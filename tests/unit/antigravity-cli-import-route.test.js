import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * End-to-end import: reads the real Antigravity CLI keyring entry, exchanges its
 * refresh token with Google, and writes a connection into an isolated DATA_DIR.
 * Skipped when the CLI is not signed in on this host.
 */
let dataDir;
let originalDataDir;
const originalFetch = globalThis.fetch;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "9r-ag-cli-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("antigravity CLI auto-import route", () => {
  it("GET reports detection without leaking the token", async () => {
    const { GET } = await import("../../src/app/api/oauth/antigravity/auto-import/route.js");
    const res = await GET();
    const body = await res.json();

    expect(body).not.toHaveProperty("refreshToken");
    expect(body).not.toHaveProperty("accessToken");
    expect(typeof body.found).toBe("boolean");
    if (!body.found) expect(typeof body.error).toBe("string");
  }, 20000);

  it("POST imports a connection, then refreshes it instead of duplicating", async () => {
    const { GET } = await import("../../src/app/api/oauth/antigravity/auto-import/route.js");
    const detected = await (await GET()).json();
    if (!detected.found) {
      // No CLI session on this host — nothing to import.
      expect(detected.error).toBeTruthy();
      return;
    }

    const { POST } = await import("../../src/app/api/oauth/antigravity/auto-import/route.js");
    const first = await POST();
    const firstBody = await first.json();
    expect(first.status).toBe(200);
    expect(firstBody.success).toBe(true);
    expect(firstBody.reused).toBeFalsy();
    expect(firstBody.connection.email).toBe(detected.email);

    // The stored refresh token must be the CLI's (server-side only, never echoed).
    const { getProviderConnections } = await import("../../src/models/index.js");
    const rows = await getProviderConnections({ provider: "antigravity" });
    expect(rows).toHaveLength(1);
    expect(rows[0].refreshToken).toBeTruthy();
    expect(rows[0].email).toBe(detected.email);
    expect(firstBody).not.toHaveProperty("refreshToken");

    // Re-import must update in place rather than stack a second account row.
    const second = await POST();
    const secondBody = await second.json();
    expect(secondBody.success).toBe(true);
    expect(secondBody.reused).toBe(true);
    expect(await getProviderConnections({ provider: "antigravity" })).toHaveLength(1);
  }, 90000);

  it("re-import preserves existing providerSpecificData instead of replacing it", async () => {
    const detected = await (
      await (await import("../../src/app/api/oauth/antigravity/auto-import/route.js")).GET()
    ).json();
    if (!detected.found) return; // needs a live CLI session

    const { getProviderConnections, updateProviderConnection } = await import("../../src/models/index.js");
    const [conn] = await getProviderConnections({ provider: "antigravity" });
    expect(conn).toBeTruthy();

    // Simulate provider-specific state a real connection carries (proxy config).
    await updateProviderConnection(conn.id, {
      providerSpecificData: { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.local:8080" },
    });

    const { POST } = await import("../../src/app/api/oauth/antigravity/auto-import/route.js");
    expect((await POST()).status).toBe(200);

    const [after] = await getProviderConnections({ provider: "antigravity" });
    // updateProviderConnection merges shallowly — the route must not drop these.
    expect(after.providerSpecificData.connectionProxyEnabled).toBe(true);
    expect(after.providerSpecificData.connectionProxyUrl).toBe("http://proxy.local:8080");
    expect(after.providerSpecificData.authMethod).toBe("antigravity-cli");
  }, 60000);
});
