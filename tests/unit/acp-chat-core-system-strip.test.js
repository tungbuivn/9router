import { describe, it, expect, vi, beforeEach } from "vitest";
import "../translator/registerAll.js";

const { executeMock, passthroughSpy } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  passthroughSpy: vi.fn(() => new TransformStream()),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: passthroughSpy,
  createSSETransformStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

vi.mock("@/lib/requestFileLogger.js", () => ({
  createRequestLog: vi.fn(async () => ({ id: "test-log-id", filename: "test-log-id.json" })),
  updateRequestLogStage: vi.fn(async () => null),
  extractMessagesView: vi.fn(() => ({ system: null, messages: [], messageCount: 0 })),
  safeClone: (v) => v,
  maskHeaders: (h) => h || {},
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

function makeSseOk() {
  const sse =
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gemini-3.8-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n' +
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gemini-3.8-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";
  return {
    response: new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    responseFormat: "openai",
    url: "acp://stdio",
    headers: {},
    transformedBody: { model: "gemini-3.8-flash", stripSystemPrompt: true },
  };
}

describe("handleChatCore ACP-only system message stripping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue(makeSseOk());
  });

  it("strips system messages, embedded system tags, and skips 9router system injectors ONLY for ACP", async () => {
    const sharedMessages = [
      { role: "system", content: "You are Zed AI coding assistant... HUGE PROMPT" },
      { role: "developer", content: "Developer rules" },
      {
        role: "user",
        content: "<system-reminder>Zed reminder</system-reminder>\n\nHello ACP",
      },
    ];
    const callerBody = {
      model: "agy/gemini-3.8-flash",
      stream: true,
      tools: [
        { type: "function", function: { name: "bash", description: "run cmd", parameters: { type: "object" } } },
        { type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
      messages: sharedMessages,
    };

    const result = await handleChatCore({
      body: { ...callerBody },
      modelInfo: { provider: "acp-04c81b1f-7b01-4eb7-9c3c-d21d124943da", model: "gemini-3.8-flash" },
      credentials: { providerSpecificData: { command: "agy", args: ["acp"] } },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn() },
      connectionId: "acp-conn-1",
      cavemanEnabled: true,
      cavemanLevel: "full",
      ponytailEnabled: true,
      ponytailLevel: "full",
      customPromptEnabled: true,
      customPrompt: "CUSTOM SYSTEM INJECTION",
      reaAllowEnabled: true,
    });

    expect(result.success).toBe(true);
    expect(executeMock).toHaveBeenCalledTimes(1);

    const dispatchedBody = executeMock.mock.calls[0][0].body;
    expect(dispatchedBody.messages).toEqual([
      { role: "user", content: "Hello ACP" },
    ]);
    expect(dispatchedBody.tools).toBeUndefined();
    expect(dispatchedBody.tool_choice).toBeUndefined();
    expect(dispatchedBody.parallel_tool_calls).toBeUndefined();

    // Token estimation body passed to passthrough stream also has system & tools stripped
    const streamBodyArg = passthroughSpy.mock.calls[0][4];
    expect(streamBodyArg.messages).toEqual([
      { role: "user", content: "Hello ACP" },
    ]);
    expect(streamBodyArg.tools).toBeUndefined();

    // Caller's original messages & tools arrays were NOT mutated (safe for combo fallback)
    expect(sharedMessages).toHaveLength(3);
    expect(sharedMessages[0].role).toBe("system");
    expect(sharedMessages[2].content).toContain("<system-reminder>");
    expect(callerBody.tools).toHaveLength(2);
  });

  it("strips Claude top-level system and mid-conversation system turns BEFORE claude-to-openai translation on ACP", async () => {
    const result = await handleChatCore({
      body: {
        model: "agy/gemini-3.8-flash",
        stream: true,
        max_tokens: 1024,
        system: "Claude system prompt",
        messages: [
          { role: "user", content: "First question" },
          { role: "system", content: "Mid-conversation system rule that must not become <instructions>" },
          { role: "user", content: "Second question" },
        ],
      },
      modelInfo: { provider: "acp-04c81b1f-7b01-4eb7-9c3c-d21d124943da", model: "gemini-3.8-flash" },
      credentials: { providerSpecificData: { command: "agy", args: ["acp"] } },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      connectionId: "acp-conn-1",
      sourceFormatOverride: "claude",
    });

    expect(result.success).toBe(true);
    const dispatchedBody = executeMock.mock.calls[0][0].body;
    const serialized = JSON.stringify(dispatchedBody);
    expect(serialized).not.toContain("Claude system prompt");
    expect(serialized).not.toContain("Mid-conversation system rule");
    expect(serialized).not.toContain("<instructions>");
    expect(serialized).toContain("First question");
    expect(serialized).toContain("Second question");
  });

  it("preserves ALL system messages, tools, and injectors for non-ACP providers", async () => {
    const result = await handleChatCore({
      body: {
        model: "gpt-4o",
        stream: true,
        tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
        messages: [
          { role: "system", content: "You are Zed AI coding assistant" },
          { role: "user", content: "<system-reminder>Keep for non-ACP</system-reminder>\n\nHello OpenAI" },
        ],
      },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "sk-test", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      connectionId: "openai-conn-1",
      customPromptEnabled: true,
      customPrompt: "CUSTOM SYSTEM INJECTION",
    });

    expect(result.success).toBe(true);
    const dispatchedBody = executeMock.mock.calls[0][0].body;
    const serialized = JSON.stringify(dispatchedBody);
    expect(serialized).toContain("You are Zed AI coding assistant");
    expect(serialized).toContain("<system-reminder>Keep for non-ACP</system-reminder>");
    expect(serialized).toContain("CUSTOM SYSTEM INJECTION");
    expect(dispatchedBody.tools).toHaveLength(1);
  });

  it("respects ACP stripSystemPrompt: false opt-out", async () => {
    const result = await handleChatCore({
      body: {
        model: "agy/gemini-3.8-flash",
        stream: true,
        messages: [
          { role: "system", content: "Keep when opted out" },
          { role: "user", content: "Hello" },
        ],
      },
      modelInfo: { provider: "acp-04c81b1f-7b01-4eb7-9c3c-d21d124943da", model: "gemini-3.8-flash" },
      credentials: { providerSpecificData: { command: "agy", args: ["acp"], stripSystemPrompt: false } },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      connectionId: "acp-conn-1",
    });

    expect(result.success).toBe(true);
    const dispatchedBody = executeMock.mock.calls[0][0].body;
    expect(dispatchedBody.messages[0]).toEqual({ role: "system", content: "Keep when opted out" });
  });
});
