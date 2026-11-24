// The streaming handler logs "(Empty streaming response)" whenever the stream
// transform never accumulates content. Two real paths used to hit that:
//
//   1. Ollama NDJSON carries text on `message.content`, not
//      `choices[].delta.content`.
//   2. When the provider speaks a different format (e.g. an OpenAI Responses
//      upstream behind an OpenAI client) the per-format checks read the upstream
//      chunk, so translated text was never counted.
//
// Both made a successful stream look empty in the request log.
import { describe, it, expect } from "vitest";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

async function runStream(lines, options) {
  const encoder = new TextEncoder();
  const upstream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines.join("\n") + "\n"));
      controller.close();
    },
  });

  let completed = null;
  const stream = createSSEStream({
    mode: "translate",
    provider: "test",
    model: "local",
    body: { messages: [{ role: "user", content: "hi" }] },
    onStreamComplete: (contentObj) => {
      completed = contentObj;
    },
    ...options,
  });

  upstream.pipeThrough(stream);
  await new Response(stream.readable).text();
  return completed;
}

describe("stream accounting is not reported as an empty response", () => {
  it("counts text delivered to an OpenAI client from a Responses upstream", async () => {
    // targetFormat = provider (upstream), sourceFormat = client
    const lines = [];
    for (let i = 0; i < 3; i++) {
      lines.push("event: response.output_text.delta");
      lines.push(`data: {"type":"response.output_text.delta","delta":"chunk${i} "}`);
      lines.push("");
    }
    lines.push("event: response.completed");
    lines.push('data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":3}}}');
    lines.push("");

    const completed = await runStream(lines, {
      targetFormat: FORMATS.OPENAI_RESPONSES,
      sourceFormat: FORMATS.OPENAI,
    });

    expect(completed).toBeTruthy();
    expect(completed.content).toBe("chunk0 chunk1 chunk2 ");
  });

  it("counts reasoning delivered from a Responses upstream", async () => {
    const lines = [
      "event: response.reasoning_summary_text.delta",
      'data: {"type":"response.reasoning_summary_text.delta","delta":"pondering"}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"answer"}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":2}}}',
      "",
    ];

    const completed = await runStream(lines, {
      targetFormat: FORMATS.OPENAI_RESPONSES,
      sourceFormat: FORMATS.OPENAI,
    });

    expect(completed.content).toBe("answer");
    expect(completed.thinking).toBe("pondering");
  });

  it("counts plain OpenAI streaming content", async () => {
    const lines = [
      'data: {"id":"a","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}',
      'data: {"id":"a","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}',
      'data: {"id":"a","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
      "data: [DONE]",
    ];

    const completed = await runStream(lines, {
      targetFormat: FORMATS.OPENAI,
      sourceFormat: FORMATS.OPENAI,
    });

    expect(completed.content).toBe("Hello world");
  });
});
