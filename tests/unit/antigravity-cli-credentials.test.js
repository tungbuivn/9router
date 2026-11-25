import { describe, it, expect } from "vitest";

const {
  parseTokenEnvelope,
  readAntigravityCliCredentials,
  ANTIGRAVITY_KEYRING_SERVICE,
  ANTIGRAVITY_KEYRING_USER,
} = await import("../../src/lib/oauth/utils/antigravityCredentials.js");

describe("Antigravity CLI credential parsing", () => {
  it("decodes the CLI token envelope (agy 1.5.16 shape)", () => {
    const raw = JSON.stringify({
      token: {
        access_token: "ya29.access",
        refresh_token: "1//refresh",
        expiry: "2026-11-25T10:41:51.135157262+07:00",
        expires_in: 3599,
      },
      auth_method: "consumer",
      id_token_email: "user@example.com",
    });

    const parsed = parseTokenEnvelope(raw);
    expect(parsed.refreshToken).toBe("1//refresh");
    expect(parsed.accessToken).toBe("ya29.access");
    expect(parsed.email).toBe("user@example.com");
    expect(parsed.authMethod).toBe("consumer");
    // Offset-normalized to UTC ISO.
    expect(parsed.expiresAt).toBe("2026-11-25T03:41:51.135Z");
  });

  it("accepts a bare token object (no outer envelope)", () => {
    const parsed = parseTokenEnvelope(
      JSON.stringify({ access_token: "a1", refresh_token: "r1" }),
    );
    expect(parsed.refreshToken).toBe("r1");
    expect(parsed.accessToken).toBe("a1");
    expect(parsed.email).toBeNull();
  });

  it("strips a Bearer prefix and surrounding whitespace", () => {
    const parsed = parseTokenEnvelope(
      JSON.stringify({ token: { access_token: " at ", refresh_token: "Bearer  rt" } }),
    );
    expect(parsed.accessToken).toBe("at");
    expect(parsed.refreshToken).toBe("rt");
  });

  it("returns null for unparseable input", () => {
    expect(parseTokenEnvelope("not json")).toBeNull();
    expect(parseTokenEnvelope("")).toBeNull();
    expect(parseTokenEnvelope(null)).toBeNull();
  });

  it("returns null when neither token is present", () => {
    expect(parseTokenEnvelope(JSON.stringify({ token: {} }))).toBeNull();
    expect(parseTokenEnvelope(JSON.stringify({ auth_method: "consumer" }))).toBeNull();
  });

  it("keeps the keyring lookup keyed on service=gemini, username=antigravity", () => {
    // The CLI writes this item; changing either half silently breaks the import.
    expect(ANTIGRAVITY_KEYRING_SERVICE).toBe("gemini");
    expect(ANTIGRAVITY_KEYRING_USER).toBe("antigravity");
  });
});

describe("readAntigravityCliCredentials", () => {
  it("never throws and always returns a boolean `found`", async () => {
    const result = await readAntigravityCliCredentials();
    expect(typeof result.found).toBe("boolean");
    if (result.found) {
      // A usable import always carries a refresh token, never only an access token.
      expect(typeof result.refreshToken).toBe("string");
      expect(result.refreshToken.length).toBeGreaterThan(0);
    } else {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
  }, 20000);
});
