import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";

export const dynamic = "force-dynamic";

function getCandidateZedSettingsPaths() {
  const home = os.homedir();
  const paths = [
    path.join(home, ".config", "zed", "settings.json"),
    // Zed installed as a Flatpak on Linux
    path.join(home, ".var", "app", "dev.zed.Zed", "config", "zed", "settings.json"),
    path.join(home, "Library", "Application Support", "Zed", "settings.json"),
  ];
  if (process.env.APPDATA) {
    paths.push(path.join(process.env.APPDATA, "Zed", "settings.json"));
  }
  return paths;
}

function parseJsonc(text) {
  const stripped = text
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, g1) => g1 || "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped);
}

function suggestPrefix(name) {
  const lower = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (lower.includes("antigravity")) return "acp-agy";
  if (lower.includes("deepseek")) return "acp-dsh";
  if (lower.includes("claude")) return "acp-claude";
  if (lower.includes("kiro")) return "acp-kiro";
  if (lower.includes("devin")) return "acp-devin";
  return `acp-${lower.slice(0, 6) || "srv"}`;
}

export async function GET() {
  try {
    const candidates = getCandidateZedSettingsPaths();
    let zedConfigPath = null;
    let content = null;

    for (const cand of candidates) {
      try {
        content = await fs.readFile(cand, "utf-8");
        zedConfigPath = cand;
        break;
      } catch {
        // try next candidate
      }
    }

    if (!zedConfigPath || !content) {
      return NextResponse.json({
        found: false,
        servers: [],
        message: "No Zed settings.json found on this machine",
      });
    }

    let parsedData = {};
    try {
      parsedData = parseJsonc(content);
    } catch (e) {
      return NextResponse.json({
        found: true,
        path: zedConfigPath,
        servers: [],
        error: `Failed to parse Zed settings JSONC: ${e.message}`,
      });
    }

    const agentServers = parsedData.agent_servers || {};
    const servers = Object.entries(agentServers).map(([key, config]) => {
      const cfg = config && typeof config === "object" ? config : {};
      const defaultModel = cfg.default_config_options?.model || cfg.model || "";
      return {
        id: key,
        name: key,
        type: cfg.type || "custom",
        command: cfg.command || "",
        args: Array.isArray(cfg.args) ? cfg.args : [],
        env: cfg.env && typeof cfg.env === "object" ? cfg.env : {},
        defaultConfigOptions: cfg.default_config_options || {},
        defaultModel,
        suggestedPrefix: suggestPrefix(key),
      };
    });

    return NextResponse.json({
      found: true,
      path: zedConfigPath,
      servers,
    });
  } catch (error) {
    console.log("Error loading Zed agent servers:", error);
    return NextResponse.json(
      { error: "Failed to read Zed agent servers" },
      { status: 500 }
    );
  }
}
