import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import zlib from "node:zlib";
import {
  decodeWhistleBody,
  extractUpstreamSystemPrompt,
  isAiUpstreamUrl,
  pullW2CapturesForWindow,
  getW2ScriptStatus,
  installW2ScriptPlugin,
} from "../../open-sse/utils/w2Capture.js";

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

describe("w2Capture (Whistle capture puller & sysprompt extractor)", () => {
  it("extracts system prompts across Gemini CloudCode, Kiro/Responses, Claude, and OpenAI Chat", () => {
    const gem = extractUpstreamSystemPrompt({
      model: "gemini-3.8-flash-high",
      request: {
        systemInstruction: { parts: [{ text: "Antigravity internal sysprompt" }] },
        tools: [{ functionDeclarations: [{ name: "read_file" }, { name: "run_cmd" }] }],
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      },
    });
    expect(gem.format).toBe("gemini-cloudcode");
    expect(gem.text).toBe("Antigravity internal sysprompt");
    expect(gem.chars).toBe("Antigravity internal sysprompt".length);
    expect(gem.toolsCount).toBe(2);
    expect(gem.upstreamModel).toBe("gemini-3.8-flash-high");

    const resp = extractUpstreamSystemPrompt({
      model: "auto",
      instructions: "Kiro instructions",
      input: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", name: "shell" }],
    });
    expect(resp.format).toBe("openai-responses");
    expect(resp.text).toBe("Kiro instructions");
    expect(resp.toolsCount).toBe(1);

    const claude = extractUpstreamSystemPrompt({
      model: "claude-sonnet-4-5",
      system: [{ type: "text", text: "Claude system block" }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(claude.format).toBe("claude");
    expect(claude.text).toBe("Claude system block");

    const oai = extractUpstreamSystemPrompt({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "OpenAI system rule" },
        { role: "user", content: "hi" },
      ],
    });
    expect(oai.format).toBe("openai-chat");
    expect(oai.text).toBe("OpenAI system rule");
  });

  it("decodes both raw base64 and gzip-compressed base64 Whistle bodies", () => {
    const payload = { request: { systemInstruction: { parts: [{ text: "Gzipped prompt" }] } } };
    const rawJson = JSON.stringify(payload);
    const plain = decodeWhistleBody(Buffer.from(rawJson, "utf8").toString("base64"), { "content-type": "application/json" });
    expect(plain.json).toEqual(payload);

    const gzippedB64 = zlib.gzipSync(Buffer.from(rawJson, "utf8")).toString("base64");
    const gz = decodeWhistleBody(gzippedB64, { "content-type": "application/json", "content-encoding": "gzip" });
    expect(gz.json).toEqual(payload);
  });

  it("classifies AI upstream URLs vs telemetry/auxiliary URLs accurately", () => {
    expect(isAiUpstreamUrl("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse")).toBe(true);
    expect(isAiUpstreamUrl("https://runtime.us-east-1.kiro.dev/v1/responses")).toBe(true);
    expect(isAiUpstreamUrl("https://api.anthropic.com/v1/messages")).toBe(true);
    expect(isAiUpstreamUrl("https://api.openai.com/v1/chat/completions")).toBe(true);

    expect(isAiUpstreamUrl("https://play.googleapis.com/log")).toBe(false);
    expect(isAiUpstreamUrl("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels")).toBe(false);
    expect(isAiUpstreamUrl("https://lh3.googleusercontent.com/a/avatar")).toBe(false);
  });

  it("pulls matching time-window captures from Whistle API, masks headers, and separates telemetry", async () => {
    const now = Date.now();
    const mainReqBody = {
      model: "gemini-3.8-flash-high",
      request: {
        systemInstruction: { parts: [{ text: "A".repeat(250) }] },
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      },
    };
    const helperReqBody = {
      model: "gemini-3.8-flash",
      request: { contents: [{ role: "user", parts: [{ text: "title" }] }] },
    };

    const createdScripts = [];
    const addedRules = [];

    const mockWhistle = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const bodyText = Buffer.concat(chunks).toString("utf8");
        res.setHeader("content-type", "application/json");

        if (req.url.startsWith("/cgi-bin/get-data")) {
          return res.end(
            JSON.stringify({
              data: {
                data: {
                  "1": {
                    id: "1",
                    startTime: now + 50,
                    endTime: now + 300,
                    url: "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
                    req: {
                      method: "POST",
                      size: 1051,
                      headers: { authorization: "Bearer ya29.secret-token-1234567890", "content-type": "application/json" },
                      base64: Buffer.from(JSON.stringify(helperReqBody)).toString("base64"),
                    },
                    res: { statusCode: 200, size: 120, headers: {}, base64: Buffer.from("data: ok\n\n").toString("base64") },
                    rules: {},
                  },
                  "2": {
                    id: "2",
                    startTime: now + 100,
                    endTime: now + 900,
                    url: "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
                    req: {
                      method: "POST",
                      size: 43864,
                      headers: { authorization: "Bearer ya29.secret-token-1234567890", "content-type": "application/json" },
                      base64: Buffer.from(JSON.stringify(mainReqBody)).toString("base64"),
                    },
                    res: { statusCode: 200, size: 1200, headers: {}, base64: Buffer.from("data: hello\n\n").toString("base64") },
                    rules: { plugin: { raw: "script://9router-sysprompt" } },
                  },
                  "3": {
                    id: "3",
                    startTime: now + 200,
                    endTime: now + 250,
                    url: "https://play.googleapis.com/log",
                    req: { method: "POST", size: 622000, headers: {}, base64: "" },
                    res: { statusCode: 200, size: 100, headers: {}, base64: "" },
                    rules: {},
                  },
                  "4": {
                    id: "4",
                    startTime: now - 60000, // outside window!
                    endTime: now - 59000,
                    url: "https://api.openai.com/v1/chat/completions",
                    req: { method: "POST", size: 500, headers: {}, base64: "" },
                    res: { statusCode: 200, size: 500, headers: {}, base64: "" },
                    rules: {},
                  },
                },
              },
            })
          );
        }

        if (req.url === "/plugin.script/cgi-bin/create") {
          createdScripts.push(JSON.parse(bodyText));
          return res.end(JSON.stringify({ ec: 0 }));
        }
        if (req.url === "/plugin.script/cgi-bin/init") {
          return res.end(JSON.stringify({ list: createdScripts }));
        }
        if (req.url === "/cgi-bin/rules/add") {
          addedRules.push(bodyText);
          return res.end(JSON.stringify({ ec: 0 }));
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ ec: 1 }));
      });
    });

    await new Promise((resolve) => mockWhistle.listen(0, "127.0.0.1", resolve));
    const w2Url = `http://127.0.0.1:${mockWhistle.address().port}`;

    try {
      const result = await pullW2CapturesForWindow({ w2Url, startTime: now, endTime: now + 1000 });
      expect(result.captureCount).toBe(2);
      expect(result.otherCount).toBe(1);
      expect(result.hasSystemPrompt).toBe(true);

      // Sorted with main sysprompt capture first
      expect(result.captures[0].id).toBe("2");
      expect(result.captures[0].systemPromptChars).toBe(250);
      expect(result.captures[0].reqHeaders.authorization).toBe("Bearer ya29.s...7890");
      expect(result.captures[0].rules).toContain("script://9router-sysprompt");
      expect(result.otherRequests[0].url).toBe("https://play.googleapis.com/log");

      // Test script plugin installer & status check
      const installRes = await installW2ScriptPlugin({
        w2Url,
        scriptName: "9router-sysprompt",
        scriptContent: "exports.handleRequest = () => {};",
        ruleName: "9router-acp-sysprompt",
        ruleContent: "daily-cloudcode-pa.googleapis.com script://9router-sysprompt",
        enableRule: false,
      });
      expect(installRes.success).toBe(true);
      expect(installRes.ruleRegistered).toBe(true);
      expect(addedRules).toHaveLength(1);

      const status = await getW2ScriptStatus(w2Url, "9router-sysprompt");
      expect(status.installed).toBe(true);
    } finally {
      await closeServer(mockWhistle);
    }
  });
});
