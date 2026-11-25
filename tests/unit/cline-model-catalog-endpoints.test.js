// Cline's model catalog is split across two endpoints, and the split matters:
//
//   GET /api/v1/ai/cline/models              → { data: [...] }  (the whole cloud catalog)
//   GET /api/v1/ai/cline/recommended-models → { recommended, free, clinePass, clineCloud }
//
// The `cline-pass/*` (ClinePass subscription) and `cline-free/*` ids exist ONLY in
// the recommended-models feed — `/api/v1/models` never carries them. Filtering
// `/api/v1/models` by the `cline-pass/` prefix therefore always returned an empty
// list, so the ClinePass picker never matched the Cline CLI.
//
// The CLI composes its own list as: [...clinePass, ...clineCloud, ...catalog].

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const CATALOG_URL = "https://api.cline.bot/api/v1/ai/cline/models";
const FEED_URL = "https://api.cline.bot/api/v1/ai/cline/recommended-models";
const LEGACY_MODELS_URL = "https://api.cline.bot/api/v1/models";

const CATALOG_RESPONSE = {
  data: [
    {
      id: "anthropic/claude-sonnet-5.5",
      name: "Claude Sonnet 5.5",
      context_length: 200000,
      top_provider: { context_length: 200000, max_completion_tokens: 64000 },
    },
    { id: "upstage/solar-mini-4-5", name: "Upstage: Solar Mini 4.5 (Preview)" },
  ],
};

const FEED_RESPONSE = {
  recommended: [{ id: "anthropic/claude-opus-5.5", name: "claude-opus-5.5", description: "", tags: ["NEW"] }],
  free: [
    { id: "cline-free/nemotron-3.5-super-vl", name: "cline-free/nemotron-3.5-super-vl", description: "", tags: [] },
    { id: "nvidia/nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning", description: "", tags: [] },
  ],
  clinePass: [
    { id: "cline-pass/deepseek-v4-pro", name: "cline-pass/deepseek-v4-pro", description: "", tags: [] },
    { id: "cline-pass/minimax-m3.1-flash", name: "cline-pass/minimax-m3.1-flash", description: "", tags: [] },
  ],
  clineCloud: [],
};

let fetchMock;

function jsonResponse(obj) {
  return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
}

beforeEach(() => {
  fetchMock = vi.fn(async (url) => {
    const urlStr = String(url);
    if (urlStr === CATALOG_URL) return jsonResponse(CATALOG_RESPONSE);
    if (urlStr === FEED_URL) return jsonResponse(FEED_RESPONSE);
    if (urlStr === LEGACY_MODELS_URL) return jsonResponse({ data: [] });
    throw new Error("unexpected fetch: " + url);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("resolveClinepassModels", () => {
  it("returns the feed's clinePass tier", async () => {
    const { resolveClinepassModels } = await import("../../open-sse/services/clinepassModels.js");
    const result = await resolveClinepassModels({ accessToken: "test-token" });
    expect(result).not.toBeNull();
    expect(result.models.map((m) => m.id)).toEqual([
      "cline-pass/deepseek-v4-pro",
      "cline-pass/minimax-m3.1-flash",
      "cline-free/nemotron-3.5-super-vl",
      "nvidia/nemotron-3.5-lightning-free",
    ]);
  });

  it("includes the feed's free tier (a ClinePass session serves it too)", async () => {
    const { resolveClinepassModels } = await import("../../open-sse/services/clinepassModels.js");
    const result = await resolveClinepassModels({ accessToken: "test-token" });
    const ids = result.models.map((m) => m.id);
    expect(ids).toContain("cline-free/nemotron-3.5-super-vl");
    expect(ids).toContain("nvidia/nemotron-3.5-lightning-free");
  });

  it("does not use the legacy /api/v1/models endpoint", async () => {
    const { resolveClinepassModels } = await import("../../open-sse/services/clinepassModels.js");
    await resolveClinepassModels({ accessToken: "test-token" });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain(LEGACY_MODELS_URL);
  });

  it("never leaks the plain cloud catalog into the ClinePass list", async () => {
    const { resolveClinepassModels } = await import("../../open-sse/services/clinepassModels.js");
    const result = await resolveClinepassModels({ accessToken: "test-token" });
    const ids = result.models.map((m) => m.id);
    expect(ids).not.toContain("anthropic/claude-sonnet-5.5");
  });

  it("returns null when the feed fails", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url) === CATALOG_URL) return jsonResponse(CATALOG_RESPONSE);
      return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
    });
    const { resolveClinepassModels } = await import("../../open-sse/services/clinepassModels.js");
    expect(await resolveClinepassModels({ accessToken: "test-token" })).toBeNull();
  });

  it("returns null when no token is available", async () => {
    const { resolveClinepassModels } = await import("../../open-sse/services/clinepassModels.js");
    expect(await resolveClinepassModels({})).toBeNull();
  });
});

