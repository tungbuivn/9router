// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodes, getProviderConnections } from "@/lib/localDb";
import { parseModel as parseModelCore, resolveModelAliasFromMap, getModelInfoCore } from "open-sse/services/model.js";
import REGISTRY from "open-sse/providers/registry/index.js";

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

const RESERVED_PROVIDER_PREFIXES = new Set(Object.keys(LOCAL_PROVIDER_ALIASES));
for (const entry of REGISTRY) {
  RESERVED_PROVIDER_PREFIXES.add(entry.id);
  if (entry.alias) RESERVED_PROVIDER_PREFIXES.add(entry.alias);
  for (const alias of entry.aliases || []) RESERVED_PROVIDER_PREFIXES.add(alias);
}

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  return parsed;
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // 1. Check ACP nodes: ACP nodes represent local stdio agent servers.
    // If an ACP node matches by prefix or id, it takes precedence if the prefix is
    // not reserved OR if the reserved built-in provider has no active connections.
    const acpNodes = await getProviderNodes({ type: "acp" });

    // Support "acp/..." prefixes (e.g. "acp/kiro/auto", "acp/agy/gemini-3.8-flash", or "acp/auto")
    if (parsed.providerAlias === "acp" && acpNodes.length > 0) {
      if (parsed.model.includes("/")) {
        const slashIdx = parsed.model.indexOf("/");
        const subPrefix = parsed.model.slice(0, slashIdx);
        const actualModel = parsed.model.slice(slashIdx + 1);
        const matched = acpNodes.find((n) =>
          n.prefix === subPrefix ||
          n.prefix === `acp-${subPrefix}` ||
          n.prefix?.replace(/^acp-/, "") === subPrefix ||
          n.name?.toLowerCase() === subPrefix.toLowerCase() ||
          n.id === subPrefix
        );
        if (matched) {
          return { provider: matched.id, model: actualModel };
        }
      } else {
        const matched = acpNodes.find((n) => {
          const configured = Array.isArray(n.models) ? n.models : [];
          const hasModel = configured.some((m) => (typeof m === "string" ? m : (m.id || m.name)) === parsed.model);
          return hasModel || n.defaultModel === parsed.model || n.defaultConfigOptions?.model === parsed.model;
        }) || acpNodes[0];
        if (matched) {
          return { provider: matched.id, model: parsed.model };
        }
      }
    }

    const matchedAcp = acpNodes.find((node) =>
      node.prefix === parsed.providerAlias ||
      node.id === parsed.providerAlias ||
      node.prefix?.replace(/^acp-/, "") === parsed.providerAlias ||
      node.name?.toLowerCase() === parsed.providerAlias.toLowerCase()
    );
    if (matchedAcp) {
      if (!RESERVED_PROVIDER_PREFIXES.has(parsed.providerAlias)) {
        return { provider: matchedAcp.id, model: parsed.model };
      }
      const activeBuiltin = await getProviderConnections({ provider: parsed.provider, isActive: true });
      if (activeBuiltin.length === 0) {
        return { provider: matchedAcp.id, model: parsed.model };
      }
    }

    // 2. Provider-node prefixes are user-defined. They must not override built-in
    // provider ids/aliases such as `cf`, `cloudflare-ai`, `openai`, or `hf`.
    if (!RESERVED_PROVIDER_PREFIXES.has(parsed.providerAlias)) {
      const openaiNodes = await getProviderNodes({ type: "openai-compatible" });
      const matchedOpenAI = openaiNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedOpenAI) {
        return { provider: matchedOpenAI.id, model: parsed.model };
      }

      const anthropicNodes = await getProviderNodes({ type: "anthropic-compatible" });
      const matchedAnthropic = anthropicNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedAnthropic) {
        return { provider: matchedAnthropic.id, model: parsed.model };
      }

      const embeddingNodes = await getProviderNodes({ type: "custom-embedding" });
      const matchedEmbedding = embeddingNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedEmbedding) {
        return { provider: matchedEmbedding.id, model: parsed.model };
      }
    }
    return {
      provider: parsed.provider,
      model: parsed.model
    };
  }

  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  const combo = await getComboByName(parsed.model);
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  return fallbackToClaudeOAuth(await getModelInfoCore(modelStr, getModelAliases));
}

/**
 * Check if model is a combo and get models list
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
export async function getComboModels(modelStr) {
  // Only check if it's not in provider/model format
  if (modelStr.includes("/")) return null;

  const combo = await getComboByName(modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}

// A bare `claude-*` id infers provider "anthropic" (API key). When no anthropic
// connection is active but a Claude OAuth connection is, use "claude" instead of
// failing with "No active credentials for provider: anthropic" (same idea as the
// Codex-only gpt-* rules in open-sse/services/model.js).
async function fallbackToClaudeOAuth(info) {
  if (info?.provider !== "anthropic") return info;
  const hasActive = async (provider) =>
    (await getProviderConnections({ provider, isActive: true })).length > 0;
  if (await hasActive("anthropic")) return info;
  if (!(await hasActive("claude"))) return info;
  return { ...info, provider: "claude" };
}
