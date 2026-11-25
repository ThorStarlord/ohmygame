// Resolves the user's Ren'Py SDK and provides bounded, cancellable CLI execution.
// No shell is used. The SDK remains the authority for script parsing and exports.
import { spawn } from "node:child_process";
import { access, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
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

const MIRROR_EXCLUDES = new Set([
  ".git", ".ohmygame", "build", "node_modules", ".venv", "__pycache__",
  ".pytest_cache", ".ruff_cache", ".tmp", "dist",
]);

const GAME_EXCLUDES = new Set(["saves", "cache"]);

/**
 * Remove a disposable folder without letting a locked file hide the validation
 * result. A warning names the folder that remains so it can be cleaned later.
 */
async function cleanupFolder(folder, label) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rm(folder, { recursive: true, force: true });
      return undefined;
    } catch (error) {
      last = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return `Could not remove the ${label} at ${folder}: ${last instanceof Error ? last.message : String(last)}`;
}

async function requireDirectory(folder, label) {
  const found = await lstat(folder).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!found) throw new Error(`This project has no ${label} to validate: ${folder}`);
  if (found.isSymbolicLink() || !found.isDirectory())
    throw new Error(`Refusing a symbolic-link or non-directory ${label}: ${folder}`);
  return found;
}

function insideOrEqual(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** A root entry only needs skipping on platforms where it aliases game/ or state/. */
function rootResourceKey(name) {
  return process.platform === "win32" || process.platform === "darwin" ? name.toLowerCase() : name;
}

/**
 * A disposable, faithful view of the project for automated validation. Game
 * sources are copied without game/saves or game/cache, and writable root state
 * is copied; other root resources are linked so Ren'Py can resolve
 * root-relative files. The mirror is always used: the player's saves and the
 * original game sources are never moved, and Ren'Py's generated saves stay in
 * the disposable copy.
 */
async function validationMirror(project) {
  const game = path.join(project, "game");
  const state = path.join(project, "state");
  await requireDirectory(game, "game folder");
  const stateFound = await lstat(state).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stateFound && (stateFound.isSymbolicLink() || !stateFound.isDirectory()))
    throw new Error("Refusing a symbolic-link or non-directory state folder: " + state);
  const savesReal = await realpath(path.join(game, "saves")).catch(() => undefined);
  const cacheReal = await realpath(path.join(game, "cache")).catch(() => undefined);
  const stateReal = await realpath(state).catch(() => undefined);
  const overlaps = (left, right) => Boolean(left && right && (insideOrEqual(left, right) || insideOrEqual(right, left)));
  const playerDataAlias = (real) => overlaps(real, savesReal) || overlaps(real, cacheReal);
  const stateAlias = (real) => overlaps(real, stateReal);
  const root = await mkdtemp(path.join(tmpdir(), "ohmygame-renpy-project-"));
  const link = process.platform === "win32" ? "junction" : "dir";
  try {
    // Copy the game tree by hand: a link that resolves into game/saves, or into
    // an ancestor that contains it, is skipped rather than copied. The
    // ancestor set stops a link back to game/ from recursing without hiding a
    // second, legitimate link to the same folder.
    const copyGame = async (source, target, ancestors) => {
      const sourceReal = await realpath(source).catch(() => source);
      if (ancestors.has(sourceReal)) return;
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(sourceReal);
      await mkdir(target, { recursive: true });
      for (const entry of await readdir(source, { withFileTypes: true })) {
        if (GAME_EXCLUDES.has(entry.name.toLowerCase())) continue;
        const from = path.join(source, entry.name);
        const to = path.join(target, entry.name);
        const info = await lstat(from);
        if (info.isSymbolicLink()) {
          const real = await realpath(from).catch(() => undefined);
          if (!real || playerDataAlias(real)) continue;
          const linked = await stat(real).catch(() => undefined);
          if (linked?.isDirectory()) await copyGame(real, to, nextAncestors);
          else if (linked?.isFile()) await cp(real, to, { force: true });
          continue;
        }
        if (info.isDirectory()) {
          await copyGame(from, to, nextAncestors);
          continue;
        }
        if (info.isFile()) await cp(from, to, { force: true });
      }
    };
    await copyGame(game, path.join(root, "game"), new Set());
    if (stateFound)
      await cp(state, path.join(root, "state"), { recursive: true, force: true, dereference: true });
    for (const entry of await readdir(project, { withFileTypes: true })) {
      const name = entry.name;
      const key = rootResourceKey(name);
      if (key === "game" || key === "state" || MIRROR_EXCLUDES.has(name.toLowerCase())) continue;
      const source = path.join(project, name);
      const target = path.join(root, name);
      const real = await realpath(source).catch(() => undefined);
      if (!real || playerDataAlias(real) || stateAlias(real)) continue;
      const info = await stat(real);
      if (!info.isDirectory()) {
        await cp(real, target, { force: true });
        continue;
      }
      try {
        await symlink(real, target, link);
      } catch {
        // A host that cannot link still gets a faithful, if larger, copy.
        await cp(real, target, { recursive: true, force: true, dereference: true });
      }
    }
  } catch (error) {
    const warning = await cleanupFolder(root, "incomplete validation copy");
    const suffix = warning ? ` (${warning})` : "";
    throw new Error("Could not make a disposable validation copy: " + (error instanceof Error ? error.message : String(error)) + suffix);
  }
  return { project: root, cleanup: () => cleanupFolder(root, "disposable validation copy") };
}

