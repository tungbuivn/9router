// Ollama discovery under /v1, so clients can set api_url to either the 9Router
// root or `…/v1`. The implementation is shared with /api/tags.
export { GET, OPTIONS } from "../../../tags/route.js";
