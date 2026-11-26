// Engine-native Ren'Py scenario discovery and checkpoint execution.
//
// The engine remains the authority for testcase selection, gameplay, assertions
// and screenshots. This module only prepares a disposable project, redirects
// screenshot output into it, collects the resulting files and keeps a bounded
// staging copy for the app. No project screenshots or saves are written.
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { renpyDiagnostics } from "./diagnostics.mjs";
import {
  insideOrEqual,
  renpyErrors,
  runRenpy,
  validationIsolation,
  validationMirror,
} from "./renpy.mjs";

const SCENARIO_TIMEOUT_MS = 300_000;
const MAX_SCENARIOS = 200;
const MAX_CHECKPOINTS = 32;
const MAX_CHECKPOINT_FILES = MAX_CHECKPOINTS + 8;
const MAX_CHECKPOINT_BYTES = 12 * 1024 * 1024;
const MAX_CHECKPOINT_PIXELS = 16_000_000;
const MAX_RUN_BYTES = 96 * 1024 * 1024;
const MAX_BASELINE_FILES = 512;
const MAX_BASELINE_BYTES = 128 * 1024 * 1024;
const MAX_WARNINGS = 12;
const MAX_WARNING_LENGTH = 300;
const MAX_RELATIVE_PATH = 300;
const STAGED_RUNS = 8;
const RUN_ID = /^[a-z0-9]{8,40}$/;
const TESTCASE = /^[A-Za-z_][A-Za-z0-9_.]{0,199}$/;
const PNG_SIGNATURE = "89504e470d0a1a0a";

const scenarioStatuses = new Set([
  "passed", "failed", "skipped", "timed-out", "cancelled", "not-found", "invocation-error", "unknown",
]);

function warning(value) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > MAX_WARNING_LENGTH ? `${text.slice(0, MAX_WARNING_LENGTH)}…` : text;
}

function validTestcase(value) {
  if (typeof value !== "string" || !TESTCASE.test(value))
    throw new Error("A scenario must be an engine testcase name containing only letters, digits, underscores and dots.");
  return value;
}

function validRunId(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !RUN_ID.test(value))
    throw new Error("A scenario run ID must contain only lowercase letters and digits.");
  return value;
}

function validBaselineDirectory(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 300)
    throw new Error("A baseline folder must be a project-relative path.");
  const text = value.replaceAll("\\", "/").replace(/\/+$/, "");
  if (text === "." || text.startsWith("/") || /^[A-Za-z]:/.test(text) || text.includes("\0"))
    throw new Error("A baseline folder must stay inside the project.");
  if (text.split("/").some((part) => !part || part === "." || part === ".." || /[\u0000-\u001f]/.test(part)))
    throw new Error("A baseline folder must not contain empty, parent or control path segments.");
  return text;
}

function validDriveError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

async function existingDirectory(folder, label) {
  const found = await lstat(folder).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!found) return undefined;
  if (found.isSymbolicLink() || !found.isDirectory())
    throw new Error(`Refusing a symbolic-link or non-directory ${label}: ${folder}`);
  return found;
}

async function safeStagingRoot(project, runId) {
  const projectRoot = await realpath(project);
  let root = projectRoot;
  for (const name of [".ohmygame", "scenario-runs"]) {
    const found = await existingDirectory(path.join(root, name), name === ".ohmygame" ? "app data folder" : "scenario runs folder");
    root = path.join(root, name);
    if (!found) {
      await mkdir(root);
      const after = await lstat(root);
      if (after.isSymbolicLink() || !after.isDirectory())
        throw new Error(`Refusing a symbolic-link or non-directory scenario runs folder: ${root}`);
    }
  }
  const runRoot = path.join(root, runId);
  if (!insideOrEqual(root, runRoot)) throw new Error("Refusing a scenario run outside the project's app data folder.");
  await lstat(runRoot).then(
    () => { throw new Error("That scenario run ID is already in use in this project."); },
    (error) => { if (error.code !== "ENOENT") throw error; },
  );
  await mkdir(runRoot);
  await mkdir(path.join(runRoot, "checkpoints"));
  return { root: runRoot, checkpoints: path.join(runRoot, "checkpoints") };
}

async function writeManifest(root, manifest) {
  await writeFile(path.join(root, "run.json"), JSON.stringify(manifest, null, 2), "utf8");
}

