import { describe, expect, it } from "vitest";
import { NativeWindowCaptures, parseNativeWindowCapture } from "../src/daemon/native-window-captures.js";
import { isNativeWindowCaptureInput } from "../src/shared/engine-observations.js";

/** A PNG signature and IHDR header, enough for the daemon's byte checks. */
function pngData(width = 1280, height = 720): string {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header.toString("base64");
}

const capture = (title = "Ren'Py") => ({
  width: 1280,
  height: 720,
  title,
  hwnd: "12345",
  rootPid: 4321,
  pid: 4322,
  mediaType: "image/png" as const,
  analysis: { sampledPixels: 10, opaqueRatio: 1, luminanceMean: 40, luminanceVariance: 20, likelyBlank: false },
  data: pngData(),
});

describe("Native window captures", () => {
  it("keeps a bounded history for one session and retrieves an exact capture", () => {
    const captures = new NativeWindowCaptures();
    const first = captures.add("project-a", "session-1", capture("first"));
    const second = captures.add("project-a", "session-1", capture("second"), { requestId: "request-1", grantId: "grant-1", plugin: "thorstarlord/renpy" });
    expect(captures.list("project-a")).toHaveLength(2);
    expect(captures.latest("project-a", "session-1")?.title).toBe("second");
    expect(captures.latest("project-a", "session-1")?.data).toBe(pngData());
    expect(captures.get("project-a", first.id)?.title).toBe("first");
    expect(captures.get("project-a", second.id)).toMatchObject({
      requestId: "request-1",
      grantId: "grant-1",
      plugin: "thorstarlord/renpy",
    });
    expect(captures.get("project-a", "gone")).toBeUndefined();
    expect(captures.get("project-b", first.id)).toBeUndefined();
    captures.remove("project-a", first.id);
    expect(captures.get("project-a", first.id)).toBeUndefined();
    expect(captures.list("project-a")).toHaveLength(1);
    captures.forget("project-a");
    expect(captures.list("project-a")).toEqual([]);
    expect(captures.get("project-a", second.id)).toBeUndefined();
  });

  it("evicts the oldest capture beyond a session's history limit", () => {
    const captures = new NativeWindowCaptures();
    const saved = Array.from({ length: 7 }, (_, index) => captures.add("project", "session", capture(`shot-${index}`)));
    expect(captures.list("project")).toHaveLength(6);
    expect(captures.get("project", saved[0]!.id)).toBeUndefined();
    expect(captures.get("project", saved[1]!.id)?.title).toBe("shot-1");
    expect(captures.get("project", saved[6]!.id)?.title).toBe("shot-6");
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
    expect(parseNativeWindowCapture(capture())).toMatchObject({ width: 1280, height: 720, hwnd: "12345" });
    expect(isNativeWindowCaptureInput({ ...capture(), data: "" })).toBe(false);
    expect(isNativeWindowCaptureInput({ ...capture(), width: 0 })).toBe(false);
    expect(isNativeWindowCaptureInput({ ...capture(), mediaType: "image/jpeg" })).toBe(false);
    expect(isNativeWindowCaptureInput({ ...capture(), hwnd: "not-a-handle" })).toBe(false);
    expect(isNativeWindowCaptureInput({ ...capture(), note: "extra" })).toBe(false);
    expect(parseNativeWindowCapture({ ...capture(), data: "not-base64-%%-png" })).toBeUndefined();
    expect(parseNativeWindowCapture({ ...capture(), width: 1 })).toBeUndefined();
    expect(parseNativeWindowCapture({ ...capture(), data: "iVBORw0KGgo=" })).toBeUndefined();
    expect(parseNativeWindowCapture({ ...capture(), width: 16_384, height: 16_384, data: pngData(16_384, 16_384) })).toBeUndefined();
  });

  it("keeps a project under a total encoded-byte budget", () => {
    const captures = new NativeWindowCaptures();
    const large = { ...capture(), data: "A".repeat(3 * 1024 * 1024) };
    for (let index = 0; index < 11; index++) captures.add("project", `session-${index}`, large);
    expect(captures.list("project").length).toBeLessThanOrEqual(10);
    expect(captures.latest("project", "session-10")).toBeDefined();
  });
});
