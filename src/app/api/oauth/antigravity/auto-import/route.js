import { NextResponse } from "next/server";
import { PROVIDERS } from "open-sse/providers/index.js";
import { ANTIGRAVITY_CONFIG, getOAuthClientMetadata } from "@/lib/oauth/constants/oauth";
import { refreshGoogleToken } from "@/sse/services/tokenRefresh";
import { readAntigravityCliCredentials } from "@/lib/oauth/utils/antigravityCredentials";
import { createProviderConnection, getProviderConnections, updateProviderConnection } from "@/models";

/**
 * GET /api/oauth/antigravity/auto-import
 * Report whether the Antigravity CLI is signed in on this host. Read-only:
 * the token itself never leaves the server.
 */
export async function GET() {
  try {
    const creds = await readAntigravityCliCredentials();
    if (!creds.found) {
      return NextResponse.json({
        found: false,
        error: creds.error || "Antigravity CLI credentials not found",
      });
    }
    return NextResponse.json({
      found: true,
      email: creds.email || null,
      expiresAt: creds.expiresAt || null,
      source: creds.source,
    });
  } catch (error) {
    console.log("Antigravity CLI auto-import error:", error);
    return NextResponse.json(
      { found: false, error: error.message || "Failed to read Antigravity CLI credentials" },
      { status: 500 },
    );
  }
}

/**
 * Resolve the Code Assist project id the CLI's token is onboarded to.
 * Mirrors what the OAuth postExchange step stores, so imported connections
 * route exactly like OAuth-created ones.
 */
async function loadProjectId(accessToken) {
  const response = await fetch(ANTIGRAVITY_CONFIG.loadCodeAssistEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": ANTIGRAVITY_CONFIG.loadCodeAssistUserAgent,
      "x-request-source": "local",
    },
    body: JSON.stringify({ metadata: getOAuthClientMetadata() }),
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  const project = data?.cloudaicompanionProject;
  const projectId = typeof project === "object" && project !== null ? project.id : project;
  return typeof projectId === "string" && projectId.trim() ? projectId.trim() : null;
}

/**
 * POST /api/oauth/antigravity/auto-import
 * Import the Antigravity CLI's session as a provider connection.
 *
 * The CLI's refresh token is a plain Google OAuth credential issued to the same
 * client id this provider uses, so it is exchanged here (server-side) and the
 * connection is created with the same shape the OAuth flow produces.
 */
export async function POST() {
  try {
    const creds = await readAntigravityCliCredentials();
    if (!creds.found) {
      return NextResponse.json(
        { error: creds.error || "Antigravity CLI credentials not found" },
        { status: 404 },
      );
    }

    const refreshed = await refreshGoogleToken(
      creds.refreshToken,
      PROVIDERS.antigravity.clientId,
      PROVIDERS.antigravity.clientSecret,
    );
    if (!refreshed?.accessToken) {
      return NextResponse.json(
        { error: "Failed to exchange the Antigravity CLI token. Sign in to the CLI again, then retry." },
        { status: 400 },
      );
    }

    const projectId = await loadProjectId(refreshed.accessToken);
    const email = creds.email || null;

    // One connection per account: re-importing refreshes the existing row
    // instead of stacking duplicates.
    const existing = email
      ? (await getProviderConnections({ provider: "antigravity" })).find(
          (conn) => conn.email && conn.email.toLowerCase() === email.toLowerCase(),
        )
      : null;

    const basePayload = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken || creds.refreshToken,
      expiresIn: refreshed.expiresIn,
      expiresAt: refreshed.expiresIn
        ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()
        : null,
      email,
      ...(projectId ? { projectId } : {}),
      testStatus: "active",
    };

    if (existing) {
      // updateProviderConnection merges shallowly, so providerSpecificData must
      // be spread over the stored value — otherwise re-importing would drop the
      // connection's proxy settings and any other provider-specific state.
      const updated = await updateProviderConnection(existing.id, {
        ...basePayload,
        providerSpecificData: {
          ...(existing.providerSpecificData || {}),
          authMethod: "antigravity-cli",
        },
      });
      return NextResponse.json({
        success: true,
        reused: true,
        connection: {
          id: updated?.id || existing.id,
          provider: "antigravity",
          email,
        },
      });
    }

    const connection = await createProviderConnection({
      provider: "antigravity",
      authType: "oauth",
      ...basePayload,
      providerSpecificData: { authMethod: "antigravity-cli" },
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
      },
    });
  } catch (error) {
    console.log("Antigravity CLI import error:", error);
    return NextResponse.json({ error: error.message || "Import failed" }, { status: 500 });
  }
}
