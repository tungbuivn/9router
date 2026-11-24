import { createRequestLog, updateRequestLogStage, maskHeaders } from "./requestFileLogger.js";
import { scheduleW2CaptureSync } from "open-sse/utils/w2Capture.js";
import { getW2AutoProxyConfig } from "open-sse/utils/w2Proxy.js";
import { isBuiltinProxyActive } from "open-sse/utils/builtinProxy.js";
import { runWithRequestLogId } from "open-sse/utils/requestLogContext.js";

const MAX_TEXT_PREVIEW_CHARS = 64 * 1024;
const MAX_BASE64_KEEP_CHARS = 16 * 1024;
const VECTOR_COMPACT_THRESHOLD = 32;

function formatCompactSize(chars) {
  if (chars < 1024) return `${chars} chars`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(2)} MB`;
}

function looksLikeBase64OrDataUrl(str) {
  if (typeof str !== "string" || str.length <= MAX_BASE64_KEEP_CHARS) return false;
  if (str.startsWith("data:")) return true;
  // Sample prefix to check base64 alphabet without scanning megabytes
  const sample = str.slice(0, 256);
  return /^[A-Za-z0-9+/=_-]+$/.test(sample);
}

/**
 * Compact huge numeric embedding vectors and huge base64 blobs so per-request JSON files
 * remain fast, readable, and lightweight on disk while preserving all regular fields intact.
 */
export function compactPayloadForLog(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 12) return "[max depth]";

  if (typeof value === "string") {
    if (looksLikeBase64OrDataUrl(value)) {
      return `[base64/data omitted: ${formatCompactSize(value.length)}]`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (
      value.length > VECTOR_COMPACT_THRESHOLD &&
      typeof value[0] === "number" &&
      typeof value[1] === "number" &&
      typeof value[value.length - 1] === "number"
    ) {
      const sample = value.slice(0, 3).map((n) => Number(n.toFixed ? n.toFixed(4) : n)).join(", ");
      return `[float[${value.length}] vector, sample: ${sample}, ...]`;
    }
    return value.map((item) => compactPayloadForLog(item, depth + 1));
  }

  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (
        (k === "b64_json" || k === "b64" || k === "audio" || k === "data") &&
        typeof v === "string" &&
        v.length > MAX_BASE64_KEEP_CHARS
      ) {
        out[k] = `[${k} omitted: ${formatCompactSize(v.length)}]`;
      } else {
        out[k] = compactPayloadForLog(v, depth + 1);
      }
    }
    return out;
  }

  return value;
}

async function extractRequestBodyForLog(request, method, query) {
  if (method === "GET" || method === "HEAD" || method === "DELETE") {
    return Object.keys(query).length > 0 ? { query } : null;
  }

  const contentType = String(request.headers?.get("content-type") || "").toLowerCase();

  try {
    const cloned = request.clone();

    if (contentType.includes("multipart/form-data")) {
      const formData = await cloned.formData();
      const fields = {};
      for (const [key, val] of formData.entries()) {
        if (val && typeof val === "object" && typeof val.arrayBuffer === "function") {
          fields[key] = {
            _file: true,
            fileName: val.name || "upload",
            mimeType: val.type || "application/octet-stream",
            sizeBytes: val.size ?? null,
          };
        } else {
          fields[key] = val;
        }
      }
      return { _multipart: true, fields, ...(Object.keys(query).length > 0 ? { query } : {}) };
    }

    if (contentType.includes("application/json") || contentType === "") {
      const text = await cloned.text();
      if (!text) return Object.keys(query).length > 0 ? { query } : null;
      try {
        const parsed = JSON.parse(text);
        return compactPayloadForLog(parsed);
      } catch {
        return { _rawText: text.slice(0, MAX_TEXT_PREVIEW_CHARS) };
      }
    }

    const text = await cloned.text();
    return {
      _contentType: contentType,
      _rawText: text.slice(0, MAX_TEXT_PREVIEW_CHARS),
    };
  } catch {
    return Object.keys(query).length > 0 ? { query } : null;
  }
}

async function extractResponseForLog(response) {
  const statusCode = response?.status ?? 200;
  const resHeaders = response?.headers ? maskHeaders(response.headers) : {};
  const contentType = String(response?.headers?.get("content-type") || "").toLowerCase();

  if (contentType.includes("text/event-stream")) {
    return {
      statusCode,
      type: "streaming",
      resHeaders,
      clientResponse: { streaming: true, contentType },
      error: statusCode >= 400 ? `HTTP ${statusCode}` : null,
    };
  }

  const isBinary =
    contentType.startsWith("audio/") ||
    contentType.startsWith("image/") ||
    contentType.startsWith("video/") ||
    contentType.includes("application/octet-stream");

  try {
    const cloned = response.clone();
    if (isBinary) {
      const buf = await cloned.arrayBuffer();
      return {
        statusCode,
        type: "binary",
        resHeaders,
        clientResponse: {
          binary: true,
          contentType,
          sizeBytes: buf.byteLength,
        },
        error: statusCode >= 400 ? `HTTP ${statusCode}` : null,
      };
    }

    const text = await cloned.text();
    if (contentType.includes("application/json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        const compacted = compactPayloadForLog(parsed);
        const errMsg =
          statusCode >= 400
            ? (parsed?.error?.message || (typeof parsed?.error === "string" ? parsed.error : null) || `HTTP ${statusCode}`)
            : null;
        return {
          statusCode,
          type: "json",
          resHeaders,
          clientResponse: compacted,
          error: errMsg,
        };
      } catch {
        // Fall through to plain text
      }
    }

    const preview =
      text.length > MAX_TEXT_PREVIEW_CHARS
        ? `${text.slice(0, MAX_TEXT_PREVIEW_CHARS)}\n... [truncated ${text.length - MAX_TEXT_PREVIEW_CHARS} chars]`
        : text;
    return {
      statusCode,
      type: "text",
      resHeaders,
      content: preview,
      clientResponse: preview ? { text: preview } : null,
      error: statusCode >= 400 ? (preview.slice(0, 300) || `HTTP ${statusCode}`) : null,
    };
  } catch {
    return {
      statusCode,
      type: "unknown",
      resHeaders,
      clientResponse: null,
      error: statusCode >= 400 ? `HTTP ${statusCode}` : null,
    };
  }
}

function splitModelHint(modelStr) {
  if (!modelStr || typeof modelStr !== "string") return { provider: null, model: null };
  const slash = modelStr.indexOf("/");
  if (slash > 0) {
    return { provider: modelStr.slice(0, slash), model: modelStr.slice(slash + 1) };
  }
  return { provider: null, model: modelStr };
}

/**
 * Higher-order wrapper for Next.js App Router API handlers (non-chat `/v1/*` & `/v1beta/*`).
 * Persists incoming request + response to the 100-file rolling disk JSON store (`requestFileLogger`)
 * without consuming or blocking the handler's request/response streams.
 */
