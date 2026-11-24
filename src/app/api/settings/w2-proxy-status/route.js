import { NextResponse } from "next/server";
import { probeW2ProxyStatus } from "open-sse/utils/w2Proxy.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/settings/w2-proxy-status?url=http://127.0.0.1:8899
 * Live TCP probe against the configured w2 (Whistle) proxy port.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const overrideUrl = searchParams.get("url") || null;
    const status = await probeW2ProxyStatus(overrideUrl);
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { active: false, error: error?.message || "Probe failed" },
      { status: 500 }
    );
  }
}
