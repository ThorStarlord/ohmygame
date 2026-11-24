// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeSessionChip } from "../src/renderer/project-frame.js";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("NativeSessionChip", () => {
  it("shows a running engine and stops it deliberately", async () => {
    const onStop = vi.fn();
    await act(async () => root.render(
      <NativeSessionChip
        sessions={[{
          id: "session-1",
          plugin: "thorstarlord/renpy",
          label: "Ren'Py",
          state: "running",
          pid: 1234,
          startedAt: Date.now(),
        }]}
        onStop={onStop}
      />,
    ));
    expect(container.textContent).toContain("Ren'Py running");
    await act(async () => container.querySelector("button")!.click());
    expect(onStop).toHaveBeenCalledWith(expect.objectContaining({ id: "session-1" }));
  });

  it("keeps a just-ended failure visible without a stop action", async () => {
    await act(async () => root.render(
      <NativeSessionChip
        sessions={[{
          id: "session-2",
          plugin: "thorstarlord/renpy",
          label: "Ren'Py",
          state: "failed",
          startedAt: Date.now() - 2_000,
          endedAt: Date.now() - 1_000,
          error: "code 1",
        }]}
        onStop={() => {}}
      />,
    ));
    expect(container.textContent).toContain("Ren'Py failed");
    expect(container.querySelector("button")).toBeNull();
  });
});
