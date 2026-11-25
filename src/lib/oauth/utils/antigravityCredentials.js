import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// The Antigravity CLI keeps its OAuth session in the OS secret store, not in a
// file: `service=gemini, username=antigravity` under libsecret's Generic schema.
// The stored value is the CLI's own token envelope (see parseTokenEnvelope).
export const ANTIGRAVITY_KEYRING_SERVICE = "gemini";
export const ANTIGRAVITY_KEYRING_USER = "antigravity";

/** Strip the "Bearer " prefix some stores use and reject empty values. */
const asToken = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^Bearer\s+/i, "");
  return trimmed || null;
};

/**
 * Decode the CLI's stored token blob.
 *
 * Shape (verified against agy 1.5.16):
 * {
 *   "token": { "access_token": "ya29...", "refresh_token": "1//0...",
 *              "expiry": "2026-11-25T10:41:51+07:00", "expires_in": 3599 },
 *   "auth_method": "consumer",
 *   "id_token_email": "user@example.com"
 * }
 *
 * Some builds store only the inner token object, so both shapes are accepted.
 */
export function parseTokenEnvelope(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const token = parsed?.token && typeof parsed.token === "object" ? parsed.token : parsed;
  const refreshToken = asToken(token?.refresh_token);
  const accessToken = asToken(token?.access_token);
  if (!refreshToken && !accessToken) return null;

  const expiry = token?.expiry ?? parsed?.expiry ?? null;
  const expiresAt = expiry && !Number.isNaN(new Date(expiry).getTime())
    ? new Date(expiry).toISOString()
    : null;

  return {
    accessToken,
    refreshToken,
    expiresAt,
    email: typeof parsed?.id_token_email === "string" ? parsed.id_token_email.trim() || null : null,
    authMethod: typeof parsed?.auth_method === "string" ? parsed.auth_method : null,
  };
}

/**
 * Read the signed-in Antigravity CLI session from the OS secret store.
 *
 * Linux:   libsecret via `secret-tool` (same tool Zed auto-import uses), with a
 *          D-Bus Secret Service fallback for hosts that ship libsecret without
 *          the `secret-tool` CLI (common on server/minimal installs).
 * macOS:   Keychain generic password (service=gemini, account=antigravity).
 * Windows: Credential Manager entry target `gemini:antigravity` (go-keyring).
 *
 * @returns {Promise<{ found: boolean, refreshToken?: string, accessToken?: string,
 *   expiresAt?: string|null, email?: string|null, source?: string, error?: string }>}
 */
export async function readAntigravityCliCredentials() {
  if (process.platform === "linux") return readLinuxCredentials();
  if (process.platform === "darwin") return readMacCredentials();
  if (process.platform === "win32") return readWindowsCredentials();
  return {
    found: false,
    error: `Antigravity CLI auto-import is not supported on platform ${process.platform}. Use OAuth instead.`,
  };
}

function finish(rawSecret, source) {
  const envelope = parseTokenEnvelope(rawSecret);
  if (!envelope) {
    return {
      found: false,
      error: "Antigravity CLI token found but could not be parsed. Sign in to the CLI again.",
    };
  }
  if (!envelope.refreshToken) {
    return {
      found: false,
      error: "Antigravity CLI entry has no refresh token. Sign in to the CLI again.",
    };
  }
  return {
    found: true,
    refreshToken: envelope.refreshToken,
    accessToken: envelope.accessToken,
    expiresAt: envelope.expiresAt,
    email: envelope.email,
    authMethod: envelope.authMethod,
    source,
  };
}

async function readLinuxCredentials() {
  const viaCli = await readLinuxViaSecretTool();
  if (viaCli.found || viaCli.hardError) return viaCli;

  const viaDbus = await readLinuxViaSecretService();
  if (viaDbus.found) return viaDbus;
  // Prefer the secret-tool message (actionable: install libsecret) over the
  // generic D-Bus one, unless D-Bus reported a real session but no entry.
  return viaCli.error ? viaCli : viaDbus;
}

