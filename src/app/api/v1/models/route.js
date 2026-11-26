import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS, getModelKind } from "@/shared/constants/models";
import {
  ALIAS_TO_ID,
  AI_PROVIDERS,
  FREE_PROVIDERS,
  getProviderAlias,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
  isAcpProvider,
} from "@/shared/constants/providers";
import { getProviderConnections, getProviderNodes, getCombos, getCustomModels, getModelAliases, getSettings } from "@/lib/localDb";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { getKeyAccessContext, filterModelsListForKey } from "@/sse/services/keyAccess.js";
import { withApiRequestLog } from "@/lib/withApiRequestLog.js";
import { resolveKiroModels } from "open-sse/services/kiroModels.js";
import { resolveKimchiModels } from "open-sse/services/kimchiModels.js";
import { resolveQoderModels, routableQoderModels } from "open-sse/services/qoderModels.js";
import { resolveCopilotModels } from "open-sse/services/copilotModels.js";
import { resolveClinepassModels, resolveClineModels } from "open-sse/services/clinepassModels.js";
import { resolveGrokCliModels } from "open-sse/services/grokCliModels.js";
import { resolveCursorModels } from "open-sse/services/cursorModels.js";
import { resolveZedModels } from "open-sse/shared/zedAuth.js";
import { resolveCommandCodeModels } from "open-sse/services/commandcodeModels.js";
import { updateProviderCredentials } from "@/sse/services/tokenRefresh";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { capabilitiesFromServiceKind, getCapabilitiesForModel, aggregateComboCapabilities } from "open-sse/providers/capabilities.js";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { resolveSeatCapabilities } from "@/lib/modelProviderContext.js";

// Qoder shares one live resolver across intl (qoder) and CN (qoder-cn); the
// credentials carry the provider id so qoderModels picks the right region's
// catalog endpoint.
async function resolveQoderLiveModels(conn, provider) {
  const result = await resolveQoderModels({
    provider,
    accessToken: conn.accessToken,
    // PAT (pt-...) connections keep the token in apiKey; without it the live
    // catalog silently fails and /v1/models falls back to the static list.
    apiKey: conn.apiKey,
    refreshToken: conn.refreshToken,
    email: conn.email,
    displayName: conn.displayName,
    providerSpecificData: conn.providerSpecificData || {}
  });
  // Visible + hidden (enable:false) catalog keys — chat routes all of them.
  const models = routableQoderModels(result);
  if (!models.length) return null;
  return { models: models.map((m) => ({ id: m.id, name: m.name })) };
}

// Combo seats use UI aliases; the model registry also has transport aliases.
// Capability overrides and catalog limits are keyed by provider id.
const ALIAS_TO_PROVIDER_ID = {
  ...Object.fromEntries(
    Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id])
  ),
  ...ALIAS_TO_ID,
};

function comboSeatCapabilities(seat) {
  const slash = seat.indexOf("/");
  if (slash <= 0) return null;
  const alias = seat.slice(0, slash);
  // Strip a trailing thinking-level override like "(max)" or "(high)" before the
  // capability lookup — it is not part of the model id. Otherwise the lookup
  // misses the provider-scoped catalog entry and falls through to a default.
  const model = seat.slice(slash + 1).replace(/\([^()]+\)\s*$/, "").trim();
  return getCapabilitiesForModel(ALIAS_TO_PROVIDER_ID[alias] || alias, model);
}

