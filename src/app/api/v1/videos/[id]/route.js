import { handleVideoGet } from "@/sse/handlers/videoGeneration.js";
import { withApiRequestLog } from "@/lib/withApiRequestLog.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/** GET /v1/videos/{request_id} - poll async video job status (xAI Grok Imagine) */
export const GET = withApiRequestLog(async function GET(request, { params }) {
  const { id } = await params;
  return await handleVideoGet(request, id);
}, { apiType: "videos", syncW2: true });
