import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
      ok: !init?.status || (init.status >= 200 && init.status < 300),
    })),
  },
}));

// Mock os
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...actual, homedir: vi.fn(() => "/mock/home") },
    homedir: vi.fn(() => "/mock/home"),
  };
});

// Mock fs/promises
vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

// Mock models
const mockConnections = [];
vi.mock("@/models", () => ({
  getProviderConnections: vi.fn(async ({ provider }) =>
    mockConnections.filter((c) => c.provider === provider)
  ),
  createProviderConnection: vi.fn(async (data) => {
    const conn = { id: `conn-${Date.now()}-${Math.random()}`, ...data };
    mockConnections.push(conn);
    return conn;
  }),
  updateProviderConnection: vi.fn(async (id, data) => {
    const idx = mockConnections.findIndex((c) => c.id === id);
    if (idx !== -1) {
      mockConnections[idx] = { ...mockConnections[idx], ...data };
      return mockConnections[idx];
    }
    return null;
  }),
}));

import * as fsPromises from "fs/promises";
import { parseClineProviders, readClineCliCredentials } from "../../src/lib/oauth/utils/clineCredentials.js";
import { GET, POST } from "../../src/app/api/oauth/cline/auto-import/route.js";

describe("Cline CLI Auto-Import", () => {
  const sampleProvidersJson = {
    version: 1,
    lastUsedProvider: "cline-pass",
    providers: {
      cline: {
        settings: {
          provider: "cline",
          auth: {
            accessToken: "workos:eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6InRlc3RAY2xpbmUuYm90In0.sig",
            refreshToken: "refresh-token-cline-123",
            expiresAt: Date.now() + 3600000,
            accountId: "usr-cline-1",
            metadata: {
              userInfo: {
                email: "test@cline.bot",
                name: "Cline User",
              },
            },
          },
          model: "cline-free/test-model",
        },
        updatedAt: new Date().toISOString(),
      },
      "cline-pass": {
        settings: {
          provider: "cline-pass",
          auth: {
            accessToken: "workos:eyJhbGciOiJSUzI1NiJ9.expired.sig",
            refreshToken: "refresh-token-cline-123",
            expiresAt: Date.now() - 3600000, // Expired
            accountId: "usr-cline-1",
            metadata: {
              userInfo: {
                email: "test@cline.bot",
                name: "Cline User",
              },
            },
          },
          model: "cline-pass/deepseek-v4-pro",
        },
        updatedAt: new Date(Date.now() - 86400000).toISOString(),
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnections.length = 0;
  });

  describe("parseClineProviders", () => {
    it("returns empty array for invalid JSON or missing providers", () => {
      expect(parseClineProviders("")).toEqual([]);
      expect(parseClineProviders("invalid json")).toEqual([]);
      expect(parseClineProviders(JSON.stringify({}))).toEqual([]);
      expect(parseClineProviders(JSON.stringify({ providers: {} }))).toEqual([]);
    });

    it("extracts and prefers valid, unexpired token when targeting clinepass", () => {
      const entries = parseClineProviders(JSON.stringify(sampleProvidersJson), "clinepass");
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry.provider).toBe("clinepass");
      // Because cline-pass was expired, it falls back to the valid token from cline
      expect(entry.refreshToken).toBe("refresh-token-cline-123");
      expect(entry.email).toBe("test@cline.bot");
      expect(entry.displayName).toBe("Cline User");
      expect(entry.accessToken).toContain("workos:");
    });

    it("extracts both cline and clinepass when no targetProvider specified", () => {
      const entries = parseClineProviders(JSON.stringify(sampleProvidersJson));
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.provider)).toEqual(["cline", "clinepass"]);
    });
  });

  describe("readClineCliCredentials", () => {
    it("returns found: false when providers.json is missing", async () => {
      fsPromises.readFile.mockRejectedValue(new Error("ENOENT"));
      const result = await readClineCliCredentials("clinepass");
      expect(result.found).toBe(false);
      expect(result.error).toContain("Cline CLI credentials not found");
    });

    it("returns found: true and parsed entries when file exists", async () => {
      fsPromises.readFile.mockResolvedValue(JSON.stringify(sampleProvidersJson));
      const result = await readClineCliCredentials("clinepass");
      expect(result.found).toBe(true);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].provider).toBe("clinepass");
    });
  });

  describe("GET /api/oauth/cline/auto-import", () => {
    it("reports sessions metadata without leaking token", async () => {
      fsPromises.readFile.mockResolvedValue(JSON.stringify(sampleProvidersJson));

      const req = new Request("http://localhost/api/oauth/cline/auto-import?provider=clinepass");
      const res = await GET(req);
      const data = await res.json();

      expect(data.found).toBe(true);
      expect(data.sessions).toHaveLength(1);
      expect(data.sessions[0].provider).toBe("clinepass");
      expect(data.sessions[0].email).toBe("test@cline.bot");
      expect(data.sessions[0].hasRefreshToken).toBe(true);
      // Ensure access token is NOT exposed in GET response
      expect(data.sessions[0].accessToken).toBeUndefined();
    });
  });

  describe("POST /api/oauth/cline/auto-import", () => {
    it("imports session as provider connection in database", async () => {
      fsPromises.readFile.mockResolvedValue(JSON.stringify(sampleProvidersJson));

      const req = new Request("http://localhost/api/oauth/cline/auto-import", {
        method: "POST",
        body: JSON.stringify({ provider: "clinepass" }),
      });
      const res = await POST(req);
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.imported).toHaveLength(1);
      expect(data.imported[0].provider).toBe("clinepass");
      expect(data.imported[0].email).toBe("test@cline.bot");
      expect(data.imported[0].reused).toBe(false);

      // Verify connection created in database mock
      expect(mockConnections).toHaveLength(1);
      expect(mockConnections[0].provider).toBe("clinepass");
      expect(mockConnections[0].email).toBe("test@cline.bot");
      expect(mockConnections[0].authType).toBe("oauth");
      expect(mockConnections[0].testStatus).toBe("active");
    });

    it("re-importing updates existing connection instead of duplicating", async () => {
      fsPromises.readFile.mockResolvedValue(JSON.stringify(sampleProvidersJson));

      // First import
      const req1 = new Request("http://localhost/api/oauth/cline/auto-import", {
        method: "POST",
        body: JSON.stringify({ provider: "clinepass" }),
      });
      await POST(req1);
      expect(mockConnections).toHaveLength(1);

      // Second import
      const req2 = new Request("http://localhost/api/oauth/cline/auto-import", {
        method: "POST",
        body: JSON.stringify({ provider: "clinepass" }),
      });
      const res2 = await POST(req2);
      const data2 = await res2.json();

      expect(data2.success).toBe(true);
      expect(data2.imported[0].reused).toBe(true);
      expect(mockConnections).toHaveLength(1); // Still 1 connection
    });
  });
});
