"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button } from "@/shared/components";
import { getProviderCustomModelRows } from "@/shared/utils/providerCustomModels";
function CompatibleModelRow({ modelId, fullModel, copied, onCopy, onDeleteAlias, onDisable, onTest, testStatus, isTesting }) {
  const borderColor = testStatus === "ok"
    ? "border-green-500/40"
    : testStatus === "error"
    ? "border-red-500/40"
    : "border-border";

  const iconColor = testStatus === "ok"
    ? "#22c55e"
    : testStatus === "error"
    ? "#ef4444"
    : undefined;

  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg border ${borderColor} hover:bg-sidebar/50`}>
      <span
        className="material-symbols-outlined text-base text-text-muted"
        style={iconColor ? { color: iconColor } : undefined}
      >
        {testStatus === "ok" ? "check_circle" : testStatus === "error" ? "cancel" : "smart_toy"}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{modelId}</p>
        <div className="flex items-center gap-1 mt-1">
          <code className="text-xs text-text-muted font-mono bg-sidebar px-1.5 py-0.5 rounded">{fullModel}</code>
          <div className="relative group/btn">
            <button
              onClick={() => onCopy(fullModel, `model-${modelId}`)}
              className="p-0.5 hover:bg-sidebar rounded text-text-muted hover:text-primary"
            >
              <span className="material-symbols-outlined text-sm">
                {copied === `model-${modelId}` ? "check" : "content_copy"}
              </span>
            </button>
            <span className="pointer-events-none absolute top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
              {copied === `model-${modelId}` ? "Copied!" : "Copy"}
            </span>
          </div>
          {onTest && (
            <div className="relative group/btn">
              <button
                onClick={onTest}
                disabled={isTesting}
                className="p-0.5 hover:bg-sidebar rounded text-text-muted hover:text-primary transition-colors"
              >
                <span className="material-symbols-outlined text-sm" style={isTesting ? { animation: "spin 1s linear infinite" } : undefined}>
                  {isTesting ? "progress_activity" : "science"}
                </span>
              </button>
              <span className="pointer-events-none absolute top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
                {isTesting ? "Testing..." : "Test"}
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {onDisable && (
          <button
            onClick={onDisable}
            className="p-1 hover:bg-amber-500/10 rounded text-text-muted hover:text-amber-500 transition-colors"
            title="Disable model"
          >
            <span className="material-symbols-outlined text-sm">block</span>
          </button>
        )}
        <button
          onClick={onDeleteAlias}
          className="p-1 hover:bg-red-500/10 rounded text-red-500 transition-colors"
          title="Remove model"
        >
          <span className="material-symbols-outlined text-sm">delete</span>
        </button>
      </div>
    </div>
  );
}

export default function CompatibleModelsSection({
  providerStorageAlias,
  providerDisplayAlias,
  modelAliases,
  customModels,
  copied,
  onCopy,
  onDeleteAlias,
  onAddCustomModel,
  onRefreshCustomModels,
  onDeleteCustomModel,
  disabledModelIds = [],
  onDisableModel,
  onEnableModel,
  connections,
  isAnthropic,
  isAcp,
  nodeModels,
}) {
  const [newModel, setNewModel] = useState("");
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState(null);
  const [testingModelId, setTestingModelId] = useState(null);
  const [modelTestResults, setModelTestResults] = useState({});

  const handleTestModel = async (modelId) => {
    if (testingModelId) return;
    setTestingModelId(modelId);
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${providerStorageAlias}/${modelId}` }),
      });
      const data = await res.json();
      setModelTestResults((prev) => ({ ...prev, [modelId]: data.ok ? "ok" : "error" }));
    } catch {
      setModelTestResults((prev) => ({ ...prev, [modelId]: "error" }));
    } finally {
      setTestingModelId(null);
    }
  };

  const baseModels = getProviderCustomModelRows({
    customModels,
    modelAliases,
    providerAlias: providerStorageAlias,
    type: "llm",
  });
  const nodeModelRows = (nodeModels || []).map((m) => {
    const mId = typeof m === "string" ? m : (m.id || m.name);
    return {
      id: mId,
      alias: mId,
      source: "node",
    };
  });
  const seenIds = new Set(baseModels.map((m) => m.id));
  const allModels = [
    ...baseModels,
    ...nodeModelRows.filter((m) => !seenIds.has(m.id)),
  ];

  const handleAdd = async () => {
    if (!newModel.trim() || adding) return;
    const modelId = newModel.trim();
    if (allModels.some((model) => model.id === modelId)) {
      alert("Model already exists for this provider.");
      return;
    }

    setAdding(true);
    try {
      await onAddCustomModel(modelId);
      setNewModel("");
    } catch (error) {
      console.log("Error adding model:", error);
    } finally {
      setAdding(false);
    }
  };

  const handleImport = async () => {
    if (importing) return;
    const activeConnection = connections.find((conn) => conn.isActive !== false);
    if (!activeConnection) return;

    setImporting(true);
    setImportStatus(null);
    try {
      const res = await fetch(`/api/providers/${activeConnection.id}/models${isAcp ? "?refresh=1" : ""}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setImportStatus({ type: "error", text: data.error || "Failed to fetch models" });
        return;
      }
      const models = data.models || [];
      if (models.length === 0) {
        setImportStatus({
          type: "error",
          text: data.discoveryError ? `No models returned: ${data.discoveryError}` : "No models returned from server.",
        });
        return;
      }
      const existingIds = new Set(allModels.map((entry) => entry.id));
      const newModelIds = [];
      for (const model of models) {
        const modelId = model.id || model.name || model.model;
        if (!modelId || existingIds.has(modelId)) continue;
        existingIds.add(modelId);
        newModelIds.push(modelId);
      }
      if (newModelIds.length === 0) {
        setImportStatus({
          type: data.discoveryError ? "error" : "info",
          text: data.discoveryError
            ? `Discovery failed: ${data.discoveryError}`
            : `All ${models.length} models from server are already added.`,
        });
        return;
      }
      for (const modelId of newModelIds) {
        await onAddCustomModel(modelId, { skipRefresh: !!onRefreshCustomModels, silent: true });
      }
      if (onRefreshCustomModels) {
        await onRefreshCustomModels();
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("customModelChanged"));
      }
      setImportStatus({
        type: "success",
        text: `Fetched and added ${newModelIds.length} models (total ${models.length} discovered).`,
      });
    } catch (error) {
      console.log("Error importing models:", error);
      setImportStatus({ type: "error", text: error.message || "Error fetching models" });
    } finally {
      setImporting(false);
    }
  };

  const canImport = connections.some((conn) => conn.isActive !== false);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">
        {isAcp
          ? "Manage models available for this ACP Server or add custom model mappings."
          : `Add ${isAnthropic ? "Anthropic" : "OpenAI"}-compatible models manually or import them from the /models endpoint.`}
      </p>

      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <label htmlFor="new-compatible-model-input" className="text-xs text-text-muted mb-1 block">Model ID</label>
          <input
            id="new-compatible-model-input"
            type="text"
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder={isAcp ? "gemini-3.8-flash" : isAnthropic ? "claude-3-opus-20240229" : "gpt-4o"}
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
          />
        </div>
        <Button size="sm" icon="add" onClick={handleAdd} disabled={!newModel.trim() || adding}>
          {adding ? "Adding..." : "Add"}
        </Button>
        <Button size="sm" variant="secondary" icon="download" onClick={handleImport} disabled={!canImport || importing}>
          {importing ? (isAcp ? "Fetching..." : "Importing...") : (isAcp ? "Fetch Models" : "Import from /models")}
        </Button>
      </div>

      {importStatus && (
        <p className={`text-xs ${
          importStatus.type === "error"
            ? "text-red-500"
            : importStatus.type === "success"
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-text-muted"
        }`}>
          {importStatus.text}
        </p>
      )}

      {!canImport && (
        <p className="text-xs text-text-muted">
          Add a connection to enable importing models.
        </p>
      )}

      {(() => {
        const disabledSet = new Set(disabledModelIds || []);
        const activeModels = allModels.filter((m) => !disabledSet.has(m.id));
        const disabledModels = allModels.filter((m) => disabledSet.has(m.id));
        const extraDisabledIds = (disabledModelIds || []).filter((id) => !allModels.some((m) => m.id === id));
        const allDisabledItems = [
          ...disabledModels.map((m) => m.id),
          ...extraDisabledIds,
        ];

        return (
          <>
            {activeModels.length > 0 && (
              <div className="flex flex-col gap-3">
                {activeModels.map(({ id, alias, source }) => (
                  <CompatibleModelRow
                    key={`${source}-${providerStorageAlias}/${id}`}
                    modelId={id}
                    fullModel={`${providerDisplayAlias}/${id}`}
                    copied={copied}
                    onCopy={onCopy}
                    onDisable={onDisableModel ? () => onDisableModel(id) : undefined}
                    onDeleteAlias={() => source === "custom" ? onDeleteCustomModel(id) : onDeleteAlias(alias)}
                    onTest={connections.length > 0 ? () => handleTestModel(id) : undefined}
                    testStatus={modelTestResults[id]}
                    isTesting={testingModelId === id}
                  />
                ))}
              </div>
            )}

            {allDisabledItems.length > 0 && (
              <div className="w-full mt-2">
                <p className="text-xs text-text-muted mb-2">Disabled models ({allDisabledItems.length}):</p>
                <div className="flex flex-wrap gap-2">
                  {allDisabledItems.map((id) => (
                    <button
                      key={id}
                      onClick={() => onEnableModel && onEnableModel(id)}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-dashed border-black/10 dark:border-white/10 text-xs text-text-muted hover:text-primary hover:border-primary/40 hover:bg-primary/5 transition-colors"
                      title="Restore model"
                    >
                      <span className="material-symbols-outlined text-[13px]">add</span>
                      {id}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}

CompatibleModelsSection.propTypes = {
  providerStorageAlias: PropTypes.string.isRequired,
  providerDisplayAlias: PropTypes.string.isRequired,
  modelAliases: PropTypes.object.isRequired,
  customModels: PropTypes.arrayOf(PropTypes.object),
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  onDeleteAlias: PropTypes.func.isRequired,
  onAddCustomModel: PropTypes.func.isRequired,
  onDeleteCustomModel: PropTypes.func.isRequired,
  connections: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    isActive: PropTypes.bool,
  })).isRequired,
  isAnthropic: PropTypes.bool,
};