function writeSetupFile(project, runId) {
  const directory = `game/.ohmygame-scenario/${runId}/screenshots`;
  // The engine normally joins basedir + _test.screenshot_directory + a test
  // filename. A filename containing `..` can escape that directory and, through
  // a linked root resource, reach canonical files. The guard below resolves the
  // real path of every screenshot statement and refuses anything outside the
  // controlled run folder. Project Python still has the user's authority and is
  // not a filesystem sandbox; this protects the screenshot contract.
  const source = [
    "init 999 python:",
    `    _test.screenshot_directory = ${JSON.stringify(directory)}`,
    "    _test.vc_revision = \"\"",
    "    import os",
    "    from renpy.test import testast",
    `    _scenario_screenshot_root = os.path.normcase(os.path.realpath(os.path.join(config.basedir, ${JSON.stringify(directory)})))`,
    "    _scenario_original_screenshot_start = testast.Screenshot.start",
    "    def _scenario_safe_screenshot_start(self, _root=_scenario_screenshot_root, _original=_scenario_original_screenshot_start, _normcase=os.path.normcase, _realpath=os.path.realpath, _sep=os.sep):",
    "        filename = _original(self)",
    "        resolved = _normcase(_realpath(filename))",
    "        if not (resolved == _root or resolved.startswith(_root + _sep)):",
    "            raise ValueError(\"Scenario screenshot path escapes the controlled checkpoint directory: \" + filename)",
    "        return filename",
    "    testast.Screenshot.start = _scenario_safe_screenshot_start",
    "",
  ].join("\n");
  return writeFile(path.join(project, "game", `zz_ohmygame_scenario_${runId}.rpy`), source, "utf8");
}

function discoverySource(name, runId) {
  return [
    `testcase ${name}:`,
    "    python:",
    "        import json",
    "        import os",
    "        import renpy",
    "        from renpy.test import testexecution",
    "        basedir = renpy.config.basedir",
    "        details = []",
    "        for case_name in sorted(testexecution.testcases.keys()):",
    "            node = testexecution.testcases[case_name]",
    "            reported = getattr(node, \"filename\", None)",
    "            if reported:",
    "                try:",
    "                    reported = os.path.relpath(reported, basedir).replace(os.sep, \"/\")",
    "                except Exception:",
    "                    reported = None",
    "                if reported and (reported == \"..\" or reported.startswith(\"../\")):",
    "                    reported = None",
    "            details.append({",
    "                \"name\": case_name,",
    "                \"kind\": \"testsuite\" if type(node).__name__ == \"TestSuite\" else \"testcase\",",
    "                \"file\": reported,",
    "                \"line\": getattr(node, \"linenumber\", None),",
    "                \"parameterized\": bool(getattr(node, \"parameters\", None)),",
    "            })",
    `        directory = os.path.join(basedir, "game", ".ohmygame-scenario", "${runId}")`,
    "        os.makedirs(directory, exist_ok=True)",
    "        with open(os.path.join(directory, \"testcases.json\"), \"w\", encoding=\"utf-8\") as handle:",
    "            json.dump(details, handle, indent=2)",
    "    exit",
    "",
  ].join("\n");
}

async function writeDiscoveryFile(project, name, runId) {
  return writeFile(path.join(project, "game", `zz_ohmygame_discover_${runId}.rpy`), discoverySource(name, runId), "utf8");
}

async function walk(root, visit, relative = "", depth = 0) {
  if (depth > 12) return;
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = path.join(root, relative, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walk(root, visit, next, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    await visit(absolute, next, await lstat(absolute));
  }
}

async function pngSize(file) {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(24);
    const { bytesRead } = await handle.read(header, 0, 24, 0);
    if (bytesRead < 24 || header.subarray(0, 8).toString("hex") !== PNG_SIGNATURE)
      return undefined;
    if (header.toString("ascii", 12, 16) !== "IHDR") return undefined;
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : undefined;
  } finally {
    await handle.close();
  }
}

