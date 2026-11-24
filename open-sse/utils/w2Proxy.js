import net from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { getCurrentRequestLogId } from "./requestLogContext.js";

export const DEFAULT_W2_PROXY_URL = "http://127.0.0.1:8899";
export const DEFAULT_LOCAL_NO_PROXY = "localhost,127.0.0.1,::1";
const DEFAULT_PROBE_TIMEOUT_MS = 250;
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
// Additive: the child keeps its system roots and adds the MITM root on top.
const ADDITIVE_CA_ENV_KEYS = ["NODE_EXTRA_CA_CERTS"];
// Replacement: the value becomes the child's ONLY trust store. Safe only for the built-in
// proxy bundle (public roots + MITM root). Some ACP servers (the Antigravity CLI `agy`)
// ignore NODE_EXTRA_CA_CERTS entirely and only read SSL_CERT_FILE.
const REPLACEMENT_CA_ENV_KEYS = ["SSL_CERT_FILE", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "AWS_CA_BUNDLE"];
const CA_ENV_KEYS = [...ADDITIVE_CA_ENV_KEYS, ...REPLACEMENT_CA_ENV_KEYS];

const GLOBAL_STATE_KEY = "__nineRouterW2AutoProxyState";

function getGlobalState() {
  if (!globalThis[GLOBAL_STATE_KEY]) {
    globalThis[GLOBAL_STATE_KEY] = {
      initialized: false,
      enabled: true,
      url: DEFAULT_W2_PROXY_URL,
    };
  }
  return globalThis[GLOBAL_STATE_KEY];
}

export function normalizeW2ProxyUrl(rawUrl) {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) return DEFAULT_W2_PROXY_URL;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (!parsed.hostname) return DEFAULT_W2_PROXY_URL;
    const port = parsed.port ? `:${parsed.port}` : (parsed.protocol === "https:" ? ":443" : ":80");
    return `${parsed.protocol}//${parsed.hostname}${port}`;
  } catch {
    return DEFAULT_W2_PROXY_URL;
  }
}

export function parseProxyHostPort(proxyUrl) {
  const normalized = normalizeW2ProxyUrl(proxyUrl);
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    const port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
    return { url: normalized, host, port };
  } catch {
    return { url: DEFAULT_W2_PROXY_URL, host: "127.0.0.1", port: 8899 };
  }
}

/**
 * Sync runtime W2 auto-proxy configuration from Settings DB (called on boot & PATCH /api/settings).
 */
export function setW2AutoProxyConfig({ w2AutoProxyEnabled, w2AutoProxyUrl, enabled, url } = {}) {
  const state = getGlobalState();
  if (typeof w2AutoProxyEnabled === "boolean") {
    state.enabled = w2AutoProxyEnabled;
  } else if (typeof enabled === "boolean") {
    state.enabled = enabled;
  }
  const nextUrl = w2AutoProxyUrl !== undefined ? w2AutoProxyUrl : url;
  if (nextUrl !== undefined) {
    state.url = normalizeW2ProxyUrl(nextUrl);
  }
  state.initialized = true;
  return getW2AutoProxyConfig();
}

export function resetW2AutoProxyConfigForTests() {
  globalThis[GLOBAL_STATE_KEY] = {
    initialized: false,
    enabled: true,
    url: DEFAULT_W2_PROXY_URL,
  };
}

/**
 * Resolve effective W2 auto-proxy configuration.
 * Env vars W2_AUTO_PROXY_ENABLED / W2_AUTO_PROXY_URL override stored settings when explicitly set.
 */
export function getW2AutoProxyConfig() {
  const state = getGlobalState();
  let enabled = state.enabled !== false;
  let url = state.url || DEFAULT_W2_PROXY_URL;

  if (process.env.W2_AUTO_PROXY_ENABLED !== undefined) {
    const v = String(process.env.W2_AUTO_PROXY_ENABLED).trim().toLowerCase();
    enabled = !["false", "0", "no", "off"].includes(v);
  }
  if (process.env.W2_AUTO_PROXY_URL !== undefined && process.env.W2_AUTO_PROXY_URL.trim()) {
    url = normalizeW2ProxyUrl(process.env.W2_AUTO_PROXY_URL);
  }

  return {
    enabled,
    ...parseProxyHostPort(url),
  };
}

