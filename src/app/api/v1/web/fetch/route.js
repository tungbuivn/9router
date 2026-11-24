import { handleFetch } from "@/sse/handlers/fetch.js";
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
 * POST /v1/web/fetch - Web URL fetch/extract endpoint
 */
export const POST = withApiRequestLog(async function POST(request) {
  return await handleFetch(request);
}, { apiType: "web-fetch", syncW2: true });
