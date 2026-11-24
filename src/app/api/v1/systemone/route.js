import { handleSystemone } from "@/sse/handlers/systemone.js";
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
 * POST /v1/systemone - System One (Jev) decision endpoint
 */
export const POST = withApiRequestLog(async function POST(request) {
  return await handleSystemone(request);
}, { apiType: "systemone", syncW2: true });
