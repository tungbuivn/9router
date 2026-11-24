// Catalog bridge for the Ollama-compatible endpoints.
//
// Zed's Ollama provider fetches /api/tags once and then calls /api/show for
// every listed model, so the expensive 9Router model build is cached and
// shared across both endpoints.

import { buildModelsList } from "@/app/api/v1/models/route.js";

const LLM_KIND = "llm";
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache = { at: 0, models: [] };
let inflight = null;

/**
 * Return 9Router's LLM models in the shape used by /v1/models.
 * @param {{ forceRefresh?: boolean }} options
 */
export async function getOllamaCatalog({ forceRefresh = false } = {}) {
  const fresh = Date.now() - cache.at < CACHE_TTL_MS;
  if (!forceRefresh && fresh) return cache.models;
  if (inflight) return inflight;

  inflight = (async () => {
    let models = [];
    try {
      models = await buildModelsList([LLM_KIND], { skipDynamicFetch: true });
    } catch (err) {
      // Fail open: an empty catalog is better than breaking Zed's provider.
      console.log("[ollama] Could not build model catalog:", err?.message || err);
    }
    cache = { at: Date.now(), models };
    return models;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/**
 * Find one model by id (exact first, then case-insensitive).
 */
export async function findOllamaModel(name) {
  const needle = String(name || "").trim();
  if (!needle) return null;
  const models = await getOllamaCatalog();
  return (
    models.find((model) => model?.id === needle) ||
    models.find((model) => String(model?.id || "").toLowerCase() === needle.toLowerCase()) ||
    null
  );
}

export function resetOllamaCatalogCache() {
  cache = { at: 0, models: [] };
  inflight = null;
}
