import { describe, expect, it, vi } from "vitest";
import { NativeCaptureRequests } from "../src/daemon/native-capture-requests.js";
import { ObservationGrants, OBSERVATION_GRANT_DURATION_MS } from "../src/daemon/observation-grants.js";
import { ObservationSessionService } from "../src/daemon/observation-session-service.js";
import { NativeWindowCaptures } from "../src/daemon/native-window-captures.js";
import type { ApprovalRequestDetails } from "../src/shared/agent-runtimes.js";
import type { NativeWindowCaptureInput } from "../src/shared/engine-observations.js";
import type { NativeSessionView } from "../src/shared/native-sessions.js";

const fixture = (title = "Game"): NativeWindowCaptureInput => ({
  width: 1280,
  height: 720,
  title,
  hwnd: "42",
  rootPid: 4321,
  pid: 4322,
  mediaType: "image/png",
  analysis: { sampledPixels: 10, opaqueRatio: 1, luminanceMean: 20, luminanceVariance: 10, likelyBlank: false },
  data: "iVBORw0KGgo=",
});

function harness(options: { approval?: "allow" | "deny"; autoResolve?: boolean } = {}) {
  let now = 1_000_000;
  let activeGrantId: string | undefined;
  const sessions: NativeSessionView[] = [{ id: "session-a", plugin: "thorstarlord/renpy", label: "Ren'Py", state: "running", pid: 4321, startedAt: 1 }];
  const captures = new NativeWindowCaptures();
  const published: Array<{ type: string; data: Record<string, unknown> }> = [];
  let pending: { projectId: string; request: string; token: string } | undefined;
  const requests = new NativeCaptureRequests({
    publish: (projectId, type, data) => {
      published.push({ type, data: data as Record<string, unknown> });
      if (type !== "native.capture.request") return;
      const target = data as { request: string; sessionId: string };
      const request = target.request;
      const token = requests.claim(projectId, request);
      if (!token) return;
      if (options.autoResolve === false) {
        pending = { projectId, request, token };
        return;
      }
      const summary = captures.add(projectId, target.sessionId, fixture(), {
        requestId: request,
        ...(activeGrantId ? { grantId: activeGrantId } : {}),
        plugin: "thorstarlord/renpy",
      });
      requests.resolveWith(projectId, request, token, () => ({ ...summary, data: fixture().data }));
    },
    windows: () => 1,
  });
  const grants = new ObservationGrants({ now: () => now });
  let approval = vi.fn(async (_details: ApprovalRequestDetails, _requestId: string, _signal?: AbortSignal) => options.approval ?? "allow");
  const serviceFor = (conversationId = "conversation-a") => new ObservationSessionService({
    projectId: "project-a",
    projectName: "Pilot",
    conversationId,
    sessions: async () => sessions,
    askApproval: approval,
    requests,
    grants,
    now: () => now,
  });
  return {
    service: serviceFor(),
    serviceFor,
    requests,
    grants,
    captures,
    sessions,
    published,
    approval,
    setApproval(value: "allow" | "deny") { approval = vi.fn(async (_details: ApprovalRequestDetails, _requestId: string, _signal?: AbortSignal) => value); },
    advance(ms: number) { now += ms; },
    setActiveGrant(id: string | undefined) { activeGrantId = id; },
    pending: () => pending,
    finishPending(capture = true) {
      if (!pending) throw new Error("No pending capture");
      const { projectId, request, token } = pending;
      pending = undefined;
      if (!capture) return requests.fail(projectId, request, token, "capture failed");
      const summary = captures.add(projectId, "session-a", fixture("finished"), {
        requestId: request,
        ...(activeGrantId ? { grantId: activeGrantId } : {}),
        plugin: "thorstarlord/renpy",
      });
      return requests.resolveWith(projectId, request, token, () => ({ ...summary, data: fixture().data }));
    },
  };
}

