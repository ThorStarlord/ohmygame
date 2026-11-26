import { randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import type {
  ScenarioCheckpoint,
  ScenarioCheckpointKind,
  ScenarioCheckpointSummary,
  ScenarioDiscovery,
  ScenarioRunMode,
  ScenarioRunSummary,
  ScenarioSummary,
} from "../shared/engine-observations.js";
import type { PluginIndexEntry } from "./plugin-index.js";
import type { PluginServices } from "./plugin-services.js";
import {
  isScenarioCheckpointKind,
  isScenarioRunStatus,
  parseScenarioDiagnostics,
  ScenarioRuns,
  type ScenarioCheckpointInput,
  type ScenarioRunInput,
} from "./scenario-runs.js";

const PLUGIN_ID = "thorstarlord/renpy";
const SCENARIO_NAME = /^[A-Za-z_][A-Za-z0-9_.]{0,199}$/;
const MAX_OUTPUT = 8_192;
const MAX_MESSAGE = 2_000;
const MAX_WARNING = 300;
const MAX_WARNINGS = 12;
const MAX_CHECKPOINTS = 40;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const MAX_PATH = 300;

export interface ScenarioPlaytestsOptions {
  plugins: PluginServices;
  runs: ScenarioRuns;
  /** False once the project is closed, so a late engine result is not retained. */
  projectExists?: (projectId: string) => boolean;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function warning(value: unknown): string {
  return String(value).replace(/\s+/g, " ").trim().slice(0, MAX_WARNING);
}

function insideOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function stagingRoot(projectFolder: string, runId: string): string {
  const root = path.join(projectFolder, ".ohmygame", "scenario-runs");
  const run = path.join(root, runId);
  if (!insideOrEqual(root, run)) throw new Error("Refusing a scenario staging folder outside the project.");
  return run;
}

function safeRelative(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replaceAll("\\", "/");
  if (!text || text.length > MAX_PATH || text.startsWith("/") || /^[A-Za-z]:/.test(text) || text.includes("\0")) return undefined;
  if (text.split("/").some((part) => !part || part === "." || part === ".." || /[\u0000-\u001f]/.test(part))) return undefined;
  return text;
}

function pngDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return undefined;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return undefined;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height || width * height > MAX_PIXELS) return undefined;
  return { width, height };
}

async function pngFileDimensions(file: string): Promise<{ width: number; height: number } | undefined> {
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const header = Buffer.alloc(24);
    const { bytesRead } = await handle.read(header, 0, 24, 0);
    if (bytesRead < 24) return undefined;
    return pngDimensions(header);
  } finally {
    await handle.close();
  }
}

function scenarioName(value: unknown): string {
  if (typeof value !== "string" || !SCENARIO_NAME.test(value))
    throw new Error("A scenario must be an engine testcase name containing only letters, digits, underscores and dots.");
  return value;
}

function parsedErrors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .slice(0, 50).map((item) => item.slice(0, MAX_MESSAGE));
}

/**
 * The app-facing scenario workflow: resolve the active engine plugin, run its
 * engine-native discovery or scenario tool, ingest only the staged checkpoint
 * files, and discard the staging copy. Scenario execution is engine authority,
 * not desktop capture, and never opens an approval card for a native window.
 */
export class ScenarioPlaytests {
  readonly #running = new Set<string>();
  readonly #controllers = new Map<string, AbortController>();

  constructor(private readonly options: ScenarioPlaytestsOptions) {}

  /** Whether this project has an active Ren'Py plugin that provides scenario execution. */
  async available(project: ProjectState): Promise<boolean> {
    const resolved = await this.options.plugins.resolve(project.workspacePath).catch(() => undefined);
    if (!resolved?.ok) return false;
    return resolved.plugins.some((plugin) => plugin.id === PLUGIN_ID && plugin.status === "active" && !!plugin.entry
      && (plugin.entry.manifest.contributes?.tools ?? []).some((tool) => tool.name === "renpy_scenario_run"));
  }

