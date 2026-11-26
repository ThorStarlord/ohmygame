import type { ApprovalDecision, ApprovalRequestDetails } from "../shared/agent-runtimes.js";
import type { NativeWindowCapture, ObservationGrantSummary } from "../shared/engine-observations.js";
import type { NativeSessionView } from "../shared/native-sessions.js";
import { NativeCaptureRequests } from "./native-capture-requests.js";
import {
  ObservationGrants,
  OBSERVATION_GRANT_DURATION_MS,
  OBSERVATION_GRANT_MAX_ATTEMPTS,
} from "./observation-grants.js";

export interface ObservationSessionServiceOptions {
  projectId: string;
  projectName: string;
  conversationId: string;
  sessions(): Promise<NativeSessionView[]>;
  askApproval(details: ApprovalRequestDetails, requestId: string, signal?: AbortSignal): Promise<ApprovalDecision>;
  requests: NativeCaptureRequests;
  grants: ObservationGrants;
  now?: () => number;
}

/**
 * The bounded observation workflow used by the app and its agent tools. The
 * person approves one session and its limits; the agent then decides when to
 * admit each permitted capture. Nothing is approved automatically.
 */
export class ObservationSessionService {
  readonly #now: () => number;

  constructor(private readonly options: ObservationSessionServiceOptions) {
    this.#now = options.now ?? (() => Date.now());
  }

  async start(sessionId: string, purpose: string, toolCallId: string, signal?: AbortSignal): Promise<ObservationGrantSummary> {
    const first = await this.#runningSession(sessionId);
    if (this.options.grants.list(this.options.projectId)
      .some((grant) => grant.sessionId === sessionId && grant.status === "active"))
      throw new Error("An observation session is already active for this game session. Use its grantId or end it first.");
    const expiresAt = this.#now() + OBSERVATION_GRANT_DURATION_MS;
    const details: ApprovalRequestDetails = {
      kind: "tool",
      tool: "engine_observation_start",
      title: "Observation session requested",
      reason: purpose.trim() || `The coding agent wants to inspect the running ${first.label} game.`,
      nativeObservation: {
        project: this.options.projectName,
        session: first.label,
        purpose: purpose.trim() || `Inspect the running ${first.label} game.`,
        maxAttempts: OBSERVATION_GRANT_MAX_ATTEMPTS,
        expiresAt,
        operation: "still",
      },
    };
    const decision = await this.options.askApproval(details, `native-observation:${toolCallId}`, signal);
    signal?.throwIfAborted();
    if (decision !== "allow") throw new Error("The person did not authorize this observation session.");
    const current = await this.#runningSession(sessionId);
    if (current.pid !== first.pid)
      throw new Error("The game session changed after the person authorized observation. Request a new authorization.");
    return this.options.grants.create({
      projectId: this.options.projectId,
      conversationId: this.options.conversationId,
      sessionId: current.id,
      sessionLabel: current.label,
      ...(current.plugin ? { plugin: current.plugin } : {}),
      rootPid: current.pid!,
      purpose: purpose.trim() || `Inspect the running ${current.label} game.`,
      maxAttempts: OBSERVATION_GRANT_MAX_ATTEMPTS,
      expiresAt,
    });
  }

  async status(grantId?: string): Promise<ObservationGrantSummary[]> {
    const running = new Set((await this.options.sessions())
      .filter((session) => session.state === "running" && session.pid !== undefined)
      .map((session) => session.id));
    for (const grant of this.options.grants.list(this.options.projectId, this.options.conversationId)) {
      if (!running.has(grant.sessionId)) this.options.grants.invalidateSession(this.options.projectId, grant.sessionId);
    }
    if (grantId) {
      const grant = this.options.grants.get(this.options.projectId, this.options.conversationId, grantId);
      if (!grant) throw new Error("That observation session is not available in this conversation.");
      return [grant];
    }
    return this.options.grants.list(this.options.projectId, this.options.conversationId);
  }

  async capture(grantId: string, signal?: AbortSignal): Promise<{ capture: NativeWindowCapture; grant: ObservationGrantSummary }> {
    const grant = this.options.grants.get(this.options.projectId, this.options.conversationId, grantId);
    if (!grant) throw new Error("That observation session is not available in this conversation.");
    signal?.throwIfAborted();
    const session = await this.#runningSession(grant.sessionId);
    // Admission is synchronous and consumes one attempt before any capture starts.
    this.options.grants.admit({
      projectId: this.options.projectId,
      conversationId: this.options.conversationId,
      grantId,
      sessionId: session.id,
      rootPid: session.pid!,
    });
    try {
      const capture = await this.options.requests.request(this.options.projectId, {
        sessionId: session.id,
        rootPid: session.pid!,
        label: session.label,
        grantId,
      }, signal);
      const completed = this.options.grants.complete(this.options.projectId, grantId, "completed");
      return { capture, grant: completed ?? grant };
    } catch (error) {
      this.options.grants.complete(this.options.projectId, grantId, "failed");
      throw error;
    }
  }

  end(grantId: string, status: "ended" | "revoked" = "ended"): ObservationGrantSummary {
    const grant = this.options.grants.end(this.options.projectId, this.options.conversationId, grantId, status);
    if (!grant) throw new Error("That observation session is not available in this conversation.");
    this.options.requests.cancelGrant(this.options.projectId, grantId);
    return grant;
  }

  async #runningSession(sessionId: string): Promise<NativeSessionView & { pid: number }> {
    const session = (await this.options.sessions()).find((item) => item.id === sessionId);
    if (!session) throw new Error("That managed native session is no longer retained for this project.");
    if (session.state !== "running" || session.pid === undefined)
      throw new Error("That managed native session is not running. Start the game and request a new observation.");
    return { ...session, pid: session.pid };
  }
}
