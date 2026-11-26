import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioPlaytests } from "../src/daemon/scenario-playtests.js";
import { ScenarioRuns } from "../src/daemon/scenario-runs.js";
import type { ProjectState } from "../src/shared/contracts.js";
import type { PluginIndexEntry } from "../src/daemon/plugin-index.js";
import type { PluginServices } from "../src/daemon/plugin-services.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const PLUGIN = "thorstarlord/renpy";

let folder: string;
let project: ProjectState;
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "ohmygame-scenario-service-"));
  await mkdir(path.join(folder, "game"), { recursive: true });
  await writeFile(path.join(folder, "game", "script.rpy"), "label start:\n    return\n");
  project = {
    id: "project-a",
    name: "Pilot",
    type: "general",
    updatedAt: "2026-11-26T00:00:00.000Z",
    workspacePath: folder,
    preview: { status: "stopped" },
  } as ProjectState;
});
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });

function entry(tools = ["renpy_scenario_run"]): PluginIndexEntry {
  return {
    id: PLUGIN,
    version: "0.2.0",
    root: folder,
    digest: "test",
    strings: {},
    skills: [],
    toolSchemas: {},
    manifest: {
      id: PLUGIN,
      version: "0.2.0",
      engines: { "ohmygame-api": "^2.37.0" },
      displayName: "Ren'Py",
      description: "Ren'Py",
      categories: ["engine"],
      appliesTo: ["general"],
      contributes: { tools: tools.map((name) => ({ name, description: name, input: "./tools/empty.json" })) },
    },
  } as unknown as PluginIndexEntry;
}

