import { handleEmbeddings } from "@/sse/handlers/embeddings.js";
import { withApiRequestLog } from "@/lib/withApiRequestLog.js";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1/embeddings - OpenAI-compatible embeddings endpoint
 */
export const POST = withApiRequestLog(async function POST(request) {
  return await handleEmbeddings(request);
}, { apiType: "embeddings", syncW2: true });
