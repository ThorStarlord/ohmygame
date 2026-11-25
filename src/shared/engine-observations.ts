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
/** Metadata for one person-authorized native window capture. */
export interface NativeWindowCaptureSummary {
  id: string;
  sessionId: string;
  capturedAt: number;
  width: number;
  height: number;
  title: string;
  hwnd: string;
  pid: number;
  mediaType: "image/png";
  analysis: PlaytestCapture["analysis"];
}

/** A retained capture; `data` is base64 PNG and only returned on request. */
export interface NativeWindowCapture extends NativeWindowCaptureSummary {
  data: string;
}

/** What the desktop capture adapter returns before the daemon gives it an ID. */
export type NativeWindowCaptureInput = Omit<NativeWindowCaptureSummary, "id" | "sessionId" | "capturedAt"> & {
  data: string;
};

export function isNativeWindowCaptureInput(value: unknown): value is NativeWindowCaptureInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<NativeWindowCaptureInput>;
  return typeof item.width === "number" && Number.isSafeInteger(item.width) && item.width > 0 && item.width <= 16_384
    && typeof item.height === "number" && Number.isSafeInteger(item.height) && item.height > 0 && item.height <= 16_384
    && typeof item.title === "string" && item.title.length <= 500
    && typeof item.hwnd === "string" && item.hwnd.length > 0 && item.hwnd.length <= 100
    && typeof item.pid === "number" && Number.isSafeInteger(item.pid) && item.pid > 0
    && item.mediaType === "image/png"
    && typeof item.data === "string" && item.data.length > 0 && item.data.length <= 12 * 1024 * 1024
    && typeof item.analysis === "object" && item.analysis !== null;
}

export interface EngineObservationSnapshot {
  projectId: string;
  observedAt: number;
  historyRetention: "daemon-memory";
  preview: Pick<PreviewRuntimeState, "status" | "phase" | "revision" | "startedAt" | "error"> & { diagnostics: PreviewDiagnostic[] };
  nativeSessions: NativeSessionView[];
  captures: NativeWindowCaptureSummary[];
  checks: EngineCheck[];
}
