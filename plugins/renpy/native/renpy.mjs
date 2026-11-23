// Resolves the user's Ren'Py SDK and provides bounded, cancellable CLI execution.
// No shell is used. The SDK remains the authority for script parsing and exports.
import { spawn } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const MAX_OUTPUT = 40_000;
const DEFAULT_TIMEOUT = 120_000;

function envValue(env, key) {
  const found = Object.keys(env).find((name) => name.toUpperCase() === key);
  return found ? env[found] : undefined;
}

async function isFile(file, platform) {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function sdkAt(folder, platform) {
  const script = path.join(folder, "renpy.py");
  if (!(await isFile(script, "win32"))) return undefined;
  if (platform === "win32") {
    for (const architecture of ["py3-windows-x86_64", "py3-windows-arm64"]) {
      const executable = path.join(folder, "lib", architecture, "python.exe");
      if (await isFile(executable, platform))
        return { sdkPath: folder, executable, prefixArgs: [script] };
    }
    return undefined;
  }
  const executable = path.join(folder, "renpy.sh");
  return await isFile(executable, platform)
    ? { sdkPath: folder, executable, prefixArgs: [] }
    : undefined;
}

async function candidateAt(candidate, platform) {
  const value = candidate?.trim();
  if (!value) return undefined;
  const full = path.resolve(value);
  const found = await stat(full).catch(() => undefined);
  if (found?.isDirectory()) return sdkAt(full, platform);
  if (!found?.isFile()) return undefined;
  const base = path.basename(full).toLowerCase();
  if (base === "renpy.sh" && platform !== "win32" && await isFile(full, platform))
    return sdkAt(path.dirname(full), platform);
  if (base === "renpy.py") return sdkAt(path.dirname(full), platform);
  if (base === "python.exe" && platform === "win32") {
    const lib = path.dirname(path.dirname(full));
    if (path.basename(lib).toLowerCase() === "lib") return sdkAt(path.dirname(lib), platform);
  }
  return undefined;
}

/** SDK setting first, then environment SDK folders and candidates on PATH. */
export async function resolveRenpy(setting, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const candidates = [
    setting,
    envValue(env, "RENPY_SDK_PATH"),
    envValue(env, "RENPY_HOME"),
    ...((envValue(env, "PATH") ?? "").split(path.delimiter).filter(Boolean)),
  ];
  const seen = new Set();
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const full = path.resolve(candidate);
    if (seen.has(full)) continue;
    seen.add(full);
    const found = await candidateAt(full, platform);
    if (found) return found;
  }
  return undefined;
}

export function renpyErrors(output) {
  return output.split(/\r?\n/)
    .filter((line) => /^\s*(?:error|exception|traceback|file ".*", line \d+|I'm sorry)/i.test(line))
    .map((line) => line.trim()).slice(0, 50);
}

/** Execute an SDK CLI task; cancellation and timeout are distinguished from CLI failures. */
export function runRenpy(command, args, options = {}) {
  const { cwd, signal, timeoutMs = DEFAULT_TIMEOUT, progress } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Ren'Py command cancelled"));
    const child = spawn(command.executable, [...command.prefixArgs, ...args], {
      cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timeout = false;
    let settled = false;
    const append = (chunk) => {
      const part = chunk.toString("utf8");
      output = (output + part).slice(-MAX_OUTPUT);
      const last = part.trim().split(/\r?\n/).at(-1);
      if (last) progress?.(last);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const stop = () => child.kill();
    const timer = setTimeout(() => { timeout = true; stop(); }, timeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (error) reject(error);
      else resolve(result);
    };
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => finish(error));
    child.on("close", (exitCode) => {
      if (signal?.aborted) return finish(new Error("Ren'Py command cancelled"));
      if (timeout) return finish(new Error("Ren'Py command timed out"));
      finish(undefined, { exitCode, output, errors: renpyErrors(output) });
    });
  });
}

async function safeDirectory(dir) {
  const existing = await lstat(dir).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory())
      throw new Error("Refusing a non-directory or symbolic-link build path: " + dir);
  } else {
    await mkdir(dir);
  }
}

/**
 * Export to a staging directory, then atomically make the completed build visible.
 * A failed export preserves the last working preview. No project sources are deleted.
 * The execute option is injected only for isolated tests.
 */
export async function exportWeb(project, command, options = {}) {
  const buildRoot = path.join(project, ".ohmygame", "build");
  await safeDirectory(path.join(project, ".ohmygame"));
  await safeDirectory(buildRoot);
  const destination = path.join(buildRoot, "web");
  const existing = await lstat(destination).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory()))
    throw new Error("Refusing an unsafe existing web build path");
  const staging = await mkdtemp(path.join(buildRoot, "renpy-web-"));
  const backup = path.join(buildRoot, "renpy-web-old-" + randomUUID());
  let movedOld = false;
  try {
    const execute = options.execute ?? runRenpy;
    const result = await execute(command, ["launcher", "web_build", project, "--destination", staging], {
      cwd: command.sdkPath, signal: options.signal, progress: options.progress, timeoutMs: 600_000,
    });
    if (result.exitCode !== 0)
      throw new Error("Ren'Py web export failed (exit " + result.exitCode + "): " + (result.errors.join("\n") || result.output.slice(-3000)));
    const entry = await lstat(path.join(staging, "index.html")).catch(() => undefined);
    if (!entry?.isFile() || entry.isSymbolicLink())
      throw new Error("Ren'Py web export produced no safe index.html; verify Web support in the SDK");
    if (existing) {
      await rename(destination, backup);
      movedOld = true;
    }
    try {
      await rename(staging, destination);
    } catch (error) {
      if (movedOld) await rename(backup, destination);
      movedOld = false;
      throw error;
    }
    if (movedOld) {
      await rm(backup, { recursive: true, force: true });
      movedOld = false;
    }
    return result;
  } finally {
    await rm(staging, { recursive: true, force: true });
    // If promotion failed before it could complete, do not delete a backup.
  }
}

export function launchRenpy(command, project, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Ren'Py launch cancelled"));
    const child = spawn(command.executable, [...command.prefixArgs, project, "run"], {
      cwd: command.sdkPath, stdio: "ignore", windowsHide: false,
    });
    const stop = () => { if (child.exitCode === null) child.kill(); };
    signal?.addEventListener("abort", stop, { once: true });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", stop);
      reject(error);
    });
    child.once("spawn", () => {
      if (signal?.aborted) { stop(); reject(new Error("Ren'Py launch cancelled")); return; }
      resolve(child);
    });
    child.once("close", () => signal?.removeEventListener("abort", stop));
  });
}
