"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Button, Input, Modal } from "@/shared/components";

export default function EditAcpNodeModal({ isOpen, node, onSave, onClose }) {
  const [formData, setFormData] = useState({
    name: "",
    prefix: "",
    command: "",
    args: "",
    defaultModel: "",
    envJson: "",
    stripSystemPrompt: true,
  });
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);

  useEffect(() => {
    if (node) {
      setFormData({
        name: node.name || "",
        prefix: node.prefix || "",
        command: node.command || "",
        args: Array.isArray(node.args) ? node.args.join(" ") : "",
        defaultModel: node.defaultConfigOptions?.model || node.defaultModel || "",
        envJson: node.env && Object.keys(node.env).length > 0 ? JSON.stringify(node.env, null, 2) : "",
        stripSystemPrompt: node.stripSystemPrompt !== false,
      });
      setValidationResult(null);
    }
  }, [node]);

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
    setSaving(true);
    try {
      let customEnv = {};
      if (formData.envJson.trim()) {
        try {
          customEnv = JSON.parse(formData.envJson);
        } catch (e) {
          alert("Invalid environment variables JSON: " + e.message);
          setSaving(false);
          return;
        }
      }

      const payload = {
        name: formData.name,
        prefix: formData.prefix,
        command: formData.command,
        args: formData.args,
        env: customEnv,
        defaultModel: formData.defaultModel,
        stripSystemPrompt: formData.stripSystemPrompt,
      };
      await onSave(payload);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title="Edit ACP Server Configuration" onClose={onClose} size="lg">
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input
            label="Provider Name"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            placeholder="e.g. Antigravity"
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
        />

        <Input
          label="Arguments"
          value={formData.args}
          onChange={(e) => setFormData({ ...formData, args: e.target.value })}
          placeholder="e.g. acp --dangerously-skip-permissions"
        />

        <Input
          label="Default Model"
          value={formData.defaultModel}
          onChange={(e) => setFormData({ ...formData, defaultModel: e.target.value })}
          placeholder="e.g. gemini-3.8-flash"
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
              Test Handshake
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
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSubmit}
              disabled={!formData.name.trim() || !formData.prefix.trim() || !formData.command.trim() || saving}
              loading={saving}
              className="!bg-purple-600 hover:!bg-purple-700 !text-white"
            >
              Save Changes
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

EditAcpNodeModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  node: PropTypes.object,
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
