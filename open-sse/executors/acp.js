import { BaseExecutor } from "./base.js";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { dbg } from "../utils/debugLog.js";
import { buildAcpProcessEnv } from "../utils/w2Proxy.js";

// Helper: JSON-RPC request line
const rpc = (method, params = {}, id = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

const SYSTEM_ROLES = new Set(["system", "developer"]);
const EMBEDDED_SYSTEM_TAG_RE =
  /<(system-reminder|system_reminder|system_instructions|system-instructions|system_message|system-message|system_prompt|system-prompt|tools_changed_notice|system)\b[^>]*>[\s\S]*?<\/\1>/gi;

const MASQUERADED_SYS_MIN_CHARS = 1500;
const MASQUERADED_SYS_PREAMBLE_RE =
  /^(?:you are (?:an? |the )?(?:ai |coding |software |helpful )?(?:assistant|agent|engineer|developer|pair programmer|model|copilot|claude|zed)|act as (?:an? |the )?(?:ai |coding )?(?:assistant|agent)|#\s*(?:system|instructions|identity|role)\b)/i;
const MASQUERADED_SYS_SIGNALS = [
  /<code_change_instructions\b/i,
  /<rules_for_code_changes\b/i,
  /<environment_limitations\b/i,
  /<prohibited_actions\b/i,
  /<environment_context\b/i,
  /<available_skills\b/i,
  /<task_completion\b/i,
  /<tool_use_instructions\b/i,
  /<shell_security\b/i,
  /<tools\b/i,
  /^##\s+Tool Use\b/m,
  /^##\s+Making Code Changes\b/m,
  /^##\s+System Information\b/m,
  /^##\s+Agent Skills\b/m,
];

/**
 * Detect IDE/SDK system prompts sent with `role: "user"` (e.g. GitHub Copilot SDK
 * in VS Code sends a ~40KB system prompt as messages[0] with role="user").
 * Requires length >= 1500 chars, a classic system persona preamble, AND >= 2
 * distinct agent-harness instruction tags/headings to prevent false positives.
 */
export function isMasqueradedUserSystemPrompt(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length < MASQUERADED_SYS_MIN_CHARS) return false;
  if (!MASQUERADED_SYS_PREAMBLE_RE.test(trimmed)) return false;
  let hits = 0;
  for (const re of MASQUERADED_SYS_SIGNALS) {
    if (re.test(trimmed)) {
      hits++;
      if (hits >= 2) return true;
    }
  }
  return false;
}

/**
 * Strip client tool definitions/controls strictly for ACP execution.
 * ACP agents run over stdio (`session/prompt`) and manage their own tools internally,
 * so forwarding client OpenAI/Claude/Gemini `tools` wastes bandwidth, tokens, and logs.
 * Returns a shallow copy without mutating the caller's body (safe for combo fallbacks).
 */
export function stripToolsForAcp(body) {
  if (!body || typeof body !== "object") return { body, strippedCount: 0 };

  const hasTopTools = Array.isArray(body.tools) && body.tools.length > 0;
  const hasTopFunctions = Array.isArray(body.functions) && body.functions.length > 0;
  const hasReqTools = Array.isArray(body.request?.tools) && body.request.tools.length > 0;
  const hasToolControls =
    body.tools !== undefined ||
    body.tool_choice !== undefined ||
    body.parallel_tool_calls !== undefined ||
    body.functions !== undefined ||
    body.function_call !== undefined ||
    body.request?.tools !== undefined ||
    body.request?.toolConfig !== undefined;

  if (!hasToolControls) return { body, strippedCount: 0 };

  let strippedCount = 0;
  if (hasTopTools) strippedCount += body.tools.length;
  if (hasTopFunctions) strippedCount += body.functions.length;
  if (hasReqTools) strippedCount += body.request.tools.length;

  const clone = { ...body };
  delete clone.tools;
  delete clone.tool_choice;
  delete clone.parallel_tool_calls;
  delete clone.functions;
  delete clone.function_call;

  if (clone.request && typeof clone.request === "object") {
    const reqClone = { ...clone.request };
    delete reqClone.tools;
    delete reqClone.toolConfig;
    clone.request = reqClone;
  }

  return { body: clone, strippedCount };
}

export function resolveAcpStripSystemPrompt(credentials) {
  const specificData = credentials?.providerSpecificData || {};
  if (specificData.stripSystemPrompt !== undefined) {
    return specificData.stripSystemPrompt === true || specificData.stripSystemPrompt === "true";
  }
  if (specificData.includeSystemPrompt !== undefined) {
    return !(specificData.includeSystemPrompt === true || specificData.includeSystemPrompt === "true");
  }
  if (process.env.ACP_STRIP_SYSTEM_PROMPT !== undefined) {
    return !["false", "0", "no"].includes(process.env.ACP_STRIP_SYSTEM_PROMPT.toLowerCase());
  }
  if (process.env.ACP_INCLUDE_SYSTEM_PROMPT !== undefined) {
    return !["true", "1", "yes"].includes(process.env.ACP_INCLUDE_SYSTEM_PROMPT.toLowerCase());
  }
  return true;
}

export function stripEmbeddedSystemTags(text) {
  if (typeof text !== "string" || !text) return text;
  const stripped = text.replace(EMBEDDED_SYSTEM_TAG_RE, "");
  if (stripped === text) return text;
  return stripped.replace(/\n{3,}/g, "\n\n").trim();
}

function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c?.text || ""))
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (Array.isArray(content.parts)) {
      return content.parts
        .map((p) => (typeof p === "string" ? p : p?.text || ""))
        .filter(Boolean)
        .join("\n");
    }
  }
  return "";
}

