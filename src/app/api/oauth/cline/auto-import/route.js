import { NextResponse } from "next/server";
import { createProviderConnection, getProviderConnections, updateProviderConnection } from "@/models";
import { readClineCliCredentials } from "@/lib/oauth/utils/clineCredentials";
import { getClineAccessToken } from "open-sse/shared/clineAuth.js";
import { refreshClineToken } from "open-sse/services/tokenRefresh/providers.js";

/**
 * GET /api/oauth/cline/auto-import
 * Report whether the Cline CLI is signed in on this host. Read-only: the
 * token itself never leaves the server — the response only lists which
 * provider rows were found.
 */
export async function GET(request) {
  try {
    const url = new URL(request.url);
    const targetProvider = url.searchParams.get("provider") || null;
    const creds = await readClineCliCredentials(targetProvider);
    if (!creds.found) {
      return NextResponse.json({
        found: false,
        error: creds.error || "Cline CLI credentials not found",
      });
    }
    return NextResponse.json({
      found: true,
      source: creds.source,
      // Never the token itself — only metadata
      sessions: creds.entries.map((e) => ({
        provider: e.provider,
        cliProvider: e.cliProvider,
        email: e.email,
        accountId: e.accountId,
        displayName: e.displayName,
        expiresAt: e.expiresAt,
        hasRefreshToken: !!e.refreshToken,
        model: e.model,
      })),
    });
  } catch (error) {
    console.log("Cline CLI auto-import error:", error);
    return NextResponse.json(
      { found: false, error: error.message || "Failed to read Cline CLI credentials" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/oauth/cline/auto-import
 * Import the Cline CLI's signed-in session(s) as provider connection(s).
 *
 * Body (optional): { provider?: "cline" | "clinepass" }
 */
export async function POST(request) {
  try {
    let body = {};
    try {
      body = await request.json();
    } catch {
      // Body is optional
    }

    const url = new URL(request.url);
    const targetProvider = body?.provider || url.searchParams.get("provider") || null;

    const creds = await readClineCliCredentials(targetProvider);
    if (!creds.found) {
      return NextResponse.json(
        { error: creds.error || "Cline CLI credentials not found" },
        { status: 404 },
      );
    }

    const imported = [];
    const skipped = [];

    for (const entry of creds.entries) {
      let accessToken = entry.accessToken;
      let refreshToken = entry.refreshToken;
      let expiresAt = entry.expiresAt;

      // If accessToken is expired or close to expiring, attempt refresh if refreshToken exists
      const isExpired = expiresAt ? new Date(expiresAt).getTime() <= Date.now() + 60000 : false;
      if (isExpired && refreshToken) {
        try {
          const refreshed = await refreshClineToken(refreshToken);
          if (refreshed?.accessToken) {
            accessToken = refreshed.accessToken;
            if (refreshed.refreshToken) refreshToken = refreshed.refreshToken;
            if (refreshed.expiresIn) {
              expiresAt = new Date(Date.now() + refreshed.expiresIn * 1000).toISOString();
            }
          }
        } catch (e) {
          console.warn("[cline-auto-import] Proactive token refresh failed:", e.message);
        }
      }

      if (!accessToken) {
        skipped.push({ provider: entry.provider, reason: "no access token" });
        continue;
      }

      // WorkOS JWTs must be prefixed with "workos:"
      const normalizedAccessToken = getClineAccessToken(accessToken);

      const basePayload = {
        provider: entry.provider,
        authType: "oauth",
        accessToken: normalizedAccessToken,
        refreshToken: refreshToken || null,
        expiresAt: expiresAt || null,
        email: entry.email || null,
        displayName: entry.displayName || entry.email || entry.accountId || "Cline CLI",
        providerSpecificData: {
          authMethod: "cline-cli",
          ...(entry.accountId ? { accountId: entry.accountId } : {}),
        },
        testStatus: "active",
      };

      // Match existing connection: by email first, then by accountId
      const existingConnections = await getProviderConnections({ provider: entry.provider });
      const existing = existingConnections.find((conn) => {
        if (entry.email && conn.email && conn.email.toLowerCase() === entry.email.toLowerCase()) {
          return true;
        }
        if (entry.accountId && conn.providerSpecificData?.accountId === entry.accountId) {
          return true;
        }
        return false;
      });

      if (existing) {
        const updated = await updateProviderConnection(existing.id, {
          provider: entry.provider,
          authType: "oauth",
          accessToken: normalizedAccessToken,
          refreshToken: refreshToken || null,
          expiresAt: expiresAt || null,
          email: entry.email || existing.email || null,
          displayName: entry.displayName || existing.displayName || "Cline CLI",
          providerSpecificData: {
            ...(existing.providerSpecificData || {}),
            ...basePayload.providerSpecificData,
          },
          testStatus: "active",
        });
        imported.push({
          provider: entry.provider,
          id: updated?.id || existing.id,
          email: entry.email || existing.email,
          reused: true,
        });
        continue;
      }

      const connection = await createProviderConnection(basePayload);
      imported.push({
        provider: entry.provider,
        id: connection.id,
        email: entry.email,
        reused: false,
      });
    }

    if (imported.length === 0) {
      return NextResponse.json(
        { error: "No importable Cline session found (no valid token stored).", skipped },
        { status: 400 },
      );
    }

    return NextResponse.json({ success: true, imported, skipped });
  } catch (error) {
    console.log("Cline CLI import error:", error);
    return NextResponse.json({ error: error.message || "Import failed" }, { status: 500 });
  }
}
