import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { resolveProviderId } from "@/shared/constants/providers";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * POST /api/oauth/minimax-cli/bulk-import
 * Bulk import multiple MiniMax CLI (device_code OAuth) account objects.
 *
 * Each account object can have:
 *   access_token / accessToken (required)
 *   refresh_token / refreshToken (optional)
 *   expires_in / expiresIn (optional, seconds)
 *   email (optional, auto-filled from token if not provided)
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return NextResponse.json(
      { error: `Invalid JSON body: ${err.message}` },
      { status: 400 }
    );
  }

  let accounts;
  if (Array.isArray(body)) {
    accounts = body;
  } else if (body && typeof body === "object" && Array.isArray(body.accounts)) {
    accounts = body.accounts;
  } else if (body && typeof body === "object") {
    accounts = [body];
  } else {
    accounts = null;
  }

  if (!Array.isArray(accounts) || accounts.length === 0) {
    return NextResponse.json(
      { error: "No accounts provided" },
      { status: 400 }
    );
  }

  const results = [];
  let success = 0;
  let failed = 0;

  for (let i = 0; i < accounts.length; i++) {
    const raw = accounts[i];
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("Item is not an object");
      }

      const accessToken = raw.access_token || raw.accessToken;
      const refreshToken = raw.refresh_token || raw.refreshToken || null;
      let email = raw.email || null;

      if (!accessToken || typeof accessToken !== "string") {
        throw new Error("Missing access_token / accessToken");
      }

      let expiresAt = raw.expires_at || raw.expiresAt || null;
      const expiresIn = raw.expires_in || raw.expiresIn;
      if (!expiresAt && typeof expiresIn === "number" && expiresIn > 0) {
        expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
      }

      const psd = {
        authMethod: "device_code",
        ...(email ? { email } : {}),
      };

      const created = await createProviderConnection({
        provider: "minimax-code-global",
        authType: "oauth",
        accessToken,
        refreshToken,
        expiresAt,
        email,
        displayName: raw.displayName || raw.name || undefined,
        providerSpecificData: psd,
        testStatus: "active",
      });

      success++;
      results.push({ index: i, ok: true, id: created.id, email: created.email });
    } catch (err) {
      failed++;
      results.push({ index: i, ok: false, error: err.message });
    }
  }

  return NextResponse.json({
    total: accounts.length,
    success,
    failed,
    results,
  });
}