function stripSystemFromMessageItem(item) {
  if (!item || typeof item !== "object") return item;
  const role = typeof item.role === "string" ? item.role.toLowerCase().trim() : "";
  if (SYSTEM_ROLES.has(role)) return null;

  const keepIfEmpty = role === "tool" || (Array.isArray(item.tool_calls) && item.tool_calls.length > 0);

  if (typeof item.content === "string") {
    const cleaned = stripEmbeddedSystemTags(item.content);
    if (!cleaned && !keepIfEmpty) return null;
    return cleaned === item.content ? item : { ...item, content: cleaned };
  }

  if (Array.isArray(item.content)) {
    let changed = false;
    const cleanedParts = [];
    for (const part of item.content) {
      if (typeof part === "string") {
        const cleaned = stripEmbeddedSystemTags(part);
        if (cleaned !== part) changed = true;
        if (cleaned) cleanedParts.push(cleaned);
      } else if (part && typeof part === "object" && typeof part.text === "string") {
        const cleaned = stripEmbeddedSystemTags(part.text);
        if (cleaned !== part.text) changed = true;
        if (cleaned) cleanedParts.push(cleaned === part.text ? part : { ...part, text: cleaned });
      } else if (part !== null && part !== undefined) {
        cleanedParts.push(part);
      }
    }
    if (cleanedParts.length === 0 && !keepIfEmpty) return null;
    return changed ? { ...item, content: cleanedParts } : item;
  }

  if (item.content && typeof item.content === "object" && typeof item.content.text === "string") {
    const cleaned = stripEmbeddedSystemTags(item.content.text);
    if (!cleaned && !keepIfEmpty) return null;
    return cleaned === item.content.text ? item : { ...item, content: { ...item.content, text: cleaned } };
  }

  return item;
}

function stripSystemFromMessageList(list) {
  if (!Array.isArray(list)) return list;
  const out = [];
  let seenKeptNonSystem = false;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const role = typeof item.role === "string" ? item.role.toLowerCase().trim() : "";
    if (SYSTEM_ROLES.has(role)) continue;

    if (!seenKeptNonSystem && (role === "user" || role === "")) {
      const rawText = extractTextFromContent(item.content !== undefined ? item.content : item.parts);
      if (isMasqueradedUserSystemPrompt(rawText)) continue;
    }

    const cleaned = stripSystemFromMessageItem(item);
    if (cleaned) {
      seenKeptNonSystem = true;
      out.push(cleaned);
    }
  }
  return out;
}

