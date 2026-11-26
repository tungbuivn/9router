import { describe, it, expect } from "vitest";
import { formatContextLabel, buildContextComboGroups, findModelsWithSameContext } from "../../src/shared/utils/autoCombo.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

describe("Combo primary item context and Auto Combo", () => {
  it("formatContextLabel formats 1M and 131k correctly", () => {
    // 1,000,000 -> 1M
    expect(formatContextLabel(1_000_000)).toBe("1M");
    // 1,048,576 (e.g. Gemini 1M) -> 1M
    expect(formatContextLabel(1_048_576)).toBe("1M");
    // 131,072 -> 131k
    expect(formatContextLabel(131_072)).toBe("131k");
    // 65,536 -> 64k
    expect(formatContextLabel(65_536)).toBe("64k");
    // 128,000 -> 128k
    expect(formatContextLabel(128_000)).toBe("128k");
  });

  it("first item in combo determines contextWindow and maxOutput", () => {
    // MiniMax M3.1 Flash has 1M context, 131k maxOutput
    const mmgCaps = getCapabilitiesForModel("minimax-code-global", "MiniMax-M3.1-Flash");
    expect(mmgCaps.contextWindow).toBe(1_000_000);
    expect(formatContextLabel(mmgCaps.contextWindow)).toBe("1M");
    expect(formatContextLabel(mmgCaps.maxOutput)).toBe("131k");

    // DeepSeek Chat has 128k context, 64k maxOutput
    const dsCaps = getCapabilitiesForModel("deepseek", "deepseek-chat");
    expect(dsCaps.contextWindow).toBe(128_000);
    expect(formatContextLabel(dsCaps.contextWindow)).toBe("128k");

    // When MiniMax is first, combo context is 1M and maxOutput is 131k
    const comboWithMmgFirst = ["mmg/MiniMax-M3.1-Flash", "ds/deepseek-chat"];
    const firstCaps1 = getCapabilitiesForModel("minimax-code-global", "MiniMax-M3.1-Flash");
    expect(firstCaps1.contextWindow).toBe(1_000_000);
    expect(formatContextLabel(firstCaps1.contextWindow)).toBe("1M");
    expect(formatContextLabel(firstCaps1.maxOutput)).toBe("131k");

    // When DeepSeek is first (reordered), combo context updates to 128k and maxOutput to 64k
    const comboWithDsFirst = ["ds/deepseek-chat", "mmg/MiniMax-M3.1-Flash"];
    const firstCaps2 = getCapabilitiesForModel("deepseek", "deepseek-chat");
    expect(firstCaps2.contextWindow).toBe(128_000);
    expect(formatContextLabel(firstCaps2.contextWindow)).toBe("128k");
    expect(formatContextLabel(firstCaps2.maxOutput)).toBe("64k");
  });

  it("buildContextComboGroups groups active models with the same context", () => {
    const models = [
      { id: "ag/gemini-3.8-flash", name: "Gemini 3.8 Flash", caps: { contextWindow: 1_048_576, maxOutput: 65_536 } },
      { id: "mmg/MiniMax-M3.1-Flash", name: "MiniMax M3.1 Flash", caps: { contextWindow: 1_000_000, maxOutput: 131_072 } },
      { id: "ds/deepseek-chat", name: "DeepSeek Chat", caps: { contextWindow: 128_000, maxOutput: 64_000 } },
      { id: "lcmn/qwen3-4b", name: "Qwen 3 4B", caps: { contextWindow: 262_144, maxOutput: 64_000 } },
    ];

    const existingNames = ["existing-combo"];
    const groups = buildContextComboGroups(models, existingNames);

    // 1M group combines both 1M models (1,000,000 and 1,048,576)
    const group1M = groups.find((g) => g.key === "1m");
    expect(group1M).toBeDefined();
    expect(group1M.label).toBe("1M");
    expect(group1M.models).toHaveLength(2);
    expect(group1M.models.map((m) => m.id)).toEqual(["ag/gemini-3.8-flash", "mmg/MiniMax-M3.1-Flash"]);
    expect(group1M.suggestedName).toBe("combo-1m");

    // 128k group
    const group128k = groups.find((g) => g.key === "128k");
    expect(group128k).toBeDefined();
    expect(group128k.label).toBe("128k");
    expect(group128k.models).toHaveLength(1);

    // 256k group
    const group256k = groups.find((g) => g.key === "256k");
    expect(group256k).toBeDefined();
    expect(group256k.label).toBe("256k");
    expect(group256k.models).toHaveLength(1);
  });

  it("findModelsWithSameContext finds models matching target context", () => {
    const models = [
      { id: "ag/gemini-3.8-flash", caps: { contextWindow: 1_048_576 } },
      { id: "mmg/MiniMax-M3.1-Flash", caps: { contextWindow: 1_000_000 } },
      { id: "ds/deepseek-chat", caps: { contextWindow: 128_000 } },
    ];

    const sameAsGemini = findModelsWithSameContext(1_048_576, models);
    expect(sameAsGemini).toEqual(["ag/gemini-3.8-flash", "mmg/MiniMax-M3.1-Flash"]);

    const sameAsDs = findModelsWithSameContext(128_000, models);
    expect(sameAsDs).toEqual(["ds/deepseek-chat"]);
  });
});