  async discover(project: ProjectState, signal?: AbortSignal): Promise<ScenarioDiscovery> {
    const entry = await this.#entry(project);
    const result = await this.options.plugins.callTool(entry, "renpy_scenarios", {
      folder: project.workspacePath,
      input: {},
      ...(signal ? { signal } : {}),
    });
    return this.#discovery(result, (text) => this.options.plugins.redactObservationText(text, entry.id));
  }

  async run(project: ProjectState, input: { scenario: string; mode?: ScenarioRunMode; baselineDirectory?: string }, signal?: AbortSignal): Promise<ScenarioRunSummary> {
    const scenario = scenarioName(input?.scenario);
    const mode = input?.mode === "regression" ? "regression" : "exploratory";
    if (input?.mode !== undefined && input.mode !== "exploratory" && input.mode !== "regression")
      throw new Error("A scenario mode must be exploratory or regression.");
    if (this.#running.has(project.id))
      throw new Error("A scenario run is already in progress for this project. Wait for it to finish.");
    this.#running.add(project.id);
    const controller = new AbortController();
    this.#controllers.set(project.id, controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const runId = randomUUID().replaceAll("-", "");
    try {
      const entry = await this.#entry(project);
      let result: unknown;
      try {
        result = await this.options.plugins.callTool(entry, "renpy_scenario_run", {
          folder: project.workspacePath,
          input: {
            testcase: scenario,
            mode,
            runId,
            ...(input.baselineDirectory ? { baselineDirectory: input.baselineDirectory } : {}),
          },
          signal: combined,
        });
      } catch (error) {
        const recovered = await this.#recover(project, entry, runId, scenario, mode, error, combined);
        if (recovered) return recovered;
        throw error;
      }
      return await this.#ingest(project, entry, runId, scenario, mode, result);
    } finally {
      if (this.#controllers.get(project.id) === controller) this.#controllers.delete(project.id);
      this.#running.delete(project.id);
    }
  }

  list(projectId: string): ScenarioRunSummary[] {
    return this.options.runs.list(projectId);
  }

  find(projectId: string, checkpointId: string): ScenarioCheckpointSummary | undefined {
    return this.options.runs.find(projectId, checkpointId);
  }

  /** One exact retained checkpoint; never substitutes another run's image. */
  checkpoint(projectId: string, checkpointId: string): ScenarioCheckpoint {
    const summary = this.options.runs.find(projectId, checkpointId);
    if (!summary) throw new Error("That scenario checkpoint is not retained for this project.");
    if (!summary.retained)
      throw new Error("That scenario checkpoint's image is no longer retained; its run and metadata remain available.");
    const checkpoint = this.options.runs.get(projectId, checkpointId);
    if (!checkpoint) throw new Error("That scenario checkpoint is no longer retained.");
    return checkpoint;
  }

  /**
   * Two exact observations and an explicit comparability judgment. Matching
   * filenames alone are not enough: scenario, checkpoint name, observation mode
   * and dimensions must agree. Source revisions remain unknown.
   */
  compare(projectId: string, beforeCheckpointId: string, afterCheckpointId: string) {
    const before = this.checkpoint(projectId, beforeCheckpointId);
    const after = this.checkpoint(projectId, afterCheckpointId);
    const reasons: string[] = [];
    if (before.scenario !== after.scenario) reasons.push("different scenarios");
    if (before.name !== after.name) reasons.push("different checkpoint names");
    if (before.mode !== after.mode) reasons.push("different observation modes");
    if (before.kind === "difference" || after.kind === "difference")
      reasons.push("a difference image is not a rendered checkpoint");
    if (before.width !== after.width || before.height !== after.height) reasons.push("different image dimensions");
    return {
      before,
      after,
      comparable: reasons.length === 0,
      reason: reasons.length === 0
        ? "Same scenario, checkpoint name, observation mode and dimensions. The source revision and exact narrative state remain unknown."
        : `Not directly comparable: ${reasons.join(", ")}.`,
    };
  }

  forget(projectId: string): void {
    this.#controllers.get(projectId)?.abort();
    this.#controllers.delete(projectId);
    this.options.runs.forget(projectId);
  }

  async #entry(project: ProjectState): Promise<PluginIndexEntry> {
    const resolved = await this.options.plugins.resolve(project.workspacePath);
    if (!resolved.ok)
      throw new Error("The project's plugins could not be read: " + resolved.issues.slice(0, 2).join("; "));
    const entry = resolved.plugins.find((plugin) => plugin.id === PLUGIN_ID && plugin.status === "active" && plugin.entry)?.entry;
    if (!entry)
      throw new Error("The Ren'Py plugin is not active for this project. Enable it before discovering or running a scenario.");
    if (!(entry.manifest.contributes?.tools ?? []).some((tool) => tool.name === "renpy_scenario_run"))
      throw new Error("The active Ren'Py plugin does not provide scenario playtesting. Update the plugin.");
    return entry;
  }

  #discovery(value: unknown, redact: (text: string) => string): ScenarioDiscovery {
    const result = record(value) ?? {};
    const scenarios: ScenarioSummary[] = [];
    for (const item of Array.isArray(result.scenarios) ? result.scenarios.slice(0, 200) : []) {
      const row = record(item);
      if (!row || typeof row.name !== "string" || !SCENARIO_NAME.test(row.name)) continue;
      const kind = row.kind === "testsuite" ? "testsuite" : "testcase";
      const file = typeof row.file === "string" && row.file.length <= MAX_PATH && !row.file.includes("\0") ? row.file : undefined;
      const line = typeof row.line === "number" && Number.isSafeInteger(row.line) && row.line > 0 ? row.line : undefined;
      scenarios.push({
        name: row.name,
        kind,
        ...(file ? { file } : {}),
        ...(line ? { line } : {}),
        parameterized: row.parameterized === true,
        default: row.default === true || row.name === "global",
      });
    }
    const output = typeof result.output === "string" ? result.output : "";
    const diagnostics = parseScenarioDiagnostics(result.diagnostics);
    return {
      status: isScenarioRunStatus(result.status) ? result.status : "unknown",
      authority: "engine",
      scenarios,
      truncated: result.truncated === true,
      exitCode: typeof result.exitCode === "number" && Number.isSafeInteger(result.exitCode) ? result.exitCode : null,
      errors: parsedErrors(result.errors).map(redact),
      diagnostics: diagnostics.diagnostics.map((item) => ({
        ...item,
        message: redact(item.message),
        ...(item.path ? { path: redact(item.path) } : {}),
      })),
      diagnosticsComplete: result.outputTruncated === false && result.diagnosticsTruncated === false && diagnostics.complete,
      ...(output ? { outputExcerpt: redact(output).slice(-MAX_OUTPUT) } : {}),
      ...(result.outputTruncated !== false || output.length > MAX_OUTPUT ? { outputOmitted: true } : {}),
      ...(typeof result.failure === "string" && result.failure.trim() ? { failure: redact(result.failure).slice(0, MAX_MESSAGE) } : {}),
    };
  }

