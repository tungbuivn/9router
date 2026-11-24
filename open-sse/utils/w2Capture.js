import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { maskHeaders, mutateRequestLog, updateRequestLogStage } from "@/lib/requestFileLogger.js";
import { getW2AutoProxyConfig, normalizeW2ProxyUrl } from "./w2Proxy.js";

const MAX_RES_PREVIEW_CHARS = 64 * 1024;

const TELEMETRY_OR_AUX_PATTERNS = [
  /play\.googleapis\.com\/log/i,
  /lh\d+\.googleusercontent\.com/i,
  /googleapis\.com\/oauth2\//i,
  /\/v1internal:(?:loadCodeAssist|fetchAvailableModels|fetchAdminControls|retrieveUserQuotaSummary|listExperiments|fetchUserInfo|writeTrajectoryAcls)/i,
  /aicode\.googleapis\.com\/v1alpha:fetchConfig/i,
  /telemetry\.[^/]+\.kiro\.dev/i,
  /auth\.desktop\.kiro\.dev/i,
  /management\.[^/]+\.kiro\.dev/i,
  /desktop-release\.q\.[^/]+\.amazonaws\.com/i,
  /cognito-identity\.[^/]+\.amazonaws\.com/i,
  /github\.com\//i,
  /telemetry/i,
  /analytics/i,
  /metrics/i,
  /sentry\.io/i,
  /datadog/i,
];

const AI_UPSTREAM_PATTERNS = [
  /streamGenerateContent/i,
  /generateContent/i,
  /\/v1\/responses(?:\?|$)/i,
  /\/v1\/chat\/completions(?:\?|$)/i,
  /\/v1\/messages(?:\?|$)/i,
  /\/v1\/completions(?:\?|$)/i,
  /\/api\/chat(?:\?|$)/i,
  /codewhisperer/i,
  /q\.us-.*amazonaws\.com/i,
  /runtime\.[^/]+\.kiro\.dev/i,
  /bedrock-runtime/i,
];

