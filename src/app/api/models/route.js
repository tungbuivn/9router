import { NextResponse } from "next/server";
import { getModelAliases, setModelAlias, getCustomModels, getCombos, getProviderConnections, getProviderNodes } from "@/models";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { AI_MODELS } from "@/shared/constants/config";
import { getProviderAlias, ALIAS_TO_ID } from "@/shared/constants/providers";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { resolveSeatCapabilities, fetchModelsForConnection, extractModelContextInfo } from "@/lib/modelProviderContext.js";

// GET /api/models - Get models with aliases
export async function GET() {
  try {
    const modelAliases = await getModelAliases();
    const disabled = await getDisabledModels();

    const models = AI_MODELS
      .filter((m) => {
        const alias = getProviderAlias(m.provider) || m.provider;
        const list = disabled[alias] || disabled[m.provider] || [];
        return !list.includes(m.model);
      })
      .map((m) => {
        const fullModel = `${m.provider}/${m.model}`;
        const providerAlias = getProviderAlias(m.provider) || m.provider;
        const routedModel = `${providerAlias}/${m.model}`;
        const c = getCapabilitiesForModel(m.provider, m.model);
        const thinkingLevels = getThinkingLevels(m.provider, m.model);
        return {
          ...m,
          fullModel,
          routedModel,
          alias: modelAliases[fullModel] || m.model,
          // Same per-model set /v1/models already publishes, so CLI-tool cards can
          // seed thinking levels instead of guessing them (Pi, opencode).
          ...(Array.isArray(thinkingLevels) && thinkingLevels.length > 0 ? { thinking_levels: thinkingLevels } : {}),
          caps: {
            vision: c.vision,
            search: c.search,
            reasoning: c.reasoning,
            contextWindow: c.contextWindow,
            maxOutput: c.maxOutput,
          },
        };
      });

    // Custom models ride along; their stored caps override the name heuristic.
    // A custom row whose provider alias routes to an already-listed model is a
    // pure shadow: the real entry wins (and is listed first), but this row would
    // land later with the same routedModel key and the client's last-write-wins
    // map then serves its thinner caps (a pre-registry "add custom model" row
    // stores {vision, reasoning} only — no contextWindow). Drop the shadow and
    // resolve the survivors' provider id, not the UI alias: the capability
    // tables are keyed by provider id, and an alias like `ocg` misses the
    // provider-scoped entries and falls back to the generic patterns.
    const [combos, connections, nodes] = await Promise.all([
      getCombos().catch(() => []),
      getProviderConnections().catch(() => []),
      getProviderNodes().catch(() => []),
    ]);

    const seenFull = new Set(models.map((m) => m.fullModel));
    const seenRouted = new Set(models.map((m) => m.routedModel));
    const customModels = (await getCustomModels()).filter((m) => {
      if (!m?.id || (m.kind || m.type || "llm") !== "llm") return false;
      if (seenRouted.has(`${m.providerAlias}/${m.id}`)) return false;
      return !seenFull.has(`${m.providerAlias}/${m.id}`);
    });
    for (const m of customModels) {
      const fullModel = `${m.providerAlias}/${m.id}`;
      const providerId = ALIAS_TO_ID[m.providerAlias] || m.providerAlias;
      const nodeForCustom = nodes.find((n) => n.id === m.providerAlias);
      const nodePrefix = nodeForCustom?.prefix;
      const seatForCustom = nodePrefix ? `${nodePrefix}/${m.id}` : fullModel;
      const c = (await resolveSeatCapabilities(seatForCustom, { connections, nodes })) || getCapabilitiesForModel(providerId, m.id);
      const thinkingLevels = getThinkingLevels(providerId, m.id);
      const caps = {
        vision: c.vision,
        search: c.search,
        reasoning: c.reasoning,
        contextWindow: c.contextWindow,
        maxOutput: c.maxOutput,
        ...(m.caps || {}),
      };
      models.push({
        provider: m.providerAlias,
        model: m.id,
        name: m.name || m.id,
        fullModel,
        routedModel: fullModel,
        alias: modelAliases[fullModel] || m.id,
        ...(Array.isArray(thinkingLevels) && thinkingLevels.length > 0 ? { thinking_levels: thinkingLevels } : {}),
        caps,
      });

      if (nodePrefix && !seenFull.has(`${nodePrefix}/${m.id}`)) {
        seenFull.add(`${nodePrefix}/${m.id}`);
        models.push({
          provider: nodePrefix,
          model: m.id,
          name: m.name || m.id,
          fullModel: `${nodePrefix}/${m.id}`,
          routedModel: `${nodePrefix}/${m.id}`,
          alias: modelAliases[`${nodePrefix}/${m.id}`] || m.id,
          caps,
        });
      }
    }

    // For every provider node / connection with a baseUrl (e.g. http://127.0.0.1:8888/v1/models),
    // discover live models and query context lengths dynamically from the provider.
    const activeCustomProviders = [];
    for (const node of nodes || []) {
      if (!node.prefix) continue;
      const conn = (connections || []).find(
        (c) => c.isActive !== false && c.provider === node.id
      );
      activeCustomProviders.push({ prefix: node.prefix, node, connection: conn || null });
    }
    for (const conn of connections || []) {
      if (conn.isActive === false) continue;
      const prefix = conn.providerSpecificData?.prefix || conn.name;
      if (prefix && !activeCustomProviders.some((p) => p.prefix === prefix)) {
        activeCustomProviders.push({ prefix, node: null, connection: conn });
      }
    }

    for (const provider of activeCustomProviders) {
      const providerModels = await fetchModelsForConnection(provider.connection, provider.node);
      for (const pm of providerModels) {
        const id = pm?.id || pm?.name || pm?.slug;
        if (!id) continue;
        const contextInfo = extractModelContextInfo(pm);
        if (!contextInfo?.contextLength) continue;

        const defaultCaps = getCapabilitiesForModel(provider.prefix, id);
        const caps = {
          ...defaultCaps,
          contextWindow: contextInfo.contextLength,
          ...(contextInfo.maxOutput ? { maxOutput: contextInfo.maxOutput } : {}),
          ...(pm.isVL !== undefined ? { vision: pm.isVL } : {}),
          ...(pm.isReasoning !== undefined ? { reasoning: pm.isReasoning } : {}),
        };

        const seat = `${provider.prefix}/${id}`;
        if (!seenFull.has(seat)) {
          seenFull.add(seat);
          models.push({
            provider: provider.prefix,
            model: id,
            name: pm.display_name || pm.name || id,
            fullModel: seat,
            routedModel: seat,
            alias: modelAliases[seat] || id,
            caps,
          });
        }

        // If model has quant (e.g. Q4_1), also register explicit tagged seat
        if (pm.quant && !id.includes(`:${pm.quant}`)) {
          const quantId = `${id}:${pm.quant}`;
          const quantSeat = `${provider.prefix}/${quantId}`;
          if (!seenFull.has(quantSeat)) {
            seenFull.add(quantSeat);
            models.push({
              provider: provider.prefix,
              model: quantId,
              name: quantId,
              fullModel: quantSeat,
              routedModel: quantSeat,
              alias: modelAliases[quantSeat] || quantId,
              caps,
            });
          }
        }
      }
    }

    // Resolve model context directly from providers for combo seats (e.g. combo 117)
    for (const combo of combos) {
      for (const seat of combo.models || []) {
        if (typeof seat !== "string" || !seat.includes("/")) continue;
        const slash = seat.indexOf("/");
        const prefix = seat.slice(0, slash).trim();
        const modelId = seat.slice(slash + 1).replace(/\([^()]+\)\s*$/, "").trim();

        if (!seenFull.has(seat)) {
          seenFull.add(seat);
          const caps = await resolveSeatCapabilities(seat, { connections, nodes });
          if (caps) {
            models.push({
              provider: prefix,
              model: modelId,
              name: modelId,
              fullModel: seat,
              routedModel: seat,
              alias: modelAliases[seat] || modelId,
              caps,
            });

            // Also register base model without quant/tag if applicable
            const baseModelId = modelId.split(":")[0];
            const baseSeat = `${prefix}/${baseModelId}`;
            if (baseModelId !== modelId && !seenFull.has(baseSeat)) {
              seenFull.add(baseSeat);
              models.push({
                provider: prefix,
                model: baseModelId,
                name: baseModelId,
                fullModel: baseSeat,
                routedModel: baseSeat,
                alias: modelAliases[baseSeat] || baseModelId,
                caps,
              });
            }
          }
        }
      }
    }

    // Also register combos as selectable models with their aggregated capabilities
    for (const combo of combos) {
      if (!combo.name) continue;
      let comboContext = Infinity;
      let comboMaxOutput = Infinity;
      let hasVision = false;
      let hasReasoning = false;
      let hasSearch = false;

      for (const seat of combo.models || []) {
        if (typeof seat !== "string") continue;
        const matched = models.find(
          (m) => m.fullModel === seat || m.routedModel === seat || m.model === seat
        );
        const caps = matched?.caps || (await resolveSeatCapabilities(seat, { connections, nodes }));
        if (caps) {
          if (Number.isFinite(caps.contextWindow)) comboContext = Math.min(comboContext, caps.contextWindow);
          if (Number.isFinite(caps.maxOutput)) comboMaxOutput = Math.min(comboMaxOutput, caps.maxOutput);
          if (caps.vision) hasVision = true;
          if (caps.reasoning) hasReasoning = true;
          if (caps.search) hasSearch = true;
        }
      }

      // Limits follow the FIRST seat (the primary model), not the aggregate.
      // The aggregate above is the conservative min/max across members, which
      // reorders the published window every time a fallback is appended — a
      // combo published as 1M silently became 128k after adding a small model
      // behind it, so clients compacted for a window the primary never had.
      // The first seat is what actually serves a healthy request, so it owns
      // the declared limits. The aggregate stays as the fallback for a seat
      // that resolves to nothing.
      const firstSeat = (combo.models || [])[0];
      let firstSeatCaps = null;
      if (typeof firstSeat === "string") {
        const matched = models.find(
          (m) => m.fullModel === firstSeat || m.routedModel === firstSeat || m.model === firstSeat
        );
        firstSeatCaps = matched?.caps || (await resolveSeatCapabilities(firstSeat, { connections, nodes }));
      }
      const finalContext = firstSeatCaps?.contextWindow ?? (Number.isFinite(comboContext) ? comboContext : undefined);
      const finalMaxOutput = firstSeatCaps?.maxOutput ?? (Number.isFinite(comboMaxOutput) ? comboMaxOutput : undefined);

      if (!seenFull.has(combo.name)) {
        seenFull.add(combo.name);
        models.push({
          provider: "combo",
          model: combo.name,
          name: combo.name,
          fullModel: combo.name,
          routedModel: combo.name,
          alias: combo.name,
          caps: {
            vision: hasVision,
            search: hasSearch,
            reasoning: hasReasoning,
            contextWindow: finalContext,
            maxOutput: finalMaxOutput,
          },
        });
      }
    }

    // Also register configured model aliases so alias names resolve to target caps
    for (const [targetSeat, alias] of Object.entries(modelAliases || {})) {
      if (!alias || seenFull.has(alias)) continue;
      const targetModel = models.find(
        (m) => m.fullModel === targetSeat || m.routedModel === targetSeat || m.model === targetSeat
      );
      if (targetModel?.caps) {
        seenFull.add(alias);
        models.push({
          provider: "alias",
          model: alias,
          name: alias,
          fullModel: alias,
          routedModel: alias,
          alias,
          caps: targetModel.caps,
        });
      }
    }

    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}

// PUT /api/models - Update model alias
export async function PUT(request) {
  try {
    const body = await request.json();
    const { model, alias } = body;

    if (!model || !alias) {
      return NextResponse.json({ error: "Model and alias required" }, { status: 400 });
    }

    const modelAliases = await getModelAliases();

    // Check if alias already exists for different model
    const existingModel = Object.entries(modelAliases).find(
      ([key, val]) => val === alias && key !== model
    );

    if (existingModel) {
      return NextResponse.json({ error: "Alias already in use" }, { status: 400 });
    }

    // Update alias
    await setModelAlias(model, alias);

    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    console.log("Error updating alias:", error);
    return NextResponse.json({ error: "Failed to update alias" }, { status: 500 });
  }
}
