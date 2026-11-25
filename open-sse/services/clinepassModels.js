import { buildClineHeaders } from "../shared/clineAuth.js";

// Cline's cloud model catalog (the CLI reads this one):
//   GET {apiBaseUrl}/api/v1/ai/cline/models          → { data: [...] }  (the whole catalog)
//   GET {apiBaseUrl}/api/v1/ai/cline/recommended-models → { recommended, free, clinePass, clineCloud }
//
// The plain `/api/v1/models` endpoint (OpenAI-compatible shape) does NOT carry the
// `cline-pass/*` ids — those live only in the recommended-models feed. Filtering
// `/api/v1/models` by the `cline-pass/` prefix therefore always yields an empty
// list, which is why the ClinePass picker never matched the CLI.
//
// The CLI composes its own list as:
//   [...clinePass, ...clineCloud, ...catalog]   (deduped by id)
// so ClinePass = feed.clinePass, and Cline = catalog + feed.free.
const CLINE_CATALOG_ENDPOINT = "https://api.cline.bot/api/v1/ai/cline/models";
const CLINE_RECOMMENDED_ENDPOINT = "https://api.cline.bot/api/v1/ai/cline/recommended-models";
const FETCH_TIMEOUT_MS = 5000;

/**
 * Build request headers for Cline's model endpoints.
 * - API keys are sent as plain Bearer tokens.
 * - OAuth access tokens must carry the WorkOS `workos:` prefix (handled by buildClineHeaders).
 */
function buildModelListHeaders(token, isApiKey) {
  if (isApiKey) {
    return {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    };
  }
  return buildClineHeaders(token, { Accept: "application/json" });
}

/** Fetch JSON with a timeout; returns null on any failure (never throws). */
async function fetchJson(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalize one feed/catalog entry into { id, name }.
 * The feed uses `id` + `name`; the catalog uses `id` + `name`/`display_name`.
 */
function toModelEntry(raw) {
  if (!raw) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  const name =
    (typeof raw.display_name === "string" && raw.display_name.trim()) ||
    (typeof raw.name === "string" && raw.name.trim()) ||
    id;
  const entry = { id, name };
  // The catalog carries the real context window; the feed does not.
  const contextLength =
    raw.context_length ?? raw.contextLength ?? raw.top_provider?.context_length ?? null;
  if (typeof contextLength === "number" && contextLength > 0) entry.contextLength = contextLength;
  const maxOutput = raw.top_provider?.max_completion_tokens ?? null;
  if (typeof maxOutput === "number" && maxOutput > 0) entry.maxOutput = maxOutput;
  return entry;
}

/** Unwrap the { success, data } / { data } envelopes both endpoints use. */
function unwrapList(json, key) {
  if (!json) return [];
  const payload = json?.data && typeof json.data === "object" && !Array.isArray(json.data)
    ? json.data
    : json;
  const list = key ? payload?.[key] : (Array.isArray(json) ? json : payload?.data);
  return Array.isArray(list) ? list : [];
}

/**
 * Fetch the recommended-models feed (recommended / free / clinePass / clineCloud).
 * Returns null on failure — every consumer treats the feed as additive.
 */
export async function fetchClineRecommendedFeed(credentials) {
  const isApiKey = Boolean(credentials?.apiKey);
  const token = isApiKey ? credentials.apiKey : credentials?.accessToken;
  if (!token) return null;

  const json = await fetchJson(CLINE_RECOMMENDED_ENDPOINT, buildModelListHeaders(token, isApiKey));
  if (!json) return null;

  const payload = json?.data && typeof json.data === "object" && !Array.isArray(json.data)
    ? json.data
    : json;

  return {
    recommended: unwrapList(payload, "recommended"),
    free: unwrapList(payload, "free"),
    clinePass: unwrapList(payload, "clinePass"),
    clineCloud: unwrapList(payload, "clineCloud"),
  };
}

/**
 * Fetch Cline's cloud catalog (the whole model list the CLI shows).
 */
export async function fetchClineCatalog(credentials) {
  const isApiKey = Boolean(credentials?.apiKey);
  const token = isApiKey ? credentials.apiKey : credentials?.accessToken;
  if (!token) return null;

  const json = await fetchJson(CLINE_CATALOG_ENDPOINT, buildModelListHeaders(token, isApiKey));
  if (!json) return null;
  return unwrapList(json);
}

/**
 * Fetch the ClinePass live model catalog.
 *
 * ClinePass is the paid subscription tier: its models are published only in the
 * recommended-models feed under `clinePass[]`, never in `/api/v1/models`.
 *
 * The feed's `free[]` tier is included too: a ClinePass session can serve the
 * free models as well (verified live against api.cline.bot), so hiding them
 * would leave paid users without the free models their own CLI shows.
 *
 * @param {object} credentials - Connection credentials ({ accessToken, apiKey })
 * @returns {Promise<{ models: { id: string, name: string }[] } | null>}
 */
export async function resolveClinepassModels(credentials) {
  const feed = await fetchClineRecommendedFeed(credentials);
  if (!feed) return null;

  const models = [...feed.clinePass, ...feed.free]
    .map(toModelEntry)
    .filter(Boolean);
  return models.length ? { models } : null;
}

/**
 * Fetch Cline's live model catalog.
 *
 * Mirrors the CLI: the whole cloud catalog plus the feed's `free[]` tier, minus
 * the `clinePass[]` subscription tier (that belongs to the ClinePass provider).
 *
 * @param {object} credentials - Connection credentials ({ accessToken, apiKey })
 * @returns {Promise<{ models: { id: string, name: string }[] } | null>}
 */
export async function resolveClineModels(credentials) {
  const [catalog, feed] = await Promise.all([
    fetchClineCatalog(credentials),
    fetchClineRecommendedFeed(credentials),
  ]);

  const byId = new Map();

  // Free tier first: the feed is the only source for `cline-free/*` ids.
  for (const raw of feed?.free || []) {
    const entry = toModelEntry(raw);
    if (entry) byId.set(entry.id, entry);
  }

  // The cloud catalog is the main source; it wins on a shared id.
  for (const raw of catalog || []) {
    const entry = toModelEntry(raw);
    if (entry) byId.set(entry.id, entry);
  }

  // The recommended list is a shortlist of the catalog — skip ids we already have,
  // but keep it as a fallback when the catalog endpoint is unavailable.
  if (!catalog?.length) {
    for (const raw of feed?.recommended || []) {
      const entry = toModelEntry(raw);
      if (entry && !byId.has(entry.id)) byId.set(entry.id, entry);
    }
  }

  const merged = Array.from(byId.values());
  return merged.length ? { models: merged } : null;
}
