import { NextResponse } from "next/server";
import { getRequestLogById, updateRequestLogStage } from "@/lib/requestFileLogger";
import { pullW2CapturesForWindow } from "open-sse/utils/w2Capture.js";
import { getW2AutoProxyConfig } from "open-sse/utils/w2Proxy.js";

export const dynamic = "force-dynamic";

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * POST /api/logs/[id]/sync-w2
 * On-demand pull of matching upstream requests from Whistle (w2) for a specific logged request.
 */
export async function POST(_request, { params }) {
  try {
    const { id } = await params;
    if (!id || !SAFE_ID_RE.test(id)) {
      return NextResponse.json({ error: "Invalid log id" }, { status: 400 });
    }

    const log = await getRequestLogById(id);
    if (!log) {
      return NextResponse.json({ error: "Log not found" }, { status: 404 });
    }

    const startTime = new Date(log.createdAt).getTime();
    const totalMs = Number(log.latency?.total || 0);
    const updatedMs = log.updatedAt ? new Date(log.updatedAt).getTime() : startTime;
    const endTime = Math.max(updatedMs, startTime + totalMs, startTime + 1000);
    const w2Url = log.afterModify?.executorPayload?.w2Proxy?.url || getW2AutoProxyConfig().url;

    const w2Capture = await pullW2CapturesForWindow({
      w2Url,
      startTime,
      endTime,
      count: 80,
    });

    await updateRequestLogStage(id, "w2Capture", w2Capture, {
      w2CaptureCount: w2Capture.captureCount,
      w2HasSystemPrompt: w2Capture.hasSystemPrompt,
    });

    const refreshed = await getRequestLogById(id);
    return NextResponse.json(refreshed, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[API /api/logs/[id]/sync-w2] POST error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to sync w2 captures (is w2 running?)" },
      { status: 502 }
    );
  }
}
