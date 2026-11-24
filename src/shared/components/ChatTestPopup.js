"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

function readAssistantText(chunk) {
  if (!chunk || typeof chunk !== "object") return "";
  const choice = chunk.choices?.[0];
  const delta = choice?.delta || {};
  const pieces = [
    delta.content,
    choice?.message?.content,
    delta.reasoning_content,
    chunk.output_text,
    chunk.text,
  ].filter(Boolean);
  return pieces.join("");
}

export default function ChatTestPopup({ isOpen, onClose }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showOptions, setShowOptions] = useState(false);

  // Model selection state
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [showModelDropdown, setShowModelDropdown] = useState(false);

  // Chat options
  const [systemPrompt, setSystemPrompt] = useState("You are a helpful AI assistant.");
  const [temperature, setTemperature] = useState(0.7);
  const [useStream, setUseStream] = useState(true);

  // Conversation state
  const [messages, setMessages] = useState([
    {
      id: "init",
      role: "assistant",
      content: "👋 Hello! Select a model and test chat features, streaming, or quick prompts below.",
    },
  ]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [latencyMs, setLatencyMs] = useState(null);
  const [copiedId, setCopiedId] = useState(null);

  const abortControllerRef = useRef(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const dropdownRef = useRef(null);

  // Auto-scroll messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowModelDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Fetch models
  useEffect(() => {
    if (!isOpen) return;

    let mounted = true;
    setLoadingModels(true);

    fetch("/api/v1/models")
      .then((res) => res.json())
      .then((data) => {
        if (!mounted) return;
        const list = Array.isArray(data?.data)
          ? data.data.map((m) => m.id).filter(Boolean)
          : [];
        setModels(list);

        // Pre-select first model if none selected
        if (list.length > 0 && !selectedModel) {
          // Prefer gemini, gpt, claude, or first model
          const preferred =
            list.find((m) => m.includes("gemini") || m.includes("gpt") || m.includes("claude") || m.includes("agy")) ||
            list[0];
          setSelectedModel(preferred);
        }
      })
      .catch((err) => {
        console.warn("Failed to fetch models for chat test:", err);
      })
      .finally(() => {
        if (mounted) setLoadingModels(false);
      });

    return () => {
      mounted = false;
    };
  }, [isOpen]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Filtered models
  const filteredModels = useMemo(() => {
    if (!modelSearch) return models;
    const q = modelSearch.toLowerCase();
    return models.filter((m) => m.toLowerCase().includes(q));
  }, [models, modelSearch]);

  const handleSend = async (textToSend) => {
    const text = (textToSend || input).trim();
    if (!text || isStreaming) return;

    const currentModel = selectedModel || "gpt-4o";
    const userMsg = { id: `u_${Date.now()}`, role: "user", content: text };
    const assistantId = `a_${Date.now()}`;
    const assistantMsg = { id: assistantId, role: "assistant", content: "", status: "streaming" };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput("");
    setIsStreaming(true);
    setLatencyMs(null);

    const startTime = Date.now();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const requestMessages = [];
    if (systemPrompt.trim()) {
      requestMessages.push({ role: "system", content: systemPrompt.trim() });
    }
    for (const m of messages) {
      if (m.id === "init") continue;
      requestMessages.push({ role: m.role, content: m.content });
    }
    requestMessages.push({ role: "user", content: text });

    try {
      const res = await fetch("/api/dashboard/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: useStream ? "text/event-stream" : "application/json",
        },
        body: JSON.stringify({
          model: currentModel,
          messages: requestMessages,
          stream: useStream,
          temperature: parseFloat(temperature) || 0.7,
        }),
        signal: abortController.signal,
      });

      setLatencyMs(Date.now() - startTime);

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error?.message || errorData.message || `Request failed with status ${res.status}`);
      }

      if (useStream && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accumulated = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;

            try {
              const chunk = JSON.parse(payload);
              const piece = readAssistantText(chunk);
              if (piece) {
                accumulated += piece;
                setMessages((prev) =>
                  prev.map((msg) => (msg.id === assistantId ? { ...msg, content: accumulated } : msg))
                );
              }
            } catch {}
          }
        }

        setMessages((prev) =>
          prev.map((msg) => (msg.id === assistantId ? { ...msg, status: "done" } : msg))
        );
      } else {
        const data = await res.json();
        const fullContent =
          data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || JSON.stringify(data);
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantId ? { ...msg, content: fullContent, status: "done" } : msg
          )
        );
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantId
              ? { ...msg, content: `❌ Error: ${err.message}`, status: "error" }
              : msg
          )
        );
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsStreaming(false);
    }
  };

  const handleClear = () => {
    handleStop();
    setMessages([
      {
        id: "init",
        role: "assistant",
        content: "👋 Chat cleared. Ready for the next test!",
      },
    ]);
    setLatencyMs(null);
  };

  const handleCopy = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  if (!isOpen) return null;

  return (
    <div
      className={`fixed top-14 right-4 z-[75] flex flex-col rounded-2xl border border-border bg-surface/95 shadow-2xl backdrop-blur-md transition-all duration-200 overflow-hidden ${
        isExpanded
          ? "w-[min(94vw,680px)] h-[min(88vh,780px)]"
          : "w-[min(94vw,440px)] h-[min(82vh,600px)]"
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border bg-surface-hover/30 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="size-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[18px]">chat</span>
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text-main truncate">Test Chat API</h3>
            <p className="text-[11px] text-text-muted truncate">
              {selectedModel ? selectedModel : "Select a model"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {latencyMs !== null && (
            <span className="text-[11px] font-mono text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-full mr-1">
              ⚡ {latencyMs}ms
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowOptions((v) => !v)}
            className={`p-1.5 rounded-lg text-text-muted hover:text-text-main hover:bg-surface-hover transition-colors ${
              showOptions ? "bg-primary/15 text-primary" : ""
            }`}
            title="Model & Prompt Parameters"
          >
            <span className="material-symbols-outlined text-[18px]">tune</span>
          </button>
          <button
            type="button"
            onClick={handleClear}
            className="p-1.5 rounded-lg text-text-muted hover:text-text-main hover:bg-surface-hover transition-colors"
            title="Clear Chat"
          >
            <span className="material-symbols-outlined text-[18px]">delete_sweep</span>
          </button>
          <button
            type="button"
            onClick={() => setIsExpanded((v) => !v)}
            className="p-1.5 rounded-lg text-text-muted hover:text-text-main hover:bg-surface-hover transition-colors hidden sm:inline-flex"
            title={isExpanded ? "Collapse" : "Expand"}
          >
            <span className="material-symbols-outlined text-[18px]">
              {isExpanded ? "close_fullscreen" : "open_in_full"}
            </span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors"
            title="Close"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      </div>

      {/* Model Selector Bar */}
      <div className="px-3.5 py-2 border-b border-border bg-bg/50 shrink-0 relative" ref={dropdownRef}>
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <button
              type="button"
              onClick={() => setShowModelDropdown((v) => !v)}
              className="w-full flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg border border-border bg-surface text-left text-xs font-medium text-text-main hover:border-primary/50 transition-colors"
            >
              <div className="flex items-center gap-2 truncate">
                <span className="material-symbols-outlined text-[15px] text-primary shrink-0">
                  smart_toy
                </span>
                <span className="truncate">{selectedModel || "Select Model..."}</span>
              </div>
              <span className="material-symbols-outlined text-[16px] text-text-muted shrink-0">
                {showModelDropdown ? "expand_less" : "expand_more"}
              </span>
            </button>

            {/* Model Dropdown Menu */}
            {showModelDropdown && (
              <div className="absolute left-0 top-full mt-1 w-full max-h-60 rounded-xl border border-border bg-surface shadow-xl z-50 flex flex-col overflow-hidden">
                <div className="p-2 border-b border-border">
                  <input
                    type="text"
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    placeholder="Search or enter model..."
                    className="w-full px-2.5 py-1 text-xs rounded-md border border-border bg-bg text-text-main focus:outline-none focus:border-primary"
                    autoFocus
                  />
                </div>
                <div className="overflow-y-auto max-h-48 p-1 custom-scrollbar">
                  {modelSearch && !filteredModels.includes(modelSearch) && (
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedModel(modelSearch);
                        setShowModelDropdown(false);
                      }}
                      className="w-full text-left px-2.5 py-1.5 rounded-md text-xs font-mono text-primary hover:bg-primary/10 transition-colors flex items-center gap-1.5"
                    >
                      <span className="material-symbols-outlined text-[14px]">add</span>
                      Use custom: &quot;{modelSearch}&quot;
                    </button>
                  )}
                  {loadingModels ? (
                    <div className="p-3 text-center text-xs text-text-muted">Loading models...</div>
                  ) : filteredModels.length === 0 ? (
                    <div className="p-3 text-center text-xs text-text-muted">No models found</div>
                  ) : (
                    filteredModels.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => {
                          setSelectedModel(m);
                          setShowModelDropdown(false);
                        }}
                        className={`w-full text-left px-2.5 py-1.5 rounded-md text-xs font-mono truncate transition-colors flex items-center justify-between ${
                          selectedModel === m
                            ? "bg-primary/15 text-primary font-semibold"
                            : "text-text-main hover:bg-surface-hover"
                        }`}
                      >
                        <span className="truncate">{m}</span>
                        {selectedModel === m && (
                          <span className="material-symbols-outlined text-[14px]">check</span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              setLoadingModels(true);
              fetch("/api/v1/models")
                .then((r) => r.json())
                .then((d) => setModels(Array.isArray(d?.data) ? d.data.map((m) => m.id).filter(Boolean) : []))
                .finally(() => setLoadingModels(false));
            }}
            className="p-1.5 rounded-lg border border-border hover:bg-surface-hover text-text-muted hover:text-text-main transition-colors shrink-0"
            title="Refresh Models"
          >
            <span className={`material-symbols-outlined text-[16px] ${loadingModels ? "animate-spin" : ""}`}>
              refresh
            </span>
          </button>
        </div>

        {/* Quick Test Prompt Chips */}
        <div className="flex items-center gap-1.5 mt-2 overflow-x-auto no-scrollbar pb-0.5">
          <button
            type="button"
            onClick={() => handleSend("Hello! Who are you and what are your capabilities?")}
            disabled={isStreaming}
            className="shrink-0 text-[11px] px-2.5 py-0.5 rounded-full border border-border bg-surface text-text-muted hover:text-text-main hover:border-primary/40 transition-colors"
          >
            👋 Hello
          </button>
          <button
            type="button"
            onClick={() => handleSend("Count from 1 to 5, one number per line.")}
            disabled={isStreaming}
            className="shrink-0 text-[11px] px-2.5 py-0.5 rounded-full border border-border bg-surface text-text-muted hover:text-text-main hover:border-primary/40 transition-colors"
          >
            ⚡ Stream
          </button>
          <button
            type="button"
            onClick={() => handleSend("Return a JSON object with keys: status ('ok'), model (your model name), time.")}
            disabled={isStreaming}
            className="shrink-0 text-[11px] px-2.5 py-0.5 rounded-full border border-border bg-surface text-text-muted hover:text-text-main hover:border-primary/40 transition-colors"
          >
            📋 JSON
          </button>
          <button
            type="button"
            onClick={() => handleSend("Write a quick Python palindrome function with a markdown code block.")}
            disabled={isStreaming}
            className="shrink-0 text-[11px] px-2.5 py-0.5 rounded-full border border-border bg-surface text-text-muted hover:text-text-main hover:border-primary/40 transition-colors"
          >
            💻 Code
          </button>
        </div>
      </div>

      {/* Expandable Parameters Drawer */}
      {showOptions && (
        <div className="p-3 border-b border-border bg-bg/80 space-y-2.5 text-xs shrink-0 animate-in slide-in-from-top-2 duration-150">
          <div>
            <label className="block text-[11px] font-medium text-text-muted mb-1">
              System Prompt
            </label>
            <input
              type="text"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="System prompt..."
              className="w-full px-2.5 py-1 text-xs rounded-md border border-border bg-surface text-text-main focus:outline-none focus:border-primary"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <label className="text-[11px] font-medium text-text-muted">Stream:</label>
              <button
                type="button"
                onClick={() => setUseStream((v) => !v)}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                  useStream ? "bg-primary" : "bg-neutral-600"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    useStream ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </button>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-[11px] font-medium text-text-muted">Temperature:</label>
              <input
                type="number"
                min="0"
                max="2"
                step="0.1"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                className="w-16 px-2 py-0.5 text-xs rounded border border-border bg-surface text-text-main focus:outline-none focus:border-primary text-center font-mono"
              />
            </div>
          </div>
        </div>
      )}

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto p-3.5 space-y-3 custom-scrollbar">
        {messages.map((m) => {
          const isUser = m.role === "user";
          return (
            <div
              key={m.id}
              className={`flex flex-col ${isUser ? "items-end" : "items-start"} text-xs`}
            >
              <div className="flex items-center gap-1.5 mb-1 px-1 text-[11px] text-text-muted">
                <span className="font-medium">
                  {isUser ? "You" : selectedModel ? selectedModel.split("/").pop() : "Assistant"}
                </span>
                {!isUser && m.content && (
                  <button
                    type="button"
                    onClick={() => handleCopy(m.content, m.id)}
                    className="text-text-muted hover:text-text-main p-0.5 transition-colors"
                    title="Copy response"
                  >
                    <span className="material-symbols-outlined text-[13px]">
                      {copiedId === m.id ? "check" : "content_copy"}
                    </span>
                  </button>
                )}
              </div>

              <div
                className={`rounded-2xl px-3.5 py-2.5 max-w-[88%] break-words leading-relaxed ${
                  isUser
                    ? "bg-primary text-primary-foreground font-normal rounded-tr-sm"
                    : "bg-surface-hover/70 text-text-main border border-border rounded-tl-sm"
                }`}
              >
                {isUser ? (
                  <p className="whitespace-pre-wrap">{m.content}</p>
                ) : (
                  <div
                    className="prose prose-invert prose-xs max-w-none text-xs leading-relaxed"
                    dangerouslySetInnerHTML={{
                      __html: marked.parse(m.content || (m.status === "streaming" ? "..." : "")),
                    }}
                  />
                )}
                {m.status === "streaming" && isStreaming && (
                  <span className="inline-block w-1.5 h-3.5 bg-primary ml-1 animate-pulse align-middle" />
                )}
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="p-3 border-t border-border bg-surface shrink-0">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="flex items-end gap-2"
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Type message... (Enter to send, Shift+Enter for newline)"
            rows={2}
            className="flex-1 max-h-24 resize-none rounded-xl border border-border bg-bg/60 p-2.5 text-xs text-text-main placeholder:text-text-muted focus:outline-none focus:border-primary/50 custom-scrollbar"
          />

          <div className="shrink-0 flex items-center gap-1">
            {isStreaming ? (
              <button
                type="button"
                onClick={handleStop}
                className="size-9 rounded-xl bg-red-500/20 text-red-500 hover:bg-red-500/30 flex items-center justify-center transition-colors"
                title="Stop streaming"
              >
                <span className="material-symbols-outlined text-[18px]">stop</span>
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className={`size-9 rounded-xl flex items-center justify-center transition-colors ${
                  input.trim()
                    ? "bg-primary text-primary-foreground hover:opacity-90"
                    : "bg-surface-hover text-text-muted cursor-not-allowed"
                }`}
                title="Send"
              >
                <span className="material-symbols-outlined text-[18px]">arrow_upward</span>
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
