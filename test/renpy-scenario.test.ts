import { lstat, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error Plugin native modules are intentionally plain JavaScript.
import { discoverScenarios, runScenario, scenarioSelection, scenarioStatus } from "../plugins/renpy/native/scenario.mjs";

// A complete 1x1 PNG, so checkpoint validation sees a real engine-shaped file.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

type CheckpointRow = { name: string; kind: string; order: number; width: number; height: number };

let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "ohmygame-renpy-scenario-"));
  await mkdir(path.join(folder, "game"), { recursive: true });
  await writeFile(path.join(folder, "game", "script.rpy"), "label start:\n    return\n");
  await writeFile(path.join(folder, "game", "testcases.rpy"), "testcase sample:\n    pass\n");
});
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });

const command = () => ({ executable: "renpy", prefixArgs: [], sdkPath: folder });

async function scenarioRunRoot(args: string[]) {
  const mirror = args[2]!;
  const root = path.join(mirror, "game", ".ohmygame-scenario");
  const entries = await readdir(root, { withFileTypes: true });
  const directory = entries.find((entry) => entry.isDirectory());
  if (!directory) throw new Error("No scenario directory in the mirror");
  return path.join(root, directory.name);
}

async function writeScreenshot(root: string, relative: string, contents = PNG) {
  const target = path.join(root, "screenshots", relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

function result(output = "", exitCode = 0) {
  return { exitCode, output, errors: [], outputTruncated: false };
}

describe("Ren'Py scenario discovery", () => {
  it("returns the testcases the engine actually registered and hides its own probe", async () => {
    const run = async (_command: unknown, args: string[]) => {
      const root = await scenarioRunRoot(args);
      const game = path.join(args[2]!, "game");
      const source = (await readdir(game)).find((name) => name.startsWith("zz_ohmygame_discover_"));
      if (!source) throw new Error("No discovery file");
      expect(await readFile(path.join(game, source), "utf8")).toContain("\n    exit");
      const discovery = args[4]!;
      await writeFile(path.join(root, "testcases.json"), JSON.stringify([
        { name: discovery, kind: "testcase", file: "game/discover.rpy", line: 1, parameterized: false },
        { name: "global", kind: "testsuite", file: "game/testcases.rpy", line: 1, parameterized: false },
        { name: "flow", kind: "testcase", file: "game/tests.rpy", line: 4, parameterized: true },
        { name: "flow.child", kind: "testcase", file: "game/tests.rpy", line: 9, parameterized: false },
      ]), "utf8");
      return result("[rpytest] [log] Running 1 test(s) marked with 'only' flag.\n");
    };
    const discovered = await discoverScenarios(command(), folder, { execute: run });
    expect(discovered).toMatchObject({
      status: "passed",
      authority: "engine",
      truncated: false,
      exitCode: 0,
      validationCopy: true,
    });
    expect(discovered.scenarios).toEqual([
      expect.objectContaining({ name: "flow", kind: "testcase", file: "game/tests.rpy", line: 4, parameterized: true, default: false }),
      expect.objectContaining({ name: "flow.child", kind: "testcase", parameterized: false }),
      expect.objectContaining({ name: "global", kind: "testsuite", default: true }),
    ]);
    expect(discovered.output).toContain("Running 1 test");
    await expect(lstat(path.join(folder, "game", ".ohmygame-scenario"))).rejects.toThrow();
  });

  it("distinguishes a project that cannot load from an empty registry", async () => {
    const discovered = await discoverScenarios(command(), folder, {
      execute: async () => result("Error: game/script.rpy:1 Parse error\n", 1),
    });
    expect(discovered).toMatchObject({ status: "failed", scenarios: [], exitCode: 1 });
    expect(discovered.output).toContain("Parse error");
  });
});

describe("Ren'Py scenario execution", () => {
  it("collects ordered engine screenshots from the mirror and stages only those files", async () => {
    const seen: string[] = [];
    const run = async (_command: unknown, args: string[]) => {
      const root = await scenarioRunRoot(args);
      await writeScreenshot(root, "scene/01-first.png");
      await writeScreenshot(root, "scene/02-second.png");
      await writeScreenshot(root, "scene/03-third.png");
      seen.push(path.dirname(root));
      return result("[rpytest] [log] Running 1 test(s) marked with 'only' flag.\r\n[rpytest] [log] - global::sample\r\nStatus: PASSED\r\n");
    };
    const runResult = await runScenario(command(), folder, { testcase: "sample", mode: "exploratory" }, { execute: run });
    expect(runResult).toMatchObject({
      exitCode: 0,
      validationCopy: true,
      scenario: {
        requested: "sample",
        executedSelection: "global::sample",
        mode: "exploratory",
        status: "passed",
        timedOut: false,
        cancelled: false,
        checkpointLimitReached: false,
        checkpointOrder: "file-write-time",
      },
    });
    expect(runResult.scenario.checkpoints.map((item: CheckpointRow) => item.name)).toEqual([
      "scene/01-first", "scene/02-second", "scene/03-third",
    ]);
    expect(runResult.scenario.checkpoints.every((item: CheckpointRow) => item.kind === "exploratory" && item.width === 1 && item.height === 1)).toBe(true);
    const staged = path.join(folder, ".ohmygame", "scenario-runs", runResult.scenario.runId);
    expect(await readdir(path.join(staged, "checkpoints", "scene"))).toEqual(["01-first.png", "02-second.png", "03-third.png"]);
    expect(JSON.parse(await readFile(path.join(staged, "run.json"), "utf8"))).toMatchObject({ status: "passed", requested: "sample" });
    expect(seen[0]).not.toBe(folder);
    await expect(lstat(seen[0]!)).rejects.toThrow();
    expect((await readdir(path.join(folder, "game"))).sort()).toEqual(["script.rpy", "testcases.rpy"]);
  });

  it("installs the screenshot containment guard in the mirror", async () => {
    let source = "";
    const run = async (_command: unknown, args: string[]) => {
      const game = path.join(args[2]!, "game");
      const setup = (await readdir(game)).find((name) => name.startsWith("zz_ohmygame_scenario_"));
      if (!setup) throw new Error("No scenario setup file");
      source = await readFile(path.join(game, setup), "utf8");
      return result();
    };
    await runScenario(command(), folder, { testcase: "sample" }, { execute: run });
    expect(source).toContain("init 999 python:");
    expect(source).toContain("_scenario_safe_screenshot_start");
    expect(source).toContain("escapes the controlled checkpoint directory");
  });

  it("says explicitly when a passing scenario produced no screenshots", async () => {
    const runResult = await runScenario(command(), folder, { testcase: "sample" }, {
      execute: async () => result("[rpytest] [log] - global::sample\nStatus: PASSED\n"),
    });
    expect(runResult.scenario).toMatchObject({ status: "passed", checkpoints: [] });
    expect(runResult.scenario.checkpointWarnings.join(" ")).toMatch(/No engine-rendered screenshots/);
  });

  it("reports a missing selection as not found instead of an empty run", async () => {
    const runResult = await runScenario(command(), folder, { testcase: "missing_scene" }, {
      execute: async () => result("KeyError: 'TestCase missing_scene not found.'\n", 1),
    });
    expect(runResult.scenario).toMatchObject({ status: "not-found", requested: "missing_scene" });
    expect(runResult.scenario.checkpoints).toEqual([]);
    expect(runResult.scenario.executedSelection).toBeUndefined();
  });

  it("keeps checkpoints and pre-stop output when the engine times out", async () => {
    const run = async (_command: unknown, args: string[]) => {
      const root = await scenarioRunRoot(args);
      await writeScreenshot(root, "timeout-01.png");
      throw Object.assign(new Error("Ren'Py command timed out"), {
        output: "[rpytest] [log] - global::sample\npartial output before stop",
        errors: [],
        outputTruncated: false,
      });
    };
    const runResult = await runScenario(command(), folder, { testcase: "sample" }, { execute: run });
    expect(runResult.scenario).toMatchObject({
      status: "timed-out",
      timedOut: true,
      cancelled: false,
      checkpoints: [expect.objectContaining({ name: "timeout-01", kind: "exploratory" })],
    });
    expect(runResult.output).toContain("partial output before stop");
  });

  it("keeps checkpoints and pre-stop output when the run is cancelled", async () => {
    const controller = new AbortController();
    const run = async (_command: unknown, args: string[]) => {
      const root = await scenarioRunRoot(args);
      await writeScreenshot(root, "cancel-01.png");
      controller.abort();
      throw Object.assign(new Error("Ren'Py command cancelled"), {
        output: "[rpytest] [log] - global::sample\ncancelled output",
        errors: [],
        outputTruncated: false,
      });
    };
    const runResult = await runScenario(command(), folder, { testcase: "sample" }, { execute: run, signal: controller.signal });
    expect(runResult.scenario).toMatchObject({
      status: "cancelled",
      cancelled: true,
      timedOut: false,
      checkpoints: [expect.objectContaining({ name: "cancel-01" })],
    });
    expect(runResult.output).toContain("cancelled output");
  });

  it("refuses unsafe scenario names, run IDs and baseline folders before running", async () => {
    const execute = async () => { throw new Error("should not run"); };
    await expect(runScenario(command(), folder, { testcase: "--danger" }, { execute })).rejects.toThrow(/scenario must be/i);
    await expect(runScenario(command(), folder, { testcase: "sample", runId: "UPPER" }, { execute })).rejects.toThrow(/run ID/i);
    await expect(runScenario(command(), folder, { testcase: "sample", mode: "regression", baselineDirectory: "../outside" }, { execute })).rejects.toThrow(/baseline folder/i);
    await expect(runScenario(command(), folder, { testcase: "sample", mode: "regression", baselineDirectory: "/absolute" }, { execute })).rejects.toThrow(/baseline folder/i);
  });
});

describe("Ren'Py scenario regression observation", () => {
  it("compares against copied baselines, keeps mismatches as evidence and leaves the project baseline untouched", async () => {
    const baseline = path.join(folder, "tests", "screenshots", "scene-01.png");
    await mkdir(path.dirname(baseline), { recursive: true });
    await writeFile(baseline, PNG);
    let mirrorScreenshot: string | undefined;
    const run = async (_command: unknown, args: string[]) => {
      const root = await scenarioRunRoot(args);
      const screenshot = path.join(root, "screenshots", "scene-01.png");
      mirrorScreenshot = screenshot;
      expect(await readFile(screenshot)).toEqual(PNG);
      await writeFile(path.join(root, "screenshots", "scene-01.new.png"), Buffer.concat([PNG, Buffer.from("new")]));
      await writeFile(path.join(root, "screenshots", "scene-01.diff.png"), PNG);
      return result("RenpyTestScreenshotError: scene-01 (pixel difference: 1 > 0)\n", 1);
    };
    const runResult = await runScenario(command(), folder, { testcase: "sample", mode: "regression" }, { execute: run });
    expect(mirrorScreenshot).not.toBe(baseline);
    expect(runResult.scenario).toMatchObject({
      status: "failed",
      mode: "regression",
      baselineDirectory: "tests/screenshots",
      baselineFiles: 1,
    });
    expect(runResult.scenario.checkpoints.map((item: CheckpointRow) => `${item.name}:${item.kind}`)).toEqual([
      "scene-01:mismatched", "scene-01:difference",
    ]);
    expect(await readFile(baseline)).toEqual(PNG);
  });

  it("does not present a matched baseline as a fresh checkpoint", async () => {
    const baseline = path.join(folder, "tests", "screenshots", "scene-01.png");
    await mkdir(path.dirname(baseline), { recursive: true });
    await writeFile(baseline, PNG);
    const run = async (_command: unknown, args: string[]) => {
      const root = await scenarioRunRoot(args);
      expect(await readFile(path.join(root, "screenshots", "scene-01.png"))).toEqual(PNG);
      return result("Status: PASSED\n", 0);
    };
    const runResult = await runScenario(command(), folder, { testcase: "sample", mode: "regression" }, { execute: run });
    expect(runResult.scenario).toMatchObject({ status: "passed", baselineFiles: 1, checkpoints: [] });
    expect(runResult.scenario.checkpointWarnings.join(" ")).toMatch(/No new screenshots were produced in regression mode/);
  });

  it("refuses regression when the project has no baselines", async () => {
    await expect(runScenario(command(), folder, { testcase: "sample", mode: "regression" }, {
      execute: async () => { throw new Error("should not run"); },
    })).rejects.toThrow(/No baseline screenshots/i);

    await mkdir(path.join(folder, "tests", "screenshots"), { recursive: true });
    await expect(runScenario(command(), folder, { testcase: "sample", mode: "regression" }, {
      execute: async () => { throw new Error("should not run"); },
    })).rejects.toThrow(/No usable PNG baseline/i);
  });
});

describe("Ren'Py scenario staging bounds", () => {
  it("keeps a bounded number of recent staged runs", async () => {
    const runs = path.join(folder, ".ohmygame", "scenario-runs");
    await mkdir(runs, { recursive: true });
    for (let index = 0; index < 10; index += 1) {
      const name = `run${String(index).padStart(5, "0")}x`;
      const root = path.join(runs, name);
      await mkdir(root);
      await writeFile(path.join(root, "run.json"), JSON.stringify({ status: "passed" }));
      const seconds = 1_700_000_000 + index * 10;
      await utimes(root, seconds, seconds);
    }
    const run = async (_command: unknown, args: string[]) => {
      const root = await scenarioRunRoot(args);
      await writeScreenshot(root, "bound-01.png");
      return result();
    };
    const runResult = await runScenario(command(), folder, { testcase: "sample" }, { execute: run });
    const remaining = (await readdir(runs, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    expect(remaining).toContain(runResult.scenario.runId);
    expect(remaining).toHaveLength(8);
    expect(remaining).not.toContain("run00000x");
    expect(remaining).not.toContain("run00001x");
    expect(remaining).not.toContain("run00002x");
  });
});

describe("Ren'Py scenario reporting helpers", () => {
  it("reads only an engine-reported selection", () => {
    expect(scenarioSelection("noise\n[rpytest] [log] - global::flow\n")).toBe("global::flow");
    expect(scenarioSelection("noise without a selection")).toBeUndefined();
  });

  it("distinguishes not-found, failed, cancelled, timed-out and invocation failures", () => {
    expect(scenarioStatus({ exitCode: 1, output: "KeyError: 'TestCase absent not found.'" })).toBe("not-found");
    expect(scenarioStatus({ exitCode: 1, output: "" })).toBe("failed");
    expect(scenarioStatus({ exitCode: 0, output: "" })).toBe("passed");
    expect(scenarioStatus({ exitCode: 0, output: "[rpytest] Status: SKIPPED \n" })).toBe("skipped");
    expect(scenarioStatus({ exitCode: null, output: "", cancelled: true })).toBe("cancelled");
    expect(scenarioStatus({ exitCode: null, output: "", timedOut: true })).toBe("timed-out");
    expect(scenarioStatus({ exitCode: null, output: "", invocationError: "spawn failed" })).toBe("invocation-error");
    expect(scenarioStatus({ exitCode: null, output: "" })).toBe("unknown");
  });
});
