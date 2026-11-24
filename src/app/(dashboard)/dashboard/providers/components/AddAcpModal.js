"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Badge, Button, Input, Modal } from "@/shared/components";

export default function AddAcpModal({ isOpen, onClose, onCreated }) {
  const [activeTab, setActiveTab] = useState("zed"); // "zed" | "manual"
  const [zedLoading, setZedLoading] = useState(false);
  const [zedData, setZedData] = useState(null);

  const initialFormData = {
    name: "",
    prefix: "",
    command: "",
    args: "",
    defaultModel: "",
    envJson: "",
    stripSystemPrompt: true,
  };

  const [formData, setFormData] = useState(initialFormData);
  const [submitting, setSubmitting] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);

  useEffect(() => {
    if (isOpen) {
      setValidationResult(null);
      fetchZedServers();
    }
  }, [isOpen]);

  const fetchZedServers = async () => {
    setZedLoading(true);
    try {
      const res = await fetch("/api/provider-nodes/zed-agent-servers");
      const data = await res.json();
      setZedData(data);
      if (data.found && data.servers?.length > 0) {
        setActiveTab("zed");
      } else {
        setActiveTab("manual");
      }
    } catch {
      setActiveTab("manual");
    } finally {
      setZedLoading(false);
    }
  };

  const handleSelectZedServer = (server) => {
    setFormData({
      name: server.name || server.id || "",
      prefix: server.suggestedPrefix || "acp-srv",
      command: server.command || "",
      args: Array.isArray(server.args) ? server.args.join(" ") : "",
      defaultModel: server.defaultModel || "",
      envJson: server.env && Object.keys(server.env).length > 0 ? JSON.stringify(server.env, null, 2) : "",
      stripSystemPrompt: true,
    });
    setValidationResult(null);
    setActiveTab("manual");
  };

  const handleValidate = async () => {
    if (!formData.command.trim()) return;
    setValidating(true);
    setValidationResult(null);
    try {
      let customEnv = {};
      if (formData.envJson.trim()) {
        try {
          customEnv = JSON.parse(formData.envJson);
        } catch {
          setValidationResult({ valid: false, error: "Invalid JSON in Environment Variables" });
          setValidating(false);
          return;
        }
      }

      const res = await fetch("/api/provider-nodes/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "acp",
          command: formData.command,
          args: formData.args,
          env: customEnv,
        }),
      });
      const data = await res.json();
      setValidationResult(data);
    } catch (err) {
      setValidationResult({ valid: false, error: err.message });
    } finally {
      setValidating(false);
    }
  };

  const handleSubmit = async () => {
    if (!formData.name.trim() || !formData.prefix.trim() || !formData.command.trim()) return;
    setSubmitting(true);
    try {
      let customEnv = {};
      if (formData.envJson.trim()) {
        try {
          customEnv = JSON.parse(formData.envJson);
        } catch (e) {
          alert("Invalid environment variables JSON: " + e.message);
          setSubmitting(false);
          return;
        }
      }

      const res = await fetch("/api/provider-nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "acp",
          name: formData.name,
          prefix: formData.prefix,
          command: formData.command,
          args: formData.args,
          env: customEnv,
          defaultModel: formData.defaultModel,
          stripSystemPrompt: formData.stripSystemPrompt,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        onCreated(data.node);
        setFormData(initialFormData);
        setValidationResult(null);
        onClose();
      } else {
        alert(data.error || "Failed to create ACP provider node");
      }
    } catch (error) {
      console.log("Error creating ACP node:", error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title="Add ACP Provider (Agent Client Protocol)" onClose={onClose} size="lg">
      <div className="flex flex-col gap-4">
        {/* Navigation Tabs */}
        <div className="flex items-center gap-2 border-b border-border pb-2">
          <button
            type="button"
            onClick={() => setActiveTab("zed")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              activeTab === "zed"
                ? "bg-purple-500/10 text-purple-600 dark:text-purple-400 font-semibold"
                : "text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5"
            }`}
          >
            Import from Zed
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("manual")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              activeTab === "manual"
                ? "bg-purple-500/10 text-purple-600 dark:text-purple-400 font-semibold"
                : "text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5"
            }`}
          >
            Manual Configuration
          </button>
        </div>

        {/* Tab 1: Zed Import */}
        {activeTab === "zed" && (
          <div className="flex flex-col gap-3">
            {zedLoading && (
              <div className="py-8 text-center text-text-muted text-sm flex items-center justify-center gap-2">
                <span className="material-symbols-outlined animate-spin text-[18px]">progress_activity</span>
                <span>Scanning Zed settings.json...</span>
              </div>
            )}

            {!zedLoading && zedData && zedData.servers?.length > 0 && (
              <div className="flex flex-col gap-2.5">
                <p className="text-xs text-text-muted">
                  Found <span className="font-semibold text-text-main">{zedData.servers.length}</span> agent servers in{" "}
                  <code className="px-1.5 py-0.5 bg-black/5 dark:bg-white/5 rounded text-[11px] font-mono">{zedData.path}</code>:
                </p>
                <div className="flex flex-col gap-2">
                  {zedData.servers.map((srv) => (
                    <div
                      key={srv.id}
                      className="flex items-start justify-between gap-3 p-3 rounded-lg border border-border bg-surface/50 hover:bg-surface transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h4 className="font-semibold text-sm">{srv.name}</h4>
                          {srv.defaultModel && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-purple-500/10 text-purple-600 dark:text-purple-400 font-mono">
                              {srv.defaultModel}
                            </span>
                          )}
                        </div>
                        <p className="text-xs font-mono text-text-muted truncate mt-1">
                          {srv.command} {srv.args?.join(" ")}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => handleSelectZedServer(srv)}
                        className="shrink-0 !bg-purple-500/20 !border-purple-500/40 !text-purple-700 dark:!text-purple-300 hover:!bg-purple-500/30 text-xs"
                      >
                        Select & Configure
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!zedLoading && (!zedData || !zedData.servers || zedData.servers.length === 0) && (
              <div className="py-6 text-center text-text-muted text-sm border border-dashed border-border rounded-lg">
                <p>No agent servers found in Zed settings.</p>
                <button
                  type="button"
                  onClick={() => setActiveTab("manual")}
                  className="mt-2 text-primary hover:underline text-xs"
                >
                  Switch to manual configuration →
                </button>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Manual Config */}
        {activeTab === "manual" && (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                label="Provider Name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g. Antigravity, DeepSeek"
                hint="Required. Friendly label for dashboard."
              />
              <Input
                label="Prefix"
                value={formData.prefix}
                onChange={(e) => setFormData({ ...formData, prefix: e.target.value })}
                placeholder="e.g. acp-agy, acp-kiro"
                hint="Required. Routing prefix (acp-prefix/model-id)."
              />
            </div>

            <Input
              label="Executable Command"
              value={formData.command}
              onChange={(e) => setFormData({ ...formData, command: e.target.value })}
              placeholder="e.g. agy (auto-detected) or an absolute path"
              hint="Required. Path to the ACP binary or command."
            />

            <Input
              label="Arguments"
              value={formData.args}
              onChange={(e) => setFormData({ ...formData, args: e.target.value })}
              placeholder="e.g. acp --dangerously-skip-permissions"
              hint="Space-separated arguments passed to command."
            />

            <Input
              label="Default Model"
              value={formData.defaultModel}
              onChange={(e) => setFormData({ ...formData, defaultModel: e.target.value })}
              placeholder="e.g. gemini-3.8-flash"
              hint="Optional. Default model sent in session/new."
            />

            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-text-main">Environment Variables (JSON)</label>
              <textarea
                value={formData.envJson}
                onChange={(e) => setFormData({ ...formData, envJson: e.target.value })}
                placeholder='{"MY_ENV": "value"}'
                rows={2}
                className="w-full p-2 bg-surface rounded border border-border text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
            </div>

            <label className="flex items-start gap-2.5 cursor-pointer select-none pt-1">
              <input
                type="checkbox"
                checked={formData.stripSystemPrompt}
                onChange={(e) => setFormData({ ...formData, stripSystemPrompt: e.target.checked })}
                className="w-4 h-4 mt-0.5 rounded border-border accent-primary cursor-pointer shrink-0"
              />
              <div className="flex flex-col">
                <span className="text-xs font-semibold text-text-main">
                  Strip Client System Prompt (Recommended)
                </span>
                <span className="text-[11px] text-text-muted">
                  Ignore client system instructions (e.g. Zed coding agent instructions) to avoid conflicting with the ACP server&#39;s built-in persona and save tokens.
                </span>
              </div>
            </label>

            {/* Test Connection */}
            <div className="flex items-center justify-between pt-2 border-t border-border">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleValidate}
                  disabled={!formData.command.trim() || validating}
                  loading={validating}
                  icon="network_check"
                >
                  Test Stdio Handshake
                </Button>
                {validationResult && (
                  <div className="flex items-center gap-1.5 text-xs">
                    {validationResult.valid ? (
                      <span className="px-2 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400 font-medium flex items-center gap-1">
                        <span className="material-symbols-outlined text-[14px]">check_circle</span>
                        Valid: {validationResult.agentInfo?.name || "ACP Server"} {validationResult.agentInfo?.version || ""}
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded bg-red-500/10 text-red-600 dark:text-red-400 font-medium flex items-center gap-1">
                        <span className="material-symbols-outlined text-[14px]">error</span>
                        {validationResult.error}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Footer buttons */}
        <div className="flex justify-end gap-2 pt-3 border-t border-border">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            disabled={!formData.name.trim() || !formData.prefix.trim() || !formData.command.trim() || submitting}
            loading={submitting}
            className="!bg-purple-600 hover:!bg-purple-700 !text-white"
          >
            Create ACP Provider
          </Button>
        </div>
      </div>
    </Modal>
  );
}

AddAcpModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onCreated: PropTypes.func.isRequired,
};
