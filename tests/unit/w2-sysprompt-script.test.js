import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { transformSysPromptBody } = require("../../scripts/w2-plugins/9router-sysprompt.js");

describe("9router-sysprompt whistle.script plugin", () => {
  const longPrompt = "You are Antigravity coding agent. ".repeat(10); // > 100 chars

  it("leaves body untouched in default passthrough mode", () => {
    const body = {
      model: "gemini-3.8-flash-high",
      request: {
        systemInstruction: { parts: [{ text: longPrompt }] },
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      },
    };
    const res = transformSysPromptBody(body, "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent", {
      mode: "passthrough",
    });
    expect(res.modified).toBe(false);
    expect(res.format).toBe("gemini-cloudcode");
    expect(res.beforeChars).toBe(longPrompt.length);
    expect(res.afterChars).toBe(longPrompt.length);
  });

  it("supports append, prepend, replace, and regex_replace on Gemini CloudCode systemInstruction", () => {
    const makeBody = () => ({
      request: { systemInstruction: { parts: [{ text: longPrompt }] } },
    });

    const appended = transformSysPromptBody(makeBody(), "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent", {
      mode: "append",
      customPrompt: "Always reply in Vietnamese.",
    });
    expect(appended.modified).toBe(true);
    expect(appended.body.request.systemInstruction.parts[0].text.endsWith("Always reply in Vietnamese.")).toBe(true);

    const prepended = transformSysPromptBody(makeBody(), "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent", {
      mode: "prepend",
      customPrompt: "TOP PRIORITY RULE",
    });
    expect(prepended.modified).toBe(true);
    expect(prepended.body.request.systemInstruction.parts[0].text.startsWith("TOP PRIORITY RULE")).toBe(true);

    const replaced = transformSysPromptBody(makeBody(), "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent", {
      mode: "replace",
      customPrompt: "Minimal prompt only",
    });
    expect(replaced.modified).toBe(true);
    expect(replaced.body.request.systemInstruction.parts[0].text).toBe("Minimal prompt only");

    const regexed = transformSysPromptBody(makeBody(), "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent", {
      mode: "regex_replace",
      regexReplacements: [{ pattern: "Antigravity", flags: "g", replacement: "CustomAgent" }],
    });
    expect(regexed.modified).toBe(true);
    expect(regexed.body.request.systemInstruction.parts[0].text).toContain("CustomAgent");
    expect(regexed.body.request.systemInstruction.parts[0].text).not.toContain("Antigravity");
  });

  it("skips tiny helper calls without a real system prompt when requireExistingSysPrompt=true", () => {
    const helperBody = {
      request: {
        systemInstruction: { parts: [{ text: "Short" }] },
        contents: [{ role: "user", parts: [{ text: "summarize title" }] }],
      },
    };
    const res = transformSysPromptBody(helperBody, "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent", {
      mode: "replace",
      customPrompt: "Should not overwrite helper",
      requireExistingSysPrompt: true,
      minSysPromptChars: 100,
    });
    expect(res.modified).toBe(false);
    expect(res.body.request.systemInstruction.parts[0].text).toBe("Short");
  });

  it("supports Kiro/Responses, Claude, and OpenAI Chat formats + per-URL overrides", () => {
    const kiroBody = { model: "auto", instructions: longPrompt, input: [{ role: "user", content: "hi" }] };
    const r1 = transformSysPromptBody(kiroBody, "https://runtime.us-east-1.kiro.dev/v1/responses", {
      mode: "passthrough",
      urlOverrides: {
        "kiro.dev": { mode: "append", customPrompt: "KIRO_EXTRA" },
      },
    });
    expect(r1.modified).toBe(true);
    expect(r1.format).toBe("openai-responses");
    expect(r1.body.instructions).toContain("KIRO_EXTRA");

    const claudeBody = { model: "claude-sonnet-4-5", system: [{ type: "text", text: longPrompt }], messages: [] };
    const r2 = transformSysPromptBody(claudeBody, "https://api.anthropic.com/v1/messages", {
      mode: "append",
      customPrompt: "CLAUDE_EXTRA",
    });
    expect(r2.modified).toBe(true);
    expect(r2.format).toBe("claude");
    expect(r2.body.system[0].text).toContain("CLAUDE_EXTRA");

    const oaiBody = { model: "gpt-4o", messages: [{ role: "system", content: longPrompt }, { role: "user", content: "hi" }] };
    const r3 = transformSysPromptBody(oaiBody, "https://api.openai.com/v1/chat/completions", {
      mode: "append",
      customPrompt: "OAI_EXTRA",
    });
    expect(r3.modified).toBe(true);
    expect(r3.format).toBe("openai-chat");
    expect(r3.body.messages[0].content).toContain("OAI_EXTRA");
  });
});
