import type { NativeSessionView } from "./native-sessions.js";
import type { PreviewRuntimeState } from "./contracts.js";
import type { PreviewDiagnostic } from "./preview-diagnostics.js";
import type { PlaytestCapture } from "./playtest.js";

export type EngineCheckOperation = "lint" | "compile" | "test" | "export";
export type EngineCheckStatus = "running" | "passed" | "failed" | "unknown" | "cancelled" | "invocation-error";

export interface EngineDiagnostic {
  severity: "error" | "warning" | "info" | "unknown";
  message: string;
  path?: string;
  line?: number;
}
export interface EngineDiagnosticComparison {
  previousRunId: string;
  recurring: number;
  newlyReported: number;
  noLongerReported: number;
}
export interface EngineCheck {
  id: string;
  plugin: string;
  version: string;
  operation: EngineCheckOperation;
  /** The exact scenario and observation mode a test check observed, when it did. */
  subject?: string;
  startedAt: number;
  completedAt?: number;
  status: EngineCheckStatus;
  sourceFreshness: "unknown";
  exitCode?: number | null;
  /** The engine reported at least one error even though its exit code may be 0. */
  reportedErrors?: boolean;
  diagnostics: EngineDiagnostic[];
  /** Whether the supported extraction was bounded or truncated, not complete engine coverage. */
  diagnosticsComplete: boolean;
  outputExcerpt?: string;
  outputOmitted?: boolean;
  validationCopy?: boolean;
  compiledArtifacts?: number;
  cleanupWarning?: string;
  failure?: string;
  comparison?: EngineDiagnosticComparison;
}
export type ScenarioRunMode = "exploratory" | "regression";
export type ScenarioRunStatus = "passed" | "failed" | "skipped" | "timed-out" | "cancelled" | "not-found" | "invocation-error" | "unknown";
export type ScenarioCheckpointKind = "exploratory" | "mismatched" | "no-baseline" | "difference";

/** One engine-rendered screenshot produced by a scripted scenario run. */
export interface ScenarioCheckpointSummary {
  id: string;
  runId: string;
  plugin: string;
  scenario: string;
  /** The screenshot statement's stable name within the run, without its extension. */
  name: string;
  /** The engine-created file, relative to the run's checkpoint folder. */
  file: string;
  kind: ScenarioCheckpointKind;
  mode: ScenarioRunMode;
  /** File-write order within this run; the engine does not expose a step counter. */
  order: number;
  width: number;
  height: number;
  mediaType: "image/png";
  bytes: number;
  /** The time the engine wrote the file, not the exact frame time. */
  capturedAt: number;
  /** False when no image is retained: bounded retention evicted it, or it was missing/invalid at ingestion. Run warnings say which. */
  retained: boolean;
}

/** A retained checkpoint; `data` is base64 PNG and only returned on request. */
export interface ScenarioCheckpoint extends ScenarioCheckpointSummary {
  data: string;
}

/** One scripted scenario execution and its checkpoint evidence. */
export interface ScenarioRunSummary {
  id: string;
  projectId: string;
  plugin: string;
  pluginVersion: string;
  /** The run identity the plugin used for its staging files. */
  engineRunId: string;
  scenario: string;
  /** The selection the engine itself reported as running, when it did. */
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
  /** Baseline files available to the engine; not a count of screenshots that matched. */
  baselineFiles?: number;
  checkpointOrder: "file-write-time";
  checkpointLimitReached: boolean;
  checkpointWarnings: string[];
  checkpoints: ScenarioCheckpointSummary[];
  diagnostics: EngineDiagnostic[];
  diagnosticsComplete: boolean;
  outputExcerpt?: string;
  outputOmitted?: boolean;
}

export interface ScenarioSummary {
  name: string;
  kind: "testcase" | "testsuite";
  file?: string;
  line?: number;
  parameterized: boolean;
  default: boolean;
}

/** The engine-registered scenarios a project can select. */
export interface ScenarioDiscovery {
  status: ScenarioRunStatus;
  authority: "engine";
  scenarios: ScenarioSummary[];
  truncated: boolean;
  exitCode: number | null;
  errors: string[];
  diagnostics: EngineDiagnostic[];
  diagnosticsComplete: boolean;
  outputExcerpt?: string;
  outputOmitted?: boolean;
  failure?: string;
}

