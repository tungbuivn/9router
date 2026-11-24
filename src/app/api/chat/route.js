import {
  handleOllamaChat,
  ollamaOptionsResponse,
} from "@/sse/handlers/ollamaChat.js";

export async function OPTIONS() {
  return ollamaOptionsResponse();
}

/**
 * POST /api/chat - Ollama-compatible chat endpoint (NDJSON stream or JSON).
 * This is the endpoint Zed's Ollama provider calls when api_url points at 9Router.
 */
export async function POST(request) {
  return handleOllamaChat(request);
}
