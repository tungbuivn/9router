#!/usr/bin/env -S node --no-warnings
import {
  listLocalSkills,
  setSkillsEnabled,
  applySkillsPreset,
  syncSkillCatalog,
} from "../src/lib/localSkillsManager.js";

function fmtKB(bytes) {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function printUsage() {
  console.log(`sk — Quick toggle for global AI skills (~/.agents/skills ↔ ~/.agents/skills-disabled)

Usage:
  sk [list|ls]                 List enabled & disabled skills and prompt size
  sk on <name|prefix|all> ...  Enable matching skill(s) (e.g. sk on langchain)
  sk off <name|prefix|all> ... Disable matching skill(s) (e.g. sk off langchain)
  sk toggle <name>             Toggle a single skill
  sk core                      Keep only core coding skills + skill-catalog
  sk none | minimal            Disable all regular skills, keep only skill-catalog (~0.5KB)
  sk all                       Enable all skills
  sk catalog                   Regenerate skill-catalog/SKILL.md
`);
}

function printState(state) {
  console.log(
    `Skills: ${state.enabledCount} enabled · ${state.disabledCount} disabled · ` +
      `Prompt size: ${fmtKB(state.activePromptBytes)} (full: ${fmtKB(state.allSkillsPromptBytes)}, saved: ${fmtKB(state.savedBytes)})`
  );
  if (state.catalogEnabled) {
    console.log(`Catalog: ACTIVE (${fmtKB(state.catalogPromptBytes)}) -> ${state.skillsDir}/skill-catalog/SKILL.md`);
  }
  console.log("");

  const enabled = state.skills.filter((s) => s.enabled && !s.isCatalog && s.hasSkillMd);
  const disabled = state.skills.filter((s) => !s.enabled && !s.isCatalog && s.hasSkillMd);

  console.log(`ENABLED (${enabled.length}):`);
  if (enabled.length === 0) console.log("  (none)");
  for (const s of enabled) {
    console.log(`  [+] ${s.name.padEnd(36)} [${s.group.padEnd(9)}] ${fmtKB(s.approxPromptBytes)}`);
  }

  console.log(`\nDISABLED (${disabled.length}) — tag @${state.disabledDir}/<name>/SKILL.md or run 'sk on <name>':`);
  if (disabled.length === 0) console.log("  (none)");
  for (const s of disabled) {
    console.log(`  [-] ${s.name.padEnd(36)} [${s.group.padEnd(9)}] ${fmtKB(s.approxPromptBytes)}`);
  }
}

async function main() {
  const [, , cmd = "list", ...rest] = process.argv;

  switch (cmd) {
    case "list":
    case "ls": {
      printState(await listLocalSkills());
      break;
    }
    case "on":
    case "enable": {
      if (rest.length === 0) {
        console.error("Usage: sk on <name|prefix|all>");
        process.exit(1);
      }
      const res = await setSkillsEnabled(rest, true);
      console.log(`Enabled (${res.changed.length}): ${res.changed.join(", ") || "none"}`);
      printState(res.state);
      break;
    }
    case "off":
    case "disable": {
      if (rest.length === 0) {
        console.error("Usage: sk off <name|prefix|all>");
        process.exit(1);
      }
      const res = await setSkillsEnabled(rest, false);
      console.log(`Disabled (${res.changed.length}): ${res.changed.join(", ") || "none"}`);
      printState(res.state);
      break;
    }
    case "toggle": {
      if (!rest[0]) {
        console.error("Usage: sk toggle <name>");
        process.exit(1);
      }
      const cur = await listLocalSkills();
      const hit = cur.skills.find((s) => !s.isCatalog && s.name === rest[0]);
      if (!hit) {
        console.error(`Skill not found: ${rest[0]}`);
        process.exit(1);
      }
      const res = await setSkillsEnabled([hit.name], !hit.enabled);
      console.log(`${hit.enabled ? "Disabled" : "Enabled"}: ${hit.name}`);
      printState(res.state);
      break;
    }
    case "core":
    case "all":
    case "none":
    case "minimal": {
      const res = await applySkillsPreset(cmd);
      console.log(`Applied preset '${cmd}' (${res.changed.length} changed)`);
      printState(res.state);
      break;
    }
    case "catalog":
    case "sync": {
      const res = await syncSkillCatalog();
      console.log(
        res.catalogEnabled
          ? `Catalog updated (${res.count} on-demand skills, ${fmtKB(res.descriptionBytes || 0)}): ${res.location}`
          : "No disabled skills — removed skill-catalog."
      );
      break;
    }
    case "-h":
    case "--help":
    case "help":
      printUsage();
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
