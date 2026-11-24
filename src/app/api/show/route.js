import { findOllamaModel } from "@/sse/services/ollamaCatalog.js";
import { toOllamaModelShow } from "open-sse/utils/ollamaTransform.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS },
  });
}

/**
 * POST /api/show - Ollama-compatible model details (capabilities + context window).
 * Ollama clients send { model } (older clients: { name }).
 */
export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const name = body?.model || body?.name;
  if (!name || typeof name !== "string") {
    return json({ error: "model is required" }, 400);
  }

  const model = await findOllamaModel(name);
  if (!model) {
    return json({ error: `model '${name}' not found` }, 404);
  }

  return json(toOllamaModelShow(model));
}
