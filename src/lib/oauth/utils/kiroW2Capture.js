import { fetchW2RawCaptures, decodeWhistleBody } from "open-sse/utils/w2Capture.js";

/**
 * Capture Kiro credentials from a Whistle (w2) proxy sitting in front of the
 * Kiro CLI.
 *
 * Two kinds of upstream calls carry what we need:
 *   - the token endpoints (AWS SSO OIDC `…/token`, Kiro auth service
 *     `…/refreshToken`) — their request body holds the refresh token (and, for
 *     IDC, the client id/secret);
 *   - the generation endpoints (`runtime.*.kiro.dev`, `codewhisperer.*`) —
 *     their `Authorization: Bearer` header holds the current access token.
 *
 * Whistle only sees plaintext when its root CA is trusted by the client, so the
 * caller must have the CLI running through the proxy with that CA installed.
 */

const KIRO_TOKEN_ENDPOINT_PATTERNS = [
  /oidc\.[^/]+\.amazonaws\.com\/token/i,
  /auth\.desktop\.kiro\.dev\/(?:refresh_?token|token|oauth\/token)/i,
];

/**
 * Generation endpoints — their bearer token is the one the Kiro runtime
 * accepts, so they are the best source for an access token.
 */
const KIRO_GENERATION_PATTERNS = [
  /runtime\.[^/]+\.kiro\.dev/i,
  /codewhisperer\.[^/]+\.amazonaws\.com/i,
  /q\.[^/]+\.amazonaws\.com/i,
  /bedrock-runtime/i,
];

/** Any other Kiro host (management, app.kiro.dev, telemetry) — last resort. */
const KIRO_OTHER_UPSTREAM_PATTERNS = [
  /\.kiro\.dev/i,
  /\.amazonaws\.com\//i,
];

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

function headersToObject(headers) {
  if (!headers) return {};
  if (Array.isArray(headers)) {
    const out = {};
    for (const pair of headers) {
      if (Array.isArray(pair) && pair.length >= 2) out[String(pair[0])] = pair[1];
    }
    return out;
  }
  if (typeof headers.entries === "function") return Object.fromEntries(headers.entries());
  return typeof headers === "object" ? headers : {};
}

function pickHeader(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headersToObject(headers))) {
    if (String(key).toLowerCase() === target) return value;
  }
  return null;
}

/**
 * Pull the bearer token out of an `Authorization` header.
 * @param {object|Array} headers
 * @returns {string|null}
 */
export function extractBearerToken(headers) {
  const raw = pickHeader(headers, "authorization");
  if (typeof raw !== "string") return null;
  const match = raw.match(/^\s*Bearer\s+(.+?)\s*$/i);
  const token = match ? match[1] : null;
  return token && token.length > 10 ? token : null;
}

/**
 * Pull a refresh token out of a captured request body.
 *
 * The body is parsed from the RAW text (not the redacted JSON view) because
 * `decodeWhistleBody` masks values under sensitive keys.
 *
 * @param {string} text - Raw request body
 * @returns {{ refreshToken: string, clientId?: string, clientSecret?: string }|null}
 */
