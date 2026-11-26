import { randomUUID } from "node:crypto";
import type {
  EngineDiagnostic,
  ScenarioCheckpoint,
  ScenarioCheckpointKind,
  ScenarioCheckpointSummary,
  ScenarioRunMode,
  ScenarioRunStatus,
  ScenarioRunSummary,
} from "../shared/engine-observations.js";

const MAX_PROJECTS = 24;
const MAX_RUNS = 8;
const MAX_DIAGNOSTICS = 50;
const MAX_MESSAGE = 2_000;
const MAX_OUTPUT = 8_192;
const MAX_WARNINGS = 12;
const MAX_WARNING = 300;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_ENCODED_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_PIXELS = 16_000_000;
const MAX_PROJECT_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_CHECKPOINTS = 40;
const RUN_ID = /^[a-z0-9]{8,40}$/;

const statuses = new Set<ScenarioRunStatus>([
  "passed", "failed", "skipped", "timed-out", "cancelled", "not-found", "invocation-error", "unknown",
]);
const kinds = new Set<ScenarioCheckpointKind>(["exploratory", "mismatched", "no-baseline", "difference"]);

export interface ScenarioCheckpointInput {
  name: string;
  file: string;
  kind: ScenarioCheckpointKind;
  order: number;
  width: number;
  height: number;
  bytes: number;
  capturedAt: number;
  data?: string;
}

export interface ScenarioRunsOptions {
  /** Retention limits, injectable for tests. Defaults are the product limits. */
  projects?: number;
  runs?: number;
  projectBytes?: number;
  totalBytes?: number;
}

export interface ScenarioRunInput {
  plugin: string;
  pluginVersion: string;
  engineRunId: string;
  scenario: string;
  executedSelection?: string;
  mode: ScenarioRunMode;
  status: ScenarioRunStatus;
  startedAt: number;
  completedAt: number;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  failure?: string;
  baselineDirectory?: string;
  baselineFiles?: number;
  checkpointOrder: "file-write-time";
  checkpointLimitReached: boolean;
  checkpointWarnings: string[];
  checkpoints: ScenarioCheckpointInput[];
  diagnostics: EngineDiagnostic[];
  diagnosticsComplete: boolean;
  outputExcerpt?: string;
  outputOmitted?: boolean;
}

interface StoredCheckpoint extends ScenarioCheckpointSummary {
  data?: string;
}

interface StoredRun extends Omit<ScenarioRunSummary, "checkpoints"> {
  checkpoints: StoredCheckpoint[];
}

const text = (value: unknown, limit: number) =>
  typeof value === "string" ? value.replace(/\0/g, "").slice(0, limit) : "";
