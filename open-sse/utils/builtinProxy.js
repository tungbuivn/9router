import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { maskHeaders } from "@/lib/requestFileLogger.js";
import { isLocalTargetUrl } from "./w2Proxy.js";
import {
  extractUpstreamSystemPrompt,
  isAiUpstreamUrl,
  appendUpstreamCaptureToLog,
  decodeAwsEventStream,
  isBinaryContentType,
  looksLikeBinaryBuffer,
  redactSensitivePayload,
} from "./w2Capture.js";
export { decodeAwsEventStream };
import {
  DEFAULT_INTERCEPTOR_SCRIPT,
  getEffectiveInterceptorScript,
  runInterceptorScript,
  syncInterceptorScriptBackupFile,
} from "./interceptorScript.js";
import { getCurrentRequestLogId } from "./requestLogContext.js";

export const DEFAULT_BUILTIN_PROXY_PORT = 20129;
export const DEFAULT_BUILTIN_INTERCEPT_HOSTS = ["*"];

const MAX_REQ_BUFFER_BYTES = 16 * 1024 * 1024; // 16 MB safety cap
const MAX_RES_PREVIEW_BYTES = 64 * 1024; // 64 KB preview cap
const MAX_CERT_CACHE_SIZE = 200;
const MAX_RECENT_CAPTURES = 80;

const GLOBAL_KEY = "__nineRouterBuiltinProxyState";

function getState() {
  if (!globalThis[GLOBAL_KEY]) {
    globalThis[GLOBAL_KEY] = {
      initialized: false,
      enabled: false,
      port: DEFAULT_BUILTIN_PROXY_PORT,
      scriptEnabled: true,
      script: "",
      interceptHosts: [...DEFAULT_BUILTIN_INTERCEPT_HOSTS],
      server: null,
      listeningPort: null,
      startPromise: null,
      certCache: new Map(),
      rootCA: null,
      caCertPath: null,
      caBundlePath: null,
      stats: {
        totalCaptured: 0,
        totalModified: 0,
        totalTunnelled: 0,
        activeConnections: 0,
        lastError: null,
      },
      recentCaptures: [],
    };
  }
  return globalThis[GLOBAL_KEY];
}

function normalizePort(raw) {
  const n = Number.parseInt(String(raw ?? DEFAULT_BUILTIN_PROXY_PORT), 10);
  return Number.isFinite(n) && n >= 1024 && n <= 65535 ? n : DEFAULT_BUILTIN_PROXY_PORT;
}