let lazyInitPromise = null;
async function ensureConfigLoadedFromDb() {
  const state = getGlobalState();
  if (state.initialized) return;
  if (process.env.W2_AUTO_PROXY_ENABLED !== undefined || process.env.W2_AUTO_PROXY_URL !== undefined) {
    return;
  }
  if (!lazyInitPromise) {
    lazyInitPromise = (async () => {
      try {
        const mod = await import("@/lib/localDb");
        if (typeof mod?.getSettings === "function") {
          const settings = await mod.getSettings();
          if (settings) {
            setW2AutoProxyConfig({
              w2AutoProxyEnabled: settings.w2AutoProxyEnabled !== false,
              w2AutoProxyUrl: settings.w2AutoProxyUrl || DEFAULT_W2_PROXY_URL,
            });
          }
        }
      } catch {
        // Running outside Next.js/DB context (e.g. standalone open-sse tests) — keep defaults
      } finally {
        lazyInitPromise = null;
      }
    })();
  }
  await lazyInitPromise;
}

/**
 * Returns true if targetUrl points to a local/loopback host that MUST NOT be captured via w2 proxy.
 */
export function isLocalTargetUrl(targetUrl) {
  if (!targetUrl) return true;
  let parsed;
  try {
    parsed = new URL(String(targetUrl));
  } catch {
    return true;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;

  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.startsWith("::ffff:")) host = host.slice(7);

  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  ) {
    return true;
  }

  return false;
}

/**
 * Fast per-request loopback TCP check (~1ms on localhost).
 */
export function isTcpPortOpen(host, port, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(open);
    };

    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

/**
 * Probe configured w2 proxy right now and return live status metadata.
 */
export async function probeW2ProxyStatus(overrideUrl = null, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  await ensureConfigLoadedFromDb();
  const cfg = overrideUrl
    ? { enabled: getW2AutoProxyConfig().enabled, ...parseProxyHostPort(overrideUrl) }
    : getW2AutoProxyConfig();

  const start = Date.now();
  const active = await isTcpPortOpen(cfg.host, cfg.port, timeoutMs);
  return {
    enabled: cfg.enabled,
    active,
    url: cfg.url,
    host: cfg.host,
    port: cfg.port,
    elapsedMs: Date.now() - start,
    caCertPath: resolveCaCertBundlePath(),
  };
}

/**
 * Resolve active W2 proxy URL for an outbound HTTP/HTTPS request (used by proxyFetch.js).
 * Returns null if disabled, if targetUrl is local, or if w2 proxy is not running.
 */
export async function resolveActiveW2ProxyUrl(targetUrl, options = {}) {
  if (isLocalTargetUrl(targetUrl)) return null;
  try {
    const { isBuiltinProxyActive } = await import("./builtinProxy.js");
    if (isBuiltinProxyActive()) return null;
  } catch {}
  await ensureConfigLoadedFromDb();
  const cfg = getW2AutoProxyConfig();
  if (!cfg.enabled) return null;

  const timeoutMs = options.timeoutMs || DEFAULT_PROBE_TIMEOUT_MS;
  const open = await isTcpPortOpen(cfg.host, cfg.port, timeoutMs);
  return open ? cfg.url : null;
}

/**
 * Locate an existing CA certificate bundle that includes Whistle's root CA (if available).
 */
