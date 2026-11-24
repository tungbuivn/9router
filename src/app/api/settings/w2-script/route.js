import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { getW2ScriptStatus, installW2ScriptPlugin } from "open-sse/utils/w2Capture.js";

export const dynamic = "force-dynamic";

const SCRIPT_NAME = "9router-sysprompt";
const RULE_NAME = "9router-acp-sysprompt";

function getPluginAssetsDir() {
  return path.join(process.cwd(), "scripts", "w2-plugins");
}

/**
 * GET /api/settings/w2-script?url=http://127.0.0.1:8899
 * Check if the 9router-sysprompt script is installed in Whistle (whistle.script).
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const w2Url = searchParams.get("url") || null;
    const status = await getW2ScriptStatus(w2Url, SCRIPT_NAME);
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { w2Reachable: false, installed: false, error: error?.message || "Failed to check w2 script status" },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }
}

/**
 * POST /api/settings/w2-script
 * Install/update `9router-sysprompt` into Whistle's whistle.script plugin and register rule group.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const w2Url = body?.w2Url || null;
    const enableRule = body?.enableRule === true;

    const dir = getPluginAssetsDir();
    const [scriptContent, ruleContent] = await Promise.all([
      fs.readFile(path.join(dir, "9router-sysprompt.js"), "utf8"),
      fs.readFile(path.join(dir, "rules.txt"), "utf8"),
    ]);

    const result = await installW2ScriptPlugin({
      w2Url,
      scriptName: SCRIPT_NAME,
      scriptContent,
      ruleName: RULE_NAME,
      ruleContent,
      enableRule,
    });

    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[API /api/settings/w2-script] POST error:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "Failed to install w2 script plugin" },
      { status: 502 }
    );
  }
}