async function copyBaselines(project, baselineDirectory, screenshotDirectory) {
  const projectRoot = await realpath(project);
  const source = path.join(projectRoot, baselineDirectory);
  const found = await existingDirectory(source, "baseline screenshots folder");
  if (!found) throw new Error(`No baseline screenshots were found at ${baselineDirectory}. Use exploratory mode, or establish and keep baselines in that folder first.`);
  const realSource = await realpath(source);
  if (!insideOrEqual(projectRoot, realSource))
    throw new Error("Refusing a baseline folder outside the project.");
  const paths = new Set();
  let files = 0;
  let bytes = 0;
  await walk(realSource, async (absolute, relative, info) => {
    if (!relative.toLowerCase().endsWith(".png")) return;
    if (relative.toLowerCase().endsWith(".new.png") || relative.toLowerCase().endsWith(".diff.png")) return;
    if (relative.length > MAX_RELATIVE_PATH) throw new Error("A baseline screenshot path is too long.");
    files += 1;
    bytes += info.size;
    if (files > MAX_BASELINE_FILES) throw new Error(`Refusing more than ${MAX_BASELINE_FILES} baseline screenshots.`);
    if (bytes > MAX_BASELINE_BYTES) throw new Error(`Refusing more than ${MAX_BASELINE_BYTES} bytes of baseline screenshots.`);
    const target = path.join(screenshotDirectory, relative);
    if (!insideOrEqual(screenshotDirectory, target)) throw new Error("Refusing a baseline screenshot outside the scenario output folder.");
    await mkdir(path.dirname(target), { recursive: true });
    await cp(absolute, target, { force: true });
    paths.add(relative);
  });
  if (!files)
    throw new Error(`No usable PNG baseline screenshots were found in ${baselineDirectory}. Use exploratory mode, or establish baselines first.`);
  return { files, paths };
}

async function collectCheckpoints(screenshotDirectory, baselinePaths, mode, stagingRoot) {
  const entries = [];
  const warnings = [];
  let bytes = 0;
  let limitReached = false;
  await walk(screenshotDirectory, async (absolute, rawRelative, info) => {
    const relative = rawRelative.replaceAll("\\", "/");
    if (!relative.toLowerCase().endsWith(".png")) return;
    if (relative.length > MAX_RELATIVE_PATH) {
      warnings.push(warning(`Skipped an overly long screenshot path: ${relative}`));
      return;
    }
    let kind;
    let name;
    let difference = false;
    if (relative.toLowerCase().endsWith(".diff.png")) {
      kind = "difference";
      name = relative.slice(0, -".diff.png".length);
      difference = true;
    } else if (relative.toLowerCase().endsWith(".new.png")) {
      kind = "mismatched";
      name = relative.slice(0, -".new.png".length);
    } else if (baselinePaths.has(relative)) {
      // The engine compared this run against the copied reference. It does not
      // save a new image on a match, so the reference is not evidence that this
      // specific screenshot statement executed. Do not present it as a capture.
      return;
    } else {
      kind = mode === "regression" ? "no-baseline" : "exploratory";
      name = relative.replace(/\.png$/i, "");
    }
    if (entries.length >= MAX_CHECKPOINT_FILES) {
      if (!limitReached) warnings.push(warning(`Stopped after ${MAX_CHECKPOINT_FILES} retained screenshot files.`));
      limitReached = true;
      return;
    }
    if (!difference && entries.filter((entry) => entry.kind !== "difference").length >= MAX_CHECKPOINTS) {
      if (!limitReached) warnings.push(warning(`Stopped after ${MAX_CHECKPOINTS} checkpoints; later screenshots were not retained.`));
      limitReached = true;
      return;
    }
    if (info.size > MAX_CHECKPOINT_BYTES) {
      warnings.push(warning(`Skipped ${relative}: larger than ${MAX_CHECKPOINT_BYTES} bytes.`));
      return;
    }
    const size = await pngSize(absolute);
    if (!size || size.width * size.height > MAX_CHECKPOINT_PIXELS) {
      warnings.push(warning(`Skipped ${relative}: not a supported engine-rendered PNG.`));
      return;
    }
    if (bytes + info.size > MAX_RUN_BYTES) {
      if (!limitReached) warnings.push(warning(`Stopped after ${MAX_RUN_BYTES} bytes of screenshots.`));
      limitReached = true;
      return;
    }
    bytes += info.size;
    entries.push({ name, file: relative, kind, width: size.width, height: size.height, bytes: info.size, capturedAt: info.mtimeMs, absolute });
  });
  const rank = (kind) => kind === "difference" ? 1 : 0;
  entries.sort((left, right) => left.capturedAt - right.capturedAt || rank(left.kind) - rank(right.kind) || left.file.localeCompare(right.file));
  const checkpoints = entries.map((entry, order) => ({
    name: entry.name,
    file: entry.file,
    kind: entry.kind,
    order,
    width: entry.width,
    height: entry.height,
    bytes: entry.bytes,
    capturedAt: entry.capturedAt,
  }));
  for (const entry of entries) {
    const target = path.join(stagingRoot, "checkpoints", entry.file);
    if (!insideOrEqual(stagingRoot, target)) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await cp(entry.absolute, target, { force: true });
  }
  return { checkpoints, bytes, limitReached, warnings: warnings.slice(0, MAX_WARNINGS) };
}

