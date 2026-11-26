import { describe, expect, it } from "vitest";
import {
  isScenarioCheckpointKind,
  isScenarioRunId,
  isScenarioRunStatus,
  ScenarioRuns,
  type ScenarioCheckpointInput,
  type ScenarioRunInput,
} from "../src/daemon/scenario-runs.js";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(width = 1, height = 1, size = 64): string {
  const buffer = Buffer.alloc(Math.max(24, size));
  Buffer.from(PNG_SIGNATURE).copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer.toString("base64");
}

function checkpoint(name: string, order: number, size = 64, overrides: Partial<ScenarioCheckpointInput> = {}): ScenarioCheckpointInput {
  const data = png(1, 1, size);
  return {
    name,
    file: `${name}.png`,
    kind: "exploratory",
    order,
    width: 1,
    height: 1,
    bytes: Buffer.from(data, "base64").length,
    capturedAt: 1_000 + order,
    data,
    ...overrides,
  };
}

function input(overrides: Partial<ScenarioRunInput> = {}): ScenarioRunInput {
  return {
    plugin: "thorstarlord/renpy",
    pluginVersion: "0.2.0",
    engineRunId: "abcdef1234567890",
    scenario: "sample",
    mode: "exploratory",
    status: "passed",
    startedAt: 1_000,
    completedAt: 2_000,
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    checkpointOrder: "file-write-time",
    checkpointLimitReached: false,
    checkpointWarnings: [],
    checkpoints: [],
    diagnostics: [],
    diagnosticsComplete: true,
    ...overrides,
  };
}

