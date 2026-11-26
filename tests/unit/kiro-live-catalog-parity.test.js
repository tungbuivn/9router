import { describe, it, expect } from "vitest";

// Kiro trả 400 INVALID_MODEL_ID cho mọi model KHÔNG có trên tài khoản.
// Registry tĩnh hardcode các model mà gói Kiro hiện tại không bán
// (opus 5.5/5/4.8/4.7/4.5, sonnet-5, gpt-5.6-*), nên khi picker dùng danh sách
// tĩnh, người dùng chọn được model mà upstream chắc chắn từ chối.
//
// /v1/models đã đọc live catalog qua ListAvailableModels; picker thì chưa, vì
// "kiro" thiếu trong LIVE_CATALOG_PROVIDERS. Test này khoá lại sự đồng bộ đó.
describe("kiro live catalog parity", () => {
  it("kiro phải nằm trong LIVE_CATALOG_PROVIDERS", async () => {
    const { LIVE_CATALOG_PROVIDERS } = await import("../../src/shared/utils/selectableModels.js");
    expect(LIVE_CATALOG_PROVIDERS).toContain("kiro");
  });

  it("provider route của kiro có customResolver trả live catalog", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../../src/app/api/providers/[id]/models/route.js", import.meta.url),
      "utf8"
    );
    // Có resolver nhưng không được picker gọi thì vô nghĩa — cả hai phải cùng tồn tại.
    expect(src).toContain("resolveKiroModels");
    expect(src).toMatch(/kiro:\s*\{[\s\S]{0,200}customResolver/);
  });

  it("picker dùng live thay vì static khi có dữ liệu", async () => {
    const { buildModelGroups } = await import("../../src/shared/utils/selectableModels.js");
    // Model mà registry tĩnh KHÔNG có, chỉ live catalog mới trả về.
    const liveKiro = [
      { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
      { id: "minimax-m2.1", name: "MiniMax M2.1" },
    ];
    const groups = buildModelGroups({
      connections: [{ id: "k1", provider: "kiro", isActive: true }],
      allConnections: [{ id: "k1", provider: "kiro", isActive: true }],
      modelAliases: {},
      customModels: [],
      disabledModels: {},
      liveModels: { kiro: liveKiro },
    });

    const ids = (groups.kiro?.models || []).map((m) => m.id);
    // Live thắng: minimax-m2.1 chỉ có ở live, không có trong registry tĩnh.
    expect(ids).toContain("minimax-m2.1");
    expect(ids).toEqual(["claude-sonnet-4.5", "minimax-m2.1"]);
  });

  it("live rỗng thì rơi về static (không làm trắng picker)", async () => {
    const { buildModelGroups } = await import("../../src/shared/utils/selectableModels.js");
    const groups = buildModelGroups({
      connections: [{ id: "k1", provider: "kiro", isActive: true }],
      allConnections: [{ id: "k1", provider: "kiro", isActive: true }],
      modelAliases: {},
      customModels: [],
      disabledModels: {},
      liveModels: { kiro: [] },
    });
    expect((groups.kiro?.models || []).length).toBeGreaterThan(0);
  });
});
