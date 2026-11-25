import { describe, it, expect, beforeEach, vi } from "vitest";
import { mergeAnthropicBeta } from "open-sse/providers/shared.js";
import { upstreamResponseHeaders } from "open-sse/utils/upstreamHeaders.js";
import { createErrorResult, unavailableResponse } from "open-sse/utils/error.js";

const betaFlags = (headers) => (headers["Anthropic-Beta"] || "").split(",").map((s) => s.trim()).filter(Boolean);

describe("mergeAnthropicBeta", () => {
  it("unions and dedupes comma lists, ignoring blanks", () => {
    expect(mergeAnthropicBeta("a,b", " b , c ,", undefined, "")).toBe("a,b,c");
  });
});

describe("DefaultExecutor.buildHeaders() forwards client anthropic-beta", () => {
  let DefaultExecutor;

  beforeEach(async () => {
    vi.resetModules();
    ({ DefaultExecutor } = await import("open-sse/executors/default.js"));
  });

  it("keeps unknown client flags alongside the pinned set on claude", () => {
    const executor = new DefaultExecutor("claude");
    const rawHeaders = { "anthropic-beta": "safeguards-2026-09-01,context-1m-2025-08-07" };
    const flags = betaFlags(executor.buildHeaders({ apiKey: "k", rawHeaders }, true, undefined, "claude-opus-5"));
    expect(flags).toContain("safeguards-2026-09-01");
    expect(flags).toContain("context-1m-2025-08-07");
    expect(flags).toContain("context-management-2025-06-27");
    expect(new Set(flags).size).toBe(flags.length);
  });

  it("forwards client flags on anthropic-compatible Claude models", () => {
    const executor = new DefaultExecutor("anthropic-compatible-custom");
    const creds = { apiKey: "k", rawHeaders: { "anthropic-beta": "safeguards-2026-09-01" }, providerSpecificData: { baseUrl: "https://gw.example.com/v1" } };
    const flags = betaFlags(executor.buildHeaders(creds, true, undefined, "claude-sonnet-5"));
    expect(flags).toContain("safeguards-2026-09-01");
    expect(flags).not.toContain("claude-code-20250219");
  });

  it("forwards client flags on the anthropic provider", () => {
    const executor = new DefaultExecutor("anthropic");
    const flags = betaFlags(executor.buildHeaders({ apiKey: "k", rawHeaders: { "anthropic-beta": "safeguards-2026-09-01" } }, true, undefined, "claude-sonnet-5"));
    expect(flags).toContain("safeguards-2026-09-01");
  });

  it("adds dangerous-tool-use-2026-09-03 when body carries safeguards", () => {
    const executor = new DefaultExecutor("claude");
    const body = {
      model: "claude-sonnet-5",
      safeguards: [{ type: "dangerous_tool_use", classifier_context: { permission_mode: "auto" } }]
    };
    const flags = betaFlags(executor.buildHeaders({ apiKey: "k" }, true, undefined, "claude-sonnet-5", body));
    expect(flags).toContain("dangerous-tool-use-2026-09-03");
  });
});

describe("auto-mode safeguards passthrough and synthesis", () => {
  it("keeps safeguards in prepareClaudeRequest for Anthropic providers", async () => {
    const { prepareClaudeRequest } = await import("open-sse/translator/formats/claude.js");
    const body = {
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      safeguards: [{ type: "dangerous_tool_use" }],
      context_management: { edits: [] },
    };
    const claudeOut = prepareClaudeRequest(structuredClone(body), "claude");
    expect(claudeOut.safeguards).toBeDefined();
    expect(claudeOut.context_management).toBeDefined();

    const anthropicOut = prepareClaudeRequest(structuredClone(body), "anthropic");
    expect(anthropicOut.safeguards).toBeDefined();
    expect(anthropicOut.context_management).toBeDefined();
  });

  it("strips safeguards in prepareClaudeRequest for non-Anthropic providers", async () => {
    const { prepareClaudeRequest } = await import("open-sse/translator/formats/claude.js");
    const body = {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "hi" }],
      safeguards: [{ type: "dangerous_tool_use" }],
      context_management: { edits: [] },
    };
    const out = prepareClaudeRequest(structuredClone(body), "deepseek");
    expect(out.safeguards).toBeUndefined();
    expect(out.context_management).toBeUndefined();
  });

  it("synthesizes safeguard_results for non-streaming OpenAI to Claude translation", async () => {
    const { openAICompletionToClaudeMessage } = await import("open-sse/translator/concerns/claudeMessage.js");
    const response = {
      id: "chatcmpl-123",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "done",
          tool_calls: [{ id: "call_1", function: { name: "Bash", arguments: "{\"command\":\"ls\"}" } }]
        },
        finish_reason: "tool_calls"
      }]
    };
    const requestBody = { safeguards: [{ type: "dangerous_tool_use" }] };
    const result = openAICompletionToClaudeMessage(response, requestBody);
    expect(result.safeguard_results).toBeDefined();
    expect(result.safeguard_results[0].type).toBe("dangerous_tool_use");
    expect(result.safeguard_results[0].status.type).toBe("available");
    expect(result.safeguard_results[0].status.tool_uses.call_1).toEqual({ type: "evaluated", outcome: "not_flagged" });
  });

  it("synthesizes safeguard_results in streaming message_delta for OpenAI to Claude translation", async () => {
    const { openaiToClaudeResponse } = await import("open-sse/translator/response/openai-to-claude.js");
    const state = {
      hasSafeguards: true,
      toolCalls: new Map([
        [0, { id: "call_abc", name: "Bash", blockIndex: 0 }]
      ]),
      usage: { input_tokens: 10, output_tokens: 20 },
    };
    const finishChunk = {
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
    };
    const results = openaiToClaudeResponse(finishChunk, state);
    const deltaEvent = results.find(r => r.type === "message_delta");
    expect(deltaEvent).toBeDefined();
    expect(deltaEvent.delta.safeguard_results).toBeDefined();
    expect(deltaEvent.delta.safeguard_results[0].status.tool_uses.call_abc).toEqual({
      type: "evaluated",
      outcome: "not_flagged"
    });
  });
});

describe("upstream response header forwarding", () => {
  const upstream = new Headers({
    "retry-after": "12",
    "x-should-retry": "false",
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-reset": "1790000000",
    "set-cookie": "secret=1",
    "content-length": "99",
  });

  it("picks only retry and ratelimit headers", () => {
    expect(upstreamResponseHeaders(upstream)).toEqual({
      "retry-after": "12",
      "x-should-retry": "false",
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": "1790000000",
    });
    expect(upstreamResponseHeaders(undefined)).toEqual({});
  });

  it("attaches them to error results", () => {
    const { response } = createErrorResult(429, "limited", undefined, upstreamResponseHeaders(upstream));
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(response.headers.get("anthropic-ratelimit-unified-status")).toBe("rejected");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("keeps the gateway retry-after on all-accounts-limited responses", () => {
    const retryAt = new Date(Date.now() + 30000).toISOString();
    const res = unavailableResponse(503, "busy", retryAt, "30s", upstreamResponseHeaders(upstream));
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(20);
    expect(res.headers.get("anthropic-ratelimit-unified-reset")).toBe("1790000000");
  });
});
