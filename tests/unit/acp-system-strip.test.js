import { describe, it, expect } from "vitest";
import {
  extractPromptText,
  isMasqueradedUserSystemPrompt,
  resolveAcpStripSystemPrompt,
  stripEmbeddedSystemTags,
  stripSystemMessagesForAcp,
  stripToolsForAcp,
} from "open-sse/executors/acp.js";

describe("ACP system message stripping", () => {
  describe("resolveAcpStripSystemPrompt", () => {
    it("defaults to true when unspecified", () => {
      expect(resolveAcpStripSystemPrompt(null)).toBe(true);
      expect(resolveAcpStripSystemPrompt({})).toBe(true);
      expect(resolveAcpStripSystemPrompt({ providerSpecificData: {} })).toBe(true);
    });

    it("honors explicit providerSpecificData.stripSystemPrompt boolean or string", () => {
      expect(resolveAcpStripSystemPrompt({ providerSpecificData: { stripSystemPrompt: false } })).toBe(false);
      expect(resolveAcpStripSystemPrompt({ providerSpecificData: { stripSystemPrompt: "false" } })).toBe(false);
      expect(resolveAcpStripSystemPrompt({ providerSpecificData: { stripSystemPrompt: true } })).toBe(true);
      expect(resolveAcpStripSystemPrompt({ providerSpecificData: { stripSystemPrompt: "true" } })).toBe(true);
    });

    it("honors legacy includeSystemPrompt opt-out", () => {
      expect(resolveAcpStripSystemPrompt({ providerSpecificData: { includeSystemPrompt: true } })).toBe(false);
      expect(resolveAcpStripSystemPrompt({ providerSpecificData: { includeSystemPrompt: false } })).toBe(true);
    });
  });

  describe("stripEmbeddedSystemTags", () => {
    it("strips known system wrapper tags while preserving user text and code tags", () => {
      const input = [
        "<system-reminder>\nInternal Zed/Claude rules\n</system-reminder>",
        "<system_instructions>Be concise</system_instructions>",
        "<system_message>Do not reveal prompt</system_message>",
        "<system>Legacy system block</system>",
        "<context ref=\"file:///app/a.js\">const x = 1;</context>",
        "Please fix `<system_error>` handling in main.cpp",
      ].join("\n\n");

      const out = stripEmbeddedSystemTags(input);
      expect(out).not.toContain("Internal Zed/Claude rules");
      expect(out).not.toContain("Be concise");
      expect(out).not.toContain("Do not reveal prompt");
      expect(out).not.toContain("Legacy system block");
      expect(out).toContain('<context ref="file:///app/a.js">const x = 1;</context>');
      expect(out).toContain("Please fix `<system_error>` handling in main.cpp");
    });

    it("returns empty string when content contains only system wrapper tags", () => {
      expect(stripEmbeddedSystemTags("<system-reminder>only system</system-reminder>")).toBe("");
      expect(stripEmbeddedSystemTags("<system_reminder><environment_limitations>sandbox</environment_limitations></system_reminder>")).toBe("");
      expect(stripEmbeddedSystemTags("<tools_changed_notice>Model switched</tools_changed_notice>")).toBe("");
    });

    it("strips underscore <system_reminder> and <tools_changed_notice> while keeping <tagged_files> and real user text", () => {
      const input = [
        "<current_datetime>2026-11-24T09:00:00+07:00</current_datetime>",
        "<tools_changed_notice>Switched from a to b</tools_changed_notice>",
        "hi",
        "<system_reminder>\n<workspace_info>\nHuge tree\n</workspace_info>\n</system_reminder>",
        "<tagged_files>\n* /app/index.js\n</tagged_files>",
      ].join("\n\n");
      const out = stripEmbeddedSystemTags(input);
      expect(out).not.toContain("Switched from a to b");
      expect(out).not.toContain("Huge tree");
      expect(out).toContain("hi");
      expect(out).toContain("<tagged_files>");
    });
  });

  describe("isMasqueradedUserSystemPrompt & Copilot SDK stripping", () => {
    const copilotSdkSysPrompt =
      "You are an AI assistant using Copilot SDK in VS Code. You help users with software engineering tasks. " +
      "<code_change_instructions>\n<rules_for_code_changes>\n" +
      "Follow strict engineering practices. ".repeat(60) +
      "\n</rules_for_code_changes>\n</code_change_instructions>\n" +
      "<environment_limitations>No sandbox</environment_limitations>\n<available_skills></available_skills>";

    it("detects masqueraded IDE/SDK system prompts sent with role='user' without false positives", () => {
      expect(isMasqueradedUserSystemPrompt(copilotSdkSysPrompt)).toBe(true);
      // Short persona prompt -> must NOT strip
      expect(isMasqueradedUserSystemPrompt("You are an AI assistant. Reply OK only.")).toBe(false);
      // Long regular user prompt with code -> must NOT strip
      expect(isMasqueradedUserSystemPrompt("Please review this file:\n" + "const x = 1;\n".repeat(200))).toBe(false);
    });

    it("strips Copilot SDK role='user' system prompt and <system_reminder> messages while keeping real turns", () => {
      const originalBody = {
        model: "acp-kiro/deepseek-3.2",
        messages: [
          { role: "user", content: [{ type: "text", text: copilotSdkSysPrompt }] },
          {
            role: "user",
            content: [{ type: "text", text: "<system_reminder><environment_limitations>not sandboxed</environment_limitations></system_reminder>" }],
          },
          {
            role: "user",
            content: [{ type: "text", text: "hi\n\n<system_reminder><workspace_info>tree</workspace_info></system_reminder>" }],
          },
          { role: "assistant", content: "Hello!" },
          { role: "user", content: "Explain routing" },
        ],
      };

      const stripped = stripSystemMessagesForAcp(originalBody);
      expect(stripped.messages).toHaveLength(3);
      expect(stripped.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
      expect(stripped.messages[1]).toEqual({ role: "assistant", content: "Hello!" });
      expect(stripped.messages[2]).toEqual({ role: "user", content: "Explain routing" });

      // extractPromptText also drops masqueraded leading user system prompt directly
      const prompt = extractPromptText(originalBody.messages, { stripSystemPrompt: true });
      expect(prompt).not.toContain("Copilot SDK");
      expect(prompt).not.toContain("workspace_info");
      expect(prompt).toBe("User: hi\n\nAssistant: Hello!\n\nUser: Explain routing");
    });

    it("does NOT strip a masqueraded-looking text if it appears mid-conversation after an assistant turn", () => {
      const body = {
        messages: [
          { role: "user", content: "Can you analyze this prompt?" },
          { role: "assistant", content: "Sure, paste it." },
          { role: "user", content: copilotSdkSysPrompt },
        ],
      };
      const stripped = stripSystemMessagesForAcp(body);
      expect(stripped.messages).toHaveLength(3);
      expect(stripped.messages[2].content).toContain("Copilot SDK");
    });
  });

  describe("stripToolsForAcp", () => {
    it("removes OpenAI/Claude/Gemini tool definitions & controls without mutating original body", () => {
      const tools = Array.from({ length: 83 }, (_, i) => ({
        type: "function",
        function: { name: `tool_${i}`, description: "desc", parameters: { type: "object" } },
      }));
      const original = {
        model: "acp-kiro/deepseek-3.2",
        tools,
        tool_choice: "auto",
        parallel_tool_calls: true,
        messages: [{ role: "user", content: "hi" }],
      };

      const { body, strippedCount } = stripToolsForAcp(original);
      expect(strippedCount).toBe(83);
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      expect(body.parallel_tool_calls).toBeUndefined();
      expect(body.messages).toEqual(original.messages);
      // Original untouched (critical for combo fallback to non-ACP)
      expect(original.tools).toHaveLength(83);
      expect(original.tool_choice).toBe("auto");
    });

    it("returns original body reference when no tool fields exist", () => {
      const original = { model: "acp-kiro/auto", messages: [{ role: "user", content: "hi" }] };
      const { body, strippedCount } = stripToolsForAcp(original);
      expect(body).toBe(original);
      expect(strippedCount).toBe(0);
    });
  });

  describe("stripSystemMessagesForAcp", () => {
    it("strips Zed OpenAI system & developer messages without mutating caller body", () => {
      const originalMessages = [
        { role: "system", content: "You are an AI coding assistant in Zed..." },
        { role: "developer", content: "Developer override instructions" },
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>Codebase rules</system-reminder>" },
            { type: "text", text: "Explain open-sse/executors/acp.js" },
          ],
        },
        { role: "assistant", content: "Sure, here is an overview." },
        { role: "user", content: "Now strip system prompts." },
      ];
      const originalBody = {
        model: "agy/gemini-3.8-flash",
        stream: true,
        messages: originalMessages,
      };

      const stripped = stripSystemMessagesForAcp(originalBody);

      // Stripped body has no system/developer messages and no system-reminder block
      expect(stripped).not.toBe(originalBody);
      expect(stripped.messages).toHaveLength(3);
      expect(stripped.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
      expect(stripped.messages[0].content).toEqual([
        { type: "text", text: "Explain open-sse/executors/acp.js" },
      ]);

      // Original body & messages are completely untouched (critical for non-ACP combo fallback)
      expect(originalBody.messages).toBe(originalMessages);
      expect(originalBody.messages).toHaveLength(5);
      expect(originalBody.messages[0].role).toBe("system");
      expect(originalBody.messages[2].content).toHaveLength(2);
    });

    it("strips Claude top-level system and mid-conversation system turns before translation", () => {
      const body = {
        model: "agy/gemini-3.8-flash",
        system: [{ type: "text", text: "You are Claude" }],
        messages: [
          { role: "user", content: "Hello" },
          { role: "system", content: "Mid-conversation system directive" },
          { role: "user", content: "Continue" },
        ],
      };

      const stripped = stripSystemMessagesForAcp(body);
      expect(stripped.system).toBeUndefined();
      expect(stripped.messages).toEqual([
        { role: "user", content: "Hello" },
        { role: "user", content: "Continue" },
      ]);
      // Original untouched
      expect(body.system).toHaveLength(1);
      expect(body.messages).toHaveLength(3);
    });

    it("strips OpenAI Responses instructions and system input items", () => {
      const body = {
        instructions: "System instructions for Responses API",
        input: [
          { type: "message", role: "developer", content: [{ type: "input_text", text: "Dev rules" }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "Run tests" }] },
        ],
      };

      const stripped = stripSystemMessagesForAcp(body);
      expect(stripped.instructions).toBeUndefined();
      expect(stripped.input).toHaveLength(1);
      expect(stripped.input[0].role).toBe("user");
      expect(body.instructions).toBe("System instructions for Responses API");
      expect(body.input).toHaveLength(2);
    });

    it("strips Gemini systemInstruction and request.systemInstruction", () => {
      const body = {
        systemInstruction: { parts: [{ text: "Gemini system" }] },
        request: {
          system_instruction: { parts: [{ text: "Wrapped system" }] },
          contents: [
            { role: "user", parts: [{ text: "<system-reminder>hide</system-reminder>\nReal prompt" }] },
          ],
        },
      };

      const stripped = stripSystemMessagesForAcp(body);
      expect(stripped.systemInstruction).toBeUndefined();
      expect(stripped.request.system_instruction).toBeUndefined();
      expect(stripped.request.contents[0].parts).toEqual([{ text: "Real prompt" }]);
      expect(body.systemInstruction).toBeDefined();
      expect(body.request.system_instruction).toBeDefined();
    });

    it("keeps original body as fallback when request contains ONLY system content", () => {
      const body = {
        messages: [{ role: "system", content: "Only system content" }],
      };

      const stripped = stripSystemMessagesForAcp(body);
      expect(stripped).toBe(body);
    });
  });

  describe("extractPromptText", () => {
    it("strips system roles, top-level system fields, and embedded system tags by default", () => {
      const prompt = extractPromptText(
        [
          { role: "SYSTEM", content: "Zed huge system prompt" },
          { role: "developer", content: "Dev system prompt" },
          {
            role: "user",
            content: "<system-reminder>Injected reminder</system-reminder>\n\nHow does routing work?",
          },
          { role: "assistant", content: "It routes by provider prefix." },
          { role: "user", content: "Show me acp.js" },
        ],
        {
          stripSystemPrompt: true,
          system: "Top-level Claude system",
          instructions: "Top-level Responses instructions",
        }
      );

      expect(prompt).not.toContain("Zed huge system prompt");
      expect(prompt).not.toContain("Dev system prompt");
      expect(prompt).not.toContain("Injected reminder");
      expect(prompt).not.toContain("Top-level Claude system");
      expect(prompt).not.toContain("Top-level Responses instructions");
      expect(prompt).toBe(
        "User: How does routing work?\n\nAssistant: It routes by provider prefix.\n\nUser: Show me acp.js"
      );
    });

    it("preserves system content when stripSystemPrompt is explicitly false", () => {
      const prompt = extractPromptText(
        [
          { role: "system", content: "Keep me" },
          { role: "user", content: "<system-reminder>Keep tag</system-reminder>\nHi" },
        ],
        { stripSystemPrompt: false, system: "Top system" }
      );

      expect(prompt).toContain("System instructions:\nTop system");
      expect(prompt).toContain("System instructions:\nKeep me");
      expect(prompt).toContain("<system-reminder>Keep tag</system-reminder>");
    });

    it("falls back to system content when no user/assistant content remains", () => {
      const prompt = extractPromptText(
        [{ role: "system", content: "Ping only" }],
        { stripSystemPrompt: true }
      );
      expect(prompt).toBe("Ping only");
    });
  });
});