describe("Scenario checkpoint retention", () => {
  it("assigns stable checkpoint identities and returns image data only on exact retrieval", () => {
    const runs = new ScenarioRuns();
    const summary = runs.add("project-a", input({
      checkpoints: [checkpoint("first", 0), checkpoint("second", 1)],
    }));
    expect(summary).toMatchObject({
      projectId: "project-a",
      plugin: "thorstarlord/renpy",
      pluginVersion: "0.2.0",
      scenario: "sample",
      status: "passed",
      checkpointOrder: "file-write-time",
    });
    expect(summary.checkpoints).toHaveLength(2);
    expect(summary.checkpoints.every((item) => item.retained && item.mediaType === "image/png")).toBe(true);
    expect("data" in summary.checkpoints[0]!).toBe(false);
    const first = summary.checkpoints[0]!;
    expect(runs.find("project-a", first.id)).toEqual(first);
    expect(runs.get("project-a", first.id)?.data).toBe(checkpoint("first", 0).data);
    expect(runs.get("project-b", first.id)).toBeUndefined();
    expect(runs.list("project-a")).toEqual([summary]);
    expect(runs.list("project-b")).toEqual([]);
  });

  it("keeps a bounded number of runs per project", () => {
    const runs = new ScenarioRuns({ runs: 3 });
    runs.add("project-a", input({ completedAt: 1_000 }));
    runs.add("project-a", input({ completedAt: 2_000 }));
    runs.add("project-a", input({ completedAt: 3_000 }));
    const newest = runs.add("project-a", input({ completedAt: 4_000 }));
    expect(runs.list("project-a")).toHaveLength(3);
    expect(runs.list("project-a")[0]!.id).toBe(newest.id);
    expect(runs.list("project-a").map((run) => run.completedAt)).toEqual([4_000, 3_000, 2_000]);
  });

  it("evicts complete old runs before taking images from the newest run", () => {
    const runs = new ScenarioRuns({ projectBytes: 3_000 });
    const older = runs.add("project-a", input({
      completedAt: 1_000,
      checkpoints: [checkpoint("a", 0, 600), checkpoint("b", 1, 600), checkpoint("c", 2, 600)],
    }));
    const newer = runs.add("project-a", input({
      completedAt: 2_000,
      checkpoints: [checkpoint("a", 0, 600), checkpoint("b", 1, 600), checkpoint("c", 2, 600)],
    }));
    expect(runs.list("project-a")[0]!.id).toBe(newer.id);
    expect(runs.retainedBytes("project-a")).toBeLessThanOrEqual(5_000);
    for (const item of runs.list("project-a").find((run) => run.id === older.id)!.checkpoints) {
      expect(item.retained).toBe(false);
      expect(runs.get("project-a", item.id)).toBeUndefined();
      expect(runs.find("project-a", item.id)).toMatchObject({ retained: false, name: item.name });
    }
    for (const item of newer.checkpoints.filter((item) => item.retained))
      expect(runs.get("project-a", item.id)).toBeDefined();
  });

  it("retains a single oversized run's earliest checkpoints and reports the rest as evicted", () => {
    const runs = new ScenarioRuns({ projectBytes: 1_000 });
    const summary = runs.add("project-a", input({
      checkpoints: [checkpoint("first", 0, 600), checkpoint("second", 1, 600), checkpoint("third", 2, 600)],
    }));
    expect(runs.retainedBytes("project-a")).toBeLessThanOrEqual(1_000);
    expect(summary.checkpoints.map((item) => [item.name, item.retained])).toEqual([
      ["first", true], ["second", false], ["third", false],
    ]);
    expect(runs.get("project-a", summary.checkpoints[0]!.id)).toBeDefined();
    expect(runs.get("project-a", summary.checkpoints[2]!.id)).toBeUndefined();
  });

  it("enforces the daemon-wide budget across projects", () => {
    const runs = new ScenarioRuns({ projectBytes: 10_000, totalBytes: 3_000 });
    runs.add("project-a", input({
      completedAt: 1_000,
      checkpoints: [checkpoint("a", 0, 600), checkpoint("b", 1, 600), checkpoint("c", 2, 600)],
    }));
    const newer = runs.add("project-b", input({
      completedAt: 2_000,
      checkpoints: [checkpoint("a", 0, 600), checkpoint("b", 1, 600), checkpoint("c", 2, 600)],
    }));
    expect(runs.retainedBytes()).toBeLessThanOrEqual(3_000);
    expect(runs.list("project-a")[0]!.checkpoints.every((item) => !item.retained)).toBe(true);
    expect(runs.list("project-b")[0]!.checkpoints.every((item) => item.retained)).toBe(true);
    expect(runs.get("project-b", newer.checkpoints[0]!.id)).toBeDefined();
  });

  it("keeps invalid image data as metadata with an explicit warning", () => {
    const runs = new ScenarioRuns();
    const summary = runs.add("project-a", input({
      checkpoints: [
        checkpoint("valid", 0),
        { ...checkpoint("invalid", 1), data: "not-base64" },
        { ...checkpoint("mismatched", 2), data: png(2, 2) },
      ],
    }));
    expect(summary.checkpoints.map((item) => item.retained)).toEqual([true, false, false]);
    expect(summary.checkpointWarnings.join(" ")).toMatch(/Skipped the image|invalid/i);
    expect(runs.get("project-a", summary.checkpoints[1]!.id)).toBeUndefined();
    expect(runs.find("project-a", summary.checkpoints[1]!.id)).toMatchObject({ name: "invalid", retained: false });
  });

  it("bounds diagnostics, warnings and output, and forgets a closed project", () => {
    const runs = new ScenarioRuns();
    const summary = runs.add("project-a", input({
      diagnostics: Array.from({ length: 60 }, (_, index) => ({ severity: "error" as const, message: `finding ${index}`, path: "game/script.rpy", line: index + 1 })),
      checkpointWarnings: Array.from({ length: 20 }, (_, index) => ` warning ${index} `),
      outputExcerpt: "x".repeat(20_000),
      outputOmitted: true,
    }));
    expect(summary.diagnostics).toHaveLength(50);
    expect(summary.diagnosticsComplete).toBe(false);
    expect(summary.checkpointWarnings).toHaveLength(12);
    expect(summary.outputExcerpt).toHaveLength(8_192);
    expect(summary.outputOmitted).toBe(true);
    runs.forget("project-a");
    expect(runs.list("project-a")).toEqual([]);
  });

  it("recognizes the public status, kind and run identity shapes", () => {
    expect(isScenarioRunStatus("passed")).toBe(true);
    expect(isScenarioRunStatus("timed-out")).toBe(true);
    expect(isScenarioRunStatus("running")).toBe(false);
    expect(isScenarioCheckpointKind("mismatched")).toBe(true);
    expect(isScenarioCheckpointKind("native-capture")).toBe(false);
    expect(isScenarioRunId("abcdef1234567890")).toBe(true);
    expect(isScenarioRunId("UPPER")).toBe(false);
  });
});