function stripSystemFromGeminiContents(contents) {
  if (!Array.isArray(contents)) return contents;
  const out = [];
  let seenKeptNonSystem = false;
  for (const item of contents) {
    if (!item || typeof item !== "object") continue;
    const role = typeof item.role === "string" ? item.role.toLowerCase().trim() : "";
    if (SYSTEM_ROLES.has(role)) continue;

    if (!seenKeptNonSystem && (role === "user" || role === "")) {
      const rawText = extractTextFromContent(item.parts !== undefined ? item.parts : item.content);
      if (isMasqueradedUserSystemPrompt(rawText)) continue;
    }

    if (Array.isArray(item.parts)) {
      const parts = [];
      for (const p of item.parts) {
        if (p && typeof p === "object" && typeof p.text === "string") {
          const cleaned = stripEmbeddedSystemTags(p.text);
          if (cleaned) parts.push(cleaned === p.text ? p : { ...p, text: cleaned });
        } else if (p !== null && p !== undefined) {
          parts.push(p);
        }
      }
      if (parts.length > 0) {
        seenKeptNonSystem = true;
        out.push({ ...item, parts });
      }
    } else {
      seenKeptNonSystem = true;
      out.push(item);
    }
  }
  return out;
}

/**
 * Strip client system prompts and embedded system-message tags from a request body
 * strictly for ACP execution. Returns a new object and never mutates the caller's body
 * (preserving system prompts for non-ACP providers and combo fallback legs).
 */
export function stripSystemMessagesForAcp(body) {
  if (!body || typeof body !== "object") return body;

  const clone = { ...body };
  delete clone.system;
  delete clone.instructions;
  delete clone.systemInstruction;
  delete clone.system_instruction;

  if (clone.request && typeof clone.request === "object") {
    const reqClone = { ...clone.request };
    delete reqClone.systemInstruction;
    delete reqClone.system_instruction;
    if (Array.isArray(reqClone.contents)) {
      const stripped = stripSystemFromGeminiContents(reqClone.contents);
      if (stripped.length > 0) {
        reqClone.contents = stripped;
      } else if (reqClone.contents.length > 0) {
        return body;
      }
    }
    clone.request = reqClone;
  }

  if (Array.isArray(clone.messages)) {
    const stripped = stripSystemFromMessageList(clone.messages);
    if (stripped.length > 0) {
      clone.messages = stripped;
    } else if (clone.messages.length > 0) {
      return body;
    }
  }

  if (Array.isArray(clone.input)) {
    const stripped = stripSystemFromMessageList(clone.input);
    if (stripped.length > 0) {
      clone.input = stripped;
    } else if (clone.input.length > 0) {
      return body;
    }
  }

  if (Array.isArray(clone.contents)) {
    const stripped = stripSystemFromGeminiContents(clone.contents);
    if (stripped.length > 0) {
      clone.contents = stripped;
    } else if (clone.contents.length > 0) {
      return body;
    }
  }

  return clone;
}