async function readLinuxViaSecretTool() {
  const args = [
    "lookup",
    "service", ANTIGRAVITY_KEYRING_SERVICE,
    "username", ANTIGRAVITY_KEYRING_USER,
  ];
  try {
    const { stdout } = await execFileAsync("secret-tool", args, {
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const secret = String(stdout || "").trim();
    if (!secret) {
      return { found: false, error: "Antigravity CLI keyring entry is empty. Sign in to the CLI again." };
    }
    return finish(secret, "linux-secret-tool");
  } catch (err) {
    if (err?.code === "ENOENT") {
      // No secret-tool CLI; let the D-Bus fallback try before giving up.
      return {
        found: false,
        softError: true,
        error: "secret-tool not found (install libsecret-tools), and the D-Bus fallback found no entry.",
      };
    }
    return {
      found: false,
      hardError: true,
      error:
        "Antigravity CLI session not found in the system keyring. Sign in with `agy` first, then retry.",
    };
  }
}

async function readLinuxViaSecretService() {
  let dbus;
  try {
    // Optional dependency: only needed when `secret-tool` is unavailable.
    dbus = (await import("dbus-next")).default;
  } catch {
    return {
      found: false,
      error:
        "Cannot read the system keyring: install libsecret-tools (secret-tool) or the dbus-next package.",
    };
  }

  const bus = dbus.sessionBus();
  try {
    const proxy = await bus.getProxyObject("org.freedesktop.secrets", "/org/freedesktop/secrets");
    const service = proxy.getInterface("org.freedesktop.Secret.Service");
    const [, sessionPath] = await service.OpenSession("plain", new dbus.Variant("s", ""));
    const [unlocked, locked] = await service.SearchItems({
      service: ANTIGRAVITY_KEYRING_SERVICE,
      username: ANTIGRAVITY_KEYRING_USER,
    });

    let items = unlocked;
    if (items.length === 0 && locked.length > 0) {
      const [nowUnlocked] = await service.Unlock(locked);
      items = nowUnlocked || [];
    }
    if (items.length === 0) {
      return {
        found: false,
        error:
          "Antigravity CLI session not found in the system keyring. Sign in with `agy` first, then retry.",
      };
    }

    const secrets = await service.GetSecrets(items, sessionPath);
    // a{o(oayays)} → the secret bytes are the third element of the struct.
    for (const entry of Object.values(secrets)) {
      const blob = entry?.[2];
      if (!blob) continue;
      const result = finish(blob.toString("utf8"), "linux-dbus");
      if (result.found) return result;
    }
    return {
      found: false,
      error: "Antigravity CLI keyring entry is empty. Sign in to the CLI again.",
    };
  } catch (err) {
    return {
      found: false,
      error: `Failed to read the Linux keyring: ${err?.message || err}`,
    };
  } finally {
    try {
      bus.disconnect();
    } catch {
      // Best effort — the process may already be tearing the connection down.
    }
  }
}

async function readMacCredentials() {
  // go-keyring stores a generic password with service=<service>, account=<user>.
  try {
    const { stdout } = await execFileAsync(
      "security",
      [
        "find-generic-password",
        "-s", ANTIGRAVITY_KEYRING_SERVICE,
        "-a", ANTIGRAVITY_KEYRING_USER,
        "-w",
      ],
      { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const secret = String(stdout || "").trim();
    if (!secret) {
      return { found: false, error: "Antigravity CLI keychain entry is empty. Sign in to the CLI again." };
    }
    return finish(secret, "darwin-keychain");
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { found: false, error: "macOS `security` tool not found." };
    }
    return {
      found: false,
      error: "Antigravity CLI session not found in the macOS Keychain. Sign in with `agy` first, then retry.",
    };
  }
}

async function readWindowsCredentials() {
  // go-keyring writes Credential Manager entries as target `<service>:<user>`.
  const target = `${ANTIGRAVITY_KEYRING_SERVICE}:${ANTIGRAVITY_KEYRING_USER}`;
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class AgCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr credentialPtr);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr buffer);
  public static string Read(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return null;
    try {
      var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      if (c.CredentialBlob == IntPtr.Zero || c.CredentialBlobSize == 0) return "";
      byte[] bytes = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, bytes, 0, (int)c.CredentialBlobSize);
      return Encoding.UTF8.GetString(bytes);
    } finally { CredFree(p); }
  }
}
"@
$r = [AgCred]::Read(${JSON.stringify(target)})
if ($null -eq $r) { exit 2 }
Write-Output $r
`.trim();

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 15000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
    );
    const secret = String(stdout || "").replace(/^\uFEFF/, "").trim();
    if (!secret) {
      return { found: false, error: "Antigravity CLI credential entry is empty. Sign in to the CLI again." };
    }
    return finish(secret, "win32-credential-manager");
  } catch (err) {
    if (err?.code === 2 || err?.status === 2) {
      return {
        found: false,
        error: "Antigravity CLI session not found in Windows Credential Manager. Sign in with `agy` first, then retry.",
      };
    }
    return { found: false, error: err?.stderr || err?.message || "Failed to read Windows credentials" };
  }
}
