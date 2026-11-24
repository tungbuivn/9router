import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  rewriteAvailableSkillsText,
  optimizeAvailableSkills,
} from "../../open-sse/rtk/skillsOptimizer.js";
import {
  listLocalSkills,
  setSkillsEnabled,
  applySkillsPreset,
  syncSkillCatalog,
  CATALOG_SKILL_NAME,
} from "../../src/lib/localSkillsManager.js";

const SAMPLE_SKILLS_BLOCK = `You are the Zed coding agent.

## Agent Skills
<available_skills>
<skill>
<name>code-implementation</name>
<description>${"Disciplined workflow for implementing code changes in existing codebases. ".repeat(8)}</description>
<location>/home/user/.agents/skills/code-implementation/SKILL.md</location>
</skill>
<skill>
<name>langchain-build-agent</name>
<description>${"Provides latest guidance for building LangChain, LangGraph, and Deep Agents applications. ".repeat(8)}</description>
<location>/home/user/.agents/skills/langchain-build-agent/SKILL.md</location>
</skill>
<skill>
<name>documentation-generator</name>
<description>${"Write and maintain technical documentation, API docs, READMEs, and runbooks. ".repeat(8)}</description>
<location>/home/user/.agents/skills/documentation-generator/SKILL.md</location>
</skill>
</available_skills>`;

describe("skillsOptimizer (9Router <available_skills> prompt optimizer)", () => {
  it("mode='off' leaves prompt completely untouched", () => {
    const res = rewriteAvailableSkillsText(SAMPLE_SKILLS_BLOCK, { mode: "off" });
    expect(res.applied).toBe(false);
    expect(res.text).toBe(SAMPLE_SKILLS_BLOCK);
  });

  it("mode='compact' strips verbose descriptions while preserving all skill names and locations", () => {
    const res = rewriteAvailableSkillsText(SAMPLE_SKILLS_BLOCK, { mode: "compact" });
    expect(res.applied).toBe(true);
    expect(res.totalSkills).toBe(3);
    expect(res.keptSkills).toBe(3);
    expect(res.savedBytes).toBeGreaterThan(1500);
    expect(res.text).toContain("<name>code-implementation</name>");
    expect(res.text).toContain("<name>langchain-build-agent</name>");
    expect(res.text).toContain("<location>/home/user/.agents/skills/langchain-build-agent/SKILL.md</location>");
    expect(res.text).not.toContain("<description>");
    expect(res.text).toContain("You are the Zed coding agent.");
  });

  it("mode='on-demand' defers untagged skills into compact index and keeps full description ONLY for tagged skills", () => {
    // No skill mentioned
    const bodyUntagged = {
      messages: [
        { role: "system", content: SAMPLE_SKILLS_BLOCK },
        { role: "user", content: "hi there" },
      ],
    };
    const r1 = optimizeAvailableSkills(bodyUntagged, "openai", { mode: "on-demand" });
    expect(r1.applied).toBe(true);
    expect(r1.keptSkills).toBe(0);
    expect(bodyUntagged.messages[0].content).toContain("<on_demand_skills>");
    expect(bodyUntagged.messages[0].content).toContain("langchain-build-agent");
    expect(bodyUntagged.messages[0].content).not.toContain("<description>");

    // User tags @langchain-build-agent in chat -> keep full entry for that skill only!
    const bodyTagged = {
      system: [{ type: "text", text: SAMPLE_SKILLS_BLOCK }],
      messages: [{ role: "user", content: "Use @langchain-build-agent to build a LangGraph agent" }],
    };
    const r2 = optimizeAvailableSkills(bodyTagged, "claude", { mode: "on-demand" });
    expect(r2.applied).toBe(true);
    expect(r2.keptSkills).toBe(1);
    const outSys = bodyTagged.system[0].text;
    expect(outSys).toContain("<name>langchain-build-agent</name>");
    expect(outSys).toContain("Provides latest guidance for building LangChain");
    expect(outSys).not.toContain("Disciplined workflow for implementing code changes");
    expect(outSys).toContain("<on_demand_skills>");
  });
});

