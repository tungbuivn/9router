import { FORMATS } from "../translator/formats.js";
import { ROLE } from "../translator/schema/roles.js";
import { RESPONSES_ITEM } from "../translator/schema/blocks.js";

const AVAILABLE_SKILLS_RE = /<available_skills\b[^>]*>[\s\S]*?<\/available_skills>/gi;
const SKILL_BLOCK_RE = /<skill\b[^>]*>([\s\S]*?)<\/skill>/gi;

function extractTagValue(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1].trim() : "";
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectUserConversationText(body) {
  const chunks = [];
  const pushContent = (content) => {
    if (typeof content === "string") chunks.push(content);
    else if (Array.isArray(content)) {
      for (const p of content) {
        if (typeof p === "string") chunks.push(p);
        else if (p && typeof p.text === "string") chunks.push(p.text);
      }
    } else if (content && typeof content.text === "string") {
      chunks.push(content.text);
    }
  };

  if (Array.isArray(body?.messages)) {
    for (const m of body.messages) {
      if (!m || m.role === ROLE.SYSTEM || m.role === ROLE.DEVELOPER) continue;
      // Ignore masqueraded huge leading system prompts containing <available_skills>
      const role = String(m.role || "").toLowerCase();
      if (role !== "user") continue;
      const before = chunks.length;
      pushContent(m.content);
      const joined = chunks.slice(before).join("\n");
      if (joined.includes("<available_skills")) {
        chunks.length = before;
      }
    }
  }

  if (Array.isArray(body?.input)) {
    for (const item of body.input) {
      if (!item || item.role !== "user") continue;
      pushContent(item.content);
    }
  } else if (typeof body?.input === "string") {
    chunks.push(body.input);
  }

  const contents = body?.request?.contents || body?.contents;
  if (Array.isArray(contents)) {
    for (const item of contents) {
      if (!item || (item.role && item.role !== "user")) continue;
      pushContent(item.parts || item.content);
    }
  }

  return chunks.join("\n").toLowerCase();
}

function isSkillMentionedInUserText(skillName, lowerUserText) {
  if (!skillName || !lowerUserText) return false;
  const escaped = escapeRegExp(skillName.toLowerCase());
  // Matches `@skill-name`, `/skill-name`, or standalone `skill-name`
  const re = new RegExp(`(?:^|[^a-z0-9_-])[@/]?${escaped}(?:$|[^a-z0-9_-])`, "i");
  return re.test(lowerUserText);
}

/**
 * Rewrite a `<available_skills>...</available_skills>` XML block according to mode:
 * - "compact": drop verbose `<description>` bodies, keeping `<name>` + `<location>` (~80-85% smaller, cache-stable)
 * - "on-demand": keep full `<skill>` ONLY when tagged/mentioned in user messages (or `skill-catalog`),
 *   and list all other skill names in a 1-line compact index (~90-95% smaller)
 */
export function rewriteAvailableSkillsText(text, { mode = "off", lowerUserText = "" } = {}) {
  if (typeof text !== "string" || !text || (mode !== "compact" && mode !== "on-demand")) {
    return { text, applied: false, beforeBytes: 0, afterBytes: 0, totalSkills: 0, keptSkills: 0 };
  }
  if (!text.includes("<available_skills")) {
    return { text, applied: false, beforeBytes: 0, afterBytes: 0, totalSkills: 0, keptSkills: 0 };
  }

  let totalBefore = 0;
  let totalAfter = 0;
  let totalSkills = 0;
  let keptSkills = 0;
  let applied = false;

  const rewritten = text.replace(AVAILABLE_SKILLS_RE, (fullBlock) => {
    const parsed = [];
    let m;
    SKILL_BLOCK_RE.lastIndex = 0;
    while ((m = SKILL_BLOCK_RE.exec(fullBlock)) !== null) {
      const inner = m[1];
      const name = extractTagValue(inner, "name");
      const location = extractTagValue(inner, "location");
      const description = extractTagValue(inner, "description");
      if (name) {
        parsed.push({ raw: m[0], name, location, description });
      }
    }

    if (parsed.length === 0) return fullBlock;

    totalSkills += parsed.length;
    totalBefore += Buffer.byteLength(fullBlock, "utf8");

    let replacement;
    if (mode === "compact") {
      keptSkills += parsed.length;
      const lines = parsed.map((s) =>
        s.location
          ? `<skill><name>${s.name}</name><location>${s.location}</location></skill>`
          : `<skill><name>${s.name}</name></skill>`
      );
      replacement = `<available_skills>\n${lines.join("\n")}\n</available_skills>`;
    } else {
      // on-demand: keep full entry only for explicitly mentioned skills (+ skill-catalog)
      const activeEntries = [];
      const dormantEntries = [];
      for (const s of parsed) {
        if (s.name === "skill-catalog" || isSkillMentionedInUserText(s.name, lowerUserText)) {
          activeEntries.push(s);
        } else {
          dormantEntries.push(s);
        }
      }
      keptSkills += activeEntries.length;

      const parts = [];
      for (const s of activeEntries) parts.push(s.raw);
      if (dormantEntries.length > 0) {
        const indexList = dormantEntries
          .map((s) => (s.location ? `${s.name} (${s.location})` : s.name))
          .join(", ");
        parts.push(
          `<on_demand_skills>Only read a skill's SKILL.md when the user tags or asks for it: ${indexList}</on_demand_skills>`
        );
      }
      replacement = `<available_skills>\n${parts.join("\n")}\n</available_skills>`;
    }

    const nextBytes = Buffer.byteLength(replacement, "utf8");
    const prevBytes = Buffer.byteLength(fullBlock, "utf8");
    // Only apply when it actually shrinks the block
    if (nextBytes < prevBytes) {
      totalAfter += nextBytes;
      applied = true;
      return replacement;
    }

    totalAfter += prevBytes;
    return fullBlock;
  });

  return {
    text: rewritten,
    applied,
    beforeBytes: totalBefore,
    afterBytes: totalAfter,
    savedBytes: Math.max(0, totalBefore - totalAfter),
    totalSkills,
    keptSkills,
  };
}

