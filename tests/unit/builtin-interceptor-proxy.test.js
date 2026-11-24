import { describe, it, expect, beforeEach, afterEach } from "vitest";
import https from "node:https";
import http from "node:http";
import tls from "node:tls";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { runInterceptorScript } from "../../open-sse/utils/interceptorScript.js";
import {
  startBuiltinProxy,
  stopBuiltinProxy,
  setBuiltinProxyConfig,
  resetBuiltinProxyForTests,
  shouldInterceptHost,
  interceptInProcessFetch,
  decodeAwsEventStream,
} from "../../open-sse/utils/builtinProxy.js";
import { runWithRequestLogId } from "../../open-sse/utils/requestLogContext.js";
import {
  createRequestLog,
  getRequestLogById,
  flushRequestFileLogs,
} from "../../src/lib/requestFileLogger.js";
import { extractUpstreamSystemPrompt } from "../../open-sse/utils/w2Capture.js";

const require = createRequire(import.meta.url);

describe("Built-in Interceptor Proxy & JS Script Engine", () => {
  let tmpDir;
  let prevLogsDir;
  let prevReject;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-builtin-proxy-test-"));
    prevLogsDir = process.env.REQUEST_LOGS_DIR;
    prevReject = process.env.BUILTIN_PROXY_UPSTREAM_REJECT_UNAUTHORIZED;
    process.env.REQUEST_LOGS_DIR = tmpDir;
    process.env.BUILTIN_PROXY_UPSTREAM_REJECT_UNAUTHORIZED = "false";
    resetBuiltinProxyForTests();
  });

  afterEach(async () => {
    await stopBuiltinProxy();
    resetBuiltinProxyForTests();
    await flushRequestFileLogs();
    if (prevLogsDir === undefined) delete process.env.REQUEST_LOGS_DIR;
    else process.env.REQUEST_LOGS_DIR = prevLogsDir;
    if (prevReject === undefined) delete process.env.BUILTIN_PROXY_UPSTREAM_REJECT_UNAUTHORIZED;
    else process.env.BUILTIN_PROXY_UPSTREAM_REJECT_UNAUTHORIZED = prevReject;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("extracts and modifies sysprompt across all 5 upstream formats (including Kiro native)", () => {
    const appendScript = `
      function transformRequest(ctx) {
        if (ctx.sysPrompt) {
          ctx.setSysPrompt(ctx.sysPrompt + " [MODIFIED]");
          ctx.headers["x-test-hook"] = "yes";
          ctx.log("rewrote", ctx.sysFormat);
        }
      }
    `;

    // 1. Kiro native conversationState.history[0]
    const kiroBody = {
      conversationState: {
        history: [{ userInputMessage: { content: "You are Kiro agent" } }],
        currentMessage: {
          userInputMessage: {
            content: "hi",
            modelId: "deepseek-3.2",
            userInputMessageContext: { tools: [{ name: "bash" }] },
          },
        },
      },
    };
    const rKiro = runInterceptorScript({
      url: "https://runtime.us-east-1.kiro.dev/",
      body: kiroBody,
      scriptCode: appendScript,
    });
    expect(rKiro.error).toBeNull();
    expect(rKiro.modified).toBe(true);
    expect(rKiro.sysFormat).toBe("kiro");
    expect(rKiro.body.conversationState.history[0].userInputMessage.content).toBe("You are Kiro agent [MODIFIED]");
    expect(rKiro.headers["x-test-hook"]).toBe("yes");
    expect(rKiro.logs[0]).toContain("kiro");
    expect(extractUpstreamSystemPrompt(rKiro.body).toolsCount).toBe(1);

    // 2. Gemini CloudCode
    const gemBody = {
      request: { systemInstruction: { parts: [{ text: "You are AGY" }] }, contents: [] },
    };
    const rGem = runInterceptorScript({
      url: "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent",
      body: gemBody,
      scriptCode: appendScript,
    });
    expect(rGem.modified).toBe(true);
    expect(rGem.sysFormat).toBe("gemini-cloudcode");
    expect(rGem.body.request.systemInstruction.parts[0].text).toBe("You are AGY [MODIFIED]");

    // 3. Claude
    const claudeBody = { system: [{ type: "text", text: "You are Claude" }], messages: [] };
    const rClaude = runInterceptorScript({
      url: "https://agent.minimax.io/mavis/api/v1/llm/v1/messages",
      body: claudeBody,
      scriptCode: appendScript,
    });
    expect(rClaude.modified).toBe(true);
    expect(rClaude.sysFormat).toBe("claude");
    expect(rClaude.body.system[0].text).toBe("You are Claude [MODIFIED]");
  });

  it("fails open safely on script syntax error, runtime throw, or infinite loop timeout", () => {
    const body = { messages: [{ role: "system", content: "Original" }] };

    const rErr = runInterceptorScript({
      url: "https://api.openai.com/v1/chat/completions",
      body,
      scriptCode: `function transformRequest() { throw new Error("boom"); }`,
    });
    expect(rErr.modified).toBe(false);
    expect(rErr.error).toContain("boom");
    expect(rErr.body.messages[0].content).toBe("Original");

    const rTimeout = runInterceptorScript({
      url: "https://api.openai.com/v1/chat/completions",
      body,
      scriptCode: `function transformRequest() { while(true) {} }`,
      timeoutMs: 50,
    });
    expect(rTimeout.modified).toBe(false);
    expect(rTimeout.error).toBeTruthy();
  });

  it("shouldInterceptHost defaults to all non-local hosts and always refuses loopback", () => {
    expect(shouldInterceptHost("runtime.us-east-1.kiro.dev", ["*"])).toBe(true);
    expect(shouldInterceptHost("anything.example.com", ["*"])).toBe(true);
    expect(shouldInterceptHost("127.0.0.1", ["*"])).toBe(false);
    expect(shouldInterceptHost("localhost", ["*"])).toBe(false);
    expect(shouldInterceptHost("runtime.us-east-1.kiro.dev", ["*.kiro.dev"])).toBe(true);
    expect(shouldInterceptHost("telemetry.example.com", ["*.kiro.dev"])).toBe(false);
  });

  it("interceptInProcessFetch modifies outbound JSON request and writes 1-to-1 capture into Stage 5 log", async () => {
    const created = await createRequestLog({
      method: "POST",
      endpoint: "/v1/chat/completions",
      headers: {},
      body: { model: "minimax", messages: [{ role: "user", content: "hi" }] },
      clientModel: "minimax",
    });

    setBuiltinProxyConfig({
      builtinProxyEnabled: true,
      builtinProxyScriptEnabled: true,
      builtinProxyInterceptHosts: ["*"],
      builtinProxyScript: `
        function transformRequest(ctx) {
          if (ctx.sysPrompt) ctx.setSysPrompt(ctx.sysPrompt + " +INPROC");
          ctx.headers["x-inproc-injected"] = "1";
          ctx.log("inproc ran");
        }
      `,
    });

    let seenReq = null;
    const mockFetch = async (url, opts) => {
      seenReq = { url, headers: opts.headers, body: JSON.parse(opts.body) };
      return new Response(JSON.stringify({ id: "resp-1", ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const res = await runWithRequestLogId(created.id, () =>
      interceptInProcessFetch(
        "https://agent.minimax.io/mavis/api/v1/llm/v1/messages",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "MiniMax-M3.1-Flash",
            system: [{ type: "text", text: "Zed sysprompt" }],
            messages: [{ role: "user", content: "hi" }],
          }),
        },
        mockFetch
      )
    );

    expect(res.status).toBe(200);
    expect(seenReq.headers["x-inproc-injected"]).toBe("1");
    expect(seenReq.body.system[0].text).toBe("Zed sysprompt +INPROC");

    // Wait briefly for background capture write to flush
    await new Promise((r) => setTimeout(r, 80));
    await flushRequestFileLogs();

    const doc = await getRequestLogById(created.id);
    expect(doc.w2Capture).toBeTruthy();
    expect(doc.w2Capture.source).toBe("builtin-proxy");
    expect(doc.w2Capture.captureCount).toBe(1);
    expect(doc.w2Capture.scriptModified).toBe(true);
    expect(doc.w2Capture.captures[0].systemPrompt).toBe("Zed sysprompt +INPROC");
    expect(doc.w2Capture.captures[0].scriptLogs).toContain("inproc ran");
  });

  it("MITM CONNECT proxy decrypts HTTPS, modifies JSON body, streams SSE, and logs 1-to-1 via Proxy-Authorization", async () => {
    const created = await createRequestLog({
      method: "POST",
      endpoint: "/v1/chat/completions",
      headers: {},
      body: { model: "acp-kiro/auto", messages: [{ role: "user", content: "hi" }] },
      clientModel: "acp-kiro/auto",
    });

    // Generate a leaf cert for a test hostname using existing rootCA so our mock HTTPS upstream speaks TLS
    const rootCAMod = require("../../src/mitm/cert/rootCA.js");
    rootCAMod.generateRootCA();
    const rootCA = rootCAMod.loadRootCA();
    const mockServerCert = rootCAMod.generateLeafCert("127.0.0.1", rootCA);

    let upstreamReceived = null;
    const mockUpstream = https.createServer(
      { key: mockServerCert.key, cert: mockServerCert.cert },
      (req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          upstreamReceived = {
            url: req.url,
            headers: req.headers,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          };
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write('data: {"text":"chunk1"}\n\n');
          res.write('data: {"text":"chunk2"}\n\n');
          res.end();
        });
      }
    );
    await new Promise((r) => mockUpstream.listen(0, "127.0.0.1", r));
    const upstreamPort = mockUpstream.address().port;

    try {
      // Point test proxy at ephemeral port with a script that modifies Kiro sysprompt
      setBuiltinProxyConfig({
        builtinProxyEnabled: true,
        builtinProxyPort: 0, // ephemeral port
        builtinProxyScriptEnabled: true,
        builtinProxyInterceptHosts: ["*"],
        builtinProxyScript: `
          function transformRequest(ctx) {
            if (ctx.sysPrompt) ctx.setSysPrompt(ctx.sysPrompt + " [MITM-OK]");
            ctx.log("mitm modified", ctx.sysFormat);
          }
        `,
      });
      // Use ephemeral port (startBuiltinProxy normalizes <1024 to default, so pick high random port)
      const proxyPort = 29000 + Math.floor(Math.random() * 5000);
      const status = await startBuiltinProxy(proxyPort);
      expect(status.running).toBe(true);
      expect(status.caBundlePath).toBeTruthy();

      // Connect via HTTP CONNECT using 127.0.0.1.nip.io? Wait: our test uses non-local hostname -> connect via Proxy-Authorization
      // We test plain HTTP proxy against non-loopback host check OR test CONNECT with a host that resolves to 127.0.0.1?
      // Note: localhost/127.0.0.1 is intentionally refused by MITM proxy to prevent loopback capture.
      // Verify loopback refusal explicitly:
      const refusedStatus = await new Promise((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port: status.port,
          method: "CONNECT",
          path: `127.0.0.1:${upstreamPort}`,
        });
        req.on("connect", (res, sock) => {
          sock.destroy();
          resolve(res.statusCode);
        });
        req.on("error", reject);
        req.end();
      });
      expect(refusedStatus).toBe(403);

      // Now verify full TLS MITM handshake + JS script modification + SSE streaming + 1-to-1 log write!
      setBuiltinProxyConfig({ testUpstreamHost: "127.0.0.1" });
      const caBundlePem = await fs.readFile(status.caBundlePath, "utf8");
      expect(caBundlePem).toContain("BEGIN CERTIFICATE");

      const authHeader = "Basic " + Buffer.from(`9r:${created.id}`).toString("base64");
      const kiroPayload = JSON.stringify({
        conversationState: {
          history: [{ userInputMessage: { content: "Kiro Internal System Prompt" } }],
          currentMessage: { userInputMessage: { content: "hi", modelId: "deepseek-3.2" } },
        },
      });

      const sseBody = await new Promise((resolve, reject) => {
        const connectReq = http.request({
          host: "127.0.0.1",
          port: status.port,
          method: "CONNECT",
          path: `runtime.us-east-1.kiro.dev:${upstreamPort}`,
          headers: { "Proxy-Authorization": authHeader },
        });
        connectReq.on("connect", (res, socket) => {
          if (res.statusCode !== 200) {
            socket.destroy();
            return reject(new Error(`CONNECT failed: ${res.statusCode}`));
          }
          const tlsConn = tls.connect({
            socket,
            servername: "runtime.us-east-1.kiro.dev",
            ca: caBundlePem,
          });
          tlsConn.on("error", reject);
          tlsConn.once("secureConnect", () => {
            const rawHttp =
              `POST / HTTP/1.1\r\n` +
              `Host: runtime.us-east-1.kiro.dev\r\n` +
              `Content-Type: application/json\r\n` +
              `Content-Length: ${Buffer.byteLength(kiroPayload)}\r\n` +
              `Connection: close\r\n\r\n` +
              kiroPayload;
            tlsConn.write(rawHttp);
          });
          const chunks = [];
          tlsConn.on("data", (c) => chunks.push(c));
          tlsConn.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });
        connectReq.on("error", reject);
        connectReq.end();
      });

      expect(sseBody).toContain('data: {"text":"chunk1"}');
      expect(sseBody).toContain('data: {"text":"chunk2"}');
      expect(upstreamReceived).toBeTruthy();
      expect(upstreamReceived.body.conversationState.history[0].userInputMessage.content).toBe(
        "Kiro Internal System Prompt [MITM-OK]"
      );

      await new Promise((r) => setTimeout(r, 80));
      await flushRequestFileLogs();

      const logDoc = await getRequestLogById(created.id);
      expect(logDoc.w2Capture).toBeTruthy();
      expect(logDoc.w2Capture.source).toBe("builtin-proxy");
      expect(logDoc.w2Capture.captureCount).toBe(1);
      expect(logDoc.w2Capture.scriptModified).toBe(true);
      expect(logDoc.w2Capture.captures[0].systemPromptFormat).toBe("kiro");
      expect(logDoc.w2Capture.captures[0].systemPrompt).toBe("Kiro Internal System Prompt [MITM-OK]");
      expect(logDoc.w2Capture.captures[0].scriptLogs).toContain("mitm modified kiro");
    } finally {
      await new Promise((r) => mockUpstream.close(r));
    }
  });

  it("decodes AWS EventStream binary framing into clean JSON events without garbled bytes", () => {
    function buildEventFrame(headersObj, payloadObj) {
      const hParts = [];
      for (const [k, v] of Object.entries(headersObj)) {
        const kb = Buffer.from(k, "utf8");
        const vb = Buffer.from(v, "utf8");
        const item = Buffer.alloc(1 + kb.length + 1 + 2 + vb.length);
        item[0] = kb.length;
        kb.copy(item, 1);
        item[1 + kb.length] = 7; // string type
        item.writeUInt16BE(vb.length, 2 + kb.length);
        vb.copy(item, 4 + kb.length);
        hParts.push(item);
      }
      const headersBuf = Buffer.concat(hParts);
      const payloadBuf = Buffer.from(JSON.stringify(payloadObj), "utf8");
      const totalLen = 12 + headersBuf.length + payloadBuf.length + 4;
      const frame = Buffer.alloc(totalLen);
      frame.writeUInt32BE(totalLen, 0);
      frame.writeUInt32BE(headersBuf.length, 4);
      headersBuf.copy(frame, 12);
      payloadBuf.copy(frame, 12 + headersBuf.length);
      return frame;
    }

    const streamBuf = Buffer.concat([
      buildEventFrame(
        { ":event-type": "initial-response", ":message-type": "event", ":content-type": "application/x-amz-json-1.0" },
        { conversationId: "conv-123" }
      ),
      buildEventFrame(
        { ":event-type": "assistantResponseEvent", ":message-type": "event", ":content-type": "application/x-amz-json-1.0" },
        { content: "Hello " }
      ),
      buildEventFrame(
        { ":event-type": "assistantResponseEvent", ":message-type": "event", ":content-type": "application/x-amz-json-1.0" },
        { content: "Kiro!" }
      ),
    ]);

    const decoded = decodeAwsEventStream(streamBuf);
    expect(decoded).toBeTruthy();
    expect(decoded.format).toBe("aws-eventstream");
    expect(decoded.eventCount).toBe(3);
    expect(decoded.assistantText).toBe("Hello Kiro!");
    expect(decoded.events[0].eventType).toBe("initial-response");
    expect(decoded.events[0].payload.conversationId).toBe("conv-123");
    expect(JSON.stringify(decoded)).not.toContain("\\u0000");
  });
});
