// Ollama-compatible wire format helpers.
//
// 9Router speaks OpenAI on the inside, so the Ollama surface (/api/tags,
// /api/show, /api/chat) converts requests in and responses out here. Kept pure
// and dependency-free so it can be unit-tested without a running server.

const encoder = new TextEncoder();

const DEFAULT_OLLAMA_MODEL = "9router";

function isoNow() {
  return new Date().toISOString();
}

function encodeLine(payload) {
  return encoder.encode(`${JSON.stringify(payload)}\n`);
}

function shortDigest(input) {
  // Stable pseudo-digest: Ollama clients only require *a* string here.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + code, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

function parseArguments(args) {
  if (args && typeof args === "object") return args;
  if (typeof args !== "string" || !args.trim()) return {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

function stringifyArguments(args) {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "{}";
  }
}

function toOllamaToolCalls(calls) {
  return (calls || []).map((call, index) => ({
    id: call?.id ? String(call.id) : `call_${index}`,
    function: {
      name: call?.function?.name || "",
      arguments: parseArguments(call?.function?.arguments),
    },
  }));
}

function thinkingDelta(delta) {
  return delta?.reasoning_content || delta?.reasoning || "";
}

function imageUrl(image) {
  const value = String(image || "");
  if (!value) return "";
  if (/^(data:|https?:)/i.test(value)) return value;
  const mime = value.startsWith("/9j/") ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${value}`;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("");
  }
  return content == null ? "" : String(content);
}

/**
 * Convert an Ollama /api/chat request body into an OpenAI chat-completions body.
 */
export function ollamaToOpenAIBody(body = {}) {
  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  if (messages.length === 0 && (body.prompt || body.message)) {
    messages.push({ role: "user", content: body.prompt || body.message });
  }

  const converted = [];
  // Ollama tool results carry only tool_name, so pair them with the ids we
  // advertised on the preceding assistant tool_calls, in order.
  const pendingToolIds = [];

  for (const message of messages) {
    const role = String(message?.role || "user").toLowerCase();

    if (role === "assistant") {
      const out = { role: "assistant", content: contentToText(message.content) };
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (calls.length > 0) {
        out.tool_calls = calls.map((call, index) => {
          const id = call?.id ? String(call.id) : `call_${converted.length}_${index}`;
          pendingToolIds.push(id);
          return {
            id,
            type: "function",
            function: {
              name: call?.function?.name || "",
              arguments: stringifyArguments(call?.function?.arguments),
            },
          };
        });
        // OpenAI expects null (not "") when an assistant turn is tool-calls only.
        if (!out.content) out.content = null;
      }
      if (typeof message.thinking === "string" && message.thinking) {
        out.reasoning_content = message.thinking;
      }
      converted.push(out);
      continue;
    }

    if (role === "tool") {
      converted.push({
        role: "tool",
        tool_call_id: message.tool_call_id || pendingToolIds.shift() || `call_${converted.length}`,
        content: contentToText(message.content),
      });
      continue;
    }

    if (role === "user" && Array.isArray(message.images) && message.images.length > 0) {
      converted.push({
        role: "user",
        content: [
          ...(contentToText(message.content)
            ? [{ type: "text", text: contentToText(message.content) }]
            : []),
          ...message.images.map((image) => ({
            type: "image_url",
            image_url: { url: imageUrl(image) },
          })),
        ],
      });
      continue;
    }

    const openaiRole = role === "system" || role === "assistant" ? role : "user";
    converted.push({ role: openaiRole, content: contentToText(message.content) });
  }

  const out = {
    model: body.model,
    messages: converted,
    stream: body.stream !== false,
  };

  const options = body.options && typeof body.options === "object" ? body.options : {};
  if (Number.isFinite(options.temperature)) out.temperature = options.temperature;
  if (Number.isFinite(options.top_p)) out.top_p = options.top_p;
  if (Array.isArray(options.stop) && options.stop.length > 0) out.stop = options.stop;
  if (Number.isFinite(options.num_predict) && options.num_predict > 0) {
    out.max_tokens = options.num_predict;
  }
  if (body.format === "json") out.response_format = { type: "json_object" };
  if (Array.isArray(body.tools) && body.tools.length > 0) out.tools = body.tools;

  return out;
}

/**
 * Map a non-streaming OpenAI chat-completions response to an Ollama /api/chat object.
 */
export function openAIJsonToOllama(payload, model) {
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const content = contentToText(message.content);
  const toolCalls = toOllamaToolCalls(message.tool_calls);
  const thinking = thinkingDelta(message);
  const usage = payload?.usage || {};

  return {
    model: model || payload?.model || DEFAULT_OLLAMA_MODEL,
    created_at: isoNow(),
    message: {
      role: "assistant",
      content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(thinking ? { thinking } : {}),
    },
    done: true,
    done_reason: choice.finish_reason === "length" ? "length" : "stop",
    ...(Number.isFinite(usage.prompt_tokens) ? { prompt_eval_count: usage.prompt_tokens } : {}),
    ...(Number.isFinite(usage.completion_tokens) ? { eval_count: usage.completion_tokens } : {}),
  };
}

/**
 * Map a 9Router /v1/models entry to the Ollama /api/tags listing shape.
 * Zed's Ollama client requires name/modified_at/size/digest/details.
 */
export function toOllamaModelTag(model) {
  const id = String(model?.id || model?.name || "unknown");
  const owner = String(model?.owned_by || DEFAULT_OLLAMA_MODEL);
  return {
    name: id,
    modified_at: "1970-01-01T00:00:00.000Z",
    size: 0,
    digest: shortDigest(id),
    details: {
      format: DEFAULT_OLLAMA_MODEL,
      family: owner,
      families: [owner],
      parameter_size: "",
      quantization_level: "",
    },
  };
}

/**
 * Map a 9Router /v1/models entry to the Ollama /api/show shape.
 * Zed reads `capabilities` (tools/vision/thinking) and the context window from
 * either `parameters` (`num_ctx <n>`) or `model_info["<arch>.context_length"]`.
 */
export function toOllamaModelShow(model) {
  const caps = model?.capabilities || {};
  const context = Number(model?.context_length ?? caps.contextWindow);
  const capabilities = ["completion"];
  if (caps.tools) capabilities.push("tools");
  if (caps.vision) capabilities.push("vision");
  if (caps.reasoning || (Array.isArray(model?.thinking_levels) && model.thinking_levels.length > 0)) {
    capabilities.push("thinking");
  }

  const show = {
    model: String(model?.id || model?.name || ""),
    details: toOllamaModelTag(model).details,
    capabilities,
  };

  if (Number.isFinite(context) && context > 0) {
    const rounded = Math.round(context);
    show.parameters = `num_ctx ${rounded}`;
    show.model_info = {
      "general.architecture": "9router",
      "9router.context_length": rounded,
    };
  }

  return show;
}

/**
 * Transform an OpenAI SSE stream into Ollama /api/chat NDJSON lines.
 * Emits exactly one terminating `done: true` line.
 */
export function transformToOllama(response, model) {
  const modelName = model || DEFAULT_OLLAMA_MODEL;
  let buffer = "";
  let pendingToolCalls = {};
  let doneSent = false;
  let usage = null;

  const emitFinal = (controller, doneReason = "stop") => {
    if (doneSent) return;
    doneSent = true;
    const toolCalls = Object.values(pendingToolCalls)
      .filter((call) => call.name || call.arguments)
      .map((call, index) => ({
        id: call.id || `call_${index}`,
        function: {
          name: call.name || "",
          arguments: parseArguments(call.arguments),
        },
      }));
    pendingToolCalls = {};
    controller.enqueue(
      encodeLine({
        model: modelName,
        created_at: isoNow(),
        message: {
          role: "assistant",
          content: "",
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        done: true,
        done_reason: doneReason,
        ...(Number.isFinite(usage?.prompt_tokens)
          ? { prompt_eval_count: usage.prompt_tokens }
          : {}),
        ...(Number.isFinite(usage?.completion_tokens) ? { eval_count: usage.completion_tokens } : {}),
      })
    );
  };

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += new TextDecoder().decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;

        if (data === "[DONE]") {
          emitFinal(controller);
          continue;
        }

        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        if (parsed?.usage) usage = parsed.usage;
        const choice = parsed?.choices?.[0] || {};
        const delta = choice.delta || choice.message || {};
        const content = typeof delta.content === "string" ? delta.content : "";
        const thinking = thinkingDelta(delta);

        if (content || thinking) {
          controller.enqueue(
            encodeLine({
              model: modelName,
              created_at: isoNow(),
              message: {
                role: "assistant",
                content,
                ...(thinking ? { thinking } : {}),
              },
              done: false,
            })
          );
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            const index = Number.isInteger(call?.index) ? call.index : Object.keys(pendingToolCalls).length;
            if (!pendingToolCalls[index]) {
              pendingToolCalls[index] = { id: call?.id, name: "", arguments: "" };
            }
            if (call?.id && !pendingToolCalls[index].id) pendingToolCalls[index].id = call.id;
            if (call?.function?.name) pendingToolCalls[index].name += call.function.name;
            if (typeof call?.function?.arguments === "string") {
              pendingToolCalls[index].arguments += call.function.arguments;
            } else if (call?.function?.arguments) {
              pendingToolCalls[index].arguments += stringifyArguments(call.function.arguments);
            }
          }
        }

        if (choice.finish_reason) {
          emitFinal(controller, choice.finish_reason === "length" ? "length" : "stop");
        }
      }
    },
    flush(controller) {
      emitFinal(controller);
    },
  });

  if (!response?.body) {
    return new Response("", {
      status: response?.status || 200,
      headers: { "Content-Type": "application/x-ndjson", "Access-Control-Allow-Origin": "*" },
    });
  }

  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    headers: { "Content-Type": "application/x-ndjson", "Access-Control-Allow-Origin": "*" },
  });
}
