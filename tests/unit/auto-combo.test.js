import { describe, it, expect } from "vitest";
import {
  formatContextLabel,
  getContextGroupKey,
  getUniqueComboName,
  buildContextComboGroups,
  findModelsWithSameContext,
} from "../../src/shared/utils/autoCombo.js";

describe("autoCombo utils", () => {
  it("formats context window correctly", () => {
    expect(formatContextLabel(1_000_000)).toBe("1M");
    expect(formatContextLabel(1_048_576)).toBe("1M");
    expect(formatContextLabel(2_000_000)).toBe("2M");
    expect(formatContextLabel(131_072)).toBe("131k");
    expect(formatContextLabel(128_000)).toBe("128k");
    expect(formatContextLabel(262_144)).toBe("256k");
    expect(formatContextLabel(65_536)).toBe("64k");
    expect(formatContextLabel(64_000)).toBe("64k");
    expect(formatContextLabel(0)).toBe("?");
    expect(formatContextLabel(null)).toBe("?");
  });

  it("maps tokens into standard bucket keys", () => {
    expect(getContextGroupKey(1_000_000)).toBe("1m");
    expect(getContextGroupKey(1_048_576)).toBe("1m");
    expect(getContextGroupKey(500_000)).toBe("500k");
    expect(getContextGroupKey(262_144)).toBe("256k");
    expect(getContextGroupKey(200_000)).toBe("200k");
    expect(getContextGroupKey(128_000)).toBe("128k");
    expect(getContextGroupKey(65_536)).toBe("64k");
    expect(getContextGroupKey(32_000)).toBe("32k");
    expect(getContextGroupKey(0)).toBeNull();
  });

  it("generates unique combo names avoiding collision", () => {
    expect(getUniqueComboName("combo-1m", [])).toBe("combo-1m");
    expect(getUniqueComboName("combo-1m", ["combo-1m"])).toBe("combo-1m-2");
    expect(getUniqueComboName("combo-1m", ["combo-1m", "combo-1m-2"])).toBe("combo-1m-3");
  });

  it("groups models by context window in descending order", () => {
    const models = [
      { id: "ag/gemini-3.8-flash", caps: { contextWindow: 1_048_576, maxOutput: 65_536 } },
      { id: "ds/deepseek-v4.1-flash", caps: { contextWindow: 1_000_000, maxOutput: 384_000 } },
      { id: "ds/deepseek-chat", caps: { contextWindow: 128_000, maxOutput: 64_000 } },
      { id: "lcmn/qwen3-4b", caps: { contextWindow: 262_144, maxOutput: 64_000 } },
    ];

    const groups = buildContextComboGroups(models, ["combo-1m"]);
    expect(groups).toHaveLength(3);

    // 1M group is first
    expect(groups[0].key).toBe("1m");
    expect(groups[0].label).toBe("1M");
    expect(groups[0].models).toHaveLength(2);
    expect(groups[0].suggestedName).toBe("combo-1m-2");
    expect(groups[0].alreadyExists).toBe(true);

    // 256k group is second
    expect(groups[1].key).toBe("256k");
    expect(groups[1].models).toHaveLength(1);
    expect(groups[1].suggestedName).toBe("combo-256k");

    // 128k group is third
    expect(groups[2].key).toBe("128k");
    expect(groups[2].models).toHaveLength(1);
  });

  it("finds other models with the same context bucket", () => {
    const models = [
      { id: "ag/gemini-3.8-flash", caps: { contextWindow: 1_048_576 } },
      { id: "ds/deepseek-v4.1-flash", caps: { contextWindow: 1_000_000 } },
      { id: "ds/deepseek-chat", caps: { contextWindow: 128_000 } },
    ];

    const matched = findModelsWithSameContext(1_048_576, models);
    expect(matched).toEqual(["ag/gemini-3.8-flash", "ds/deepseek-v4.1-flash"]);
  });
});
