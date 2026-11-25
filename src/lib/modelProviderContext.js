import { getProviderConnections, getProviderNodes } from "./localDb.js";
import {
  ALIAS_TO_ID,
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
  isAcpProvider,
} from "../shared/constants/providers.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// In-memory cache for models discovered from provider endpoints:
// connectionOrNodeId -> { timestamp: number, models: Array }
const connectionModelsCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Find the provider connection and/or node corresponding to a prefix/alias.
 * E.g., for prefix "117", matches the custom node with prefix "117" and its connection.
 */
export async function findModelProvider(prefixOrAlias, options = {}) {
  const prefix = String(prefixOrAlias || "").trim();
  if (!prefix) return null;

  const connections = options.connections || (await getProviderConnections());
  const nodes = options.nodes || (await getProviderNodes());

  // 1. Find matching provider node (custom OpenAI-compatible / Anthropic-compatible)
  const matchedNode = (nodes || []).find((node) => {
    return (
      node.prefix === prefix ||
      node.id === prefix ||
      node.name === prefix
    );
  });

  // 2. Find matching connection
  const matchedConn = (connections || []).find((conn) => {
    if (conn.isActive === false) return false;
    if (matchedNode && conn.provider === matchedNode.id) return true;
    if (conn.providerSpecificData?.prefix === prefix) return true;
    if (conn.name === prefix) return true;
    if (conn.provider === prefix) return true;
    if (ALIAS_TO_ID[prefix] && conn.provider === ALIAS_TO_ID[prefix]) return true;
    return false;
  });

  if (!matchedConn && !matchedNode) return null;

  return {
    connection: matchedConn || null,
    node: matchedNode || null,
    prefix,
  };
}

/**
 * Fetch models dynamically from a provider connection or node (with caching and fallback).
 */
