import {
  handleOllamaChat,
  ollamaOptionsResponse,
} from "@/sse/handlers/ollamaChat.js";

export async function OPTIONS() {
  return ollamaOptionsResponse();
}

/**
 * POST /v1/api/chat - Ollama-style conversion path (same behavior as /api/chat).
 */
export async function POST(request) {
  return handleOllamaChat(request);
}