export function scenarioSelection(output) {
  if (typeof output !== "string") return undefined;
  const match = /\[rpytest\]\s+\[log\]\s+-\s+([^\r\n]+)/.exec(output);
  const value = match?.[1]?.trim();
  return value && value.length <= 200 ? value : undefined;
}

export function scenarioStatus({ cancelled = false, timedOut = false, invocationError, exitCode, output = "" }) {
  if (cancelled) return "cancelled";
  if (timedOut) return "timed-out";
  if (invocationError) return "invocation-error";
  if (/TestCase\s+.+?\s+not found/i.test(output)) return "not-found";
  if (/\bStatus:\s*SKIPPED\b/i.test(output)) return "skipped";
  if (exitCode === 0) return "passed";
  if (typeof exitCode === "number") return "failed";
  return "unknown";
}

async function pruneStagedRuns(project, currentRunId) {
  const runsRoot = path.join(project, ".ohmygame", "scenario-runs");
  const found = await lstat(runsRoot).catch(() => undefined);
  if (!found || found.isSymbolicLink() || !found.isDirectory()) return [];
  const warnings = [];
  const runs = [];
  for (const entry of await readdir(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !RUN_ID.test(entry.name) || entry.name === currentRunId) continue;
    const root = path.join(runsRoot, entry.name);
    const info = await lstat(root).catch(() => undefined);
    if (!info || info.isSymbolicLink()) continue;
    runs.push({ name: entry.name, root, mtimeMs: info.mtimeMs });
  }
  runs.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const run of runs.slice(STAGED_RUNS - 1)) {
    const manifest = await readFile(path.join(run.root, "run.json"), "utf8").then((value) => JSON.parse(value)).catch(() => undefined);
    if (manifest?.status === "running" && Date.now() - run.mtimeMs < 60 * 60_000) continue;
    try {
      await rm(run.root, { recursive: true, force: true });
    } catch (error) {
      warnings.push(warning(`Could not prune the old scenario run ${run.name}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  return warnings;
}

/**
 * Runs a named Ren'Py testcase or testsuite in a disposable mirror. Screenshot
 * statements are redirected into the mirror, then the produced PNGs are copied
 * into the project's bounded staging folder before the mirror is removed.
 * Engine failures are returned as evidence; setup failures are thrown.
 */
export async function runScenario(command, project, input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("A scenario run needs a testcase name.");
  const testcase = validTestcase(input.testcase);
  if (input.mode !== undefined && input.mode !== "exploratory" && input.mode !== "regression")
    throw new Error("A scenario mode must be exploratory or regression.");
  const mode = input.mode === "regression" ? "regression" : "exploratory";
  const runId = validRunId(input.runId) ?? randomUUID().replaceAll("-", "");
  const baselineDirectory = mode === "regression" ? validBaselineDirectory(input.baselineDirectory ?? "tests/screenshots") : undefined;
  const execute = options.execute ?? runRenpy;
  const timeoutMs = options.timeoutMs ?? SCENARIO_TIMEOUT_MS;
  const startedAt = Date.now();
  const mirror = await validationMirror(project);
  const warnings = [];
  let isolation;
  let staging;
  let response;
  let setupFailure;

  try {
    isolation = await validationIsolation();
    const runRoot = path.join(mirror.project, "game", ".ohmygame-scenario", runId);
    const screenshotDirectory = path.join(runRoot, "screenshots");
    await mkdir(screenshotDirectory, { recursive: true });
    await writeSetupFile(mirror.project, runId);

    let baseline = { files: 0, paths: new Set() };
    if (mode === "regression") {
      options.progress?.("Copying screenshot baselines");
      baseline = await copyBaselines(project, baselineDirectory, screenshotDirectory);
    }

    staging = await safeStagingRoot(project, runId);
    await writeManifest(staging.root, {
      runId, requested: testcase, mode, status: "running", startedAt,
      ...(baselineDirectory ? { baselineDirectory, baselineFiles: baseline.files } : {}),
      checkpoints: [],
    });

    let result;
    let cancelled = false;
    let timedOut = false;
    let invocationError;
    try {
      options.progress?.(`Running ${testcase}`);
      result = await execute(command, ["--savedir", isolation.savedir, mirror.project, "test", testcase], {
        cwd: mirror.project,
        signal: options.signal,
        progress: options.progress,
        timeoutMs,
        stopOnReport: true,
        env: { ...options.env, ...isolation.env },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.signal?.aborted || /cancelled/i.test(message)) cancelled = true;
      else if (/timed out/i.test(message)) timedOut = true;
      else invocationError = message;
      result = {
        exitCode: null,
        output: typeof error?.output === "string" ? error.output : "",
        errors: Array.isArray(error?.errors) ? error.errors : [],
        outputTruncated: error?.outputTruncated === true,
      };
    }

    options.progress?.("Collecting scenario checkpoints");
    const collected = await collectCheckpoints(screenshotDirectory, baseline.paths, mode, staging.root);
    if (mode === "regression" && collected.checkpoints.some((item) => item.kind === "no-baseline"))
      collected.warnings = [...collected.warnings, warning("Some screenshots had no matching baseline and were not regression-compared.")].slice(0, MAX_WARNINGS);
    if (!collected.checkpoints.length)
      collected.warnings = [...collected.warnings, warning(mode === "regression"
        ? "No new screenshots were produced in regression mode; screenshot statements either matched their baselines or produced no files."
        : "No engine-rendered screenshots were found in the controlled run folder; the scenario may have no screenshot statements or may have redirected the screenshot directory.")].slice(0, MAX_WARNINGS);
    const output = typeof result.output === "string" ? result.output : "";
    const status = scenarioStatus({
      cancelled, timedOut, invocationError, exitCode: result.exitCode, output,
    });
    const selection = scenarioSelection(output);
    const completedAt = Date.now();
    const scenario = {
      runId,
      requested: testcase,
      ...(selection ? { executedSelection: selection } : {}),
      mode,
      status: scenarioStatuses.has(status) ? status : "unknown",
      startedAt,
      completedAt,
      timedOut,
      cancelled,
      ...(invocationError ? { failure: warning(invocationError) }
        : timedOut ? { failure: "The scenario exceeded the engine time limit and was stopped." }
          : cancelled ? { failure: "The scenario was cancelled before it finished." } : {}),
      ...(baselineDirectory ? { baselineDirectory, baselineFiles: baseline.files } : {}),
      checkpointOrder: "file-write-time",
      checkpointDirectory: `.ohmygame/scenario-runs/${runId}/checkpoints`,
      checkpointBytes: collected.bytes,
      checkpointLimitReached: collected.limitReached,
      checkpointWarnings: collected.warnings,
      checkpoints: collected.checkpoints,
    };
    let diagnostics = { diagnostics: [], diagnosticsTruncated: false };
    try {
      diagnostics = await renpyDiagnostics(output, mirror.project, project);
    } catch {
      // The engine output remains the evidence when path mapping cannot run.
    }
    await writeManifest(staging.root, { ...scenario, checkpoints: collected.checkpoints });
    warnings.push(...await pruneStagedRuns(project, runId));
    response = {
      exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
      errors: Array.isArray(result.errors) ? result.errors : renpyErrors(output),
      output,
      outputTruncated: result.outputTruncated === true,
      ...diagnostics,
      validationCopy: true,
      scenario,
    };
  } catch (error) {
    setupFailure = validDriveError(error);
  } finally {
    if (isolation) {
      const warningText = await isolation.cleanup();
      if (warningText) warnings.push(warningText);
    }
    const warningText = await mirror.cleanup();
    if (warningText) warnings.push(warningText);
  }

  if (setupFailure) {
    if (warnings.length) setupFailure.message += ` (cleanup warning: ${warnings.join("; ")})`;
    throw setupFailure;
  }
  return {
    ...response,
    ...(warnings.length ? { cleanupWarning: warnings.join("; ") } : {}),
  };
}

/**
 * Asks the running engine which testcases and testsuites its loaded scripts
 * registered. A generated testcase writes the registry, so lexical scanning
 * cannot claim a scenario that the engine would not run.
 */
export async function discoverScenarios(command, project, options = {}) {
  const execute = options.execute ?? runRenpy;
  const timeoutMs = options.timeoutMs ?? SCENARIO_TIMEOUT_MS;
  const runId = randomUUID().replaceAll("-", "");
  const discoveryName = `__ohmygame_discover_${runId}__`;
  const mirror = await validationMirror(project);
  const warnings = [];
  let isolation;
  let response;
  let setupFailure;

  try {
    isolation = await validationIsolation();
    const runRoot = path.join(mirror.project, "game", ".ohmygame-scenario", runId);
    await mkdir(runRoot, { recursive: true });
    await writeDiscoveryFile(mirror.project, discoveryName, runId);

    let result;
    let cancelled = false;
    let timedOut = false;
    let invocationError;
    try {
      options.progress?.("Reading engine testcases");
      result = await execute(command, ["--savedir", isolation.savedir, mirror.project, "test", discoveryName], {
        cwd: mirror.project,
        signal: options.signal,
        progress: options.progress,
        timeoutMs,
        stopOnReport: true,
        env: { ...options.env, ...isolation.env },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.signal?.aborted || /cancelled/i.test(message)) cancelled = true;
      else if (/timed out/i.test(message)) timedOut = true;
      else invocationError = message;
      result = {
        exitCode: null,
        output: typeof error?.output === "string" ? error.output : "",
        errors: Array.isArray(error?.errors) ? error.errors : [],
        outputTruncated: error?.outputTruncated === true,
      };
    }

    const output = typeof result.output === "string" ? result.output : "";
    let status = scenarioStatus({ cancelled, timedOut, invocationError, exitCode: result.exitCode, output });
    const scenarios = [];
    let truncated = false;
    let failure;
    const raw = await readFile(path.join(runRoot, "testcases.json"), "utf8").catch(() => undefined);
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error("The engine's scenario list was not an array.");
        const seen = new Set();
        for (const item of parsed) {
          if (!item || typeof item.name !== "string" || !TESTCASE.test(item.name)) continue;
          if (item.name === discoveryName || item.name.startsWith("__ohmygame_discover_")) continue;
          if (seen.has(item.name)) continue;
          seen.add(item.name);
          if (scenarios.length >= MAX_SCENARIOS) {
            truncated = true;
            break;
          }
          const name = item.name;
          const kind = item.kind === "testsuite" ? "testsuite" : "testcase";
          const file = typeof item.file === "string" && item.file.length <= MAX_RELATIVE_PATH && !item.file.includes("\0")
            ? item.file : undefined;
          const line = Number.isSafeInteger(item.line) && item.line > 0 ? item.line : undefined;
          scenarios.push({
            name,
            kind,
            ...(file ? { file } : {}),
            ...(line ? { line } : {}),
            parameterized: item.parameterized === true,
            default: name === "global",
          });
        }
        scenarios.sort((left, right) => left.name.localeCompare(right.name));
      } catch (error) {
        failure = `The engine's scenario list could not be read: ${error instanceof Error ? error.message : String(error)}`;
        if (status === "passed") status = "failed";
      }
    } else if (status === "passed") {
      failure = "The scenario discovery testcase finished without reporting the engine's testcase list.";
      status = "failed";
    }

    let diagnostics = { diagnostics: [], diagnosticsTruncated: false };
    try {
      diagnostics = await renpyDiagnostics(output, mirror.project, project);
    } catch {
      // The engine output remains the evidence when path mapping cannot run.
    }
    response = {
      status,
      authority: "engine",
      scenarios,
      truncated,
      exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
      errors: Array.isArray(result.errors) ? result.errors : renpyErrors(output),
      output,
      outputTruncated: result.outputTruncated === true,
      ...diagnostics,
      validationCopy: true,
      ...(failure ? { failure } : {}),
    };
  } catch (error) {
    setupFailure = validDriveError(error);
  } finally {
    if (isolation) {
      const warningText = await isolation.cleanup();
      if (warningText) warnings.push(warningText);
    }
    const warningText = await mirror.cleanup();
    if (warningText) warnings.push(warningText);
  }

  if (setupFailure) {
    if (warnings.length) setupFailure.message += ` (cleanup warning: ${warnings.join("; ")})`;
    throw setupFailure;
  }
  return {
    ...response,
    ...(warnings.length ? { cleanupWarning: warnings.join("; ") } : {}),
  };
}