const warning = (value: unknown) => text(value, MAX_WARNING).replace(/\s+/g, " ").trim();
const integer = (value: unknown, fallback: number, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;

function checkpointSummary({ data: _data, ...item }: StoredCheckpoint): ScenarioCheckpointSummary {
  return { ...item };
}

function runSummary(run: StoredRun): ScenarioRunSummary {
  return { ...run, checkpoints: run.checkpoints.map(checkpointSummary) };
}

export function parseScenarioDiagnostics(input: unknown): { diagnostics: EngineDiagnostic[]; complete: boolean } {
  const values = Array.isArray(input) ? input.slice(0, MAX_DIAGNOSTICS) : [];
  const result: EngineDiagnostic[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as Partial<EngineDiagnostic>;
    if (typeof item.message !== "string" || !item.message.trim()) continue;
    const severity = item.severity === "error" || item.severity === "warning" || item.severity === "info" ? item.severity : "unknown";
    const path = text(item.path, 4_096);
    const line = integer(item.line, 0, 1);
    result.push({
      severity,
      message: text(item.message, MAX_MESSAGE),
      ...(path ? { path } : {}),
      ...(line > 0 ? { line } : {}),
    });
  }
  return { diagnostics: result, complete: input === undefined || (Array.isArray(input) && input.length <= MAX_DIAGNOSTICS) };
}

function encodedPng(item: ScenarioCheckpointInput): string | undefined {
  if (typeof item.data !== "string" || !item.data || item.data.length > MAX_ENCODED_BYTES
    || item.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)) return undefined;
  const bytes = Buffer.from(item.data, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return undefined;
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return undefined;
  if (bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") return undefined;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== item.width || height !== item.height || width * height > MAX_PIXELS) return undefined;
  return item.data;
}

/**
 * Engine-rendered scenario checkpoints for one daemon lifetime. Runs and
 * checkpoints are project-scoped and bounded by count and encoded bytes. When
 * the budget is exceeded, complete oldest runs lose their images first and
 * keep their metadata; exact retrieval never substitutes another image.
 */
export class ScenarioRuns {
  readonly #projects = new Map<string, StoredRun[]>();
  readonly #maxProjects: number;
  readonly #maxRuns: number;
  readonly #maxProjectBytes: number;
  readonly #maxTotalBytes: number;

  constructor(options: ScenarioRunsOptions = {}) {
    this.#maxProjects = options.projects ?? MAX_PROJECTS;
    this.#maxRuns = options.runs ?? MAX_RUNS;
    this.#maxProjectBytes = options.projectBytes ?? MAX_PROJECT_BYTES;
    this.#maxTotalBytes = options.totalBytes ?? MAX_TOTAL_BYTES;
  }

  add(projectId: string, input: ScenarioRunInput): ScenarioRunSummary {
    const runId = randomUUID();
    const scenario = text(input.scenario, 200);
    const mode = input.mode === "regression" ? "regression" : "exploratory";
    const checkpointWarnings = input.checkpointWarnings.slice(0, MAX_WARNINGS).map(warning).filter(Boolean);
    const checkpoints: StoredCheckpoint[] = [];
    for (const item of input.checkpoints.slice(0, MAX_CHECKPOINTS)) {
      if (!item || typeof item !== "object") continue;
      if (!kinds.has(item.kind) || typeof item.name !== "string" || !item.name.trim()
        || typeof item.file !== "string" || !item.file.trim()
        || !Number.isSafeInteger(item.order) || item.order < 0
        || !Number.isSafeInteger(item.width) || item.width < 1 || item.width > 16_384
        || !Number.isSafeInteger(item.height) || item.height < 1 || item.height > 16_384
        || item.width * item.height > MAX_PIXELS
        || !Number.isSafeInteger(item.bytes) || item.bytes < 1
        || typeof item.capturedAt !== "number" || !Number.isFinite(item.capturedAt)) {
        checkpointWarnings.push(warning("Skipped a checkpoint whose reported metadata was invalid."));
        continue;
      }
      const data = item.data === undefined ? undefined : encodedPng(item);
      if (item.data !== undefined && data === undefined)
        checkpointWarnings.push(warning(`Skipped the image for ${item.name}; it was not a supported PNG within the retention limit.`));
      checkpoints.push({
        id: randomUUID(),
        runId,
        plugin: text(input.plugin, 200),
        scenario,
        name: text(item.name, 300),
        file: text(item.file, 300),
        kind: item.kind,
        mode,
        order: item.order,
        width: item.width,
        height: item.height,
        mediaType: "image/png",
        bytes: item.bytes,
        capturedAt: item.capturedAt,
        retained: data !== undefined,
        ...(data ? { data } : {}),
      });
    }
    checkpoints.sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
    const parsedDiagnostics = parseScenarioDiagnostics(input.diagnostics);
    const run: StoredRun = {
      id: runId,
      projectId,
      plugin: text(input.plugin, 200),
      pluginVersion: text(input.pluginVersion, 100),
      engineRunId: text(input.engineRunId, 40),
      scenario,
      ...(input.executedSelection ? { executedSelection: text(input.executedSelection, 200) } : {}),
      mode,
      status: statuses.has(input.status) ? input.status : "unknown",
      startedAt: typeof input.startedAt === "number" && Number.isFinite(input.startedAt) ? input.startedAt : Date.now(),
      completedAt: typeof input.completedAt === "number" && Number.isFinite(input.completedAt) ? input.completedAt : Date.now(),
      exitCode: input.exitCode === null || (typeof input.exitCode === "number" && Number.isSafeInteger(input.exitCode)) ? input.exitCode : null,
      timedOut: input.timedOut === true,
      cancelled: input.cancelled === true,
      ...(input.failure ? { failure: text(input.failure, MAX_MESSAGE) } : {}),
      ...(input.baselineDirectory ? { baselineDirectory: text(input.baselineDirectory, 300) } : {}),
      ...(input.baselineFiles !== undefined ? { baselineFiles: integer(input.baselineFiles, 0) } : {}),
      checkpointOrder: "file-write-time",
      checkpointLimitReached: input.checkpointLimitReached === true,
      checkpointWarnings: checkpointWarnings.slice(0, MAX_WARNINGS),
      checkpoints,
      diagnostics: parsedDiagnostics.diagnostics,
      diagnosticsComplete: input.diagnosticsComplete === true && parsedDiagnostics.complete,
      ...(input.outputExcerpt ? { outputExcerpt: text(input.outputExcerpt, MAX_OUTPUT) } : {}),
      ...(input.outputOmitted === true ? { outputOmitted: true } : {}),
    };
    const runs = [run, ...(this.#projects.get(projectId) ?? [])];
    while (runs.length > this.#maxRuns) runs.pop();
    this.#projects.delete(projectId);
    this.#projects.set(projectId, runs);
    while (this.#projects.size > this.#maxProjects) this.#projects.delete(this.#projects.keys().next().value!);
    this.#enforceProjectBudget(projectId);
    this.#enforceTotalBudget();
    return runSummary(run);
  }

  list(projectId: string): ScenarioRunSummary[] {
    return (this.#projects.get(projectId) ?? []).map(runSummary);
  }

  /** One checkpoint's metadata, retained or evicted. */
  find(projectId: string, checkpointId: string): ScenarioCheckpointSummary | undefined {
    for (const run of this.#projects.get(projectId) ?? []) {
      const found = run.checkpoints.find((item) => item.id === checkpointId);
      if (found) return checkpointSummary(found);
    }
    return undefined;
  }

  /** One exact retained checkpoint; undefined when it was evicted or is another project's. */
  get(projectId: string, checkpointId: string): ScenarioCheckpoint | undefined {
    for (const run of this.#projects.get(projectId) ?? []) {
      const found = run.checkpoints.find((item) => item.id === checkpointId);
      if (found?.data) return { ...checkpointSummary(found), data: found.data };
    }
    return undefined;
  }

  retainedBytes(projectId?: string): number {
    let total = 0;
    for (const [id, runs] of this.#projects) {
      if (projectId !== undefined && id !== projectId) continue;
      for (const run of runs) for (const checkpoint of run.checkpoints) total += checkpoint.data?.length ?? 0;
    }
    return total;
  }

  forget(projectId: string): void {
    this.#projects.delete(projectId);
  }

  #enforceProjectBudget(projectId: string): void {
    const runs = this.#projects.get(projectId);
    if (!runs) return;
    while (this.retainedBytes(projectId) > this.#maxProjectBytes) {
      const withImages = runs.filter((run) => run.checkpoints.some((item) => item.data));
      if (!withImages.length) return;
      if (withImages.length > 1) {
        // Keep the newest runs complete; an old run becomes metadata only.
        for (const checkpoint of withImages[withImages.length - 1]!.checkpoints) {
          if (!checkpoint.data) continue;
          checkpoint.retained = false;
          delete checkpoint.data;
        }
        continue;
      }
      // One run is larger than the project's whole budget. Retain its earliest
      // checkpoints and keep the later ones as metadata with an explicit flag.
      const run = withImages[0]!;
      const candidate = [...run.checkpoints].reverse().find((item) => item.data)!;
      candidate.retained = false;
      delete candidate.data;
    }
  }

  #enforceTotalBudget(): void {
    while (this.retainedBytes() > this.#maxTotalBytes) {
      let oldest: StoredRun | undefined;
      for (const runs of this.#projects.values()) {
        for (const run of runs) {
          if (!run.checkpoints.some((item) => item.data)) continue;
          if (!oldest || run.completedAt < oldest.completedAt) oldest = run;
        }
      }
      if (!oldest) return;
      for (const checkpoint of oldest.checkpoints) {
        if (!checkpoint.data) continue;
        checkpoint.retained = false;
        delete checkpoint.data;
      }
    }
  }
}

export function isScenarioRunStatus(value: unknown): value is ScenarioRunStatus {
  return typeof value === "string" && statuses.has(value as ScenarioRunStatus);
}

export function isScenarioCheckpointKind(value: unknown): value is ScenarioCheckpointKind {
  return typeof value === "string" && kinds.has(value as ScenarioCheckpointKind);
}

export function isScenarioRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID.test(value);
}
