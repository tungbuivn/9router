"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Card, Button, Badge, ConfirmModal } from "@/shared/components";
import { cn } from "@/shared/utils/cn";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";

const STATUS_FILTERS = [
  { id: "all", label: "All" },
  { id: "success", label: "Success" },
  { id: "error", label: "Error" },
  { id: "streaming", label: "Streaming" },
  { id: "pending", label: "Pending" },
];

const DETAIL_TABS = [
  { id: "received", label: "1. Received", icon: "inbox" },
  { id: "beforeModify", label: "2. Before Modify", icon: "edit_note" },
  { id: "afterModify", label: "3. After Modify", icon: "auto_fix_high" },
  { id: "response", label: "4. Response", icon: "output" },
  { id: "fallback", label: "Fallback & Retries", icon: "alt_route" },
  { id: "w2Capture", label: "5. Upstream Proxy", icon: "hub" },
  { id: "raw", label: "Raw JSON", icon: "data_object" },
];

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTime(iso) {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-GB", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatDateTime(iso) {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    return `${d.toLocaleDateString("en-CA")} ${d.toLocaleTimeString("en-GB", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  } catch {
    return iso;
  }
}

function formatRelative(iso) {
  if (!iso) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function statusBadgeVariant(status, statusCode) {
  if (status === "error" || (statusCode && statusCode >= 400)) return "error";
  if (status === "streaming") return "info";
  if (status === "pending") return "warning";
  return "success";
}

function statusBadgeLabel(status, statusCode) {
  if (status === "streaming") return "STREAM";
  if (status === "pending") return "PENDING";
  if (statusCode) return String(statusCode);
  return (status || "unknown").toUpperCase();
}

function stringifyMessageContent(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text" || typeof part?.text === "string") return part.text;
        if (part?.type === "image_url" || part?.type === "image") return "[Image]";
        if (part?.type === "tool_use") return `[Tool Call: ${part.name}(${JSON.stringify(part.input || {})})]`;
        if (part?.type === "tool_result") return `[Tool Result: ${stringifyMessageContent(part.content)}]`;
        return JSON.stringify(part, null, 2);
      })
      .join("\n");
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (Array.isArray(content.parts)) return stringifyMessageContent(content.parts);
    return JSON.stringify(content, null, 2);
  }
  return String(content);
}

function roleBadgeVariant(role) {
  const r = String(role || "").toLowerCase();
  if (r === "system" || r === "developer") return "warning";
  if (r === "assistant" || r === "model") return "primary";
  if (r === "tool" || r === "function") return "info";
  return "default";
}

function JsonBlock({ title, data, defaultExpanded = true, maxHeight = "max-h-[460px]" }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);

  const formatted = useMemo(() => {
    if (data === null || data === undefined) return "null";
    if (typeof data === "string") return data;
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }, [data]);

  const handleCopy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(formatted);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div className="border border-border-subtle rounded-lg overflow-hidden bg-bg/40">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        className="flex items-center justify-between px-3 py-2 bg-surface-2/60 hover:bg-surface-2 cursor-pointer select-none"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn(
              "material-symbols-outlined text-[16px] text-text-muted transition-transform",
              expanded && "rotate-90"
            )}
          >
            chevron_right
          </span>
          <span className="text-xs font-semibold text-text-main truncate">{title}</span>
          <span className="text-[11px] text-text-muted">({formatBytes(formatted.length)})</span>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium text-text-muted hover:text-text-main hover:bg-surface transition-colors"
        >
          <span className="material-symbols-outlined text-[14px]">
            {copied ? "check" : "content_copy"}
          </span>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {expanded && (
        <pre
          className={cn(
            "p-3 text-xs font-mono text-text-main overflow-auto custom-scrollbar whitespace-pre-wrap break-words bg-black/[0.03] dark:bg-black/30",
            maxHeight
          )}
        >
          {formatted}
        </pre>
      )}
    </div>
  );
}

