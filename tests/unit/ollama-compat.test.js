import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ollamaToOpenAIBody,
  openAIJsonToOllama,
  toOllamaModelTag,
  toOllamaModelShow,
  transformToOllama,
} from "../../open-sse/utils/ollamaTransform.js";

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

async function readNdjson(response) {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

describe("Ollama-compatible transform", () => {
  describe("ollamaToOpenAIBody", () => {
    it("maps model, messages, streaming flag and options", () => {
      const body = ollamaToOpenAIBody({
        model: "ds/deepseek-chat",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hi" },
        ],
        options: { temperature: 0.2, top_p: 0.9, num_predict: 256, stop: ["END"] },
      });

      expect(body.model).toBe("ds/deepseek-chat");
      expect(body.stream).toBe(true);
      expect(body.messages).toEqual([
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ]);
      expect(body.temperature).toBe(0.2);
      expect(body.top_p).toBe(0.9);
      expect(body.max_tokens).toBe(256);
      expect(body.stop).toEqual(["END"]);
    });

    it("keeps stream:false and maps tools / json format", () => {
      const tools = [{ type: "function", function: { name: "shell", parameters: { type: "object" } } }];
      const body = ollamaToOpenAIBody({
        model: "combo1",
        messages: [{ role: "user", content: "run ls" }],
        stream: false,
        format: "json",
        tools,
      });
      expect(body.stream).toBe(false);
      expect(body.tools).toEqual(tools);
      expect(body.response_format).toEqual({ type: "json_object" });
    });

    it("converts base64 images to OpenAI image_url parts", () => {
      const body = ollamaToOpenAIBody({
        model: "ag/gemini-4-carbon",
        messages: [{ role: "user", content: "what is this?", images: ["iVBORw0KGgoAAAANS"] }],
      });
      const content = body.messages[0].content;
      expect(content[0]).toEqual({ type: "text", text: "what is this?" });
      expect(content[1].type).toBe("image_url");
      expect(content[1].image_url.url).toBe("data:image/png;base64,iVBORw0KGgoAAAANS");
    });

    it("round-trips assistant tool calls and pairs tool results with ids", () => {
      const body = ollamaToOpenAIBody({
        model: "combo1",
        messages: [
          { role: "user", content: "check the weather" },
          {
            role: "assistant",
            content: "",
            thinking: "need the weather tool",
            tool_calls: [
              { id: "call_a", function: { name: "weather", arguments: { city: "Hue" } } },
            ],
          },
          { role: "tool", tool_name: "weather", content: "31C" },
        ],
      });

      const assistant = body.messages[1];
      expect(assistant.content).toBeNull();
      expect(assistant.reasoning_content).toBe("need the weather tool");
      expect(assistant.tool_calls[0]).toEqual({
        id: "call_a",
        type: "function",
        function: { name: "weather", arguments: '{"city":"Hue"}' },
      });
      expect(body.messages[2]).toEqual({
        role: "tool",
        tool_call_id: "call_a",
        content: "31C",
      });
    });
  });

  describe("openAIJsonToOllama", () => {
    it("maps a non-streaming completion including tool calls and usage", () => {
      const out = openAIJsonToOllama(
        {
          model: "combo1",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "",
                reasoning_content: "plan",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "shell", arguments: '{"cmd":"ls"}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        },
        "combo1"
      );

      expect(out.model).toBe("combo1");
      expect(out.done).toBe(true);
      expect(out.created_at).toMatch(/T/);
      expect(out.prompt_eval_count).toBe(11);
      expect(out.eval_count).toBe(7);
      expect(out.message.thinking).toBe("plan");
      expect(out.message.tool_calls).toEqual([
        { id: "call_1", function: { name: "shell", arguments: { cmd: "ls" } } },
      ]);
    });
  });

  describe("model metadata mapping", () => {
    const model = {
      id: "acp-agy/gemini-4-neon-high",
      owned_by: "acp-agy",
      context_length: 1048576,
      max_completion_tokens: 64000,
      capabilities: { vision: true, tools: true, reasoning: true },
    };

    it("emits every field Zed's /api/tags parser requires", () => {
      const tag = toOllamaModelTag(model);
      expect(tag.name).toBe(model.id);
      expect(typeof tag.modified_at).toBe("string");
      expect(typeof tag.size).toBe("number");
      expect(typeof tag.digest).toBe("string");
      expect(tag.digest.length).toBe(16);
      expect(tag.details).toMatchObject({
        format: "9router",
        family: "acp-agy",
        parameter_size: "",
        quantization_level: "",
      });
      expect(tag.details.families).toEqual(["acp-agy"]);
    });

    it("reports capabilities and context window for /api/show", () => {
      const show = toOllamaModelShow(model);
      expect(show.capabilities).toEqual(
        expect.arrayContaining(["completion", "tools", "vision", "thinking"])
      );
      expect(show.parameters).toBe("num_ctx 1048576");
      expect(show.model_info["9router.context_length"]).toBe(1048576);
    });

    it("omits context when the catalog has none", () => {
      const show = toOllamaModelShow({ id: "mystery" });
      expect(show.parameters).toBeUndefined();
      expect(show.model_info).toBeUndefined();
      expect(show.capabilities).toEqual(["completion"]);
    });
  });

  describe("transformToOllama", () => {
    it("streams content, thinking, usage and exactly one final line", async () => {
      const response = sseResponse([
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"thin',
        'king"}}]}\n\ndata: {"choices":[{"delta":{"content":"Hel',
        'lo"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
        "data: [DONE]\n\n",
      ]);

      const lines = await readNdjson(transformToOllama(response, "combo1"));
      expect(lines.length).toBe(4); // thinking + "Hello" + " world" + final
      expect(lines[0].message.thinking).toBe("thinking");
      expect(lines[1].message.content).toBe("Hello");
      expect(lines[2].message.content).toBe(" world");

      const final = lines.at(-1);
      expect(final.done).toBe(true);
      expect(final.done_reason).toBe("stop");
      expect(final.prompt_eval_count).toBe(5);
      expect(final.eval_count).toBe(2);
      expect(lines.filter((line) => line.done)).toHaveLength(1);

      for (const line of lines) {
        expect(line.model).toBe("combo1");
        expect(typeof line.created_at).toBe("string");
        expect(line.message.role).toBe("assistant");
      }
    });

    it("assembles split tool-call deltas with ids and parsed arguments", async () => {
      const response = sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"she',
        'll","arguments":"{\\"cmd\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ]);

      const lines = await readNdjson(transformToOllama(response, "combo1"));
      const final = lines.at(-1);
      expect(final.done).toBe(true);
      expect(final.message.tool_calls).toEqual([
        { id: "call_9", function: { name: "shell", arguments: { cmd: "ls" } } },
      ]);
    });

    it("still terminates the stream when no [DONE] sentinel arrives", async () => {
      const response = sseResponse([
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      ]);
      const lines = await readNdjson(transformToOllama(response, "m"));
      expect(lines.at(-1).done).toBe(true);
    });
  });
});

describe("Ollama chat handler", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("streams NDJSON for stream:true and leaves no OpenAI SSE markers", async () => {
    vi.doMock("open-sse/translator/index.js", () => ({ initTranslators: vi.fn() }));
    let sentBody = null;
    const handleChat = vi.fn(async (request) => {
      sentBody = await request.json();
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    });
    vi.doMock("@/sse/handlers/chat.js", () => ({ handleChat }));

    const { handleOllamaChat } = await import("../../src/sse/handlers/ollamaChat.js");
    const response = await handleOllamaChat(
      new Request("http://127.0.0.1:20127/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
        body: JSON.stringify({
          model: "combo1",
          messages: [{ role: "user", content: "say OK" }],
          options: { temperature: 0.1 },
        }),
      })
    );

    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = await readNdjson(response);
    expect(lines.map((line) => line.message.content).join("")).toBe("OK");
    expect(lines.at(-1).done).toBe(true);

    // The translated upstream body is OpenAI-shaped.
    expect(sentBody.model).toBe("combo1");
    expect(sentBody.stream).toBe(true);
    expect(sentBody.temperature).toBe(0.1);
    expect(sentBody.messages).toEqual([{ role: "user", content: "say OK" }]);
  });

  it("returns a single Ollama JSON object for stream:false", async () => {
    vi.doMock("open-sse/translator/index.js", () => ({ initTranslators: vi.fn() }));
    let sentBody = null;
    const handleChat = vi.fn(async (request) => {
      sentBody = await request.json();
      return new Response(
        JSON.stringify({
          model: "combo1",
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    });
    vi.doMock("@/sse/handlers/chat.js", () => ({ handleChat }));

    const { handleOllamaChat } = await import("../../src/sse/handlers/ollamaChat.js");
    const response = await handleOllamaChat(
      new Request("http://127.0.0.1:20127/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
        body: JSON.stringify({
          model: "combo1",
          messages: [{ role: "user", content: "say OK" }],
          stream: false,
        }),
      })
    );

    expect(sentBody.stream).toBe(false);
    const out = await response.json();
    expect(out.done).toBe(true);
    expect(out.message.content).toBe("OK");
    expect(out.eval_count).toBe(1);
  });

  it("maps upstream failures to an Ollama-shaped error", async () => {
    vi.doMock("open-sse/translator/index.js", () => ({ initTranslators: vi.fn() }));
    const handleChat = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "no active accounts" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.doMock("@/sse/handlers/chat.js", () => ({ handleChat }));

    const { handleOllamaChat } = await import("../../src/sse/handlers/ollamaChat.js");
    const response = await handleOllamaChat(
      new Request("http://127.0.0.1:20127/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
        body: JSON.stringify({ model: "combo1", messages: [{ role: "user", content: "hi" }] }),
      })
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "no active accounts" });
  });
});
