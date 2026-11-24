import { NextResponse } from "next/server";
import {
  listLocalSkills,
  setSkillsEnabled,
  applySkillsPreset,
  syncSkillCatalog,
} from "@/lib/localSkillsManager.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const data = await listLocalSkills();
    return NextResponse.json(data, { headers: NO_STORE });
  } catch (err) {
    return NextResponse.json(
      { error: err?.message || "Failed to list local skills" },
      { status: 500, headers: NO_STORE }
    );
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const action = body?.action;

    if (action === "toggle") {
      if (!body?.name) {
        return NextResponse.json({ error: "Missing skill name" }, { status: 400, headers: NO_STORE });
      }
      const res = await setSkillsEnabled([body.name], Boolean(body.enabled));
      return NextResponse.json(res, { headers: NO_STORE });
    }

    if (action === "batch") {
      const names = Array.isArray(body?.names) ? body.names : [];
      const res = await setSkillsEnabled(names, Boolean(body.enabled));
      return NextResponse.json(res, { headers: NO_STORE });
    }

    if (action === "preset") {
      const preset = String(body?.preset || "");
      if (!["core", "all", "none", "minimal"].includes(preset)) {
        return NextResponse.json({ error: `Invalid preset: ${preset}` }, { status: 400, headers: NO_STORE });
      }
      const res = await applySkillsPreset(preset);
      return NextResponse.json(res, { headers: NO_STORE });
    }

    if (action === "sync-catalog") {
      await syncSkillCatalog();
      const state = await listLocalSkills();
      return NextResponse.json({ changed: [], skipped: [], state }, { headers: NO_STORE });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400, headers: NO_STORE });
  } catch (err) {
    return NextResponse.json(
      { error: err?.message || "Failed to update skills" },
      { status: 500, headers: NO_STORE }
    );
  }
}
