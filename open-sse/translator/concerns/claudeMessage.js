import { FORMATS } from "../formats.js";
import { fromOpenAIFinish } from "./finishReason.js";
import { CLAUDE_BLOCK, MODEL_FALLBACK, RESPONSES_ITEM, ROLE } from "../schema/index.js";

function parseToolArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function openAICompletionToClaudeMessage(responseBody, originalBody = null) {
  if (!responseBody?.choices?.[0]) return responseBody;
  const choice = responseBody.choices[0];
  const message = choice.message || {};
  const content = [];

  // `reasoning` (string) is the vendor alias some OpenAI-compatible upstreams use (SenseNova, OpenRouter).
  const reasoning = message.reasoning_content
    || message.provider_specific_fields?.reasoning_content
    || (typeof message.reasoning === "string" ? message.reasoning : "");
  if (reasoning) {
    content.push({ type: CLAUDE_BLOCK.THINKING, thinking: reasoning });
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: CLAUDE_BLOCK.TEXT, text: message.content });
  }
  for (const toolCall of message.tool_calls || []) {
    const fn = toolCall.function || {};
    content.push({
      type: CLAUDE_BLOCK.TOOL_USE,
      id: toolCall.id || `toolu_${Date.now()}_${content.length}`,
      name: fn.name || toolCall.name || "",
      input: parseToolArguments(fn.arguments || toolCall.arguments),
    });
  }
  if (content.length === 0) content.push({ type: CLAUDE_BLOCK.TEXT, text: "" });

  const usage = responseBody.usage || {};
  const result = {
    id: String(responseBody.id || `msg_${Date.now()}`).replace(/^chatcmpl-/, ""),
    type: RESPONSES_ITEM.MESSAGE,
    role: ROLE.ASSISTANT,
    model: responseBody.model || MODEL_FALLBACK,
    content,
    stop_reason: fromOpenAIFinish(choice.finish_reason, FORMATS.CLAUDE),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    },
  };

  if (responseBody.safeguard_results) {
    result.safeguard_results = responseBody.safeguard_results;
  } else if (originalBody?.safeguards || responseBody?.safeguards) {
    const toolUses = {};
    for (const toolCall of message.tool_calls || []) {
      if (toolCall.id) {
        toolUses[toolCall.id] = { type: "evaluated", outcome: "not_flagged" };
      }
    }
    result.safeguard_results = [
      {
        type: "dangerous_tool_use",
        status: {
          type: "available",
          tool_uses: toolUses,
        },
      },
    ];
  }

  return result;
}