/**
 * Copy compiled scripts from a successful mirror compile back into the real
 * project. Compile is the one automated operation whose artifact is part of
 * its contract; lint and tests stay read-only. Saves, cache and new orphan
 * files are not promoted.
 */
async function promoteCompiledScripts(mirror, project, signal) {
  const sourceRoot = path.join(mirror, "game");
  const targetRoot = path.join(project, "game");
  if (signal?.aborted) throw new Error("Ren'Py command cancelled");
  const realTargetRoot = await realpath(targetRoot);
  const plan = [];
  const checkTarget = async (to) => {
    const resolved = path.resolve(to);
    const inside = path.relative(realTargetRoot, resolved);
    if (inside.startsWith("..") || path.isAbsolute(inside))
      throw new Error("Refusing to write a compiled script outside the game folder: " + to);
    // Find the nearest existing ancestor and resolve it. A missing directory
    // under a link outside game/ is rejected before mkdir can create anything.
    let ancestor = path.dirname(resolved);
    for (;;) {
      const info = await lstat(ancestor).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (info) {
        const real = await realpath(ancestor);
        if (!insideOrEqual(realTargetRoot, real))
          throw new Error("Refusing to write a compiled script outside the game folder: " + to);
        break;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor)
        throw new Error("Refusing to write a compiled script outside the game folder: " + to);
      ancestor = parent;
    }
    const existing = await lstat(resolved).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing?.isSymbolicLink())
      throw new Error("Refusing to replace a symbolic-link compiled script: " + to);
    if (existing && !existing.isFile())
      throw new Error("Refusing to replace a non-file compiled script target: " + to);
  };
  async function collect(directory, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (signal?.aborted) throw new Error("Ren'Py command cancelled");
      const next = relative ? path.join(relative, entry.name) : entry.name;
      const from = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (GAME_EXCLUDES.has(entry.name.toLowerCase())) continue;
        await collect(from, next);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".rpyc")) continue;
      const to = path.join(targetRoot, next);
      const current = await readFile(from);
      await checkTarget(to);
      const old = await readFile(to).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (old?.equals(current)) continue;
      plan.push({ from, to, old });
    }
  }
  await collect(sourceRoot);
  if (signal?.aborted) throw new Error("Ren'Py command cancelled");
  const written = [];
  try {
    for (const { from, to, old } of plan) {
      await mkdir(path.dirname(to), { recursive: true });
      await cp(from, to, { force: true });
      written.push({ to, old });
    }
  } catch (error) {
    // Best-effort rollback: a failed promotion must not leave a mixed set.
    for (const { to, old } of written.reverse()) {
      try {
        if (old === undefined) await rm(to, { force: true });
        else await writeFile(to, old);
      } catch {
        // The original promotion error remains the useful one.
      }
    }
    throw error;
  }
  return plan.length;
}

/**
 * A throwaway savedir and redirected save-like state for a run inside the
 * disposable mirror.
 */
