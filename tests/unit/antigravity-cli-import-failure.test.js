import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Failure path for the Antigravity CLI import. Lives in its own file because
 * refreshGoogleToken dedupes results for 10s per token — sharing a module
 * registry with the success-path test would let the cached success mask the
 * mocked failure (vitest isolates modules per test file).
 */
const dataDir = mkdtempSync(join(tmpdir(), "9r-ag-cli-fail-"));
const originalDataDir = process.env.DATA_DIR;
const originalFetch = globalThis.fetch;

process.env.DATA_DIR = dataDir;

afterAll(() => {
  globalThis.fetch = originalFetch;
  rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("antigravity CLI auto-import failure path", () => {
  it("returns 400 (not a connection) when the refresh token is rejected", async () => {
    const route = await import("../../src/app/api/oauth/antigravity/auto-import/route.js");

    const detected = await (await route.GET()).json();
    if (!detected.found) {
      // No CLI session on this host — the failure path needs a token to reject.
      expect(detected.error).toBeTruthy();
      return;
    }

    // Every network call the exchange makes now fails like a revoked grant.
    globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => "invalid_grant" });

    const res = await route.POST();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/exchange/i);

    // A failed exchange must not leave a broken connection behind.
    const { getProviderConnections } = await import("../../src/models/index.js");
    const rows = await getProviderConnections({ provider: "antigravity" });
    expect(rows).toHaveLength(0);
  }, 40000);
});
