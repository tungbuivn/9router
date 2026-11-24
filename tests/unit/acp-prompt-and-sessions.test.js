import { describe, it, expect, beforeEach } from "vitest";
import { buildAcpPrompt } from "../../open-sse/executors/acp.js";
import {
  buildAcpSessionKey,
  claimAcpSession,
  clearAcpSessions,
  dropAcpSession,
  peekAcpSession,
  saveAcpSession,
} from "../../open-sse/utils/acpSessionStore.js";

const turns = (items) => items.map(([role, content]) => ({ role, content }));

describe("buildAcpPrompt", () => {
  it("keeps a single-turn request plain (no framing)", () => {
    const out = buildAcpPrompt(turns([["user", "Fix the build"]]), { stripSystemPrompt: true });
    expect(out.prompt).toBe("Fix the build");
    expect(out.currentRequestText).toBe("Fix the build");
    expect(out.canResume).toBe(false);
    expect(out.historyTurns).toBe(0);
  });

  it("frames history and marks the newest turn as the current request", () => {
    const out = buildAcpPrompt(
      turns([
        ["user", "How does ACP stream?"],
        ["assistant", "Via a bridge."],
        ["user", "Move nvm to C:\\"],
      ]),
      { stripSystemPrompt: true }
    );

    expect(out.prompt).toContain("## Conversation so far");
    expect(out.prompt).toContain("User: How does ACP stream?");
    expect(out.prompt).toContain("Assistant: Via a bridge.");
    expect(out.prompt).toContain("## Current request\nMove nvm to C:\\");
    expect(out.prompt).toContain("never continue or complete an earlier answer");
    // The request must come after the history so it is the last thing the agent reads.
    expect(out.prompt.indexOf("## Current request")).toBeGreaterThan(
      out.prompt.indexOf("## Conversation so far")
    );
    expect(out.currentRequestText).toBe("Move nvm to C:\\");
    expect(out.canResume).toBe(true);
  });

  it("labels tool turns distinctly from user turns", () => {
    const out = buildAcpPrompt(
      turns([
        ["user", "run it"],
        ["tool", "exit code 1"],
        ["user", "why?"],
      ]),
      { stripSystemPrompt: true }
    );
    expect(out.prompt).toContain("Tool: exit code 1");
  });

  it("drops the oldest turns and records how many were omitted", () => {
    const out = buildAcpPrompt(
      turns([
        ["user", "one"],
        ["assistant", "two"],
        ["user", "three"],
        ["assistant", "four"],
        ["user", "five"],
      ]),
      { stripSystemPrompt: true, limits: { historyMaxTurns: 1 } }
    );

    expect(out.historyTurns).toBe(4);
    expect(out.omittedTurns).toBe(3);
    expect(out.prompt).toContain("(3 earlier turn(s) omitted)");
    // Newest history turn is kept, the oldest ones are gone.
    expect(out.prompt).toContain("Assistant: four");
    expect(out.prompt).not.toContain("User: one");
  });

  it("caps very long turns", () => {
    const long = "x".repeat(500);
    const out = buildAcpPrompt(
      turns([
        ["user", long],
        ["assistant", "ok"],
        ["user", "next"],
      ]),
      { stripSystemPrompt: true, limits: { turnMaxChars: 100 } }
    );
    expect(out.prompt).toContain("[turn truncated 400 chars]");
    expect(out.prompt.length).toBeLessThan(long.length);
  });

  it("includes the system prompt only when stripping is disabled", () => {
    const withSystem = buildAcpPrompt(
      turns([
        ["system", "Be terse"],
        ["user", "a"],
        ["user", "b"],
      ]),
      { stripSystemPrompt: false }
    );
    expect(withSystem.prompt.startsWith("## System instructions\nBe terse")).toBe(true);

    const stripped = buildAcpPrompt(
      turns([
        ["system", "Be terse"],
        ["user", "a"],
        ["user", "b"],
      ]),
      { stripSystemPrompt: true }
    );
    expect(stripped.prompt).not.toContain("Be terse");
  });

  it("collects only earlier user turns for the session fingerprint", () => {
    const out = buildAcpPrompt(
      turns([
        ["user", "first"],
        ["assistant", "reply"],
        ["user", "second"],
        ["assistant", "reply 2"],
        ["user", "third"],
      ]),
      { stripSystemPrompt: true }
    );
    expect(out.historyUserTexts).toEqual(["first", "second"]);
  });

  it("cannot resume when the last turn is not a user turn", () => {
    const out = buildAcpPrompt(
      turns([
        ["user", "first"],
        ["assistant", "reply"],
      ]),
      { stripSystemPrompt: true }
    );
    expect(out.canResume).toBe(false);
  });
});

describe("ACP session store", () => {
  beforeEach(() => {
    clearAcpSessions();
  });

  it("returns no key without earlier user turns", () => {
    expect(buildAcpSessionKey({ command: "agy", historyUserTexts: [] })).toBeNull();
    expect(buildAcpSessionKey({})).toBeNull();
  });

  it("fingerprints on user turns, command, cwd and model", () => {
    const base = {
      provider: "acp-1",
      command: "agy",
      cwd: "D:\\9router",
      model: "gemini-3.8-flash",
      historyUserTexts: ["hi", "next"],
    };
    const key = buildAcpSessionKey(base);
    expect(key).toBe(buildAcpSessionKey({ ...base }));
    expect(key).not.toBe(buildAcpSessionKey({ ...base, historyUserTexts: ["hi", "different"] }));
    expect(key).not.toBe(buildAcpSessionKey({ ...base, model: "other-model" }));
    expect(key).not.toBe(buildAcpSessionKey({ ...base, cwd: "D:\\other" }));
  });

  it("claims once, blocks concurrent claims, and remembers the session id", () => {
    const key = buildAcpSessionKey({ command: "agy", historyUserTexts: ["hi"] });

    const first = claimAcpSession(key);
    expect(first).toEqual({ sessionId: null, claimed: true });

    // A concurrent request for the same conversation must not reuse the session.
    expect(claimAcpSession(key)).toEqual({ sessionId: null, claimed: false });

    saveAcpSession(key, "session-1");
    expect(peekAcpSession(key)).toMatchObject({ sessionId: "session-1", busy: false });
    expect(claimAcpSession(key)).toEqual({ sessionId: "session-1", claimed: true });
  });

  it("drops a fingerprint once the session advanced past it", () => {
    const key = buildAcpSessionKey({ command: "agy", historyUserTexts: ["hi"] });
    saveAcpSession(key, "session-1");
    dropAcpSession(key);
    expect(peekAcpSession(key)).toBeNull();
  });

  it("ignores missing keys and session ids", () => {
    expect(claimAcpSession(null)).toEqual({ sessionId: null, claimed: false });
    expect(() => dropAcpSession(null)).not.toThrow();
    saveAcpSession(null, "x");
    saveAcpSession("k", null);
    expect(peekAcpSession(null)).toBeNull();
    expect(peekAcpSession("k")).toBeNull();
  });
});
