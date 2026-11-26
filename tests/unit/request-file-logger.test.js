import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  createRequestLog,
  updateRequestLogStage,
  listRequestLogs,
  getRequestLogById,
  deleteRequestLogById,
  clearAllRequestLogs,
  flushRequestFileLogs,
  extractMessagesView,
  maskHeaders,
} from "@/lib/requestFileLogger.js";

describe("requestFileLogger (disk-backed rolling JSON store)", () => {
  let tmpDir;
  let prevDir;
  let prevMax;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-reqlogs-"));
    prevDir = process.env.REQUEST_LOGS_DIR;
    prevMax = process.env.REQUEST_LOGS_MAX_FILES;
    process.env.REQUEST_LOGS_DIR = tmpDir;
    delete process.env.REQUEST_LOGS_MAX_FILES;
  });

  afterEach(async () => {
    await flushRequestFileLogs();
    if (prevDir === undefined) delete process.env.REQUEST_LOGS_DIR;
    else process.env.REQUEST_LOGS_DIR = prevDir;
    if (prevMax === undefined) delete process.env.REQUEST_LOGS_MAX_FILES;
    else process.env.REQUEST_LOGS_MAX_FILES = prevMax;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes 1 JSON file per request with all 4 stages, masks headers, and does not mutate input", async () => {
    const incomingBody = {
      model: "acp-kiro/auto",
      stream: false,
      messages: [
        { role: "system", content: "You are Zed assistant" },
        { role: "user", content: "Say hello" },
      ],
    };

    const { id, filename } = await createRequestLog({
      method: "POST",
      endpoint: "/v1/chat/completions",
      headers: {
        authorization: "Bearer sk-140fbbce80f6d017-pmi11t-3d6738ef",
        "x-api-key": "secret-key-value-1234567890",
        cookie: "session=abcdef1234567890",
        "content-type": "application/json",
      },
      body: incomingBody,
      clientModel: "acp-kiro/auto",
      detectedFormat: "openai",
    });

    // Mutate caller object after createRequestLog to prove deep-clone isolation
    incomingBody.messages.push({ role: "user", content: "mutated-later" });

    await updateRequestLogStage(
      id,
      "beforeModify",
      {
        provider: "acp-534c09bf-73a1-4f79-9179-32aa492be711",
        providerName: "Kiro",
        model: "auto",
        sourceFormat: "openai",
        targetFormat: "openai",
        ...extractMessagesView({
          messages: [
            { role: "system", content: "You are Zed assistant" },
            { role: "user", content: "Say hello" },
          ],
        }),
        body: { model: "acp-kiro/auto", messages: [{ role: "system", content: "You are Zed assistant" }, { role: "user", content: "Say hello" }] },
      },
      { provider: "acp-534c09bf-73a1-4f79-9179-32aa492be711", providerName: "Kiro", model: "auto" }
    );

    await updateRequestLogStage(
      id,
      "afterModify",
      {
        transformations: ["ACP:NO-SYS"],
        providerUrl: "acp://stdio",
        ...extractMessagesView({ messages: [{ role: "user", content: "Say hello" }] }),
        translatedBody: { model: "auto", messages: [{ role: "user", content: "Say hello" }] },
        executorPayload: { command: "kiro-cli", stripSystemPrompt: true, prompt: "User: Say hello" },
      },
      { transformations: ["ACP:NO-SYS"] }
    );

    await updateRequestLogStage(
      id,
      "response",
      {
        type: "json",
        statusCode: 200,
        content: "Hello!",
        finishReason: "stop",
        clientResponse: { choices: [{ message: { role: "assistant", content: "Hello!" } }] },
        error: null,
      },
      { status: "success", statusCode: 200, latency: { ttft: 120, total: 240 } }
    );

    await flushRequestFileLogs(id);

    // File must exist directly on disk as valid JSON
    const filePath = path.join(tmpDir, filename);
    const rawOnDisk = JSON.parse(await fs.readFile(filePath, "utf8"));

    expect(rawOnDisk.id).toBe(id);
    expect(rawOnDisk.status).toBe("success");
    expect(rawOnDisk.statusCode).toBe(200);
    // Sensitive headers masked
    expect(rawOnDisk.received.headers.authorization).toBe("Bearer sk-140...38ef");
    expect(rawOnDisk.received.headers["x-api-key"]).toBe("secret...7890");
    expect(rawOnDisk.received.headers.cookie).toBe("sessio...7890");
    expect(rawOnDisk.received.headers["content-type"]).toBe("application/json");
    // Caller mutation did NOT affect logged body
    expect(rawOnDisk.received.body.messages).toHaveLength(2);
    // Before vs After stages captured cleanly
    expect(rawOnDisk.beforeModify.messageCount).toBe(2);
    expect(rawOnDisk.afterModify.messageCount).toBe(1);
    expect(rawOnDisk.afterModify.transformations).toEqual(["ACP:NO-SYS"]);
    expect(rawOnDisk.afterModify.executorPayload.prompt).toBe("User: Say hello");
    expect(rawOnDisk.response.content).toBe("Hello!");

    // API read helper returns same content + fileSizeBytes
    const loaded = await getRequestLogById(id);
    expect(loaded.fileSizeBytes).toBeGreaterThan(0);
    expect(loaded.response.content).toBe("Hello!");
  });

  it("enforces rolling limit of 100 files and deletes oldest files from disk", async () => {
    const createdIds = [];
    for (let i = 0; i < 105; i++) {
      const { id } = await createRequestLog({
        method: "POST",
        endpoint: "/v1/chat/completions",
        body: { model: `model-${i}`, messages: [{ role: "user", content: `msg ${i}` }] },
        clientModel: `model-${i}`,
      });
      createdIds.push(id);
    }
    await flushRequestFileLogs();

    const diskEntries = (await fs.readdir(tmpDir)).filter((f) => f.endsWith(".json") && f !== "_index.json");
    expect(diskEntries).toHaveLength(100);

    // The 5 oldest files must be physically deleted from disk
    for (let i = 0; i < 5; i++) {
      const oldId = createdIds[i];
      await expect(fs.access(path.join(tmpDir, `${oldId}.json`))).rejects.toThrow();
      expect(await getRequestLogById(oldId)).toBeNull();
    }

    // The 100 newest files must exist and be listed newest-first
    const listed = await listRequestLogs();
    expect(listed.total).toBe(100);
    expect(listed.items).toHaveLength(100);
    expect(listed.items[0].id).toBe(createdIds[104]);
    expect(listed.items[99].id).toBe(createdIds[5]);
  });

  it("rebuilds _index.json automatically if deleted and supports filtering, delete, and clear", async () => {
    const first = await createRequestLog({
      endpoint: "/v1/chat/completions",
      body: { model: "acp-kiro/auto", messages: [{ role: "user", content: "hi" }] },
      clientModel: "acp-kiro/auto",
    });
    await updateRequestLogStage(first.id, "response", { statusCode: 200, content: "ok" }, { status: "success", statusCode: 200, provider: "acp-kiro" });

    const second = await createRequestLog({
      endpoint: "/v1/messages",
      body: { model: "claude/sonnet", messages: [{ role: "user", content: "hi" }] },
      clientModel: "claude/sonnet",
    });
    await updateRequestLogStage(second.id, "response", { statusCode: 502, error: "boom" }, { status: "error", statusCode: 502, provider: "claude" });

    // Remove _index.json to simulate cold start / missing manifest
    await fs.unlink(path.join(tmpDir, "_index.json"));

    const all = await listRequestLogs();
    expect(all.total).toBe(2);
    expect(all.items[0].id).toBe(second.id);

    const onlyErrors = await listRequestLogs({ status: "error" });
    expect(onlyErrors.items).toHaveLength(1);
    expect(onlyErrors.items[0].id).toBe(second.id);

    const bySearch = await listRequestLogs({ search: "kiro" });
    expect(bySearch.items).toHaveLength(1);
    expect(bySearch.items[0].id).toBe(first.id);

    // Delete single
    expect(await deleteRequestLogById(first.id)).toBe(true);
    await expect(fs.access(path.join(tmpDir, first.filename))).rejects.toThrow();
    expect((await listRequestLogs()).total).toBe(1);

    // Clear all
    const cleared = await clearAllRequestLogs();
    expect(cleared).toBe(1);
    expect((await listRequestLogs()).total).toBe(0);
  });

  it("rejects path traversal IDs and archives fallback attempts", async () => {
    expect(await getRequestLogById("../etc/passwd")).toBeNull();
    expect(await getRequestLogById("foo/bar")).toBeNull();
    expect(await deleteRequestLogById("../../secret")).toBe(false);

    // Fallback attempt archival
    const { id } = await createRequestLog({ body: { model: "combo", messages: [{ role: "user", content: "hi" }] } });
    await updateRequestLogStage(id, "beforeModify", { provider: "p1", model: "m1" }, { provider: "p1", model: "m1" });
    await updateRequestLogStage(id, "response", { statusCode: 429, error: "rate limited" }, { status: "error", statusCode: 429 });
    // Second attempt on same requestLogId
    await updateRequestLogStage(id, "beforeModify", { provider: "p2", model: "m2" }, { provider: "p2", model: "m2" });
    await updateRequestLogStage(id, "response", { statusCode: 200, content: "ok from p2" }, { status: "success", statusCode: 200 });

    const doc = await getRequestLogById(id);
    expect(doc.attempts).toHaveLength(1);
    expect(doc.attempts[0].attemptIndex).toBe(1);
    expect(doc.attempts[0].provider).toBe("p1");
    expect(doc.attempts[0].statusCode).toBe(429);
    expect(doc.provider).toBe("p2");
    expect(doc.response.content).toBe("ok from p2");

    const listRes = await listRequestLogs();
    const item = listRes.items.find((x) => x.id === id);
    expect(item.fallbackCount).toBe(1);
  });

  it("maskHeaders handles short secrets safely", () => {
    const masked = maskHeaders({ Authorization: "Bearer tiny", "x-custom": "keep" });
    expect(masked.Authorization).toBe("Bearer [REDACTED]");
    expect(masked["x-custom"]).toBe("keep");
  });
});
