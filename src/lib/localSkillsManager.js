import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const CATALOG_SKILL_NAME = "skill-catalog";
// Skill specs (Claude Code, Zed, …) cap the frontmatter description at 1024 chars.
const MAX_CATALOG_DESCRIPTION_CHARS = 1024;
export const CORE_SKILL_NAMES = [
  "code-implementation",
  "diagnosing-bugs",
  "code-review",
  "codebase-design",
];

function resolvePaths(opts = {}) {
  const home = opts.homeDir || os.homedir();
  const skillsDir = opts.skillsDir || path.join(home, ".agents", "skills");
  const disabledDir = opts.disabledDir || path.join(home, ".agents", "skills-disabled");
  const symlinkTargets =
    opts.symlinkTargets !== undefined
      ? opts.symlinkTargets
      : [
          path.join(home, ".claude", "skills"),
          path.join(home, ".gemini", "config", "skills"),
        ];
  return { home, skillsDir, disabledDir, symlinkTargets };
}

function isSafeSkillName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 160 &&
    /^[a-zA-Z0-9._-]+$/.test(name) &&
    name !== "." &&
    name !== ".."
  );
}

function inferGroup(name) {
  if (name === CATALOG_SKILL_NAME) return "catalog";
  if (CORE_SKILL_NAMES.includes(name)) return "core";
  if (name.startsWith("langchain-")) return "langchain";
  if (name.startsWith("context-management-")) return "context";
  if (name.includes("reverse-engineer") || name.includes("rea")) return "rea";
  return "other";
}

function parseYamlScalar(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function encodeYamlScalar(value) {
  // JSON string syntax is a valid YAML double-quoted scalar and escapes
  // backslashes (Windows paths) and quotes without hand-rolled escaping.
  return JSON.stringify(String(value));
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { name: "", description: "" };
  const fm = match[1];

  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? parseYamlScalar(nameMatch[1]) : "";

  let description = "";
  const lines = fm.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^description:\s*(.*)$/);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline === "|" || inline === ">" || inline === "|-" || inline === ">-") {
      const buf = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s+/.test(lines[j])) buf.push(lines[j].trim());
        else if (lines[j].trim() === "") buf.push("");
        else break;
      }
      description = buf.join(" ").trim();
    } else {
      description = parseYamlScalar(inline);
    }
    break;
  }

  return { name, description };
}

async function pathExists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function readSkillEntry(dir, name, enabled) {
  const skillDir = path.join(dir, name);
  const skillMdPath = path.join(skillDir, "SKILL.md");
  let hasSkillMd = false;
  let description = "";
  let fileSizeBytes = 0;

  try {
    const [raw, st] = await Promise.all([
      fs.readFile(skillMdPath, "utf8"),
      fs.stat(skillMdPath),
    ]);
    hasSkillMd = true;
    fileSizeBytes = st.size;
    const fm = parseFrontmatter(raw);
    description = fm.description || "";
  } catch {
    // Directory without SKILL.md
  }

  // Approximate XML block size inside <available_skills>
  const approxPromptBytes = hasSkillMd
    ? Buffer.byteLength(
        `<skill><name>${name}</name><description>${description}</description><location>${skillMdPath}</location></skill>`,
        "utf8"
      )
    : 0;

  return {
    name,
    enabled,
    isCatalog: name === CATALOG_SKILL_NAME,
    group: inferGroup(name),
    hasSkillMd,
    description,
    descLen: description.length,
    approxPromptBytes,
    fileSizeBytes,
    dir: skillDir,
    location: skillMdPath,
  };
}

