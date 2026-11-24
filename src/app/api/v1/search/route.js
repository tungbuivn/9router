import { handleSearch } from "@/sse/handlers/search.js";
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
 * POST /v1/search - Web search endpoint
 */
export const POST = withApiRequestLog(async function POST(request) {
  return await handleSearch(request);
}, { apiType: "search", syncW2: true });