export async function fetchModelsForConnection(connection, node = null) {
  if (!connection && !node) return [];
  const cacheKey = connection?.id || node?.id || node?.prefix;

  const cached = connectionModelsCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.models;
  }

  let models = [];

  try {
    const rawBaseUrl =
      connection?.providerSpecificData?.baseUrl ||
      connection?.baseUrl ||
      node?.baseUrl ||
      node?.providerSpecificData?.baseUrl;

    const apiKey =
      connection?.apiKey ||
      connection?.accessToken ||
      connection?.providerSpecificData?.apiKey ||
      node?.apiKey;

    const providerType =
      connection?.provider ||
      node?.type ||
      node?.id ||
      "";

    if (isAcpProvider(providerType) || node?.type === "acp") {
      const nodeModels = node?.models || connection?.providerSpecificData?.models || [];
      const defaultModel = node?.defaultModel || connection?.providerSpecificData?.defaultModel || node?.defaultConfigOptions?.model;
      models = Array.isArray(nodeModels) && nodeModels.length > 0
        ? nodeModels.map((m) => typeof m === "string" ? { id: m, name: m, contextLength: 1048576 } : { contextLength: 1048576, ...m })
        : (defaultModel ? [{ id: defaultModel, name: defaultModel, contextLength: 1048576 }] : []);
      connectionModelsCache.set(cacheKey, { timestamp: Date.now(), models });
      return models;
    }

    if (rawBaseUrl) {
      let baseUrl = rawBaseUrl.replace(/\/$/, "");
      let url = `${baseUrl}/models`;
      const headers = { "Content-Type": "application/json" };
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      if (isAnthropicCompatibleProvider(providerType)) {
        if (url.endsWith("/messages/models")) {
          url = url.slice(0, -9);
        } else if (url.endsWith("/messages")) {
          url = `${url.slice(0, -9)}/models`;
        }
        if (apiKey) {
          headers["x-api-key"] = apiKey;
          headers["anthropic-version"] = "2023-06-01";
        }
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      try {
        const res = await fetch(url, {
          method: "GET",
          headers,
          cache: "no-store",
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json();
          models = Array.isArray(data)
            ? data
            : data?.data || data?.models || data?.results || [];
        }
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        // If baseUrl used localhost or 127.0.0.1, try the IPv4 / hostname alternative
        if (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1")) {
          const altUrl = baseUrl.includes("localhost")
            ? url.replace("localhost", "127.0.0.1")
            : url.replace("127.0.0.1", "localhost");
          try {
            const ctrl2 = new AbortController();
            const to2 = setTimeout(() => ctrl2.abort(), 3000);
            const res2 = await fetch(altUrl, {
              method: "GET",
              headers,
              cache: "no-store",
              signal: ctrl2.signal,
            });
            clearTimeout(to2);
            if (res2.ok) {
              const data2 = await res2.json();
              models = Array.isArray(data2)
                ? data2
                : data2?.data || data2?.models || data2?.results || [];
            }
          } catch {}
        }
      }
    }
  } catch (err) {
    if (cached) return cached.models;
  }

  connectionModelsCache.set(cacheKey, { timestamp: Date.now(), models });
  return models;
}

/**
 * Match a target model id in the models list returned dynamically by a provider.
 */
export function findModelInProviderList(models, targetModelId) {
  if (!Array.isArray(models) || !targetModelId) return null;
  const target = String(targetModelId).trim().toLowerCase();
  const targetBase = target.split(":")[0];

  // 1. Exact match on id, name, slug, or display_name, or in aliases
  let found = models.find((m) => {
    const id = (m?.id || m?.name || m?.slug || m?.model || m?.display_name || "").toLowerCase();
    if (id === target) return true;
    if (Array.isArray(m?.aliases)) {
      return m.aliases.some((a) => String(a).toLowerCase() === target);
    }
    return false;
  });
  if (found) return found;

  // 2. id + ":" + quant match (e.g. "unsloth/Qwen3-4B-GGUF" + ":" + "Q4_1")
  found = models.find((m) => {
    if (m?.id && m?.quant) {
      const full = `${m.id}:${m.quant}`.toLowerCase();
      if (full === target) return true;
    }
    return false;
  });
  if (found) return found;

  // 3. Match base id without tag/quant
  found = models.find((m) => {
    const id = (m?.id || m?.name || m?.slug || m?.model || "").toLowerCase();
    return id === targetBase;
  });
  if (found) return found;

  // 4. Prefix match (target starts with m.id or m.id starts with targetBase)
  found = models.find((m) => {
    const id = (m?.id || "").toLowerCase();
    return id && (target.startsWith(id) || id.startsWith(targetBase));
  });
  if (found) return found;

  // 5. Fallback for single-model local endpoints (llama-server, unsloth, etc.):
  // If the provider has only 1 model currently running, adopt it as fallback
  if (models.length === 1 && models[0]) {
    return models[0];
  }

  return null;
}

/**
 * Extract context length and max output from a model object returned by a provider.
 */
export function extractModelContextInfo(modelObj) {
  if (!modelObj || typeof modelObj !== "object") return null;

  const contextLength =
    modelObj.contextLength ??
    modelObj.context_length ??
    modelObj.max_context_length ??
    modelObj.native_context_length ??
    modelObj.context_window ??
    modelObj.max_model_len ??
    modelObj.meta?.n_ctx ??
    modelObj.meta?.context_length ??
    modelObj.meta?.n_ctx_train ??
    modelObj.details?.context_length ??
    modelObj.max_tokens;

  const maxOutput =
    modelObj.maxOutput ??
    modelObj.max_output ??
    modelObj.max_output_tokens ??
    modelObj.max_tokens;

  return {
    contextLength: Number.isFinite(contextLength) ? contextLength : null,
    maxOutput: Number.isFinite(maxOutput) ? maxOutput : null,
  };
}

/**
 * Resolve capabilities and context limits dynamically for a seat by querying its model provider.
 */
export async function resolveSeatCapabilities(seat, options = {}) {
  if (!seat || typeof seat !== "string") return null;
  const slash = seat.indexOf("/");
  if (slash <= 0) return null;

  const prefix = seat.slice(0, slash).trim();
  const modelId = seat.slice(slash + 1).replace(/\([^()]+\)\s*$/, "").trim();

  const providerInfo = await findModelProvider(prefix, options);
  const providerId =
    providerInfo?.connection?.provider ||
    providerInfo?.node?.id ||
    ALIAS_TO_ID[prefix] ||
    prefix;

  const defaultCaps = getCapabilitiesForModel(providerId, modelId);

  if (!providerInfo?.connection && !providerInfo?.node) {
    return defaultCaps;
  }

  const providerModels = await fetchModelsForConnection(
    providerInfo.connection,
    providerInfo.node
  );
  const matched = findModelInProviderList(providerModels, modelId);

  if (!matched) {
    return defaultCaps;
  }

  const contextInfo = extractModelContextInfo(matched);

  return {
    ...defaultCaps,
    ...(contextInfo?.contextLength ? { contextWindow: contextInfo.contextLength } : {}),
    ...(contextInfo?.maxOutput ? { maxOutput: contextInfo.maxOutput } : {}),
    ...(matched.isVL !== undefined ? { vision: matched.isVL } : {}),
    ...(matched.isReasoning !== undefined ? { reasoning: matched.isReasoning } : {}),
  };
}