export function extractRefreshTokenFromBody(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return null;

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  const pick = (obj, keys) => {
    for (const key of keys) {
      const value = obj?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  };

  if (parsed && typeof parsed === "object") {
    const refreshToken = pick(parsed, ["refresh_token", "refreshToken"]);
    if (!refreshToken) return null;
    return {
      refreshToken,
      clientId: pick(parsed, ["client_id", "clientId"]) || undefined,
      clientSecret: pick(parsed, ["client_secret", "clientSecret"]) || undefined,
    };
  }

  // form-encoded body (application/x-www-form-urlencoded)
  try {
    const params = new URLSearchParams(raw);
    const refreshToken = params.get("refresh_token") || params.get("refreshToken");
    if (!refreshToken) return null;
    return {
      refreshToken,
      clientId: params.get("client_id") || params.get("clientId") || undefined,
      clientSecret: params.get("client_secret") || params.get("clientSecret") || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Decode the payload of a JWT without verifying it.
 * @param {string} token
 * @returns {object|null}
 */
export function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = (4 - (base64.length % 4)) % 4;
    return JSON.parse(Buffer.from(`${base64}${"=".repeat(padding)}`, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function isKiroTokenEndpoint(url) {
  return KIRO_TOKEN_ENDPOINT_PATTERNS.some((re) => re.test(url));
}

/** 0 = generation endpoint, 1 = other Kiro host, null = not Kiro. */
function kiroUpstreamRank(url) {
  if (KIRO_GENERATION_PATTERNS.some((re) => re.test(url))) return 0;
  if (KIRO_OTHER_UPSTREAM_PATTERNS.some((re) => re.test(url))) return 1;
  return null;
}

function regionFromUrl(url) {
  const match = String(url || "").match(/oidc\.([^./]+)\.amazonaws\.com/i);
  return match ? match[1] : null;
}

/**
 * Scan recent w2 captures for Kiro credentials.
 *
 * @param {object} [options]
 * @param {string|null} [options.w2Url] - Whistle base URL (default: configured one)
 * @param {number} [options.count] - How many captures to pull
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxAgeMs] - Ignore captures older than this
 * @returns {Promise<{ found: boolean, error?: string }>}
 */
export async function captureKiroAuthFromW2({
  w2Url = null,
  count = 60,
  timeoutMs = 2500,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  let entries;
  try {
    entries = await fetchW2RawCaptures(w2Url, count, timeoutMs);
  } catch (error) {
    return {
      found: false,
      error: `Could not read the w2 proxy: ${error?.message || error}. Is Whistle running on 127.0.0.1:8899?`,
    };
  }

  const now = Date.now();
  let refresh = null;
  let access = null;
  let accessRank = null;

  for (const entry of entries) {
    const url = String(entry?.url || "");
    if (!url) continue;

    const startedAt = Number(entry?.startTime || 0);
    if (startedAt && maxAgeMs > 0 && now - startedAt > maxAgeMs) continue;

    const reqHeaders = entry?.req?.headers || {};

    if (isKiroTokenEndpoint(url)) {
      const decoded = decodeWhistleBody(entry?.req?.base64, reqHeaders, entry?.req?.body);
      const parsed = extractRefreshTokenFromBody(decoded.text);
      if (parsed) {
        refresh = {
          refreshToken: parsed.refreshToken,
          clientId: parsed.clientId || null,
          clientSecret: parsed.clientSecret || null,
          region: regionFromUrl(url) || "us-east-1",
          authMethod: /oidc\./i.test(url) ? "idc" : "social",
          capturedAt: startedAt || null,
          source: `w2:${url}`,
        };
      }
    }

    const rank = kiroUpstreamRank(url);
    if (rank !== null && (accessRank === null || rank < accessRank)) {
      const token = extractBearerToken(reqHeaders);
      if (token) {
        const payload = decodeJwtPayload(token);
        access = {
          accessToken: token,
          expiresAt: payload?.exp ? new Date(payload.exp * 1000).toISOString() : null,
          email:
            payload?.email ||
            payload?.preferred_username ||
            payload?.upn ||
            payload?.sub ||
            null,
          // The CLI sends the profile ARN of the signed-in identity; keeping it
          // lets the imported connection address the same AWS profile.
          profileArn: pickHeader(reqHeaders, "x-amzn-codewhisperer-profile-arn") || null,
          capturedAt: startedAt || null,
          source: `w2:${url}`,
        };
        accessRank = rank;
      }
    }
  }

  if (!refresh && !access) {
    return {
      found: false,
      error:
        "No Kiro credentials found in the w2 captures. Run the Kiro CLI through the proxy (HTTPS_PROXY=http://127.0.0.1:8899 kiro-cli chat) and retry.",
    };
  }

  return {
    found: true,
    accessToken: access?.accessToken || null,
    refreshToken: refresh?.refreshToken || null,
    clientId: refresh?.clientId || null,
    clientSecret: refresh?.clientSecret || null,
    region: refresh?.region || "us-east-1",
    authMethod: refresh?.authMethod || "social",
    expiresAt: access?.expiresAt || null,
    email: access?.email || null,
    profileArn: access?.profileArn || null,
    source: refresh?.source || access?.source || "w2",
  };
}
