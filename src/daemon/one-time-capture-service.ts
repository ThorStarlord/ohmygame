import type { ApprovalDecision, ApprovalRequestDetails } from "../shared/agent-runtimes.js";
import type { NativeWindowCapture } from "../shared/engine-observations.js";
import type { NativeSessionView } from "../shared/native-sessions.js";
import { NativeCaptureRequests } from "./native-capture-requests.js";

export interface OneTimeCaptureOptions {
  projectId: string;
  projectName: string;
  conversationId: string;
  sessionId: string;
  reason?: string;
  toolCallId: string;
  sessions(): Promise<NativeSessionView[]>;
  askApproval(details: ApprovalRequestDetails, requestId: string, signal?: AbortSignal): Promise<ApprovalDecision>;
  requests: NativeCaptureRequests;
  signal?: AbortSignal;
}

/**
 * The existing one-time capture path, extracted so the app and its connected
 * integration test use the same approval and session revalidation. Nothing is
 * remembered; every call asks again.
 */
export async function requestOneTimeCapture(options: OneTimeCaptureOptions): Promise<NativeWindowCapture> {
  const session = await runningSession(options.sessions, options.sessionId);
  const details: ApprovalRequestDetails = {
    kind: "tool",
    tool: "engine_capture_request",
    title: "Visual observation requested",
    reason: options.reason?.trim() || `The coding agent wants to inspect the running ${session.label} game.`,
    nativeCapture: { project: options.projectName, session: session.label, operation: "still" },
  };
  const decision = await options.askApproval(details, `native-capture:${options.toolCallId}`, options.signal);
  options.signal?.throwIfAborted();
  if (decision !== "allow") throw new Error("The person did not allow this visual observation request.");
  const current = await runningSession(options.sessions, options.sessionId);
  if (current.pid !== session.pid)
    throw new Error("The native session changed after the person allowed the observation. Request a new one.");
  return options.requests.request(options.projectId, {
    sessionId: current.id,
    rootPid: current.pid,
    label: current.label,
  }, options.signal);
}

async function runningSession(sessions: () => Promise<NativeSessionView[]>, sessionId: string): Promise<NativeSessionView & { pid: number }> {
  const session = (await sessions()).find((item) => item.id === sessionId);
  if (!session) throw new Error("That managed native session is no longer retained for this project.");
  if (session.state !== "running" || session.pid === undefined)
    throw new Error("That managed native session is not running. Start the game and request a new observation.");
  return { ...session, pid: session.pid };
}