  async #ingest(
    project: ProjectState,
    entry: PluginIndexEntry,
    runId: string,
    scenario: string,
    mode: ScenarioRunMode,
    value: unknown,
  ): Promise<ScenarioRunSummary> {
    const result = record(value) ?? {};
    const payload = record(result.scenario);
    if (!payload) throw new Error("The Ren'Py plugin returned no scenario result.");
    if (payload.runId !== runId) throw new Error("The Ren'Py plugin used an unexpected scenario run identity.");
    const staging = stagingRoot(project.workspacePath, runId);
    if (this.options.projectExists && !this.options.projectExists(project.id)) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw new Error("The project closed before the scenario finished; its evidence was not retained.");
    }
    const redact = (text: string) => this.options.plugins.redactObservationText(text, entry.id);
    const warnings = (Array.isArray(payload.checkpointWarnings) ? payload.checkpointWarnings : [])
      .filter((item): item is string => typeof item === "string")
      .map(warning).filter(Boolean).slice(0, MAX_WARNINGS);
    const checkpoints: ScenarioCheckpointInput[] = [];
    const checkpointRoot = path.join(staging, "checkpoints");
    const rows = Array.isArray(payload.checkpoints) ? payload.checkpoints.slice(0, MAX_CHECKPOINTS) : [];
    for (const [index, value] of rows.entries()) {
      const checkpoint = await this.#checkpoint(value, index, checkpointRoot, warnings);
      if (checkpoint) checkpoints.push(checkpoint);
    }
    await rm(staging, { recursive: true, force: true }).then(
      () => undefined,
      (error) => warnings.push(warning(`Could not remove the scenario staging copy: ${error instanceof Error ? error.message : String(error)}`)),
    );

    const output = typeof result.output === "string" ? result.output : "";
    const diagnostics = parseScenarioDiagnostics(result.diagnostics);
    const redactedWarnings = warnings.map((item) => warning(redact(item))).slice(0, MAX_WARNINGS);
    const reportedMode = payload.mode;
    const input: ScenarioRunInput = {
      plugin: entry.id,
      pluginVersion: entry.version,
      engineRunId: runId,
      scenario: typeof payload.requested === "string" && payload.requested ? payload.requested.slice(0, 200) : scenario,
      ...(typeof payload.executedSelection === "string" && payload.executedSelection
        ? { executedSelection: payload.executedSelection.slice(0, 200) } : {}),
      mode: reportedMode === "regression" ? "regression" : reportedMode === "exploratory" ? "exploratory" : mode,
      status: isScenarioRunStatus(payload.status) ? payload.status : "unknown",
      startedAt: typeof payload.startedAt === "number" && Number.isFinite(payload.startedAt) ? payload.startedAt : Date.now(),
      completedAt: typeof payload.completedAt === "number" && Number.isFinite(payload.completedAt) ? payload.completedAt : Date.now(),
      exitCode: typeof result.exitCode === "number" && Number.isSafeInteger(result.exitCode) ? result.exitCode : null,
      timedOut: payload.timedOut === true,
      cancelled: payload.cancelled === true,
      ...(typeof payload.failure === "string" && payload.failure.trim() ? { failure: redact(payload.failure).slice(0, MAX_MESSAGE) } : {}),
      ...(typeof payload.baselineDirectory === "string" && payload.baselineDirectory
        ? { baselineDirectory: payload.baselineDirectory.slice(0, MAX_PATH) } : {}),
      ...(typeof payload.baselineFiles === "number" && Number.isSafeInteger(payload.baselineFiles) && payload.baselineFiles >= 0
        ? { baselineFiles: payload.baselineFiles } : {}),
      checkpointOrder: "file-write-time",
      checkpointLimitReached: payload.checkpointLimitReached === true,
      checkpointWarnings: redactedWarnings,
      checkpoints,
      diagnostics: diagnostics.diagnostics.map((item) => ({
        ...item,
        message: redact(item.message),
        ...(item.path ? { path: redact(item.path) } : {}),
      })),
      diagnosticsComplete: result.outputTruncated === false && result.diagnosticsTruncated === false && diagnostics.complete,
      ...(output ? { outputExcerpt: redact(output).slice(-MAX_OUTPUT) } : {}),
      ...(result.outputTruncated !== false || output.length > MAX_OUTPUT ? { outputOmitted: true } : {}),
    };
    return this.options.runs.add(project.id, input);
  }

  async #checkpoint(
    value: unknown,
    index: number,
    checkpointRoot: string,
    warnings: string[],
  ): Promise<ScenarioCheckpointInput | undefined> {
    const row = record(value);
    const kind = row?.kind;
    if (!row || typeof row.name !== "string" || !row.name.trim() || !isScenarioCheckpointKind(kind)
      || typeof row.order !== "number" || !Number.isSafeInteger(row.order) || row.order < 0
      || typeof row.width !== "number" || !Number.isSafeInteger(row.width) || row.width < 1 || row.width > 16_384
      || typeof row.height !== "number" || !Number.isSafeInteger(row.height) || row.height < 1 || row.height > 16_384
      || typeof row.bytes !== "number" || !Number.isSafeInteger(row.bytes) || row.bytes < 1
      || typeof row.capturedAt !== "number" || !Number.isFinite(row.capturedAt)) {
      warnings.push(warning("Skipped a checkpoint whose reported metadata was invalid."));
      return undefined;
    }
    const file = safeRelative(row.file);
    if (!file) {
      warnings.push(warning(`Skipped checkpoint ${row.name}: its file path was not safe.`));
      return undefined;
    }
    const base: ScenarioCheckpointInput = {
      name: row.name.slice(0, MAX_PATH),
      file,
      kind,
      order: row.order || index,
      width: row.width,
      height: row.height,
      bytes: row.bytes,
      capturedAt: row.capturedAt,
    };
    const absolute = path.join(checkpointRoot, file);
    if (!insideOrEqual(checkpointRoot, absolute)) {
      warnings.push(warning(`Skipped checkpoint ${row.name}: its file was outside the run.`));
      return { ...base };
    }
    const info = await lstat(absolute).catch(() => undefined);
    if (!info || info.isSymbolicLink() || !info.isFile()) {
      warnings.push(warning(`Checkpoint ${row.name} has no staged image; its metadata is retained without the image.`));
      return { ...base };
    }
    const realRoot = await realpath(checkpointRoot).catch(() => undefined);
    const realFile = await realpath(absolute).catch(() => undefined);
    if (!realRoot || !realFile || !insideOrEqual(realRoot, realFile)) {
      warnings.push(warning(`Checkpoint ${row.name}: its resolved file was outside the run.`));
      return { ...base };
    }
    if (info.size > MAX_IMAGE_BYTES) {
      warnings.push(warning(`Checkpoint ${row.name} is larger than the image retention limit.`));
      return { ...base, bytes: info.size };
    }
    const bytes = await readFile(absolute).catch(() => undefined);
    const png = bytes ? pngDimensions(bytes) : undefined;
    if (!bytes || !png) {
      warnings.push(warning(`Checkpoint ${row.name} is not a supported engine-rendered PNG.`));
      return { ...base, bytes: info.size };
    }
    if (png.width !== base.width || png.height !== base.height)
      warnings.push(warning(`Checkpoint ${row.name}: the staged image's dimensions differed from the plugin metadata.`));
    return {
      ...base,
      width: png.width,
      height: png.height,
      bytes: bytes.length,
      data: bytes.toString("base64"),
    };
  }

  async #recover(
    project: ProjectState,
    entry: PluginIndexEntry,
    runId: string,
    scenario: string,
    mode: ScenarioRunMode,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<ScenarioRunSummary | undefined> {
    const staging = stagingRoot(project.workspacePath, runId);
    const found = await lstat(staging).catch(() => undefined);
    if (!found || found.isSymbolicLink() || !found.isDirectory()) return undefined;
    if (this.options.projectExists && !this.options.projectExists(project.id)) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      return undefined;
    }
    const manifest = await readFile(path.join(staging, "run.json"), "utf8")
      .then((value) => record(JSON.parse(value)))
      .catch(() => undefined);
    const redact = (text: string) => this.options.plugins.redactObservationText(text, entry.id);
    const failure = error instanceof Error ? error.message : String(error);
    const manifestStatus = typeof manifest?.status === "string" && manifest.status !== "running" && isScenarioRunStatus(manifest.status)
      ? manifest.status : undefined;
    const status = manifestStatus ?? (signal?.aborted ? "cancelled" : "invocation-error");
    const completed = status === "passed" || status === "failed" || status === "skipped" || status === "not-found";
    const warnings = (Array.isArray(manifest?.checkpointWarnings) ? manifest.checkpointWarnings : [])
      .filter((item): item is string => typeof item === "string")
      .map(warning).filter(Boolean).slice(0, MAX_WARNINGS);
    warnings.push(warning(completed
      ? "Recovered the completed run from its manifest; the plugin result was not delivered."
      : `Recovered partial evidence after ${signal?.aborted ? "cancellation" : "an invocation error"}.`));
    const checkpoints: ScenarioCheckpointInput[] = [];
    let rows = Array.isArray(manifest?.checkpoints) ? manifest.checkpoints : [];
    if (!rows.length) {
      const modeOfRun = manifest?.mode === "regression" ? "regression" : manifest?.mode === "exploratory" ? "exploratory" : mode;
      const files: Array<{ name: string; kind: ScenarioCheckpointKind; absolute: string; mtimeMs: number; size: number; width: number; height: number }> = [];
      const walk = async (folder: string, relative = "", depth = 0) => {
        if (depth > 8) return;
        for (const item of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
          const next = relative ? `${relative}/${item.name}` : item.name;
          const absolute = path.join(folder, item.name);
          if (item.isSymbolicLink()) continue;
          if (item.isDirectory()) {
            await walk(absolute, next, depth + 1);
            continue;
          }
          if (!item.isFile() || !next.toLowerCase().endsWith(".png") || next.length > MAX_PATH) continue;
          const info = await lstat(absolute).catch(() => undefined);
          const size = await pngFileDimensions(absolute);
          if (!info || !size) {
            warnings.push(warning(`Skipped an unreadable staged screenshot: ${next}`));
            continue;
          }
          const lower = next.toLowerCase();
          const kind: ScenarioCheckpointKind = lower.endsWith(".diff.png") ? "difference"
            : lower.endsWith(".new.png") ? "mismatched"
              : modeOfRun === "regression" ? "no-baseline" : "exploratory";
          const name = lower.endsWith(".diff.png") ? next.slice(0, -".diff.png".length)
            : lower.endsWith(".new.png") ? next.slice(0, -".new.png".length)
              : next.replace(/\.png$/i, "");
          files.push({ name, kind, absolute, mtimeMs: info.mtimeMs, size: info.size, ...size });
        }
      };
      await walk(path.join(staging, "checkpoints"));
      const rank = (kind: ScenarioCheckpointKind) => kind === "difference" ? 1 : 0;
      files.sort((left, right) => left.mtimeMs - right.mtimeMs || rank(left.kind) - rank(right.kind) || left.name.localeCompare(right.name));
      rows = files.map((file, index) => ({
        name: file.name,
        file: path.relative(path.join(staging, "checkpoints"), file.absolute).replaceAll("\\", "/"),
        kind: file.kind,
        order: index,
        width: file.width,
        height: file.height,
        bytes: file.size,
        capturedAt: file.mtimeMs,
      }));
    }
    const checkpointRoot = path.join(staging, "checkpoints");
    const truncated = rows.length > MAX_CHECKPOINTS;
    if (truncated) warnings.push(warning(`Only the first ${MAX_CHECKPOINTS} recovered checkpoints were retained.`));
    for (const [index, row] of rows.slice(0, MAX_CHECKPOINTS).entries()) {
      const checkpoint = await this.#checkpoint(row, index, checkpointRoot, warnings);
      if (checkpoint) checkpoints.push(checkpoint);
    }
    await rm(staging, { recursive: true, force: true }).then(
      () => undefined,
      (cleanupError) => warnings.push(warning(`Could not remove the scenario staging copy: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)),
    );
    const startedAt = typeof manifest?.startedAt === "number" && Number.isFinite(manifest.startedAt) ? manifest.startedAt : Date.now();
    const completedAt = typeof manifest?.completedAt === "number" && Number.isFinite(manifest.completedAt) ? manifest.completedAt : Date.now();
    const requested = typeof manifest?.requested === "string" && manifest.requested ? manifest.requested.slice(0, 200) : scenario;
    const reportedMode = manifest?.mode;
    return this.options.runs.add(project.id, {
      plugin: entry.id,
      pluginVersion: entry.version,
      engineRunId: runId,
      scenario: requested,
      mode: reportedMode === "regression" ? "regression" : reportedMode === "exploratory" ? "exploratory" : mode,
      status,
      startedAt,
      completedAt,
      exitCode: null,
      timedOut: status === "timed-out" || manifest?.timedOut === true,
      cancelled: status === "cancelled" || signal?.aborted === true || manifest?.cancelled === true,
      ...(typeof manifest?.failure === "string" && manifest.failure.trim()
        ? { failure: redact(manifest.failure).slice(0, MAX_MESSAGE) }
        : completed ? {} : { failure: redact(failure).slice(0, MAX_MESSAGE) }),
      checkpointOrder: "file-write-time",
      checkpointLimitReached: manifest?.checkpointLimitReached === true || truncated,
      checkpointWarnings: warnings.map((item) => warning(redact(item))).slice(0, MAX_WARNINGS),
      checkpoints,
      diagnostics: [],
      diagnosticsComplete: false,
    });
  }
}
