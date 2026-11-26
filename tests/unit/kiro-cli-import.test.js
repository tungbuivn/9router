import { describe, it, expect } from "vitest";
import http from "node:http";

const {
  parseKiroCliTokenPayload,
  getKiroCliDataDbPaths,
  getKiroCliHomePaths,
  KIRO_CLI_TOKEN_KEYS,
} = await import("../../src/lib/oauth/utils/kiroCliCredentials.js");

const {
  extractBearerToken,
  extractRefreshTokenFromBody,
  decodeJwtPayload,
  captureKiroAuthFromW2,
} = await import("../../src/lib/oauth/utils/kiroW2Capture.js");

describe("Kiro CLI token payload parsing", () => {
  it("parses the kiro-cli 3.5.0 auth_kv shape", () => {
    const raw = JSON.stringify({
      access_token: "access-1",
      expires_at: "2026-11-26T03:40:59.146Z",
      refresh_token: "refresh-1",
      telemetry_generation: "a".repeat(64),
      provider: "google",
      profile_arn: "arn:aws:codewhisperer:us-east-1:123:profile/ABC",
    });

    const parsed = parseKiroCliTokenPayload(raw, "kirocli:social:token");
    expect(parsed.accessToken).toBe("access-1");
    expect(parsed.refreshToken).toBe("refresh-1");
    expect(parsed.expiresAt).toBe("2026-11-26T03:40:59.146Z");
    expect(parsed.profileArn).toBe("arn:aws:codewhisperer:us-east-1:123:profile/ABC");
    expect(parsed.provider).toBe("google");
    expect(parsed.region).toBe("us-east-1");
    expect(parsed.authMethod).toBe("social");
  });

  it("accepts camelCase keys and a nested token object", () => {
    const parsed = parseKiroCliTokenPayload(
      JSON.stringify({ token: { accessToken: "a2", refreshToken: "r2", expiresAt: 1764000000000 } }),
    );
    expect(parsed.accessToken).toBe("a2");
    expect(parsed.refreshToken).toBe("r2");
    expect(parsed.expiresAt).toBe(new Date(1764000000000).toISOString());
  });

  it("flags IDC sessions and keeps the client credentials", () => {
    const parsed = parseKiroCliTokenPayload(
      JSON.stringify({
        access_token: "a3",
        refresh_token: "r3",
        client_id: "cid",
        client_secret: "csecret",
        region: "eu-west-1",
      }),
      "kirocli:idc:token",
    );
    expect(parsed.authMethod).toBe("idc");
    expect(parsed.clientId).toBe("cid");
    expect(parsed.clientSecret).toBe("csecret");
    expect(parsed.region).toBe("eu-west-1");
  });

  it("returns null for unusable payloads", () => {
    expect(parseKiroCliTokenPayload("not json")).toBeNull();
    expect(parseKiroCliTokenPayload("")).toBeNull();
    expect(parseKiroCliTokenPayload(null)).toBeNull();
    expect(parseKiroCliTokenPayload(JSON.stringify({ unrelated: true }))).toBeNull();
  });

  it("exposes the known auth_kv keys", () => {
    expect(KIRO_CLI_TOKEN_KEYS).toContain("kirocli:social:token");
    expect(KIRO_CLI_TOKEN_KEYS).toContain("kirocli:idc:token");
  });
});

describe("Kiro CLI paths", () => {
  it("always includes a kiro-cli data.sqlite3 candidate", () => {
    const paths = getKiroCliDataDbPaths();
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => p.endsWith("data.sqlite3"))).toBe(true);
    expect(paths.some((p) => p.includes("kiro-cli"))).toBe(true);
  });

  it("honours KIRO_DATA_DIR", () => {
    const previous = process.env.KIRO_DATA_DIR;
    process.env.KIRO_DATA_DIR = "/tmp/kiro-data";
    try {
      expect(getKiroCliDataDbPaths()[0]).toBe("/tmp/kiro-data/data.sqlite3");
    } finally {
      if (previous === undefined) delete process.env.KIRO_DATA_DIR;
      else process.env.KIRO_DATA_DIR = previous;
    }
  });

  it("falls back to ~/.kiro for the CLI home", () => {
    expect(getKiroCliHomePaths().some((p) => p.endsWith(".kiro"))).toBe(true);
  });
});

