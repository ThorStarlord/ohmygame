// Resolves the user's Ren'Py SDK and provides bounded, cancellable CLI execution.
// No shell is used. The SDK remains the authority for script parsing and exports.
import { spawn } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
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

const VALIDATION_BACKUPS = "I take responsibility for this.";

/**
 * Ren'Py always adds <project>/game/saves as an active save location. For a
 * portable project that folder is the real player namespace; --savedir and
 * RENPY_PATH_TO_SAVES do not redirect it. Refuse existing player data there,
 * and remove whatever an automated run creates when it was absent or empty.
 */
async function projectSaves(project) {
  const folder = path.join(project, "game", "saves");
  const found = await lstat(folder).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!found) return { folder, existed: false };
  if (found.isSymbolicLink() || !found.isDirectory())
    throw new Error("Refusing a non-directory or symbolic-link game/saves folder: " + folder);
  if ((await readdir(folder)).length)
    throw new Error(
      "This Ren'Py project keeps player data in game/saves, which --savedir cannot isolate. " +
      "Move that folder aside or set config.save_directory before running an automated Ren'Py operation.",
    );
  return { folder, existed: true };
}

async function removeProjectSaves(state) {
  if (!state.existed) {
    await rm(state.folder, { recursive: true, force: true });
    return;
  }
  for (const entry of await readdir(state.folder))
    await rm(path.join(state.folder, entry), { recursive: true, force: true });
}

/**
 * A throwaway savedir and redirected save-like state. The project's own
 * game/saves is checked before the run and cleaned after it.
 */
async function validationIsolation(project) {
  const projectSavesState = await projectSaves(project);
  const savedir = await mkdtemp(path.join(tmpdir(), "ohmygame-renpy-validation-"));
  let savesBase;
  let multipersistentBase;
  try {
    savesBase = await mkdtemp(path.join(tmpdir(), "ohmygame-renpy-validation-saves-"));
    multipersistentBase = await mkdtemp(path.join(tmpdir(), "ohmygame-renpy-validation-multi-"));
  } catch (error) {
    await rm(savedir, { recursive: true, force: true });
    if (savesBase) await rm(savesBase, { recursive: true, force: true });
    throw error;
  }
  return {
    savedir,
    env: {
      RENPY_PATH_TO_SAVES: savesBase,
      RENPY_MULTIPERSISTENT: path.join(multipersistentBase, "multipersistent"),
      RENPY_DISABLE_BACKUPS: VALIDATION_BACKUPS,
    },
    async cleanup() {
      await removeProjectSaves(projectSavesState).catch(() => {});
      await Promise.all([
        rm(savedir, { recursive: true, force: true }),
        rm(savesBase, { recursive: true, force: true }),
        rm(multipersistentBase, { recursive: true, force: true }),
      ]);
    },
  };
}

/**
 * Runs a read-only SDK task against a throwaway save directory. Ren'Py loads
 * and can rewrite persistent data even for lint and compile; without this a
 * check would touch the player's real saves and unlocks.
 */
export async function runWithIsolatedSaves(command, project, args, options = {}) {
  const isolation = await validationIsolation(project);
  try {
    return await runRenpy(command, ["--savedir", isolation.savedir, project, ...args], {
      ...options,
      env: { ...options.env, ...isolation.env },
    });
  } finally {
    await isolation.cleanup();
  }
}

/** Execute an SDK CLI task; cancellation and timeout are distinguished from CLI failures. */
export function runRenpy(command, args, options = {}) {
  const { cwd, signal, timeoutMs = DEFAULT_TIMEOUT, progress, env } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Ren'Py command cancelled"));
    const child = spawn(command.executable, [...command.prefixArgs, ...args], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(env ? { env: { ...process.env, ...env } } : {}),
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
  // Checked before the build starts, so a project with real game/saves
  // player data fails before the launcher can touch it.
  const isolation = await validationIsolation(project);
  const backup = path.join(buildRoot, "renpy-web-old-" + randomUUID());
  let staging;
  let movedOld = false;
  try {
    staging = await mkdtemp(path.join(buildRoot, "renpy-web-"));
    const execute = options.execute ?? runRenpy;
    // The launcher starts the project in its own process, which ignores the
    // parent's --savedir. RENPY_PATH_TO_SAVES is inherited and keeps the
    // build from reading or rewriting the player's saves and unlocks; the
    // preflight guard covers portable projects, where Ren'Py ignores it.
    const result = await execute(command, ["--savedir", isolation.savedir, "launcher", "web_build", project, "--destination", staging], {
      cwd: command.sdkPath,
      signal: options.signal,
      progress: options.progress,
      timeoutMs: 600_000,
      env: { ...options.env, ...isolation.env },
    });
    if (result.exitCode !== 0)
      throw new Error("Ren'Py web export failed (exit " + result.exitCode + "): " + (result.errors.join("\n") || result.output.slice(-3000)));
    // Ren'Py may place a named web directory alongside an archive.
    // The destination parameter does not always name the serving root.
    const validIndex = async (directory) => {
      const entry = await lstat(path.join(directory, "index.html")).catch(() => undefined);
      return Boolean(entry?.isFile() && !entry.isSymbolicLink());
    };
    let playable = staging;
    if (!(await validIndex(staging))) {
      const candidates = [];
      for (const child of await readdir(staging, { withFileTypes: true })) {
        if (!child.isDirectory() || child.isSymbolicLink()) continue;
        const directory = path.join(staging, child.name);
        if (await validIndex(directory)) candidates.push(directory);
      }
      if (candidates.length !== 1)
        throw new Error("Ren'Py web export produced no unambiguous playable index.html; verify Web support in the SDK");
      playable = candidates[0];
    }
    if (existing) {
      await rename(destination, backup);
      movedOld = true;
    }
    try {
      await rename(playable, destination);
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
    if (staging) await rm(staging, { recursive: true, force: true });
    await isolation.cleanup();
    // If promotion failed before it could complete, do not delete a backup.
  }
}

/** What the managed host session should run for `project run`. */
export function renpyLaunch(command, project) {
  return {
    executable: command.executable,
    args: [...command.prefixArgs, project, "run"],
    cwd: command.sdkPath,
    label: "Ren'Py",
  };
}