// Per-provider live model resolvers. Each receives a connection record and
// returns { models: [{ id, name? }, ...] } | null on failure.
// Adding a provider here makes /v1/models prefer the live catalog for it.
const LIVE_MODEL_RESOLVERS = {
  opencode: async (conn) => {
    try {
      const res = await fetch("https://opencode.ai/zen/v1/models", {
        headers: { "x-opencode-client": "desktop" },
        cache: "no-store",
      });
      if (!res.ok) return null;
      const data = await res.json();
      const raw = Array.isArray(data?.models) ? data.models : Array.isArray(data?.data) ? data.data : [];
      const KNOWN_FREE = new Set(["big-pickle"]);
      const DEAD = new Set(["deepseek-v4-flash-free"]);
      const models = raw
        .filter((m) => {
          const id = m?.id || m?.name;
          if (typeof id !== "string") return false;
          return id.endsWith("-free") || KNOWN_FREE.has(id);
        })
        .filter((m) => !DEAD.has(m?.id || m?.name))
        .map((m) => {
          const id = m.id || m.name;
          const caps = {};
          if (m.limit?.context) caps.contextWindow = m.limit.context;
          if (m.limit?.output) caps.maxOutput = m.limit.output;
          if (m.capabilities?.reasoning?.supported) caps.reasoning = true;
          if (m.capabilities?.tools?.supported) caps.tools = true;
          return { id, name: m.name || id, capabilities: Object.keys(caps).length ? caps : undefined };
        });
      return models.length ? { models } : null;
    } catch {
      return null;
    }
  },
  kiro: async (conn) => {
    const result = await resolveKiroModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      providerSpecificData: conn.providerSpecificData || {}
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  },
  qoder: async (conn) => resolveQoderLiveModels(conn, "qoder"),
  "qoder-cn": async (conn) => resolveQoderLiveModels(conn, "qoder-cn"),
  kimchi: async (conn) => {
    const result = await resolveKimchiModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
      providerSpecificData: conn.providerSpecificData || {}
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  },
  github: async (conn) => {
    const result = await resolveCopilotModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      providerSpecificData: conn.providerSpecificData || {}
    }, {
      log: console,
      onCredentialsRefreshed: async (refreshed) => {
        await updateProviderCredentials(conn.id, {
          copilotToken: refreshed.copilotToken,
          copilotTokenExpiresAt: refreshed.copilotTokenExpiresAt,
          existingProviderSpecificData: conn.providerSpecificData || {},
        });
      },
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  clinepass: async (conn) => {
    const result = await resolveClinepassModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  cline: async (conn) => {
    const result = await resolveClineModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  "grok-cli": async (conn) => {
    const proxy = await resolveConnectionProxyConfig(conn.providerSpecificData || {});
    const result = await resolveGrokCliModels({
      ...conn,
      connectionId: conn.id,
    }, {
      log: console,
      proxyOptions: {
        connectionProxyEnabled: proxy.connectionProxyEnabled === true,
        connectionProxyUrl: proxy.connectionProxyUrl || "",
        connectionNoProxy: proxy.connectionNoProxy || "",
        vercelRelayUrl: proxy.vercelRelayUrl || "",
        strictProxy: proxy.strictProxy === true,
      },
      onCredentialsRefreshed: async (refreshed) => {
        await updateProviderCredentials(conn.id, {
          ...refreshed,
          existingProviderSpecificData: conn.providerSpecificData || {},
        });
      },
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  cursor: async (conn) => {
    const result = await resolveCursorModels({
      accessToken: conn.accessToken,
      providerSpecificData: conn.providerSpecificData || {},
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  },
  zed: async (conn) => {
    const result = await resolveZedModels({
      accessToken: conn.accessToken,
      providerSpecificData: conn.providerSpecificData || {},
    });
    if (!result?.models?.length) return null;
    return {
      models: result.models
        .filter((m) => !m.isDisabled)
        .map((m) => ({
          id: m.id,
          name: m.name,
          capabilities: m.supportsTools ? { tools: true } : undefined,
        })),
    };
  },
  // CommandCode's catalog is public and account-independent, so no per-connection
  // credentials are needed — the connection only has to exist and be active.
  commandcode: async () => {
    const result = await resolveCommandCodeModels();
    if (!result?.models?.length) return null;
    return { models: result.models.map(({ id, name }) => ({ id, name })) };
  },
};

const parseOpenAIStyleModels = (data) => {
  if (Array.isArray(data)) return data;
  return data?.data || data?.models || data?.results || [];
};

// Header sent by fetchCompatibleModelIds to detect cross-instance /models fetches
// and break recursive loops between 9router instances connected to each other.
const INTERNAL_MODELS_FETCH_HEADER = "x-9r-internal-models-fetch";

// LLM kind sentinel — combos/models with no explicit kind default to LLM
const LLM_KIND = "llm";

// Map per-model `type` field (in PROVIDER_MODELS) to service kind.
// Models without `type` are treated as LLM.
const MODEL_TYPE_TO_KIND = {
  image: "image",
  tts: "tts",
  embedding: "embedding",
  stt: "stt",
  imageToText: "imageToText",
  video: "video",
};

function modelKind(model) {
  const k = model?.kind || model?.type;
  if (!k) return LLM_KIND;
  return MODEL_TYPE_TO_KIND[k] || LLM_KIND;
}

// For dynamic/unknown model IDs (compatible providers, alias map, custom models)
// fall back to provider-level kind matching when per-model type is unavailable.
function inferKindFromUnknownModelId(modelId) {
  const lower = String(modelId).toLowerCase();
  if (/embed/.test(lower)) return "embedding";
  if (/tts|speech|audio|voice/.test(lower)) return "tts";
  if (/image|imagen|dall-?e|flux|sdxl|sd-|stable-diffusion/.test(lower)) return "image";
  return LLM_KIND;
}

async function fetchCompatibleModelIds(connection) {
  if (!connection?.apiKey) return [];

  const baseUrl = typeof connection?.providerSpecificData?.baseUrl === "string"
    ? connection.providerSpecificData.baseUrl.trim().replace(/\/$/, "")
    : "";

  if (!baseUrl) return [];

  let url = `${baseUrl}/models`;
  const headers = {
    "Content-Type": "application/json",
  };

  if (isOpenAICompatibleProvider(connection.provider)) {
    headers.Authorization = `Bearer ${connection.apiKey}`;
  } else if (isAnthropicCompatibleProvider(connection.provider)) {
    if (url.endsWith("/messages/models")) {
      url = url.slice(0, -9);
    } else if (url.endsWith("/messages")) {
      url = `${url.slice(0, -9)}/models`;
    }
    headers["x-api-key"] = connection.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers.Authorization = `Bearer ${connection.apiKey}`;
  } else {
    return [];
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, {
      method: "GET",
      headers: { ...headers, [INTERNAL_MODELS_FETCH_HEADER]: "1" },
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) return [];

    const data = await response.json();
    const rawModels = parseOpenAIStyleModels(data);

    return Array.from(
      new Set(
        rawModels
          .map((model) => model?.id || model?.name || model?.model)
          .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "")
      )
    );
  } catch {
    return [];
  }
}

// Provider matches kindFilter when its serviceKinds intersect the requested kinds.
// LLM is the default kind for providers missing serviceKinds.
function providerMatchesKinds(providerId, kindFilter) {
  const provider = AI_PROVIDERS[providerId];
  const kinds = Array.isArray(provider?.serviceKinds) && provider.serviceKinds.length > 0
    ? provider.serviceKinds
    : [LLM_KIND];
  return kindFilter.some((k) => kinds.includes(k));
}

// Combo matches kindFilter when its `kind` field is in the list.
// Combos with no kind are treated as LLM.
function comboMatchesKinds(combo, kindFilter) {
  const kind = combo?.kind || LLM_KIND;
  return kindFilter.includes(kind);
}

// Nested combo names are valid seats — the model selector exposes them and
// chat routing resolves them recursively — but a no-slash seat is otherwise
// treated as a literal model and publishes the 200k floor. Expand nested
// names (cycle-guarded) so the published window is the true min across the
// whole chain.
function comboSeatLimits(combo, combosByName, visiting = new Set(), resolveCapsFn = null) {
  const name = typeof combo?.name === "string" ? combo.name : null;
  if (name) {
    if (visiting.has(name)) return { contextWindow: undefined, maxOutput: undefined };
    visiting.add(name);
  }

  let contextWindow = Infinity;
  let maxOutput = Infinity;
  try {
    for (const seat of Array.isArray(combo?.models) ? combo.models : []) {
      if (typeof seat !== "string") continue;
      const slash = seat.indexOf("/");
      if (slash <= 0) {
        const nested = combosByName.get(seat);
        if (nested) {
          const nestedLimits = comboSeatLimits(nested, combosByName, visiting, resolveCapsFn);
          if (Number.isFinite(nestedLimits.contextWindow)) contextWindow = Math.min(contextWindow, nestedLimits.contextWindow);
          if (Number.isFinite(nestedLimits.maxOutput)) maxOutput = Math.min(maxOutput, nestedLimits.maxOutput);
          continue;
        }
      }
      const caps = (resolveCapsFn ? resolveCapsFn(seat) : null) || comboSeatCapabilities(seat) || getCapabilitiesForModel(null, seat);
      if (Number.isFinite(caps?.contextWindow)) contextWindow = Math.min(contextWindow, caps.contextWindow);
      if (Number.isFinite(caps?.maxOutput)) maxOutput = Math.min(maxOutput, caps.maxOutput);
    }
  } finally {
    if (name) visiting.delete(name);
  }

  return {
    contextWindow: Number.isFinite(contextWindow) ? contextWindow : undefined,
    maxOutput: Number.isFinite(maxOutput) ? maxOutput : undefined,
  };
}

/**
 * Build OpenAI-format models list filtered by service kinds.
 * @param {string[]} kindFilter - List of service kinds to include (e.g. ["llm"], ["webSearch","webFetch"]).
 */
export async function buildModelsList(kindFilter, options = {}) {
  // When this header is present, the /v1/models request came from another
  // 9router instance's fetchCompatibleModelIds — skip dynamic fetch to break
  // cross-instance recursive loops.
  const skipDynamicFetch = options.skipDynamicFetch === true;
  let connections = [];
  let nodes = [];
  try {
    [connections, nodes] = await Promise.all([
      getProviderConnections().then((conns) => (conns || []).filter((c) => c.isActive !== false)),
      getProviderNodes().catch(() => []),
    ]);
  } catch (e) {
    console.log("Could not fetch providers, returning all models");
  }

  const activeConnectionByProvider = new Map();
  for (const conn of connections) {
    if (!activeConnectionByProvider.has(conn.provider)) {
      activeConnectionByProvider.set(conn.provider, conn);
    }
  }

  let combos = [];
  try {
    combos = await getCombos();
  } catch (e) {
    console.log("Could not fetch combos");
  }

  let customModels = [];
  try {
    customModels = await getCustomModels();
  } catch (e) {
    console.log("Could not fetch custom models");
  }

  let modelAliases = {};
  try {
    modelAliases = await getModelAliases();
  } catch (e) {
    console.log("Could not fetch model aliases");
  }

  let disabledByAlias = {};
  try {
    disabledByAlias = await getDisabledModels();
  } catch (e) {
    console.log("Could not fetch disabled models");
  }

  const isModelDisabled = (modelOrId, conn = null) => {
    const fullId = typeof modelOrId === "string" ? modelOrId.trim() : (modelOrId?.id || "").trim();
    if (!fullId) return false;

    // Global wildcard checks
    if (disabledByAlias["all"]?.includes(fullId) || disabledByAlias["*"]?.includes(fullId)) return true;

    const slashIdx = fullId.indexOf("/");
    const prefix = slashIdx > 0 ? fullId.slice(0, slashIdx).trim() : null;
    const bareId = slashIdx > 0 ? fullId.slice(slashIdx + 1).trim() : fullId.trim();

    // If combo name or single bare model
    if (!prefix) {
      if (
        disabledByAlias["combo"]?.includes(fullId) ||
        disabledByAlias["combos"]?.includes(fullId) ||
        disabledByAlias["custom"]?.includes(fullId) ||
        disabledByAlias["models"]?.includes(fullId)
      ) {
        return true;
      }
    }

    // Collect candidate alias keys that could store this model's disabled state
    const candidateKeys = new Set();
    if (prefix) {
      candidateKeys.add(prefix);
      const provId = ALIAS_TO_PROVIDER_ID[prefix] || ALIAS_TO_ID[prefix];
      if (provId) candidateKeys.add(provId);
      const alias = getProviderAlias(prefix);
      if (alias) candidateKeys.add(alias);
      const staticId = PROVIDER_ID_TO_ALIAS[prefix];
      if (staticId) candidateKeys.add(staticId);
    }

    if (conn) {
      if (conn.id) candidateKeys.add(conn.id);
      if (conn.name) candidateKeys.add(conn.name);
      if (conn.provider) {
        candidateKeys.add(conn.provider);
        const alias = getProviderAlias(conn.provider) || PROVIDER_ID_TO_ALIAS[conn.provider];
        if (alias) candidateKeys.add(alias);
      }
      if (conn.providerSpecificData?.prefix) candidateKeys.add(conn.providerSpecificData.prefix);
    }

    const baseBareId = bareId.split(":")[0];
    const leafId = bareId.includes("/") ? bareId.slice(bareId.lastIndexOf("/") + 1) : bareId;
    const baseLeafId = leafId.split(":")[0];

    // Check candidate aliases
    for (const key of candidateKeys) {
      const list = disabledByAlias[key];
      if (!Array.isArray(list) || list.length === 0) continue;

      if (
        list.includes(bareId) ||
        list.includes(fullId) ||
        list.includes(baseBareId) ||
        list.includes(leafId) ||
        list.includes(baseLeafId) ||
        (prefix && list.includes(`${prefix}/${baseBareId}`)) ||
        (prefix && list.includes(`${prefix}/${leafId}`))
      ) {
        return true;
      }

      for (const item of list) {
        if (!item) continue;
        if (item === bareId || item === fullId || item === baseBareId) return true;
        if (typeof item === "string") {
          const itemBase = item.split(":")[0];
          if (itemBase === baseBareId || itemBase === bareId) return true;
          if (item.includes("/")) {
            const itemLeaf = item.slice(item.lastIndexOf("/") + 1);
            if (itemLeaf === bareId || itemLeaf === baseBareId || itemLeaf === leafId || itemLeaf === baseLeafId) {
              return true;
            }
          }
        }
      }
    }

    // Direct check across all keys in disabledByAlias if fullId or leafId is recorded
    for (const [key, list] of Object.entries(disabledByAlias)) {
      if (!Array.isArray(list) || list.length === 0) continue;
      if (list.includes(fullId)) return true;
      if (prefix && (key === prefix || candidateKeys.has(key))) {
        if (list.includes(bareId) || list.includes(baseBareId) || list.includes(leafId)) return true;
      }
    }

    return false;
  };

  // Include no-auth free providers (e.g. opencode) so their models are exposed in /v1/models
  // Skip providers that are explicitly disabled via providerStrategies[id].disabled
  let disabledNoAuth = new Set();
  try {
    const settings = await getSettings();
    const strats = settings?.providerStrategies || {};
    for (const [id, cfg] of Object.entries(strats)) {
      if (cfg?.disabled) disabledNoAuth.add(id);
    }
  } catch {}

  // A hidden provider is not offered in the dashboard grid, so it must not be
  // auto-offered here either. `hidden` marks providers that are not wired up
  // (e.g. mimo-free: the free MiMo channel is retired — its bootstrap endpoint
  // answers 404). The dashboard toggle in providers/page.js filters on `hidden`
  // too, so such a provider has no card and therefore no switch to turn it
  // off — publishing it here would leave an unreachable model id in /v1/models.
  //
  // A provider with a real connection is unaffected: the loop below only fills
  // in providers the user never connected, and a hidden provider the user
  // explicitly connected keeps working (same as hidden OAuth providers).
  for (const [id, provider] of Object.entries(FREE_PROVIDERS || {})) {
    if (provider?.hidden) continue;
    if (provider?.noAuth && !activeConnectionByProvider.has(id) && !disabledNoAuth.has(id)) {
      activeConnectionByProvider.set(id, {
        id: "noauth",
        provider: id,
        isActive: true,
      });
    }
  }

  const models = [];
  const combosByName = new Map(
    combos.filter((c) => typeof c?.name === "string").map((c) => [c.name, c]),
  );

  // Lookup map so aggregateComboCapabilities can recursively resolve nested combos
  const comboByName = Object.fromEntries(combos.map((c) => [c.name, c.models]));

  // Pre-resolve seat capabilities from provider for all combo seats
  const seatCapsMap = new Map();
  for (const combo of combos) {
    for (const seat of combo.models || []) {
      if (typeof seat === "string" && seat.includes("/") && !seatCapsMap.has(seat)) {
        try {
          const caps = await resolveSeatCapabilities(seat, { connections, nodes });
          if (caps) seatCapsMap.set(seat, caps);
        } catch {}
      }
    }
  }

  const resolveSeatCaps = (seat) => {
    if (seatCapsMap.has(seat)) return seatCapsMap.get(seat);
    return comboSeatCapabilities(seat);
  };

  // Combos first (filtered by kind). Web combos expose `kind` so AI knows search vs fetch.
  for (const combo of combos) {
    if (!comboMatchesKinds(combo, kindFilter)) continue;
    if (isModelDisabled(combo.name)) continue;

    // Check if the combo has at least one active, non-disabled seat
    if (Array.isArray(combo.models) && combo.models.length > 0) {
      const hasAvailableSeat = combo.models.some((seat) => {
        if (typeof seat !== "string") return false;
        const slash = seat.indexOf("/");
        if (slash <= 0) {
          const nested = combosByName.get(seat);
          return nested && !isModelDisabled(nested.name);
        }
        const prefix = seat.slice(0, slash).trim();
        const bare = seat.slice(slash + 1).replace(/\([^()]+\)\s*$/, "").trim();

        // Check active connection
        const conn = connections.find((c) =>
          c.isActive !== false && (
            c.providerSpecificData?.prefix === prefix ||
            c.name === prefix ||
            getProviderAlias(c.provider) === prefix ||
            PROVIDER_ID_TO_ALIAS[c.provider] === prefix ||
            c.provider === prefix ||
            c.id === prefix
          )
        );
        if (!conn) {
          const isFree = Object.entries(FREE_PROVIDERS || {}).some(
            ([id, p]) => p?.noAuth && (getProviderAlias(id) === prefix || id === prefix)
          );
          if (!isFree) return false;
        }

        return !isModelDisabled(`${prefix}/${bare}`, conn);
      });

      if (!hasAvailableSeat) continue;
    }

    const entry = {
      id: combo.name,
      object: "model",
      owned_by: "combo",
    };
    if (combo.kind === "webSearch" || combo.kind === "webFetch") {
      entry.kind = combo.kind;
    } else {
      const comboCaps = aggregateComboCapabilities(combo.models, comboByName, resolveSeatCaps);
      if (comboCaps) entry.capabilities = comboCaps;
      // Any seat can serve the request, so the only window a combo can promise is
      // its smallest. Combo entries were the only models on this endpoint that
      // published no limits at all, which leaves a client to guess from the name —
      // and it guesses high (see the snake_case note on the per-provider path).
      const { contextWindow, maxOutput } = comboSeatLimits(combo, combosByName, new Set(), resolveSeatCaps);
      const firstSeat = (combo.models || [])[0];
      const firstCaps = firstSeat ? resolveSeatCaps(firstSeat) || getCapabilitiesForModel(null, firstSeat) : null;
      const finalContext = firstCaps?.contextWindow ?? contextWindow;
      const finalMax = firstCaps?.maxOutput ?? maxOutput;
      if (Number.isFinite(finalContext)) entry.context_length = finalContext;
      if (Number.isFinite(finalMax)) entry.max_completion_tokens = finalMax;
    }
    models.push(entry);
  }

  if (connections.length === 0) {
    // DB unavailable -> return static models, filtered by per-model kind
    for (const [alias, providerModels] of Object.entries(PROVIDER_MODELS)) {
      const providerId = ALIAS_TO_PROVIDER_ID[alias] || alias;
      // Hidden providers are not wired up — publishing their static rows would
      // advertise model ids the upstream no longer serves.
      if (AI_PROVIDERS[providerId]?.hidden) continue;
      if (!providerMatchesKinds(providerId, kindFilter)) continue;
      for (const model of providerModels) {
        if (!kindFilter.includes(modelKind(model))) continue;
        if (isModelDisabled(`${alias}/${model.id}`)) continue;
        models.push({
          id: `${alias}/${model.id}`,
          object: "model",
          owned_by: alias,
          capabilities: getCapabilitiesForModel(alias, model.id),
        });
      }
    }

    for (const customModel of customModels) {
      if (!customModel?.id || (customModel.type && customModel.type !== "llm")) continue;
      // Custom models without active connection are LLM-only by current schema
      if (!kindFilter.includes(LLM_KIND)) continue;
      const providerAlias = customModel.providerAlias;
      if (!providerAlias) continue;

      const modelId = String(customModel.id).trim();
      if (!modelId) continue;
      if (isModelDisabled(`${providerAlias}/${modelId}`)) continue;

      models.push({
        id: `${providerAlias}/${modelId}`,
        object: "model",
        owned_by: providerAlias,
      });
    }
  } else {
    for (const [providerId, conn] of activeConnectionByProvider.entries()) {
      if (!providerMatchesKinds(providerId, kindFilter)) continue;

      const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
      const outputAlias = (
        conn?.providerSpecificData?.prefix
        || getProviderAlias(providerId)
        || staticAlias
      ).trim();
      const providerModels = PROVIDER_MODELS[staticAlias] || [];
      const enabledModels = conn?.providerSpecificData?.enabledModels;
      const hasExplicitEnabledModels =
        Array.isArray(enabledModels) && enabledModels.length > 0;
      const isCompatibleProvider =
        isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId) || isAcpProvider(providerId);

      // Build kind lookup for static models so we can filter even when only IDs are exposed
      const staticModelKindById = new Map(
        providerModels.map((m) => [m.id, modelKind(m)])
      );
      let liveModelKindById = new Map();
      let liveCapabilitiesById = new Map();

      let rawModelIds = hasExplicitEnabledModels
        ? Array.from(
            new Set(
              enabledModels.filter(
                (modelId) => typeof modelId === "string" && modelId.trim() !== "",
              ),
            ),
          )
        : providerModels.map((model) => model.id);

      if (isAcpProvider(providerId)) {
        const matchedNode = (nodes || []).find((n) => n.id === providerId || n.prefix === outputAlias);
        const acpModels = (Array.isArray(conn?.providerSpecificData?.models) && conn.providerSpecificData.models.length > 0)
          ? conn.providerSpecificData.models
          : (Array.isArray(matchedNode?.models) && matchedNode.models.length > 0)
            ? matchedNode.models
            : (matchedNode?.defaultModel
                ? [matchedNode.defaultModel]
                : (conn?.providerSpecificData?.defaultModel
                    ? [conn.providerSpecificData.defaultModel]
                    : (matchedNode?.defaultConfigOptions?.model
                        ? [matchedNode.defaultConfigOptions.model]
                        : (conn?.providerSpecificData?.defaultConfigOptions?.model
                            ? [conn.providerSpecificData.defaultConfigOptions.model]
                            : ["default"]))));
        rawModelIds = acpModels.map((m) => (typeof m === "string" ? m : (m.id || m.name)));
      } else if (isCompatibleProvider && rawModelIds.length === 0 && !skipDynamicFetch) {
        rawModelIds = await fetchCompatibleModelIds(conn);
      }

      // Config-driven live catalog override (e.g. Kiro returns dynamic
      // -thinking/-agentic variants per account). On failure, fall back to
      // whatever rawModelIds already holds.
      const liveResolver = LIVE_MODEL_RESOLVERS[providerId];
      if (liveResolver && !hasExplicitEnabledModels) {
        try {
          const live = await liveResolver(conn);
          if (live?.models?.length) {
            rawModelIds = live.models.map((m) => m.id);
            liveModelKindById = new Map(
              live.models
                .filter((m) => m?.id)
                .map((m) => [m.id, modelKind(m)])
            );
            liveCapabilitiesById = new Map(
              live.models
                .filter((m) => m?.id && m.capabilities)
                .map((m) => [m.id, m.capabilities])
            );
          }
        } catch (err) {
          console.log(`Live model fetch failed for ${providerId}: ${err?.message || err}`);
        }
      }

      const modelIds = rawModelIds
        .map((modelId) => {
          if (modelId.startsWith(`${outputAlias}/`)) {
            return modelId.slice(outputAlias.length + 1);
          }
          if (modelId.startsWith(`${staticAlias}/`)) {
            return modelId.slice(staticAlias.length + 1);
          }
          if (modelId.startsWith(`${providerId}/`)) {
            return modelId.slice(providerId.length + 1);
          }
          return modelId;
        })
        .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "");

      const customModelKindById = new Map();
      const customModelIds = customModels
        .filter((m) => {
          if (!m?.id) return false;
          const kind = getModelKind(m) || LLM_KIND;
          // imageToText custom models are vision-capable chat models: expose them
          // both in the default LLM list and in /v1/models/image-to-text.
          if (!kindFilter.includes(kind) && !(kind === "imageToText" && kindFilter.includes(LLM_KIND))) return false;
          const alias = m.providerAlias;
          return alias === staticAlias || alias === outputAlias || alias === providerId;
        })
        .map((m) => {
          const modelId = String(m.id).trim();
          if (modelId) customModelKindById.set(modelId, getModelKind(m) || LLM_KIND);
          return modelId;
        })
        .filter((modelId) => modelId !== "");

      const aliasModelIds = Object.values(modelAliases || {})
        .filter((fullModel) => {
          if (typeof fullModel !== "string" || !fullModel.includes("/")) return false;
          return (
            fullModel.startsWith(`${outputAlias}/`) ||
            fullModel.startsWith(`${staticAlias}/`) ||
            fullModel.startsWith(`${providerId}/`)
          );
        })
        .map((fullModel) => {
          if (fullModel.startsWith(`${outputAlias}/`)) {
            return fullModel.slice(outputAlias.length + 1);
          }
          if (fullModel.startsWith(`${staticAlias}/`)) {
            return fullModel.slice(staticAlias.length + 1);
          }
          if (fullModel.startsWith(`${providerId}/`)) {
            return fullModel.slice(providerId.length + 1);
          }
          return fullModel;
        })
        .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "");

      const mergedModelIds = Array.from(new Set([...modelIds, ...customModelIds, ...aliasModelIds]));

      for (const modelId of mergedModelIds) {
        // Resolve kind: prefer custom/live metadata, then static, then ID heuristics.
        const customKind = customModelKindById.get(modelId);
        const liveKind = liveModelKindById.get(modelId);
        const kind = customKind || liveKind || staticModelKindById.get(modelId) || inferKindFromUnknownModelId(modelId);
        // imageToText custom models stay in the LLM list (vision-capable chat models)
        const allowAsLlm = kind === "imageToText" && kindFilter.includes(LLM_KIND);
        if (!kindFilter.includes(kind) && !allowAsLlm) continue;
        if (isModelDisabled({ id: `${outputAlias}/${modelId}` }, conn)) continue;

        const model = {
          id: `${outputAlias}/${modelId}`,
          object: "model",
          owned_by: outputAlias,
        };
        // Live-catalog resolvers (kiro/qoder/github/clinepass) mostly only return
        // { id, name } — no per-model capability data. Fall back to the same
        // pattern-matched capabilities the dashboard uses (useModelCaps.js) so
        // dynamically-discovered LLM models still surface vision/reasoning/search/tools.
        const liveCaps = liveCapabilitiesById.get(modelId);
        const serviceCaps = capabilitiesFromServiceKind(customKind || liveKind);
        const caps = liveCaps || serviceCaps || (kind === LLM_KIND ? getCapabilitiesForModel(providerId, modelId) : null);
        if (caps) model.capabilities = caps;
        // Token limits under the snake_case names the OpenAI/OpenRouter
        // convention uses. `capabilities.contextWindow` is camelCase and nested,
        // so clients matching context_length find nothing, fall back to guessing
        // the window from the model name, and guess high — a 372k model read as
        // 1.05M never reaches its compaction threshold and hard-fails upstream.
        // Emitted at top level because not every client recurses into nested
        // objects; the camelCase `capabilities` block stays for compatibility.
        if (kind === LLM_KIND || allowAsLlm) {
          let contextWindow = caps?.contextWindow;
          let maxOutput = caps?.maxOutput;
          // Live-catalog and service-kind capabilities are usually partial
          // (often just { tools: true }), so fill the gaps from the static
          // table rather than emitting null and leaving clients to guess.
          if (!Number.isFinite(contextWindow) || !Number.isFinite(maxOutput)) {
            const fallback = getCapabilitiesForModel(providerId, modelId);
            if (!Number.isFinite(contextWindow)) contextWindow = fallback.contextWindow;
            if (!Number.isFinite(maxOutput)) maxOutput = fallback.maxOutput;
          }
          if (Number.isFinite(contextWindow)) model.context_length = contextWindow;
          if (Number.isFinite(maxOutput)) model.max_completion_tokens = maxOutput;
          // Selectable reasoning levels (the set the dashboard picker shows) so clients
          // can build their effort selector from the gateway instead of keeping a
          // per-model table. Omitted when the model has no reasoning.
          const thinkingLevels = getThinkingLevels(providerId, modelId);
          if (Array.isArray(thinkingLevels) && thinkingLevels.length > 0) model.thinking_levels = thinkingLevels;
        }
        models.push(model);
      }

      // Web search/fetch — provider IS the model, expose as {alias}/search and/or {alias}/fetch with explicit kind
      const providerInfo = AI_PROVIDERS[providerId];
      if (kindFilter.includes("webSearch") && providerInfo?.searchConfig) {
        const searchId = `${outputAlias}/search`;
        if (!isModelDisabled({ id: searchId }, conn)) {
          models.push({
            id: searchId,
            object: "model",
            kind: "webSearch",
            owned_by: outputAlias,
          });
        }
      }
      if (kindFilter.includes("webFetch") && providerInfo?.fetchConfig) {
        const fetchId = `${outputAlias}/fetch`;
        if (!isModelDisabled({ id: fetchId }, conn)) {
          models.push({
            id: fetchId,
            object: "model",
            kind: "webFetch",
            owned_by: outputAlias,
          });
        }
      }
    }
  }

  const dedupedModels = [];
  const seenModelIds = new Set();
  for (const model of models) {
    if (!model?.id || seenModelIds.has(model.id)) continue;
    if (isModelDisabled(model)) continue;
    seenModelIds.add(model.id);
    dedupedModels.push(model);
  }

  return dedupedModels;
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/models - OpenAI compatible models list (LLM/chat models only by default).
 * For other capabilities use /v1/models/{kind} (image, tts, stt, embedding, image-to-text, web).
 */
export const GET = withApiRequestLog(async function GET(request) {
  try {
    // Detect cross-instance recursive /models fetch (another 9router fetching our /models)
    const skipDynamicFetch = request?.headers?.get(INTERNAL_MODELS_FETCH_HEADER) === "1";
    const data = await filterModelsListForKey(
      await getKeyAccessContext(request),
      await buildModelsList([LLM_KIND], { skipDynamicFetch })
    );
    return Response.json({ object: "list", data }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}, {
  apiType: "models",
  shouldSkip: (req) => req?.headers?.get(INTERNAL_MODELS_FETCH_HEADER) === "1",
});
