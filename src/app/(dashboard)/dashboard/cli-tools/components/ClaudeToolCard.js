"use client";

import { useState, useEffect, useRef } from "react";
import { Card, Button, ModelSelectModal, ManualConfigModal, Tooltip } from "@/shared/components";
import Image from "next/image";
import BaseUrlSelect from "./BaseUrlSelect";
import { rememberEndpoint } from "./cliEndpointPresets";
import ApiKeySelect from "./ApiKeySelect";
import { matchKnownEndpoint } from "./cliEndpointMatch";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { useModelCaps } from "@/shared/hooks/useModelCaps";

const CLOUD_URL = process.env.NEXT_PUBLIC_CLOUD_URL;

// Auto-compact window presets (CLAUDE_CODE_AUTO_COMPACT_WINDOW, valid 32K–1M).
// UI shows the round number; the value written is nudged down 2K to stay safely
// under the upstream hard cap.
const FIXED_CONTEXT_OPTIONS = [
  { label: "Default", value: "" },
  { label: "32K", value: "30000" },
  { label: "40K", value: "38000" },
  { label: "64K", value: "60000" },
  { label: "100K", value: "98000" },
  { label: "128K", value: "124000" },
  { label: "200K", value: "198000" },
  { label: "300K", value: "298000" },
  { label: "500K", value: "498000" },
  { label: "700K", value: "698000" },
];

const fmtContext = (tokens) => {
  if (!tokens || typeof tokens !== "number") return null;
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const k = Math.round(tokens / 1_000);
    return `${k}k`;
  }
  return `${tokens}`;
};

// Claude Code assumes a model's window is 200K unless the name carries the `[1m]`
// marker, which is why the 1M auto-compact preset only takes effect once the
// marker is applied.

