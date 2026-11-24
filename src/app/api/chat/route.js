import { NextResponse } from "next/server";
import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function POST(request) {
  await ensureInitialized();

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Convenience shorthand: allow { model, message } or { model, prompt }
  if (!body.messages && (body.message || body.prompt)) {
    body.messages = [{ role: "user", content: body.message || body.prompt }];
  }

  const headers = new Headers(request.headers);
  if (!headers.get("authorization")) {
    try {
      const { getApiKeys } = await import("@/lib/localDb");
      const keys = await getApiKeys();
      const activeKeys = keys.filter((k) => k.isActive !== false);
      const defaultKey = (activeKeys.find((k) => !k.access?.restricted) || activeKeys[0])?.key;
      if (defaultKey) {
        headers.set("authorization", `Bearer ${defaultKey}`);
      }
    } catch {}
  }

  const newRequest = new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  return await handleChat(newRequest, { isDashboard: true });
}
