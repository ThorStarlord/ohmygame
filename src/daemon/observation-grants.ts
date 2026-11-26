import { randomUUID } from "node:crypto";
import type { ObservationGrantStatus, ObservationGrantSummary } from "../shared/engine-observations.js";

/** Initial delegated-observation limits; a person sees these before authorizing. */
export const OBSERVATION_GRANT_MAX_ATTEMPTS = 3;
export const OBSERVATION_GRANT_DURATION_MS = 10 * 60_000;

const MAX_GRANTS_PER_PROJECT = 16;
const TERMINAL_RETENTION_MS = 60 * 60_000;

interface ObservationGrantRecord extends Omit<ObservationGrantSummary, "status"> {
  projectId: string;
  conversationId: string;
  rootPid: number;
  state: ObservationGrantStatus;
  endedAt?: number;
}

export interface ObservationGrantsOptions {
  now?: () => number;
}

function summary(record: ObservationGrantRecord, now: number): ObservationGrantSummary {
  const status: ObservationGrantStatus = record.state !== "active"
    ? record.state
    : now >= record.expiresAt
      ? "expired"
      : record.admitted >= record.maxAttempts && !record.inFlight
        ? "exhausted"
        : "active";
  return {
    id: record.id,
    sessionId: record.sessionId,
    sessionLabel: record.sessionLabel,
    ...(record.plugin ? { plugin: record.plugin } : {}),
    purpose: record.purpose,
    maxAttempts: record.maxAttempts,
    admitted: record.admitted,
    completed: record.completed,
    failed: record.failed,
    remaining: Math.max(0, record.maxAttempts - record.admitted),
    inFlight: record.inFlight,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    status,
  };
}

/**
 * Bounded, in-memory observation authority for one daemon lifetime. Each grant
 * is bound to one project, conversation, native session and root process. It
 * is not persisted, cannot be transferred to a replacement session, and is
 * removed on project close or daemon restart.
 */
export class ObservationGrants {
  readonly #projects = new Map<string, ObservationGrantRecord[]>();
  readonly #now: () => number;