async function readDirSkillNames(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Sync symlinks in tool-specific skill folders (~/.claude/skills, ~/.gemini/config/skills).
 * Only manages symlinks — never deletes or overwrites real non-symlink directories.
 */
async function syncToolSymlink(name, enabled, { skillsDir, symlinkTargets }) {
  const targetSkillPath = path.join(skillsDir, name);

  for (const toolDir of symlinkTargets) {
    if (!(await pathExists(toolDir))) continue;
    const linkPath = path.join(toolDir, name);

    let stat = null;
    try {
      stat = await fs.lstat(linkPath);
    } catch {
      stat = null;
    }

    if (enabled) {
      if (stat) continue; // Already exists (symlink or real dir)
      try {
        const rel = path.relative(toolDir, targetSkillPath);
        await fs.symlink(rel, linkPath);
      } catch {
        // Ignore symlink failure on restricted FS
      }
    } else {
      // Only remove if it's a symlink (never delete real directories like ~/.claude/skills/archify)
      if (stat && stat.isSymbolicLink()) {
        await fs.unlink(linkPath).catch(() => {});
      }
    }
  }
}

/**
 * Build the catalog frontmatter description. It ends up inside agent prompts (often in an
 * XML block), so keep it free of `<`/`>` — an unclosed placeholder such as `<name>` makes
 * the whole block invalid XML — and within the 1024-char skill-spec limit.
 */
export function buildCatalogDescription(names, disabledDir) {
  const head = `On-demand catalog of ${names.length} extra skills stored in ${disabledDir} as {name}/SKILL.md: `;
  const tail =
    ". Read a skill's SKILL.md only when the user tags it (@name or /name) or asks for that domain.";
  const budget = MAX_CATALOG_DESCRIPTION_CHARS - head.length - tail.length;
  if (budget <= 16) {
    // Pathologically long skills dir — fall back to a minimal, always-valid description.
    return `On-demand catalog of ${names.length} extra skills. Read a skill's SKILL.md only when the user tags it (@name or /name) or asks for that domain.`;
  }

  const kept = [];
  let used = 0;
  for (const name of names) {
    const add = (kept.length > 0 ? 2 : 0) + name.length;
    if (used + add > budget - 16) break; // reserve room for the "(+N more)" suffix
    kept.push(name);
    used += add;
  }

  const list =
    kept.length === names.length
      ? kept.join(", ")
      : `${kept.join(", ")} (+${names.length - kept.length} more)`;

  return `${head}${list}${tail}`;
}

/**
 * Regenerate or remove ~/.agents/skills/skill-catalog/SKILL.md so AI agents always know
 * which skills exist in ~/.agents/skills-disabled/ in ~300-500 bytes instead of ~8-10KB.
 */
export async function syncSkillCatalog(opts = {}) {
  const paths = resolvePaths(opts);
  const { skillsDir, disabledDir } = paths;

  const disabledNames = (await readDirSkillNames(disabledDir)).filter(
    (n) => n !== CATALOG_SKILL_NAME
  );
  const disabledSkills = [];
  for (const name of disabledNames) {
    const entry = await readSkillEntry(disabledDir, name, false);
    if (entry.hasSkillMd) disabledSkills.push(entry);
  }

  const catalogDir = path.join(skillsDir, CATALOG_SKILL_NAME);
  const catalogMd = path.join(catalogDir, "SKILL.md");

  if (disabledSkills.length === 0) {
    // Nothing disabled — remove catalog to avoid unnecessary prompt entry
    await fs.rm(catalogDir, { recursive: true, force: true }).catch(() => {});
    await syncToolSymlink(CATALOG_SKILL_NAME, false, paths);
    return { catalogEnabled: false, count: 0, location: catalogMd };
  }

  await fs.mkdir(catalogDir, { recursive: true });

  const shortDesc = buildCatalogDescription(
    disabledSkills.map((s) => s.name),
    disabledDir
  );

  const lines = [
    "---",
    `name: ${CATALOG_SKILL_NAME}`,
    `description: ${encodeYamlScalar(shortDesc)}`,
    "---",
    "",
    "# On-Demand Skill Catalog",
    "",
    `The following skills are installed in \`${disabledDir}\` and loaded only on demand to keep context small.`,
    "When the user explicitly mentions/tags a skill (e.g. `@skill-name` or `/skill-name`) or requests a task matching one of these skills, read its `SKILL.md` file first before proceeding:",
    "",
    ...disabledSkills.map((s) => {
      const brief = s.description
        ? s.description.replace(/\s+/g, " ").slice(0, 140)
        : "No description";
      return `- **${s.name}** (\`${s.location}\`): ${brief}`;
    }),
    "",
  ];

  await fs.writeFile(catalogMd, lines.join("\n"), "utf8");
  await syncToolSymlink(CATALOG_SKILL_NAME, true, paths);

  return {
    catalogEnabled: true,
    count: disabledSkills.length,
    location: catalogMd,
    descriptionBytes: Buffer.byteLength(shortDesc, "utf8"),
  };
}

export async function listLocalSkills(opts = {}) {
  const paths = resolvePaths(opts);
  const [enabledNames, disabledNames] = await Promise.all([
    readDirSkillNames(paths.skillsDir),
    readDirSkillNames(paths.disabledDir),
  ]);

  const seen = new Set();
  const skills = [];

  for (const name of enabledNames) {
    seen.add(name);
    skills.push(await readSkillEntry(paths.skillsDir, name, true));
  }
  for (const name of disabledNames) {
    if (seen.has(name)) continue;
    skills.push(await readSkillEntry(paths.disabledDir, name, false));
  }

  skills.sort((a, b) => {
    if (a.isCatalog !== b.isCatalog) return a.isCatalog ? -1 : 1;
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const regularSkills = skills.filter((s) => !s.isCatalog && s.hasSkillMd);
  const enabledRegular = regularSkills.filter((s) => s.enabled);
  const disabledRegular = regularSkills.filter((s) => !s.enabled);
  const catalogSkill = skills.find((s) => s.isCatalog) || null;

  const activePromptBytes = skills
    .filter((s) => s.enabled && s.hasSkillMd)
    .reduce((sum, s) => sum + s.approxPromptBytes, 0);
  const allSkillsPromptBytes = regularSkills.reduce(
    (sum, s) => sum + s.approxPromptBytes,
    0
  );

  return {
    skillsDir: paths.skillsDir,
    disabledDir: paths.disabledDir,
    catalogEnabled: Boolean(catalogSkill),
    catalogPromptBytes: catalogSkill?.approxPromptBytes || 0,
    enabledCount: enabledRegular.length,
    disabledCount: disabledRegular.length,
    totalCount: regularSkills.length,
    activePromptBytes,
    allSkillsPromptBytes,
    savedBytes: Math.max(0, allSkillsPromptBytes - activePromptBytes),
    skills,
  };
}

async function moveDirSafe(src, dst) {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  try {
    await fs.rename(src, dst);
  } catch (err) {
    if (err?.code === "EXDEV") {
      await fs.cp(src, dst, { recursive: true });
      await fs.rm(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

/**
 * Enable or disable one or more skills by exact name, prefix, group, or "all".
 */
export async function setSkillsEnabled(targets, enabled, opts = {}) {
  const paths = resolvePaths(opts);
  const targetList = (Array.isArray(targets) ? targets : [targets])
    .map((t) => String(t || "").trim())
    .filter(Boolean);

  if (targetList.length === 0) {
    return { changed: [], skipped: [], state: await listLocalSkills(opts) };
  }

  const current = await listLocalSkills(opts);
  const regular = current.skills.filter((s) => !s.isCatalog);

  const matched = new Set();
  for (const query of targetList) {
    if (query === "all" || query === "*") {
      for (const s of regular) matched.add(s.name);
      continue;
    }
    const qLower = query.toLowerCase();
    for (const s of regular) {
      if (
        s.name === query ||
        s.name.toLowerCase() === qLower ||
        s.group === qLower ||
        s.name.toLowerCase().startsWith(`${qLower}-`) ||
        s.name.toLowerCase().startsWith(qLower)
      ) {
        matched.add(s.name);
      }
    }
  }

  const changed = [];
  const skipped = [];

  for (const name of matched) {
    if (!isSafeSkillName(name) || name === CATALOG_SKILL_NAME) {
      skipped.push(name);
      continue;
    }
    const src = path.join(enabled ? paths.disabledDir : paths.skillsDir, name);
    const dst = path.join(enabled ? paths.skillsDir : paths.disabledDir, name);

    if (!(await pathExists(src))) {
      skipped.push(name);
      continue;
    }
    if (await pathExists(dst)) {
      skipped.push(name);
      continue;
    }

    await moveDirSafe(src, dst);
    await syncToolSymlink(name, enabled, paths);
    changed.push(name);
  }

  if (opts.syncCatalog !== false) {
    await syncSkillCatalog(opts);
  }

  return {
    changed,
    skipped,
    state: await listLocalSkills(opts),
  };
}

export async function applySkillsPreset(preset, opts = {}) {
  const current = await listLocalSkills(opts);
  const regular = current.skills.filter((s) => !s.isCatalog);

  if (preset === "all") {
    return setSkillsEnabled(["all"], true, opts);
  }
  if (preset === "none" || preset === "minimal") {
    return setSkillsEnabled(["all"], false, opts);
  }
  if (preset === "core") {
    const toEnable = regular
      .filter((s) => CORE_SKILL_NAMES.includes(s.name) && !s.enabled)
      .map((s) => s.name);
    const toDisable = regular
      .filter((s) => !CORE_SKILL_NAMES.includes(s.name) && s.enabled)
      .map((s) => s.name);

    const changed = [];
    if (toEnable.length > 0) {
      const r1 = await setSkillsEnabled(toEnable, true, { ...opts, syncCatalog: false });
      changed.push(...r1.changed);
    }
    if (toDisable.length > 0) {
      const r2 = await setSkillsEnabled(toDisable, false, { ...opts, syncCatalog: false });
      changed.push(...r2.changed);
    }
    await syncSkillCatalog(opts);
    return { changed, skipped: [], state: await listLocalSkills(opts) };
  }

  throw new Error(`Unknown skills preset: ${preset}`);
}
