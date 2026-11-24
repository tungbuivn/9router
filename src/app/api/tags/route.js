import { getOllamaCatalog } from "@/sse/services/ollamaCatalog.js";
import { toOllamaModelTag } from "open-sse/utils/ollamaTransform.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

/**
 * GET /api/tags - Ollama-compatible model listing backed by 9Router's catalog.
 * Zed's Ollama provider discovers models here, then calls /api/show per model.
 */
export async function GET(request) {
  let forceRefresh = false;
  try {
    forceRefresh = new URL(request.url).searchParams.get("refresh") === "1";
  } catch {
    // Non-standard request objects (tests) — use the cache.
  }

  const models = await getOllamaCatalog({ forceRefresh });
  return new Response(JSON.stringify({ models: models.map(toOllamaModelTag) }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  });
}
