import { randomUUID } from "node:crypto";
import type { EngineCheck, EngineDiagnostic, EngineDiagnosticComparison, EngineCheckOperation } from "../shared/engine-observations.js";

const MAX_PROJECTS = 24;
const MAX_RUNS = 8;
const MAX_DIAGNOSTICS = 50;
const MAX_MESSAGE = 2_000;
const MAX_OUTPUT = 8_192;
const now = () => performance.timeOrigin + performance.now();

type Redact = (text: string) => string;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function renpyCheckOperation(plugin: string, tool: string): EngineCheckOperation | undefined {
  if (plugin !== "thorstarlord/renpy") return undefined;
  switch (tool) {
    case "renpy_lint": return "lint";
    case "renpy_compile": return "compile";
    case "renpy_test": return "test";
    case "renpy_export_web": return "export";
    default: return undefined;
  }
}

function scriptPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4_096 && /^game\//.test(value)
    && /\.(?:rpy|rpym|py)$/i.test(value) && !/[\\:\0]/.test(value)
    && !value.split("/").some((part) => part === "" || part === ".." || part === ".")
    && !/^game\/(?:saves|cache)(?:\/|$)/i.test(value);
}

function diagnosticsOf(result: Record<string, unknown>, redact: Redact): { diagnostics: EngineDiagnostic[]; complete: boolean } {
  const structured = Array.isArray(result.diagnostics);
  const values: unknown[] = structured ? result.diagnostics as unknown[]
    : Array.isArray(result.errors) ? result.errors : [];
  const diagnostics: EngineDiagnostic[] = [];
  let complete = structured && result.outputTruncated === false && result.diagnosticsTruncated === false && values.length <= MAX_DIAGNOSTICS;
  for (const value of values.slice(0, MAX_DIAGNOSTICS)) {
    const item: Record<string, unknown> | undefined = typeof value === "string" ? { message: value, severity: "unknown" } : record(value);
    if (!item || typeof item.message !== "string" || !item.message.trim()) { complete = false; continue; }
    const severity = item.severity === "error" || item.severity === "warning" || item.severity === "info" ? item.severity : "unknown";
    const message = redact(item.message);
    if (message.length > MAX_MESSAGE) complete = false;
    const source = scriptPath(item.path) && typeof item.line === "number" && Number.isSafeInteger(item.line) && item.line > 0 && redact(item.path) === item.path
      ? { path: item.path, line: item.line } : {};
    diagnostics.push({ severity, message: message.slice(0, MAX_MESSAGE), ...source });
  }
  return { diagnostics, complete };
}

function diagnosticKey(item: EngineDiagnostic): string {
  return JSON.stringify([item.severity, item.path ?? null, item.line ?? null, item.message]);
}

/** A reported difference, never a claim of repair, source freshness or full coverage. */
export function compareReportedChecks(current: EngineCheck, previous: EngineCheck): EngineDiagnosticComparison | undefined {
  if (current.plugin !== previous.plugin || current.version !== previous.version || current.operation !== previous.operation
    || !current.diagnosticsComplete || !previous.diagnosticsComplete
    || (current.status !== "passed" && current.status !== "failed")
    || (previous.status !== "passed" && previous.status !== "failed")
    || !previous.completedAt || previous.completedAt > current.startedAt) return undefined;
  const counts = new Map<string, number>();
  for (const item of previous.diagnostics) {
    const key = diagnosticKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let recurring = 0;
  for (const item of current.diagnostics) {
    const key = diagnosticKey(item);
    const count = counts.get(key) ?? 0;
    if (count > 0) { recurring += 1; counts.set(key, count - 1); }
  }
  return { previousRunId: previous.id, recurring, newlyReported: current.diagnostics.length - recurring, noLongerReported: previous.diagnostics.length - recurring };
}

/** Bounded, daemon-local evidence; never writes to the project or starts an engine. */
export class EngineCheckHistory {
  readonly #projects = new Map<string, EngineCheck[]>();

  begin(folder: string, plugin: string, version: string, operation: EngineCheckOperation): string {
    const runs = this.#projects.get(folder) ?? [];
    const id = randomUUID();
    runs.unshift({ id, plugin, version, operation, startedAt: now(), status: "running", sourceFreshness: "unknown", diagnostics: [], diagnosticsComplete: false });
    runs.splice(MAX_RUNS);
    this.#projects.delete(folder);
    this.#projects.set(folder, runs);
    while (this.#projects.size > MAX_PROJECTS) this.#projects.delete(this.#projects.keys().next().value!);
    return id;
  }

  complete(folder: string, id: string, value: unknown, redact: Redact): void {
    const result = record(value);
    if (!result) { this.fail(folder, id, "Engine returned no structured result", false, redact); return; }
    const exitCode = typeof result.exitCode === "number" && Number.isInteger(result.exitCode) ? result.exitCode : null;
    const { diagnostics, complete } = diagnosticsOf(result, redact);
    const output = typeof result.output === "string" ? redact(result.output) : "";
    this.#settle(folder, id, {
      status: exitCode === 0 ? "passed" : exitCode === null ? "unknown" : "failed",
      exitCode, diagnostics, diagnosticsComplete: complete,
      outputExcerpt: output.slice(-MAX_OUTPUT), outputOmitted: result.outputTruncated !== false || typeof result.output !== "string" || result.output.length > MAX_OUTPUT || output.length > MAX_OUTPUT,
      ...(result.validationCopy === true ? { validationCopy: true } : {}),
      ...(typeof result.compiledArtifacts === "number" && Number.isSafeInteger(result.compiledArtifacts) && result.compiledArtifacts >= 0 ? { compiledArtifacts: result.compiledArtifacts } : {}),
      ...(typeof result.cleanupWarning === "string" ? { cleanupWarning: redact(result.cleanupWarning).slice(0, MAX_MESSAGE) } : {}),
    });
  }

  fail(folder: string, id: string, message: string, cancelled: boolean, redact: Redact): void {
    this.#settle(folder, id, { status: cancelled ? "cancelled" : "invocation-error", failure: redact(message).slice(0, MAX_MESSAGE) });
  }

  #settle(folder: string, id: string, patch: Partial<EngineCheck>): void {
    const runs = this.#projects.get(folder);
    const run = runs?.find((candidate) => candidate.id === id);
    if (run?.status === "running") Object.assign(run, patch, { completedAt: now() });
  }

  read(folder: string): EngineCheck[] {
    const runs = structuredClone(this.#projects.get(folder) ?? []);
    for (let index = 0; index < runs.length; index += 1) {
      const current = runs[index]!;
      const previous = runs.slice(index + 1).find((run) => run.plugin === current.plugin && run.operation === current.operation);
      if (!previous) continue;
      const comparison = compareReportedChecks(current, previous);
      if (comparison) current.comparison = comparison;
    }
    return runs;
  }

  forget(folder: string): void { this.#projects.delete(folder); }
}