export function normalizeInterceptHosts(raw) {
  if (Array.isArray(raw)) {
    const cleaned = raw.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean);
    return cleaned.length > 0 ? cleaned : [...DEFAULT_BUILTIN_INTERCEPT_HOSTS];
  }
  if (typeof raw === "string") {
    const cleaned = raw
      .split(/[\n,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return cleaned.length > 0 ? cleaned : [...DEFAULT_BUILTIN_INTERCEPT_HOSTS];
  }
  return [...DEFAULT_BUILTIN_INTERCEPT_HOSTS];
}

function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function shouldInterceptHost(hostname, interceptHosts = DEFAULT_BUILTIN_INTERCEPT_HOSTS) {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (isLocalTargetUrl(`http://${host}`)) return false;

  const patterns = normalizeInterceptHosts(interceptHosts);
  for (const p of patterns) {
    if (p === "*") return true;
    if (p.startsWith("!")) {
      const neg = p.slice(1).trim();
      if (neg && wildcardToRegExp(neg).test(host)) return false;
      continue;
    }
    if (wildcardToRegExp(p).test(host)) return true;
  }
  return false;
}

function resolveMitmDir() {
  const dataDir = process.env.DATA_DIR || path.join(os.homedir(), ".9router");
  return path.join(dataDir, "mitm");
}

function loadRootCAModule() {
  const req = createRequire(import.meta.url);
  // Load existing pure-JS node-forge Root CA generator from src/mitm/cert/rootCA.js
  return req("../../src/mitm/cert/rootCA.js");
}

function findSystemCaBundle() {
  const candidates = [
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/cert.pem",
    "/etc/ssl/ca-bundle.pem",
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}

/**
 * Ensure ~/.9router/mitm/rootCA.crt exists and build combined ~/.9router/mitm/ca-bundle.pem
 * (OS system CAs + 9Router Root CA) so ACP child processes trust BOTH intercepted and public hosts.
 */
export function ensureBuiltinProxyCerts() {
  const state = getState();
  const rootCAMod = loadRootCAModule();

  const generated = rootCAMod.generateRootCA();
  const rootCA = rootCAMod.loadRootCA();
  state.rootCA = rootCA;
  state.caCertPath = generated.cert;

  const mitmDir = path.dirname(generated.cert);
  const bundlePath = path.join(mitmDir, "ca-bundle.pem");

  const rootPem = fs.readFileSync(generated.cert, "utf8").trim();
  const sysBundle = findSystemCaBundle();
  let combined = rootPem + "\n";
  if (sysBundle) {
    try {
      const sysPem = fs.readFileSync(sysBundle, "utf8").trim();
      combined = `${sysPem}\n\n# 9Router Built-in Interceptor Proxy Root CA\n${rootPem}\n`;
    } catch {}
  }

  // Only rewrite if missing or changed
  let needsWrite = true;
  try {
    if (fs.existsSync(bundlePath) && fs.readFileSync(bundlePath, "utf8") === combined) {
      needsWrite = false;
    }
  } catch {}
  if (needsWrite) {
    fs.mkdirSync(mitmDir, { recursive: true });
    fs.writeFileSync(bundlePath, combined, "utf8");
  }

  state.caBundlePath = bundlePath;
  return {
    rootCA,
    caCertPath: state.caCertPath,
    caBundlePath: state.caBundlePath,
  };
}

function getOrGenerateLeafCert(domain) {
  const state = getState();
  const key = String(domain || "").toLowerCase();
  const cached = state.certCache.get(key);
  if (cached) return cached;

  if (!state.rootCA) {
    ensureBuiltinProxyCerts();
  }
  const rootCAMod = loadRootCAModule();
  const leaf = rootCAMod.generateLeafCert(key, state.rootCA);

  if (state.certCache.size >= MAX_CERT_CACHE_SIZE) {
    const oldest = state.certCache.keys().next().value;
    state.certCache.delete(oldest);
  }
  state.certCache.set(key, leaf);
  return leaf;
}

function parseProxyAuthRequestLogId(proxyAuthHeader) {
  if (!proxyAuthHeader || typeof proxyAuthHeader !== "string") return null;
  const trimmed = proxyAuthHeader.trim();
  if (!trimmed.toLowerCase().startsWith("basic ")) return null;
  try {
    const decoded = Buffer.from(trimmed.slice(6).trim(), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 0) return null;
    const user = decoded.slice(0, colon);
    const pass = decoded.slice(colon + 1).trim();
    if (user === "9r" && pass && /^[a-zA-Z0-9_-]+$/.test(pass)) {
      return pass;
    }
  } catch {}
  return null;
}

function decompressBuffer(buf, encoding) {
  if (!buf || buf.length === 0) return buf;
  const enc = String(encoding || "").trim().toLowerCase();
  try {
    if (enc === "gzip" || enc === "x-gzip") return zlib.gunzipSync(buf);
    if (enc === "deflate") {
      try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); }
    }
    if (enc === "br") return zlib.brotliDecompressSync(buf);
  } catch {}
  return buf;
}

function decodeResponsePreview(previewBuf, resHeaders = {}, resTotalBytes = 0) {
  const ct = String(resHeaders["content-type"] || "").toLowerCase();
  if (ct.includes("application/vnd.amazon.eventstream")) {
    const decoded = decodeAwsEventStream(previewBuf);
    if (decoded) return decoded;
    return { binary: true, contentType: ct, sizeBytes: resTotalBytes };
  }
  if (isBinaryContentType(ct)) {
    return { binary: true, contentType: ct, sizeBytes: resTotalBytes };
  }
  const decompressed = decompressBuffer(previewBuf, resHeaders["content-encoding"]);
  if (looksLikeBinaryBuffer(decompressed)) {
    return { binary: true, contentType: ct || "application/octet-stream", sizeBytes: resTotalBytes };
  }
  const previewText = decompressed.toString("utf8");
  const resJson = tryParseJson(previewText, ct);
  if (resJson !== null) return redactSensitivePayload(resJson);
  return previewText || null;
}

