import { describe, expect, it } from "vitest";
import {
  ObservationGrants,
  OBSERVATION_GRANT_DURATION_MS,
  OBSERVATION_GRANT_MAX_ATTEMPTS,
} from "../src/daemon/observation-grants.js";

function setup() {
  let now = 1_000_000;
  const grants = new ObservationGrants({ now: () => now });
  return {
    grants,
    advance(ms: number) { now += ms; },
    now: () => now,
    create(overrides: Partial<Parameters<ObservationGrants["create"]>[0]> = {}) {
      return grants.create({
        projectId: "project-a",
        conversationId: "conversation-a",
        sessionId: "session-a",
        sessionLabel: "Ren'Py",
        plugin: "thorstarlord/renpy",
        rootPid: 4321,
        purpose: "Inspect the dialogue layout",
        ...overrides,
      });
    },
  };
}

describe("Observation grants", () => {
  it("creates a three-attempt, ten-minute grant bound to one conversation and session", () => {
    const { grants, create, now } = setup();
    const grant = create();
    expect(grant).toMatchObject({
      sessionId: "session-a",
      maxAttempts: OBSERVATION_GRANT_MAX_ATTEMPTS,
      remaining: 3,
      admitted: 0,
      completed: 0,
      failed: 0,
      inFlight: false,
      status: "active",
      expiresAt: now() + OBSERVATION_GRANT_DURATION_MS,
    });
    expect(grants.list("project-a", "conversation-a")).toEqual([grant]);
    expect(grants.list("project-a", "conversation-b")).toEqual([]);
    expect(grants.get("project-a", "conversation-b", grant.id)).toBeUndefined();
    expect(() => create()).toThrow(/already active/);
  });

  it("admits one attempt at a time and keeps failed attempts consumed", () => {
    const { grants, create } = setup();
    const grant = create();
    const admitted = grants.admit({
      projectId: "project-a", conversationId: "conversation-a", grantId: grant.id,
      sessionId: "session-a", rootPid: 4321,
    });
    expect(admitted).toMatchObject({ admitted: 1, remaining: 2, inFlight: true });
    expect(() => grants.admit({
      projectId: "project-a", conversationId: "conversation-a", grantId: grant.id,
      sessionId: "session-a", rootPid: 4321,
    })).toThrow(/already in progress/);
    expect(grants.complete("project-a", grant.id, "failed")).toMatchObject({ admitted: 1, failed: 1, remaining: 2, inFlight: false });
    grants.admit({ projectId: "project-a", conversationId: "conversation-a", grantId: grant.id, sessionId: "session-a", rootPid: 4321 });
    expect(grants.complete("project-a", grant.id, "completed")).toMatchObject({ admitted: 2, completed: 1, failed: 1, remaining: 1, inFlight: false });
  });

  it("refuses wrong conversation, session or process without consuming a budget", () => {
    const { grants, create } = setup();
    const grant = create();
    expect(() => grants.admit({
      projectId: "project-a", conversationId: "conversation-b", grantId: grant.id,
      sessionId: "session-a", rootPid: 4321,
    })).toThrow(/not available/);
    expect(() => grants.admit({
      projectId: "project-a", conversationId: "conversation-a", grantId: grant.id,
      sessionId: "session-b", rootPid: 4321,
    })).toThrow(/game session changed/);
    expect(() => grants.admit({
      projectId: "project-a", conversationId: "conversation-a", grantId: grant.id,
      sessionId: "session-a", rootPid: 9999,
    })).toThrow(/game session changed/);
    expect(grants.get("project-a", "conversation-a", grant.id)).toMatchObject({ admitted: 0, remaining: 3 });
  });

  it("exhausts after the approved attempts and requires a new authorization", () => {
    const { grants, create } = setup();
    const grant = create();
    for (let index = 0; index < OBSERVATION_GRANT_MAX_ATTEMPTS; index += 1) {
      grants.admit({ projectId: "project-a", conversationId: "conversation-a", grantId: grant.id, sessionId: "session-a", rootPid: 4321 });
      grants.complete("project-a", grant.id, "completed");
    }
    expect(grants.get("project-a", "conversation-a", grant.id)).toMatchObject({
      admitted: 3, completed: 3, remaining: 0, status: "exhausted",
    });
    expect(() => grants.admit({
      projectId: "project-a", conversationId: "conversation-a", grantId: grant.id,
      sessionId: "session-a", rootPid: 4321,
    })).toThrow(/no capture attempts left/);
    expect(grants.create({
      projectId: "project-a", conversationId: "conversation-a", sessionId: "session-a", sessionLabel: "Ren'Py",
      rootPid: 4321, purpose: "Another inspection",
    })).toMatchObject({ remaining: 3, status: "active" });
  });

  it("expires at the approved absolute time", () => {
    const { grants, create, advance } = setup();
    const grant = create();
    advance(OBSERVATION_GRANT_DURATION_MS);
    expect(grants.list("project-a", "conversation-a")).toEqual([]);
    expect(grants.get("project-a", "conversation-a", grant.id)?.status).toBe("expired");
    expect(() => grants.admit({
      projectId: "project-a", conversationId: "conversation-a", grantId: grant.id,
      sessionId: "session-a", rootPid: 4321,
    })).toThrow(/expired/);
    expect(grants.create({
      projectId: "project-a", conversationId: "conversation-a", sessionId: "session-a", sessionLabel: "Ren'Py",
      rootPid: 4321, purpose: "After expiry",
    })).toMatchObject({ status: "active" });
  });

  it("revokes, ends and invalidates without transferring authority", () => {
    const { grants, create } = setup();
    const revoked = create();
    expect(grants.revoke("project-a", revoked.id)?.status).toBe("revoked");
    expect(() => grants.admit({
      projectId: "project-a", conversationId: "conversation-a", grantId: revoked.id,
      sessionId: "session-a", rootPid: 4321,
    })).toThrow(/no longer active/);

    const ended = create({ sessionId: "session-b" });
    expect(grants.end("project-a", "conversation-b", ended.id)).toBeUndefined();
    expect(grants.end("project-a", "conversation-a", ended.id)?.status).toBe("ended");

    const sessionBound = create({ sessionId: "session-c" });
    expect(grants.invalidateSession("project-a", "session-c")).toEqual([sessionBound.id]);
    expect(grants.get("project-a", "conversation-a", sessionBound.id)?.status).toBe("invalidated");

    const conversationBound = create({ sessionId: "session-d", conversationId: "conversation-b" });
    expect(grants.invalidateConversation("project-a", "conversation-b")).toEqual([conversationBound.id]);
    expect(grants.get("project-a", "conversation-b", conversationBound.id)?.status).toBe("invalidated");
    grants.forget("project-a");
    expect(grants.list("project-a")).toEqual([]);
  });

  it("refuses an authorization that expires before it is created", () => {
    const { grants, now } = setup();
    expect(() => grants.create({
      projectId: "project-a", conversationId: "conversation-a", sessionId: "session-a", sessionLabel: "Ren'Py",
      rootPid: 4321, purpose: "Too late", expiresAt: now(),
    })).toThrow(/expired/);
  });
});
