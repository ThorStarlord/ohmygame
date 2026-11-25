import { describe, expect, it } from "vitest";
import { EngineCheckHistory, compareReportedChecks, renpyCheckOperation, renpyCommandOperation } from "../src/daemon/engine-check-history.js";
import type { EngineDiagnostic } from "../src/shared/engine-observations.js";

const plugin = "thorstarlord/renpy";
const plain = (text: string) => text;
const diagnostic = (message: string, extra: Partial<EngineDiagnostic> = {}): EngineDiagnostic => ({ message, severity: "error", ...extra });
const result = (diagnostics: unknown[], extra: Record<string, unknown> = {}) => ({
  exitCode: 1, diagnostics, output: "raw", outputTruncated: false, diagnosticsTruncated: false, ...extra,
});

describe("Engine check observations", () => {
  it("isolates projects and bounds retained history", () => {
    const history = new EngineCheckHistory();
    const id = history.begin("A", plugin, "1", "lint");
    expect(history.read("A")[0]?.status).toBe("running");
    expect(history.read("B")).toEqual([]);
    history.complete("A", id, result([diagnostic("bad", { path: "game/x.rpy", line: 2 })]), plain);
    expect(history.read("A")[0]).toMatchObject({ status: "failed", diagnostics: [{ path: "game/x.rpy", message: "bad" }] });
    history.read("A")[0]!.diagnostics[0]!.message = "changed";
    expect(history.read("A")[0]!.diagnostics[0]!.message).toBe("bad");
    for (let i = 0; i < 9; i++) history.begin("A", plugin, "1", "lint");
    expect(history.read("A")).toHaveLength(8);
    for (let i = 0; i < 24; i++) history.begin("P" + i, plugin, "1", "lint");
    expect(history.read("A")).toEqual([]);
  });

  it("distinguishes invocation failure and cancellation from engine findings", () => {
    const history = new EngineCheckHistory();
    const id = history.begin("A", plugin, "1", "lint");
    history.fail("A", id, "secret token", true, (text) => text.replace("secret", "[redacted]"));
    history.complete("A", id, result([], { exitCode: 0 }), plain);
    expect(history.read("A")[0]).toMatchObject({ status: "cancelled", failure: "[redacted] token" });
    const failure = history.begin("A", plugin, "1", "test");
    history.fail("A", failure, "SDK absent", false, plain);
    expect(history.read("A")[0]?.status).toBe("invocation-error");
  });

  it("compares reported multisets only for compatible sequential complete extractions", () => {
    const history = new EngineCheckHistory();
    let id = history.begin("A", plugin, "1", "lint");
    history.complete("A", id, result([diagnostic("same"), diagnostic("same"), diagnostic("old")]), plain);
    id = history.begin("A", plugin, "1", "lint");
    history.complete("A", id, result([diagnostic("same"), diagnostic("new")]), plain);
    const [current, previous] = history.read("A");
    expect(current!.comparison).toEqual({ previousRunId: previous!.id, recurring: 1, newlyReported: 1, noLongerReported: 2 });
    expect(compareReportedChecks({ ...current!, startedAt: previous!.completedAt! - 1 }, previous!)).toBeUndefined();
    expect(compareReportedChecks({ ...current!, version: "2" }, previous!)).toBeUndefined();
    expect(compareReportedChecks({ ...current!, diagnosticsComplete: false }, previous!)).toBeUndefined();
    id = history.begin("A", plugin, "1", "lint");
    history.complete("A", id, result([], { outputTruncated: true }), plain);
    expect(history.read("A")[0]!.comparison).toBeUndefined();
  });

  it("bounds output, refuses unsafe source paths, and forgets removed projects", () => {
    const history = new EngineCheckHistory();
    const id = history.begin("A", plugin, "1", "lint");
    history.complete("A", id, result([
      diagnostic("bad", { path: "game/../secret.rpy", line: 1 }),
      diagnostic("bad", { path: "game/saves/x.rpy", line: 1 }),
      diagnostic("valid", { path: "game/a.rpy", line: 2 }), null,
    ], { output: "a".repeat(10_000) }), plain);
    const run = history.read("A")[0]!;
    expect(run.diagnosticsComplete).toBe(false);
    expect(run.diagnostics.filter((item) => item.path)).toHaveLength(1);
    expect(run.outputExcerpt).toHaveLength(8192);
    expect(run.outputOmitted).toBe(true);
    history.forget("A");
    expect(history.read("A")).toEqual([]);
    expect(renpyCheckOperation("other/renpy", "renpy_lint")).toBeUndefined();
    expect(renpyCheckOperation(plugin, "renpy_lint")).toBe("lint");
    expect(renpyCommandOperation(plugin, "lint-renpy")).toBe("lint");
    expect(renpyCommandOperation(plugin, "run-in-renpy")).toBeUndefined();
  });
});