function tryParseJson(text, contentType = "") {
  if (!text) return null;
  const trimmed = text.trim();
  if (
    String(contentType).toLowerCase().includes("json") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[")
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {}
  }
  return null;
}

function pushRecentCapture(record) {
  const state = getState();
  state.recentCaptures.unshift({
    id: record.id,
    startTime: record.startTime,
    method: record.method,
    url: record.url,
    statusCode: record.statusCode,
    reqSize: record.reqSize,
    resSize: record.resSize,
    durationMs: record.durationMs,
    source: record.source,
    scriptModified: record.scriptModified,
    systemPromptChars: record.systemPromptChars,
    requestLogId: record.requestLogId || null,
  });
  if (state.recentCaptures.length > MAX_RECENT_CAPTURES) {
    state.recentCaptures.length = MAX_RECENT_CAPTURES;
  }
}

function buildCaptureEntry({
  id,
  startTime,
  endTime,
  method,
  url,
  statusCode,
  reqSize,
  resSize,
  reqHeaders,
  resHeaders,
  reqJson,
  reqText,
  resPreview,
  source,
  scriptResult,
  requestLogId,
}) {
  const sysInfo = extractUpstreamSystemPrompt(reqJson);
  const rules = [];
  if (scriptResult?.modified) rules.push("builtin-script:modified");
  else if (scriptResult && !scriptResult.error) rules.push("builtin-script:passthrough");
  if (scriptResult?.error) rules.push("builtin-script:error");

  return {
    id,
    source,
    requestLogId: requestLogId || null,
    startTime,
    endTime,
    durationMs: Math.max(0, endTime - startTime),
    method,
    url,
    statusCode,
    reqSize,
    resSize,
    rules,
    scriptModified: Boolean(scriptResult?.modified),
    beforeSysPromptChars: scriptResult?.beforeSysPromptChars ?? sysInfo.chars,
    afterSysPromptChars: scriptResult?.afterSysPromptChars ?? sysInfo.chars,
    scriptLogs: scriptResult?.logs?.length ? scriptResult.logs : [],
    scriptError: scriptResult?.error || null,
    reqHeaders: maskHeaders(reqHeaders),
    resHeaders: maskHeaders(resHeaders),
    upstreamModel: sysInfo.upstreamModel,
    systemPromptFormat: sysInfo.format,
    systemPromptChars: sysInfo.chars,
    systemPrompt: sysInfo.text,
    toolsCount: sysInfo.toolsCount,
    reqBody: reqJson
      ? redactSensitivePayload(reqJson)
      : (typeof reqText === "object" && reqText !== null
          ? reqText
          : (reqText ? reqText.slice(0, MAX_RES_PREVIEW_BYTES) : null)),
    resPreview,
  };
}

function isAuxAmzTarget(reqHeaders = {}) {
  const target = String(reqHeaders["x-amz-target"] || "").toLowerCase();
  return target.includes("sendtelemetryevent") || target.includes("getcredentialsforidentity") || target.includes("getuserpreference") || target.includes("listavailablemodels");
}

function recordCapture({ requestLogId, entry, proxyUrl }) {
  const state = getState();
  state.stats.totalCaptured++;
  if (entry.scriptModified) state.stats.totalModified++;
  pushRecentCapture(entry);

  if (!requestLogId) return;
  const isAi =
    !isAuxAmzTarget(entry.reqHeaders) &&
    (isAiUpstreamUrl(entry.url) || entry.systemPromptChars > 0 || entry.scriptModified);

  const payload = isAi
    ? entry
    : {
        id: entry.id,
        source: entry.source,
        method: entry.method,
        url: entry.url,
        statusCode: entry.statusCode,
        reqSize: entry.reqSize,
        resSize: entry.resSize,
        durationMs: entry.durationMs,
      };

  appendUpstreamCaptureToLog(requestLogId, payload, {
    isAi,
    source: "builtin-proxy",
    proxyUrl,
  }).catch((err) => {
    state.stats.lastError = `log-write: ${err?.message || String(err)}`;
  });
}

/**
 * Forward an intercepted HTTP/HTTPS request (inside MITM tunnel or plain HTTP proxy)
 * to the real upstream server, running the JS interceptor script and streaming response back.
 */
function handleInterceptedHttpRequest(clientReq, clientRes, { targetHost, targetPort, isHttps, requestLogId }) {
  const state = getState();
  const startTime = Date.now();
  const captureId = `bp-${startTime}-${crypto.randomBytes(3).toString("hex")}`;
  const method = (clientReq.method || "GET").toUpperCase();

  let reqPath = clientReq.url || "/";
  let resolvedHost = targetHost;
  let resolvedPort = targetPort;
  let resolvedHttps = isHttps;

  if (/^https?:\/\//i.test(reqPath)) {
    try {
      const parsed = new URL(reqPath);
      resolvedHttps = parsed.protocol === "https:";
      resolvedHost = parsed.hostname;
      resolvedPort = Number(parsed.port) || (resolvedHttps ? 443 : 80);
      reqPath = `${parsed.pathname}${parsed.search}`;
    } catch {}
  }

  const defaultPort = resolvedHttps ? 443 : 80;
  const portSuffix = resolvedPort && resolvedPort !== defaultPort ? `:${resolvedPort}` : "";
  const fullUrl = `${resolvedHttps ? "https" : "http"}://${resolvedHost}${portSuffix}${reqPath}`;

  // Collect request body
  const reqChunks = [];
  let reqBytes = 0;
  let reqTooLarge = false;

  clientReq.on("data", (chunk) => {
    reqBytes += chunk.length;
    if (reqBytes <= MAX_REQ_BUFFER_BYTES) {
      reqChunks.push(chunk);
    } else {
      reqTooLarge = true;
    }
  });

  clientReq.on("error", () => {});

  clientReq.on("end", () => {
    const rawBuf = Buffer.concat(reqChunks);
    const outHeaders = { ...clientReq.headers };
    delete outHeaders["proxy-authorization"];
    delete outHeaders["proxy-connection"];
    delete outHeaders["keep-alive"];

    const contentEncoding = outHeaders["content-encoding"];
    const contentType = outHeaders["content-type"] || "";

    let decodedBuf = rawBuf;
    let reqText = "";
    let reqJson = null;
    let reqIsBinary = isBinaryContentType(contentType);

    if (!reqTooLarge && rawBuf.length > 0) {
      decodedBuf = decompressBuffer(rawBuf, contentEncoding);
      if (reqIsBinary || looksLikeBinaryBuffer(decodedBuf)) {
        reqIsBinary = true;
        reqText = {
          binary: true,
          contentType: contentType || "application/octet-stream",
          sizeBytes: rawBuf.length,
        };
      } else {
        reqText = decodedBuf.toString("utf8");
        reqJson = tryParseJson(reqText, contentType);
      }
    }

    let finalBuf = rawBuf;
    let scriptResult = null;

    if (!reqTooLarge && !reqIsBinary && state.scriptEnabled) {
      scriptResult = runInterceptorScript({
        url: fullUrl,
        method,
        headers: outHeaders,
        body: reqJson,
        rawBody: reqText,
        source: "acp-mitm",
        scriptCode: state.script,
      });

      if (scriptResult.headersModified) {
        for (const k of Object.keys(outHeaders)) delete outHeaders[k];
        Object.assign(outHeaders, scriptResult.headers);
        delete outHeaders["proxy-authorization"];
        delete outHeaders["proxy-connection"];
      }

      if (scriptResult.bodyModified) {
        finalBuf = Buffer.from(scriptResult.rawBody || "", "utf8");
        reqText = scriptResult.rawBody || "";
        reqJson = scriptResult.body && typeof scriptResult.body === "object" ? scriptResult.body : tryParseJson(reqText, contentType);
        delete outHeaders["content-encoding"];
        delete outHeaders["transfer-encoding"];
        outHeaders["content-length"] = String(finalBuf.length);
      }
    }

    const transport = resolvedHttps ? https : http;
    const dialHost = state.testUpstreamHost || resolvedHost;
    const reqOpts = {
      hostname: dialHost,
      port: resolvedPort,
      path: reqPath,
      method,
      headers: outHeaders,
      ...(resolvedHttps && state.testUpstreamHost ? { servername: resolvedHost } : {}),
      // Honor custom upstream TLS CA in tests (e.g. self-signed mock upstream) when configured
      ...(process.env.BUILTIN_PROXY_UPSTREAM_REJECT_UNAUTHORIZED === "false"
        ? { rejectUnauthorized: false }
        : {}),
    };

    const upReq = transport.request(reqOpts, (upRes) => {
      const statusCode = upRes.statusCode || 200;
      const resHeaders = { ...upRes.headers };

      // Write status + headers immediately so SSE streams have zero added latency
      try {
        clientRes.writeHead(statusCode, upRes.statusMessage, resHeaders);
      } catch {}

      const resChunks = [];
      let resTotalBytes = 0;
      let resPreviewBytes = 0;

      upRes.on("data", (chunk) => {
        resTotalBytes += chunk.length;
        if (resPreviewBytes < MAX_RES_PREVIEW_BYTES) {
          const take = Math.min(chunk.length, MAX_RES_PREVIEW_BYTES - resPreviewBytes);
          resChunks.push(take === chunk.length ? chunk : chunk.subarray(0, take));
          resPreviewBytes += take;
        }
        if (!clientRes.writableEnded && !clientRes.destroyed) {
          clientRes.write(chunk);
        }
      });

      upRes.on("end", () => {
        if (!clientRes.writableEnded && !clientRes.destroyed) {
          clientRes.end();
        }
        const endTime = Date.now();
        const resPreview = decodeResponsePreview(Buffer.concat(resChunks), resHeaders, resTotalBytes);

        const entry = buildCaptureEntry({
          id: captureId,
          startTime,
          endTime,
          method,
          url: fullUrl,
          statusCode,
          reqSize: finalBuf.length,
          resSize: resTotalBytes,
          reqHeaders: outHeaders,
          resHeaders,
          reqJson,
          reqText,
          resPreview,
          source: "acp-mitm",
          scriptResult,
          requestLogId,
        });

        recordCapture({
          requestLogId,
          entry,
          proxyUrl: `http://127.0.0.1:${state.listeningPort || state.port}`,
        });
      });

      upRes.on("error", (err) => {
        if (!clientRes.writableEnded && !clientRes.destroyed) {
          try { clientRes.end(); } catch {}
        }
        state.stats.lastError = err?.message || String(err);
      });
    });

    upReq.on("error", (err) => {
      state.stats.lastError = err?.message || String(err);
      if (!clientRes.headersSent) {
        try {
          clientRes.writeHead(502, { "content-type": "application/json" });
          clientRes.end(JSON.stringify({ error: `Built-in proxy upstream error: ${err.message}` }));
        } catch {}
      } else if (!clientRes.writableEnded) {
        try { clientRes.end(); } catch {}
      }
    });

    if (finalBuf.length > 0 && method !== "GET" && method !== "HEAD") {
      upReq.write(finalBuf);
    }
    upReq.end();
  });
}

function handleTcpPassthrough(clientSocket, head, targetHost, targetPort, requestLogId) {
  const state = getState();
  state.stats.totalTunnelled++;
  const startTime = Date.now();
  const upSocket = net.connect(targetPort, targetHost, () => {
    try {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length > 0) upSocket.write(head);
      upSocket.pipe(clientSocket);
      clientSocket.pipe(upSocket);
    } catch {
      upSocket.destroy();
      clientSocket.destroy();
    }
  });

  upSocket.on("error", () => {
    try { clientSocket.destroy(); } catch {}
  });
  clientSocket.on("error", () => {
    try { upSocket.destroy(); } catch {}
  });

  if (requestLogId) {
    upSocket.once("close", () => {
      appendUpstreamCaptureToLog(
        requestLogId,
        {
          id: `tunnel-${startTime}-${crypto.randomBytes(2).toString("hex")}`,
          source: "builtin-proxy-tunnel",
          method: "CONNECT",
          url: `tunnel://${targetHost}:${targetPort}`,
          statusCode: 200,
          reqSize: 0,
          resSize: 0,
          durationMs: Date.now() - startTime,
        },
        {
          isAi: false,
          source: "builtin-proxy",
          proxyUrl: `http://127.0.0.1:${state.listeningPort || state.port}`,
        }
      ).catch(() => {});
    });
  }
}