describe("resolveClineModels", () => {
  it("returns the cloud catalog plus the feed's free tier", async () => {
    const { resolveClineModels } = await import("../../open-sse/services/clinepassModels.js");
    const result = await resolveClineModels({ accessToken: "test-token" });
    const ids = result.models.map((m) => m.id);
    expect(ids).toContain("anthropic/claude-sonnet-5.5");
    expect(ids).toContain("upstage/solar-mini-4-5");
    expect(ids).toContain("cline-free/nemotron-3.5-super-vl");
    expect(ids).toContain("nvidia/nemotron-3.5-lightning-free");
  });

  it("does not leak the cline-pass subscription tier into the cline list", async () => {
    const { resolveClineModels } = await import("../../open-sse/services/clinepassModels.js");
    const result = await resolveClineModels({ accessToken: "test-token" });
    const ids = result.models.map((m) => m.id);
    expect(ids).not.toContain("cline-pass/deepseek-v4-pro");
    expect(ids).not.toContain("cline-pass/minimax-m3.1-flash");
  });

  it("carries the catalog's context window", async () => {
    const { resolveClineModels } = await import("../../open-sse/services/clinepassModels.js");
    const result = await resolveClineModels({ accessToken: "test-token" });
    const entry = result.models.find((m) => m.id === "anthropic/claude-sonnet-5.5");
    expect(entry.contextLength).toBe(200000);
    expect(entry.maxOutput).toBe(64000);
  });

  it("falls back to the feed's recommended list when the catalog endpoint fails", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url) === FEED_URL) return jsonResponse(FEED_RESPONSE);
      return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
    });
    const { resolveClineModels } = await import("../../open-sse/services/clinepassModels.js");
    const result = await resolveClineModels({ accessToken: "test-token" });
    const ids = result.models.map((m) => m.id);
    expect(ids).toContain("anthropic/claude-opus-5.5");
    expect(ids).toContain("cline-free/nemotron-3.5-super-vl");
  });

  it("survives a failing feed and still returns the catalog", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url) === CATALOG_URL) return jsonResponse(CATALOG_RESPONSE);
      return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
    });
    const { resolveClineModels } = await import("../../open-sse/services/clinepassModels.js");
    const result = await resolveClineModels({ accessToken: "test-token" });
    expect(result.models.map((m) => m.id)).toEqual([
      "anthropic/claude-sonnet-5.5",
      "upstage/solar-mini-4-5",
    ]);
  });

  it("deduplicates ids present in both sources", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url) === CATALOG_URL) {
        return jsonResponse({ data: [{ id: "cline-free/nemotron-3.5-super-vl", name: "Catalog Nemotron" }] });
      }
      return jsonResponse(FEED_RESPONSE);
    });
    const { resolveClineModels } = await import("../../open-sse/services/clinepassModels.js");
    const result = await resolveClineModels({ accessToken: "test-token" });
    const ids = result.models.map((m) => m.id);
    expect(ids.filter((id) => id === "cline-free/nemotron-3.5-super-vl")).toHaveLength(1);
    // The catalog entry wins on a shared id.
    expect(result.models.find((m) => m.id === "cline-free/nemotron-3.5-super-vl").name).toBe("Catalog Nemotron");
  });

  it("returns null when no token is available", async () => {
    const { resolveClineModels } = await import("../../open-sse/services/clinepassModels.js");
    expect(await resolveClineModels({})).toBeNull();
  });

  it("returns null on fetch error", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));
    const { resolveClineModels } = await import("../../open-sse/services/clinepassModels.js");
    expect(await resolveClineModels({ accessToken: "test-token" })).toBeNull();
  });
});
