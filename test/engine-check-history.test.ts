import { describe, expect, it } from "vitest";
import { EngineCheckHistory, compareReportedChecks, godotCheckOperation, pluginCheckOperation, renpyCheckOperation, renpyCommandOperation } from "../src/daemon/engine-check-history.js";
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
    const exportFailure = history.begin("A", "ohmygame/godot", "1.0.3", "export");
    history.fail("A", exportFailure, "The web export failed (exit 2): parse error", false, plain, 2);
    expect(history.read("A")[0]).toMatchObject({ status: "failed", exitCode: 2 });
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

  it("observes Godot runs and extracts res:// source locations", () => {
    const godot = "ohmygame/godot";
    expect(godotCheckOperation(godot, "run_headless")).toBe("test");
    expect(godotCheckOperation(godot, "export_web")).toBe("export");
    expect(godotCheckOperation(godot, "godot_status")).toBeUndefined();
    expect(pluginCheckOperation(godot, "export_web")).toBe("export");
    const history = new EngineCheckHistory();
    const id = history.begin("G", godot, "1.0.3", "test");
    history.complete("G", id, {
      exitCode: 0,
      errors: ["SCRIPT ERROR: Parse Error: unexpected token"],
      output: [
        "SCRIPT ERROR: Parse Error: unexpected token",
        "   at: GDScript::reload (res://scripts/player.gd:12)",
        "WARNING: something to inspect",
        "   at: res://scenes/main.tscn:4",
      ].join("\n"),
    }, plain);
    const run = history.read("G")[0]!;
    expect(run.status).toBe("failed");
    expect(run.exitCode).toBe(0);
    expect(run.reportedErrors).toBe(true);
    expect(run.diagnosticsComplete).toBe(true);
    expect(run.diagnostics).toEqual([
      expect.objectContaining({ severity: "error", path: "scripts/player.gd", line: 12 }),
      expect.objectContaining({ severity: "warning", path: "scenes/main.tscn", line: 4 }),
    ]);
    expect(run.diagnostics[0]!.message).toContain("unexpected token");
    expect(run.diagnostics[0]!.message).toContain("GDScript::reload");
  });

  it("does not invent a Godot source from unrelated text", () => {
    const history = new EngineCheckHistory();
    const id = history.begin("G", "ohmygame/godot", "1.0.3", "test");
    history.complete("G", id, {
      exitCode: 1,
      errors: ["ERROR: a path https://example.test/a.gd:1 is not a Godot resource"],
      output: [
        "ERROR: a path https://example.test/a.gd:1 is not a Godot resource",
        "ERROR: cannot open res://backup/main.gd.old",
        "ERROR: res://C:/Users/x/secret.gd:1",
      ].join("\n"),
    }, plain);
    expect(history.read("G")[0]!.diagnostics).toHaveLength(3);
    expect(history.read("G")[0]!.diagnostics.every((item) => item.path === undefined)).toBe(true);
  });
});
