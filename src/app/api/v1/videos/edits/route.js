import { handleVideoCreate } from "@/sse/handlers/videoGeneration.js";
import { withApiRequestLog } from "@/lib/withApiRequestLog.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/** POST /v1/videos/edits - async video edit (xAI Grok Imagine) */
export const POST = withApiRequestLog(async function POST(request) {
  return await handleVideoCreate(request, "edits");
}, { apiType: "videos", syncW2: true });
