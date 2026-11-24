import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const IS_WINDOWS = process.platform === "win32";

// CreateProcess only runs `.exe` directly; `.cmd`/`.bat` shims need a shell.
const WINDOWS_EXEC_EXTS = [".exe", ".cmd", ".bat", ".com"];
const WINDOWS_SHELL_EXTS = new Set([".cmd", ".bat"]);

/**
 * Home directory used for ACP binary discovery.
 * `os.homedir()` already honors $HOME on POSIX and %USERPROFILE% on Windows,
 * so a server started without a login shell (tray/daemon/systemd) still works.
 */
export function getAcpHomeDir() {
  return os.homedir() || process.env.HOME || process.env.USERPROFILE || "";
}

/**
 * Directories that commonly hold ACP CLIs (agy, kiro-cli, dsh, …) but are often
 * missing from a detached server's PATH.
 */
export function getAcpBinDirs({ home = getAcpHomeDir() } = {}) {
  const dirs = [];
  if (home) {
    dirs.push(path.join(home, ".gemini", "bin"), path.join(home, ".local", "bin"));
  }
  if (IS_WINDOWS) {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm"));
  } else {
    dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin");
  }
  return dirs;
}

/**
 * PATH value for ACP child processes: extra bin dirs first, then the inherited
 * PATH, deduped and joined with the platform separator (`;` on Windows, `:` elsewhere).
 */
export function buildAcpPathEnv(currentPath = process.env.PATH || "", extraDirs = getAcpBinDirs()) {
  const seen = new Set();
  const out = [];
  for (const raw of [...extraDirs, ...String(currentPath).split(path.delimiter)]) {
    const dir = typeof raw === "string" ? raw.trim() : "";
    if (!dir) continue;
    const key = IS_WINDOWS ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out.join(path.delimiter);
}

function hasPathSeparator(command) {
  return command.includes("/") || command.includes("\\");
}

function withWindowsExtensions(filePath) {
  if (!IS_WINDOWS || path.extname(filePath)) return [filePath];
  return [filePath, ...WINDOWS_EXEC_EXTS.map((ext) => filePath + ext)];
}

function isRunnableFile(filePath) {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return false;
    // Windows has no exec bit; POSIX requires at least one execute bit.
    return IS_WINDOWS || (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Resolve an ACP command to an absolute path when possible.
 * Bare names are looked up in `pathEnv` (with PATHEXT-style suffixes on Windows);
 * unresolved commands are returned unchanged so the caller can still try them.
 */
export function resolveAcpExecutable(command, { pathEnv = buildAcpPathEnv() } = {}) {
  const raw = typeof command === "string" ? command.trim().replace(/^"(.*)"$/, "$1") : "";
  if (!raw) return "";

  if (hasPathSeparator(raw) || path.isAbsolute(raw)) {
    for (const candidate of withWindowsExtensions(raw)) {
      if (isRunnableFile(candidate)) return candidate;
    }
    return raw;
  }

  for (const dir of String(pathEnv || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const candidate of withWindowsExtensions(path.join(dir, raw))) {
      if (isRunnableFile(candidate)) return candidate;
    }
  }
  return raw;
}

/**
 * Resolve a command plus the shell requirement for `child_process.spawn`.
 * Using an absolute path removes the need for `shell: true` (and its argument
 * quoting/injection pitfalls) except for Windows `.cmd`/`.bat` shims.
 */
export function resolveAcpSpawn(command, { pathEnv = buildAcpPathEnv() } = {}) {
  const resolved = resolveAcpExecutable(command, { pathEnv });
  const ext = IS_WINDOWS ? path.extname(resolved).toLowerCase() : "";
  return {
    command: resolved,
    useShell: WINDOWS_SHELL_EXTS.has(ext),
    pathEnv,
  };
}

/**
 * Terminate an ACP child and its descendants.
 * On Windows a plain `child.kill()` leaves grandchildren (shell commands run by
 * the agent) alive, so use `taskkill /T /F`.
 */
export function killAcpChild(child) {
  if (!child || !child.pid) return;
  if (IS_WINDOWS) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).unref?.();
      return;
    } catch {
      /* fall through to child.kill */
    }
  }
  if (child.killed) return;
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}