export type ObservationGrantStatus = "active" | "exhausted" | "expired" | "revoked" | "ended" | "invalidated";

/** A bounded, person-authorized observation session for one native session. */
export interface ObservationGrantSummary {
  id: string;
  sessionId: string;
  sessionLabel: string;
  plugin?: string;
  purpose: string;
  maxAttempts: number;
  /** Admitted attempts, including ones that later failed. */
  admitted: number;
  completed: number;
  failed: number;
  remaining: number;
  inFlight: boolean;
  createdAt: number;
  expiresAt: number;
  status: ObservationGrantStatus;
}

/** Metadata for one person-authorized native window capture. */
export interface NativeWindowCaptureSummary {
  id: string;
  sessionId: string;
  /** The one-time agent request this capture satisfied, when one did. */
  requestId?: string;
  /** The delegated observation grant this capture was admitted under, when any. */
  grantId?: string;
  /** The plugin that owned the native session, for provenance. */
  plugin?: string;
  capturedAt: number;
  width: number;
  height: number;
  title: string;
  hwnd: string;
  /** The managed session root process. */
  rootPid: number;
  /** The process that owns the captured window; it may be a descendant. */
  pid: number;
  mediaType: "image/png";
  analysis: PlaytestCapture["analysis"];
}

/** A retained capture; `data` is base64 PNG and only returned on request. */
export interface NativeWindowCapture extends NativeWindowCaptureSummary {
  data: string;
}

/** What the desktop capture adapter returns before the daemon gives it an ID. */
export type NativeWindowCaptureInput = Omit<NativeWindowCaptureSummary, "id" | "sessionId" | "capturedAt" | "requestId" | "grantId" | "plugin"> & {
  data: string;
};

const NATIVE_CAPTURE_KEYS = new Set([
  "width", "height", "title", "hwnd", "rootPid", "pid", "mediaType", "analysis", "data",
]);

export function isNativeWindowCaptureInput(value: unknown): value is NativeWindowCaptureInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<NativeWindowCaptureInput>;
  if (Object.keys(item).some((key) => !NATIVE_CAPTURE_KEYS.has(key))) return false;
  const analysis = item.analysis as Partial<PlaytestCapture["analysis"]> | undefined;
  return typeof item.width === "number" && Number.isSafeInteger(item.width) && item.width > 0 && item.width <= 16_384
    && typeof item.height === "number" && Number.isSafeInteger(item.height) && item.height > 0 && item.height <= 16_384
    && typeof item.title === "string" && item.title.length <= 500
    && typeof item.hwnd === "string" && /^\d{1,20}$/.test(item.hwnd)
    && typeof item.rootPid === "number" && Number.isSafeInteger(item.rootPid) && item.rootPid > 0
    && typeof item.pid === "number" && Number.isSafeInteger(item.pid) && item.pid > 0
    && item.mediaType === "image/png"
    && typeof item.data === "string" && item.data.length > 0 && item.data.length <= 16 * 1024 * 1024
    && item.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(item.data)
    && !!analysis && typeof analysis === "object"
    && typeof analysis.sampledPixels === "number" && Number.isSafeInteger(analysis.sampledPixels) && analysis.sampledPixels >= 0
    && typeof analysis.opaqueRatio === "number" && analysis.opaqueRatio >= 0 && analysis.opaqueRatio <= 1
    && typeof analysis.luminanceMean === "number" && analysis.luminanceMean >= 0
    && typeof analysis.luminanceVariance === "number" && analysis.luminanceVariance >= 0
    && typeof analysis.likelyBlank === "boolean";
}

export interface EngineObservationSnapshot {
  projectId: string;
  observedAt: number;
  historyRetention: "daemon-memory";
  preview: Pick<PreviewRuntimeState, "status" | "phase" | "revision" | "startedAt" | "error"> & { diagnostics: PreviewDiagnostic[] };
  nativeSessions: NativeSessionView[];
  captures: NativeWindowCaptureSummary[];
  observationGrants: ObservationGrantSummary[];
  /** True when the project has an active Ren'Py plugin with scenario execution. */
  scenarioPlaytestsAvailable: boolean;
  scenarioRuns: ScenarioRunSummary[];
  checks: EngineCheck[];
}