async function validationIsolation() {
  const savedir = await mkdtemp(path.join(tmpdir(), "ohmygame-renpy-validation-"));
  let savesBase;
  let multipersistentBase;
  try {
    savesBase = await mkdtemp(path.join(tmpdir(), "ohmygame-renpy-validation-saves-"));
    multipersistentBase = await mkdtemp(path.join(tmpdir(), "ohmygame-renpy-validation-multi-"));
  } catch (error) {
    await cleanupFolder(savedir, "temporary save directory");
    if (savesBase) await cleanupFolder(savesBase, "temporary save directory");
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
      const warnings = [];
      for (const [target, label] of [
        [savedir, "temporary save directory"],
        [savesBase, "temporary save directory"],
        [multipersistentBase, "temporary multipersistent directory"],
      ]) {
        const warning = await cleanupFolder(target, label);
        if (warning) warnings.push(warning);
      }
      return warnings.join("; ") || undefined;
    },
  };
}

/**
 * Runs an SDK task inside a disposable project mirror. Ren'Py loads and can
 * rewrite persistent data even for lint and compile; the mirror keeps that
 * away from the player's saves and from the live game sources. Compile
 * artifacts are promoted back because compile promises .rpyc files.
 */
export async function runWithIsolatedSaves(command, project, args, options = {}) {
  const mirror = await validationMirror(project);
  const warnings = [];
  let result;
  let failure;
  let isolation;
  try {
    isolation = await validationIsolation();
    result = await runRenpy(command, ["--savedir", isolation.savedir, mirror.project, ...args], {
      ...options,
      cwd: mirror.project,
      env: { ...options.env, ...isolation.env },
    });
    if (args[0] === "compile" && result.exitCode === 0)
      result = { ...result, compiledArtifacts: await promoteCompiledScripts(mirror.project, project, options.signal) };
  } catch (error) {
    failure = error;
  } finally {
    if (isolation) {
      const warning = await isolation.cleanup();
      if (warning) warnings.push(warning);
    }
    const warning = await mirror.cleanup();
    if (warning) warnings.push(warning);
  }
  if (failure) {
    if (warnings.length && failure instanceof Error) failure.message += " (cleanup warning: " + warnings.join("; ") + ")";
    throw failure;
  }
  return {
    ...result,
    validationCopy: true,
    ...(warnings.length ? { cleanupWarning: warnings.join("; ") } : {}),
  };
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
  // The launcher builds from a disposable mirror, so it cannot read or rewrite
  // the player's real saves. Only the completed web output is promoted into
  // the project's build folder.
  const mirror = await validationMirror(project);
  const warnings = [];
  const backup = path.join(buildRoot, "renpy-web-old-" + randomUUID());
  let isolation;
  let staging;
  let movedOld = false;
  let result;
  let failure;
  try {
    isolation = await validationIsolation();
    staging = await mkdtemp(path.join(buildRoot, "renpy-web-"));
    const execute = options.execute ?? runRenpy;
    // The launcher starts the project in its own process, which ignores the
    // parent's --savedir. RENPY_PATH_TO_SAVES is inherited and keeps the
    // build from reading or rewriting the player's saves and unlocks; the
    // mirror keeps the launcher's generated files out of the project.
    result = await execute(command, ["--savedir", isolation.savedir, "launcher", "web_build", mirror.project, "--destination", staging], {
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
      const warning = await cleanupFolder(backup, "previous web build backup");
      if (warning) warnings.push(warning);
      movedOld = false;
    }
  } catch (error) {
    failure = error;
  } finally {
    if (staging) {
      const warning = await cleanupFolder(staging, "web export staging folder");
      if (warning) warnings.push(warning);
    }
    if (isolation) {
      const warning = await isolation.cleanup();
      if (warning) warnings.push(warning);
    }
    const warning = await mirror.cleanup();
    if (warning) warnings.push(warning);
    // If promotion failed before it could complete, do not delete a backup.
  }
  if (failure) {
    if (warnings.length && failure instanceof Error) failure.message += " (cleanup warning: " + warnings.join("; ") + ")";
    throw failure;
  }
  return {
    ...result,
    validationCopy: true,
    ...(warnings.length ? { cleanupWarning: warnings.join("; ") } : {}),
  };
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