function createProxyServer() {
  const state = getState();

  const server = http.createServer((req, res) => {
    // Plain HTTP proxy request (GET http://example.com/...)
    const requestLogId = parseProxyAuthRequestLogId(req.headers["proxy-authorization"]);
    let targetHost = "";
    let targetPort = 80;
    try {
      const parsed = new URL(req.url);
      targetHost = parsed.hostname;
      targetPort = Number(parsed.port) || 80;
    } catch {
      const hostHeader = String(req.headers.host || "");
      const [h, p] = hostHeader.split(":");
      targetHost = h;
      targetPort = Number(p) || 80;
    }

    if (!targetHost || isLocalTargetUrl(`http://${targetHost}`)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("9Router Built-in Proxy refuses loopback targets");
      return;
    }

    handleInterceptedHttpRequest(req, res, {
      targetHost,
      targetPort,
      isHttps: false,
      requestLogId,
    });
  });

  server.on("connect", (req, clientSocket, head) => {
    const rawAuthority = String(req.url || "");
    const lastColon = rawAuthority.lastIndexOf(":");
    const targetHost = (lastColon > 0 ? rawAuthority.slice(0, lastColon) : rawAuthority).replace(/^\[|\]$/g, "");
    const targetPort = lastColon > 0 ? Number(rawAuthority.slice(lastColon + 1)) || 443 : 443;
    const requestLogId = parseProxyAuthRequestLogId(req.headers["proxy-authorization"]);

    // Never MITM localhost targets
    if (!targetHost || isLocalTargetUrl(`https://${targetHost}`)) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }

    // Selective or full MITM (default `["*"]` decrypts all non-local hosts)
    if (!shouldInterceptHost(targetHost, state.interceptHosts)) {
      handleTcpPassthrough(clientSocket, head, targetHost, targetPort, requestLogId);
      return;
    }

    let leafCert;
    try {
      leafCert = getOrGenerateLeafCert(targetHost);
    } catch (err) {
      state.stats.lastError = err?.message || String(err);
      // Fail-open to raw TCP passthrough if cert generation ever fails
      handleTcpPassthrough(clientSocket, head, targetHost, targetPort, requestLogId);
      return;
    }

    state.stats.activeConnections++;
    try {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    } catch {
      state.stats.activeConnections = Math.max(0, state.stats.activeConnections - 1);
      return;
    }

    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      key: leafCert.key,
      cert: leafCert.cert,
      ALPNProtocols: ["http/1.1"],
    });

    if (head && head.length > 0) {
      clientSocket.unshift(head);
    }

    const innerHttp = http.createServer((innerReq, innerRes) => {
      handleInterceptedHttpRequest(innerReq, innerRes, {
        targetHost,
        targetPort,
        isHttps: true,
        requestLogId,
      });
    });

    tlsSocket.on("error", () => {
      try { tlsSocket.destroy(); } catch {}
    });
    clientSocket.on("error", () => {
      try { tlsSocket.destroy(); } catch {}
    });
    tlsSocket.once("close", () => {
      state.stats.activeConnections = Math.max(0, state.stats.activeConnections - 1);
    });

    innerHttp.emit("connection", tlsSocket);
  });

  return server;
}

