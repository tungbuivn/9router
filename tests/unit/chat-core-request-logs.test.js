import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import "../translator/registerAll.js";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
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

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const {
  listRequestLogs,
  getRequestLogById,
  flushRequestFileLogs,
} = await import("@/lib/requestFileLogger.js");

function makeAcpSseResponse(text = "Hello from ACP!") {
  const sse =
    `data: {"id":"chatcmpl-acp-1","object":"chat.completion.chunk","created":1,"model":"auto","choices":[{"index":0,"delta":{"role":"assistant","content":${JSON.stringify(text)}},"finish_reason":null}]}\n\n` +
    'data: {"id":"chatcmpl-acp-1","object":"chat.completion.chunk","created":1,"model":"auto","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";
  return {
    response: new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    responseFormat: "openai",
    url: "acp://stdio",
    headers: {},
    transformedBody: {
      model: "auto",
      command: "/home/tungbt/.local/bin/kiro-cli",
      args: ["acp"],
      stripSystemPrompt: true,
      prompt: "User: Hello ACP",
    },
  };
}

describe("handleChatCore disk-backed 4-stage request logging", () => {
  let tmpDir;
  let prevDir;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-chatcore-logs-"));
    prevDir = process.env.REQUEST_LOGS_DIR;
    process.env.REQUEST_LOGS_DIR = tmpDir;
  });

  afterEach(async () => {
    await flushRequestFileLogs();
    if (prevDir === undefined) delete process.env.REQUEST_LOGS_DIR;
    else process.env.REQUEST_LOGS_DIR = prevDir;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("logs received, beforeModify (with system), afterModify (system stripped + ACP prompt), and response (non-streaming forced SSE->JSON)", async () => {
    executeMock.mockResolvedValue(makeAcpSseResponse("OK from Kiro"));

    const rawBody = {
      model: "acp-kiro/auto",
      stream: false,
      messages: [
        { role: "system", content: "Zed huge system prompt" },
        { role: "user", content: "<system-reminder>Zed reminder</system-reminder>\n\nHello ACP" },
      ],
    };

    const result = await handleChatCore({
      body: { ...rawBody },
      modelInfo: { provider: "acp-534c09bf-73a1-4f79-9179-32aa492be711", model: "auto" },
      credentials: {
        connectionName: "Kiro (ACP Stdio)",
        providerSpecificData: { command: "kiro-cli", args: ["acp"], nodeName: "Kiro" },
      },
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        headers: { authorization: "Bearer sk-1234567890abcdef1234", "content-type": "application/json" },
        body: rawBody,
      },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn() },
      connectionId: "conn-kiro-1",
    });

    expect(result.success).toBe(true);
    await flushRequestFileLogs();

    const listed = await listRequestLogs();
    expect(listed.total).toBe(1);

    const logDoc = await getRequestLogById(listed.items[0].id);
    expect(logDoc).not.toBeNull();
    expect(logDoc.status).toBe("success");
    expect(logDoc.statusCode).toBe(200);

    // Stage 1: Received
    expect(logDoc.received.endpoint).toBe("/v1/chat/completions");
    expect(logDoc.received.headers.authorization).toBe("Bearer sk-123...1234");
    expect(logDoc.received.messageCount).toBe(2);

    // Stage 2: Before Modify (system message & reminder still intact!)
    expect(logDoc.beforeModify.messageCount).toBe(2);
    expect(logDoc.beforeModify.messages[0]).toEqual({ role: "system", content: "Zed huge system prompt" });
    expect(logDoc.beforeModify.messages[1].content).toContain("<system-reminder>");

    // Stage 3: After Modify (system stripped + ACP prompt captured!)
    expect(logDoc.afterModify.messageCount).toBe(1);
    expect(logDoc.afterModify.messages).toEqual([{ role: "user", content: "Hello ACP" }]);
    expect(logDoc.afterModify.transformations).toContain("ACP:NO-SYS");
    expect(logDoc.afterModify.executorPayload.prompt).toBe("User: Hello ACP");

    // Stage 4: Response
    expect(logDoc.response.statusCode).toBe(200);
    expect(logDoc.response.content).toBe("OK from Kiro");
    expect(logDoc.response.clientResponse.choices[0].message.content).toBe("OK from Kiro");
  });

  it("logs streaming completion content on disk once stream finishes", async () => {
    executeMock.mockResolvedValue(makeAcpSseResponse("Streamed answer"));

    const result = await handleChatCore({
      body: {
        model: "acp-kiro/auto",
        stream: true,
        messages: [{ role: "user", content: "Stream test" }],
      },
      modelInfo: { provider: "acp-534c09bf-73a1-4f79-9179-32aa492be711", model: "auto" },
      credentials: {
        connectionName: "Kiro (ACP Stdio)",
        providerSpecificData: { command: "kiro-cli", args: ["acp"], nodeName: "Kiro" },
      },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn() },
      connectionId: "conn-kiro-1",
    });

    expect(result.success).toBe(true);
    // Drain the stream completely so onStreamComplete fires
    const text = await result.response.text();
    expect(text).toContain("Streamed answer");

    await flushRequestFileLogs();

    const listed = await listRequestLogs();
    expect(listed.total).toBe(1);
    const logDoc = await getRequestLogById(listed.items[0].id);
    expect(logDoc.status).toBe("success");
    expect(logDoc.response.type).toBe("streaming");
    expect(logDoc.response.content).toBe("Streamed answer");
  });

  it("logs upstream error status and error message in Stage 4", async () => {
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({ error: { message: "Upstream rate limit" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
      responseFormat: "openai",
      url: "https://api.example.com/v1/chat/completions",
      headers: { authorization: "Bearer secret-upstream-token-9999" },
      transformedBody: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });

    const result = await handleChatCore({
      body: { model: "openai/gpt-4o", stream: false, messages: [{ role: "user", content: "hi" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "sk-test" },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn(), errorLine: vi.fn() },
      connectionId: "openai-1",
    });

    expect(result.success).toBe(false);
    await flushRequestFileLogs();

    const listed = await listRequestLogs();
    expect(listed.total).toBe(1);
    const logDoc = await getRequestLogById(listed.items[0].id);
    expect(logDoc.status).toBe("error");
    expect(logDoc.statusCode).toBe(429);
    expect(logDoc.afterModify.providerHeaders.authorization).toBe("Bearer secret...9999");
    expect(logDoc.response.error).toContain("Upstream rate limit");
  });
});
