import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getDataDir } from "./dataDir.js";

const DEFAULT_MAX_LOG_FILES = 100;
const INDEX_FILENAME = "_index.json";
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const SENSITIVE_HEADER_KEYS = ["authorization", "x-api-key", "cookie", "set-cookie", "x-goog-api-key", "api-key", "proxy-authorization"];

const LOGGER_GLOBAL_KEY = "__nineRouterRequestFileLoggerState";
function getLoggerRuntime() {
  if (!globalThis[LOGGER_GLOBAL_KEY]) {
    globalThis[LOGGER_GLOBAL_KEY] = {
      seqCounter: 0,
      pendingFileOps: new Map(),
      indexQueue: Promise.resolve(),
    };
  }
  return globalThis[LOGGER_GLOBAL_KEY];
}

export function getLogsDir() {
  return process.env.REQUEST_LOGS_DIR || path.join(getDataDir(), "request-logs");
}

export function getMaxLogFiles() {
  const raw = Number.parseInt(process.env.REQUEST_LOGS_MAX_FILES || String(DEFAULT_MAX_LOG_FILES), 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_MAX_LOG_FILES;
}

export function safeClone(value) {
  if (value === null || value === undefined) return value;
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return null;
    }
  }
}

function maskSecretValue(val) {
  const str = String(val || "");
  if (!str) return "";
  const spaceIdx = str.indexOf(" ");
  if (spaceIdx > 0 && spaceIdx < 16) {
    const scheme = str.slice(0, spaceIdx);
    const token = str.slice(spaceIdx + 1).trim();
    if (token.length <= 12) return `${scheme} [REDACTED]`;
    return `${scheme} ${token.slice(0, 6)}...${token.slice(-4)}`;
  }
  if (str.length <= 12) return "[REDACTED]";
  return `${str.slice(0, 6)}...${str.slice(-4)}`;
}

export function maskHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const entries = typeof headers.entries === "function"
    ? Array.from(headers.entries())
    : Object.entries(headers);
  const out = {};
  for (const [k, v] of entries) {
    const lower = String(k).toLowerCase();
    if (SENSITIVE_HEADER_KEYS.some((s) => lower.includes(s))) {
      out[k] = maskSecretValue(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function extractMessagesView(body) {
  if (!body || typeof body !== "object") {
    return { system: null, messages: [], messageCount: 0 };
  }

  const system =
    body.system ??
    body.instructions ??
    body.systemInstruction ??
    body.system_instruction ??
    body.request?.systemInstruction ??
    body.request?.system_instruction ??
    null;

  let messages = [];
  if (Array.isArray(body.messages)) {
    messages = body.messages;
  } else if (Array.isArray(body.input)) {
    messages = body.input;
  } else if (typeof body.input === "string") {
    messages = [{ role: "user", content: body.input }];
  } else if (Array.isArray(body.contents)) {
    messages = body.contents;
  } else if (Array.isArray(body.request?.contents)) {
    messages = body.request.contents;
  }

  return {
    system: safeClone(system),
    messages: safeClone(messages),
    messageCount: messages.length,
  };
}

function isValidLogId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 120 && SAFE_ID_RE.test(id);
}

function resolveLogFilePath(logsDir, id) {
  if (!isValidLogId(id)) {
    throw new Error("Invalid log id");
  }
  const resolvedDir = path.resolve(logsDir);
  const filePath = path.resolve(resolvedDir, `${id}.json`);
  if (!filePath.startsWith(resolvedDir + path.sep)) {
    throw new Error("Invalid log path");
  }
  return filePath;
}

async function ensureLogsDir(logsDir) {
  await fs.mkdir(logsDir, { recursive: true });
}

async function writeJsonAtomic(filePath, data) {
  const payload = JSON.stringify(data, null, 2);
  const bytes = Buffer.byteLength(payload, "utf8");
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmpPath, payload, "utf8");
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    try { await fs.unlink(tmpPath); } catch {}
    // Fallback direct write if rename fails
    await fs.writeFile(filePath, payload, "utf8");
  }
  return bytes;
}