export async function startBuiltinProxy(portOverride = null) {
  const state = getState();
  const targetPort = portOverride !== null ? normalizePort(portOverride) : state.port;

  if (state.server && state.listeningPort === targetPort) {
    return getBuiltinProxyStatus();
  }

  if (state.startPromise) {
    await state.startPromise;
    if (state.server && state.listeningPort === targetPort) {
      return getBuiltinProxyStatus();
    }
  }

  state.startPromise = (async () => {
    if (state.server) {
      await stopBuiltinProxy();
    }
    ensureBuiltinProxyCerts();
    const server = createProxyServer();
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        state.stats.lastError = err?.message || String(err);
        reject(err);
      };
      server.once("error", onError);
      server.listen(targetPort, "127.0.0.1", () => {
        server.off("error", onError);
        const addr = server.address();
        state.server = server;
        state.listeningPort = typeof addr === "object" && addr ? addr.port : targetPort;
        state.stats.lastError = null;
        resolve();
      });
    });
  })();

  try {
    await state.startPromise;
  } finally {
    state.startPromise = null;
  }
  return getBuiltinProxyStatus();
}

export async function stopBuiltinProxy() {
  const state = getState();
  const srv = state.server;
  state.server = null;
  state.listeningPort = null;
  if (!srv) return getBuiltinProxyStatus();

  await new Promise((resolve) => {
    try {
      srv.closeAllConnections?.();
      srv.close(() => resolve());
    } catch {
      resolve();
    }
  });
  return getBuiltinProxyStatus();
}