function services(options: { active?: boolean; call?: (name: string, input: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> } = {}) {
  const plugin = entry();
  return {
    resolve: vi.fn(async () => ({
      ok: true as const,
      typeReady: true,
      plugins: options.active === false ? [] : [{ id: PLUGIN, version: "0.2.0", status: "active" as const, providesType: false, everyProject: false, entry: plugin }],
    })),
    callTool: vi.fn(async (_entry: unknown, name: string, call: { input?: unknown; signal?: AbortSignal }) =>
      options.call ? options.call(name, (call.input ?? {}) as Record<string, unknown>, call.signal) : {}),
    redactObservationText: (text: string) => text.replaceAll("secret", "[redacted]"),
  } as unknown as PluginServices;
}

async function staging(runId: string): Promise<{ root: string; checkpoints: string }> {
  const root = path.join(folder, ".ohmygame", "scenario-runs", runId);
  const checkpoints = path.join(root, "checkpoints");
  await mkdir(checkpoints, { recursive: true });
  return { root, checkpoints };
}

async function writeCheckpoint(root: string, file: string): Promise<void> {
  const target = path.join(root, "checkpoints", file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, PNG);
}

function runResult(runId: string, checkpoints: Array<{ name: string; file: string }>, overrides: Record<string, unknown> = {}) {
  return {
    exitCode: 0,
    output: "[rpytest] [log] - global::sample\nStatus: PASSED\n",
    outputTruncated: false,
    diagnostics: [{ severity: "info", message: "engine note" }],
    diagnosticsTruncated: false,
    validationCopy: true,
    scenario: {
      runId,
      requested: "sample",
      executedSelection: "global::sample",
      mode: "exploratory",
      status: "passed",
      startedAt: 1_000,
      completedAt: 2_000,
      timedOut: false,
      cancelled: false,
      checkpointOrder: "file-write-time",
      checkpointDirectory: `.ohmygame/scenario-runs/${runId}/checkpoints`,
      checkpointBytes: checkpoints.length * PNG.length,
      checkpointLimitReached: false,
      checkpointWarnings: [],
      checkpoints: checkpoints.map((item, order) => ({
        name: item.name,
        file: item.file,
        kind: "exploratory",
        order,
        width: 1,
        height: 1,
        bytes: PNG.length,
        capturedAt: 1_000 + order,
      })),
      ...overrides,
    },
  };
}

describe("Daemon scenario playtests", () => {
  it("runs the plugin, ingests only staged checkpoint files, and retrieves them exactly", async () => {
    const runs = new ScenarioRuns();
    const pluginServices = services({
      call: async (name, input) => {
        expect(name).toBe("renpy_scenario_run");
        expect(input).toMatchObject({ testcase: "sample", mode: "exploratory" });
        expect(input.runId).toMatch(/^[a-z0-9]{32}$/);
        const runId = String(input.runId);
        const staged = await staging(runId);
        await writeCheckpoint(staged.root, "first.png");
        await writeCheckpoint(staged.root, "nested/second.png");
        await writeFile(path.join(staged.root, "run.json"), JSON.stringify({ status: "running", requested: "sample" }));
        return runResult(runId, [{ name: "first", file: "first.png" }, { name: "nested/second", file: "nested/second.png" }]);
      },
    });
    const service = new ScenarioPlaytests({ plugins: pluginServices, runs });
    const run = await service.run(project, { scenario: "sample" });
    expect(run).toMatchObject({
      projectId: project.id,
      plugin: PLUGIN,
      scenario: "sample",
      executedSelection: "global::sample",
      status: "passed",
      exitCode: 0,
      diagnostics: [{ severity: "info", message: "engine note" }],
      diagnosticsComplete: true,
    });
    expect(run.checkpoints.map((item) => item.name)).toEqual(["first", "nested/second"]);
    expect(run.checkpoints.every((item) => item.retained)).toBe(true);
    const first = run.checkpoints[0]!;
    expect(service.checkpoint(project.id, first.id).data).toBe(PNG.toString("base64"));
    expect(service.find(project.id, first.id)).toMatchObject({ name: "first", retained: true });
    expect(service.list(project.id)).toEqual([run]);
    expect(() => service.checkpoint("project-b", first.id)).toThrow(/not retained/);
    await expect(lstat(path.join(folder, ".ohmygame", "scenario-runs", run.engineRunId))).rejects.toThrow();
  });

  it("passes a custom project-relative baseline folder for regression comparison", async () => {
    const pluginServices = services({
      call: async (name, input) => {
        expect(name).toBe("renpy_scenario_run");
        expect(input).toMatchObject({ mode: "regression", baselineDirectory: "tests/custom" });
        const runId = String(input.runId);
        await staging(runId);
        return runResult(runId, [], { mode: "regression", baselineDirectory: "tests/custom", baselineFiles: 1 });
      },
    });
    const service = new ScenarioPlaytests({ plugins: pluginServices, runs: new ScenarioRuns() });
    const run = await service.run(project, { scenario: "sample", mode: "regression", baselineDirectory: "tests/custom" });
    expect(run).toMatchObject({ mode: "regression", baselineDirectory: "tests/custom", baselineFiles: 1 });
  });

  it("reports engine-registered scenarios from the discovery tool", async () => {
    const pluginServices = services({
      call: async (name) => {
        expect(name).toBe("renpy_scenarios");
        return {
          status: "passed",
          authority: "engine",
          scenarios: [
            { name: "flow", kind: "testcase", file: "game/tests.rpy", line: 4, parameterized: true, default: false },
            { name: "global", kind: "testsuite", file: "game/testcases.rpy", line: 1, parameterized: false, default: true },
          ],
          truncated: false,
          exitCode: 0,
          errors: [],
          output: "engine output",
          outputTruncated: false,
          diagnostics: [],
          diagnosticsTruncated: false,
          validationCopy: true,
        };
      },
    });
    const service = new ScenarioPlaytests({ plugins: pluginServices, runs: new ScenarioRuns() });
    const discovery = await service.discover(project);
    expect(discovery).toMatchObject({
      status: "passed",
      authority: "engine",
      scenarios: [
        expect.objectContaining({ name: "flow", kind: "testcase", parameterized: true, default: false }),
        expect.objectContaining({ name: "global", kind: "testsuite", default: true }),
      ],
      truncated: false,
      outputExcerpt: "engine output",
    });
  });

  it("refuses a project without an active scenario-capable Ren'Py plugin", async () => {
    const inactive = new ScenarioPlaytests({ plugins: services({ active: false }), runs: new ScenarioRuns() });
    await expect(inactive.discover(project)).rejects.toThrow(/not active/);
    const old = new ScenarioPlaytests({
      plugins: {
        resolve: async () => ({ ok: true, typeReady: true, plugins: [{ id: PLUGIN, version: "0.1.0", status: "active", providesType: false, everyProject: false, entry: entry([]) }] }),
        callTool: async () => ({}),
      } as unknown as PluginServices,
      runs: new ScenarioRuns(),
    });
    await expect(old.run(project, { scenario: "sample" })).rejects.toThrow(/does not provide scenario playtesting/);
  });

  it("recovers partial checkpoints after cancellation and keeps the failure truthful", async () => {
    const controller = new AbortController();
    const pluginServices = services({
      call: async (_name, input) => {
        const runId = String(input.runId);
        const staged = await staging(runId);
        await writeCheckpoint(staged.root, "cancel-01.png");
        await writeFile(path.join(staged.root, "run.json"), JSON.stringify({
          runId, requested: "sample", mode: "exploratory", status: "running", startedAt: 1_000,
          checkpointWarnings: ["engine was stopped"], checkpoints: [],
        }));
        controller.abort();
        throw new Error("Plugin call cancelled");
      },
    });
    const service = new ScenarioPlaytests({ plugins: pluginServices, runs: new ScenarioRuns() });
    const run = await service.run(project, { scenario: "sample" }, controller.signal);
    expect(run).toMatchObject({
      status: "cancelled",
      cancelled: true,
      failure: "Plugin call cancelled",
      checkpoints: [expect.objectContaining({ name: "cancel-01", retained: true })],
    });
    expect(run.checkpointWarnings.join(" ")).toMatch(/Recovered partial evidence/);
    expect(service.checkpoint(project.id, run.checkpoints[0]!.id).data).toBe(PNG.toString("base64"));
  });

  it("records staged evidence after an invocation failure without claiming a clean run", async () => {
    const pluginServices = services({
      call: async (_name, input) => {
        const staged = await staging(String(input.runId));
        await writeCheckpoint(staged.root, "crash-01.png");
        throw new Error("Extension host crashed");
      },
    });
    const service = new ScenarioPlaytests({ plugins: pluginServices, runs: new ScenarioRuns() });
    const run = await service.run(project, { scenario: "sample" });
    expect(run).toMatchObject({
      status: "invocation-error",
      cancelled: false,
      timedOut: false,
      failure: "Extension host crashed",
      checkpoints: [expect.objectContaining({ name: "crash-01", retained: true })],
    });
  });

  it("redacts stored scenario output and diagnostics before they reach observations", async () => {
    const pluginServices = services({
      call: async (_name, input) => {
        const runId = String(input.runId);
        await staging(runId);
        return {
          ...runResult(runId, []),
          output: "token secret in output",
          diagnostics: [{ severity: "error", message: "secret diagnostic", path: "game/secret.rpy" }],
          outputTruncated: false,
        };
      },
    });
    const service = new ScenarioPlaytests({ plugins: pluginServices, runs: new ScenarioRuns() });
    const run = await service.run(project, { scenario: "sample" });
    expect(run.outputExcerpt).toContain("[redacted]");
    expect(run.outputExcerpt).not.toContain("secret");
    expect(run.diagnostics[0]?.message).toContain("[redacted]");
    expect(run.diagnostics[0]?.message).not.toContain("secret");
    expect(run.diagnostics[0]?.path).not.toContain("secret");
  });

  it("keeps a timed-out manifest status when the plugin result is lost", async () => {
    const pluginServices = services({
      call: async (_name, input) => {
        const runId = String(input.runId);
        const staged = await staging(runId);
        await writeFile(path.join(staged.root, "run.json"), JSON.stringify({
          runId, requested: "sample", mode: "exploratory", status: "timed-out",
          timedOut: true, startedAt: 1, completedAt: 2, checkpoints: [],
        }));
        throw new Error("Plugin call timed out");
      },
    });
    const service = new ScenarioPlaytests({ plugins: pluginServices, runs: new ScenarioRuns() });
    const run = await service.run(project, { scenario: "sample" });
    expect(run).toMatchObject({ status: "timed-out", timedOut: true, cancelled: false });
    expect(run.failure).toMatch(/timed out/);
    expect(run.checkpointWarnings.join(" ")).toMatch(/Recovered partial evidence/);
  });

  it("refuses a staged checkpoint reached through a parent junction", async () => {
    const outside = path.join(folder, "outside-checkpoints");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "outside.png"), PNG);
    let linked = false;
    const pluginServices = services({
      call: async (_name, input) => {
        const runId = String(input.runId);
        const staged = await staging(runId);
        try {
          await symlink(outside, path.join(staged.root, "checkpoints", "linked"), process.platform === "win32" ? "junction" : "dir");
          linked = true;
        } catch (error) {
          if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EPERM")
            return runResult(runId, [], { checkpointWarnings: ["The host did not allow a junction test."] });
          throw error;
        }
        return runResult(runId, [{ name: "outside", file: "linked/outside.png" }]);
      },
    });
    const service = new ScenarioPlaytests({ plugins: pluginServices, runs: new ScenarioRuns() });
    const run = await service.run(project, { scenario: "sample" });
    if (!linked) return;
    expect(run.checkpoints[0]).toMatchObject({ name: "outside", retained: false });
    expect(run.checkpointWarnings.join(" ")).toMatch(/resolved file was outside/);
  });

  it("rethrows when nothing was staged and discards evidence after the project closes", async () => {
    const nothing = new ScenarioPlaytests({
      plugins: services({ call: async () => { throw new Error("Plugin call cancelled"); } }),
      runs: new ScenarioRuns(),
    });
    await expect(nothing.run(project, { scenario: "sample" })).rejects.toThrow(/Plugin call cancelled/);

    const runs = new ScenarioRuns();
    const closed = new ScenarioPlaytests({
      plugins: services({
        call: async (_name, input) => {
          const staged = await staging(String(input.runId));
          await writeCheckpoint(staged.root, "closed-01.png");
          return runResult(String(input.runId), [{ name: "closed-01", file: "closed-01.png" }]);
        },
      }),
      runs,
      projectExists: () => false,
    });
    await expect(closed.run(project, { scenario: "sample" })).rejects.toThrow(/project closed/);
    expect(runs.list(project.id)).toEqual([]);
    expect(await readFile(path.join(folder, "game", "script.rpy"), "utf8")).toContain("label start");
  });

  it("aborts an in-flight scenario when the project is forgotten", async () => {
    let exists = true;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let observed: AbortSignal | undefined;
    let capturedRunId = "";
    const pluginServices = services({
      call: async (_name, input, signal) => {
        capturedRunId = String(input.runId);
        const staged = await staging(capturedRunId);
        await writeCheckpoint(staged.root, "in-flight.png");
        observed = signal;
        started();
        await new Promise<never>((_resolve, reject) => {
          if (signal?.aborted) return reject(new Error("Plugin call cancelled"));
          signal?.addEventListener("abort", () => reject(new Error("Plugin call cancelled")), { once: true });
        });
      },
    });
    const runs = new ScenarioRuns();
    const service = new ScenarioPlaytests({ plugins: pluginServices, runs, projectExists: () => exists });
    const pending = service.run(project, { scenario: "sample" });
    await ready;
    exists = false;
    service.forget(project.id);
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(observed?.aborted).toBe(true);
    expect(runs.list(project.id)).toEqual([]);
    await expect(lstat(path.join(folder, ".ohmygame", "scenario-runs", capturedRunId))).rejects.toThrow();
  });

  it("keeps a missing staged image as metadata and refuses to substitute another image", async () => {
    const pluginServices = services({
      call: async (_name, input) => {
        const runId = String(input.runId);
        await staging(runId);
        return runResult(runId, [{ name: "missing", file: "missing.png" }], { checkpointWarnings: [] });
      },
    });
    const service = new ScenarioPlaytests({ plugins: pluginServices, runs: new ScenarioRuns() });
    const run = await service.run(project, { scenario: "sample" });
    expect(run.checkpoints[0]).toMatchObject({ name: "missing", retained: false });
    expect(run.checkpointWarnings.join(" ")).toMatch(/no staged image/);
    expect(() => service.checkpoint(project.id, run.checkpoints[0]!.id)).toThrow(/no longer retained/);
  });
});
