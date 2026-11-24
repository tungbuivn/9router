#!/usr/bin/env node
/**
 * Install/update the 9router-sysprompt script into a running Whistle (w2) instance.
 *
 * Usage:
 *   node scripts/w2-plugins/install-w2-script.mjs
 *   node scripts/w2-plugins/install-w2-script.mjs --enable-rule --url http://127.0.0.1:8899
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const enableRule = args.includes("--enable-rule");
const urlIdx = args.indexOf("--url");
const w2Url = (urlIdx >= 0 && args[urlIdx + 1]) || process.env.W2_AUTO_PROXY_URL || "http://127.0.0.1:8899";

function post(targetUrl, contentType, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const buf = Buffer.from(body, "utf8");
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "content-type": contentType,
          "content-length": String(buf.length),
        },
        timeout: 3000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

async function main() {
  const scriptContent = await fs.readFile(path.join(__dirname, "9router-sysprompt.js"), "utf8");
  const ruleContent = await fs.readFile(path.join(__dirname, "rules.txt"), "utf8");

  const r1 = await post(
    `${w2Url}/plugin.script/cgi-bin/create`,
    "application/json",
    JSON.stringify({ name: "9router-sysprompt", value: scriptContent })
  );
  console.log("Installed script '9router-sysprompt':", r1.status, r1.text);

  const form = new URLSearchParams({
    name: "9router-acp-sysprompt",
    value: ruleContent,
    clientId: "9router-cli",
  }).toString();

  const r2 = await post(`${w2Url}/cgi-bin/rules/add`, "application/x-www-form-urlencoded", form);
  console.log("Registered rule group '9router-acp-sysprompt':", r2.status, r2.text);

  if (enableRule) {
    const r3 = await post(`${w2Url}/cgi-bin/rules/select`, "application/x-www-form-urlencoded", form);
    console.log("Enabled rule group '9router-acp-sysprompt':", r3.status, r3.text);
  }

  console.log(`\nEdit script in Whistle UI: ${w2Url}/plugin.script/`);
  console.log(`Manage rules in Whistle UI: ${w2Url}/#rules`);
}

main().catch((err) => {
  console.error("Failed to install w2 script plugin:", err.message);
  process.exit(1);
});
