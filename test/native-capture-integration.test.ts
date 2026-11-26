import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAgentTools } from "../src/daemon/agent-tools.js";
import { NativeCaptureRequests } from "../src/daemon/native-capture-requests.js";
import { NativeWindowCaptures } from "../src/daemon/native-window-captures.js";
import { requestOneTimeCapture } from "../src/daemon/one-time-capture-service.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { ToolRunner } from "../src/daemon/tools.js";
import type { ApprovalDecision, ApprovalRequestDetails } from "../src/shared/agent-runtimes.js";
import type { NativeWindowCaptureInput } from "../src/shared/engine-observations.js";
import type { NativeSessionView } from "../src/shared/native-sessions.js";

const input = (title = "Game"): NativeWindowCaptureInput => ({
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

async function setup() {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-capture-integration-"));
  const projects = new ProjectManager(dataDirectory);
  await projects.load();
  const project = await projects.create("Capture integration");
  const runner = new ToolRunner(dataDirectory, { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) });
  await runner.load();
  const sessions: NativeSessionView[] = [{ id: "session-1", plugin: "thorstarlord/renpy", label: "Ren'Py", state: "running", pid: 4321, startedAt: 1 }];
  const captures = new NativeWindowCaptures();
  const published: Array<{ type: string; data: Record<string, unknown> }> = [];
  const requests = new NativeCaptureRequests({
    publish: (projectId, type, data) => {
      published.push({ type, data: data as Record<string, unknown> });
      if (type !== "native.capture.request") return;
      const target = data as { request: string; sessionId: string };
      const request = target.request;
      const token = requests.claim(projectId, request);
      if (!token) return;
      const summary = captures.add(projectId, target.sessionId, input(), {
        requestId: request,
        plugin: "thorstarlord/renpy",
      });
      requests.resolveWith(projectId, request, token, () => ({ ...summary, data: input().data }));
    },
    windows: () => 1,
  });
  const approval = vi.fn(async (_details: ApprovalRequestDetails, _requestId: string, _signal?: AbortSignal): Promise<ApprovalDecision> => "allow");
  const tools = createAgentTools(
    project, runner, projects, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    async () => ({
      projectId: project.id, observedAt: 1, historyRetention: "daemon-memory",
      preview: { status: "stopped", diagnostics: [] }, nativeSessions: sessions, captures: captures.list(project.id), observationGrants: [], scenarioPlaytestsAvailable: false, scenarioRuns: [], checks: [],
    }),
    (query) => Promise.resolve(query.captureId ? captures.get(project.id, query.captureId) : query.sessionId ? captures.latest(project.id, query.sessionId) : undefined),
    (sessionId, reason, toolCallId, signal) => requestOneTimeCapture({
      projectId: project.id,
      projectName: project.name,
      conversationId: "conversation-1",
      sessionId,
      reason,
      toolCallId,
      sessions: async () => sessions,
      askApproval: approval,
      requests,
      ...(signal ? { signal } : {}),
    }),
  );
  return { project, tools, approval, sessions, captures, requests, published };
}

describe("One-time capture application integration", () => {
  it("connects agent tool, approval, session revalidation, claim, storage and exact retrieval", async () => {
    const h = await setup();
    const requestTool = h.tools.find(({ name }) => name === "engine_capture_request");
    const captureTool = h.tools.find(({ name }) => name === "engine_capture");
    if (!requestTool || !captureTool) throw new Error("Expected capture tools");
    const result = await requestTool.execute("call-1", { sessionId: "session-1", reason: "Inspect the dialogue" }, undefined, undefined, {} as never);
    const metadata = JSON.parse((result.content[0] as { text: string }).text) as { id: string };
    expect(h.approval).toHaveBeenCalledOnce();
    expect(h.approval.mock.calls[0]![0]).toMatchObject({
      nativeCapture: { project: h.project.name, session: "Ren'Py", operation: "still" },
    });
    expect(h.published[0]).toMatchObject({ type: "native.capture.request" });
    expect(metadata.id).toBeTruthy();
    expect(h.captures.get(h.project.id, metadata.id)?.requestId).toBe(String(h.published[0]!.data.request));
    const exact = await captureTool.execute("call-2", { captureId: metadata.id }, undefined, undefined, {} as never);
    expect(exact.content[1]).toEqual({ type: "image", data: input().data, mimeType: "image/png" });
  });

  it("returns no capture when the person denies", async () => {
    const h = await setup();
    h.approval.mockResolvedValueOnce("deny");
    const requestTool = h.tools.find(({ name }) => name === "engine_capture_request");
    if (!requestTool) throw new Error("Expected capture request tool");
    await expect(requestTool.execute("call-1", { sessionId: "session-1", reason: "Inspect" }, undefined, undefined, {} as never))
      .rejects.toThrow(/did not allow/);
    expect(h.published).toEqual([]);
    expect(h.captures.list(h.project.id)).toEqual([]);
  });

  it("refuses a session replaced while the approval is pending", async () => {
    const h = await setup();
    h.approval.mockImplementationOnce(async () => {
      h.sessions[0] = { ...h.sessions[0]!, pid: 9999 };
      return "allow";
    });
    const requestTool = h.tools.find(({ name }) => name === "engine_capture_request");
    if (!requestTool) throw new Error("Expected capture request tool");
    await expect(requestTool.execute("call-1", { sessionId: "session-1", reason: "Inspect" }, undefined, undefined, {} as never))
      .rejects.toThrow(/changed after/);
    expect(h.published).toEqual([]);
    expect(h.captures.list(h.project.id)).toEqual([]);
  });
});
