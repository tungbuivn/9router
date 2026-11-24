import { createHash } from "node:crypto";

/**
 * In-memory cache of ACP session ids, keyed by a conversation fingerprint.
 *
 * An ACP agent (agy, kiro-cli, …) keeps its own conversation state for a session
 * id, and `session/load` can resume that state from a fresh child process. Reusing
 * it means we only have to send the newest turn instead of the whole transcript.
 */

const MAX_ENTRIES = 32;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function ttlMs() {
  const raw = Number.parseInt(process.env.ACP_SESSION_TTL_MS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

// key -> { sessionId, updatedAt, busy }
const cache = new Map();

export function clearAcpSessions() {
  cache.clear();
}

/**
 * Fingerprint a conversation from its *user* turns only, so a client that rewrites
 * assistant messages (reasoning wrappers, redaction) still maps to the same session.
 * Returns null when there is nothing to resume yet (no earlier user turn).
 */
export function buildAcpSessionKey({ provider, command, cwd, model, historyUserTexts } = {}) {
  const turns = Array.isArray(historyUserTexts) ? historyUserTexts : [];
  if (turns.length === 0) return null;
  const raw = [
    provider || "",
    command || "",
    cwd || "",
    model || "",
    ...turns.map((text) => String(text ?? "").trim()),
  ].join("\u0000");
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

function prune() {
  const now = Date.now();
  const maxAge = ttlMs();
  for (const [key, entry] of cache) {
    if (!entry.busy && now - entry.updatedAt > maxAge) cache.delete(key);
  }
  while (cache.size > MAX_ENTRIES) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, entry] of cache) {
      if (entry.busy) continue;
      if (entry.updatedAt < oldestAt) {
        oldestAt = entry.updatedAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

/**
 * Reserve a conversation for this request and return its cached session id (if any).
 * A second concurrent request for the same conversation gets `claimed: false` and
 * must fall back to a fresh session with the full transcript.
 */
export function claimAcpSession(key) {
  if (!key) return { sessionId: null, claimed: false };
  const entry = cache.get(key);
  if (entry?.busy) return { sessionId: null, claimed: false };
  const fresh = entry && Date.now() - entry.updatedAt <= ttlMs();
  cache.set(key, {
    sessionId: fresh ? entry.sessionId : null,
    updatedAt: fresh ? entry.updatedAt : Date.now(),
    busy: true,
  });
  return { sessionId: fresh ? entry.sessionId : null, claimed: true };
}

/**
 * Remember the session id under the *next* request's fingerprint.
 * A session that already contains turn k must not stay reachable from the
 * fingerprint of turns 1..k-1, or a regenerate would replay turn k twice — hence
 * the executor drops the claimed key and only writes the advanced one.
 */
export function saveAcpSession(key, sessionId) {
  if (!key || !sessionId) return;
  cache.set(key, { sessionId, updatedAt: Date.now(), busy: false });
  prune();
}

/** Forget a fingerprint (used once a session has advanced past it). */
export function dropAcpSession(key) {
  if (key) cache.delete(key);
}

/** Test helper: inspect a cached entry without claiming it. */
export function peekAcpSession(key) {
  return cache.get(key) || null;
}
