import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAcpPathEnv,
  getAcpBinDirs,
  getAcpHomeDir,
  resolveAcpExecutable,
  resolveAcpSpawn,
} from "../../open-sse/utils/acpRuntime.js";
import {
  ACP_EMPTY_TURN_NOTICE,
  buildAcpClientReply,
  pickAcpPermissionOption,
} from "../../open-sse/executors/acp.js";

const IS_WINDOWS = process.platform === "win32";

describe("ACP runtime paths (Windows + Linux)", () => {
  let tmpDir;
  let binName;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-runtime-"));
    binName = IS_WINDOWS ? "fake-acp.exe" : "fake-acp";
    const binPath = path.join(tmpDir, binName);
    fs.writeFileSync(binPath, IS_WINDOWS ? "" : "#!/bin/sh\nexit 0\n");
    if (!IS_WINDOWS) fs.chmodSync(binPath, 0o755);
    // A non-executable file must never be picked up on POSIX.
    fs.writeFileSync(path.join(tmpDir, "not-exec-acp"), "x");
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("uses the platform PATH separator and puts the ACP bin dirs first", () => {
    const out = buildAcpPathEnv(`/existing/bin${path.delimiter}/usr/bin`, ["/custom/acp"]);
    expect(out.split(path.delimiter)[0]).toBe("/custom/acp");
    expect(out.split(path.delimiter)).toContain("/existing/bin");
    expect(out.split(path.delimiter)).toContain("/usr/bin");
  });

  it("dedupes dirs (case-insensitively on Windows)", () => {
    const dup = path.join(tmpDir, "bin");
    const out = buildAcpPathEnv(`${dup}${path.delimiter}${dup}`, [dup]);
    expect(out.split(path.delimiter).filter(Boolean)).toHaveLength(1);
  });

  it("derives the home dir from os.homedir() instead of $HOME only", () => {
    expect(getAcpHomeDir()).toBe(os.homedir());
  });

  it("includes ~/.gemini/bin and ~/.local/bin on every platform", () => {
    const dirs = getAcpBinDirs({ home: "/home/test" });
    expect(dirs).toContain(path.join("/home/test", ".gemini", "bin"));
    expect(dirs).toContain(path.join("/home/test", ".local", "bin"));
  });

  it("resolves a bare command through the supplied PATH", () => {
    const resolved = resolveAcpExecutable("fake-acp", { pathEnv: tmpDir });
    expect(resolved).toBe(path.join(tmpDir, binName));
  });

  it("does not resolve a non-executable file on POSIX", () => {
    if (IS_WINDOWS) return;
    expect(resolveAcpExecutable("not-exec-acp", { pathEnv: tmpDir })).toBe("not-exec-acp");
  });

  it("resolves absolute paths with platform-specific extensions", () => {
    const abs = path.join(tmpDir, "fake-acp");
    const resolved = resolveAcpExecutable(abs, { pathEnv: "" });
    expect(resolved).toBe(path.join(tmpDir, binName));
  });

  it("leaves unknown commands untouched so spawn can still try them", () => {
    expect(resolveAcpExecutable("definitely-not-installed-acp", { pathEnv: tmpDir }))
      .toBe("definitely-not-installed-acp");
  });

  it("only asks for a shell for Windows .cmd/.bat shims", () => {
    const exe = resolveAcpSpawn("fake-acp", { pathEnv: tmpDir });
    expect(exe.command).toBe(path.join(tmpDir, binName));
    expect(exe.useShell).toBe(false);
  });
});

describe("ACP server→client replies", () => {
  const permissionMsg = (options) => ({
    jsonrpc: "2.0",
    id: "1",
    method: "session/request_permission",
    params: {
      sessionId: "s",
      toolCall: { toolCallId: "c", name: "run_command" },
      options,
    },
  });

  it("answers request_permission with the ACP outcome object, not { outcome: 'accept' }", () => {
    const reply = buildAcpClientReply(
      permissionMsg([
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ])
    );
    expect(reply).toEqual({ result: { outcome: { outcome: "selected", optionId: "allow" } } });
  });

  it("prefers allow_once over allow_always", () => {
    const reply = buildAcpClientReply(
      permissionMsg([
        { optionId: "always", name: "Always", kind: "allow_always" },
        { optionId: "once", name: "Once", kind: "allow_once" },
      ])
    );
    expect(reply.result.outcome.optionId).toBe("once");
  });

  it("honours ACP_PERMISSION_MODE=deny", () => {
    const reply = buildAcpClientReply(
      permissionMsg([
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ]),
      { permissionMode: "deny" }
    );
    expect(reply.result.outcome).toEqual({ outcome: "selected", optionId: "deny" });
  });

  it("cancels when the agent offers no options", () => {
    const reply = buildAcpClientReply(permissionMsg([]));
    expect(reply).toEqual({ result: { outcome: { outcome: "cancelled" } } });
  });

  it("falls back to the first non-deny option when kinds are missing", () => {
    expect(pickAcpPermissionOption([{ optionId: "ok", name: "OK" }])).toBe("ok");
    expect(pickAcpPermissionOption([{ optionId: "no", name: "No" }], { prefer: "allow" })).toBeNull();
    expect(pickAcpPermissionOption(undefined)).toBeNull();
  });

  it("answers unsupported client requests with -32601 instead of a bogus outcome", () => {
    const reply = buildAcpClientReply({
      jsonrpc: "2.0",
      id: 7,
      method: "fs/read_text_file",
      params: { path: "/etc/passwd" },
    });
    expect(reply.error.code).toBe(-32601);
    expect(reply.result).toBeUndefined();
  });

  it("exposes a non-empty notice for turns with no text", () => {
    expect(ACP_EMPTY_TURN_NOTICE.length).toBeGreaterThan(10);
  });
});