function buildSummaryFromRecord(record, fileSizeBytes = 0) {
  return {
    id: record.id,
    filename: record.filename || `${record.id}.json`,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt || record.createdAt,
    status: record.status || "pending",
    statusCode: record.statusCode ?? null,
    apiType: record.apiType || "chat",
    method: record.method || "POST",
    endpoint: record.endpoint || "",
    clientModel: record.clientModel || null,
    provider: record.provider || null,
    providerName: record.providerName || null,
    model: record.model || null,
    sourceFormat: record.sourceFormat || null,
    targetFormat: record.targetFormat || null,
    stream: Boolean(record.stream),
    passthrough: Boolean(record.passthrough),
    transformations: Array.isArray(record.transformations) ? record.transformations : [],
    beforeMessageCount: record.beforeModify?.messageCount ?? record.received?.messageCount ?? null,
    afterMessageCount: record.afterModify?.messageCount ?? null,
    latency: record.latency || null,
    tokens: record.tokens || null,
    error: record.response?.error || null,
    isCombo: Boolean(record.isCombo),
    comboName: record.comboName || null,
    fallbackCount: Array.isArray(record.attempts) ? record.attempts.length : 0,
    w2CaptureCount: record.w2CaptureCount ?? record.w2Capture?.captureCount ?? 0,
    w2HasSystemPrompt: Boolean(record.w2HasSystemPrompt ?? record.w2Capture?.hasSystemPrompt),
    fileSizeBytes,
  };
}

function enqueueForId(id, task) {
  const rt = getLoggerRuntime();
  const prev = rt.pendingFileOps.get(id) || Promise.resolve();
  const next = prev.then(task, task);
  const cleanup = next.finally(() => {
    if (rt.pendingFileOps.get(id) === cleanup) {
      rt.pendingFileOps.delete(id);
    }
  });
  rt.pendingFileOps.set(id, cleanup);
  return next;
}

function enqueueIndex(task) {
  const rt = getLoggerRuntime();
  const next = rt.indexQueue.then(task, task);
  rt.indexQueue = next.catch(() => {});
  return next;
}

async function listJsonLogFiles(logsDir) {
  let entries;
  try {
    entries = await fs.readdir(logsDir);
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((name) => name.endsWith(".json") && name !== INDEX_FILENAME)
    .sort(); // oldest first because filenames start with zero-padded epochMs
}

async function rebuildIndexUnlocked(logsDir, maxFiles) {
  const files = await listJsonLogFiles(logsDir);

  // Enforce rolling limit during rebuild as well
  if (files.length > maxFiles) {
    const toDelete = files.splice(0, files.length - maxFiles);
    await Promise.all(
      toDelete.map((name) => fs.unlink(path.join(logsDir, name)).catch(() => {}))
    );
  }

  const summaries = [];
  for (let i = files.length - 1; i >= 0; i--) {
    const filename = files[i];
    const filePath = path.join(logsDir, filename);
    try {
      const [raw, stat] = await Promise.all([
        fs.readFile(filePath, "utf8"),
        fs.stat(filePath),
      ]);
      const parsed = JSON.parse(raw);
      summaries.push(buildSummaryFromRecord(parsed, stat.size));
    } catch {
      // Skip corrupt/unreadable file
    }
  }

  const indexPath = path.join(logsDir, INDEX_FILENAME);
  await writeJsonAtomic(indexPath, { version: 1, items: summaries }).catch(() => {});
  return summaries;
}

async function readIndexUnlocked(logsDir, maxFiles) {
  const indexPath = path.join(logsDir, INDEX_FILENAME);
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.items)) {
      return parsed.items;
    }
  } catch {
    // Missing or invalid index -> rebuild from disk
  }
  return rebuildIndexUnlocked(logsDir, maxFiles);
}

async function upsertIndexAndRoll(logsDir, summary, maxFiles) {
  return enqueueIndex(async () => {
    await ensureLogsDir(logsDir);
    let items = await readIndexUnlocked(logsDir, maxFiles);

    const existingIdx = items.findIndex((item) => item.id === summary.id);
    if (existingIdx >= 0) {
      items[existingIdx] = { ...items[existingIdx], ...summary };
    } else {
      items.unshift(summary);
    }

    // Keep sorted newest-first by id (lexicographical timestamp prefix)
    items.sort((a, b) => (b.id > a.id ? 1 : b.id < a.id ? -1 : 0));

    // Rolling cleanup on disk: delete oldest files beyond maxFiles
    const diskFiles = await listJsonLogFiles(logsDir);
    if (diskFiles.length > maxFiles) {
      const staleFiles = diskFiles.slice(0, diskFiles.length - maxFiles);
      const staleIds = new Set(staleFiles.map((f) => f.replace(/\.json$/, "")));
      await Promise.all(
        staleFiles.map((f) => fs.unlink(path.join(logsDir, f)).catch(() => {}))
      );
      items = items.filter((item) => !staleIds.has(item.id));
    }

    if (items.length > maxFiles) {
      const overflow = items.splice(maxFiles);
      await Promise.all(
        overflow.map((item) => {
          const filename = item.filename || `${item.id}.json`;
          return fs.unlink(path.join(logsDir, filename)).catch(() => {});
        })
      );
    }

    const indexPath = path.join(logsDir, INDEX_FILENAME);
    await writeJsonAtomic(indexPath, { version: 1, items });
  });
}

