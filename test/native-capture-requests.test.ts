import { describe, expect, it } from "vitest";
import { NativeCaptureRequests, type NativeCaptureTarget } from "../src/daemon/native-capture-requests.js";
import type { NativeWindowCapture } from "../src/shared/engine-observations.js";

const target: NativeCaptureTarget = { sessionId: "session-1", rootPid: 4321, label: "Ren'Py" };
const capture: NativeWindowCapture = {
  id: "capture-1",
  sessionId: target.sessionId,
  requestId: "request-1",
  plugin: "thorstarlord/renpy",
  capturedAt: 1,
  width: 1280,
  height: 720,
  title: "Game",
  hwnd: "42",
  rootPid: target.rootPid,
  pid: 4322,
  mediaType: "image/png",
  analysis: { sampledPixels: 10, opaqueRatio: 1, luminanceMean: 20, luminanceVariance: 10, likelyBlank: false },
  data: "iVBORw0KGgo=",
};

function setup() {
  const published: Array<{ projectId: string; type: string; data: Record<string, unknown> }> = [];
  const requests = new NativeCaptureRequests({
    publish: (projectId, type, data) => { published.push({ projectId, type, data: data as Record<string, unknown> }); },
    windows: () => 1,
  });
  return { requests, published };
}

describe("Native capture requests", () => {
  it("binds a published request to one session and settles on one claimed answer", async () => {
    const { requests, published } = setup();
    const pending = requests.request("project-a", target);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      projectId: "project-a",
      type: "native.capture.request",
      data: { sessionId: target.sessionId, rootPid: target.rootPid, label: target.label },
    });
    const request = String(published[0]!.data.request);
    expect(requests.target("project-b", request)).toBeUndefined();
    expect(requests.target("project-a", request)).toEqual(target);
    expect(requests.claim("project-b", request)).toBe(false);
    expect(requests.claim("project-a", request)).toBe(true);
    expect(requests.claim("project-a", request)).toBe(false);
    expect(requests.resolve("project-a", request, capture)).toBe(true);
    await expect(pending).resolves.toEqual(capture);
    expect(requests.target("project-a", request)).toBeUndefined();
    expect(requests.resolve("project-a", request, { ...capture, id: "late" })).toBe(false);
  });

  it("refuses a request when the only desktop window declines", async () => {
    const { requests, published } = setup();
    const pending = requests.request("project-a", target);
    const request = String(published[0]!.data.request);
    const rejection = expect(pending).rejects.toThrow("The game window is hidden");
    expect(requests.decline("project-a", request, "The game window is hidden")).toBe(true);
    await rejection;
  });

  it("cancels a request when the caller stops and tells the windows", async () => {
    const { requests, published } = setup();
    const controller = new AbortController();
    const pending = requests.request("project-a", target, controller.signal);
    const rejection = expect(pending).rejects.toThrow("Cancelled");
    controller.abort();
    await rejection;
    expect(published.at(-1)).toMatchObject({ type: "native.capture.cancel" });
    expect(requests.target("project-a", String(published[0]!.data.request))).toBeUndefined();
  });

  it("invalidates outstanding work when its project closes or its session ends", async () => {
    const { requests, published } = setup();
    const first = requests.request("project-a", target);
    const firstRejection = expect(first).rejects.toThrow("project closed");
    requests.forget("project-a");
    await firstRejection;
    expect(published.at(-1)).toMatchObject({ type: "native.capture.cancel" });

    const second = requests.request("project-b", target);
    const request = String(published.at(-1)!.data.request);
    const secondRejection = expect(second).rejects.toThrow("session ended");
    requests.cancelSession("project-b", "another-session");
    expect(requests.target("project-b", request)).toEqual(target);
    requests.cancelSession("project-b", target.sessionId);
    await secondRejection;
    expect(requests.target("project-b", request)).toBeUndefined();
  });

  it("does not resolve an answer that was never claimed", async () => {
    const { requests, published } = setup();
    const pending = requests.request("project-a", target);
    const request = String(published[0]!.data.request);
    expect(requests.fail("project-a", request, "no claim")).toBe(false);
    expect(requests.resolve("project-a", request, capture)).toBe(false);
    const rejection = expect(pending).rejects.toThrow("project closed");
    requests.forget("project-a");
    await rejection;
  });
});