function httpRequestJson(targetUrl, { method = "GET", headers = {}, body = null, timeoutMs = 2500 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (err) {
      return reject(err);
    }

    const mod = parsed.protocol === "https:" ? https : http;
    const reqHeaders = { ...headers };
    let payloadBuf = null;
    if (body !== null && body !== undefined) {
      payloadBuf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
      reqHeaders["content-length"] = String(payloadBuf.length);
    }

    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: reqHeaders,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ statusCode: res.statusCode || 0, headers: res.headers, text, json });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error(`W2 request timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (payloadBuf) req.write(payloadBuf);
    req.end();
  });
}

function decompressBuffer(buf, contentEncoding) {
  if (!buf || buf.length === 0) return buf;
  const enc = String(contentEncoding || "").trim().toLowerCase();
  try {
    if (enc === "gzip" || enc === "x-gzip") return zlib.gunzipSync(buf);
    if (enc === "deflate") {
      try {
        return zlib.inflateSync(buf);
      } catch {
        return zlib.inflateRawSync(buf);
      }
    }
    if (enc === "br") return zlib.brotliDecompressSync(buf);
  } catch {
    // Return original buffer if decompression fails
  }
  return buf;
}

const BINARY_CONTENT_TYPE_RE =
  /^(?:application\/(?:x-protobuf|protobuf|grpc|octet-stream|pdf|zip|gzip|wasm)|image\/|audio\/|video\/|font\/)/i;
const SENSITIVE_BODY_KEYS = new Set([
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "idtoken",
  "id_token",
  "secretkey",
  "secret_key",
  "sessiontoken",
  "session_token",
  "password",
  "client_secret",
  "clientsecret",
]);

export function isBinaryContentType(contentType) {
  const ct = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (!ct) return false;
  return BINARY_CONTENT_TYPE_RE.test(ct);
}

export function looksLikeBinaryBuffer(buf) {
  if (!buf || buf.length === 0) return false;
  const sampleLen = Math.min(buf.length, 256);
  let nonPrintable = 0;
  for (let i = 0; i < sampleLen; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 0x09 || (b > 0x0d && b < 0x20)) nonPrintable++;
  }
  return nonPrintable / sampleLen > 0.15;
}

export function redactSensitivePayload(value, depth = 0) {
  if (value === null || value === undefined || depth > 8) return value;
  if (Array.isArray(value)) return value.map((item) => redactSensitivePayload(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_BODY_KEYS.has(k.toLowerCase()) && typeof v === "string" && v.length > 0) {
        out[k] = v.length > 12 ? `${v.slice(0, 6)}...${v.slice(-4)}` : "[REDACTED]";
      } else {
        out[k] = redactSensitivePayload(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/**
 * Decode AWS EventStream binary framing (`application/vnd.amazon.eventstream`, used by Kiro / Bedrock)
 * into clean JSON events + concatenated assistantText instead of garbled UTF-8 binary bytes.
 */
export function decodeAwsEventStream(buf) {
  if (!buf || buf.length < 16) return null;
  const events = [];
  const textParts = [];
  let offset = 0;

  while (offset + 16 <= buf.length) {
    const totalLen = buf.readUInt32BE(offset);
    const headersLen = buf.readUInt32BE(offset + 4);
    if (totalLen < 16 || offset + totalLen > buf.length || headersLen > totalLen - 16) {
      break;
    }

    const headers = {};
    let hOff = offset + 12;
    const hEnd = offset + 12 + headersLen;
    while (hOff < hEnd) {
      const nameLen = buf[hOff++];
      if (hOff + nameLen > hEnd) break;
      const name = buf.subarray(hOff, hOff + nameLen).toString("utf8");
      hOff += nameLen;
      if (hOff >= hEnd) break;
      const valType = buf[hOff++];
      if (valType === 0) { headers[name] = true; }
      else if (valType === 1) { headers[name] = false; }
      else if (valType === 2) { headers[name] = buf.readInt8(hOff); hOff += 1; }
      else if (valType === 3) { headers[name] = buf.readInt16BE(hOff); hOff += 2; }
      else if (valType === 4) { headers[name] = buf.readInt32BE(hOff); hOff += 4; }
      else if (valType === 5 || valType === 8) { hOff += 8; }
      else if (valType === 6 || valType === 7) {
        if (hOff + 2 > hEnd) break;
        const vLen = buf.readUInt16BE(hOff);
        hOff += 2;
        if (hOff + vLen > hEnd) break;
        const slice = buf.subarray(hOff, hOff + vLen);
        headers[name] = valType === 7 ? slice.toString("utf8") : `[bytes:${vLen}]`;
        hOff += vLen;
      } else if (valType === 9) { hOff += 16; }
      else { break; }
    }

    const payloadStart = offset + 12 + headersLen;
    const payloadEnd = offset + totalLen - 4;
    const payloadBuf = buf.subarray(payloadStart, payloadEnd);
    const payloadText = payloadBuf.toString("utf8").trim();
    let payload = payloadText || null;
    if (payloadText.startsWith("{") || payloadText.startsWith("[")) {
      try { payload = JSON.parse(payloadText); } catch {}
    }

    if (payload && typeof payload === "object") {
      const content =
        payload.content ??
        payload.assistantResponseEvent?.content ??
        payload.delta?.text ??
        null;
      if (typeof content === "string" && content.length > 0) {
        textParts.push(content);
      }
    }

    events.push({
      eventType: headers[":event-type"] || headers[":exception-type"] || "event",
      messageType: headers[":message-type"] || "event",
      contentType: headers[":content-type"] || null,
      payload,
    });

    offset += totalLen;
  }

  if (events.length === 0) return null;
  return {
    format: "aws-eventstream",
    eventCount: events.length,
    assistantText: textParts.join(""),
    events,
  };
}

export function decodeWhistleBody(base64Str, headers = {}, fallbackBody = "") {
  const contentType = String(headers?.["content-type"] || headers?.["Content-Type"] || "").toLowerCase();
  let rawText = "";
  if (typeof base64Str === "string" && base64Str.length > 0) {
    try {
      const rawBuf = Buffer.from(base64Str, "base64");
      const decodedBuf = decompressBuffer(rawBuf, headers?.["content-encoding"] || headers?.["Content-Encoding"]);
      if (contentType.includes("application/vnd.amazon.eventstream")) {
        const decoded = decodeAwsEventStream(decodedBuf);
        if (decoded) return { text: "", json: decoded };
        return { text: "", json: { binary: true, contentType, sizeBytes: decodedBuf.length } };
      }
      if (isBinaryContentType(contentType) || looksLikeBinaryBuffer(decodedBuf)) {
        return { text: "", json: { binary: true, contentType: contentType || "application/octet-stream", sizeBytes: decodedBuf.length } };
      }
      rawText = decodedBuf.toString("utf8");
    } catch {
      rawText = "";
    }
  } else if (typeof fallbackBody === "string" && fallbackBody.length > 0) {
    rawText = fallbackBody;
  }

  if (!rawText) return { text: "", json: null };

  const trimmed = rawText.trim();
  if (contentType.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { text: rawText, json: redactSensitivePayload(JSON.parse(trimmed)) };
    } catch {
      // Not valid JSON (e.g. SSE or partial body)
    }
  }
  return { text: rawText, json: null };
}

function extractTextBlocks(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          if (typeof item.text === "string") return item.text;
          if (typeof item.content === "string") return item.content;
          if (Array.isArray(item.parts)) return extractTextBlocks(item.parts);
          if (Array.isArray(item.content)) return extractTextBlocks(item.content);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (Array.isArray(value.parts)) return extractTextBlocks(value.parts);
    if (Array.isArray(value.content)) return extractTextBlocks(value.content);
  }
  return "";
}

/**
 * Extract upstream system prompt, format, tools count, and model from any major LLM API request body.
 */
export function extractUpstreamSystemPrompt(body) {
  if (!body || typeof body !== "object") {
    return { format: null, text: null, chars: 0, toolsCount: 0, upstreamModel: null };
  }

  const upstreamModel = typeof body.model === "string" ? body.model : null;

  // 1. Antigravity / Gemini CloudCode (`request.systemInstruction` or top-level `systemInstruction`)
  const gemReq = body.request && typeof body.request === "object" ? body.request : body;
  const gemSys = gemReq.systemInstruction || gemReq.system_instruction;
  if (gemSys) {
    const text = extractTextBlocks(gemSys);
    const toolsCount = Array.isArray(gemReq.tools)
      ? gemReq.tools.reduce((n, t) => n + (Array.isArray(t?.functionDeclarations) ? t.functionDeclarations.length : 1), 0)
      : 0;
    return {
      format: body.request ? "gemini-cloudcode" : "gemini",
      text: text || null,
      chars: text.length,
      toolsCount,
      upstreamModel,
    };
  }

  // 1b. Kiro native runtime (`conversationState.history[0].userInputMessage.content`)
  const cs = body.conversationState;
  if (cs && typeof cs === "object") {
    let sysText = "";
    if (Array.isArray(cs.history)) {
      const firstUser = cs.history.find((h) => h?.userInputMessage && typeof h.userInputMessage.content === "string");
      if (firstUser) sysText = firstUser.userInputMessage.content;
    }
    const ctxTools = cs.currentMessage?.userInputMessage?.userInputMessageContext?.tools;
    const toolsCount = Array.isArray(ctxTools) ? ctxTools.length : 0;
    const kiroModel = cs.currentMessage?.userInputMessage?.modelId || upstreamModel;
    return {
      format: "kiro",
      text: sysText || null,
      chars: sysText.length,
      toolsCount,
      upstreamModel: kiroModel,
    };
  }

  // 2. Kiro / OpenAI Responses API (`instructions` and/or `input` system/developer items)
  if (typeof body.instructions === "string" || Array.isArray(body.input)) {
    const parts = [];
    if (typeof body.instructions === "string" && body.instructions.trim()) {
      parts.push(body.instructions);
    }
    if (Array.isArray(body.input)) {
      for (const item of body.input) {
        const role = String(item?.role || "").toLowerCase();
        if (role === "system" || role === "developer") {
          const t = extractTextBlocks(item.content);
          if (t) parts.push(t);
        }
      }
    }
    const text = parts.join("\n\n");
    return {
      format: "openai-responses",
      text: text || null,
      chars: text.length,
      toolsCount: Array.isArray(body.tools) ? body.tools.length : 0,
      upstreamModel,
    };
  }

  // 3. Anthropic / Claude (`system` top-level string or blocks)
  if (body.system !== undefined && body.system !== null) {
    const text = extractTextBlocks(body.system);
    return {
      format: "claude",
      text: text || null,
      chars: text.length,
      toolsCount: Array.isArray(body.tools) ? body.tools.length : 0,
      upstreamModel,
    };
  }

  // 4. OpenAI Chat Completions (`messages` with role system/developer)
  if (Array.isArray(body.messages)) {
    const parts = [];
    for (const msg of body.messages) {
      const role = String(msg?.role || "").toLowerCase();
      if (role === "system" || role === "developer") {
        const t = extractTextBlocks(msg.content);
        if (t) parts.push(t);
      }
    }
    const text = parts.join("\n\n");
    return {
      format: "openai-chat",
      text: text || null,
      chars: text.length,
      toolsCount: Array.isArray(body.tools) ? body.tools.length : 0,
      upstreamModel,
    };
  }

  return {
    format: null,
    text: null,
    chars: 0,
    toolsCount: Array.isArray(body.tools) ? body.tools.length : (Array.isArray(gemReq?.tools) ? gemReq.tools.length : 0),
    upstreamModel,
  };
}

/**
 * Rewrite upstream system prompt in place across all 5 supported LLM formats:
 *   1. Gemini CloudCode / Gemini (`request.systemInstruction.parts` or `systemInstruction.parts`)
 *   2. Kiro native (`conversationState.history[0].userInputMessage.content`)
 *   3. OpenAI Responses (`instructions` or `input` system/developer item)
 *   4. Anthropic / Claude (`system` string or text block array)
 *   5. OpenAI Chat (`messages` system/developer entry)
 */
export function applyUpstreamSystemPrompt(body, newText) {
  if (!body || typeof body !== "object") {
    return { modified: false, format: null };
  }
  const nextText = String(newText ?? "");

  // 1. Gemini CloudCode / Gemini
  const gemReq = body.request && typeof body.request === "object" ? body.request : body;
  const gemSys = gemReq.systemInstruction || gemReq.system_instruction;
  if (gemSys && typeof gemSys === "object") {
    const parts = Array.isArray(gemSys.parts) ? gemSys.parts : [];
    const nonTextParts = parts.filter((p) => !p || typeof p.text !== "string");
    gemSys.parts = [{ text: nextText }, ...nonTextParts];
    return { modified: true, format: body.request ? "gemini-cloudcode" : "gemini" };
  }

  // 2. Kiro native
  const cs = body.conversationState;
  if (cs && typeof cs === "object" && Array.isArray(cs.history)) {
    const firstUser = cs.history.find((h) => h?.userInputMessage && typeof h.userInputMessage.content === "string");
    if (firstUser) {
      firstUser.userInputMessage.content = nextText;
      return { modified: true, format: "kiro" };
    }
  }

  // 3. OpenAI Responses
  if (typeof body.instructions === "string") {
    body.instructions = nextText;
    return { modified: true, format: "openai-responses" };
  }
  if (Array.isArray(body.input)) {
    const sysItem = body.input.find((it) => it && (it.role === "system" || it.role === "developer"));
    if (sysItem) {
      sysItem.content = typeof sysItem.content === "string"
        ? nextText
        : [{ type: "input_text", text: nextText }];
      return { modified: true, format: "openai-responses" };
    }
  }

  // 4. Claude / Anthropic
  if (body.system !== undefined && body.system !== null) {
    body.system = typeof body.system === "string" ? nextText : [{ type: "text", text: nextText }];
    return { modified: true, format: "claude" };
  }

  // 5. OpenAI Chat
  if (Array.isArray(body.messages)) {
    const sysMsg = body.messages.find((m) => m && (m.role === "system" || m.role === "developer"));
    if (sysMsg) {
      sysMsg.content = nextText;
      return { modified: true, format: "openai-chat" };
    }
    body.messages.unshift({ role: "system", content: nextText });
    return { modified: true, format: "openai-chat" };
  }

  return { modified: false, format: null };
}

// Per-requestLogId serialized append queue so concurrent upstream calls never race on w2Capture
const captureAppendQueues = new Map();

/**
 * Directly append a live upstream capture (from Built-in Interceptor Proxy or in-process hook)
 * into a request's Stage 5 (`w2Capture`) on disk — exact 1-to-1 correlation without polling Whistle.
 */
export function appendUpstreamCaptureToLog(
  requestLogId,
  entry,
  { isAi = true, source = "builtin-proxy", proxyUrl = null } = {}
) {
  if (!requestLogId || !entry) return Promise.resolve(null);

  const prev = captureAppendQueues.get(requestLogId) || Promise.resolve();
  const next = prev
    .then(async () => {
      let stageData = null;
      await mutateRequestLog(requestLogId, (record) => {
        const cur = record.w2Capture || {};
        const captures = Array.isArray(cur.captures) ? [...cur.captures] : [];
        const otherRequests = Array.isArray(cur.otherRequests) ? [...cur.otherRequests] : [];

        if (isAi) {
          captures.push(entry);
          captures.sort((a, b) => {
            const sysDiff = (b.systemPromptChars || 0) - (a.systemPromptChars || 0);
            if (sysDiff !== 0) return sysDiff;
            return (b.reqSize || 0) - (a.reqSize || 0);
          });
        } else {
          otherRequests.push(entry);
        }

        const hasSystemPrompt = captures.some((c) => (c.systemPromptChars || 0) > 0);
        const anyModified = captures.some((c) => c.scriptModified === true);
        stageData = {
          timestamp: new Date().toISOString(),
          source,
          syncedAt: new Date().toISOString(),
          w2Url: proxyUrl || cur.w2Url || null,
          captureCount: captures.length,
          otherCount: otherRequests.length,
          hasSystemPrompt,
          scriptModified: anyModified,
          captures,
          otherRequests,
        };

        record.w2Capture = stageData;
        record.w2CaptureCount = captures.length;
        record.w2HasSystemPrompt = hasSystemPrompt;
        return true;
      });
      return stageData;
    })
    .catch((err) => {
      console.error("[w2Capture] appendUpstreamCaptureToLog failed:", err?.message || err);
      throw err;
    });

  const cleanup = next
    .catch(() => {})
    .finally(() => {
      if (captureAppendQueues.get(requestLogId) === cleanup) {
        captureAppendQueues.delete(requestLogId);
      }
    });
  captureAppendQueues.set(requestLogId, cleanup);
  return next;
}

export function isAiUpstreamUrl(url) {
  const u = String(url || "");
  if (!u) return false;
  if (TELEMETRY_OR_AUX_PATTERNS.some((re) => re.test(u))) return false;
  return AI_UPSTREAM_PATTERNS.some((re) => re.test(u));
}

function summarizeMatchedRules(rulesObj) {
  if (!rulesObj || typeof rulesObj !== "object") return [];
  const out = [];
  for (const [key, val] of Object.entries(rulesObj)) {
    if (!val) continue;
    if (typeof val === "string") {
      out.push(`${key}: ${val}`);
    } else if (val.raw) {
      out.push(val.raw);
    } else if (Array.isArray(val.list)) {
      for (const item of val.list) {
        if (item?.raw) out.push(item.raw);
      }
    } else if (val.matcher) {
      out.push(val.matcher);
    }
  }
  return Array.from(new Set(out));
}

export async function fetchW2RawCaptures(w2Url = null, count = 60, timeoutMs = 2000) {
  const baseUrl = normalizeW2ProxyUrl(w2Url || getW2AutoProxyConfig().url);
  const res = await httpRequestJson(`${baseUrl}/cgi-bin/get-data?count=${encodeURIComponent(String(count))}`, {
    method: "GET",
    timeoutMs,
  });
  if (res.statusCode < 200 || res.statusCode >= 300 || !res.json) {
    throw new Error(`Failed to fetch w2 captures (HTTP ${res.statusCode})`);
  }
  const map = res.json?.data?.data || {};
  return Object.values(map);
}

/**
 * Pull and decode Whistle (w2) captured upstream requests matching a 9Router request's time window.
 */
export async function pullW2CapturesForWindow({
  w2Url = null,
  startTime,
  endTime = Date.now(),
  count = 60,
  timeoutMs = 2000,
} = {}) {
  const baseUrl = normalizeW2ProxyUrl(w2Url || getW2AutoProxyConfig().url);
  const entries = await fetchW2RawCaptures(baseUrl, count, timeoutMs);

  const windowStart = (Number(startTime) || Date.now() - 10000) - 500;
  const windowEnd = (Number(endTime) || Date.now()) + 2000;

  const matched = entries
    .filter((entry) => {
      const ts = Number(entry?.startTime || 0);
      if (!ts) return false;
      return ts >= windowStart && ts <= windowEnd;
    })
    .sort((a, b) => (a.startTime || 0) - (b.startTime || 0));

  const captures = [];
  const otherRequests = [];

  for (const entry of matched) {
    const url = entry?.url || "";
    const method = entry?.req?.method || "GET";
    const statusCode = entry?.res?.statusCode ?? null;
    const reqSize = entry?.req?.size ?? 0;
    const resSize = entry?.res?.size ?? 0;
    const durationMs = entry?.endTime && entry?.startTime ? Math.max(0, entry.endTime - entry.startTime) : null;

    if (!isAiUpstreamUrl(url)) {
      otherRequests.push({
        id: entry.id,
        method,
        url,
        statusCode,
        reqSize,
        resSize,
        durationMs,
      });
      continue;
    }

    const reqHeaders = entry?.req?.headers || {};
    const resHeaders = entry?.res?.headers || {};
    const decodedReq = decodeWhistleBody(entry?.req?.base64, reqHeaders, entry?.req?.body);
    const decodedRes = decodeWhistleBody(entry?.res?.base64, resHeaders, entry?.res?.body);
    const sysInfo = extractUpstreamSystemPrompt(decodedReq.json);

    let resPreview = decodedRes.json ?? decodedRes.text ?? null;
    if (typeof resPreview === "string" && resPreview.length > MAX_RES_PREVIEW_CHARS) {
      resPreview = `${resPreview.slice(0, MAX_RES_PREVIEW_CHARS)}\n... [truncated ${resPreview.length - MAX_RES_PREVIEW_CHARS} chars]`;
    }

    captures.push({
      id: entry.id,
      startTime: entry.startTime,
      endTime: entry.endTime || null,
      durationMs,
      method,
      url,
      statusCode,
      reqSize,
      resSize,
      rules: summarizeMatchedRules(entry.rules),
      reqHeaders: maskHeaders(reqHeaders),
      resHeaders: maskHeaders(resHeaders),
      upstreamModel: sysInfo.upstreamModel,
      systemPromptFormat: sysInfo.format,
      systemPromptChars: sysInfo.chars,
      systemPrompt: sysInfo.text,
      toolsCount: sysInfo.toolsCount,
      reqBody: decodedReq.json ?? (decodedReq.text || null),
      resPreview,
    });
  }

  // Sort captures so the primary generation call (with systemPrompt / largest body) comes first
  captures.sort((a, b) => {
    const sysDiff = (b.systemPromptChars || 0) - (a.systemPromptChars || 0);
    if (sysDiff !== 0) return sysDiff;
    return (b.reqSize || 0) - (a.reqSize || 0);
  });

  const hasSystemPrompt = captures.some((c) => (c.systemPromptChars || 0) > 0);

  return {
    syncedAt: new Date().toISOString(),
    w2Url: baseUrl,
    window: { startTime: windowStart, endTime: windowEnd },
    captureCount: captures.length,
    otherCount: otherRequests.length,
    hasSystemPrompt,
    captures,
    otherRequests,
  };
}

/**
 * Non-blocking post-response sync: waits briefly for Whistle to flush the entry,
 * then pulls w2 captures and writes Stage 5 (`w2Capture`) into the request's disk JSON file.
 */
export function scheduleW2CaptureSync({
  requestLogId,
  w2Url = null,
  startTime,
  endTime = Date.now(),
  delayMs = 300,
} = {}) {
  if (!requestLogId) return;
  setTimeout(async () => {
    try {
      const result = await pullW2CapturesForWindow({ w2Url, startTime, endTime });
      if (result.captureCount > 0 || result.otherCount > 0) {
        await updateRequestLogStage(requestLogId, "w2Capture", result, {
          w2CaptureCount: result.captureCount,
          w2HasSystemPrompt: result.hasSystemPrompt,
        });
      }
    } catch {
      // Never fail or crash if Whistle stopped mid-request
    }
  }, delayMs);
}

/**
 * Check whether a script (e.g. "9router-sysprompt") is installed in Whistle's whistle.script plugin.
 */
export async function getW2ScriptStatus(w2Url = null, scriptName = "9router-sysprompt", timeoutMs = 2000) {
  const baseUrl = normalizeW2ProxyUrl(w2Url || getW2AutoProxyConfig().url);
  const res = await httpRequestJson(`${baseUrl}/plugin.script/cgi-bin/init`, {
    method: "GET",
    timeoutMs,
  });
  if (res.statusCode < 200 || res.statusCode >= 300 || !res.json) {
    return {
      w2Reachable: false,
      pluginAvailable: false,
      installed: false,
      scriptName,
      editorUrl: `${baseUrl}/plugin.script/`,
      rulesUrl: `${baseUrl}/#rules`,
    };
  }
  const list = Array.isArray(res.json.list) ? res.json.list : [];
  const found = list.find((item) => item?.name === scriptName);
  return {
    w2Reachable: true,
    pluginAvailable: true,
    installed: Boolean(found),
    scriptName,
    scriptLength: found?.value ? found.value.length : 0,
    existingScripts: list.map((i) => i.name).filter(Boolean),
    editorUrl: `${baseUrl}/plugin.script/`,
    rulesUrl: `${baseUrl}/#rules`,
  };
}