export function setBuiltinProxyConfig(settings = {}) {
  const state = getState();
  if (typeof settings.builtinProxyEnabled === "boolean") {
    state.enabled = settings.builtinProxyEnabled;
  } else if (typeof settings.enabled === "boolean") {
    state.enabled = settings.enabled;
  }
  if (settings.builtinProxyPort !== undefined) {
    state.port = normalizePort(settings.builtinProxyPort);
  } else if (settings.port !== undefined) {
    state.port = normalizePort(settings.port);
  }
  if (typeof settings.builtinProxyScriptEnabled === "boolean") {
    state.scriptEnabled = settings.builtinProxyScriptEnabled;
  } else if (typeof settings.scriptEnabled === "boolean") {
    state.scriptEnabled = settings.scriptEnabled;
  }
  if (typeof settings.builtinProxyScript === "string") {
    state.script = settings.builtinProxyScript;
    syncInterceptorScriptBackupFile(getEffectiveInterceptorScript(state.script));
  } else if (typeof settings.script === "string") {
    state.script = settings.script;
    syncInterceptorScriptBackupFile(getEffectiveInterceptorScript(state.script));
  }
  if (settings.builtinProxyInterceptHosts !== undefined) {
    state.interceptHosts = normalizeInterceptHosts(settings.builtinProxyInterceptHosts);
  } else if (settings.interceptHosts !== undefined) {
    state.interceptHosts = normalizeInterceptHosts(settings.interceptHosts);
  }
  if (settings.testUpstreamHost !== undefined) {
    state.testUpstreamHost = settings.testUpstreamHost || null;
  }
  state.initialized = true;
  return getBuiltinProxyConfig();
}

