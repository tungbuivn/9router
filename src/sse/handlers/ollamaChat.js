// Ollama-compatible chat handler shared by /api/chat and /v1/api/chat.

import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import {
  ollamaToOpenAIBody,
  openAIJsonToOllama,
  transformToOllama,
} from "open-sse/utils/ollamaTransform.js";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export function ollamaOptionsResponse() {
  return new Response(null, { headers: CORS_HEADERS });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

/**
 * Attach a 9Router API key when the caller did not send one (mirrors the
 * dashboard convenience behavior). Local Ollama clients often send no auth.
 */
async function ensureAuthorization(headers) {
  if (headers.get("authorization") || headers.get("x-api-key")) return;
  try {
    const { getApiKeys } = await import("@/lib/localDb");
    const keys = await getApiKeys();
    const activeKeys = (keys || []).filter((key) => key.isActive !== false);
    const defaultKey = (activeKeys.find((key) => !key.access?.restricted) || activeKeys[0])?.key;
    if (defaultKey) headers.set("authorization", `Bearer ${defaultKey}`);
  } catch {
    // No DB context (or no keys) — let the request continue unauthenticated.
  }
}

async function upstreamErrorMessage(response) {
  try {
    const text = await response.text();
    if (!text) return `Upstream error ${response.status}`;
    try {
      const parsed = JSON.parse(text);
      return (
        parsed?.error?.message ||
        parsed?.error ||
        parsed?.message ||
        text
      );
    } catch {
      return text;
    }
  } catch {
    return `Upstream error ${response.status}`;
  }
}

/**
 * POST handler for Ollama /api/chat requests.
 * Accepts `stream: true` (NDJSON) and `stream: false` (single JSON object).
 */
export async function handleOllamaChat(request) {
  await ensureInitialized();

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const modelName =
    typeof body?.model === "string" && body.model.trim() ? body.model.trim() : "9router";
  const openaiBody = ollamaToOpenAIBody({ ...body, model: modelName });

  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  await ensureAuthorization(headers);

  const upstreamRequest = new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify(openaiBody),
    signal: request.signal,
  });

  let upstream;
  try {
    upstream = await handleChat(upstreamRequest, { isDashboard: true });
  } catch (err) {
    return jsonResponse({ error: err?.message || String(err) }, 500);
  }

  if (!upstream || !upstream.ok) {
    const status = upstream?.status || 500;
    const message = upstream ? await upstreamErrorMessage(upstream) : "No upstream response";
    return jsonResponse({ error: String(message) }, status);
  }

  if (openaiBody.stream === false) {
    let payload;
    try {
      payload = await upstream.json();
    } catch {
      return jsonResponse({ error: "Upstream returned a non-JSON response" }, 502);
    }
    return jsonResponse(openAIJsonToOllama(payload, modelName));
  }

  return transformToOllama(upstream, modelName);
}
