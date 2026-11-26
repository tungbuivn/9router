/**
 * Helpers for auto-generating combos grouped by context window.
 *
 * Providers publish a window in tokens, but the same real limit arrives under
 * several numbers: 1M shows up as 1_000_000 (most vendors) and 1_048_576
 * (Gemini, Kimi); 256k as 256_000 and 262_144; 64k as 64_000 and 65_536. A naive
 * equality check therefore puts two identical-window models in separate combos,
 * so everything is bucketed through getContextGroupMeta() first and the bucket
 * carries the canonical label used for the combo name.
 *
 * The bucket drives the combo NAME only. The actual ctx/max published for a
 * combo comes from its first model (see ComboCard), never from the bucket.
 */

// Format token count into standard label ("1M", "256k", "128k", "64k")
export function formatContextLabel(n) {
  if (!n || typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "?";
  if (n >= 990000 && n <= 1100000) return "1M";
  if (n >= 1900000 && n <= 2100000) return "2M";
  if (n >= 1000000) {
    const m = Math.round(n / 100000) / 10;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  // 262,144 (256 * 1024) is standard 256k context
  if (n >= 255000 && n <= 265000) return "256k";
  // 65,536 (64 * 1024) is standard 64k context
  if (n >= 63000 && n <= 66000) return "64k";
  // Other sizes (e.g. 131072 -> 131k, 128000 -> 128k)
  return `${Math.round(n / 1000)}k`;
}

// Metadata for standard context window buckets
export function getContextGroupMeta(ctx) {
  if (!ctx || typeof ctx !== "number" || !Number.isFinite(ctx) || ctx <= 0) return null;
  if (ctx >= 990000 && ctx <= 1100000) return { key: "1m", label: "1M", tokens: 1000000 };
  if (ctx >= 450000 && ctx <= 550000) return { key: "500k", label: "500k", tokens: 500000 };
  if (ctx >= 240000 && ctx <= 280000) return { key: "256k", label: "256k", tokens: 256000 };
  if (ctx >= 180000 && ctx <= 210000) return { key: "200k", label: "200k", tokens: 200000 };
  if (ctx >= 120000 && ctx <= 140000) return { key: "128k", label: "128k", tokens: 128000 };
  if (ctx >= 60000 && ctx <= 70000) return { key: "64k", label: "64k", tokens: 64000 };
  if (ctx >= 30000 && ctx <= 40000) return { key: "32k", label: "32k", tokens: 32000 };
  const k = Math.round(ctx / 1000);
  return { key: `${k}k`, label: `${k}k`, tokens: ctx };
}

// Map concrete token counts into context bucket keys
export function getContextGroupKey(ctx) {
  const meta = getContextGroupMeta(ctx);
  return meta?.key || null;
}

// Generate unique combo name given existing ones
export function getUniqueComboName(baseName, existingNames = []) {
  const existing = new Set(existingNames);
  if (!existing.has(baseName)) return baseName;
  let counter = 2;
  while (existing.has(`${baseName}-${counter}`)) {
    counter++;
  }
  return `${baseName}-${counter}`;
}

/**
 * Group active models by their context window.
 *
 * @param {Array<{ id: string, name?: string, caps?: object }>} models
 * @param {string[]} [existingComboNames]
 * @returns {Array<{ key: string, label: string, contextWindow: number, suggestedName: string, alreadyExists: boolean, models: Array<{ id: string, name: string, caps: object }> }>}
 */
export function buildContextComboGroups(models, existingComboNames = []) {
  const groupsMap = new Map();

  for (const m of models || []) {
    const fullId = typeof m === "string" ? m : (m.id || m.fullModel || m.routedModel);
    if (!fullId) continue;
    const caps = m.caps || {};
    const ctx = caps.contextWindow;
    if (!ctx || !Number.isFinite(ctx) || ctx <= 0) continue;

    const meta = getContextGroupMeta(ctx);
    if (!meta) continue;

    if (!groupsMap.has(meta.key)) {
      groupsMap.set(meta.key, {
        key: meta.key,
        label: meta.label,
        contextWindow: meta.tokens,
        models: [],
      });
    }

    const group = groupsMap.get(meta.key);
    if (!group.models.some((item) => (item.id || item) === fullId)) {
      group.models.push({
        id: fullId,
        name: m.name || fullId,
        caps,
      });
    }
  }

  // Sort groups descending by contextWindow (1M -> 500k -> 256k -> 128k -> 64k)
  const sorted = Array.from(groupsMap.values()).sort((a, b) => b.contextWindow - a.contextWindow);

  const existing = new Set(existingComboNames || []);
  return sorted.map((g) => {
    const defaultName = `combo-${g.key}`;
    return {
      ...g,
      suggestedName: getUniqueComboName(defaultName, existing),
      alreadyExists: existing.has(defaultName),
    };
  });
}

/**
 * Filter models that share the same context bucket as a target context count.
 *
 * @param {number} targetContext
 * @param {Array<{ id: string, name?: string, caps?: object }>} allModels
 * @returns {string[]} Model IDs matching the context group
 */
export function findModelsWithSameContext(targetContext, allModels) {
  const targetKey = getContextGroupKey(targetContext);
  if (!targetKey) return [];

  const matched = [];
  const seen = new Set();
  for (const m of allModels || []) {
    const fullId = typeof m === "string" ? m : (m.id || m.fullModel || m.routedModel);
    if (!fullId || seen.has(fullId)) continue;
    const caps = m.caps || {};
    const ctx = caps.contextWindow;
    if (ctx && getContextGroupKey(ctx) === targetKey) {
      seen.add(fullId);
      matched.push(fullId);
    }
  }
  return matched;
}
