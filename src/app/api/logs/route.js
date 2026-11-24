import { NextResponse } from "next/server";
import { listRequestLogs, clearAllRequestLogs } from "@/lib/requestFileLogger";

export const dynamic = "force-dynamic";

/**
 * GET /api/logs
 * List metadata of up to 100 most recent request logs stored on disk.
 * Query params: search, provider, status
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search") || "";
    const provider = searchParams.get("provider") || "";
    const status = searchParams.get("status") || "";
    const apiType = searchParams.get("apiType") || "";

    const data = await listRequestLogs({ search, provider, status, apiType });
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API /api/logs] GET error:", error);
    return NextResponse.json(
      { error: "Failed to load request logs" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/logs
 * Clear all request log JSON files on disk.
 */
export async function DELETE() {
  try {
    const cleared = await clearAllRequestLogs();
    return NextResponse.json({ success: true, cleared });
  } catch (error) {
    console.error("[API /api/logs] DELETE error:", error);
    return NextResponse.json(
      { error: "Failed to clear request logs" },
      { status: 500 }
    );
  }
}