export function resolveCaCertBundlePath() {
  const homeDir = process.env.HOME || os.homedir() || "";
  const candidates = [
    process.env.SSL_CERT_FILE,
    process.env.NODE_EXTRA_CA_CERTS,
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    homeDir ? join(homeDir, ".WhistleAppData", ".whistle", "certs", "root.crt") : "",
    "/usr/local/share/ca-certificates/whistle-root.crt",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

function mergeNoProxy(existing) {
  const parts = String(existing || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  for (const required of ["localhost", "127.0.0.1", "::1"]) {
    if (!parts.some((p) => p.toLowerCase() === required)) {
      parts.push(required);
    }
  }
  return parts.join(",");
}

function matchesProxyEndpoint(value, host, port) {
  if (!value) return false;
  try {
    const parsed = parseProxyHostPort(value);
    return parsed.host === host && parsed.port === port;
  } catch {
    return false;
  }
}

/**
 * Build child-process env for ACP servers (agy, kiro-cli, devin, etc.).
 * Probes w2 proxy on EVERY call when enabled:
 *  - Active: injects HTTP_PROXY/HTTPS_PROXY/ALL_PROXY + NO_PROXY (bypass local) + CA bundle env vars.
 *  - Inactive or disabled: removes stale w2 proxy values inherited from process.env so direct calls never fail.
 */
export async function buildAcpProcessEnv(baseEnv = process.env, customEnv = {}, options = {}) {
  await ensureConfigLoadedFromDb();
  const cfg = getW2AutoProxyConfig();
  const safeCustom = customEnv && typeof customEnv === "object" ? customEnv : {};
  const env = { ...baseEnv, ...safeCustom };

  // Respect explicit proxy configuration set on the ACP node itself
  const hasCustomProxy = PROXY_ENV_KEYS.some(
    (k) => Object.prototype.hasOwnProperty.call(safeCustom, k) && String(safeCustom[k] || "").trim() !== ""
  );
  if (hasCustomProxy) {
    return {
      env,
      w2Proxy: {
        enabled: cfg.enabled,
        active: false,
        url: cfg.url,
        caCertPath: null,
        skippedReason: "custom_env_override",
      },
    };
  }

  // Priority 1: Built-in Interceptor Proxy (no external w2 needed, exact 1-to-1 requestLogId correlation)
  if (process.env.W2_AUTO_PROXY_URL === undefined) {
    try {
      const { ensureBuiltinProxyReady } = await import("./builtinProxy.js");
      const bp = await ensureBuiltinProxyReady();
      if (bp?.enabled && bp?.running && bp?.port) {
        const rawLogId = options.requestLogId || getCurrentRequestLogId();
        const logId = typeof rawLogId === "string" && /^[a-zA-Z0-9_-]+$/.test(rawLogId)
          ? rawLogId
          : null;
        const authProxyUrl = logId
          ? `http://9r:${logId}@127.0.0.1:${bp.port}`
          : `http://127.0.0.1:${bp.port}`;

        for (const key of PROXY_ENV_KEYS) {
          env[key] = authProxyUrl;
        }
        const mergedNoProxy = mergeNoProxy(env.NO_PROXY || env.no_proxy);
        env.NO_PROXY = mergedNoProxy;
        env.no_proxy = mergedNoProxy;

        const caPath = bp.caBundlePath || bp.caCertPath || resolveCaCertBundlePath();
        if (caPath) {
          // Built-in bundle = public roots + MITM root, so replacement vars are safe and
          // required for ACP servers that ignore the additive NODE_EXTRA_CA_CERTS.
          for (const caKey of CA_ENV_KEYS) {
            env[caKey] = caPath;
          }
        }

        return {
          env,
          w2Proxy: {
            enabled: true,
            active: true,
            mode: "builtin",
            url: `http://127.0.0.1:${bp.port}`,
            caCertPath: caPath,
            requestLogId: logId,
          },
        };
      }
    } catch {
      // Fall through to external w2 proxy if built-in proxy unavailable
    }
  }

  const stripStaleW2Proxy = () => {
    for (const key of PROXY_ENV_KEYS) {
      if (matchesProxyEndpoint(env[key], cfg.host, cfg.port)) {
        delete env[key];
      }
    }
  };

  if (!cfg.enabled) {
    stripStaleW2Proxy();
    return {
      env,
      w2Proxy: {
        enabled: false,
        active: false,
        url: cfg.url,
        caCertPath: null,
      },
    };
  }

  const timeoutMs = options.timeoutMs || DEFAULT_PROBE_TIMEOUT_MS;
  const active = await isTcpPortOpen(cfg.host, cfg.port, timeoutMs);

  if (!active) {
    stripStaleW2Proxy();
    return {
      env,
      w2Proxy: {
        enabled: true,
        active: false,
        url: cfg.url,
        caCertPath: null,
      },
    };
  }

  for (const key of PROXY_ENV_KEYS) {
    env[key] = cfg.url;
  }
  const mergedNoProxy = mergeNoProxy(env.NO_PROXY || env.no_proxy);
  env.NO_PROXY = mergedNoProxy;
  env.no_proxy = mergedNoProxy;

  const caCertPath = resolveCaCertBundlePath();
  if (caCertPath) {
    // External w2 proxies may tunnel these hosts, so only add the CA — replacing the
    // trust store with a MITM-only bundle would drop every public root.
    for (const caKey of ADDITIVE_CA_ENV_KEYS) {
      if (!env[caKey]) env[caKey] = caCertPath;
    }
  }

  return {
    env,
    w2Proxy: {
      enabled: true,
      active: true,
      url: cfg.url,
      caCertPath,
    },
  };
}
