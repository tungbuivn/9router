import { readFile, readdir, stat, copyFile, mkdtemp, rm } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const DEFAULT_REGION = "us-east-1";

/**
 * Keys the Kiro CLI writes into `auth_kv`. The CLI namespaces them per sign-in
 * method ("social" = Builder ID / Google / GitHub, "idc" = IAM Identity Center).
 */
export const KIRO_CLI_TOKEN_KEYS = ["kirocli:social:token", "kirocli:idc:token"];

/** Service/account names the CLI may use when it stores the token in the OS keyring. */
const KIRO_KEYRING_SERVICES = ["kiro-cli", "kiro", "kiro-cli-auth", "chat-cli"];

/** Directories under ~/.kiro that never hold credentials (logs, chats, caches). */
const KIRO_HOME_SKIP_DIRS = new Set([
  "logs",
  "sessions",
  "session-index",
  "session-leases",
  "session-relationships",
  "memories",
  "knowledge_bases",
  "workspace-roots",
]);

const MAX_SCAN_FILE_BYTES = 512 * 1024;
const MAX_SCAN_DEPTH = 3;

/* -------------------------------------------------------------------------- */
/* Paths                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Candidate locations of the Kiro CLI's SQLite data file (`data.sqlite3`).
 * The CLI resolves its data dir from `KIRO_DATA_DIR`, else the platform default.
 */
export function getKiroCliDataDbPaths() {
  const home = homedir();
  const paths = [];

  if (process.env.KIRO_DATA_DIR) {
    paths.push(join(process.env.KIRO_DATA_DIR, "data.sqlite3"));
  }

  if (process.platform === "darwin") {
    paths.push(join(home, "Library", "Application Support", "kiro-cli", "data.sqlite3"));
  } else if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    paths.push(join(localAppData, "kiro-cli", "data.sqlite3"));
  } else {
    const xdgData = process.env.XDG_DATA_HOME || join(home, ".local", "share");
    paths.push(join(xdgData, "kiro-cli", "data.sqlite3"));
    paths.push(join(home, ".local", "share", "kiro-cli", "data.sqlite3"));
  }

  return Array.from(new Set(paths));
}

/** Candidate Kiro CLI home directories (`KIRO_HOME`, else `~/.kiro`). */
export function getKiroCliHomePaths() {
  const paths = [];
  if (process.env.KIRO_HOME) paths.push(process.env.KIRO_HOME);
  paths.push(join(homedir(), ".kiro"));
  return Array.from(new Set(paths));
}

/* -------------------------------------------------------------------------- */
/* Token payload parsing                                                       */
/* -------------------------------------------------------------------------- */

function pickString(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function parseExpiresAt(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Heuristic: values below 1e12 are seconds, above are milliseconds.
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof raw === "string" && raw.trim()) {
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

/**
 * Normalize one stored Kiro CLI token payload.
 *
 * Shape (verified against kiro-cli 3.5.0, `auth_kv` key `kirocli:social:token`):
 * {
 *   "access_token": "…",
 *   "expires_at": "2026-11-26T02:41:10Z",
 *   "refresh_token": "…",
 *   "telemetry_generation": "<64 hex>",
 *   "provider": "google",
 *   "profile_arn": "arn:aws:codewhisperer:us-east-1:…"
 * }
 *
 * Older/newer builds may use camelCase keys or nest the token under `token`,
 * so both are accepted.
 *
 * @param {string|object} raw - Stored value (JSON string or object)
 * @param {string} [key] - `auth_kv` key the value came from
 * @returns {object|null}
 */
export function parseKiroCliTokenPayload(raw, key = "") {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const token = parsed.token && typeof parsed.token === "object" ? parsed.token : parsed;

  const accessToken = pickString(token, ["access_token", "accessToken"]);
  const refreshToken = pickString(token, ["refresh_token", "refreshToken"]);
  if (!accessToken && !refreshToken) return null;

  const profileArn = pickString(token, ["profile_arn", "profileArn"]);
  const clientId = pickString(token, ["client_id", "clientId"]);
  const clientSecret = pickString(token, ["client_secret", "clientSecret"]);
  const region = pickString(token, ["region"]) || DEFAULT_REGION;
  const provider = pickString(token, ["provider"]);

  const isIdc = /idc/i.test(key) || (!!clientId && !!clientSecret);

  return {
    key: key || null,
    accessToken,
    refreshToken,
    expiresAt: parseExpiresAt(token.expires_at ?? token.expiresAt ?? token.expiry),
    profileArn,
    clientId,
    clientSecret,
    region,
    provider,
    authMethod: isIdc ? "idc" : "social",
  };
}

/* -------------------------------------------------------------------------- */
/* SQLite reader (read-only, copy-first)                                      */
/* -------------------------------------------------------------------------- */

async function queryWithNodeSqlite(dbPath) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT key, value FROM auth_kv").all();
  } finally {
    db.close();
  }
}