function MessagesList({ system, messages, emptyLabel = "No messages captured" }) {
  const hasSystem = system !== null && system !== undefined && system !== "";
  const list = Array.isArray(messages) ? messages : [];

  if (!hasSystem && list.length === 0) {
    return (
      <div className="p-4 rounded-lg border border-dashed border-border-subtle text-xs text-text-muted text-center">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {hasSystem && (
        <div className="rounded-lg border border-yellow-500/25 bg-yellow-500/5 p-3">
          <div className="flex items-center justify-between mb-1.5">
            <Badge variant="warning" size="sm">top-level system</Badge>
            <span className="text-[11px] text-text-muted">
              {stringifyMessageContent(system).length} chars
            </span>
          </div>
          <pre className="text-xs font-mono text-text-main whitespace-pre-wrap break-words max-h-60 overflow-y-auto custom-scrollbar">
            {stringifyMessageContent(system)}
          </pre>
        </div>
      )}
      {list.map((msg, idx) => {
        const role = msg?.role || msg?.type || "message";
        const contentSource = msg?.content !== undefined ? msg.content : (msg?.parts !== undefined ? msg.parts : msg);
        const text = stringifyMessageContent(contentSource);
        const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
        return (
          <div
            key={idx}
            className="rounded-lg border border-border-subtle bg-surface/70 p-3"
          >
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono text-text-muted">#{idx + 1}</span>
                <Badge variant={roleBadgeVariant(role)} size="sm">{role}</Badge>
                {msg?.name && (
                  <span className="text-[11px] font-mono text-text-muted">name={msg.name}</span>
                )}
              </div>
              <span className="text-[11px] text-text-muted">{text.length} chars</span>
            </div>
            {text && (
              <pre className="text-xs font-mono text-text-main whitespace-pre-wrap break-words max-h-64 overflow-y-auto custom-scrollbar">
                {text}
              </pre>
            )}
            {toolCalls.length > 0 && (
              <div className="mt-2 pt-2 border-t border-border-subtle space-y-1">
                <div className="text-[11px] font-semibold text-blue-500">
                  Tool Calls ({toolCalls.length})
                </div>
                <pre className="text-[11px] font-mono text-text-muted whitespace-pre-wrap break-words max-h-40 overflow-y-auto custom-scrollbar">
                  {JSON.stringify(toolCalls, null, 2)}
                </pre>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function apiTypeBadgeVariant(apiType) {
  switch (apiType) {
    case "chat":
      return "primary";
    case "models":
      return "info";
    case "count-tokens":
    case "embeddings":
      return "default";
    case "images":
    case "audio":
    case "videos":
      return "warning";
    case "search":
    case "web-fetch":
    case "systemone":
      return "success";
    default:
      return "default";
  }
}

export default function LogsPageClient() {
  const [items, setItems] = useState([]);
  const [meta, setMeta] = useState({ total: 0, maxFiles: 100, storageDir: "", totalSizeBytes: 0, providers: [], apiTypes: [] });
  const [providerNames, setProviderNames] = useState({});
  const [loadingList, setLoadingList] = useState(true);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [providerFilter, setProviderFilter] = useState("");
  const [apiTypeFilter, setApiTypeFilter] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);

  const [selectedId, setSelectedId] = useState(null);
  const [selectedLog, setSelectedLog] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [activeTab, setActiveTab] = useState("received");
  const [showCompare, setShowCompare] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [syncingW2, setSyncingW2] = useState(false);
  const [w2SyncError, setW2SyncError] = useState("");

  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const resolveProviderLabel = useCallback(
    (providerId, fallbackName) => {
      if (fallbackName) return fallbackName;
      if (!providerId) return "-";
      if (providerNames[providerId]) return providerNames[providerId];
      const known = AI_PROVIDERS[providerId] || getProviderByAlias(providerId);
      return known?.name || providerId;
    },
    [providerNames]
  );

  // Load friendly names for custom / ACP provider nodes once
  useEffect(() => {
    fetch("/api/provider-nodes")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const nodes = data?.nodes || [];
        const map = {};
        for (const n of nodes) {
          if (n?.id) map[n.id] = n.name || n.prefix || n.id;
        }
        setProviderNames(map);
      })
      .catch(() => {});
  }, []);

  const fetchDetail = useCallback(async (id, silent = false) => {
    if (!id) {
      setSelectedLog(null);
      return;
    }
    if (!silent) setLoadingDetail(true);
    try {
      const res = await fetch(`/api/logs/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 404) setSelectedLog(null);
        return;
      }
      const data = await res.json();
      if (selectedIdRef.current === id) {
        setSelectedLog(data);
      }
    } catch (err) {
      console.error("Failed to fetch log detail:", err);
    } finally {
      if (!silent) setLoadingDetail(false);
    }
  }, []);

  const fetchList = useCallback(
    async (silent = false) => {
      if (!silent) setLoadingList(true);
      try {
        const params = new URLSearchParams();
        if (search.trim()) params.set("search", search.trim());
        if (statusFilter && statusFilter !== "all") params.set("status", statusFilter);
        if (providerFilter) params.set("provider", providerFilter);
        if (apiTypeFilter) params.set("apiType", apiTypeFilter);

        const res = await fetch(`/api/logs?${params.toString()}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        const nextItems = data.items || [];
        setItems(nextItems);
        setMeta({
          total: data.total || 0,
          maxFiles: data.maxFiles || 100,
          storageDir: data.storageDir || "",
          totalSizeBytes: data.totalSizeBytes || 0,
          providers: data.providers || [],
          apiTypes: data.apiTypes || [],
        });

        // Auto-select newest item if nothing selected yet
        if (!selectedIdRef.current && nextItems.length > 0) {
          const firstId = nextItems[0].id;
          setSelectedId(firstId);
          fetchDetail(firstId, false);
        } else if (selectedIdRef.current) {
          const currentRow = nextItems.find((i) => i.id === selectedIdRef.current);
          // Refresh selected detail silently if still streaming/pending or updated
          if (currentRow && (currentRow.status === "streaming" || currentRow.status === "pending")) {
            fetchDetail(selectedIdRef.current, true);
          }
        }
      } catch (err) {
        console.error("Failed to fetch logs:", err);
      } finally {
        if (!silent) setLoadingList(false);
      }
    },
    [search, statusFilter, providerFilter, apiTypeFilter, fetchDetail]
  );

  useEffect(() => {
    fetchList(false);
  }, [fetchList]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      fetchList(true);
    }, 3000);
    return () => clearInterval(timer);
  }, [autoRefresh, fetchList]);

  const handleSelectItem = (id) => {
    setSelectedId(id);
    setW2SyncError("");
    fetchDetail(id, false);
  };

  const handleSyncW2 = async () => {
    if (!selectedLog?.id) return;
    setSyncingW2(true);
    setW2SyncError("");
    try {
      const res = await fetch(`/api/logs/${encodeURIComponent(selectedLog.id)}/sync-w2`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setW2SyncError(data?.error || "Failed to pull captures from w2 proxy");
        return;
      }
      setSelectedLog(data);
      fetchList(true);
    } catch (err) {
      setW2SyncError(err?.message || "Failed to connect to w2 proxy");
    } finally {
      setSyncingW2(false);
    }
  };

  const handleDeleteOne = async (id) => {
    try {
      const res = await fetch(`/api/logs/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.ok) {
        if (selectedId === id) {
          setSelectedId(null);
          setSelectedLog(null);
        }
        fetchList(true);
      }
    } catch (err) {
      console.error("Failed to delete log:", err);
    }
  };

  const handleClearAll = async () => {
    setClearing(true);
    try {
      const res = await fetch("/api/logs", { method: "DELETE" });
      if (res.ok) {
        setSelectedId(null);
        setSelectedLog(null);
        setShowClearConfirm(false);
        fetchList(false);
      }
    } catch (err) {
      console.error("Failed to clear logs:", err);
    } finally {
      setClearing(false);
    }
  };

  const handleDownloadJson = () => {
    if (!selectedLog) return;
    const blob = new Blob([JSON.stringify(selectedLog, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = selectedLog.filename || `${selectedLog.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const renderDetailContent = () => {
    if (loadingDetail) {
      return (
        <div className="flex items-center justify-center h-64 text-text-muted text-sm gap-2">
          <span className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>
          Loading log file from disk...
        </div>
      );
    }

    if (!selectedLog) {
      return (
        <div className="flex flex-col items-center justify-center h-64 text-text-muted text-sm gap-2">
          <span className="material-symbols-outlined text-[36px] opacity-40">receipt_long</span>
          <span>Select a request on the left to inspect all 4 pipeline stages.</span>
        </div>
      );
    }

    if (activeTab === "received") {
      const stage = selectedLog.received;
      if (!stage) {
        return <div className="text-sm text-text-muted p-4">No received request data captured.</div>;
      }
      const hasMessagesOrSystem = Boolean(stage.system) || (stage.messageCount ?? 0) > 0;
      const isChatApi = !selectedLog.apiType || selectedLog.apiType === "chat";
      return (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="primary" size="sm">{stage.method || "POST"}</Badge>
            {selectedLog.apiType && (
              <Badge variant={apiTypeBadgeVariant(selectedLog.apiType)} size="sm">
                {selectedLog.apiType}
              </Badge>
            )}
            <code className="px-2 py-0.5 rounded bg-surface-2 font-mono text-text-main">
              {stage.endpoint || "-"}
            </code>
            <span className="text-text-muted">•</span>
            <span className="text-text-muted">{formatDateTime(stage.timestamp)}</span>
            {(isChatApi || hasMessagesOrSystem) && (
              <>
                <span className="text-text-muted">•</span>
                <span className="text-text-main font-medium">{stage.messageCount ?? 0} message(s)</span>
              </>
            )}
          </div>

          {hasMessagesOrSystem && (
            <MessagesList
              system={stage.system}
              messages={stage.messages}
              emptyLabel="No messages array in raw incoming body"
            />
          )}

          <JsonBlock title="Incoming Headers (Sensitive keys masked)" data={stage.headers} defaultExpanded={false} />
          <JsonBlock title="Raw Incoming Request Body / Query" data={stage.body} defaultExpanded={true} />
        </div>
      );
    }

    if (activeTab === "beforeModify") {
      const stage = selectedLog.beforeModify;
      if (!stage) {
        const isNonChat = selectedLog.apiType && selectedLog.apiType !== "chat";
        return (
          <div className="p-4 rounded-lg border border-dashed border-border-subtle text-sm text-text-muted">
            {isNonChat ? (
              <>
                Non-chat API request (<code>{selectedLog.apiType}</code>) does not go through chat message modification. Inspect <strong>1. Received</strong>, <strong>4. Response</strong>, or <strong>5. W2 Proxy</strong>.
              </>
            ) : (
              <>
                Request ended before reaching message processing (e.g. auth/validation/bypass error). Check <strong>1. Received</strong> and <strong>4. Response</strong>.
              </>
            )}
          </div>
        );
      }
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="p-2.5 rounded-lg bg-surface-2/60 border border-border-subtle">
              <div className="text-text-muted text-[11px]">Provider</div>
              <div className="font-semibold text-text-main truncate">
                {resolveProviderLabel(stage.provider, stage.providerName)}
              </div>
            </div>
            <div className="p-2.5 rounded-lg bg-surface-2/60 border border-border-subtle">
              <div className="text-text-muted text-[11px]">Target Model</div>
              <div className="font-semibold font-mono text-text-main truncate">{stage.model || "-"}</div>
            </div>
            <div className="p-2.5 rounded-lg bg-surface-2/60 border border-border-subtle">
              <div className="text-text-muted text-[11px]">Format</div>
              <div className="font-semibold font-mono text-text-main truncate">
                {stage.sourceFormat || "?"} → {stage.targetFormat || "?"}
              </div>
            </div>
            <div className="p-2.5 rounded-lg bg-surface-2/60 border border-border-subtle">
              <div className="text-text-muted text-[11px]">Messages Before</div>
              <div className="font-semibold text-text-main">
                {stage.messageCount ?? 0} {stage.system ? "+ top system" : ""}
              </div>
            </div>
          </div>

          <MessagesList
            system={stage.system}
            messages={stage.messages}
            emptyLabel="No messages before modification"
          />

          <JsonBlock title="Full Pre-Modification Request Body" data={stage.body} defaultExpanded={false} />
        </div>
      );
    }

    if (activeTab === "afterModify") {
      const stage = selectedLog.afterModify;
      const before = selectedLog.beforeModify;
      if (!stage) {
        const isNonChat = selectedLog.apiType && selectedLog.apiType !== "chat";
        return (
          <div className="p-4 rounded-lg border border-dashed border-border-subtle text-sm text-text-muted">
            {isNonChat ? (
              <>
                Non-chat API request (<code>{selectedLog.apiType}</code>) does not run chat prompt/message transformations. Inspect <strong>1. Received</strong>, <strong>4. Response</strong>, or <strong>5. W2 Proxy</strong>.
              </>
            ) : (
              "Request has not reached post-modification stage yet (or failed during translation)."
            )}
          </div>
        );
      }

      const beforeCount = before?.messageCount ?? 0;
      const afterCount = stage.messageCount ?? 0;
      const countChanged = before && beforeCount !== afterCount;
      const acpPrompt = typeof stage.executorPayload?.prompt === "string" ? stage.executorPayload.prompt : null;

      return (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={countChanged ? "warning" : "default"} size="sm">
                Messages: {beforeCount} → {afterCount}
              </Badge>
              {(stage.transformations || []).length > 0 ? (
                stage.transformations.map((t) => (
                  <Badge key={t} variant="primary" size="sm">{t}</Badge>
                ))
              ) : (
                <Badge variant="default" size="sm">No transforms</Badge>
              )}
            </div>

            {before && (
              <Button
                size="sm"
                variant={showCompare ? "primary" : "outline"}
                icon="compare"
                onClick={() => setShowCompare((v) => !v)}
              >
                {showCompare ? "Hide Compare" : "Compare Before / After"}
              </Button>
            )}
          </div>

          {stage.providerUrl && (
            <div className="text-xs text-text-muted flex items-center gap-2">
              <span>Upstream:</span>
              <code className="px-2 py-0.5 rounded bg-surface-2 font-mono text-text-main break-all">
                {stage.providerUrl}
              </code>
            </div>
          )}

          {showCompare && before ? (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              <div className="space-y-2 p-3 rounded-lg border border-border-subtle bg-surface-2/20">
                <div className="text-xs font-semibold text-text-main flex items-center justify-between">
                  <span>Before Modify ({beforeCount} msgs)</span>
                  {before.system && <Badge variant="warning" size="sm">has system</Badge>}
                </div>
                <MessagesList system={before.system} messages={before.messages} />
              </div>
              <div className="space-y-2 p-3 rounded-lg border border-primary/30 bg-primary/[0.03]">
                <div className="text-xs font-semibold text-text-main flex items-center justify-between">
                  <span>After Modify ({afterCount} msgs)</span>
                  {stage.system && <Badge variant="warning" size="sm">has system</Badge>}
                </div>
                <MessagesList system={stage.system} messages={stage.messages} />
              </div>
            </div>
          ) : (
            <MessagesList
              system={stage.system}
              messages={stage.messages}
              emptyLabel="No messages in modified body"
            />
          )}

          {acpPrompt !== null && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge variant="primary" size="sm">ACP Final Prompt Sent</Badge>
                  {stage.executorPayload?.stripSystemPrompt !== undefined && (
                    <Badge variant={stage.executorPayload.stripSystemPrompt ? "success" : "warning"} size="sm">
                      stripSystemPrompt: {String(stage.executorPayload.stripSystemPrompt)}
                    </Badge>
                  )}
                </div>
                <span className="text-[11px] text-text-muted">{acpPrompt.length} chars</span>
              </div>
              <pre className="text-xs font-mono text-text-main whitespace-pre-wrap break-words max-h-72 overflow-y-auto custom-scrollbar">
                {acpPrompt}
              </pre>
            </div>
          )}

          <JsonBlock title="Modified Body (translatedBody)" data={stage.translatedBody} defaultExpanded={false} />
          {stage.executorPayload && (
            <JsonBlock title="Executor Outbound Payload (finalBody)" data={stage.executorPayload} defaultExpanded={false} />
          )}
          {stage.providerHeaders && Object.keys(stage.providerHeaders).length > 0 && (
            <JsonBlock title="Outbound Provider Headers (Masked)" data={stage.providerHeaders} defaultExpanded={false} />
          )}
        </div>
      );
    }

    if (activeTab === "response") {
      const stage = selectedLog.response;
      if (!stage) {
        return (
          <div className="p-4 rounded-lg border border-dashed border-border-subtle text-sm text-text-muted">
            Waiting for response...
          </div>
        );
      }
      return (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant={statusBadgeVariant(selectedLog.status, stage.statusCode)} size="sm" dot>
              {statusBadgeLabel(selectedLog.status, stage.statusCode)}
            </Badge>
            {stage.type && <Badge variant="default" size="sm">{stage.type}</Badge>}
            {stage.finishReason && (
              <Badge variant="default" size="sm">finish: {stage.finishReason}</Badge>
            )}
            {selectedLog.latency && (
              <span className="text-text-muted font-mono">
                TTFT: {selectedLog.latency.ttft ?? 0}ms · Total: {selectedLog.latency.total ?? 0}ms
              </span>
            )}
            {selectedLog.tokens && (
              <span className="text-text-muted font-mono">
                IN: {selectedLog.tokens.prompt_tokens ?? selectedLog.tokens.input_tokens ?? 0} · OUT:{" "}
                {selectedLog.tokens.completion_tokens ?? selectedLog.tokens.output_tokens ?? 0}
              </span>
            )}
          </div>

          {stage.error && (
            <div className="p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-xs font-mono whitespace-pre-wrap break-words">
              {stage.error}
            </div>
          )}

          {stage.thinking && (
            <JsonBlock title="Thinking / Reasoning" data={stage.thinking} defaultExpanded={false} />
          )}

          {stage.content !== null && stage.content !== undefined && (
            <div className="rounded-lg border border-border-subtle bg-surface/70 p-3 space-y-1.5">
              <div className="text-xs font-semibold text-text-main">Assistant Output</div>
              <pre className="text-xs font-mono text-text-main whitespace-pre-wrap break-words max-h-80 overflow-y-auto custom-scrollbar">
                {typeof stage.content === "string" ? stage.content : JSON.stringify(stage.content, null, 2)}
              </pre>
            </div>
          )}

          {stage.clientResponse && (
            <JsonBlock title="Client Response Payload" data={stage.clientResponse} defaultExpanded={!stage.content} />
          )}
          {stage.providerResponse && (
            <JsonBlock title="Raw Provider Response" data={stage.providerResponse} defaultExpanded={false} />
          )}

          {Array.isArray(selectedLog.attempts) && selectedLog.attempts.length > 0 && (
            <div className="space-y-3 pt-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[18px] text-amber-500">alt_route</span>
                  <span className="text-xs font-semibold text-text-main">
                    Fallback History ({selectedLog.attempts.length} failed attempt{selectedLog.attempts.length > 1 ? "s" : ""})
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab("fallback")}
                  className="text-xs text-primary hover:underline flex items-center gap-1 font-medium"
                >
                  View full fallback chain
                  <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
                </button>
              </div>
              <div className="space-y-2">
                {selectedLog.attempts.map((att, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded-lg border border-amber-500/20 bg-amber-500/5 text-xs flex flex-col gap-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 font-mono">
                        <Badge variant="warning" size="sm">Attempt #{idx + 1}</Badge>
                        <span className="font-semibold text-text-main">
                          {att.provider ? `${att.provider}/${att.model || ""}` : (att.model || "Unknown")}
                        </span>
                      </div>
                      <Badge variant={statusBadgeVariant(att.status, att.statusCode)} size="sm">
                        {statusBadgeLabel(att.status, att.statusCode)}
                      </Badge>
                    </div>
                    {(att.error || att.response?.error) && (
                      <div className="text-[11px] font-mono text-red-600 dark:text-red-400 bg-red-500/10 p-2 rounded border border-red-500/20 whitespace-pre-wrap break-words">
                        {att.error || att.response?.error}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }

    if (activeTab === "fallback") {
      const attempts = Array.isArray(selectedLog.attempts) ? selectedLog.attempts : [];
      const hasCombo = selectedLog.isCombo || selectedLog.comboName || attempts.length > 0;
      const comboModels = selectedLog.comboModels || [];

      return (
        <div className="space-y-4">
          <div className="p-3.5 rounded-lg border border-border-subtle bg-surface-2/40 flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[20px] text-primary">alt_route</span>
                <span className="font-semibold text-text-main text-sm">
                  {selectedLog.comboName ? `Combo: ${selectedLog.comboName}` : "Model Fallback & Routing"}
                </span>
                {selectedLog.comboStrategy && (
                  <Badge variant="default" size="sm">
                    Strategy: {selectedLog.comboStrategy}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1.5 font-mono text-xs text-text-muted">
                <span>Total Candidates: {comboModels.length || (attempts.length + (selectedLog.provider ? 1 : 0))}</span>
                <span>•</span>
                <span className={attempts.length > 0 ? "text-amber-500 font-semibold" : ""}>
                  Failed: {attempts.length}
                </span>
              </div>
            </div>

            {comboModels.length > 0 && (
              <div className="text-xs text-text-muted pt-1">
                <div className="text-[11px] font-medium text-text-muted mb-1">Configured Model Chain:</div>
                <div className="flex flex-wrap items-center gap-1 font-mono">
                  {comboModels.map((m, idx) => {
                    const isFinal = selectedLog.model && (m === selectedLog.model || m.endsWith(`/${selectedLog.model}`));
                    const isFailed = attempts.some((att) => att.model === m || att.provider && m.includes(att.provider));
                    return (
                      <span key={idx} className="flex items-center gap-1">
                        <span
                          className={cn(
                            "px-2 py-0.5 rounded text-[11px] border",
                            isFinal
                              ? "bg-green-500/15 border-green-500/30 text-green-700 dark:text-green-300 font-semibold"
                              : isFailed
                              ? "bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-400 line-through"
                              : "bg-surface border-border-subtle text-text-muted"
                          )}
                        >
                          {idx + 1}. {m}
                        </span>
                        {idx < comboModels.length - 1 && <span className="text-text-muted">→</span>}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {attempts.length === 0 ? (
            <div className="p-6 rounded-lg border border-dashed border-border-subtle text-center text-xs text-text-muted space-y-1">
              <span className="material-symbols-outlined text-[24px] text-green-500">check_circle</span>
              <p className="font-medium text-text-main">No fallback was triggered</p>
              <p>The primary candidate served the request successfully on the first attempt.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                Execution Steps & Fallback Chain
              </div>
              {attempts.map((att, idx) => (
                <div
                  key={idx}
                  className="rounded-lg border border-red-500/30 bg-surface overflow-hidden shadow-sm"
                >
                  <div className="px-3.5 py-2.5 bg-red-500/10 border-b border-red-500/20 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="material-symbols-outlined text-[16px] text-red-500">error</span>
                      <span className="font-semibold text-text-main font-mono">
                        Attempt #{idx + 1}: {att.provider ? `${att.provider}/${att.model || ""}` : (att.model || "Unknown")}
                      </span>
                      {att.providerName && (
                        <span className="text-[11px] text-text-muted">({att.providerName})</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge variant={statusBadgeVariant(att.status || "error", att.statusCode)} size="sm">
                        {statusBadgeLabel(att.status || "error", att.statusCode)}
                      </Badge>
                      <Badge variant="error" size="sm">
                        FAILED
                      </Badge>
                    </div>
                  </div>

                  <div className="p-3.5 space-y-3 text-xs">
                    {(att.error || att.response?.error) && (
                      <div className="p-2.5 rounded bg-red-500/10 border border-red-500/20 font-mono text-red-600 dark:text-red-400 text-xs whitespace-pre-wrap break-words">
                        <div className="font-bold text-[11px] mb-1">Failure Reason:</div>
                        {att.error || att.response?.error}
                      </div>
                    )}

                    {att.beforeModify && (
                      <JsonBlock
                        title={`Attempt #${idx + 1} Payload (Before Modify)`}
                        data={att.beforeModify.body || att.beforeModify}
                        defaultExpanded={false}
                      />
                    )}

                    {att.afterModify && (
                      <JsonBlock
                        title={`Attempt #${idx + 1} Upstream Payload (After Modify)`}
                        data={att.afterModify.body || att.afterModify}
                        defaultExpanded={false}
                      />
                    )}

                    {att.response && (
                      <JsonBlock
                        title={`Attempt #${idx + 1} Error Response`}
                        data={att.response}
                        defaultExpanded={false}
                      />
                    )}
                  </div>
                </div>
              ))}

              {/* Final Successful or Terminal Attempt */}
              <div className="rounded-lg border border-green-500/30 bg-surface overflow-hidden shadow-sm">
                <div className="px-3.5 py-2.5 bg-green-500/10 border-b border-green-500/20 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="material-symbols-outlined text-[16px] text-green-500">
                      {selectedLog.status === "error" ? "cancel" : "check_circle"}
                    </span>
                    <span className="font-semibold text-text-main font-mono">
                      Final Attempt #{attempts.length + 1}: {selectedLog.provider ? `${selectedLog.provider}/${selectedLog.model || ""}` : (selectedLog.model || "Unknown")}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Badge variant={statusBadgeVariant(selectedLog.status, selectedLog.statusCode)} size="sm">
                      {statusBadgeLabel(selectedLog.status, selectedLog.statusCode)}
                    </Badge>
                  </div>
                </div>
                <div className="p-3.5 text-xs text-text-muted">
                  {selectedLog.status === "error"
                    ? "Exhausted all fallback models. The final error was returned to the client."
                    : "Fallback succeeded! This model fulfilled the request."}
                </div>
              </div>
            </div>
          )}
        </div>
      );
    }

    if (activeTab === "w2Capture") {
      const stage = selectedLog.w2Capture;
      const captures = Array.isArray(stage?.captures) ? stage.captures : [];
      const otherRequests = Array.isArray(stage?.otherRequests) ? stage.otherRequests : [];
      const isBuiltin = stage?.source === "builtin-proxy";

      return (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant={isBuiltin ? "primary" : "default"} size="sm">
                {isBuiltin ? "Built-in Proxy" : "W2 Proxy"}
              </Badge>
              <Badge variant={captures.length > 0 ? "success" : "default"} size="sm">
                {captures.length} capture(s)
              </Badge>
              {stage?.hasSystemPrompt && (
                <Badge variant="warning" size="sm">Has Upstream Sysprompt</Badge>
              )}
              {stage?.scriptModified && (
                <Badge variant="info" size="sm">Script Modified</Badge>
              )}
              {stage?.w2Url && (
                <code className="px-2 py-0.5 rounded bg-surface-2 font-mono text-text-main">
                  {stage.w2Url}
                </code>
              )}
              {stage?.syncedAt && (
                <span className="text-text-muted">Recorded {formatTime(stage.syncedAt)}</span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {!isBuiltin && (
                <>
                  <a
                    href={`${stage?.w2Url || "http://127.0.0.1:8899"}/plugin.script/`}
                    target="_blank"
                    rel="noreferrer"
                    className="px-2.5 py-1 rounded-lg border border-border-subtle bg-surface text-xs text-text-muted hover:text-text-main hover:bg-surface-2 transition-colors"
                  >
                    Whistle Script UI ↗
                  </a>
                  <Button
                    size="sm"
                    variant="outline"
                    icon="sync"
                    loading={syncingW2}
                    onClick={handleSyncW2}
                  >
                    Sync from w2
                  </Button>
                </>
              )}
            </div>
          </div>

          {w2SyncError && (
            <div className="p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-xs">
              {w2SyncError}
            </div>
          )}

          {captures.length === 0 ? (
            <div className="p-6 rounded-lg border border-dashed border-border-subtle text-center text-xs text-text-muted space-y-2">
              <div>No upstream requests captured for this request yet.</div>
              <div>
                Enable <strong>Built-in Interceptor Proxy</strong> in Settings (no external proxy needed), or click{" "}
                <strong>Sync from w2</strong> if using external Whistle.
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {captures.map((cap, idx) => (
                <div
                  key={cap.id || idx}
                  className="rounded-xl border border-border-subtle bg-surface/70 p-3.5 space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                      <Badge variant={cap.statusCode >= 400 ? "error" : "success"} size="sm">
                        {cap.statusCode || "?"}
                      </Badge>
                      <Badge variant="primary" size="sm">{cap.method || "POST"}</Badge>
                      {cap.systemPromptFormat && (
                        <Badge variant="info" size="sm">{cap.systemPromptFormat}</Badge>
                      )}
                      {cap.upstreamModel && (
                        <Badge variant="default" size="sm">{cap.upstreamModel}</Badge>
                      )}
                      {cap.toolsCount > 0 && (
                        <Badge variant="default" size="sm">{cap.toolsCount} tools</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] font-mono text-text-muted">
                      <span>Req {formatBytes(cap.reqSize)}</span>
                      <span>·</span>
                      <span>Res {formatBytes(cap.resSize)}</span>
                      {cap.durationMs != null && (
                        <>
                          <span>·</span>
                          <span>{cap.durationMs}ms</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="text-xs font-mono text-text-main break-all bg-surface-2/60 px-2.5 py-1.5 rounded-lg">
                    {cap.url}
                  </div>

                  {Array.isArray(cap.rules) && cap.rules.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] text-text-muted">Matched rules:</span>
                      {cap.rules.map((r) => (
                        <Badge key={r} variant={cap.scriptModified ? "warning" : "primary"} size="sm">{r}</Badge>
                      ))}
                      {cap.scriptModified && cap.beforeSysPromptChars !== undefined && cap.afterSysPromptChars !== undefined && (
                        <span className="text-[11px] font-mono text-amber-600 dark:text-amber-400">
                          sysprompt: {cap.beforeSysPromptChars} → {cap.afterSysPromptChars} chars
                        </span>
                      )}
                    </div>
                  )}

                  {cap.scriptError && (
                    <div className="p-2.5 rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-xs font-mono">
                      Interceptor script error (fail-open): {cap.scriptError}
                    </div>
                  )}

                  {Array.isArray(cap.scriptLogs) && cap.scriptLogs.length > 0 && (
                    <div className="p-2.5 rounded-lg border border-border-subtle bg-surface-2/60 text-xs font-mono text-text-muted space-y-0.5">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-text-main">Script Console</div>
                      {cap.scriptLogs.map((line, li) => (
                        <div key={li}>{line}</div>
                      ))}
                    </div>
                  )}

                  {cap.systemPrompt ? (
                    <div className="rounded-lg border border-amber-500/35 bg-amber-500/5 p-3 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Badge variant="warning" size="sm">Upstream System Prompt (ACP / Provider)</Badge>
                          <span className="text-[11px] font-mono text-text-muted">
                            {cap.systemPromptChars?.toLocaleString?.() || cap.systemPrompt.length} chars
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => navigator.clipboard?.writeText?.(cap.systemPrompt).catch(() => {})}
                          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium text-text-muted hover:text-text-main hover:bg-surface transition-colors"
                        >
                          <span className="material-symbols-outlined text-[14px]">content_copy</span>
                          Copy Sysprompt
                        </button>
                      </div>
                      <pre className="text-xs font-mono text-text-main whitespace-pre-wrap break-words max-h-80 overflow-y-auto custom-scrollbar">
                        {cap.systemPrompt}
                      </pre>
                    </div>
                  ) : (
                    <div className="text-[11px] text-text-muted italic">
                      No systemInstruction / system prompt field in this request body (likely helper call).
                    </div>
                  )}

                  <JsonBlock
                    title="Upstream Request Body (Decoded JSON)"
                    data={cap.reqBody}
                    defaultExpanded={false}
                  />
                  <JsonBlock
                    title="Upstream Request Headers (Masked)"
                    data={cap.reqHeaders}
                    defaultExpanded={false}
                  />
                  {cap.resPreview && (
                    <JsonBlock
                      title="Upstream Response Preview"
                      data={cap.resPreview}
                      defaultExpanded={false}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {otherRequests.length > 0 && (
            <JsonBlock
              title={`Auxiliary / Telemetry Requests in Same Window (${otherRequests.length})`}
              data={otherRequests}
              defaultExpanded={false}
            />
          )}
        </div>
      );
    }

    // Raw JSON tab
    return (
      <div className="space-y-3">
        <div className="text-xs text-text-muted font-mono">
          Disk file: {meta.storageDir ? `${meta.storageDir}/${selectedLog.filename}` : selectedLog.filename}
        </div>
        <JsonBlock title={selectedLog.filename || "request.json"} data={selectedLog} defaultExpanded={true} maxHeight="max-h-[calc(100vh-340px)]" />
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Top Toolbar */}
      <Card padding="sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Search + Filters */}
          <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[260px]">
            <div className="relative flex-1 min-w-[200px] max-w-xs">
              <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-[16px] text-text-muted pointer-events-none">
                search
              </span>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search model, provider, endpoint..."
                className="w-full h-8 pl-8 pr-7 rounded-lg border border-border-subtle bg-bg text-xs text-text-main focus:outline-none focus:border-primary/50"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-main"
                >
                  <span className="material-symbols-outlined text-[15px]">close</span>
                </button>
              )}
            </div>

            <div className="flex items-center rounded-lg border border-border-subtle bg-bg p-0.5">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setStatusFilter(f.id)}
                  className={cn(
                    "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                    statusFilter === f.id
                      ? "bg-primary text-white"
                      : "text-text-muted hover:text-text-main"
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <select
              value={providerFilter}
              onChange={(e) => setProviderFilter(e.target.value)}
              className="h-8 px-2.5 rounded-lg border border-border-subtle bg-bg text-xs text-text-main focus:outline-none focus:border-primary/50"
            >
              <option value="">All Providers</option>
              {meta.providers.map((p) => (
                <option key={p} value={p}>
                  {resolveProviderLabel(p)}
                </option>
              ))}
            </select>

            <select
              value={apiTypeFilter}
              onChange={(e) => setApiTypeFilter(e.target.value)}
              className="h-8 px-2.5 rounded-lg border border-border-subtle bg-bg text-xs text-text-main focus:outline-none focus:border-primary/50"
            >
              <option value="">All APIs</option>
              {(meta.apiTypes || []).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          {/* Storage Info & Actions */}
          <div className="flex flex-wrap items-center gap-2">
            <div
              title={meta.storageDir || "~/.9router/request-logs"}
              className="flex items-center gap-1.5 px-2.5 h-8 rounded-lg bg-surface-2/70 border border-border-subtle text-xs text-text-muted"
            >
              <span className="material-symbols-outlined text-[15px] text-primary">hard_drive</span>
              <span className="font-mono font-medium text-text-main">
                {meta.total}/{meta.maxFiles}
              </span>
              <span>files</span>
              <span>·</span>
              <span className="font-mono">{formatBytes(meta.totalSizeBytes)}</span>
            </div>

            <button
              type="button"
              onClick={() => setAutoRefresh((v) => !v)}
              className={cn(
                "flex items-center gap-1.5 px-2.5 h-8 rounded-lg border text-xs font-medium transition-colors",
                autoRefresh
                  ? "border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400"
                  : "border-border-subtle bg-bg text-text-muted hover:text-text-main"
              )}
              title="Toggle 3s auto-refresh"
            >
              <span className={cn("size-1.5 rounded-full", autoRefresh ? "bg-green-500 animate-pulse" : "bg-gray-400")} />
              Auto
            </button>

            <Button size="sm" variant="outline" icon="refresh" onClick={() => fetchList(false)}>
              Refresh
            </Button>

            <Button
              size="sm"
              variant="outline"
              icon="delete_sweep"
              disabled={meta.total === 0}
              onClick={() => setShowClearConfirm(true)}
            >
              Clear
            </Button>
          </div>
        </div>
      </Card>

      {/* Master-Detail Split View */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:h-[calc(100vh-215px)] min-h-[520px]">
        {/* Left List */}
        <Card padding="none" className="lg:col-span-4 flex flex-col overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border-subtle flex items-center justify-between bg-surface-2/40 shrink-0">
            <span className="text-xs font-semibold text-text-main">
              Recent Requests ({items.length})
            </span>
            <span className="text-[11px] text-text-muted">Newest first · 1 JSON / req</span>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar divide-y divide-border-subtle">
            {loadingList && items.length === 0 ? (
              <div className="p-8 text-center text-xs text-text-muted">Loading logs...</div>
            ) : items.length === 0 ? (
              <div className="p-8 text-center text-xs text-text-muted space-y-2">
                <span className="material-symbols-outlined text-[32px] opacity-40 block">inbox</span>
                <div>No request logs recorded yet.</div>
                <div className="text-[11px]">Send any API request to 9Router to see it logged on disk.</div>
              </div>
            ) : (
              items.map((item) => {
                const isSelected = item.id === selectedId;
                const msgChanged =
                  item.beforeMessageCount !== null &&
                  item.afterMessageCount !== null &&
                  item.beforeMessageCount !== item.afterMessageCount;
                const primaryLabel = item.clientModel || item.model || item.endpoint || "unknown";
                const showEndpointInSubline = Boolean(item.endpoint && item.endpoint !== primaryLabel);

                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleSelectItem(item.id)}
                    className={cn(
                      "w-full text-left px-3.5 py-2.5 transition-colors flex flex-col gap-1.5",
                      isSelected
                        ? "bg-primary/10 border-l-2 border-l-primary"
                        : "hover:bg-surface-2/60 border-l-2 border-l-transparent"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Badge
                          variant={statusBadgeVariant(item.status, item.statusCode)}
                          size="sm"
                          dot
                        >
                          {statusBadgeLabel(item.status, item.statusCode)}
                        </Badge>
                        {item.method && item.method !== "POST" && (
                          <span className="px-1 py-0.5 rounded bg-surface-2 text-text-muted text-[10px] font-mono shrink-0">
                            {item.method}
                          </span>
                        )}
                        <span className="text-xs font-semibold font-mono text-text-main truncate">
                          {primaryLabel}
                        </span>
                      </div>
                      <span className="text-[11px] font-mono text-text-muted shrink-0" title={formatDateTime(item.createdAt)}>
                        {formatTime(item.createdAt)}
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-2 text-[11px] text-text-muted">
                      <span className="truncate">
                        {item.provider ? resolveProviderLabel(item.provider, item.providerName) : (item.apiType || "api")}
                        {showEndpointInSubline ? ` · ${item.endpoint}` : ""}
                      </span>
                      <span className="font-mono shrink-0">
                        {item.latency?.total != null ? `${item.latency.total}ms` : formatRelative(item.createdAt)}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-1">
                      <div className="flex flex-wrap items-center gap-1">
                        {item.apiType && item.apiType !== "chat" && (
                          <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 text-[10px] font-mono">
                            {item.apiType}
                          </span>
                        )}
                        {(item.isCombo || item.fallbackCount > 0) && (
                          <span
                            className={cn(
                              "px-1.5 py-0.5 rounded text-[10px] font-mono font-medium",
                              item.fallbackCount > 0
                                ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                                : "bg-purple-500/15 text-purple-600 dark:text-purple-400"
                            )}
                            title={item.fallbackCount > 0 ? `${item.fallbackCount} fallback attempt(s)` : "Combo model"}
                          >
                            COMBO{item.fallbackCount > 0 ? ` (${item.fallbackCount} retried)` : ""}
                          </span>
                        )}
                        {item.beforeMessageCount != null && item.afterMessageCount != null && (
                          <span
                            className={cn(
                              "px-1.5 py-0.5 rounded text-[10px] font-mono",
                              msgChanged
                                ? "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400"
                                : "bg-surface-2 text-text-muted"
                            )}
                          >
                            {item.beforeMessageCount}→{item.afterMessageCount} msgs
                          </span>
                        )}
                        {(item.transformations || []).slice(0, 2).map((t) => (
                          <span
                            key={t}
                            className="px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-mono"
                          >
                            {t}
                          </span>
                        ))}
                        {item.w2CaptureCount > 0 && (
                          <span
                            className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px] font-mono"
                            title={item.w2HasSystemPrompt ? "Captured in w2 with upstream sysprompt" : "Captured in w2 proxy"}
                          >
                            W2:{item.w2CaptureCount}
                          </span>
                        )}
                        {(item.transformations || []).length > 2 && (
                          <span className="text-[10px] text-text-muted">
                            +{item.transformations.length - 2}
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] font-mono text-text-muted">
                        {formatBytes(item.fileSizeBytes)}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </Card>

        {/* Right Detail Inspector */}
        <Card padding="none" className="lg:col-span-8 flex flex-col overflow-hidden">
          {selectedLog && (
            <div className="px-4 py-3 border-b border-border-subtle bg-surface-2/30 shrink-0 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Badge
                    variant={statusBadgeVariant(selectedLog.status, selectedLog.statusCode)}
                    size="sm"
                    dot
                  >
                    {statusBadgeLabel(selectedLog.status, selectedLog.statusCode)}
                  </Badge>
                  {selectedLog.method && (
                    <Badge variant="default" size="sm">
                      {selectedLog.method}
                    </Badge>
                  )}
                  {selectedLog.apiType && (
                    <Badge variant={apiTypeBadgeVariant(selectedLog.apiType)} size="sm">
                      {selectedLog.apiType}
                    </Badge>
                  )}
                  {selectedLog.isCombo && (
                    <Badge variant="warning" size="sm">
                      COMBO
                    </Badge>
                  )}
                  <span className="text-sm font-semibold font-mono text-text-main truncate">
                    {selectedLog.clientModel || selectedLog.model || selectedLog.endpoint || selectedLog.id}
                  </span>
                  {selectedLog.provider && (
                    <span className="text-xs text-text-muted truncate">
                      → {resolveProviderLabel(selectedLog.provider, selectedLog.providerName)}
                      {selectedLog.model ? ` / ${selectedLog.model}` : ""}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <Button size="sm" variant="outline" icon="download" onClick={handleDownloadJson}>
                    JSON
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    icon="delete"
                    onClick={() => handleDeleteOne(selectedLog.id)}
                  >
                    Delete
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted font-mono">
                <span>{formatDateTime(selectedLog.createdAt)}</span>
                <span>•</span>
                <span>{selectedLog.filename}</span>
                <span>•</span>
                <span>{formatBytes(selectedLog.fileSizeBytes)}</span>
                {selectedLog.latency?.total != null && (
                  <>
                    <span>•</span>
                    <span>
                      TTFT {selectedLog.latency.ttft ?? 0}ms / Total {selectedLog.latency.total}ms
                    </span>
                  </>
                )}
              </div>

              {/* Stage Tabs */}
              <div className="flex flex-wrap items-center gap-1 pt-1">
                {DETAIL_TABS.map((tab) => {
                  let hasData =
                    tab.id === "raw" ||
                    (tab.id === "w2Capture"
                      ? Boolean(selectedLog.w2Capture?.captureCount > 0)
                      : Boolean(selectedLog[tab.id]));
                  let badgeCount = 0;
                  if (tab.id === "w2Capture") {
                    badgeCount = selectedLog.w2Capture?.captureCount || 0;
                  } else if (tab.id === "fallback") {
                    badgeCount = Array.isArray(selectedLog.attempts) ? selectedLog.attempts.length : 0;
                    hasData = Boolean(selectedLog.isCombo || selectedLog.comboName || badgeCount > 0);
                  }
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveTab(tab.id)}
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
                        activeTab === tab.id
                          ? "bg-primary text-white shadow-sm"
                          : "bg-surface text-text-muted hover:text-text-main hover:bg-surface-2 border border-border-subtle"
                      )}
                    >
                      <span className="material-symbols-outlined text-[15px]">{tab.icon}</span>
                      <span>
                        {tab.label}
                        {badgeCount > 0 ? ` (${badgeCount})` : ""}
                      </span>
                      {!hasData && (
                        <span className="size-1.5 rounded-full bg-gray-400/60" title="Not captured for this request" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
            {renderDetailContent()}
          </div>
        </Card>
      </div>

      <ConfirmModal
        isOpen={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        onConfirm={handleClearAll}
        title="Clear All Request Logs"
        message={`Delete all ${meta.total} JSON request log file(s) from disk?`}
        confirmText={clearing ? "Clearing..." : "Clear All"}
        cancelText="Cancel"
        variant="danger"
      />
    </div>
  );
}