export async function syncBuiltinProxyState(settings = {}) {
  setBuiltinProxyConfig(settings);
  const state = getState();
  if (state.enabled) {
    try {
      return await startBuiltinProxy(state.port);
    } catch (err) {
      state.stats.lastError = err?.message || String(err);
      return getBuiltinProxyStatus();
    }
  }
  return await stopBuiltinProxy();
}

let lazyInitPromise = null;
export async function ensureBuiltinProxyReady() {
  const state = getState();
  if (!state.initialized) {
    if (process.env.VITEST) {
      state.initialized = true;
      return getBuiltinProxyStatus();
    }
    if (!lazyInitPromise) {
      lazyInitPromise = (async () => {
        try {
          const mod = await import("@/lib/localDb");
          if (typeof mod?.getSettings === "function") {
            const settings = await mod.getSettings();
            if (settings) {
              setBuiltinProxyConfig(settings);
            }
          }
        } catch {
          // Running outside Next.js/DB context (e.g. standalone unit tests)
          state.initialized = true;
        } finally {
          lazyInitPromise = null;
        }
      })();
    }
    await lazyInitPromise;
  }

  if (state.enabled && !state.server && process.env.BUILTIN_PROXY_AUTO_START !== "false") {
    try {
      await startBuiltinProxy(state.port);
    } catch (err) {
      state.stats.lastError = err?.message || String(err);
    }
  }
  return getBuiltinProxyStatus();
}

export function getBuiltinProxyConfig() {
  const state = getState();
  return {
    enabled: state.enabled === true,
    port: state.port,
    scriptEnabled: state.scriptEnabled !== false,
    script: getEffectiveInterceptorScript(state.script),
    interceptHosts: [...state.interceptHosts],
  };
}

export function isBuiltinProxyActive() {
  const state = getState();
  return Boolean(state.enabled && state.server && state.listeningPort);
}

export function getBuiltinProxyStatus() {
  const state = getState();
  const running = Boolean(state.server && state.listeningPort);
  const port = state.listeningPort || state.port;
  return {
    enabled: state.enabled === true,
    running,
    port,
    url: `http://127.0.0.1:${port}`,
    caCertPath: state.caCertPath,
    caBundlePath: state.caBundlePath,
    scriptEnabled: state.scriptEnabled !== false,
    script: getEffectiveInterceptorScript(state.script),
    defaultScript: DEFAULT_INTERCEPTOR_SCRIPT,
    interceptHosts: [...state.interceptHosts],
    stats: { ...state.stats },
    recentCaptures: state.recentCaptures.slice(0, 20),
  };
}

export function resetBuiltinProxyForTests() {
  const state = getState();
  if (state.server) {
    try {
      state.server.closeAllConnections?.();
      state.server.close();
    } catch {}
  }
  globalThis[GLOBAL_KEY] = undefined;
}

/**
 * In-process interceptor hook for non-ACP outbound HTTP/HTTPS requests inside proxyFetch.js.
 * Runs the same JS interceptor script without TLS MITM overhead and writes captures 1-to-1
 * to the active requestLogId (via AsyncLocalStorage).
 */
