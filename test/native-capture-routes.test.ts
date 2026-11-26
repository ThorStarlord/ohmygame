import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { NativeCaptureRequests } from "../src/daemon/native-capture-requests.js";
import { NativeWindowCaptures } from "../src/daemon/native-window-captures.js";
import { registerNativeCaptureRoutes } from "../src/daemon/native-capture-routes.js";
import type { ProjectState } from "../src/shared/contracts.js";
import type { NativeWindowCaptureInput } from "../src/shared/engine-observations.js";
import type { NativeSessionView } from "../src/shared/native-sessions.js";

const project = {
  id: "project-a",
  name: "Pilot",
  type: "general",
  updatedAt: "2026-11-26T00:00:00.000Z",
  workspacePath: "C:\\pilot",
  preview: { status: "stopped" },
} as ProjectState;
const session: NativeSessionView = {
  id: "session-a",
  plugin: "thorstarlord/renpy",
  label: "Ren'Py",
  state: "running",
  pid: 4321,
  startedAt: 1,
};

function pngData(width = 1280, height = 720): string {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header.toString("base64");
}

const image = (title = "Game"): NativeWindowCaptureInput => ({
  width: 1280,
  height: 720,
  title,
  hwnd: "42",
  rootPid: 4321,
  pid: 4322,
  mediaType: "image/png",
  analysis: { sampledPixels: 10, opaqueRatio: 1, luminanceMean: 20, luminanceVariance: 10, likelyBlank: false },
  data: pngData(),
});

function setup(platform: NodeJS.Platform = "win32") {
  const app = Fastify();
  const captures = new NativeWindowCaptures();
  const published: Array<Record<string, unknown>> = [];
  const requests = new NativeCaptureRequests({
    publish: (_projectId, type, data) => { if (type === "native.capture.request") published.push(data as Record<string, unknown>); },
    windows: () => 1,
  });
  registerNativeCaptureRoutes(app, {
    platform,
    projects: { get: (id) => id === project.id ? project : undefined },
    sessions: async () => [session],
    requests,
    captures,
    redactTitle: (text) => text,
  });
  return { app, captures, requests, published };
}

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function start(setupValue: ReturnType<typeof setup>, grantId?: string) {
  apps.push(setupValue.app);
  const pending = setupValue.requests.request(project.id, { sessionId: session.id, rootPid: 4321, label: "Ren'Py", ...(grantId ? { grantId } : {}) });
  const request = String(setupValue.published.at(-1)!.request);
  return { request, pending };
}

const url = (request: string) => `/projects/project-a/native-capture-requests/${request}`;

describe("Native capture HTTP routes", () => {
  it("claims with a token, rejects wrong or missing tokens, stores once and retrieves the exact capture", async () => {
    const h = setup();
    const { request, pending } = start(h, "grant-1");
    const claim = await h.app.inject({ method: "POST", url: url(request), payload: { started: true } });
    expect(claim.statusCode).toBe(200);
    const token = claim.json<{ claimToken: string }>().claimToken;
    expect(token).toBeTruthy();
    expect((await h.app.inject({ method: "POST", url: url(request), payload: { started: true } })).statusCode).toBe(404);

    expect((await h.app.inject({ method: "POST", url: url(request), payload: { image: image() } })).statusCode).toBe(400);
    expect((await h.app.inject({ method: "POST", url: url(request), payload: { image: image(), claimToken: "wrong" } })).statusCode).toBe(409);
    expect(h.captures.list(project.id)).toEqual([]);

    const answer = await h.app.inject({ method: "POST", url: url(request), payload: { image: image(), claimToken: token } });
    expect(answer.statusCode).toBe(200);
    const saved = answer.json<{ id: string; grantId?: string; requestId?: string }>();
    expect(saved).toMatchObject({ grantId: "grant-1", requestId: request });
    await expect(pending).resolves.toMatchObject({ id: saved.id, grantId: "grant-1" });
    expect((await h.app.inject({ method: "GET", url: `/projects/project-a/native-captures/${saved.id}` })).statusCode).toBe(200);
    expect((await h.app.inject({ method: "GET", url: `/projects/project-a/native-captures/missing` })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "POST", url: url(request), payload: { image: image("late"), claimToken: token } })).statusCode).toBe(404);
  });

  it("settles an error only for the claimant and a decline before a claim", async () => {
    const h = setup();
    const first = start(h);
    const token = (await h.app.inject({ method: "POST", url: url(first.request), payload: { started: true } })).json<{ claimToken: string }>().claimToken;
    const rejection = expect(first.pending).rejects.toThrow("capture failed");
    expect((await h.app.inject({ method: "POST", url: url(first.request), payload: { error: "capture failed", claimToken: "wrong" } })).statusCode).toBe(409);
    expect((await h.app.inject({ method: "POST", url: url(first.request), payload: { error: "capture failed", claimToken: token } })).statusCode).toBe(204);
    await rejection;

    const second = start(h);
    const decline = expect(second.pending).rejects.toThrow("window hidden");
    expect((await h.app.inject({ method: "POST", url: url(second.request), payload: { declined: "window hidden" } })).statusCode).toBe(204);
    await decline;
    expect(h.captures.list(project.id)).toHaveLength(0);
  });

  it("refuses capture outside Windows and when the session changed", async () => {
    const h = setup("linux");
    const { request, pending } = start(h);
    const rejection = expect(pending).rejects.toThrow("project closed");
    expect((await h.app.inject({ method: "POST", url: url(request), payload: { started: true } })).statusCode).toBe(409);
    h.requests.forget(project.id);
    await rejection;

    const windows = setup();
    const { request: next, pending: nextPending } = start(windows);
    const token = (await windows.app.inject({ method: "POST", url: url(next), payload: { started: true } })).json<{ claimToken: string }>().claimToken;
    // The route's session callback is fixed to the running session; a live
    // replacement is covered by the service and route session checks.
    expect(token).toBeTruthy();
    const answer = await windows.app.inject({ method: "POST", url: url(next), payload: { image: { ...image(), rootPid: 9999 }, claimToken: token } });
    expect(answer.statusCode).toBe(400);
    await expect(nextPending).rejects.toThrow("did not belong");
  });
});