/**
 * Optimize `<available_skills>` blocks across OpenAI Chat, Claude, OpenAI Responses,
 * and Gemini request bodies in place. Fail-open — never throws or breaks a request.
 */
export function optimizeAvailableSkills(body, format, { mode = "off" } = {}) {
  const empty = { applied: false, mode, beforeBytes: 0, afterBytes: 0, savedBytes: 0, totalSkills: 0, keptSkills: 0 };
  try {
    if (!body || typeof body !== "object") return empty;
    if (mode !== "compact" && mode !== "on-demand") return empty;

    const lowerUserText = mode === "on-demand" ? collectUserConversationText(body) : "";
    const agg = { ...empty };

    const transformText = (str) => {
      const res = rewriteAvailableSkillsText(str, { mode, lowerUserText });
      if (res.applied) {
        agg.applied = true;
        agg.beforeBytes += res.beforeBytes;
        agg.afterBytes += res.afterBytes;
        agg.savedBytes += res.savedBytes;
        agg.totalSkills += res.totalSkills;
        agg.keptSkills += res.keptSkills;
      }
      return res.text;
    };

    const transformContent = (content) => {
      if (typeof content === "string") return transformText(content);
      if (Array.isArray(content)) {
        let changed = false;
        const next = content.map((p) => {
          if (typeof p === "string") {
            const t = transformText(p);
            if (t !== p) changed = true;
            return t;
          }
          if (p && typeof p === "object" && typeof p.text === "string") {
            const t = transformText(p.text);
            if (t !== p.text) {
              changed = true;
              return { ...p, text: t };
            }
          }
          return p;
        });
        return changed ? next : content;
      }
      return content;
    };

    // 1. Claude top-level body.system
    if (format === FORMATS.CLAUDE || body.system !== undefined) {
      if (body.system !== undefined) {
        body.system = transformContent(body.system);
      }
    }

    // 2. Gemini systemInstruction / system_instruction
    const geminiTarget = body.request && typeof body.request === "object" ? body.request : body;
    for (const key of ["system_instruction", "systemInstruction"]) {
      const sys = geminiTarget?.[key];
      if (sys && Array.isArray(sys.parts)) {
        sys.parts = transformContent(sys.parts);
      }
    }

    // 3. OpenAI Responses top-level instructions
    if (typeof body.instructions === "string") {
      body.instructions = transformText(body.instructions);
    }

    // 4. OpenAI Chat messages[] (system/developer + leading user message for Copilot SDK)
    if (Array.isArray(body.messages)) {
      for (let i = 0; i < body.messages.length; i++) {
        const m = body.messages[i];
        if (!m) continue;
        const role = String(m.role || "").toLowerCase();
        if (role === ROLE.SYSTEM || role === ROLE.DEVELOPER || i === 0) {
          m.content = transformContent(m.content);
        }
      }
    }

    // 5. OpenAI Responses input[]
    if (Array.isArray(body.input)) {
      for (let i = 0; i < body.input.length; i++) {
        const item = body.input[i];
        if (!item) continue;
        const isSys = item.type === RESPONSES_ITEM.MESSAGE && (item.role === ROLE.SYSTEM || item.role === ROLE.DEVELOPER);
        if (isSys || i === 0) {
          item.content = transformContent(item.content);
        }
      }
    }

    return agg;
  } catch {
    return empty;
  }
}
