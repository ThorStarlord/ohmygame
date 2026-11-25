import { describe, expect, it } from "vitest";
import { NativeWindowCaptures } from "../src/daemon/native-window-captures.js";
import { isNativeWindowCaptureInput } from "../src/shared/engine-observations.js";

const capture = (title = "Ren'Py") => ({
  width: 1280,
  height: 720,
  title,
  hwnd: "12345",
  pid: 4321,
  mediaType: "image/png" as const,
  analysis: { sampledPixels: 10, opaqueRatio: 1, luminanceMean: 40, luminanceVariance: 20, likelyBlank: false },
  data: "iVBORw0KGgo=",
});

describe("Native window captures", () => {
  it("keeps one latest capture per session and isolates projects", () => {
    const captures = new NativeWindowCaptures();
    const first = captures.add("project-a", "session-1", capture("first"));
    captures.add("project-a", "session-1", capture("second"));
    expect(captures.list("project-a")).toHaveLength(1);
    expect(captures.latest("project-a", "session-1")?.title).toBe("second");
    expect(captures.latest("project-a", "session-1")?.data).toBe("iVBORw0KGgo=");
    expect(captures.list("project-a")[0]?.id).not.toBe(first.id);
    expect(captures.list("project-b")).toEqual([]);
    captures.forget("project-a");
    expect(captures.list("project-a")).toEqual([]);
  });

  it("bounds retained sessions per project", () => {
    const captures = new NativeWindowCaptures();
    for (let index = 0; index < 15; index++) captures.add("project", `session-${index}`, capture());
    expect(captures.list("project")).toHaveLength(12);
    expect(captures.latest("project", "session-14")?.title).toBe("Ren'Py");
    expect(captures.latest("project", "session-0")).toBeUndefined();
  });

  it("rejects malformed capture input before it reaches storage", () => {
    expect(isNativeWindowCaptureInput(capture())).toBe(true);
    expect(isNativeWindowCaptureInput({ ...capture(), data: "" })).toBe(false);
    expect(isNativeWindowCaptureInput({ ...capture(), width: 0 })).toBe(false);
    expect(isNativeWindowCaptureInput({ ...capture(), mediaType: "image/jpeg" })).toBe(false);
  });
});
