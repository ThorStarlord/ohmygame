// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ScenarioPlaytestsPanel } from "../src/renderer/scenario-playtests-panel.js";
import type { ScenarioRunSummary } from "../src/shared/engine-observations.js";

let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function run(overrides: Partial<ScenarioRunSummary> & { id: string; startedAt: number; checkpointId: string; name?: string }): ScenarioRunSummary {
  const { id, startedAt, checkpointId, name: checkpointName, ...rest } = overrides;
  const name = checkpointName ?? "scene/01-dialogue";
  return {
    id,
    projectId: "project",
    plugin: "thorstarlord/renpy",
    pluginVersion: "0.2.0",
    engineRunId: id.replaceAll("-", "").padEnd(16, "0"),
    scenario: "flow",
    executedSelection: "global::flow",
    mode: "exploratory",
    status: "passed",
    startedAt,
    completedAt: startedAt + 1,
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    checkpointOrder: "file-write-time",
    checkpointLimitReached: false,
    checkpointWarnings: [],
    diagnostics: [],
    diagnosticsComplete: true,
    checkpoints: [{
      id: checkpointId,
      runId: id,
      plugin: "thorstarlord/renpy",
      scenario: "flow",
      name,
      file: name.replace("/", "-") + ".png",
      kind: "exploratory",
      mode: "exploratory",
      order: 0,
      width: 1280,
      height: 720,
      mediaType: "image/png",
      bytes: 68,
      capturedAt: startedAt,
      retained: true,
    }],
    ...rest,
  } as ScenarioRunSummary;
}

const discovery = {
  status: "passed" as const,
  authority: "engine" as const,
  scenarios: [
    { name: "flow", kind: "testcase" as const, file: "game/tests.rpy", line: 4, parameterized: false, default: false },
    { name: "global", kind: "testsuite" as const, file: "game/testcases.rpy", line: 1, parameterized: false, default: true },
  ],
  truncated: false,
  exitCode: 0,
  errors: [],
  diagnostics: [],
  diagnosticsComplete: true,
};

it("discovers engine scenarios, runs one explicitly, and views exact checkpoints", async () => {
  const changed = vi.fn();
  const requests: Array<{ url: string; body?: unknown }> = [];
  const before = run({ id: "run-1", startedAt: 1, checkpointId: "checkpoint-1" });
  const after = run({ id: "run-2", startedAt: 2, checkpointId: "checkpoint-2" });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/scenarios/discover")) return Response.json(discovery);
    if (url.includes("/scenario-runs") && init?.method === "POST") return Response.json(after);
    if (url.includes("/scenario-checkpoints/checkpoint-1")) return Response.json({ ...before.checkpoints[0]!, data: "iVBORw0KGgo=" });
    if (url.includes("/scenario-checkpoints/checkpoint-2")) return Response.json({ ...after.checkpoints[0]!, data: "iVBORw0KGgo=" });
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);

  await act(async () => root.render(<ScenarioPlaytestsPanel projectId="project" runs={[]} onChanged={changed} />));
  expect(container.textContent).toContain("Scenario playtests");
  expect(container.textContent).toContain("No scenario has run in this app session.");
  await act(async () => root.render(<ScenarioPlaytestsPanel projectId="project" runs={[after, before]} onChanged={changed} />));
  expect(container.textContent).toContain("These checkpoints share the same scenario");

  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "Discover scenarios")!.click();
  });
  await vi.waitFor(() => expect(container.textContent).toContain("Run scenario"));
  const scenarioSelect = [...container.querySelectorAll("select")][0] as HTMLSelectElement;
  expect(scenarioSelect.value).toBe("global");
  expect(scenarioSelect.textContent).toContain("global · testsuite");
  expect(scenarioSelect.textContent).toContain("flow · testcase · game/tests.rpy:4");

  const modeSelect = [...container.querySelectorAll("select")][1] as HTMLSelectElement;
  await act(async () => {
    modeSelect.value = "regression";
    modeSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const baselineInput = container.querySelector("input") as HTMLInputElement;
  expect(baselineInput.value).toBe("tests/screenshots");
  expect(container.textContent).toContain("Baseline folder");
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(baselineInput, "tests/custom");
    baselineInput.dispatchEvent(new Event("input", { bubbles: true }));
  });

  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "Run scenario")!.click();
  });
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  const started = requests.find((request) => request.url.includes("/scenario-runs") && request.body);
  expect(started?.body).toEqual({ scenario: "global", mode: "regression", baselineDirectory: "tests/custom" });

  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "View checkpoint")!.click();
  });
  await vi.waitFor(() => expect(container.querySelector("img")).not.toBeNull());
  expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
});

it("shows run evidence, evicted metadata and a regression baseline count", async () => {
  const changed = vi.fn();
  const runWithEvidence = run({
    id: "run-3", startedAt: 3, checkpointId: "checkpoint-3",
    mode: "regression", baselineFiles: 2, baselineDirectory: "tests/screenshots",
    checkpointWarnings: ["The engine compared two screenshots."],
    diagnostics: [{ severity: "error", message: "sample engine diagnostic", path: "game/tests.rpy", line: 4 }],
    outputExcerpt: "sample engine output excerpt",
    outputOmitted: true,
    checkpoints: [{
      ...run({ id: "run-3", startedAt: 3, checkpointId: "checkpoint-3" }).checkpoints[0]!,
      mode: "regression",
      retained: false,
    }],
  });
  await act(async () => root.render(<ScenarioPlaytestsPanel projectId="project" runs={[runWithEvidence]} onChanged={changed} />));
  expect(container.textContent).toContain("flow · Regression · passed");
  expect(container.textContent).toContain("Regression baselines available: 2.");
  expect(container.textContent).toContain("Baseline folder: tests/screenshots");
  expect(container.textContent).toContain("The engine compared two screenshots.");
  expect(container.textContent).toContain("sample engine diagnostic");
  expect(container.textContent).toContain("game/tests.rpy:4");
  expect(container.textContent).toContain("sample engine output excerpt");
  expect(container.textContent).toContain("The retained output excerpt is bounded");
  expect(container.textContent).toContain("This image is not retained");
});

it("does not keep showing a cached image after its checkpoint is no longer retained", async () => {
  const changed = vi.fn();
  const retained = run({ id: "run-4", startedAt: 4, checkpointId: "checkpoint-4" });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...retained.checkpoints[0]!, data: "iVBORw0KGgo=" })));
  await act(async () => root.render(<ScenarioPlaytestsPanel projectId="project" runs={[retained]} onChanged={changed} />));
  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "View checkpoint")!.click();
  });
  await vi.waitFor(() => expect(container.querySelector("img")).not.toBeNull());
  const evicted = {
    ...retained,
    checkpoints: [{ ...retained.checkpoints[0]!, retained: false }],
  };
  await act(async () => root.render(<ScenarioPlaytestsPanel projectId="project" runs={[evicted]} onChanged={changed} />));
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toContain("This image is not retained");
});
