import type { NativeSessionView } from "./native-sessions.js";
import type { PreviewRuntimeState } from "./contracts.js";
import type { PreviewDiagnostic } from "./preview-diagnostics.js";

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
  startedAt: number;
  completedAt?: number;
  status: EngineCheckStatus;
  sourceFreshness: "unknown";
  exitCode?: number | null;
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
export interface EngineObservationSnapshot {
  projectId: string;
  observedAt: number;
  historyRetention: "daemon-memory";
  preview: Pick<PreviewRuntimeState, "status" | "phase" | "revision" | "startedAt" | "error"> & { diagnostics: PreviewDiagnostic[] };
  nativeSessions: NativeSessionView[];
  checks: EngineCheck[];
}
