import { NextResponse } from "next/server";
import { getRequestLogById, deleteRequestLogById } from "@/lib/requestFileLogger";

export const dynamic = "force-dynamic";

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * GET /api/logs/[id]
 * Read a single request log JSON file from disk.
 */
export async function GET(_request, { params }) {
  try {
    const { id } = await params;
    if (!id || !SAFE_ID_RE.test(id)) {
      return NextResponse.json({ error: "Invalid log id" }, { status: 400 });
    }

    const log = await getRequestLogById(id);
    if (!log) {
      return NextResponse.json({ error: "Log not found" }, { status: 404 });
    }

    return NextResponse.json(log);
  } catch (error) {
    console.error("[API /api/logs/[id]] GET error:", error);
    return NextResponse.json(
      { error: "Failed to read request log" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/logs/[id]
 * Delete a single request log JSON file from disk.
 */
export async function DELETE(_request, { params }) {
  try {
    const { id } = await params;
    if (!id || !SAFE_ID_RE.test(id)) {
      return NextResponse.json({ error: "Invalid log id" }, { status: 400 });
    }

    const deleted = await deleteRequestLogById(id);
    if (!deleted) {
      return NextResponse.json({ error: "Log not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, id });
  } catch (error) {
    console.error("[API /api/logs/[id]] DELETE error:", error);
    return NextResponse.json(
      { error: "Failed to delete request log" },
      { status: 500 }
    );
  }
}