describe("w2 capture helpers", () => {
  it("extracts a bearer token from the Authorization header", () => {
    expect(extractBearerToken({ Authorization: "Bearer abcdefghijklmnop" })).toBe("abcdefghijklmnop");
    expect(extractBearerToken({ authorization: "bearer abcdefghijklmnop" })).toBe("abcdefghijklmnop");
    expect(extractBearerToken({ Authorization: "Basic abc" })).toBeNull();
    expect(extractBearerToken({})).toBeNull();
  });

  it("extracts a refresh token from a JSON body", () => {
    const parsed = extractRefreshTokenFromBody(
      JSON.stringify({ refreshToken: "r-1", clientId: "cid", clientSecret: "cs" }),
    );
    expect(parsed.refreshToken).toBe("r-1");
    expect(parsed.clientId).toBe("cid");
    expect(parsed.clientSecret).toBe("cs");
  });

  it("extracts a refresh token from a form-encoded body", () => {
    const parsed = extractRefreshTokenFromBody(
      "grant_type=refresh_token&refresh_token=r-2&client_id=cid2",
    );
    expect(parsed.refreshToken).toBe("r-2");
    expect(parsed.clientId).toBe("cid2");
  });

  it("ignores bodies without a refresh token", () => {
    expect(extractRefreshTokenFromBody("")).toBeNull();
    expect(extractRefreshTokenFromBody(JSON.stringify({ foo: "bar" }))).toBeNull();
  });

  it("decodes a JWT payload without verifying it", () => {
    const payload = Buffer.from(JSON.stringify({ email: "a@b.c" })).toString("base64url");
    expect(decodeJwtPayload(`header.${payload}.sig`).email).toBe("a@b.c");
    expect(decodeJwtPayload("not-a-jwt")).toBeNull();
  });
});

describe("captureKiroAuthFromW2", () => {
  async function withW2Server(entries, fn) {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { data: entries } }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      return await fn(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it("recovers the refresh token from a captured OIDC token request", async () => {
    const body = JSON.stringify({ clientId: "cid", clientSecret: "cs", refreshToken: "r-9" });
    const entries = {
      a: {
        id: "a",
        url: "https://oidc.us-east-1.amazonaws.com/token",
        startTime: Date.now(),
        req: {
          method: "POST",
          headers: { "content-type": "application/json" },
          base64: Buffer.from(body).toString("base64"),
          body: "",
        },
      },
    };

    const result = await withW2Server(entries, (url) => captureKiroAuthFromW2({ w2Url: url }));
    expect(result.found).toBe(true);
    expect(result.refreshToken).toBe("r-9");
    expect(result.clientId).toBe("cid");
    expect(result.region).toBe("us-east-1");
    expect(result.authMethod).toBe("idc");
  });

  it("recovers the access token from a captured Kiro upstream call", async () => {
    const jwt = `h.${Buffer.from(JSON.stringify({ email: "user@example.com", exp: 1764000000 })).toString("base64url")}.s`;
    const entries = {
      b: {
        id: "b",
        url: "https://runtime.us-east-1.kiro.dev/v1/responses",
        startTime: Date.now(),
        req: {
          method: "POST",
          headers: { authorization: `Bearer ${jwt}` },
          body: "",
        },
      },
    };

    const result = await withW2Server(entries, (url) => captureKiroAuthFromW2({ w2Url: url }));
    expect(result.found).toBe(true);
    expect(result.accessToken).toBe(jwt);
    expect(result.email).toBe("user@example.com");
    expect(result.expiresAt).toBe(new Date(1764000000 * 1000).toISOString());
  });

  it("reports not-found when no Kiro traffic was captured", async () => {
    const entries = {
      c: {
        id: "c",
        url: "https://example.com/v1/chat/completions",
        startTime: Date.now(),
        req: { method: "POST", headers: {}, body: "" },
      },
    };

    const result = await withW2Server(entries, (url) => captureKiroAuthFromW2({ w2Url: url }));
    expect(result.found).toBe(false);
    expect(result.error).toContain("No Kiro credentials found");
  });
});