async function queryWithBetterSqlite(dbPath) {
  const mod = await import("better-sqlite3");
  const Database = mod.default || mod;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT key, value FROM auth_kv").all();
  } finally {
    db.close();
  }
}

async function queryWithSqliteCli(dbPath) {
  const { stdout } = await execFileAsync(
    "sqlite3",
    ["-json", dbPath, "SELECT key, value FROM auth_kv;"],
    { timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
  );
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed);
}

async function queryAuthKv(dbPath) {
  const readers = [queryWithNodeSqlite, queryWithBetterSqlite, queryWithSqliteCli];
  let lastError = null;
  for (const reader of readers) {
    try {
      const rows = await reader(dbPath);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No SQLite reader available");
}

/**
 * Read `auth_kv` from the Kiro CLI's data file.
 *
 * The file is copied (together with its -wal/-shm siblings) to a temp dir first:
 * the CLI may be running and holding the DB, and a copy never disturbs it.
 */
async function readAuthKvRows(dbPath) {
  const tmpDir = await mkdtemp(join(tmpdir(), "kiro-cli-"));
  try {
    const copyPath = join(tmpDir, "data.sqlite3");
    await copyFile(dbPath, copyPath);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        await copyFile(`${dbPath}${suffix}`, `${copyPath}${suffix}`);
      } catch {
        // Sidecar files are optional.
      }
    }
    return await queryAuthKv(copyPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */
/* ~/.kiro scan                                                                */
/* -------------------------------------------------------------------------- */

async function collectJsonFiles(dir, depth) {
  if (depth > MAX_SCAN_DEPTH) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (KIRO_HOME_SKIP_DIRS.has(entry.name)) continue;
      files.push(...(await collectJsonFiles(full, depth + 1)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(full);
    }
  }
  return files;
}

async function scanKiroHomeForToken() {
  for (const homePath of getKiroCliHomePaths()) {
    const files = await collectJsonFiles(homePath, 0);
    for (const file of files) {
      try {
        const info = await stat(file);
        if (!info.isFile() || info.size > MAX_SCAN_FILE_BYTES) continue;
        const raw = await readFile(file, "utf-8");
        const parsed = parseKiroCliTokenPayload(raw, file);
        if (parsed) return { ...parsed, source: file };
      } catch {
        continue;
      }
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* OS keyring                                                                 */
/* -------------------------------------------------------------------------- */

function finishKeyringSecret(rawSecret, source) {
  const parsed = parseKiroCliTokenPayload(rawSecret, source);
  if (!parsed) {
    return {
      found: false,
      error: "Kiro CLI keyring entry found but could not be parsed. Sign in to the CLI again.",
    };
  }
  return { found: true, ...parsed, source };
}

async function readLinuxKeyringViaSecretTool() {
  for (const service of KIRO_KEYRING_SERVICES) {
    try {
      const { stdout } = await execFileAsync(
        "secret-tool",
        ["lookup", "service", service],
        { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 }
      );
      const secret = String(stdout || "").trim();
      if (!secret) continue;
      const result = finishKeyringSecret(secret, `linux-secret-tool:${service}`);
      if (result.found) return result;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          found: false,
          softError: true,
          error: "secret-tool not found (install libsecret-tools), and the D-Bus fallback found no entry.",
        };
      }
    }
  }
  return { found: false, softError: true };
}

async function readLinuxKeyringViaDbus() {
  let dbus;
  try {
    dbus = (await import("dbus-next")).default;
  } catch {
    return {
      found: false,
      error: "Cannot read the system keyring: install libsecret-tools (secret-tool) or the dbus-next package.",
    };
  }

  const bus = dbus.sessionBus();
  try {
    const proxy = await bus.getProxyObject("org.freedesktop.secrets", "/org/freedesktop/secrets");
    const service = proxy.getInterface("org.freedesktop.Secret.Service");
    const [, sessionPath] = await service.OpenSession("plain", new dbus.Variant("s", ""));

    // Only look at entries attributed to the Kiro CLI — never sweep unrelated secrets.
    const items = [];
    for (const name of KIRO_KEYRING_SERVICES) {
      const found = await service.SearchItems({ service: name });
      for (const item of found.flat()) {
        if (!items.includes(item)) items.push(item);
      }
    }
    if (items.length === 0) {
      return { found: false, error: "Kiro CLI session not found in the system keyring. Sign in to the CLI first." };
    }

    const secrets = await service.GetSecrets(items, sessionPath);
    for (const entry of Object.values(secrets)) {
      const blob = entry?.[2];
      if (!blob) continue;
      const result = finishKeyringSecret(blob.toString("utf8"), "linux-dbus");
      if (result.found) return result;
    }
    return {
      found: false,
      error: "Kiro CLI keyring entry is empty or malformed. Sign in to the CLI again.",
    };
  } catch (error) {
    return {
      found: false,
      error: `Failed to read the Linux keyring: ${error?.message || error}`,
    };
  } finally {
    try {
      bus.disconnect();
    } catch {
      // Best effort — the process may already be tearing the connection down.
    }
  }
}

async function readMacKeyring() {
  for (const service of KIRO_KEYRING_SERVICES) {
    try {
      const { stdout } = await execFileAsync(
        "security",
        ["find-generic-password", "-s", service, "-w"],
        { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 }
      );
      const secret = String(stdout || "").trim();
      if (!secret) continue;
      const result = finishKeyringSecret(secret, `darwin-keychain:${service}`);
      if (result.found) return result;
    } catch (error) {
      if (error?.code !== "ENOENT") continue;
    }
  }
  return {
    found: false,
    error: "Kiro CLI session not found in the macOS Keychain. Sign in to the CLI first.",
  };
}

/**
 * Read the Kiro CLI session from the OS secret store.
 *
 * @returns {Promise<{ found: boolean, error?: string }>}
 */
export async function readKiroCliKeyringCredentials() {
  if (process.platform === "linux") {
    const viaCli = await readLinuxKeyringViaSecretTool();
    if (viaCli.found) return viaCli;
    const viaDbus = await readLinuxKeyringViaDbus();
    if (viaDbus.found) return viaDbus;
    return viaCli.error ? viaCli : viaDbus;
  }
  if (process.platform === "darwin") {
    return readMacKeyring();
  }
  return {
    found: false,
    error: `Kiro CLI keyring import is not supported on platform ${process.platform}.`,
  };
}

/* -------------------------------------------------------------------------- */
/* CLI identity (email)                                                        */
/* -------------------------------------------------------------------------- */

/** Known install locations of the `kiro-cli` binary. */
function getKiroCliBinCandidates() {
  const candidates = [];
  if (process.env.KIRO_CLI_BIN) candidates.push(process.env.KIRO_CLI_BIN);
  const home = homedir();
  candidates.push(
    join(home, ".local", "bin", "kiro-cli"),
    join(home, ".local", "bin", "kiro"),
    "/usr/local/bin/kiro",
    "/usr/local/bin/kiro-cli",
    "/opt/homebrew/bin/kiro",
    "/opt/homebrew/bin/kiro-cli"
  );
  return candidates;
}

/**
 * Ask the CLI who is signed in.
 *
 * `kiro-cli whoami --format json` prints the account of the local session
 * (email, provider, sign-in method) without performing any network call.
 *
 * @returns {Promise<{ email: string|null, provider: string|null, accountType: string|null }|null>}
 */
export async function readKiroCliWhoami() {
  for (const bin of getKiroCliBinCandidates()) {
    try {
      const { stdout } = await execFileAsync(bin, ["whoami", "--format", "json"], {
        timeout: 8000,
        windowsHide: true,
        maxBuffer: 256 * 1024,
      });
      const parsed = JSON.parse(String(stdout || "").trim());
      const email = typeof parsed?.email === "string" ? parsed.email.trim() || null : null;
      return {
        email,
        provider: typeof parsed?.provider === "string" ? parsed.provider : null,
        accountType: typeof parsed?.accountType === "string" ? parsed.accountType : null,
      };
    } catch {
      // Binary missing, not signed in, or unexpected output — try the next one.
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Read the Kiro CLI's stored session.
 *
 * Sources, in order:
 *   1. the CLI's SQLite data file (`data.sqlite3`, table `auth_kv`)
 *   2. JSON files under `~/.kiro`
 *
 * @returns {Promise<{ found: boolean, error?: string, source?: string }>}
 */
export async function readKiroCliCredentials() {
  const dbPaths = getKiroCliDataDbPaths();

  for (const dbPath of dbPaths) {
    try {
      await stat(dbPath);
    } catch {
      continue;
    }
    try {
      const rows = await readAuthKvRows(dbPath);
      const candidates = [];
      for (const row of rows) {
        const key = String(row?.key || "");
        if (!/kirocli/i.test(key) && !KIRO_CLI_TOKEN_KEYS.includes(key)) continue;
        const parsed = parseKiroCliTokenPayload(row?.value, key);
        if (parsed) candidates.push(parsed);
      }
      if (candidates.length > 0) {
        // Prefer a social session (most common), then the one expiring last.
        candidates.sort((a, b) => {
          const aSocial = a.authMethod === "social" ? 1 : 0;
          const bSocial = b.authMethod === "social" ? 1 : 0;
          if (aSocial !== bSocial) return bSocial - aSocial;
          return String(b.expiresAt || "").localeCompare(String(a.expiresAt || ""));
        });
        return { found: true, ...candidates[0], source: dbPath };
      }
    } catch (error) {
      // Try the next candidate path.
    }
  }

  const fromHome = await scanKiroHomeForToken();
  if (fromHome) return { found: true, ...fromHome };

  return {
    found: false,
    error: "Kiro CLI session not found. Sign in with `kiro-cli login` first, then retry.",
  };
}
