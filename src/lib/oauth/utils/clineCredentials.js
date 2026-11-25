import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

/**
 * Cline CLI (VS Code extension / `cline` CLI) keeps its provider auth in
 * ~/.cline/data/settings/providers.json.
 *
 * Shape (verified against Cline CLI):
 * {
 *   "version": 1,
 *   "lastUsedProvider": "cline-pass",
 *   "providers": {
 *     "cline": {
 *       "settings": {
 *         "provider": "cline",
 *         "auth": {
 *           "accessToken": "workos:eyJ…",   // WorkOS JWT
 *           "refreshToken": "…",
 *           "expiresAt": 1795613897000,    // epoch ms
 *           "accountId": "usr-…",
 *           "metadata": {
 *             "userInfo": { "email": "…", "name": "…" }
 *           }
 *         },
 *         "model": "…"
 *       },
 *       "updatedAt": "…",
 *       "tokenSource": "oauth"
 *     },
 *     "cline-pass": { … same shape … }
 *   }
 * }
 */

const PROVIDERS_FILE = () => join(homedir(), ".cline", "data", "settings", "providers.json");

// The CLI keeps user info inside `metadata.userInfo`
function readUserInfo(metadata) {
  if (!metadata) return null;
  let info = metadata;
  if (typeof metadata === "string") {
    try {
      info = JSON.parse(metadata);
    } catch {
      return null;
    }
  }
  return info?.userInfo || info || null;
}

function parseExpiresAt(rawExpiry) {
  if (typeof rawExpiry === "number" && Number.isFinite(rawExpiry)) {
    return new Date(rawExpiry).toISOString();
  }
  if (typeof rawExpiry === "string" && rawExpiry && !Number.isNaN(new Date(rawExpiry).getTime())) {
    return new Date(rawExpiry).toISOString();
  }
  return null;
}

/**
 * Parse the CLI's providers.json into candidate Cline credentials.
 * @param {string} raw - Raw JSON string
 * @param {string} [targetProvider] - Optional target provider ("cline" or "clinepass")
 * @returns {Array<object>}
 */
export function parseClineProviders(raw, targetProvider = null) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const providers = parsed?.providers;
  if (!providers || typeof providers !== "object") return [];

  // Extract all cline-related blocks from providers.json ("cline", "cline-pass")
  const candidates = [];
  const knownKeys = ["cline", "cline-pass"];

  for (const key of knownKeys) {
    const row = providers[key];
    if (!row) continue;

    const auth = row?.settings?.auth;
    if (!auth || typeof auth !== "object") continue;

    const accessToken = typeof auth.accessToken === "string" ? auth.accessToken.trim() : "";
    const refreshToken = typeof auth.refreshToken === "string" ? auth.refreshToken.trim() : "";
    if (!accessToken && !refreshToken) continue;

    const expiresAt = parseExpiresAt(auth.expiresAt);
    const userInfo = readUserInfo(auth.metadata);
    const email = typeof userInfo?.email === "string" ? userInfo.email.trim() : null;
    const displayName = typeof userInfo?.name === "string" ? userInfo.name.trim() : null;

    candidates.push({
      cliKey: key,
      accessToken,
      refreshToken,
      expiresAt,
      expiresAtMs: auth.expiresAt ? new Date(auth.expiresAt).getTime() : 0,
      accountId: typeof auth.accountId === "string" ? auth.accountId.trim() : null,
      email,
      displayName,
      model: typeof row?.settings?.model === "string" ? row.settings.model : null,
      updatedAt: typeof row?.updatedAt === "string" ? row.updatedAt : null,
    });
  }

  if (candidates.length === 0) return [];

  // Sort candidates so the freshest / unexpired token is preferred:
  // 1. Unexpired access token first
  // 2. Later expiresAtMs / updatedAt
  const now = Date.now();
  candidates.sort((a, b) => {
    const aValid = a.expiresAtMs > now ? 1 : 0;
    const bValid = b.expiresAtMs > now ? 1 : 0;
    if (aValid !== bValid) return bValid - aValid;
    return (b.expiresAtMs || 0) - (a.expiresAtMs || 0);
  });

  const bestCandidate = candidates[0];

  // If a specific provider is targeted (e.g. "clinepass" or "cline"):
  if (targetProvider === "cline" || targetProvider === "clinepass") {
    // Check if there is an exact matching key that is valid
    const matchKey = targetProvider === "clinepass" ? "cline-pass" : "cline";
    const exactCandidate = candidates.find((c) => c.cliKey === matchKey && c.expiresAtMs > now);
    const chosen = exactCandidate || bestCandidate;

    return [{
      provider: targetProvider,
      cliProvider: chosen.cliKey,
      accessToken: chosen.accessToken,
      refreshToken: chosen.refreshToken,
      expiresAt: chosen.expiresAt,
      accountId: chosen.accountId,
      email: chosen.email,
      displayName: chosen.displayName,
      model: chosen.model,
    }];
  }

  // If no target provider, generate entries for both cline and clinepass
  // ensuring each gets the best available credential
  const results = [];
  for (const prov of ["cline", "clinepass"]) {
    const matchKey = prov === "clinepass" ? "cline-pass" : "cline";
    const exact = candidates.find((c) => c.cliKey === matchKey && c.expiresAtMs > now);
    const chosen = exact || bestCandidate;

    results.push({
      provider: prov,
      cliProvider: chosen.cliKey,
      accessToken: chosen.accessToken,
      refreshToken: chosen.refreshToken,
      expiresAt: chosen.expiresAt,
      accountId: chosen.accountId,
      email: chosen.email,
      displayName: chosen.displayName,
      model: chosen.model,
    });
  }

  return results;
}

/**
 * Read the Cline CLI's stored sessions.
 * @param {string} [targetProvider]
 * @returns {Promise<{ found: boolean, entries?: Array, source?: string, error?: string }>}
 */
export async function readClineCliCredentials(targetProvider = null) {
  const path = PROVIDERS_FILE();
  let raw;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return {
      found: false,
      error: "Cline CLI credentials not found. Sign in to Cline (CLI or VS Code extension) first.",
    };
  }

  const entries = parseClineProviders(raw, targetProvider);
  if (entries.length === 0) {
    return {
      found: false,
      error: "No signed-in Cline session found in ~/.cline/data/settings/providers.json.",
    };
  }

  return { found: true, entries, source: path };
}