describe("localSkillsManager (~/.agents/skills ↔ ~/.agents/skills-disabled + skill-catalog)", () => {
  let tmpRoot;
  let skillsDir;
  let disabledDir;
  let claudeDir;
  let geminiDir;
  let opts;

  async function writeFakeSkill(dir, name, desc) {
    const sDir = path.join(dir, name);
    await fs.mkdir(sDir, { recursive: true });
    await fs.writeFile(
      path.join(sDir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\nFull instructions.\n`,
      "utf8"
    );
  }

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "9router-skills-mgr-"));
    skillsDir = path.join(tmpRoot, "skills");
    disabledDir = path.join(tmpRoot, "skills-disabled");
    claudeDir = path.join(tmpRoot, "claude-skills");
    geminiDir = path.join(tmpRoot, "gemini-skills");
    await Promise.all([
      fs.mkdir(skillsDir, { recursive: true }),
      fs.mkdir(claudeDir, { recursive: true }),
      fs.mkdir(geminiDir, { recursive: true }),
    ]);

    await writeFakeSkill(skillsDir, "code-implementation", "Core implementation skill ".repeat(15));
    await writeFakeSkill(skillsDir, "diagnosing-bugs", "Core bug diagnosis skill ".repeat(12));
    await writeFakeSkill(skillsDir, "langchain-build-agent", "LangChain build skill ".repeat(15));
    await writeFakeSkill(skillsDir, "langchain-agent-tracing", "LangChain tracing skill ".repeat(15));
    await writeFakeSkill(skillsDir, "documentation-generator", "Docs generator skill ".repeat(12));

    // Create symlinks in claude & gemini dirs + 1 real dir in claudeDir that must never be deleted
    for (const n of ["code-implementation", "langchain-build-agent", "langchain-agent-tracing"]) {
      await fs.symlink(path.relative(claudeDir, path.join(skillsDir, n)), path.join(claudeDir, n));
      await fs.symlink(path.relative(geminiDir, path.join(skillsDir, n)), path.join(geminiDir, n));
    }
    await fs.mkdir(path.join(claudeDir, "documentation-generator"), { recursive: true });

    opts = { skillsDir, disabledDir, symlinkTargets: [claudeDir, geminiDir] };
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("toggles skills by prefix, syncs symlinks safely without deleting real dirs, and generates skill-catalog", async () => {
    const offRes = await setSkillsEnabled(["langchain"], false, opts);
    expect(offRes.changed.sort()).toEqual(["langchain-agent-tracing", "langchain-build-agent"]);
    expect(offRes.state.enabledCount).toBe(3);
    expect(offRes.state.disabledCount).toBe(2);
    expect(offRes.state.catalogEnabled).toBe(true);
    expect(offRes.state.savedBytes).toBeGreaterThan(0);

    // Symlinks for disabled langchain skills should be removed
    await expect(fs.lstat(path.join(claudeDir, "langchain-build-agent"))).rejects.toThrow();
    await expect(fs.lstat(path.join(geminiDir, "langchain-build-agent"))).rejects.toThrow();

    // skill-catalog SKILL.md should exist and list disabled skills
    const catalogTxt = await fs.readFile(path.join(skillsDir, CATALOG_SKILL_NAME, "SKILL.md"), "utf8");
    expect(catalogTxt).toContain("langchain-build-agent");
    expect(catalogTxt).toContain("langchain-agent-tracing");
    // Symlink for skill-catalog created in tool dirs
    expect((await fs.lstat(path.join(claudeDir, CATALOG_SKILL_NAME))).isSymbolicLink()).toBe(true);

    // Disabling documentation-generator must NOT delete real directory in claudeDir
    await setSkillsEnabled(["documentation-generator"], false, opts);
    expect((await fs.lstat(path.join(claudeDir, "documentation-generator"))).isDirectory()).toBe(true);

    // Re-enabling all removes skill-catalog cleanly and restores symlinks
    const allRes = await applySkillsPreset("all", opts);
    expect(allRes.state.enabledCount).toBe(5);
    expect(allRes.state.disabledCount).toBe(0);
    expect(allRes.state.catalogEnabled).toBe(false);
    expect((await fs.lstat(path.join(claudeDir, "langchain-build-agent"))).isSymbolicLink()).toBe(true);
  });

  it("supports 'core' and 'none' presets", async () => {
    const coreRes = await applySkillsPreset("core", opts);
    expect(coreRes.state.enabledCount).toBe(2); // code-implementation + diagnosing-bugs
    expect(coreRes.state.disabledCount).toBe(3);
    expect(coreRes.state.catalogEnabled).toBe(true);

    const noneRes = await applySkillsPreset("none", opts);
    expect(noneRes.state.enabledCount).toBe(0);
    expect(noneRes.state.disabledCount).toBe(5);
    expect(noneRes.state.catalogEnabled).toBe(true);

    const cat = await syncSkillCatalog(opts);
    expect(cat.count).toBe(5);
    expect(cat.descriptionBytes).toBeLessThan(800);
  });
});