function generateLogId() {
  const rt = getLoggerRuntime();
  const ts = String(Date.now()).padStart(15, "0");
  rt.seqCounter = (rt.seqCounter + 1) % 10000;
  const seq = String(rt.seqCounter).padStart(4, "0");
  const rand = crypto.randomBytes(3).toString("hex");
  return `${ts}-${seq}-${rand}`;
}

/**
 * Create a new per-request JSON log file on disk (Stage 1: received).
 * Keeps full payloads strictly on disk; never caches bodies in memory.
 */
export async function createRequestLog({
  method = "POST",
  endpoint = "",
  headers = {},
  body = null,
  clientModel = null,
  detectedFormat = null,
  apiType = "chat",
} = {}) {
  const logsDir = getLogsDir();
  const maxFiles = getMaxLogFiles();
  const id = generateLogId();
  const filename = `${id}.json`;
  const now = new Date().toISOString();
  const clonedBody = safeClone(body);
  const msgView = extractMessagesView(clonedBody);

  const record = {
    id,
    filename,
    createdAt: now,
    updatedAt: now,
    status: "pending",
    statusCode: null,
    apiType: apiType || "chat",
    method,
    endpoint,
    clientModel: clientModel || clonedBody?.model || null,
    provider: null,
    providerName: null,
    model: null,
    sourceFormat: detectedFormat || null,
    targetFormat: null,
    stream: Boolean(clonedBody?.stream),
    passthrough: false,
    transformations: [],
    latency: null,
    tokens: null,
    received: {
      timestamp: now,
      method,
      endpoint,
      headers: maskHeaders(headers),
      messageCount: msgView.messageCount,
      system: msgView.system,
      messages: msgView.messages,
      body: clonedBody,
    },
    beforeModify: null,
    afterModify: null,
    response: null,
    w2Capture: null,
    attempts: [],
  };

  await enqueueForId(id, async () => {
    await ensureLogsDir(logsDir);
    const filePath = resolveLogFilePath(logsDir, id);
    const bytes = await writeJsonAtomic(filePath, record);
    await upsertIndexAndRoll(logsDir, buildSummaryFromRecord(record, bytes), maxFiles);
  });

  return { id, filename };
}

/**
 * Update a specific stage ("beforeModify" | "afterModify" | "response") and summary metadata
 * inside the request's JSON file on disk.
 */
export async function updateRequestLogStage(id, stageName, stageData, summaryPatch = {}) {
  if (!isValidLogId(id)) return null;
  const logsDir = getLogsDir();
  const maxFiles = getMaxLogFiles();

  return enqueueForId(id, async () => {
    const filePath = resolveLogFilePath(logsDir, id);
    let record;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      record = JSON.parse(raw);
    } catch {
      // File may have been rolled out or deleted manually
      return null;
    }

    const now = new Date().toISOString();
    record.updatedAt = now;

    // If a fallback/retry begins a new beforeModify after a prior attempt, archive previous attempt summary
    if (stageName === "beforeModify" && record.beforeModify) {
      if (!Array.isArray(record.attempts)) record.attempts = [];
      const prevAttemptNum = record.attempts.length + 1;
      record.attempts.push({
        attemptIndex: prevAttemptNum,
        provider: record.provider,
        providerName: record.providerName || null,
        model: record.model,
        targetFormat: record.targetFormat || null,
        status: record.status,
        statusCode: record.statusCode,
        error: record.response?.error || null,
        latency: record.latency || null,
        beforeModify: record.beforeModify,
        afterModify: record.afterModify,
        response: record.response,
      });
      record.afterModify = null;
      record.response = null;
    }

    if (stageName && stageData !== undefined) {
      record[stageName] = {
        timestamp: now,
        ...safeClone(stageData),
      };
    }

    if (summaryPatch && typeof summaryPatch === "object") {
      for (const [key, value] of Object.entries(summaryPatch)) {
        if (value !== undefined) {
          record[key] = safeClone(value);
        }
      }
    }

    const bytes = await writeJsonAtomic(filePath, record);
    await upsertIndexAndRoll(logsDir, buildSummaryFromRecord(record, bytes), maxFiles);
    return { id, filename: record.filename, fileSizeBytes: bytes };
  });
}

/**
 * Atomically read, mutate, and write a request log record inside the per-ID serialized queue
 * so concurrent stage updates (e.g. response completion vs Built-in Proxy captures) never race.
 */
