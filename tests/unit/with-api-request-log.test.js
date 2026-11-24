import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withApiRequestLog, compactPayloadForLog } from "../../src/lib/withApiRequestLog.js";
import {
  listRequestLogs,
  getRequestLogById,
  flushRequestFileLogs,
} from "../../src/lib/requestFileLogger.js";

describe("withApiRequestLog", () => {
  let tmpDir;
  let prevDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-api-log-test-"));
    prevDir = process.env.REQUEST_LOGS_DIR;
    process.env.REQUEST_LOGS_DIR = tmpDir;
  });

  afterEach(async () => {
    await flushRequestFileLogs();
    if (prevDir === undefined) {
      delete process.env.REQUEST_LOGS_DIR;
    } else {
      process.env.REQUEST_LOGS_DIR = prevDir;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("logs GET requests with query params and JSON response without altering client output", async () => {
    const handler = withApiRequestLog(
      async () =>
        Response.json({
          object: "list",
          data: [{ id: "openai/gpt-4o", object: "model" }],
        }),
      { apiType: "models" }
    );

    const req = new Request("http://127.0.0.1:20127/api/v1/models?provider=openai", {
      method: "GET",
      headers: { authorization: "Bearer sk-secret-1234567890abcdef" },
    });

    const res = await handler(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data[0].id).toBe("openai/gpt-4o");

    const list = await listRequestLogs();
    expect(list.items).toHaveLength(1);
    expect(list.apiTypes).toContain("models");
    expect(list.items[0].method).toBe("GET");
    expect(list.items[0].apiType).toBe("models");
    expect(list.items[0].endpoint).toBe("/api/v1/models");
    expect(list.items[0].statusCode).toBe(200);

    const detail = await getRequestLogById(list.items[0].id);
    expect(detail.received.body).toEqual({ query: { provider: "openai" } });
    expect(detail.received.headers.authorization).not.toContain("1234567890");
    expect(detail.response.clientResponse.data[0].id).toBe("openai/gpt-4o");
  });

  it("compacts large embedding float vectors and base64 blobs on disk while keeping client response intact", async () => {
    const vector = Array.from({ length: 1536 }, (_, i) => i * 0.001);
    const bigB64 = "A".repeat(32 * 1024);

    const handler = withApiRequestLog(
      async (req) => {
        const body = await req.json();
        return Response.json({
          model: body.model,
          data: [{ embedding: vector, b64_json: bigB64 }],
        });
      },
      { apiType: "embeddings" }
    );

    const req = new Request("http://127.0.0.1:20127/api/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "hello world" }),
    });

    const res = await handler(req);
    const clientJson = await res.json();
    // Client still receives full uncompacted data
    expect(clientJson.data[0].embedding).toHaveLength(1536);
    expect(clientJson.data[0].b64_json).toHaveLength(32 * 1024);

    const list = await listRequestLogs({ apiType: "embeddings" });
    expect(list.items).toHaveLength(1);
    expect(list.items[0].provider).toBe("openai");
    expect(list.items[0].model).toBe("text-embedding-3-small");

    const detail = await getRequestLogById(list.items[0].id);
    expect(detail.received.body.input).toBe("hello world");
    expect(detail.response.clientResponse.data[0].embedding).toContain("float[1536] vector");
    expect(detail.response.clientResponse.data[0].b64_json).toContain("b64_json omitted");
  });

  it("logs multipart/form-data file metadata without consuming the upload stream", async () => {
    const audioBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    let receivedFileSize = 0;

    const handler = withApiRequestLog(
      async (req) => {
        const form = await req.formData();
        const file = form.get("file");
        const buf = await file.arrayBuffer();
        receivedFileSize = buf.byteLength;
        return Response.json({ text: "hello audio", model: form.get("model") });
      },
      { apiType: "audio" }
    );

    const formData = new FormData();
    formData.append("model", "openai/whisper-1");
    formData.append("file", new File([audioBytes], "sample.mp3", { type: "audio/mpeg" }));

    const req = new Request("http://127.0.0.1:20127/api/v1/audio/transcriptions", {
      method: "POST",
      body: formData,
    });

    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(receivedFileSize).toBe(audioBytes.byteLength);

    const list = await listRequestLogs({ apiType: "audio" });
    expect(list.items).toHaveLength(1);
    const detail = await getRequestLogById(list.items[0].id);
    expect(detail.received.body._multipart).toBe(true);
    expect(detail.received.body.fields.model).toBe("openai/whisper-1");
    expect(detail.received.body.fields.file).toMatchObject({
      _file: true,
      fileName: "sample.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 8,
    });
    expect(detail.response.clientResponse.text).toBe("hello audio");
  });

  it("logs binary audio responses as size/content-type metadata while returning exact bytes to client", async () => {
    const payload = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22]);

    const handler = withApiRequestLog(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
      { apiType: "audio" }
    );

    const req = new Request("http://127.0.0.1:20127/api/v1/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "edge-tts/en-US-AriaNeural", input: "hi" }),
    });

    const res = await handler(req);
    const received = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(received)).toEqual(Array.from(payload));

    const list = await listRequestLogs();
    const detail = await getRequestLogById(list.items[0].id);
    expect(detail.response.type).toBe("binary");
    expect(detail.response.clientResponse).toEqual({
      binary: true,
      contentType: "audio/mpeg",
      sizeBytes: 6,
    });
  });

  it("logs 4xx/5xx error responses and thrown exceptions", async () => {
    const errHandler = withApiRequestLog(
      async () =>
        Response.json({ error: { message: "Invalid API key" } }, { status: 401 }),
      { apiType: "count-tokens" }
    );
    const throwHandler = withApiRequestLog(
      async () => {
        throw new Error("Upstream boom");
      },
      { apiType: "search" }
    );

    const res401 = await errHandler(
      new Request("http://127.0.0.1:20127/api/v1/messages/count_tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-3-5-sonnet", messages: [] }),
      })
    );
    expect(res401.status).toBe(401);

    await expect(
      throwHandler(
        new Request("http://127.0.0.1:20127/api/v1/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "9router" }),
        })
      )
    ).rejects.toThrow("Upstream boom");

    // Allow async catch update to flush
    await new Promise((r) => setTimeout(r, 50));

    const list = await listRequestLogs();
    expect(list.items).toHaveLength(2);
    const searchItem = list.items.find((i) => i.apiType === "search");
    const countItem = list.items.find((i) => i.apiType === "count-tokens");

    expect(countItem.status).toBe("error");
    expect(countItem.statusCode).toBe(401);
    expect(searchItem.status).toBe("error");
    expect(searchItem.statusCode).toBe(500);

    const countDetail = await getRequestLogById(countItem.id);
    expect(countDetail.response.error).toBe("Invalid API key");
    const searchDetail = await getRequestLogById(searchItem.id);
    expect(searchDetail.response.error).toBe("Upstream boom");
  });

  it("respects shouldSkip predicate and filters listRequestLogs by apiType", async () => {
    const modelsHandler = withApiRequestLog(
      async () => Response.json({ object: "list", data: [] }),
      {
        apiType: "models",
        shouldSkip: (req) => req.headers.get("x-9router-internal-models-fetch") === "1",
      }
    );
    const webFetchHandler = withApiRequestLog(
      async () => Response.json({ content: "ok" }),
      { apiType: "web-fetch" }
    );

    // Skipped internal fetch
    await modelsHandler(
      new Request("http://127.0.0.1:20127/api/v1/models", {
        headers: { "x-9router-internal-models-fetch": "1" },
      })
    );
    // Normal client fetches
    await modelsHandler(new Request("http://127.0.0.1:20127/api/v1/models"));
    await webFetchHandler(
      new Request("http://127.0.0.1:20127/api/v1/web/fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      })
    );

    const all = await listRequestLogs();
    expect(all.items).toHaveLength(2);
    expect(all.apiTypes.sort()).toEqual(["models", "web-fetch"]);

    const onlyModels = await listRequestLogs({ apiType: "models" });
    expect(onlyModels.items).toHaveLength(1);
    expect(onlyModels.items[0].apiType).toBe("models");

    const onlyWeb = await listRequestLogs({ apiType: "web-fetch" });
    expect(onlyWeb.items).toHaveLength(1);
    expect(onlyWeb.items[0].apiType).toBe("web-fetch");
  });

  it("compactPayloadForLog keeps short strings and small arrays untouched", () => {
    const input = {
      name: "hello",
      scores: [0.1, 0.2, 0.3],
      nested: { dataUrl: `data:image/png;base64,${"B".repeat(20 * 1024)}` },
    };
    const out = compactPayloadForLog(input);
    expect(out.name).toBe("hello");
    expect(out.scores).toEqual([0.1, 0.2, 0.3]);
    expect(out.nested.dataUrl).toContain("base64/data omitted");
  });
});
