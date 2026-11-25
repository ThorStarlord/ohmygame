// A native engine process that a plugin starts through the extension host.
// The host owns the process and its hold on the host's lifetime; the daemon
// exposes the state and can stop it for the project that owns it.

export type NativeSessionState = "starting" | "running" | "stopping" | "exited" | "failed";

/** What a plugin asks the host to run: an engine executable it already resolved. */
export interface NativeSessionStart {
  executable: string;
  args: string[];
  /** Defaults to the project folder. */
  cwd?: string;
  /** Shown in the app, such as "Ren'Py" or "Godot". */
  label?: string;
  /** Explicitly observe this owned child's output. Default: no output capture. */
  captureOutput?: boolean;
}

export interface NativeSessionOutput {
  stdout: string;
  stderr: string;
  /** Earlier output or the final drain may have been omitted. */
  omitted: boolean;
}

export function isNativeSessionOutput(value: unknown): value is NativeSessionOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const output = value as Partial<NativeSessionOutput>;
  return typeof output.stdout === "string" && output.stdout.length <= 4_096 &&
    typeof output.stderr === "string" && output.stderr.length <= 4_096 &&
    typeof output.omitted === "boolean";
}

/** What the project and its windows see about a session. */
export interface NativeSessionView {
  id: string;
  plugin: string;
  label: string;
  state: NativeSessionState;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  /** Why a launch or an unexpected exit failed. */
  error?: string;
  /** True when the person or the project asked it to stop. */
  stopped?: boolean;
  /** Only in an explicit project observation, not the ordinary session list. */
  output?: NativeSessionOutput;
}

/** The handle a plugin's native code receives. */
export interface PluginNativeSession {
  readonly id: string;
  readonly pid: number;
  readonly label: string;
  /** Stops this session and its process tree. */
  stop(): Promise<void>;
  /** Resolves when the process exits, including after `stop()`. */
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
}

export const NATIVE_SESSION_MAX_ARGS = 64;
export const NATIVE_SESSION_MAX_ARG_CHARS = 4_096;
export const NATIVE_SESSION_MAX_PATH_CHARS = 4_096;
export const NATIVE_SESSION_MAX_LABEL_CHARS = 120;

const hasNul = (value: string) => value.includes("\0");

/** Returns why a start request is invalid, or undefined when it can run. */
export function nativeSessionStartIssue(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "A native session needs start options";
  const start = value as Partial<NativeSessionStart>;
  if (typeof start.executable !== "string" || !start.executable.trim() || start.executable.length > NATIVE_SESSION_MAX_PATH_CHARS || hasNul(start.executable))
    return "A native session needs a bounded executable path";
  if (!Array.isArray(start.args) || start.args.length > NATIVE_SESSION_MAX_ARGS)
    return `A native session takes at most ${NATIVE_SESSION_MAX_ARGS} arguments`;
  if (start.args.some((arg) => typeof arg !== "string" || arg.length > NATIVE_SESSION_MAX_ARG_CHARS || hasNul(arg)))
    return "Every native session argument must be a bounded string";
  if (start.cwd !== undefined && (typeof start.cwd !== "string" || !start.cwd.trim() || start.cwd.length > NATIVE_SESSION_MAX_PATH_CHARS || hasNul(start.cwd)))
    return "The working folder must be a bounded path";
  if (start.label !== undefined && (typeof start.label !== "string" || !start.label.trim() || start.label.length > NATIVE_SESSION_MAX_LABEL_CHARS || hasNul(start.label)))
    return "The session label must be a bounded string";
  if (start.captureOutput !== undefined && typeof start.captureOutput !== "boolean") return "Native output capture must be a boolean";
  return undefined;
}

const STATES: readonly NativeSessionState[] = ["starting", "running", "stopping", "exited", "failed"];

export function isNativeSessionView(value: unknown): value is NativeSessionView {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const session = value as Partial<NativeSessionView>;
  return (
    typeof session.id === "string" && session.id.length > 0 && session.id.length <= 100 &&
    typeof session.plugin === "string" && session.plugin.length > 0 && session.plugin.length <= 200 &&
    typeof session.label === "string" && session.label.length > 0 && session.label.length <= NATIVE_SESSION_MAX_LABEL_CHARS &&
    STATES.includes(session.state as NativeSessionState) &&
    (session.pid === undefined || (Number.isInteger(session.pid) && session.pid > 0)) &&
    typeof session.startedAt === "number" && Number.isFinite(session.startedAt) &&
    (session.endedAt === undefined || (typeof session.endedAt === "number" && Number.isFinite(session.endedAt))) &&
    (session.exitCode === undefined || session.exitCode === null || Number.isInteger(session.exitCode)) &&
    (session.signal === undefined || session.signal === null || (typeof session.signal === "string" && session.signal.length <= 64)) &&
    (session.error === undefined || (typeof session.error === "string" && session.error.length <= 2_000)) &&
    (session.stopped === undefined || typeof session.stopped === "boolean") &&
    (session.output === undefined || isNativeSessionOutput(session.output))
  );
}
