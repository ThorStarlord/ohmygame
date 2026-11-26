import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerScenarioRoutes } from "../src/daemon/scenario-routes.js";
import type { ProjectState } from "../src/shared/contracts.js";
import type { ScenarioCheckpoint, ScenarioCheckpointSummary, ScenarioDiscovery, ScenarioRunSummary } from "../src/shared/engine-observations.js";

const project = {
  id: "project-a",
  name: "Pilot",
  type: "general",
  updatedAt: "2026-11-26T00:00:00.000Z",
  workspacePath: "C:\\pilot",
  preview: { status: "stopped" },
} as ProjectState;

const run = {
  id: "run-1", projectId: project.id, plugin: "thorstarlord/renpy", pluginVersion: "0.2.0",
  engineRunId: "abcdef1234567890", scenario: "flow", executedSelection: "global::flow",
  mode: "exploratory", status: "passed", startedAt: 1, completedAt: 2, exitCode: 0,
  timedOut: false, cancelled: false, checkpointOrder: "file-write-time",
  checkpointLimitReached: false, checkpointWarnings: [], checkpoints: [], diagnostics: [], diagnosticsComplete: true,
} as ScenarioRunSummary;

const summary = {
  id: "checkpoint-1", runId: run.id, plugin: "thorstarlord/renpy", scenario: "flow",
  name: "scene/01", file: "scene/01.png", kind: "exploratory", mode: "exploratory",
  order: 0, width: 1, height: 1, mediaType: "image/png", bytes: 68, capturedAt: 1, retained: true,
} as ScenarioCheckpointSummary;

const checkpoint = { ...summary, data: "iVBORw0KGgo=" } as ScenarioCheckpoint;

const discovery = {
  status: "passed", authority: "engine",
  scenarios: [{ name: "flow", kind: "testcase", parameterized: false, default: false }],
  truncated: false, exitCode: 0, errors: [], diagnostics: [], diagnosticsComplete: true,
} as ScenarioDiscovery;

function setup() {
  const app = Fastify();
  const playtests = {
    discover: vi.fn(async () => discovery),
    run: vi.fn(async () => run),
    list: vi.fn(() => [run]),
    find: vi.fn((projectId: string, checkpointId: string) => projectId === project.id && checkpointId === summary.id ? summary : undefined),
    checkpoint: vi.fn(() => checkpoint),
  };
  registerScenarioRoutes(app, {
    projects: { get: (id) => id === project.id ? project : id === "evicted" ? { ...project, id: "evicted" } : undefined },
    playtests,
  });
  return { app, playtests };
}

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("Scenario HTTP routes", () => {
  it("discovers engine scenarios and runs one explicitly", async () => {
    const { app, playtests } = setup();
    apps.push(app);
    const found = await app.inject({ method: "POST", url: "/projects/project-a/scenarios/discover" });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ status: "passed", authority: "engine", scenarios: [expect.objectContaining({ name: "flow" })] });
    expect(playtests.discover).toHaveBeenCalledWith(project, expect.any(AbortSignal));

    const started = await app.inject({
      method: "POST", url: "/projects/project-a/scenario-runs",
      payload: { scenario: "flow", mode: "regression", baselineDirectory: "tests/custom" },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ id: "run-1", status: "passed" });
    expect(playtests.run).toHaveBeenCalledWith(project, {
      scenario: "flow", mode: "regression", baselineDirectory: "tests/custom",
    }, expect.any(AbortSignal));

    const defaulted = await app.inject({ method: "POST", url: "/projects/project-a/scenario-runs", payload: { scenario: "flow" } });
    expect(defaulted.statusCode).toBe(200);
    expect(playtests.run).toHaveBeenLastCalledWith(project, { scenario: "flow" }, expect.any(AbortSignal));
  });

  it("validates the run body and reports unavailable projects or refused runs", async () => {
    const { app, playtests } = setup();
    apps.push(app);
    expect((await app.inject({ method: "POST", url: "/projects/project-a/scenario-runs", payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/projects/project-a/scenario-runs", payload: { scenario: "flow", mode: "video" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/projects/missing/scenario-runs", payload: { scenario: "flow" } })).statusCode).toBe(404);
    playtests.run.mockRejectedValueOnce(new Error("The Ren'Py plugin is not active for this project."));
    const refused = await app.inject({ method: "POST", url: "/projects/project-a/scenario-runs", payload: { scenario: "flow" } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "The Ren'Py plugin is not active for this project." });
  });

  it("lists retained runs and retrieves one exact checkpoint", async () => {
    const { app, playtests } = setup();
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/projects/project-a/scenario-runs" })).json()).toEqual({ runs: [run] });
    expect((await app.inject({ method: "GET", url: "/projects/missing/scenario-runs" })).statusCode).toBe(404);

    const exact = await app.inject({ method: "GET", url: "/projects/project-a/scenario-checkpoints/checkpoint-1" });
    expect(exact.statusCode).toBe(200);
    expect(exact.json()).toMatchObject({ id: "checkpoint-1", data: "iVBORw0KGgo=" });
    expect(playtests.checkpoint).toHaveBeenCalledWith(project.id, "checkpoint-1");
    expect((await app.inject({ method: "GET", url: "/projects/project-a/scenario-checkpoints/missing" })).statusCode).toBe(404);
  });

  it("distinguishes an evicted image from a missing checkpoint", async () => {
    const { app } = setup();
    apps.push(app);
    // The route asks the project's service; make this project report an
    // evicted checkpoint through the same exact ID contract.
    const evictedApp = Fastify();
    apps.push(evictedApp);
    registerScenarioRoutes(evictedApp, {
      projects: { get: (id) => id === "evicted" ? { ...project, id: "evicted" } : undefined },
      playtests: {
        discover: async () => discovery,
        run: async () => run,
        list: () => [],
        find: (_id, checkpointId) => checkpointId === "evicted-1" ? { ...summary, id: "evicted-1", retained: false } : undefined,
        checkpoint: () => { throw new Error("should not be called"); },
      },
    });
    const response = await evictedApp.inject({ method: "GET", url: "/projects/evicted/scenario-checkpoints/evicted-1" });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({ error: "That scenario checkpoint's image is no longer retained" });
  });
});