// Helper: Extract text from messages array
export function extractPromptText(messages, options = {}) {
  const stripSystem = options.stripSystemPrompt !== false;
  const parts = [];
  const systemParts = [];

  // Handle top-level system prompt if provided (Claude body.system, Responses body.instructions, Gemini systemInstruction)
  const topLevelSystem = options.system ?? options.instructions ?? options.systemInstruction ?? options.system_instruction;
  if (topLevelSystem) {
    const sysContent = extractTextFromContent(topLevelSystem);
    if (sysContent) {
      systemParts.push(sysContent);
      if (!stripSystem) {
        parts.push(`System instructions:\n${sysContent}`);
      }
    }
  }

  if (Array.isArray(messages)) {
    let seenKeptTurn = false;
    for (const m of messages) {
      if (!m) continue;
      const role = typeof m.role === "string" ? m.role.toLowerCase().trim() : "user";
      const rawContent = extractTextFromContent(m.content !== undefined ? m.content : m.parts);
      if (!rawContent) continue;

      if (SYSTEM_ROLES.has(role)) {
        systemParts.push(rawContent);
        if (!stripSystem) {
          parts.push(`System instructions:\n${rawContent}`);
        }
      } else if (stripSystem && !seenKeptTurn && (role === "user" || role === "") && isMasqueradedUserSystemPrompt(rawContent)) {
        systemParts.push(rawContent);
      } else {
        const content = stripSystem ? stripEmbeddedSystemTags(rawContent) : rawContent;
        if (!content) {
          systemParts.push(rawContent);
          continue;
        }
        seenKeptTurn = true;
        if (role === "assistant" || role === "model") {
          parts.push(`Assistant: ${content}`);
        } else {
          parts.push(`User: ${content}`);
        }
      }
    }
  }

  // If stripping system prompt left no content at all, fallback to system content
  if (parts.length === 0 && systemParts.length > 0) {
    return systemParts.join("\n\n");
  }

  return parts.join("\n\n");
}

function extractResultText(result) {
  if (!result) return "";
  if (typeof result.content === "string") return result.content;
  if (typeof result.text === "string") return result.text;
  const msg = result.message;
  if (msg && typeof msg.content === "string") return msg.content;
  const msgs = result.messages;
  if (Array.isArray(msgs)) {
    return msgs
      .filter((m) => m?.role === "assistant")
      .map((m) => String(m.content || ""))
      .join("\n");
  }
  return "";
}

/**
 * AcpExecutor — runs Agent Client Protocol (ACP) servers over stdio
 */
export class AcpExecutor extends BaseExecutor {
  constructor(provider = "acp") {
    super(provider, { baseUrl: "acp://stdio", noAuth: true });
  }

