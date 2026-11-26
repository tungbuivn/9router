// Claude settings Apply → ~/.claude/settings.json.
//
// Two guarantees are pinned here:
//  1. Apply always writes CLAUDE_CODE_AUTO_MODE_SERVER=0, so Claude Code's
//     own auto-mode server stays off and traffic goes to 9router only.
//  2. Apply must not blow up on a hand-edited settings.json. Claude Code (and
//     users) write JSONC with trailing commas; a plain JSON.parse here turns
//     "Apply" into a 500 and the dashboard silently keeps the old config.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HOME = "/tmp/9r-claude-home";

const fsMock = vi.hoisted(() => {
  const files = new Map();
  return {
    files,
    readFile: vi.fn(async (p) => {
      if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(p);
    }),
    writeFile: vi.fn(async (p, content) => { files.set(p, content); }),
    mkdir: vi.fn(async () => {}),
    access: vi.fn(async () => {}),
  };
});

vi.mock("fs/promises", () => ({ default: fsMock, ...fsMock }));
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  // The route imports the default export (`import os from "os"`), so the
  // override has to land on `default` too — not just the named export.
  const patched = { ...actual, homedir: () => HOME };
  return { ...patched, default: patched };
});
// exec is only used to detect the CLI; fail it so the route falls back to the
// settings-file check instead of spawning a real process.
vi.mock("child_process", () => ({
  exec: vi.fn((_cmd, _opts, cb) => {
    const done = typeof _opts === "function" ? _opts : cb;
    done(new Error("not found"));
  }),
}));

const { POST, DELETE } = await import("../../src/app/api/cli-tools/claude-settings/route.js");

const SETTINGS = `${HOME}/.claude/settings.json`;
const CLAUDE_JSON = `${HOME}/.claude.json`;

const post = (body) => POST({ json: async () => body });
const readSettings = () => JSON.parse(fsMock.files.get(SETTINGS));

beforeEach(() => {
  fsMock.files.clear();
  fsMock.files.set(SETTINGS, JSON.stringify({
    hasCompletedOnboarding: true,
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:20127/", ANTHROPIC_AUTH_TOKEN: "sk-existing" },
  }, null, 2));
});

describe("claude-settings Apply", () => {
  it("writes CLAUDE_CODE_AUTO_MODE_SERVER=0 so Claude Code uses 9router only", async () => {
    const res = await post({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:20127/" } });
    expect(res.status).toBe(200);
    expect(readSettings().env.CLAUDE_CODE_AUTO_MODE_SERVER).toBe("0");
  });

  it("keeps the auto-mode server disabled even when the payload omits it", async () => {
    // The dashboard always sends it; a stale/absent key must not re-enable the
    // CLI's own listener, so the route defaults it to "0" rather than dropping it.
    fsMock.files.set(SETTINGS, JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:20127/", CLAUDE_CODE_AUTO_MODE_SERVER: "1" },
    }, null, 2));
    await post({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:20127/" } });
    expect(readSettings().env.CLAUDE_CODE_AUTO_MODE_SERVER).toBe("0");
  });

  it("preserves unrelated settings and env entries", async () => {
    fsMock.files.set(SETTINGS, JSON.stringify({
      hasCompletedOnboarding: true,
      model: "haiku",
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }] },
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:20127/",
        ANTHROPIC_AUTH_TOKEN: "sk-existing",
        MY_CUSTOM_KEY: "keep-me",
      },
    }, null, 2));
    await post({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:20127/" } });
    const s = readSettings();
    expect(s.model).toBe("haiku");
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe("rtk hook claude");
    // Env entries the route does not manage survive the write.
    expect(s.env.MY_CUSTOM_KEY).toBe("keep-me");
    // An existing token is preserved, not replaced by the payload.
    expect(s.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-existing");
  });

  it("writes the context-window value the payload carries", async () => {
    await post({
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:20127/" },
      maxContextTokens: "1000000",
    });
    expect(readSettings().env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("1000000");
  });

  it("applies to a settings.json that has trailing commas (JSONC)", async () => {
    fsMock.files.set(SETTINGS, `{
  "hasCompletedOnboarding": true,
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:20127/",
  },
}`);
    const res = await post({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:20127/" } });
    expect(res.status).toBe(200);
    expect(readSettings().env.CLAUDE_CODE_AUTO_MODE_SERVER).toBe("0");
    expect(readSettings().env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:20127/");
  });

  it("Reset removes the auto-mode key again", async () => {
    await post({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:20127/" } });
    expect(readSettings().env.CLAUDE_CODE_AUTO_MODE_SERVER).toBe("0");
    const res = await DELETE();
    expect(res.status).toBe(200);
    // Reset clears the whole managed env block, so `env` may be gone entirely.
    expect(readSettings().env?.CLAUDE_CODE_AUTO_MODE_SERVER).toBeUndefined();
  });
});

describe("claude-settings card", () => {
  it("sends CLAUDE_CODE_AUTO_MODE_SERVER=0 from the Apply button", async () => {
    // "fs/promises" is mocked above; "node:fs" is not, so read the real file.
    const card = readFileSync(
      fileURLToPath(new URL("../../src/app/(dashboard)/dashboard/cli-tools/components/ClaudeToolCard.js", import.meta.url)),
      "utf-8"
    );
    // The Apply payload and the manual-copy snippet must agree, otherwise the
    // snippet tells the user to write something the button does not.
    expect(card).toContain('env.CLAUDE_CODE_AUTO_MODE_SERVER = "0";');
    expect(card.match(/CLAUDE_CODE_AUTO_MODE_SERVER/g)).toHaveLength(3);
  });

  it("keeps the Exa MCP toggle off the settings.json write path", async () => {
    // Exa lives in ~/.claude.json; settings.json must not gain an mcpServers key.
    const res = await post({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:20127/" }, exaMcpEnabled: false });
    expect(res.status).toBe(200);
    expect(readSettings().mcpServers).toBeUndefined();
    expect(fsMock.files.has(CLAUDE_JSON)).toBe(true);
  });
});
