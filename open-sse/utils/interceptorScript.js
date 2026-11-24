import vm from "node:vm";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { extractUpstreamSystemPrompt, applyUpstreamSystemPrompt } from "./w2Capture.js";

export const DEFAULT_INTERCEPTOR_SCRIPT = `/**
 * 9Router Built-in Interceptor Script
 * Runs on every upstream request captured by the Built-in Interceptor Proxy
 * (both ACP child processes like kiro-cli / agy AND direct providers like minimax / claude / openai).
 *
 * Available on ctx:
 *   ctx.url                  Full upstream URL (string)
 *   ctx.method               HTTP method ("POST", "GET", ...)
 *   ctx.headers              Mutable lowercase request headers object
 *   ctx.body                 Parsed JSON body (mutate in place or assign ctx.body = newObj)
 *   ctx.rawBody              Raw UTF-8 body string (for non-JSON requests)
 *   ctx.source               "acp-mitm" | "in-process"
 *   ctx.sysPrompt            Extracted upstream system prompt (Gemini, Kiro, Claude, OpenAI, Responses)
 *   ctx.sysFormat            "gemini-cloudcode" | "kiro" | "openai-responses" | "claude" | "openai-chat" | null
 *   ctx.setSysPrompt(text)   Helper to rewrite the upstream system prompt cleanly for any format
 *   ctx.log(...args)         Logs shown directly in /dashboard/logs -> Tab 5 (Upstream Proxy)
 */
function transformRequest(ctx) {
  // Default: passthrough (capture & inspect without altering the request).
  // Uncomment any example below and click "Save & Apply":

  // Example 1: Append an instruction to ACP / upstream system prompt
  // if (ctx.sysPrompt && ctx.sysPrompt.length > 100) {
  //   ctx.setSysPrompt(ctx.sysPrompt + "\\n\\nAlways respond concisely in Vietnamese.");
  //   ctx.log("Appended Vietnamese rule to", ctx.sysFormat);
  // }

  // Example 2: Replace a phrase inside the upstream system prompt
  // if (ctx.sysPrompt && ctx.sysPrompt.includes("old phrase")) {
  //   ctx.setSysPrompt(ctx.sysPrompt.replaceAll("old phrase", "new phrase"));
  // }

  // Example 3: Add or override an upstream header for a specific host
  // if (ctx.url.includes("minimax.io")) {
  //   ctx.headers["x-9router-tag"] = "custom";
  // }
}
`;

const DEFAULT_SCRIPT_TIMEOUT_MS = 200;
const compiledCache = new Map();
const MAX_COMPILED_CACHE = 16;

function resolveScriptBackupPath() {
  const dataDir = process.env.DATA_DIR || path.join(os.homedir(), ".9router");
  return path.join(dataDir, "interceptor-script.js");
}

export function syncInterceptorScriptBackupFile(scriptCode) {
  try {
    const filePath = resolveScriptBackupPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, scriptCode || DEFAULT_INTERCEPTOR_SCRIPT, "utf8");
    return filePath;
  } catch {
    return null;
  }
}

export function getEffectiveInterceptorScript(rawScript) {
  if (typeof rawScript === "string" && rawScript.trim().length > 0) {
    return rawScript;
  }
  return DEFAULT_INTERCEPTOR_SCRIPT;
}

export function compileInterceptorScript(sourceCode) {
  const code = getEffectiveInterceptorScript(sourceCode);
  const hash = crypto.createHash("sha256").update(code).digest("hex");
  const cached = compiledCache.get(hash);
  if (cached) return cached;

  // Wrap user code so `function transformRequest(ctx)` or `module.exports = ...` both work
  const wrapped = `(function() {\n${code}\n; return typeof transformRequest === "function" ? transformRequest : (typeof exports !== "undefined" && typeof exports.transformRequest === "function" ? exports.transformRequest : null);\n})()`;

  const script = new vm.Script(wrapped, {
    filename: "9router-interceptor-script.js",
  });

  const entry = { hash, code, script };
  if (compiledCache.size >= MAX_COMPILED_CACHE) {
    const firstKey = compiledCache.keys().next().value;
    compiledCache.delete(firstKey);
  }
  compiledCache.set(hash, entry);
  return entry;
}

function safeCloneJson(val) {
  if (val === null || val === undefined) return val;
  try {
    return JSON.parse(JSON.stringify(val));
  } catch {
    return val;
  }
}

function normalizeLowerHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== "object") return out;
  const entries = typeof headers.entries === "function"
    ? Array.from(headers.entries())
    : Object.entries(headers);
  for (const [k, v] of entries) {
    if (v === undefined || v === null) continue;
    out[String(k).toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

/**
 * Execute user JS interceptor script safely in a VM sandbox (fail-open on error/timeout).
 */
export function runInterceptorScript({
  url = "",
  method = "POST",
  headers = {},
  body = null,
  rawBody = "",
  source = "acp-mitm",
  scriptCode = "",
  timeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS,
} = {}) {
  const start = Date.now();
  const logs = [];
  const lowerHeaders = normalizeLowerHeaders(headers);
  const beforeHeadersJson = JSON.stringify(lowerHeaders);

  const isJsonBody = body !== null && body !== undefined && typeof body === "object";
  const workingBody = isJsonBody ? safeCloneJson(body) : body;
  const beforeBodyJson = isJsonBody ? JSON.stringify(workingBody) : null;
  const beforeRaw = typeof rawBody === "string" ? rawBody : "";

  const beforeSys = isJsonBody
    ? extractUpstreamSystemPrompt(workingBody)
    : { format: null, text: null, chars: 0, toolsCount: 0, upstreamModel: null };

  let sysPromptWasSet = false;
  const ctx = {
    url: String(url || ""),
    method: String(method || "GET").toUpperCase(),
    headers: { ...lowerHeaders },
    body: workingBody,
    rawBody: beforeRaw,
    source,
    sysPrompt: beforeSys.text,
    sysFormat: beforeSys.format,
    setSysPrompt(newText) {
      if (!ctx.body || typeof ctx.body !== "object") return false;
      const res = applyUpstreamSystemPrompt(ctx.body, String(newText ?? ""));
      if (res.modified) {
        sysPromptWasSet = true;
        ctx.sysPrompt = String(newText ?? "");
        ctx.sysFormat = res.format || ctx.sysFormat;
      }
      return res.modified;
    },
    log(...args) {
      if (logs.length >= 30) return;
      const line = args
        .map((a) => {
          if (typeof a === "string") return a;
          try { return JSON.stringify(a); } catch { return String(a); }
        })
        .join(" ");
      logs.push(line.slice(0, 500));
    },
  };

  try {
    const { script } = compileInterceptorScript(scriptCode);
    const sandbox = {
      console: {
        log: (...a) => ctx.log(...a),
        info: (...a) => ctx.log(...a),
        warn: (...a) => ctx.log("[WARN]", ...a),
        error: (...a) => ctx.log("[ERR]", ...a),
      },
      JSON,
      RegExp,
      URL,
      URLSearchParams,
      Date,
      Math,
      Buffer,
      exports: {},
    };
    const vmContext = vm.createContext(sandbox);
    const fn = script.runInContext(vmContext, { timeout: timeoutMs });

    if (typeof fn === "function") {
      const returned = vm.runInContext("__run(__ctx)", Object.assign(vmContext, { __run: fn, __ctx: ctx }), {
        timeout: timeoutMs,
      });
      if (returned && typeof returned === "object" && returned !== ctx) {
        if (returned.body !== undefined) ctx.body = returned.body;
        if (returned.headers && typeof returned.headers === "object") {
          ctx.headers = normalizeLowerHeaders(returned.headers);
        }
        if (typeof returned.rawBody === "string") ctx.rawBody = returned.rawBody;
      }
    }
  } catch (err) {
    return {
      modified: false,
      bodyModified: false,
      headersModified: false,
      headers: lowerHeaders,
      body: isJsonBody ? body : workingBody,
      rawBody: beforeRaw,
      beforeSysPromptChars: beforeSys.chars,
      afterSysPromptChars: beforeSys.chars,
      sysFormat: beforeSys.format,
      logs,
      error: err?.message || String(err),
      durationMs: Date.now() - start,
    };
  }

  const nextHeaders = normalizeLowerHeaders(ctx.headers);
  const headersModified = JSON.stringify(nextHeaders) !== beforeHeadersJson;

  let bodyModified = false;
  let nextRawBody = typeof ctx.rawBody === "string" ? ctx.rawBody : beforeRaw;

  if (ctx.body !== null && ctx.body !== undefined && typeof ctx.body === "object") {
    const afterBodyJson = JSON.stringify(ctx.body);
    if (afterBodyJson !== beforeBodyJson) {
      bodyModified = true;
      nextRawBody = afterBodyJson;
    }
  } else if (nextRawBody !== beforeRaw) {
    bodyModified = true;
  }

  const afterSys = ctx.body && typeof ctx.body === "object"
    ? extractUpstreamSystemPrompt(ctx.body)
    : beforeSys;

  return {
    modified: bodyModified || headersModified || sysPromptWasSet,
    bodyModified,
    headersModified,
    headers: nextHeaders,
    body: ctx.body,
    rawBody: nextRawBody,
    beforeSysPromptChars: beforeSys.chars,
    afterSysPromptChars: afterSys.chars,
    sysFormat: afterSys.format || beforeSys.format,
    logs,
    error: null,
    durationMs: Date.now() - start,
  };
}