/**
 * Install/update a script in Whistle's whistle.script plugin and optionally register a Whistle rule group
 * without overwriting or disabling any existing user scripts/rules (such as `kiro9`).
 */
export async function installW2ScriptPlugin({
  w2Url = null,
  scriptName = "9router-sysprompt",
  scriptContent,
  ruleName = "9router-acp-sysprompt",
  ruleContent = "",
  enableRule = false,
  timeoutMs = 3000,
} = {}) {
  const baseUrl = normalizeW2ProxyUrl(w2Url || getW2AutoProxyConfig().url);
  if (!scriptContent) throw new Error("scriptContent is required");

  // 1. Push script into whistle.script
  const scriptRes = await httpRequestJson(`${baseUrl}/plugin.script/cgi-bin/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: scriptName, value: scriptContent }),
    timeoutMs,
  });
  if (scriptRes.statusCode < 200 || scriptRes.statusCode >= 300 || scriptRes.json?.ec !== 0) {
    throw new Error(`Failed to install whistle.script '${scriptName}' (HTTP ${scriptRes.statusCode})`);
  }

  // 2. Register rule group in Whistle (does not overwrite other rule groups)
  let ruleRegistered = false;
  let ruleSelected = false;
  if (ruleName && ruleContent) {
    const form = new URLSearchParams({
      name: ruleName,
      value: ruleContent,
      clientId: "9router",
    }).toString();

    const addRes = await httpRequestJson(`${baseUrl}/cgi-bin/rules/add`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
      timeoutMs,
    });
    ruleRegistered = addRes.statusCode >= 200 && addRes.statusCode < 300 && addRes.json?.ec === 0;

    if (ruleRegistered && enableRule) {
      const selRes = await httpRequestJson(`${baseUrl}/cgi-bin/rules/select`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
        timeoutMs,
      });
      ruleSelected = selRes.statusCode >= 200 && selRes.statusCode < 300 && selRes.json?.ec === 0;
    }
  }

  return {
    success: true,
    w2Url: baseUrl,
    scriptName,
    ruleName,
    ruleRegistered,
    ruleSelected,
    editorUrl: `${baseUrl}/plugin.script/`,
    rulesUrl: `${baseUrl}/#rules`,
  };
}