  constructor(options: ObservationGrantsOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  /** Create a grant after the person authorized the exact session and limits. */
  create(input: {
    projectId: string;
    conversationId: string;
    sessionId: string;
    sessionLabel: string;
    plugin?: string;
    rootPid: number;
    purpose: string;
    maxAttempts?: number;
    durationMs?: number;
    /** The absolute time the person saw and approved; never extended after approval. */
    expiresAt?: number;
  }): ObservationGrantSummary {
    const now = this.#now();
    const purpose = input.purpose.trim();
    if (!purpose) throw new Error("An observation authorization needs a purpose.");
    const expiresAt = input.expiresAt ?? now + (input.durationMs ?? OBSERVATION_GRANT_DURATION_MS);
    if (expiresAt <= now) throw new Error("The observation authorization expired before it could be created.");
    const grants = this.#projects.get(input.projectId) ?? [];
    const current = grants
      .map((grant) => summary(grant, now))
      .find((grant) => grant.sessionId === input.sessionId && grant.status === "active");
    if (current) throw new Error("An observation session is already active for this game session. End it before requesting another.");
    // An exhausted grant has no authority left; retire it when the person
    // explicitly authorizes a new one for the same session.
    for (const grant of grants) {
      if (grant.sessionId === input.sessionId && summary(grant, now).status === "exhausted") {
        grant.state = "ended";
        grant.endedAt = now;
      }
    }
    const record: ObservationGrantRecord = {
      id: randomUUID(),
      projectId: input.projectId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      sessionLabel: input.sessionLabel,
      ...(input.plugin ? { plugin: input.plugin } : {}),
      rootPid: input.rootPid,
      purpose,
      maxAttempts: input.maxAttempts ?? OBSERVATION_GRANT_MAX_ATTEMPTS,
      admitted: 0,
      completed: 0,
      failed: 0,
      remaining: input.maxAttempts ?? OBSERVATION_GRANT_MAX_ATTEMPTS,
      inFlight: false,
      createdAt: now,
      expiresAt,
      state: "active",
    };
    const next = [record, ...grants];
    while (next.length > MAX_GRANTS_PER_PROJECT) {
      const terminal = [...next].reverse().find((grant) => summary(grant, now).status !== "active");
      if (!terminal) throw new Error("Too many active observation sessions for this project. End one first.");
      next.splice(next.indexOf(terminal), 1);
    }
    this.#projects.delete(input.projectId);
    this.#projects.set(input.projectId, next);
    return summary(record, now);
  }

  /** Current, still usable authority for a conversation, newest first. */
  list(projectId: string, conversationId?: string): ObservationGrantSummary[] {
    const now = this.#now();
    this.#prune(projectId, now);
    return (this.#projects.get(projectId) ?? [])
      .filter((grant) => conversationId === undefined || grant.conversationId === conversationId)
      .map((grant) => summary(grant, now))
      .filter((grant) => grant.status === "active" || grant.status === "exhausted");
  }

  /** One grant, including a terminal state, when it belongs to this conversation. */
  get(projectId: string, conversationId: string, grantId: string): ObservationGrantSummary | undefined {
    const now = this.#now();
    const grant = this.#projects.get(projectId)?.find((item) => item.id === grantId);
    return grant?.conversationId === conversationId ? summary(grant, now) : undefined;
  }

  /**
   * Atomically consume one attempt and mark it in flight. Every eligibility
   * check happens before the counter changes, so concurrent calls cannot
   * exceed the approved budget.
   */
  admit(input: {
    projectId: string;
    conversationId: string;
    grantId: string;
    sessionId: string;
    rootPid: number;
  }): ObservationGrantSummary {
    const now = this.#now();
    const grant = this.#projects.get(input.projectId)?.find((item) => item.id === input.grantId);
    if (!grant || grant.conversationId !== input.conversationId)
      throw new Error("That observation session is not available in this conversation.");
    const current = summary(grant, now);
    if (current.status === "expired") throw new Error("The observation session has expired. Request a new authorization.");
    if (current.status === "revoked" || current.status === "ended" || current.status === "invalidated")
      throw new Error("The observation session is no longer active.");
    if (current.status === "exhausted" || current.remaining <= 0)
      throw new Error("The observation session has no capture attempts left. Request a new authorization.");
    if (grant.inFlight) throw new Error("An observation from this session is already in progress.");
    if (grant.sessionId !== input.sessionId || grant.rootPid !== input.rootPid)
      throw new Error("The game session changed. Request a new observation authorization.");
    grant.admitted += 1;
    grant.inFlight = true;
    return summary(grant, now);
  }

  /** Record the outcome of an admitted attempt; the attempt stays consumed either way. */
  complete(projectId: string, grantId: string, outcome: "completed" | "failed"): ObservationGrantSummary | undefined {
    const grant = this.#projects.get(projectId)?.find((item) => item.id === grantId);
    if (!grant) return undefined;
    if (grant.inFlight) {
      grant.inFlight = false;
      if (outcome === "completed") grant.completed += 1;
      else grant.failed += 1;
    }
    return summary(grant, this.#now());
  }

  /** End a grant, preventing further admissions. An in-flight capture may still settle unless cancelled separately. */
  end(projectId: string, conversationId: string, grantId: string, status: "ended" | "revoked" = "ended"): ObservationGrantSummary | undefined {
    const grant = this.#projects.get(projectId)?.find((item) => item.id === grantId);
    if (!grant || grant.conversationId !== conversationId) return undefined;
    if (grant.state === "active") {
      grant.state = status;
      grant.endedAt = this.#now();
    }
    return summary(grant, this.#now());
  }

  /** The person can revoke any active grant in the project immediately. */
  revoke(projectId: string, grantId: string): ObservationGrantSummary | undefined {
    const grant = this.#projects.get(projectId)?.find((item) => item.id === grantId);
    if (!grant) return undefined;
    if (grant.state === "active") {
      grant.state = "revoked";
      grant.endedAt = this.#now();
    }
    return summary(grant, this.#now());
  }

  /** Managed-session termination invalidates every grant bound to it. */
  invalidateSession(projectId: string, sessionId: string): string[] {
    return this.#invalidate(projectId, (grant) => grant.sessionId === sessionId, "invalidated");
  }

  /** Archiving or deleting a conversation invalidates grants made from it. */
  invalidateConversation(projectId: string, conversationId: string): string[] {
    return this.#invalidate(projectId, (grant) => grant.conversationId === conversationId, "invalidated");
  }

  forget(projectId: string): void {
    this.#projects.delete(projectId);
  }

  #invalidate(projectId: string, matches: (grant: ObservationGrantRecord) => boolean, state: ObservationGrantStatus): string[] {
    const invalidated: string[] = [];
    for (const grant of this.#projects.get(projectId) ?? []) {
      if (grant.state !== "active" || !matches(grant)) continue;
      grant.state = state;
      grant.endedAt = this.#now();
      invalidated.push(grant.id);
    }
    return invalidated;
  }

  #prune(projectId: string, now: number): void {
    const grants = this.#projects.get(projectId);
    if (!grants) return;
    const kept = grants.filter((grant) => {
      const current = summary(grant, now);
      return current.status === "active" || current.status === "exhausted" || current.status === "expired"
        || (grant.endedAt !== undefined && now - grant.endedAt < TERMINAL_RETENTION_MS);
    });
    if (kept.length) this.#projects.set(projectId, kept);
    else this.#projects.delete(projectId);
  }
}