export function withApiRequestLog(handler, options = {}) {
  const {
    apiType = "api",
    syncW2 = false,
    shouldSkip = null,
    extractModel = null,
  } = options;

  return async function wrappedApiHandler(request, context) {
    if (shouldSkip && shouldSkip(request, context)) {
      return handler(request, context);
    }

    const startTime = Date.now();
    const method = request?.method || "GET";
    let endpoint = "";
    let query = {};
    try {
      const url = new URL(request.url);
      endpoint = url.pathname;
      query = Object.fromEntries(url.searchParams.entries());
    } catch {
      endpoint = "";
    }

    const headers = request?.headers ? Object.fromEntries(request.headers.entries()) : {};
    const reqBody = await extractRequestBodyForLog(request, method, query);

    let clientModel =
      reqBody?.model ||
      reqBody?.fields?.model ||
      query.model ||
      query.id ||
      (extractModel ? await Promise.resolve(extractModel(request, context, reqBody)).catch(() => null) : null) ||
      null;

    const { provider, model } = splitModelHint(clientModel);

    let requestLogId = null;
    try {
      const created = await createRequestLog({
        method,
        endpoint,
        headers,
        body: reqBody,
        clientModel,
        detectedFormat: apiType,
        apiType,
      });
      requestLogId = created.id;
    } catch {
      // Logging must never break API requests
    }

    let response;
    try {
      response = await runWithRequestLogId(requestLogId, () => handler(request, context));
    } catch (err) {
      const total = Date.now() - startTime;
      if (requestLogId) {
        updateRequestLogStage(
          requestLogId,
          "response",
          {
            type: "json",
            statusCode: 500,
            error: err?.message || String(err),
          },
          {
            status: "error",
            statusCode: 500,
            provider,
            model,
            latency: { ttft: total, total },
          }
        ).catch(() => {});
      }
      throw err;
    }

    const total = Date.now() - startTime;
    if (requestLogId && response) {
      // Inspect cloned response asynchronously without delaying return if not needed,
      // awaiting only for small payloads so disk log is immediately ready for /dashboard/logs
      try {
        const resInfo = await extractResponseForLog(response);
        const status = resInfo.statusCode >= 400 ? "error" : "success";
        await updateRequestLogStage(
          requestLogId,
          "response",
          resInfo,
          {
            status,
            statusCode: resInfo.statusCode,
            provider,
            model,
            latency: { ttft: total, total },
          }
        ).catch(() => {});
      } catch {
        // Ignore inspection failure
      }

      if (syncW2 && !isBuiltinProxyActive()) {
        try {
          const w2Cfg = getW2AutoProxyConfig();
          if (w2Cfg.enabled) {
            scheduleW2CaptureSync({
              requestLogId,
              w2Url: w2Cfg.url,
              startTime,
              endTime: Date.now(),
            });
          }
        } catch {}
      }
    }

    return response;
  };
}