export async function mutateRequestLog(id, mutator) {
  if (!isValidLogId(id) || typeof mutator !== "function") return null;
  const logsDir = getLogsDir();
  const maxFiles = getMaxLogFiles();

  return enqueueForId(id, async () => {
    const filePath = resolveLogFilePath(logsDir, id);
    let record;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      record = JSON.parse(raw);
    } catch {
      return null;
    }

    const changed = await mutator(record);
    if (changed === false) return null;

    record.updatedAt = new Date().toISOString();
    const bytes = await writeJsonAtomic(filePath, record);
    await upsertIndexAndRoll(logsDir, buildSummaryFromRecord(record, bytes), maxFiles);
    return { id, filename: record.filename, fileSizeBytes: bytes };
  });
}

/**
 * Wait for all in-flight writes for a specific id (or all ids) to finish.
 * Primarily useful in tests and graceful shutdown.
 */
export async function flushRequestFileLogs(id = null) {
  const rt = getLoggerRuntime();
  if (id) {
    await (rt.pendingFileOps.get(id) || Promise.resolve());
  } else {
    await Promise.all(Array.from(rt.pendingFileOps.values()));
  }
  await rt.indexQueue;
}

/**
 * List metadata of up to MAX_LOG_FILES most recent request logs (newest first).
 */
export async function listRequestLogs({ search = "", provider = "", status = "", apiType = "" } = {}) {
  const logsDir = getLogsDir();
  const maxFiles = getMaxLogFiles();

  const items = await enqueueIndex(async () => {
    await ensureLogsDir(logsDir);
    const indexed = await readIndexUnlocked(logsDir, maxFiles);
    const diskFiles = await listJsonLogFiles(logsDir);
    // If disk file count diverged (e.g. files deleted externally), rebuild index
    if (diskFiles.length !== indexed.length) {
      return rebuildIndexUnlocked(logsDir, maxFiles);
    }
    return indexed;
  });

  const totalSizeBytes = items.reduce((sum, item) => sum + (item.fileSizeBytes || 0), 0);
  const providers = Array.from(
    new Set(items.map((i) => i.provider).filter(Boolean))
  ).sort();
  const apiTypes = Array.from(
    new Set(items.map((i) => i.apiType || "chat").filter(Boolean))
  ).sort();

  const q = String(search || "").trim().toLowerCase();
  const statusFilter = String(status || "").trim().toLowerCase();
  const providerFilter = String(provider || "").trim();
  const apiTypeFilter = String(apiType || "").trim().toLowerCase();

  const filtered = items.filter((item) => {
    if (providerFilter && item.provider !== providerFilter) return false;
    if (statusFilter && statusFilter !== "all" && item.status !== statusFilter) return false;
    if (apiTypeFilter && apiTypeFilter !== "all" && (item.apiType || "chat").toLowerCase() !== apiTypeFilter) return false;
    if (q) {
      const hay = [
        item.id,
        item.method,
        item.apiType || "chat",
        item.clientModel,
        item.provider,
        item.providerName,
        item.model,
        item.endpoint,
        item.error,
        ...(item.transformations || []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return {
    items: filtered,
    total: items.length,
    filteredTotal: filtered.length,
    maxFiles,
    storageDir: logsDir,
    totalSizeBytes,
    providers,
    apiTypes,
  };
}

/**
 * Read a single request log JSON file directly from disk.
 */
export async function getRequestLogById(id) {
  if (!isValidLogId(id)) return null;
  const logsDir = getLogsDir();
  const filePath = resolveLogFilePath(logsDir, id);
  try {
    const [raw, stat] = await Promise.all([
      fs.readFile(filePath, "utf8"),
      fs.stat(filePath),
    ]);
    const parsed = JSON.parse(raw);
    return { ...parsed, fileSizeBytes: stat.size };
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Delete a single request log JSON file from disk and update index.
 */
export async function deleteRequestLogById(id) {
  if (!isValidLogId(id)) return false;
  const logsDir = getLogsDir();
  const maxFiles = getMaxLogFiles();
  const filePath = resolveLogFilePath(logsDir, id);

  let deleted = false;
  try {
    await fs.unlink(filePath);
    deleted = true;
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }

  await enqueueIndex(async () => {
    const items = await readIndexUnlocked(logsDir, maxFiles);
    const next = items.filter((item) => item.id !== id);
    await writeJsonAtomic(path.join(logsDir, INDEX_FILENAME), { version: 1, items: next });
  });

  return deleted;
}

/**
 * Delete all request log JSON files from disk and reset index.
 */
export async function clearAllRequestLogs() {
  const logsDir = getLogsDir();
  return enqueueIndex(async () => {
    const files = await listJsonLogFiles(logsDir);
    await Promise.all(
      files.map((f) => fs.unlink(path.join(logsDir, f)).catch(() => {}))
    );
    try {
      await ensureLogsDir(logsDir);
      await writeJsonAtomic(path.join(logsDir, INDEX_FILENAME), { version: 1, items: [] });
    } catch {}
    return files.length;
  });
}
