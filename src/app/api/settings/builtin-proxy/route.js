import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import {
  ensureBuiltinProxyReady,
  getBuiltinProxyStatus,
  startBuiltinProxy,
  stopBuiltinProxy,
  syncBuiltinProxyState,
} from "open-sse/utils/builtinProxy.js";
import {
  DEFAULT_INTERCEPTOR_SCRIPT,
  runInterceptorScript,
} from "open-sse/utils/interceptorScript.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store" };

const DEFAULT_SAMPLE_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
const DEFAULT_SAMPLE_BODY = {
  model: "gemini-3.8-flash",
  request: {
    systemInstruction: {
      parts: [{ text: "You are a helpful AI coding assistant running inside an ACP agent. Follow best engineering practices and verify every change carefully." }],
    },
    contents: [{ role: "user", parts: [{ text: "Hello!" }] }],
  },
};

export async function GET() {
  try {
    const settings = await getSettings();
    await syncBuiltinProxyState(settings);
    const status = getBuiltinProxyStatus();
    return NextResponse.json(status, { headers: NO_STORE });
  } catch (err) {
    return NextResponse.json(
      { error: err?.message || "Failed to read Built-in Proxy status" },
      { status: 500, headers: NO_STORE }
    );
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const action = body?.action;

    if (action === "test-script") {
      const sampleUrl = typeof body?.sampleUrl === "string" && body.sampleUrl.trim()
        ? body.sampleUrl.trim()
        : DEFAULT_SAMPLE_URL;
      const sampleBody = body?.sampleBody && typeof body.sampleBody === "object"
        ? body.sampleBody
        : DEFAULT_SAMPLE_BODY;
      const scriptCode = typeof body?.script === "string" ? body.script : DEFAULT_INTERCEPTOR_SCRIPT;

      const result = runInterceptorScript({
        url: sampleUrl,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: sampleBody,
        rawBody: JSON.stringify(sampleBody),
        source: "dry-run",
        scriptCode,
      });

      return NextResponse.json(
        {
          ok: !result.error,
          modified: result.modified,
          bodyModified: result.bodyModified,
          headersModified: result.headersModified,
          sysFormat: result.sysFormat,
          beforeSysPromptChars: result.beforeSysPromptChars,
          afterSysPromptChars: result.afterSysPromptChars,
          logs: result.logs,
          error: result.error,
          durationMs: result.durationMs,
          previewBody: result.body,
          previewHeaders: result.headers,
        },
        { headers: NO_STORE }
      );
    }

    if (action === "reset-script") {
      const settings = await updateSettings({ builtinProxyScript: DEFAULT_INTERCEPTOR_SCRIPT });
      const status = await syncBuiltinProxyState(settings);
      return NextResponse.json({ success: true, status }, { headers: NO_STORE });
    }

    if (action === "restart") {
      const settings = await getSettings();
      await stopBuiltinProxy();
      const status = settings.builtinProxyEnabled !== false
        ? await startBuiltinProxy(settings.builtinProxyPort)
        : await ensureBuiltinProxyReady();
      return NextResponse.json({ success: true, status }, { headers: NO_STORE });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400, headers: NO_STORE });
  } catch (err) {
    return NextResponse.json(
      { error: err?.message || "Built-in proxy action failed" },
      { status: 500, headers: NO_STORE }
    );
  }
}