export async function interceptInProcessFetch(targetUrl, options, doFetch) {
  const state = getState();
  if (!state.enabled || isLocalTargetUrl(targetUrl)) {
    return doFetch(targetUrl, options);
  }

  let hostname = "";
  try {
    hostname = new URL(targetUrl).hostname;
  } catch {
    return doFetch(targetUrl, options);
  }
  if (!shouldInterceptHost(hostname, state.interceptHosts)) {
    return doFetch(targetUrl, options);
  }

  const startTime = Date.now();
  const captureId = `inproc-${startTime}-${crypto.randomBytes(3).toString("hex")}`;
  const requestLogId = getCurrentRequestLogId();
  const method = String(options?.method || "GET").toUpperCase();

  // Normalize headers
  const headersObj = {};
  if (options?.headers) {
    const entries = options.headers instanceof Headers
      ? Array.from(options.headers.entries())
      : Array.isArray(options.headers)
        ? options.headers
        : Object.entries(options.headers);
    for (const [k, v] of entries) {
      if (v !== undefined && v !== null) headersObj[String(k).toLowerCase()] = String(v);
    }
  }

  let reqText = "";
  let reqJson = null;
  let reqSize = 0;
  let reqIsBinary = isBinaryContentType(headersObj["content-type"]);
  const rawBody = options?.body;
  if (typeof rawBody === "string") {
    reqText = rawBody;
    reqSize = Buffer.byteLength(rawBody, "utf8");
    reqJson = tryParseJson(rawBody, headersObj["content-type"]);
  } else if (Buffer.isBuffer(rawBody) || rawBody instanceof Uint8Array) {
    reqSize = rawBody.byteLength;
    const rawBuf = Buffer.from(rawBody);
    if (reqIsBinary || looksLikeBinaryBuffer(rawBuf)) {
      reqIsBinary = true;
      reqText = {
        binary: true,
        contentType: headersObj["content-type"] || "application/octet-stream",
        sizeBytes: reqSize,
      };
    } else if (reqSize <= MAX_REQ_BUFFER_BYTES) {
      reqText = rawBuf.toString("utf8");
      reqJson = tryParseJson(reqText, headersObj["content-type"]);
    }
  }

  let nextOptions = options;
  let scriptResult = null;
  if (state.scriptEnabled && !reqIsBinary) {
    scriptResult = runInterceptorScript({
      url: targetUrl,
      method,
      headers: headersObj,
      body: reqJson,
      rawBody: reqText,
      source: "in-process",
      scriptCode: state.script,
    });

    if (scriptResult.modified) {
      nextOptions = { ...options };
      if (scriptResult.headersModified) {
        nextOptions.headers = { ...scriptResult.headers };
      }
      if (scriptResult.bodyModified) {
        nextOptions.body = scriptResult.rawBody;
        reqText = scriptResult.rawBody;
        reqSize = Buffer.byteLength(reqText, "utf8");
        reqJson = scriptResult.body && typeof scriptResult.body === "object"
          ? scriptResult.body
          : tryParseJson(reqText, headersObj["content-type"]);
        if (nextOptions.headers) {
          const h = nextOptions.headers instanceof Headers
            ? Object.fromEntries(nextOptions.headers.entries())
            : { ...nextOptions.headers };
          delete h["content-length"];
          delete h["Content-Length"];
          nextOptions.headers = h;
        }
      }
    }
  }

  const response = await doFetch(targetUrl, nextOptions);

  // Tee response preview in background without blocking SSE streams
  if (response) {
    const resHeaders = {};
    if (response.headers && typeof response.headers.entries === "function") {
      for (const [k, v] of response.headers.entries()) resHeaders[k.toLowerCase()] = v;
    }
    const statusCode = response.status ?? 200;

    let cloned = null;
    try {
      if (typeof response.clone === "function") cloned = response.clone();
    } catch {}

    const finalizeCapture = async () => {
      let resPreview = null;
      let resSize = 0;
      if (cloned?.body && typeof cloned.body.getReader === "function") {
        const reader = cloned.body.getReader();
        const chunks = [];
        try {
          while (resSize < MAX_RES_PREVIEW_BYTES) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              const take = Math.min(value.byteLength, MAX_RES_PREVIEW_BYTES - resSize);
              chunks.push(Buffer.from(value.buffer, value.byteOffset, take));
              resSize += take;
            }
          }
          await reader.cancel().catch(() => {});
        } catch {}
        resPreview = decodeResponsePreview(Buffer.concat(chunks), resHeaders, resSize);
      }

      const endTime = Date.now();
      const entry = buildCaptureEntry({
        id: captureId,
        startTime,
        endTime,
        method,
        url: targetUrl,
        statusCode,
        reqSize,
        resSize,
        reqHeaders: scriptResult?.headersModified ? scriptResult.headers : headersObj,
        resHeaders,
        reqJson,
        reqText,
        resPreview,
        source: "in-process",
        scriptResult,
        requestLogId,
      });

      recordCapture({
        requestLogId,
        entry,
        proxyUrl: `builtin://in-process`,
      });
    };

    void finalizeCapture();
  }

  return response;
}