export default function ClaudeToolCard({
  tool,
  isExpanded,
  onToggle,
  activeProviders,
  modelMappings,
  onModelMappingChange,
  baseUrl,
  hasActiveProviders,
  apiKeys,
  cloudEnabled,
  initialStatus,
  tunnelEnabled,
  tunnelPublicUrl,
  tailscaleEnabled,
  tailscaleUrl,
}) {
  const { getCaps } = useModelCaps();
  const [claudeStatus, setClaudeStatus] = useState(initialStatus || null);
  const [checkingClaude, setCheckingClaude] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState(null);
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [currentEditingAlias, setCurrentEditingAlias] = useState(null);
  const [selectedApiKey, setSelectedApiKey] = useState("");
  const [modelAliases, setModelAliases] = useState({});
  const [showManualConfigModal, setShowManualConfigModal] = useState(false);
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [ccFilterNaming, setCcFilterNaming] = useState(false);
  const [exaMcpEnabled, setExaMcpEnabled] = useState(false);
  const [autoCompactWindow, setAutoCompactWindow] = useState("");
  const [oneMContext, setOneMContext] = useState(false);
  const [maxContextTokens, setMaxContextTokens] = useState("");
  const [compactMode, setCompactMode] = useState("percent"); // "percent" | "fixed" | "default"
  const [compactPct, setCompactPct] = useState("80");
  const [disableUnknownModelEnforcement, setDisableUnknownModelEnforcement] = useState(true);
  const [enableGatewayDiscovery, setEnableGatewayDiscovery] = useState(true);
  const hasInitializedModels = useRef(false);
  const hasUserEditedMaxContext = useRef(false);

  // Sonnet is Claude Code's primary default model; fallback to opus, fable, or haiku
  const primaryModelMapping = modelMappings["sonnet"] || modelMappings["opus"] || modelMappings["fable"] || modelMappings["haiku"] || "";
  const cleanPrimaryModel = primaryModelMapping ? stripModelContextMarker(primaryModelMapping).model : "";
  const primaryCaps = cleanPrimaryModel ? getCaps(cleanPrimaryModel) : null;
  const detectedPrimaryContext = primaryCaps?.contextWindow || null;

  // Auto-fill maxContextTokens on initial load or model change if user hasn't typed custom tokens
  useEffect(() => {
    if (!hasUserEditedMaxContext.current && detectedPrimaryContext && !maxContextTokens) {
      setMaxContextTokens(String(detectedPrimaryContext));
    }
  }, [detectedPrimaryContext, maxContextTokens]);

  // Claude Code only string-matches the marker against the model name, so it
  // applies to any id — the user decides which models are worth declaring as 1M.
  // Stripping first keeps repeated toggles from stacking `[1m][1m]`.
  const withContextMarker = (value, enabled) => {
    const { model } = stripModelContextMarker(value);
    return enabled ? `${model}[1m]` : model;
  };

  // Rewrite the mappings in place on toggle, so the inputs show what will be
  // written without waiting for Apply.
  const handleOneMContextToggle = (enabled) => {
    setOneMContext(enabled);
    tool.defaultModels.forEach((model) => {
      const current = modelMappings[model.alias];
      if (current) onModelMappingChange(model.alias, withContextMarker(current, enabled));
    });
    if (enabled) {
      setMaxContextTokens("1000000");
    } else if (detectedPrimaryContext) {
      setMaxContextTokens(String(detectedPrimaryContext));
    }
  };

  const currentBaseUrl = claudeStatus?.settings?.env?.ANTHROPIC_BASE_URL || "";

  const getConfigStatus = () => {
    if (!claudeStatus?.installed) return null;
    const currentUrl = claudeStatus.settings?.env?.ANTHROPIC_BASE_URL;
    if (!currentUrl) return "not_configured";
    if (matchKnownEndpoint(currentUrl, { tunnelPublicUrl, tailscaleUrl, cloudUrl: cloudEnabled ? CLOUD_URL : null })) return "configured";
    return "other";
  };

  const configStatus = getConfigStatus();

  useEffect(() => {
    if (apiKeys?.length > 0 && !selectedApiKey) {
      setSelectedApiKey(apiKeys[0].key);
    }
  }, [apiKeys, selectedApiKey]);

  useEffect(() => {
    if (initialStatus) {
      setClaudeStatus(initialStatus);
      setExaMcpEnabled(!!initialStatus.exaMcpEnabled);
    }
  }, [initialStatus]);

  useEffect(() => {
    const env = claudeStatus?.settings?.env;
    if (!env) return;

    if (env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
      setMaxContextTokens(String(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS));
      hasUserEditedMaxContext.current = true;
    }

    if (env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) {
      setCompactMode("percent");
      setCompactPct(String(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE));
    } else if (env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) {
      setCompactMode("fixed");
      setAutoCompactWindow(String(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW));
    } else if (claudeStatus?.settings?.autoCompactWindow) {
      setCompactMode("fixed");
      setAutoCompactWindow(String(claudeStatus.settings.autoCompactWindow));
    }

    if (env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT !== undefined) {
      setDisableUnknownModelEnforcement(
        env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT === "1" ||
        env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT === true ||
        env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT === "true"
      );
    }

    if (env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY !== undefined) {
      setEnableGatewayDiscovery(
        env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === "1" ||
        env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === true ||
        env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === "true"
      );
    }
  }, [claudeStatus]);

  useEffect(() => {
    const env = claudeStatus?.settings?.env;
    if (!env) return;
    setOneMContext(tool.defaultModels.some((model) => env[model.envKey]?.endsWith("[1m]")));
  }, [claudeStatus?.settings?.env, tool.defaultModels]);

  useEffect(() => {
    if (isExpanded) {
      if (!claudeStatus) checkClaudeStatus();
      fetchModelAliases();
    }
  }, [isExpanded]);

  useEffect(() => {
    fetch("/api/settings").then(r => r.json()).then(data => {
      setCcFilterNaming(!!data.ccFilterNaming);
    }).catch(() => {});
  }, []);

  const handleCcFilterNamingToggle = async (e) => {
    const value = e.target.checked;
    setCcFilterNaming(value);
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ccFilterNaming: value }),
    }).catch(() => {});
  };

  const fetchModelAliases = async () => {
    try {
      const res = await fetch("/api/models/alias");
      const data = await res.json();
      if (res.ok) setModelAliases(data.aliases || {});
    } catch (error) {
      console.log("Error fetching model aliases:", error);
    }
  };

  useEffect(() => {
    if (claudeStatus?.installed && !hasInitializedModels.current) {
      hasInitializedModels.current = true;
      const env = claudeStatus.settings?.env || {};

      tool.defaultModels.forEach((model) => {
        if (model.envKey) {
          // Kept verbatim (marker included) so the input matches what is on disk;
          // withContextMarker strips before appending, so re-applying cannot double it.
          const value = env[model.envKey] || model.defaultValue || "";
          // Only sync initial values from file once
          if (value) {
            onModelMappingChange(model.alias, value);
          }
        }
      });
      // Restore key from settings.json; ApiKeySelect matches it against saved presets
      const tokenFromFile = env.ANTHROPIC_AUTH_TOKEN;
      if (tokenFromFile) {
        setSelectedApiKey(tokenFromFile);
      }
    }
  }, [claudeStatus, apiKeys, tool.defaultModels, onModelMappingChange]);

  const checkClaudeStatus = async () => {
    setCheckingClaude(true);
    try {
      const res = await fetch("/api/cli-tools/claude-settings");
      const data = await res.json();
      setClaudeStatus(data);
      setExaMcpEnabled(!!data.exaMcpEnabled);
    } catch (error) {
      setClaudeStatus({ installed: false, error: error.message });
    } finally {
      setCheckingClaude(false);
    }
  };

  const getEffectiveBaseUrl = () => {
    return customBaseUrl || baseUrl;
  };

  const getDisplayUrl = () => {
    return customBaseUrl || baseUrl;
  };

  const handleApplySettings = async () => {
    setApplying(true);
    setMessage(null);
    try {
      const env = { ANTHROPIC_BASE_URL: getEffectiveBaseUrl() };

      // Get key from dropdown, fallback to first key or sk_9router for localhost
      const keyToUse = selectedApiKey?.trim()
        || (apiKeys?.length > 0 ? apiKeys[0].key : null)
        || (!cloudEnabled ? "sk_9router" : null);

      if (keyToUse) {
        env.ANTHROPIC_AUTH_TOKEN = keyToUse;
      }

      tool.defaultModels.forEach((model) => {
        const targetModel = modelMappings[model.alias];
        // Written verbatim — the input may hold a marker typed by hand, and the
        // toggle already decided the marker when it was flipped.
        if (targetModel && model.envKey) env[model.envKey] = targetModel;
      });

      if (maxContextTokens && Number(maxContextTokens) > 0) {
        env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(maxContextTokens);
      }

      if (compactMode === "percent" && compactPct) {
        env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(compactPct);
      } else if (compactMode === "fixed" && autoCompactWindow) {
        env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(autoCompactWindow);
      }

      if (disableUnknownModelEnforcement) {
        env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = "1";
      }

      if (enableGatewayDiscovery) {
        env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
      }

      // Claude Code's auto-mode server runs its own local listener; disable it
      // so the CLI talks to 9Router only.
      env.CLAUDE_CODE_AUTO_MODE_SERVER = "0";

      const res = await fetch("/api/cli-tools/claude-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          env,
          exaMcpEnabled,
          autoCompactWindow: compactMode === "fixed" ? autoCompactWindow : "",
          maxContextTokens: maxContextTokens || "",
          compactPct: compactMode === "percent" ? compactPct : "",
          compactMode,
          disableUnknownModelEnforcement,
          enableGatewayDiscovery,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        // Remember the endpoint so it stays selectable next time
        rememberEndpoint(getEffectiveBaseUrl(), { tunnelPublicUrl, tailscaleUrl });
        setMessage({ type: "success", text: "Settings applied successfully!" });
        setClaudeStatus(prev => ({
          ...prev,
          hasBackup: true,
          settings: {
            ...prev?.settings,
            env: {
              ...prev?.settings?.env,
              ...env,
              CLAUDE_CODE_MAX_CONTEXT_TOKENS: maxContextTokens ? String(maxContextTokens) : undefined,
              CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: compactMode === "percent" ? String(compactPct) : undefined,
              CLAUDE_CODE_AUTO_COMPACT_WINDOW: compactMode === "fixed" ? String(autoCompactWindow) : undefined,
              CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: disableUnknownModelEnforcement ? "1" : undefined,
              CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: enableGatewayDiscovery ? "1" : undefined,
              CLAUDE_CODE_AUTO_MODE_SERVER: "0",
            },
          },
          exaMcpEnabled,
        }));
      } else {
        setMessage({ type: "error", text: data.error || "Failed to apply settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setApplying(false);
    }
  };

  const handleResetSettings = async () => {
    setRestoring(true);
    setMessage(null);
    try {
      const res = await fetch("/api/cli-tools/claude-settings", { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: "Settings reset successfully!" });
        tool.defaultModels.forEach((model) => onModelMappingChange(model.alias, model.defaultValue || ""));
        setSelectedApiKey("");
        setExaMcpEnabled(false);
        setAutoCompactWindow("");
        setMaxContextTokens("");
        setCompactMode("percent");
        setCompactPct("80");
        setDisableUnknownModelEnforcement(true);
        setEnableGatewayDiscovery(true);
        setOneMContext(false);
        hasUserEditedMaxContext.current = false;
      } else {
        setMessage({ type: "error", text: data.error || "Failed to reset settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setRestoring(false);
    }
  };

  const openModelSelector = (alias) => {
    setCurrentEditingAlias(alias);
    setModalOpen(true);
  };

  const handleModelSelect = (model) => {
    if (currentEditingAlias) {
      const val = withContextMarker(model.value, oneMContext);
      onModelMappingChange(currentEditingAlias, val);

      // Auto-update max context tokens if setting primary/sonnet model or user hasn't custom typed
      const clean = stripModelContextMarker(val).model;
      const caps = getCaps(clean);
      if (caps?.contextWindow) {
        if (currentEditingAlias === "sonnet" || !hasUserEditedMaxContext.current) {
          setMaxContextTokens(String(caps.contextWindow));
        }
      }
    }
  };

  // Generate settings.json content for manual copy
  const getManualConfigs = () => {
    const keyToUse = (selectedApiKey && selectedApiKey.trim())
      ? selectedApiKey
      : (!cloudEnabled ? "sk_9router" : "<API_KEY_FROM_DASHBOARD>");
    const cleanBaseUrl = getEffectiveBaseUrl();
    const env = {
      ANTHROPIC_BASE_URL: cleanBaseUrl,
      ANTHROPIC_AUTH_TOKEN: keyToUse,
    };
    tool.defaultModels.forEach((model) => {
      const targetModel = modelMappings[model.alias];
      if (targetModel && model.envKey) env[model.envKey] = targetModel;
    });
    if (maxContextTokens && Number(maxContextTokens) > 0) {
      env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(maxContextTokens);
    }
    if (compactMode === "percent" && compactPct) {
      env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(compactPct);
    } else if (compactMode === "fixed" && autoCompactWindow) {
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(autoCompactWindow);
    }
    if (disableUnknownModelEnforcement) {
      env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = "1";
    }
    if (enableGatewayDiscovery) {
      env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
    }
    // Same env the Apply button writes — keep the copy/paste snippet in sync.
    env.CLAUDE_CODE_AUTO_MODE_SERVER = "0";

    return [
      {
        filename: "~/.claude/settings.json",
        content: JSON.stringify({ hasCompletedOnboarding: true, env }, null, 2),
      },
    ];
  };

  const effectiveMaxContext = parseInt(maxContextTokens, 10) || detectedPrimaryContext || (oneMContext ? 1000000 : 200000);
  const calculatedCompactThreshold = Math.min(
    Math.floor(effectiveMaxContext * ((parseFloat(compactPct) || 80) / 100)),
    effectiveMaxContext - 13000 > 0 ? effectiveMaxContext - 13000 : effectiveMaxContext
  );

  return (
    <Card padding="xs" className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 hover:cursor-pointer sm:items-center" onClick={onToggle}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-8 flex items-center justify-center shrink-0">
            <Image src="/providers/claude.png" alt={tool.name} width={32} height={32} className="size-8 object-contain rounded-lg" sizes="32px" onError={(e) => { e.target.style.display = "none"; }} loading="lazy" decoding="async" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="font-medium text-sm">{tool.name}</h3>
              {configStatus === "configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-500/10 text-green-600 dark:text-green-400 rounded-full">Connected</span>}
              {configStatus === "not_configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 rounded-full">Not configured</span>}
              {configStatus === "other" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-full">Other</span>}
            </div>
            <p className="text-xs text-text-muted truncate">{tool.description}</p>
          </div>
        </div>
        <span className={`material-symbols-outlined text-text-muted text-[20px] transition-transform ${isExpanded ? "rotate-180" : ""}`}>expand_more</span>
      </div>

      {isExpanded && (
        <div className="mt-4 pt-4 border-t border-border flex flex-col gap-4">
          {checkingClaude && (
            <div className="flex items-center gap-2 text-text-muted">
              <span className="material-symbols-outlined animate-spin">progress_activity</span>
              <span>Checking Claude CLI...</span>
            </div>
          )}

          {!checkingClaude && claudeStatus && !claudeStatus.installed && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                <div className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-yellow-500">warning</span>
                  <div className="flex-1">
                    <p className="font-medium text-yellow-600 dark:text-yellow-400">Claude CLI not detected locally</p>
                    <p className="text-sm text-text-muted">Manual configuration is still available if 9router is deployed on a remote server.</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 pl-9">
                  <Button variant="secondary" size="sm" onClick={() => setShowManualConfigModal(true)} className="!bg-yellow-500/20 !border-yellow-500/40 !text-yellow-700 dark:!text-yellow-300 hover:!bg-yellow-500/30">
                    <span className="material-symbols-outlined text-[18px] mr-1">content_copy</span>
                    Manual Config
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowInstallGuide(!showInstallGuide)}>
                    <span className="material-symbols-outlined text-[18px] mr-1">{showInstallGuide ? "expand_less" : "help"}</span>
                    {showInstallGuide ? "Hide" : "How to Install"}
                  </Button>
                </div>
              </div>
              {showInstallGuide && (
                <div className="p-4 bg-surface border border-border rounded-lg">
                  <h4 className="font-medium mb-3">Installation Guide</h4>
                  <div className="space-y-3 text-sm">
                    <div>
                      <p className="text-text-muted mb-1">macOS / Linux / Windows:</p>
                      <code className="block px-3 py-2 bg-black/5 dark:bg-white/5 rounded font-mono text-xs">npm install -g @anthropic-ai/claude-code</code>
                    </div>
                    <p className="text-text-muted">After installation, run <code className="px-1 bg-black/5 dark:bg-white/5 rounded">claude</code> to verify.</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {!checkingClaude && claudeStatus?.installed && (
            <>
              <div className="flex flex-col gap-2">
                {/* Endpoint (selector) */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Select Endpoint</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <BaseUrlSelect
                    value={customBaseUrl || getDisplayUrl()}
                    onChange={setCustomBaseUrl}
                    requiresExternalUrl={tool.requiresExternalUrl}
                    tunnelEnabled={tunnelEnabled}
                    tunnelPublicUrl={tunnelPublicUrl}
                    tailscaleEnabled={tailscaleEnabled}
                    tailscaleUrl={tailscaleUrl}
                    currentUrl={currentBaseUrl}
                    withV1={false}
                  />
                </div>

                {/* Current configured */}
                {claudeStatus?.settings?.env?.ANTHROPIC_BASE_URL && (
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                    <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Current</span>
                    <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                    <span className="min-w-0 truncate rounded bg-surface/40 px-2 py-2 text-xs text-text-muted sm:py-1.5">
                      {claudeStatus.settings.env.ANTHROPIC_BASE_URL}
                    </span>
                  </div>
                )}

                {/* API Key */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">API Key</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <ApiKeySelect value={selectedApiKey} onChange={setSelectedApiKey} apiKeys={apiKeys} cloudEnabled={cloudEnabled} />
                </div>

                {/* Model Mappings */}
                {tool.defaultModels.map((model) => {
                  const mappedValue = modelMappings[model.alias] || "";
                  const cleanModel = mappedValue
                    ? stripModelContextMarker(mappedValue).model
                    : (model.defaultValue ? stripModelContextMarker(model.defaultValue).model : "");
                  const modelCaps = cleanModel ? getCaps(cleanModel) : null;
                  const ctxWindow = modelCaps?.contextWindow;
                  const isCurrentContext = ctxWindow && String(maxContextTokens) === String(ctxWindow);

                  return (
                    <div key={model.alias} className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                      <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">{model.name}</span>
                      <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="relative flex-1 min-w-0">
                          <input
                            type="text"
                            value={mappedValue}
                            onChange={(e) => {
                              const val = e.target.value;
                              onModelMappingChange(model.alias, val);
                              const clean = stripModelContextMarker(val).model;
                              const caps = getCaps(clean);
                              if (caps?.contextWindow && (model.alias === "sonnet" || !hasUserEditedMaxContext.current)) {
                                setMaxContextTokens(String(caps.contextWindow));
                              }
                            }}
                            placeholder="provider/model-id"
                            className="w-full min-w-0 pl-2 pr-7 py-2 bg-surface rounded border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5"
                          />
                          {mappedValue && (
                            <button
                              onClick={() => onModelMappingChange(model.alias, "")}
                              className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-text-muted hover:text-red-500 rounded transition-colors"
                              title="Clear"
                            >
                              <span className="material-symbols-outlined text-[14px]">close</span>
                            </button>
                          )}
                        </div>
                        <button
                          onClick={() => openModelSelector(model.alias)}
                          disabled={!hasActiveProviders}
                          className={`rounded border px-2.5 py-2 text-xs transition-colors sm:py-1.5 whitespace-nowrap shrink-0 ${
                            hasActiveProviders
                              ? "bg-surface border-border text-text-main hover:border-primary cursor-pointer"
                              : "opacity-50 cursor-not-allowed border-border"
                          }`}
                        >
                          Select
                        </button>
                        {ctxWindow ? (
                          <button
                            type="button"
                            onClick={() => {
                              hasUserEditedMaxContext.current = true;
                              setMaxContextTokens(String(ctxWindow));
                            }}
                            className={`inline-flex items-center gap-1 rounded border px-2.5 py-2 text-xs font-mono transition-colors shrink-0 cursor-pointer sm:py-1.5 whitespace-nowrap ${
                              isCurrentContext
                                ? "bg-primary/10 border-primary/60 text-primary font-semibold"
                                : "bg-surface border-border text-text-muted hover:text-text-main hover:border-primary"
                            }`}
                            title={`Set Max Context to ${ctxWindow.toLocaleString()} tokens`}
                          >
                            <span className={`material-symbols-outlined text-[13px] ${isCurrentContext ? "text-primary" : "text-primary/80"}`}>data_object</span>
                            ctx {fmtContext(ctxWindow)}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}

                {/* Max Context Tokens (CLAUDE_CODE_MAX_CONTEXT_TOKENS) */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <div className="flex items-center gap-1 sm:justify-end">
                    <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Max Context</span>
                    <Tooltip text="Sets CLAUDE_CODE_MAX_CONTEXT_TOKENS in ~/.claude/settings.json. Informs Claude Code of your model's true context limit (e.g. 40,960 for local117) so it doesn't assume 200k or crash providers.">
                      <span className="material-symbols-outlined text-text-muted text-[14px] cursor-help">info</span>
                    </Tooltip>
                  </div>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="relative flex-1 min-w-0">
                      <input
                        type="number"
                        value={maxContextTokens}
                        onChange={(e) => {
                          hasUserEditedMaxContext.current = true;
                          setMaxContextTokens(e.target.value);
                        }}
                        placeholder={detectedPrimaryContext ? String(detectedPrimaryContext) : "e.g. 40960"}
                        className="w-full min-w-0 pl-2 pr-7 py-2 bg-surface rounded border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5 font-mono"
                      />
                      {maxContextTokens && (
                        <button
                          onClick={() => {
                            hasUserEditedMaxContext.current = true;
                            setMaxContextTokens("");
                          }}
                          className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-text-muted hover:text-red-500 rounded transition-colors"
                          title="Clear"
                        >
                          <span className="material-symbols-outlined text-[14px]">close</span>
                        </button>
                      )}
                    </div>
                    {detectedPrimaryContext ? (
                      <button
                        type="button"
                        onClick={() => {
                          hasUserEditedMaxContext.current = false;
                          setMaxContextTokens(String(detectedPrimaryContext));
                        }}
                        className="rounded border border-border bg-surface px-2.5 py-2 text-xs text-text-muted hover:text-text-main hover:border-primary transition-colors sm:py-1.5 whitespace-nowrap shrink-0"
                        title={`Reset to detected context from Sonnet: ${detectedPrimaryContext.toLocaleString()} tokens`}
                      >
                        Auto ({fmtContext(detectedPrimaryContext)})
                      </button>
                    ) : null}
                  </div>
                </div>

                {/* Auto-compact */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <div className="flex items-center gap-1 sm:justify-end">
                    <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Auto-compact</span>
                    <Tooltip text="Controls when Claude Code auto-compacts conversation history. Percentage mode sets CLAUDE_AUTOCOMPACT_PCT_OVERRIDE; Token mode sets CLAUDE_CODE_AUTO_COMPACT_WINDOW.">
                      <span className="material-symbols-outlined text-text-muted text-[14px] cursor-help">info</span>
                    </Tooltip>
                  </div>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <div className="flex flex-col gap-1.5 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={compactMode}
                        onChange={(e) => setCompactMode(e.target.value)}
                        className="px-2 py-2 bg-surface rounded border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5"
                      >
                        <option value="percent">Percentage (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)</option>
                        <option value="fixed">Fixed Tokens (CLAUDE_CODE_AUTO_COMPACT_WINDOW)</option>
                        <option value="default">Default</option>
                      </select>

                      {compactMode === "percent" && (
                        <select
                          value={compactPct}
                          onChange={(e) => setCompactPct(e.target.value)}
                          className="px-2 py-2 bg-surface rounded border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5 font-medium"
                        >
                          <option value="50">50%</option>
                          <option value="60">60%</option>
                          <option value="70">70%</option>
                          <option value="75">75%</option>
                          <option value="80">80% (Recommended)</option>
                          <option value="85">85%</option>
                          <option value="90">90%</option>
                          <option value="95">95%</option>
                        </select>
                      )}

                      {compactMode === "fixed" && (
                        <div className="flex items-center gap-1.5 flex-1 min-w-[140px]">
                          <select
                            value={FIXED_CONTEXT_OPTIONS.some((o) => o.value === autoCompactWindow) ? autoCompactWindow : "custom"}
                            onChange={(e) => {
                              if (e.target.value !== "custom") setAutoCompactWindow(e.target.value);
                            }}
                            className="px-2 py-2 bg-surface rounded border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5"
                          >
                            {FIXED_CONTEXT_OPTIONS.map((opt) => (
                              <option key={opt.label} value={opt.value}>{opt.label}</option>
                            ))}
                            <option value="custom">Custom...</option>
                          </select>
                          {(!FIXED_CONTEXT_OPTIONS.some((o) => o.value === autoCompactWindow) || autoCompactWindow === "") && (
                            <input
                              type="number"
                              value={autoCompactWindow}
                              onChange={(e) => setAutoCompactWindow(e.target.value)}
                              placeholder="tokens, e.g. 32000"
                              className="flex-1 min-w-0 px-2 py-2 bg-surface rounded border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5 font-mono"
                            />
                          )}
                        </div>
                      )}
                    </div>

                    {compactMode === "percent" && (
                      <p className="text-[11px] text-text-muted">
                        Compacts at ~<span className="font-semibold text-text-main">{calculatedCompactThreshold.toLocaleString()} tokens</span> ({compactPct}% of {effectiveMaxContext.toLocaleString()} max context)
                      </p>
                    )}
                  </div>
                </div>

                {/* 1M context */}
                <div className="flex flex-wrap items-center justify-between gap-1.5 sm:grid sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">1M context</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input type="checkbox" checked={oneMContext} onChange={(e) => handleOneMContextToggle(e.target.checked)} className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0" />
                    <span className="text-xs text-text-muted">Append [1m] to the model name</span>
                    <Tooltip text="Claude Code otherwise assumes a 200K window, which clamps the auto-compact window above. Applied to every mapped model — only enable it for models that really accept 1M.">
                      <span className="material-symbols-outlined text-text-muted text-[14px] cursor-help">info</span>
                    </Tooltip>
                  </label>
                </div>

                {/* Gateway Discovery */}
                <div className="flex flex-wrap items-center justify-between gap-1.5 sm:grid sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Gateway Models</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={enableGatewayDiscovery}
                      onChange={(e) => setEnableGatewayDiscovery(e.target.checked)}
                      className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                    />
                    <span className="text-xs text-text-muted">Gateway model discovery</span>
                    <Tooltip text="Sets CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1. Tells Claude Code to fetch available models from 9router (GET /v1/models) so custom and routed models appear directly inside Claude Code's /model picker.">
                      <span className="material-symbols-outlined text-text-muted text-[14px] cursor-help">info</span>
                    </Tooltip>
                  </label>
                </div>

                {/* Disable Unknown Model Window Enforcement */}
                <div className="flex flex-wrap items-center justify-between gap-1.5 sm:grid sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Window Relax</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={disableUnknownModelEnforcement}
                      onChange={(e) => setDisableUnknownModelEnforcement(e.target.checked)}
                      className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                    />
                    <span className="text-xs text-text-muted">Disable unknown model enforcement</span>
                    <Tooltip text="Sets CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1. Prevents Claude Code from forcing an arbitrary 200k context clamp on unrecognized model IDs, allowing custom context limits and compacting thresholds to take effect accurately.">
                      <span className="material-symbols-outlined text-text-muted text-[14px] cursor-help">info</span>
                    </Tooltip>
                  </label>
                </div>

                {/* CC Filter Naming */}
                <div className="flex flex-wrap items-center justify-between gap-1.5 sm:grid sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Filter naming</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input type="checkbox" checked={ccFilterNaming} onChange={handleCcFilterNamingToggle} className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0" />
                    <span className="text-xs text-text-muted">Filter naming requests</span>
                    <Tooltip text="Intercepts Claude Code's topic-naming requests and returns a fake response locally, saving API tokens.">
                      <span className="material-symbols-outlined text-text-muted text-[14px] cursor-help">info</span>
                    </Tooltip>
                  </label>
                </div>

                {/* Exa MCP — ~/.claude.json mcpServers (not settings.json) */}
                <div className="flex flex-wrap items-center justify-between gap-1.5 sm:grid sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Web Search</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input type="checkbox" checked={exaMcpEnabled} onChange={(e) => setExaMcpEnabled(e.target.checked)} className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0" />
                    <span className="text-xs text-text-muted">Exa MCP</span>
                    <Tooltip text="Injects Exa MCP into ~/.claude.json so non-Claude models gain web search. Restart Claude Code after Apply.">
                      <span className="material-symbols-outlined text-text-muted text-[14px] cursor-help">info</span>
                    </Tooltip>
                  </label>
                </div>
              </div>

              {message && (
                <div className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${message.type === "success" ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"}`}>
                  <span className="material-symbols-outlined text-[14px]">{message.type === "success" ? "check_circle" : "error"}</span>
                  <span>{message.text}</span>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" size="sm" onClick={handleApplySettings} disabled={!hasActiveProviders} loading={applying}>
                  <span className="material-symbols-outlined text-[14px] mr-1">save</span>Apply
                </Button>
                <Button variant="outline" size="sm" onClick={handleResetSettings} disabled={!claudeStatus?.has9Router} loading={restoring}>
                  <span className="material-symbols-outlined text-[14px] mr-1">restore</span>Reset
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowManualConfigModal(true)}>
                  <span className="material-symbols-outlined text-[14px] mr-1">content_copy</span>Manual Config
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {modalOpen && (
        <ModelSelectModal isOpen={modalOpen} onClose={() => setModalOpen(false)} onSelect={handleModelSelect} selectedModel={currentEditingAlias ? modelMappings[currentEditingAlias] : null} activeProviders={activeProviders} modelAliases={modelAliases} title={`Select model for ${currentEditingAlias}`} />
      )}

      <ManualConfigModal
        isOpen={showManualConfigModal}
        onClose={() => setShowManualConfigModal(false)}
        title="Claude CLI - Manual Configuration"
        configs={getManualConfigs()}
      />
    </Card>
  );
}
