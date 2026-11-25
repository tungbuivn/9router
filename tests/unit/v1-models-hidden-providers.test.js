import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getProviderNodes: vi.fn(async () => []),
  getSettings: vi.fn(async () => ({})),
}));

vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

describe("/v1/models hidden providers", () => {
  it("does not publish a hidden no-auth provider's models", async () => {
    // One unrelated connection so the route takes the "has connections" branch
    // (the static fallback lists every provider in the registry).
    db.getProviderConnections.mockResolvedValue([{
      id: "conn-1",
      provider: "deepseek",
      isActive: true,
      providerSpecificData: { enabledModels: ["deepseek-chat"] },
    }]);

    const models = await buildModelsList(["llm"]);
    const ids = models.map((m) => m.id);

    // mimo-free is hidden (the free MiMo channel is retired) and publishes under
    // the "mmf" alias — neither the id nor the alias may show up.
    expect(ids).not.toContain("mmf/mimo-auto");
    expect(ids.some((id) => id.startsWith("mmf/"))).toBe(false);
    expect(ids.some((id) => id.startsWith("mimo-free/"))).toBe(false);
  });

  it("still publishes a visible no-auth provider's models", async () => {
    db.getProviderConnections.mockResolvedValue([{
      id: "conn-1",
      provider: "deepseek",
      isActive: true,
      providerSpecificData: { enabledModels: ["deepseek-chat"] },
    }]);

    const models = await buildModelsList(["llm"]);
    const ids = models.map((m) => m.id);

    // opencode is a visible no-auth free provider — it must stay.
    expect(ids.some((id) => id.startsWith("oc/"))).toBe(true);
  });
});
