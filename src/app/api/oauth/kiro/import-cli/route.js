import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { KiroService } from "@/lib/oauth/services/kiro";
import { readKiroCliCredentials, readKiroCliKeyringCredentials, readKiroCliWhoami } from "@/lib/oauth/utils/kiroCliCredentials";
import { captureKiroAuthFromW2 } from "@/lib/oauth/utils/kiroW2Capture";
import { getW2AutoProxyConfig, normalizeW2ProxyUrl } from "open-sse/utils/w2Proxy.js";

export const dynamic = "force-dynamic";

const VALID_SOURCES = new Set(["auto", "cli", "keyring", "w2"]);

/**
 * Only loopback / private-range Whistle instances may be queried, so a crafted
 * request cannot turn this endpoint into an SSRF probe against arbitrary hosts.
 */
function isSafeW2Host(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^10(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(host)) return true;
  return false;
}

function resolveW2Url(requested) {
  const configured = normalizeW2ProxyUrl(getW2AutoProxyConfig().url);
  const raw = String(requested || "").trim();
  if (!raw) return configured;
  try {
    const parsed = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`);
    if (!isSafeW2Host(parsed.hostname)) return configured;
    return normalizeW2ProxyUrl(raw);
  } catch {
    return configured;
  }
}

/**
 * POST /api/oauth/kiro/import-cli
 *
 * Import the Kiro session of the local Kiro CLI.
 *
 * Sources (body `source`, default "auto"):
 *   - "cli"     : the CLI's own data file (~/.local/share/kiro-cli/data.sqlite3) / ~/.kiro
 *   - "keyring" : the OS secret store (libsecret / Keychain)
 *   - "w2"      : captured from a Whistle (w2) proxy on 127.0.0.1:8899
 *   - "auto"    : cli -> keyring -> w2
 */
export async function POST(request) {
  try {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const source = VALID_SOURCES.has(body?.source) ? body.source : "auto";
    const w2Url = resolveW2Url(body?.w2Url);

    const attempts = [];
    let credentials = null;

    const tryCli = async () => {
      const result = await readKiroCliCredentials();
      attempts.push({ source: "cli", found: !!result.found, error: result.error });
      return result.found ? result : null;
    };
    const tryKeyring = async () => {
      const result = await readKiroCliKeyringCredentials();
      attempts.push({ source: "keyring", found: !!result.found, error: result.error });
      return result.found ? result : null;
    };
    const tryW2 = async () => {
      const result = await captureKiroAuthFromW2({ w2Url });
      attempts.push({ source: "w2", found: !!result.found, error: result.error });
      return result.found ? result : null;
    };

    if (source === "cli") credentials = await tryCli();
    else if (source === "keyring") credentials = await tryKeyring();
    else if (source === "w2") credentials = await tryW2();
    else {
      credentials = (await tryCli()) || (await tryKeyring()) || (await tryW2());
    }

    if (!credentials) {
      return NextResponse.json(
        {
          error: "No Kiro CLI session found.",
          attempts,
          hint:
            source === "w2"
              ? "Start the Kiro CLI through the proxy (HTTPS_PROXY=http://127.0.0.1:8899 kiro-cli chat) and retry."
              : "Sign in with `kiro-cli login`, or retry with source=w2 to capture from the proxy.",
        },
        { status: 404 }
      );
    }

    const isIdc = credentials.authMethod === "idc" && credentials.clientId && credentials.clientSecret;
    const providerSpecificData = {
      ...(credentials.profileArn ? { profileArn: credentials.profileArn } : {}),
      ...(credentials.region ? { region: credentials.region } : {}),
      ...(isIdc
        ? {
            clientId: credentials.clientId,
            clientSecret: credentials.clientSecret,
          }
        : {}),
    };

    const kiroService = new KiroService();

    let accessToken = credentials.accessToken || null;
    let refreshToken = credentials.refreshToken || null;
    let expiresAt = credentials.expiresAt || null;
    let refreshWarning = null;

    // A refresh token is the only credential that keeps working after the
    // access token expires — validate it (and mint a fresh access token) when
    // we have one, but never fail the import because the refresh endpoint is
    // unreachable.
    if (refreshToken) {
      try {
        const refreshed = await kiroService.refreshToken(
          refreshToken,
          isIdc ? { ...providerSpecificData, authMethod: "idc" } : {}
        );
        accessToken = refreshed.accessToken || accessToken;
        refreshToken = refreshed.refreshToken || refreshToken;
        expiresAt = new Date(Date.now() + (refreshed.expiresIn || 3600) * 1000).toISOString();
        if (!providerSpecificData.profileArn && refreshed.profileArn) {
          providerSpecificData.profileArn = refreshed.profileArn;
        }
      } catch (error) {
        refreshWarning = `Could not refresh the imported token: ${error?.message || error}`;
      }
    } else {
      // Access-token-only sessions (e.g. a proxy capture without the token
      // request) cannot be refreshed — say so instead of failing silently.
      refreshWarning =
        "Only an access token was found. The connection cannot be refreshed and stops working when that token expires.";
    }

    if (!accessToken) {
      return NextResponse.json(
        { error: "The captured Kiro session has no usable access token.", attempts },
        { status: 400 }
      );
    }

    let email = kiroService.extractEmailFromJWT?.(accessToken) || credentials.email || null;
    if (!email) {
      // The access token carries no email — ask the CLI which local account it
      // is, so the connection is deduplicated by identity in the dashboard.
      const whoami = await readKiroCliWhoami();
      email = whoami?.email || null;
    }

    const connection = await createProviderConnection({
      provider: "kiro",
      authType: "oauth",
      accessToken,
      refreshToken,
      expiresAt,
      email,
      providerSpecificData: {
        ...providerSpecificData,
        authMethod: isIdc ? "idc" : "imported",
        provider: "Kiro CLI",
      },
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      source: credentials.source || source,
      warning: refreshWarning,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
      },
    });
  } catch (error) {
    console.error("Kiro CLI import error:", error?.message || error);
    return NextResponse.json(
      { error: error?.message || "Kiro CLI import failed" },
      { status: 500 }
    );
  }
}