  async execute(opts, maybeCredentials, urlIndex = 0, maybeSignal = null) {
    const model = opts?.model;
    const body = opts?.body || opts || {};
    const messages = body?.messages || opts?.messages;
    const credentials = opts?.credentials || maybeCredentials;
    const signal = opts?.signal || maybeSignal;

    const specificData = credentials?.providerSpecificData || {};
    let command = specificData.command;
    const homeDir = process.env.HOME || "";
    const defaultAgyBin = join(homeDir, ".gemini", "bin", "agy");
    if (!command || command === "agy") {
      if (existsSync(defaultAgyBin)) {
        command = defaultAgyBin;
      } else {
        command = command || "agy";
      }
    }

    const args = Array.isArray(specificData.args)
      ? specificData.args
      : (typeof specificData.args === "string" ? specificData.args.trim().split(/\s+/).filter(Boolean) : ["acp"]);
    const customEnv = specificData.env || {};

    const stripSystemPrompt = resolveAcpStripSystemPrompt(credentials);

    const promptText = extractPromptText(messages || body.input || body.contents, {
      stripSystemPrompt,
      system: body.system,
      instructions: body.instructions,
      systemInstruction: body.systemInstruction || body.system_instruction,
    });
    const cleanModel = (model || "").includes("/") ? model.split("/").pop() : model;
    const workspaceCwd = process.cwd();

    const geminiBinDir = join(homeDir, ".gemini", "bin");
    const localBinDir = join(homeDir, ".local", "bin");
    const { env: spawnEnv, w2Proxy } = await buildAcpProcessEnv(
      {
        ...process.env,
        PATH: `${geminiBinDir}:${localBinDir}:${process.env.PATH || ""}`,
      },
      customEnv,
      { requestLogId: opts?.requestLogId || null }
    );
    if (w2Proxy.active) {
      dbg("ACP", `proxy active (${w2Proxy.mode || "w2"}: ${w2Proxy.url}, log=${w2Proxy.requestLogId || "-"}) — routing ACP outbound traffic through proxy`);
    }

    let child = null;
    let isStreamClosed = false;

    const sseStream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        let stdinClosed = false;
        let finished = false;

        const emit = (data) => {
          if (isStreamClosed || finished) return false;
          try {
            controller.enqueue(enc.encode(data));
            return true;
          } catch {
            isStreamClosed = true;
            return false;
          }
        };

        const closeController = () => {
          if (isStreamClosed) return;
          isStreamClosed = true;
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        };

        const terminateChild = () => {
          if (!stdinClosed && child?.stdin && !child.stdin.destroyed) {
            try {
              child.stdin.end();
            } catch {
              /* ignore */
            }
            stdinClosed = true;
          }
          if (child && !child.killed) {
            try {
              child.kill("SIGTERM");
            } catch {
              /* ignore */
            }
          }
        };

        child = spawn(command, args, {
          env: spawnEnv,
          cwd: workspaceCwd,
          stdio: ["pipe", "pipe", "pipe"],
          shell: process.platform === "win32",
        });

        child.on("error", (err) => {
          const msg = `ACP server spawn error (${command}): ${err.message}`;
          dbg("ACP", msg);
          if (!finished && !isStreamClosed) {
            emit(`data: ${JSON.stringify({ error: { message: msg, type: "acp_error", code: "spawn_failed" } })}\n\n`);
            emit("data: [DONE]\n\n");
            closeController();
          }
          finished = true;
          terminateChild();
        });

        if (signal) {
          signal.addEventListener("abort", () => {
            isStreamClosed = true;
            finished = true;
            terminateChild();
          });
        }

        let idCounter = 1;
        let initReqId = null;
        let newSessionReqId = null;
        let setModelReqId = null;
        let setConfigReqId = null;
        let promptReqId = null;
        let sessionId = null;
        const responseId = `chatcmpl-acp-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        let roleEmitted = false;
        let totalText = "";

        const sendRpc = (method, params) => {
          if (stdinClosed || child.stdin.destroyed) return null;
          const id = idCounter++;
          try {
            child.stdin.write(rpc(method, params, id));
          } catch {
            /* ignore */
          }
          return id;
        };

        const emitDelta = (delta) => {
          if (!roleEmitted) {
            emit(
              `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
              })}\n\n`
            );
            roleEmitted = true;
          }
          totalText += delta;
          emit(
            `data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
            })}\n\n`
          );
        };

        const finish = (error, finishReason = "stop") => {
          if (finished || isStreamClosed) return;

          // Emit the terminal chunks before flipping `finished` — emit() refuses to
          // write once `finished` is set, which would drop finish_reason/[DONE].
          if (!isStreamClosed) {
            if (error) {
              emit(`data: ${JSON.stringify({ error: { message: error, type: "acp_error" } })}\n\n`);
            } else {
              if (!roleEmitted) {
                emit(
                  `data: ${JSON.stringify({
                    id: responseId,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [{ index: 0, delta: { role: "assistant", content: totalText }, finish_reason: null }],
                  })}\n\n`
                );
                roleEmitted = true;
              }
              emit(
                `data: ${JSON.stringify({
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                })}\n\n`
              );
            }
            emit("data: [DONE]\n\n");
            closeController();
          }

          finished = true;
          terminateChild();
        };

        // ── Stdout reader (line-buffered JSON-RPC) ─────────────────────────
        let stdoutBuf = "";
        child.stdout.on("data", (chunk) => {
          stdoutBuf += chunk.toString("utf8");
          const lines = stdoutBuf.split("\n");
          stdoutBuf = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            let msg;
            try {
              msg = JSON.parse(line);
            } catch {
              continue;
            }

            // 1. Initialize response
            if (initReqId && msg.id === initReqId) {
              if (msg.error) {
                finish(`ACP initialize error: ${msg.error.message || JSON.stringify(msg.error)}`);
                return;
              }
              newSessionReqId = sendRpc("session/new", {
                cwd: workspaceCwd,
                mcpServers: [],
              });
              continue;
            }

            // 2. session/new response → get sessionId
            if (newSessionReqId && msg.id === newSessionReqId) {
              if (msg.error) {
                finish(`ACP session/new error: ${msg.error.message || JSON.stringify(msg.error)}`);
                return;
              }
              const res = msg.result || {};
              sessionId = res.sessionId || null;
              if (!sessionId) {
                finish("ACP server session/new returned no sessionId");
                return;
              }
              if (cleanModel) {
                setModelReqId = sendRpc("session/set_model", {
                  sessionId,
                  modelId: cleanModel,
                });
              } else {
                promptReqId = sendRpc("session/prompt", {
                  sessionId,
                  prompt: [{ type: "text", text: promptText }],
                });
              }
              continue;
            }

            // 2a. session/set_model response (fallback to session/set_config_option if unsupported)
            if (setModelReqId && msg.id === setModelReqId) {
              if (msg.error) {
                setConfigReqId = sendRpc("session/set_config_option", {
                  sessionId,
                  configId: "model",
                  value: cleanModel,
                });
              } else {
                promptReqId = sendRpc("session/prompt", {
                  sessionId,
                  prompt: [{ type: "text", text: promptText }],
                });
              }
              continue;
            }

            // 2b. session/set_config_option response
            if (setConfigReqId && msg.id === setConfigReqId) {
              promptReqId = sendRpc("session/prompt", {
                sessionId,
                prompt: [{ type: "text", text: promptText }],
              });
              continue;
            }

            // 3. session/prompt response
            if (promptReqId && msg.id === promptReqId) {
              if (msg.error) {
                finish(`ACP session/prompt error: ${msg.error.message || JSON.stringify(msg.error)}`);
                return;
              }
              if (!roleEmitted) {
                const res = msg.result;
                const content = extractResultText(res);
                if (content) {
                  totalText = content;
                  emitDelta(content);
                }
              }
              finish(null, msg.result?.stopReason === "end_turn" ? "stop" : (msg.result?.stopReason || "stop"));
              return;
            }

            // 4. Notifications (session/update)
            if (msg.method === "session/update" || msg.method === "$/update") {
              const params = msg.params || {};
              const update = params.update || {};
              const type = update.sessionUpdate || update.type || params.type;

              if (type === "agent_message_chunk" || type === "message_delta" || type === "text_delta" || type === "content_delta") {
                const contentField = update.content !== undefined ? update.content : params.content;
                const deltaText =
                  typeof contentField === "string"
                    ? contentField
                    : (contentField?.text ?? update.delta ?? params.delta ?? params.text ?? "");
                if (deltaText) emitDelta(deltaText);
              } else if (type === "message_stop" || type === "stop" || type === "done") {
                finish();
                return;
              } else if (type === "error") {
                finish(String(params.message || params.error || update.error || "ACP Agent error"));
                return;
              }
              continue;
            }

            // 5. Server-to-client request (e.g. permission or confirmation prompt)
            if (msg.method && msg.id) {
              try {
                child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome: "accept" } }) + "\n");
              } catch {}
              continue;
            }

            if (msg.error) {
              finish(`ACP error ${msg.error.code}: ${msg.error.message}`);
              return;
            }
          }
        });

        child.stderr.on("data", (chunk) => {
          dbg("ACP", `stderr: ${chunk.toString("utf8").slice(0, 200)}`);
        });

        child.on("close", (code) => {
          if (!finished && !isStreamClosed) {
            finish(roleEmitted ? undefined : `ACP server process exited with code ${code}`);
          }
        });

        // Send initial handshake
        initReqId = sendRpc("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "9router", version: "1.0.0" },
        });
      },
      cancel() {
        isStreamClosed = true;
        if (child) {
          try {
            if (child.stdin && !child.stdin.destroyed) child.stdin.end();
          } catch {}
          if (!child.killed) {
            try {
              child.kill("SIGTERM");
            } catch {}
          }
        }
      },
    });

    return {
      response: new Response(sseStream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      }),
      responseFormat: "openai",
      url: "acp://stdio",
      headers: {},
      transformedBody: {
        model,
        command,
        args,
        stripSystemPrompt,
        w2Proxy,
        prompt: promptText,
      },
    };
  }
}

export default AcpExecutor;
