import { spawn } from "child_process";
import { buildAcpProcessEnv } from "../utils/w2Proxy.js";
import {
  buildAcpPathEnv,
  killAcpChild,
  resolveAcpSpawn,
} from "../utils/acpRuntime.js";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const acpModelsCache = new Map();

export function clearAcpModelsCache() {
  acpModelsCache.clear();
}

function resolveAcpCommand(command, pathEnv) {
  return resolveAcpSpawn(command || "agy", { pathEnv });
}

function normalizeArgs(args) {
  if (Array.isArray(args)) return args.map((a) => String(a).trim()).filter(Boolean);
  if (typeof args === "string" && args.trim()) return args.trim().split(/\s+/).filter(Boolean);
  return ["acp"];
}

function extractModelsFromSessionResult(result) {
  if (!result || typeof result !== "object") return [];
  const seen = new Set();
  const models = [];

  const add = (id, name, description) => {
    const cleanId = String(id || "").trim();
    if (!cleanId || seen.has(cleanId)) return;
    seen.add(cleanId);
    models.push({
      id: cleanId,
      name: String(name || cleanId).trim(),
      ...(description ? { description: String(description) } : {}),
    });
  };

  // 1. Standard ACP models.availableModels (supported by Antigravity, Kiro CLI, etc.)
  const available = result.models?.availableModels;
  if (Array.isArray(available)) {
    for (const m of available) {
      if (typeof m === "string") {
        add(m, m);
      } else if (m && typeof m === "object") {
        add(m.modelId || m.id || m.name, m.name || m.displayName || m.modelId || m.id, m.description);
      }
    }
  }

  // 2. ACP configOptions where id/category === "model" (base models, e.g. gemini-3.8-flash)
  if (Array.isArray(result.configOptions)) {
    for (const opt of result.configOptions) {
      if (!opt || (opt.id !== "model" && opt.category !== "model")) continue;
      if (Array.isArray(opt.options)) {
        for (const item of opt.options) {
          if (typeof item === "string") {
            add(item, item);
          } else if (item && typeof item === "object") {
            add(item.value || item.id || item.name, item.name || item.value || item.id, item.description);
          }
        }
      }
    }
  }

  // 3. Fallback: currentModelId if no list was returned
  if (models.length === 0 && result.models?.currentModelId) {
    add(result.models.currentModelId, result.models.currentModelId);
  }

  return models;
}

/**
 * Discover live models from an ACP server via stdio JSON-RPC (initialize -> session/new).
 */
export async function discoverAcpModels({
  command,
  args,
  env: customEnv = {},
  timeoutMs = 15000,
  forceRefresh = false,
} = {}) {
  const pathEnv = buildAcpPathEnv(process.env.PATH || "");
  const resolved = resolveAcpCommand(command, pathEnv);
  const parsedArgs = normalizeArgs(args);
  const cacheKey = `${resolved.command}::${JSON.stringify(parsedArgs)}`;

  if (!forceRefresh) {
    const cached = acpModelsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.models;
    }
  }

  const { env: spawnEnv } = await buildAcpProcessEnv(
    { ...process.env, PATH: pathEnv },
    customEnv || {}
  );

  const discovered = await new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBuf = "";
    let stderrText = "";

    const child = spawn(resolved.command, parsedArgs, {
      env: spawnEnv,
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      // Absolute path already resolved: no shell needed except Windows .cmd/.bat shims.
      shell: resolved.useShell,
    });

    const cleanup = () => {
      clearTimeout(timer);
      try {
        if (!child.stdin.destroyed) child.stdin.end();
      } catch {}
      setTimeout(() => {
        killAcpChild(child);
      }, 200);
    };

    const done = (err, models) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(models);
    };

    const timer = setTimeout(() => {
      done(new Error(`ACP model discovery timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const sendRpc = (id, method, params) => {
      if (child.stdin.destroyed) return;
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch {}
    };

    child.on("error", (err) => {
      done(new Error(`ACP spawn error (${resolved.command}): ${err.message}`));
    });

    child.stderr.on("data", (chunk) => {
      if (stderrText.length < 500) stderrText += chunk.toString("utf8");
    });

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }

        if (msg.id === 1) {
          if (msg.error) {
            done(new Error(`ACP initialize error: ${msg.error.message || JSON.stringify(msg.error)}`));
            return;
          }
          sendRpc(2, "session/new", {
            cwd: process.cwd(),
            mcpServers: [],
          });
          continue;
        }

        if (msg.id === 2) {
          if (msg.error) {
            done(new Error(`ACP session/new error: ${msg.error.message || JSON.stringify(msg.error)}`));
            return;
          }
          const models = extractModelsFromSessionResult(msg.result);
          done(null, models);
          return;
        }
      }
    });

    child.on("close", (code) => {
      if (!settled) {
        done(new Error(`ACP process exited with code ${code}${stderrText ? `: ${stderrText.trim().slice(0, 200)}` : ""}`));
      }
    });

    sendRpc(1, "initialize", {
      protocolVersion: 1,
      clientInfo: { name: "9router", version: "1.0.0" },
    });
  });

  if (discovered.length > 0) {
    acpModelsCache.set(cacheKey, { timestamp: Date.now(), models: discovered });
  }
  return discovered;
}