describe("Observation session service", () => {
  it("asks for one bounded authorization, then captures without another approval", async () => {
    const h = harness();
    const grant = await h.service.start("session-a", "Check the dialogue layout", "tool-1");
    h.setActiveGrant(grant.id);
    expect(h.approval).toHaveBeenCalledOnce();
    expect(h.approval.mock.calls[0]![0]).toMatchObject({
      nativeObservation: {
        project: "Pilot",
        session: "Ren'Py",
        purpose: "Check the dialogue layout",
        maxAttempts: 3,
        operation: "still",
      },
    });
    const first = await h.service.capture(grant.id);
    expect(first.capture.grantId).toBe(grant.id);
    expect(first.grant).toMatchObject({ admitted: 1, completed: 1, remaining: 2, status: "active" });
    expect(h.approval).toHaveBeenCalledOnce();
    expect(h.captures.get("project-a", first.capture.id)?.grantId).toBe(grant.id);
    expect(await h.service.status(grant.id)).toEqual([expect.objectContaining({ id: grant.id, remaining: 2 })]);
    expect(h.service.end(grant.id)).toMatchObject({ status: "ended" });
    await expect(h.service.capture(grant.id)).rejects.toThrow(/no longer active/);
  });

  it("produces no grant on denial", async () => {
    const h = harness({ approval: "deny" });
    await expect(h.service.start("session-a", "Inspect", "tool-1")).rejects.toThrow(/did not authorize/);
    expect(h.grants.list("project-a")).toEqual([]);
    expect(h.published).toEqual([]);
  });

  it("rejects a session change after approval", async () => {
    const h = harness();
    h.approval.mockImplementationOnce(async () => {
      h.sessions[0] = { ...h.sessions[0]!, pid: 9999 };
      return "allow";
    });
    await expect(h.service.start("session-a", "Inspect", "tool-1")).rejects.toThrow(/changed after/);
    expect(h.grants.list("project-a")).toEqual([]);
  });

  it("counts admitted attempts and never exceeds the approved budget", async () => {
    const h = harness();
    const grant = await h.service.start("session-a", "Inspect", "tool-1");
    h.setActiveGrant(grant.id);
    for (let index = 0; index < 3; index += 1) await h.service.capture(grant.id);
    expect(h.published.filter((item) => item.type === "native.capture.request")).toHaveLength(3);
    await expect(h.service.capture(grant.id)).rejects.toThrow(/no capture attempts left/);
    expect(h.published.filter((item) => item.type === "native.capture.request")).toHaveLength(3);
    expect((await h.service.status(grant.id))[0]).toMatchObject({ admitted: 3, completed: 3, remaining: 0, status: "exhausted" });
  });

  it("refuses admission after expiry without consuming an attempt", async () => {
    const h = harness();
    const grant = await h.service.start("session-a", "Inspect", "tool-1");
    h.advance(OBSERVATION_GRANT_DURATION_MS);
    await expect(h.service.capture(grant.id)).rejects.toThrow(/expired/);
    expect(h.grants.get("project-a", "conversation-a", grant.id)).toMatchObject({ admitted: 0, status: "expired" });
  });

  it("refuses a replaced session before admission", async () => {
    const h = harness();
    const grant = await h.service.start("session-a", "Inspect", "tool-1");
    h.sessions[0] = { ...h.sessions[0]!, pid: 9999 };
    await expect(h.service.capture(grant.id)).rejects.toThrow(/changed/);
    expect(h.grants.get("project-a", "conversation-a", grant.id)).toMatchObject({ admitted: 0 });
  });

  it("keeps grants scoped to the requesting conversation", async () => {
    const h = harness();
    const grant = await h.service.start("session-a", "Inspect", "tool-1");
    const other = h.serviceFor("conversation-b");
    expect(await other.status()).toEqual([]);
    await expect(other.capture(grant.id)).rejects.toThrow(/not available/);
    expect(() => other.end(grant.id)).toThrow(/not available/);
  });

  it("revokes an in-flight capture and does not let its late result settle it", async () => {
    const h = harness({ autoResolve: false });
    const grant = await h.service.start("session-a", "Inspect", "tool-1");
    h.setActiveGrant(grant.id);
    const inFlight = h.service.capture(grant.id);
    await vi.waitFor(() => expect(h.pending()).toBeDefined());
    expect(h.service.end(grant.id, "revoked")).toMatchObject({ status: "revoked" });
    await expect(inFlight).rejects.toThrow(/no longer active/);
    expect(h.grants.get("project-a", "conversation-a", grant.id)).toMatchObject({ status: "revoked", admitted: 1, failed: 1 });
    expect(h.finishPending()).toBe(false);
  });

  it("allows only one in-flight capture and does not double-charge the budget", async () => {
    const h = harness({ autoResolve: false });
    const grant = await h.service.start("session-a", "Inspect", "tool-1");
    h.setActiveGrant(grant.id);
    const first = h.service.capture(grant.id);
    await vi.waitFor(() => expect(h.pending()).toBeDefined());
    await expect(h.service.capture(grant.id)).rejects.toThrow(/already in progress/);
    h.finishPending();
    await expect(first).resolves.toMatchObject({ grant: { admitted: 1, completed: 1, remaining: 2 } });
    expect(h.grants.get("project-a", "conversation-a", grant.id)).toMatchObject({ admitted: 1, inFlight: false });
  });

  it("consumes an attempt when a claimed capture fails", async () => {
    const h = harness({ autoResolve: false });
    const grant = await h.service.start("session-a", "Inspect", "tool-1");
    h.setActiveGrant(grant.id);
    const inFlight = h.service.capture(grant.id);
    await vi.waitFor(() => expect(h.pending()).toBeDefined());
    h.finishPending(false);
    await expect(inFlight).rejects.toThrow(/capture failed/);
    expect(h.grants.get("project-a", "conversation-a", grant.id)).toMatchObject({
      admitted: 1, completed: 0, failed: 1, remaining: 2, inFlight: false,
    });
  });
});
