import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexPluginPackage } from "../src/daemon/plugin-index.js";
// @ts-expect-error Plugin native modules are intentionally plain JavaScript.
import { resolveRenpy, runRenpy, runWithIsolatedSaves, exportWeb, renpyErrors, renpyLaunch } from "../plugins/renpy/native/renpy.mjs";
// @ts-expect-error Plugin native modules are intentionally plain JavaScript.
import { activate } from "../plugins/renpy/native/index.mjs";

let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "ohmygame-renpy-"));
  await mkdir(path.join(folder, "game"), { recursive: true });
  await writeFile(path.join(folder, "game", "script.rpy"), "label start:\n    return\n");
});
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });

async function file(...parts: string[]) {
  const target = path.join(folder, ...parts);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "");
  await chmod(target, 0o755);
  return target;
}

describe("Ren'Py SDK discovery", () => {
  it("finds a configured SDK directory on Linux and chooses it before the environment", async () => {
    const configured = path.join(folder, "installed");
    await file("installed", "renpy.py");
    const script = await file("installed", "renpy.sh");
    await file("env", "renpy.py");
    await file("env", "renpy.sh");
    const command = await resolveRenpy(configured, {
      platform: "linux", env: { RENPY_SDK_PATH: path.join(folder, "env"), PATH: "" },
    });
    expect(command).toEqual({ sdkPath: configured, executable: script, prefixArgs: [] });
  });

  it("accepts the launch script, then falls back to RENPY_HOME for an invalid setting", async () => {
    await file("sdk", "renpy.py");
    const launcher = await file("sdk", "renpy.sh");
    const environment = { RENPY_HOME: path.join(folder, "sdk"), PATH: "" };
    expect((await resolveRenpy(launcher, { platform: "linux", env: environment }))?.executable).toBe(launcher);
    expect((await resolveRenpy(path.join(folder, "missing"), { platform: "linux", env: environment }))?.executable).toBe(launcher);
  });

  it("uses the SDK's bundled Windows Python interpreter, not the Ren'Py launcher UI", async () => {
    const sdk = path.join(folder, "sdk");
    const script = await file("sdk", "renpy.py");
    const python = await file("sdk", "lib", "py3-windows-x86_64", "python.exe");
    expect(await resolveRenpy(sdk, { platform: "win32", env: { PATH: "" } })).toEqual({
      sdkPath: sdk, executable: python, prefixArgs: [script],
    });
    expect((await resolveRenpy(python, { platform: "win32", env: { PATH: "" } }))?.executable).toBe(python);
  });

  it("returns missing instead of accidentally invoking an unknown executable", async () => {
    await file("not-renpy");
    expect(await resolveRenpy(path.join(folder, "not-renpy"), { platform: "linux", env: { PATH: "" } })).toBeUndefined();
  });
});

describe("Ren'Py execution and browser export", () => {
  it("uses argument arrays without a shell and preserves diagnostics and exit codes", async () => {
    const fake = path.join(folder, "cli.cjs");
    await writeFile(fake, 'process.stdout.write(process.argv.slice(2).join("|") + "\\n"); process.stderr.write("Error: sample diagnostic\\n"); process.exit(3);\n');
    const command = { executable: process.execPath, prefixArgs: [fake], sdkPath: folder };
    const result = await runRenpy(command, ["a project", "lint", "--error-code"], { cwd: folder });
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("a project|lint|--error-code");
    expect(result.errors).toContain("Error: sample diagnostic");
  });

  it("honors cancellation before executing the SDK", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runRenpy({ executable: process.execPath, prefixArgs: [], sdkPath: folder }, [],
      { signal: controller.signal })).rejects.toThrow(/cancelled/);
  });

  it("promotes a successful web export over an old preview", async () => {
    const web = path.join(folder, ".ohmygame", "build", "web");
    await mkdir(web, { recursive: true });
    await writeFile(path.join(web, "index.html"), "previous");
    const command = { executable: "renpy", prefixArgs: [], sdkPath: folder };
    const args: string[][] = [];
    let savesBase: string | undefined;
    let multipersistent: string | undefined;
    let backups: string | undefined;
    const result = await exportWeb(folder, command, { execute: async (_sdk: unknown, argv: string[], options: { env?: Record<string, string> }) => {
      args.push(argv);
      savesBase = options.env?.RENPY_PATH_TO_SAVES;
      multipersistent = options.env?.RENPY_MULTIPERSISTENT;
      backups = options.env?.RENPY_DISABLE_BACKUPS;
      const project = argv[4]!;
      await mkdir(path.join(project, "game", "saves"), { recursive: true });
      await writeFile(path.join(project, "game", "saves", "persistent"), "generated");
      const destination = argv.at(-1)!;
      await writeFile(path.join(destination, "index.html"), "new-build");
      return { exitCode: 0, output: "built", errors: [] };
    } });
    expect(result.exitCode).toBe(0);
    expect(result.validationCopy).toBe(true);
    expect(args[0]?.[0]).toBe("--savedir");
    expect(args[0]?.[1]).toContain("ohmygame-renpy-validation-");
    expect(args[0]?.slice(2, 4)).toEqual(["launcher", "web_build"]);
    expect(path.basename(args[0]![4]!)).toMatch(/^ohmygame-renpy-project-/);
    expect(args[0]?.slice(5, 6)).toEqual(["--destination"]);
    expect(savesBase).toContain("ohmygame-renpy-validation-saves-");
    expect(multipersistent).toContain("ohmygame-renpy-validation-multi-");
    expect(backups).toBe("I take responsibility for this.");
    await expect(lstat(args[0]![1]!)).rejects.toThrow();
    await expect(lstat(args[0]![4]!)).rejects.toThrow();
    await expect(lstat(savesBase!)).rejects.toThrow();
    await expect(lstat(path.dirname(multipersistent!))).rejects.toThrow();
    await expect(lstat(path.join(folder, "game", "saves"))).rejects.toThrow();
    expect(await readFile(path.join(web, "index.html"), "utf8")).toBe("new-build");
    expect(await readdir(path.dirname(web))).toEqual(["web"]);
  });

  it("accepts Ren'Py's named web distribution folder beside its zip", async () => {
    const command = { executable: "renpy", prefixArgs: [], sdkPath: folder };
    await exportWeb(folder, command, { execute: async (_sdk: unknown, argv: string[]) => {
      const staging = argv.at(-1)!;
      const site = path.join(staging, "mygame-1.0-web");
      await mkdir(site);
      await writeFile(path.join(site, "index.html"), "nested-web-build");
      await writeFile(path.join(staging, "mygame-1.0-web.zip"), "archive");
      return { exitCode: 0, output: "built", errors: [] };
    } });
    const web = path.join(folder, ".ohmygame", "build", "web");
    expect(await readFile(path.join(web, "index.html"), "utf8")).toBe("nested-web-build");
    expect(await readdir(path.dirname(web))).toEqual(["web"]);
  });

  it("rejects ambiguous web distributions", async () => {
    const command = { executable: "renpy", prefixArgs: [], sdkPath: folder };
    await expect(exportWeb(folder, command, { execute: async (_sdk: unknown, argv: string[]) => {
      const staging = argv.at(-1)!;
      for (const name of ["a-web", "b-web"]) {
        const site = path.join(staging, name);
        await mkdir(site);
        await writeFile(path.join(site, "index.html"), "ambiguous");
      }
      return { exitCode: 0, output: "built", errors: [] };
    } })).rejects.toThrow(/unambiguous/);
    expect(await readdir(path.join(folder, ".ohmygame", "build"))).toEqual([]);
  });

  it("keeps the previous preview intact when Ren'Py fails to export", async () => {
    const web = path.join(folder, ".ohmygame", "build", "web");
    await mkdir(web, { recursive: true });
    await writeFile(path.join(web, "index.html"), "last-working-build");
    let savesBase: string | undefined;
    await expect(exportWeb(folder, { executable: "renpy", prefixArgs: [], sdkPath: folder }, {
      execute: async (_sdk: unknown, _argv: string[], options: { env?: Record<string, string> }) => {
        savesBase = options.env?.RENPY_PATH_TO_SAVES;
        return { exitCode: 2, output: "Error: export failed", errors: ["Error: export failed"] };
      },
    })).rejects.toThrow(/export failed/);
    expect(await readFile(path.join(web, "index.html"), "utf8")).toBe("last-working-build");
    expect(await readdir(path.dirname(web))).toEqual(["web"]);
    await expect(lstat(savesBase!)).rejects.toThrow();
  });

  it("refuses a non-directory preview destination", async () => {
    const build = path.join(folder, ".ohmygame", "build");
    await mkdir(build, { recursive: true });
    await writeFile(path.join(build, "web"), "do not touch");
    await expect(exportWeb(folder, { executable: "renpy", prefixArgs: [], sdkPath: folder }, {
      execute: async () => { throw new Error("should not run"); },
    })).rejects.toThrow(/unsafe existing web build path/);
    expect(await readFile(path.join(build, "web"), "utf8")).toBe("do not touch");
    expect((await lstat(path.join(build, "web"))).isFile()).toBe(true);
  });

  it("refuses an export without a real index.html", async () => {
    await expect(exportWeb(folder, { executable: "renpy", prefixArgs: [], sdkPath: folder }, {
      execute: async () => ({ exitCode: 0, output: "", errors: [] }),
    })).rejects.toThrow(/index.html/);
    expect(await readdir(path.join(folder, ".ohmygame", "build"))).toEqual([]);
  });

  it("builds a web export from a mirror when the project keeps player data in game/saves", async () => {
    const project = path.join(folder, "portable-web");
    const saves = path.join(project, "game", "saves");
    await mkdir(saves, { recursive: true });
    await mkdir(path.join(project, "game"), { recursive: true });
    await writeFile(path.join(project, "game", "script.rpy"), "label start:\n    return\n");
    await writeFile(path.join(saves, "persistent"), "player data");
    const result = await exportWeb(project, { executable: "renpy", prefixArgs: [], sdkPath: folder }, {
      execute: async (_sdk: unknown, argv: string[]) => {
        expect(argv[4]).not.toBe(project);
        expect(path.basename(argv[4]!)).toMatch(/^ohmygame-renpy-project-/);
        await writeFile(path.join(argv.at(-1)!, "index.html"), "from-mirror");
        return { exitCode: 0, output: "built", errors: [] };
      },
    });
    expect(result.validationCopy).toBe(true);
    expect(await readFile(path.join(saves, "persistent"), "utf8")).toBe("player data");
    expect(await readFile(path.join(project, ".ohmygame", "build", "web", "index.html"), "utf8")).toBe("from-mirror");
    await expect(lstat(path.join(project, "game", "saves"))).resolves.toBeTruthy();
  });

  it("detects Ren'Py traceback markers", () => {
    expect(renpyErrors("starting\nI'm sorry, but an uncaught exception occurred.\nTraceback (most recent call last):\n"))
      .toContain("Traceback (most recent call last):");
  });

  it("builds the launch request the managed host runs", () => {
    expect(renpyLaunch(
      { executable: "C:/sdk/python.exe", prefixArgs: ["C:/sdk/renpy.py"], sdkPath: "C:/sdk" },
      "C:/game",
    )).toEqual({
      executable: "C:/sdk/python.exe",
      args: ["C:/sdk/renpy.py", "C:/game", "run"],
      cwd: "C:/sdk",
      label: "Ren'Py",
    });
  });

  it("runs validation in a disposable project copy with a temporary save directory", async () => {
    const fake = path.join(folder, "cli.cjs");
    await writeFile(fake, 'process.stdout.write(process.argv.slice(2).join("|"));\n');
    const result = await runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      folder,
      ["lint", "--error-code"],
      { cwd: folder },
    );
    const [flag, savedir, project, ...rest] = result.output.split("|");
    expect(flag).toBe("--savedir");
    expect(savedir).toContain("ohmygame-renpy-validation-");
    expect(project).not.toBe(folder);
    expect(path.basename(project!)).toMatch(/^ohmygame-renpy-project-/);
    expect(rest).toEqual(["lint", "--error-code"]);
    expect(result.validationCopy).toBe(true);
    await expect(lstat(savedir!)).rejects.toThrow();
    await expect(lstat(project!)).rejects.toThrow();
  });

  it("removes the temporary save directory and validation copy when validation fails", async () => {
    const seen = path.join(folder, "seen-failure.txt");
    const fake = path.join(folder, "failed.cjs");
    await writeFile(fake, `require("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ savedir: process.argv[3], project: process.argv[4] })); process.exit(2);\n`);
    const result = await runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      folder,
      ["lint", "--error-code"],
      { cwd: folder },
    );
    const seenPaths = JSON.parse(await readFile(seen, "utf8")) as { savedir: string; project: string };
    expect(result.exitCode).toBe(2);
    expect(result.validationCopy).toBe(true);
    await expect(lstat(seenPaths.savedir)).rejects.toThrow();
    await expect(lstat(seenPaths.project)).rejects.toThrow();
  });

  it("removes the temporary save directory and validation copy when validation is cancelled", async () => {
    const seen = path.join(folder, "seen-cancelled.txt");
    const fake = path.join(folder, "waiting.cjs");
    await writeFile(fake, `require("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ savedir: process.argv[3], project: process.argv[4] })); setInterval(() => {}, 1000);\n`);
    const controller = new AbortController();
    const running = runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      folder,
      ["lint", "--error-code"],
      { cwd: folder, signal: controller.signal },
    );
    await vi.waitFor(async () => {
      expect((await lstat(seen).catch(() => undefined))?.isFile()).toBe(true);
    });
    controller.abort();
    await expect(running).rejects.toThrow(/cancelled/);
    const seenPaths = JSON.parse(await readFile(seen, "utf8")) as { savedir: string; project: string };
    await expect(lstat(seenPaths.savedir)).rejects.toThrow();
    await expect(lstat(seenPaths.project)).rejects.toThrow();
  });

  it("redirects persistent, MultiPersistent, and backups away from player data", async () => {
    const seen = path.join(folder, "environment.json");
    const fake = path.join(folder, "environment.cjs");
    await writeFile(fake, `require("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
      savedir: process.argv[3],
      saves: process.env.RENPY_PATH_TO_SAVES,
      multi: process.env.RENPY_MULTIPERSISTENT,
      backups: process.env.RENPY_DISABLE_BACKUPS,
    }));\n`);
    const project = path.join(folder, "environment-project");
    await mkdir(path.join(project, "game"), { recursive: true });
    await runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      project,
      ["lint"],
      { cwd: folder },
    );
    const environment = JSON.parse(await readFile(seen, "utf8")) as Record<string, string>;
    expect(environment.savedir).toContain("ohmygame-renpy-validation-");
    expect(environment.saves).toContain("ohmygame-renpy-validation-saves-");
    expect(environment.multi).toContain("ohmygame-renpy-validation-multi-");
    expect(environment.backups).toBe("I take responsibility for this.");
    await expect(lstat(environment.savedir!)).rejects.toThrow();
    await expect(lstat(environment.saves!)).rejects.toThrow();
    await expect(lstat(path.dirname(environment.multi!))).rejects.toThrow();
  });

  it("validates a project with player saves in a disposable copy", async () => {
    const project = path.join(folder, "portable-saved");
    const saves = path.join(project, "game", "saves");
    await mkdir(saves, { recursive: true });
    await mkdir(path.join(project, "game"), { recursive: true });
    await mkdir(path.join(project, "state"), { recursive: true });
    await mkdir(path.join(project, "Canon"), { recursive: true });
    await writeFile(path.join(project, "game", "script.rpy"), "label start:\n    return\n");
    await writeFile(path.join(project, "state", "registry.json"), "{}");
    await writeFile(path.join(project, "Canon", "note.md"), "source");
    await writeFile(path.join(saves, "persistent"), "player data");
    const marker = path.join(folder, "validation-project.txt");
    const fake = path.join(folder, "validation-copy.cjs");
    await writeFile(fake, `const fs = require("node:fs");
      const path = require("node:path");
      const project = process.argv[4];
      fs.readFileSync(path.join(project, "state", "registry.json"));
      fs.readFileSync(path.join(project, "Canon", "note.md"));
      fs.writeFileSync(${JSON.stringify(marker)}, project);
      fs.writeFileSync(path.join(project, "game", "checked.txt"), "validated");\n`);
    const result = await runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      project,
      ["lint"],
      { cwd: folder },
    );
    const checked = await readFile(marker, "utf8");
    expect(result.validationCopy).toBe(true);
    expect(checked).not.toBe(project);
    expect(path.basename(checked)).toMatch(/^ohmygame-renpy-project-/);
    expect(await readFile(path.join(saves, "persistent"), "utf8")).toBe("player data");
    await expect(lstat(path.join(project, "game", "checked.txt"))).rejects.toThrow();
    await expect(lstat(checked)).rejects.toThrow();
  });

  it("removes the validation copy when validation fails", async () => {
    const project = path.join(folder, "portable-saved-failure");
    const saves = path.join(project, "game", "saves");
    await mkdir(saves, { recursive: true });
    await mkdir(path.join(project, "game"), { recursive: true });
    await writeFile(path.join(project, "game", "script.rpy"), "label start:\n    return\n");
    await writeFile(path.join(saves, "persistent"), "player data");
    const marker = path.join(folder, "validation-failure-project.txt");
    const fake = path.join(folder, "validation-failure.cjs");
    await writeFile(fake, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, process.argv[4]); process.exit(2);\n`);
    const result = await runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      project,
      ["lint"],
      { cwd: folder },
    );
    expect(result.exitCode).toBe(2);
    expect(result.validationCopy).toBe(true);
    expect(await readFile(path.join(saves, "persistent"), "utf8")).toBe("player data");
    await expect(lstat(await readFile(marker, "utf8"))).rejects.toThrow();
  });

  it("keeps saves a run generates out of the original project", async () => {
    const project = path.join(folder, "portable-fresh");
    await mkdir(path.join(project, "game"), { recursive: true });
    await writeFile(path.join(project, "game", "script.rpy"), "label start:\n    return\n");
    const fake = path.join(folder, "writes-saves.cjs");
    await writeFile(fake, `const fs = require("node:fs");
      const path = require("node:path");
      const saves = path.join(process.argv[4], "game", "saves");
      fs.mkdirSync(path.join(saves, "sync"), { recursive: true });
      fs.writeFileSync(path.join(saves, "persistent"), "generated");
      fs.writeFileSync(path.join(saves, "sync", "persistent"), "generated");\n`);
    await runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      project,
      ["lint"],
      { cwd: folder },
    );
    await expect(lstat(path.join(project, "game", "saves"))).rejects.toThrow();
  });

  it("keeps a project's pre-existing empty game/saves empty", async () => {
    const project = path.join(folder, "portable-empty");
    const saves = path.join(project, "game", "saves");
    await mkdir(saves, { recursive: true });
    const fake = path.join(folder, "writes-empty.cjs");
    await writeFile(fake, `const fs = require("node:fs");
      const path = require("node:path");
      fs.writeFileSync(path.join(process.argv[4], "game", "saves", "persistent"), "generated");\n`);
    await runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      project,
      ["lint"],
      { cwd: folder },
    );
    expect((await lstat(saves)).isDirectory()).toBe(true);
    expect(await readdir(saves)).toEqual([]);
  });

  it("promotes compiled scripts from a successful compile but not after a failure", async () => {
    const project = path.join(folder, "compile-project");
    const game = path.join(project, "game");
    await mkdir(game, { recursive: true });
    await writeFile(path.join(game, "script.rpy"), "label start:\n    return\n");
    await writeFile(path.join(game, "script.rpyc"), "old-compiled");
    const fake = path.join(folder, "compile.cjs");
    await writeFile(fake, `const fs = require("node:fs");
      const path = require("node:path");
      const game = path.join(process.argv[4], "game");
      fs.writeFileSync(path.join(game, "script.rpyc"), "new-compiled");
      fs.writeFileSync(path.join(game, "added.rpyc"), "added-compiled");
      fs.mkdirSync(path.join(game, "saves"), { recursive: true });
      fs.writeFileSync(path.join(game, "saves", "persistent"), "generated");
      process.exit(Number(process.env.COMPILE_EXIT || "0"));\n`);
    const compile = () => runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      project,
      ["compile", "--keep-orphan-rpyc"],
      { cwd: folder, env: { COMPILE_EXIT: "0" } },
    );
    const failed = () => runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      project,
      ["compile", "--keep-orphan-rpyc"],
      { cwd: folder, env: { COMPILE_EXIT: "1" } },
    );
    const result = await compile();
    expect(result.validationCopy).toBe(true);
    expect(result.compiledArtifacts).toBe(2);
    expect(await readFile(path.join(game, "script.rpyc"), "utf8")).toBe("new-compiled");
    expect(await readFile(path.join(game, "added.rpyc"), "utf8")).toBe("added-compiled");
    await expect(lstat(path.join(game, "saves"))).rejects.toThrow();
    await rm(path.join(game, "added.rpyc"));
    await writeFile(path.join(game, "script.rpyc"), "old-compiled");
    const failure = await failed();
    expect(failure.exitCode).toBe(1);
    expect(failure.compiledArtifacts).toBeUndefined();
    expect(await readFile(path.join(game, "script.rpyc"), "utf8")).toBe("old-compiled");
    await expect(lstat(path.join(game, "added.rpyc"))).rejects.toThrow();
  });

  it("refuses a symbolic-link game folder instead of mirroring through it", async (context) => {
    const real = path.join(folder, "real-project");
    await mkdir(path.join(real, "game"), { recursive: true });
    await writeFile(path.join(real, "game", "script.rpy"), "label start:\n    return\n");
    const linked = path.join(folder, "linked-project");
    await mkdir(linked, { recursive: true });
    try {
      await symlink(path.join(real, "game"), path.join(linked, "game"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      context.skip();
      return;
    }
    await expect(runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [], sdkPath: folder },
      linked,
      ["lint"],
      { cwd: folder },
    )).rejects.toThrow(/symbolic-link or non-directory game folder/);
  });

  it("excludes game/SAVES case-insensitively from the validation copy", async () => {
    const project = path.join(folder, "uppercase-saves");
    await mkdir(path.join(project, "game", "SAVES"), { recursive: true });
    await writeFile(path.join(project, "game", "script.rpy"), "label start:\n    return\n");
    await writeFile(path.join(project, "game", "SAVES", "persistent"), "player data");
    const marker = path.join(folder, "uppercase.json");
    const fake = path.join(folder, "uppercase.cjs");
    await writeFile(fake, `const fs = require("node:fs");
      const path = require("node:path");
      const game = path.join(process.argv[4], "game");
      fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
        upper: fs.existsSync(path.join(game, "SAVES")),
        lower: fs.existsSync(path.join(game, "saves")),
      }));\n`);
    await runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      project,
      ["lint"],
      { cwd: folder },
    );
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({ upper: false, lower: false });
    expect(await readFile(path.join(project, "game", "SAVES", "persistent"), "utf8")).toBe("player data");
  });

  it("ignores a case-variant root Game folder instead of copying its saves", async (context) => {
    if (process.platform !== "win32" && process.platform !== "darwin") {
      context.skip();
      return;
    }
    const project = path.join(folder, "case-variant-root");
    await mkdir(path.join(project, "Game", "SAVES"), { recursive: true });
    await writeFile(path.join(project, "Game", "script.rpy"), "label start:\n    return\n");
    await writeFile(path.join(project, "Game", "SAVES", "persistent"), "player data");
    const marker = path.join(folder, "case-variant.json");
    const fake = path.join(folder, "case-variant.cjs");
    await writeFile(fake, `const fs = require("node:fs");
      const path = require("node:path");
      const game = path.join(process.argv[4], "game");
      fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
        upper: fs.existsSync(path.join(game, "SAVES")),
        lower: fs.existsSync(path.join(game, "saves")),
      }));\n`);
    await runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      project,
      ["lint"],
      { cwd: folder },
    );
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({ upper: false, lower: false });
    expect(await readFile(path.join(project, "Game", "SAVES", "persistent"), "utf8")).toBe("player data");
  });

  it("skips a link inside game that resolves to player saves", async (context) => {
    const project = path.join(folder, "inner-save-link");
    const saves = path.join(project, "game", "saves");
    await mkdir(saves, { recursive: true });
    await writeFile(path.join(project, "game", "script.rpy"), "label start:\n    return\n");
    await writeFile(path.join(saves, "persistent"), "player data");
    try {
      await symlink(saves, path.join(project, "game", "shared"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      context.skip();
      return;
    }
    const marker = path.join(folder, "inner-link.txt");
    const fake = path.join(folder, "inner-link.cjs");
    await writeFile(fake, `const fs = require("node:fs");
      const path = require("node:path");
      fs.writeFileSync(${JSON.stringify(marker)}, String(fs.existsSync(path.join(process.argv[4], "game", "shared"))));\n`);
    await runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      project,
      ["lint"],
      { cwd: folder },
    );
    expect(await readFile(marker, "utf8")).toBe("false");
    expect(await readFile(path.join(saves, "persistent"), "utf8")).toBe("player data");
  });

  it("copies both a real game folder and a separate link to it", async (context) => {
    const project = path.join(folder, "game-link-alias");
    await mkdir(path.join(project, "game", "assets"), { recursive: true });
    await writeFile(path.join(project, "game", "script.rpy"), "label start:\n    return\n");
    await writeFile(path.join(project, "game", "assets", "note.txt"), "asset");
    try {
      await symlink(path.join(project, "game", "assets"), path.join(project, "game", "alias"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      context.skip();
      return;
    }
    const marker = path.join(folder, "game-link-alias.json");
    const fake = path.join(folder, "game-link-alias.cjs");
    await writeFile(fake, `const fs = require("node:fs");
      const path = require("node:path");
      const game = path.join(process.argv[4], "game");
      fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
        assets: fs.readFileSync(path.join(game, "assets", "note.txt"), "utf8"),
        alias: fs.readFileSync(path.join(game, "alias", "note.txt"), "utf8"),
      }));\n`);
    await runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      project,
      ["lint"],
      { cwd: folder },
    );
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({ assets: "asset", alias: "asset" });
  });

  it("skips a root link into a save subdirectory whose name starts with dots", async (context) => {
    const project = path.join(folder, "dotdot-root-link");
    const backup = path.join(project, "game", "saves", "..backup");
    await mkdir(backup, { recursive: true });
    await writeFile(path.join(project, "game", "script.rpy"), "label start:\n    return\n");
    await writeFile(path.join(backup, "persistent"), "PLAYER BACKUP SAVE");
    try {
      await symlink(backup, path.join(project, "SharedBackup"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      context.skip();
      return;
    }
    const marker = path.join(folder, "dotdot-root.json");
    const fake = path.join(folder, "dotdot-root.cjs");
    await writeFile(fake, `const fs = require("node:fs");
      const path = require("node:path");
      const target = path.join(process.argv[4], "SharedBackup", "persistent");
      const found = fs.existsSync(target);
      if (found) fs.writeFileSync(target, "MUTATED");
      fs.writeFileSync(${JSON.stringify(marker)}, String(found));\n`);
    await runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      project,
      ["lint"],
      { cwd: folder },
    );
    expect(await readFile(marker, "utf8")).toBe("false");
    expect(await readFile(path.join(backup, "persistent"), "utf8")).toBe("PLAYER BACKUP SAVE");
  });

  it("skips an inner game link into a save subdirectory whose name starts with dots", async (context) => {
    const project = path.join(folder, "dotdot-inner-link");
    const backup = path.join(project, "game", "saves", "..backup");
    await mkdir(backup, { recursive: true });
    await writeFile(path.join(project, "game", "script.rpy"), "label start:\n    return\n");
    await writeFile(path.join(backup, "persistent"), "PLAYER BACKUP SAVE");
    try {
      await symlink(backup, path.join(project, "game", "shared"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      context.skip();
      return;
    }
    const marker = path.join(folder, "dotdot-inner.txt");
    const fake = path.join(folder, "dotdot-inner.cjs");
    await writeFile(fake, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(require("node:fs").existsSync(require("node:path").join(process.argv[4], "game", "shared"))));\n`);
    await runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      project,
      ["lint"],
      { cwd: folder },
    );
    expect(await readFile(marker, "utf8")).toBe("false");
    expect(await readFile(path.join(backup, "persistent"), "utf8")).toBe("PLAYER BACKUP SAVE");
  });

  it("promotes a compiled script whose name starts with dots", async () => {
    const project = path.join(folder, "dotdot-promotion");
    const game = path.join(project, "game");
    await mkdir(game, { recursive: true });
    await writeFile(path.join(game, "script.rpy"), "label start:\n    return\n");
    await writeFile(path.join(game, "..extra.rpyc"), "old");
    const fake = path.join(folder, "dotdot-promotion.cjs");
    await writeFile(fake, `require("node:fs").writeFileSync(require("node:path").join(process.argv[4], "game", "..extra.rpyc"), "new");\n`);
    const result = await runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      project,
      ["compile", "--keep-orphan-rpyc"],
      { cwd: folder },
    );
    expect(result.compiledArtifacts).toBe(1);
    expect(await readFile(path.join(game, "..extra.rpyc"), "utf8")).toBe("new");
  });

  it("promotes compiled scripts when the project itself is opened through a junction", async (context) => {
    const real = path.join(folder, "junction-project-real");
    const linked = path.join(folder, "junction-project-linked");
    await mkdir(path.join(real, "game"), { recursive: true });
    await writeFile(path.join(real, "game", "script.rpy"), "label start:\n    return\n");
    await writeFile(path.join(real, "game", "script.rpyc"), "old");
    try {
      await symlink(real, linked, process.platform === "win32" ? "junction" : "dir");
    } catch {
      context.skip();
      return;
    }
    const fake = path.join(folder, "junction-project.cjs");
    await writeFile(fake, `require("node:fs").writeFileSync(require("node:path").join(process.argv[4], "game", "script.rpyc"), "new");\n`);
    const result = await runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      linked,
      ["compile", "--keep-orphan-rpyc"],
      { cwd: folder },
    );
    expect(result.exitCode).toBe(0);
    expect(result.compiledArtifacts).toBe(1);
    expect(await readFile(path.join(real, "game", "script.rpyc"), "utf8")).toBe("new");
    expect(await readFile(path.join(linked, "game", "script.rpyc"), "utf8")).toBe("new");
  });

  it("keeps ordinary nested cache and saves asset folders in the mirror", async () => {
    const project = path.join(folder, "nested-assets");
    await mkdir(path.join(project, "game", "story", "cache"), { recursive: true });
    await mkdir(path.join(project, "game", "story", "saves"), { recursive: true });
    await writeFile(path.join(project, "game", "script.rpy"), "label start:\n    return\n");
    await writeFile(path.join(project, "game", "story", "cache", "asset.txt"), "cached asset");
    await writeFile(path.join(project, "game", "story", "saves", "note.txt"), "story note");
    const marker = path.join(folder, "nested-assets.json");
    const fake = path.join(folder, "nested-assets.cjs");
    await writeFile(fake, `const fs = require("node:fs");
      const path = require("node:path");
      const game = path.join(process.argv[4], "game");
      fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
        cache: fs.readFileSync(path.join(game, "story", "cache", "asset.txt"), "utf8"),
        saves: fs.readFileSync(path.join(game, "story", "saves", "note.txt"), "utf8"),
      }));\n`);
    await runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      project,
      ["lint"],
      { cwd: folder },
    );
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({ cache: "cached asset", saves: "story note" });
  });

  it("skips a root link that resolves to player saves", async (context) => {
    const project = path.join(folder, "root-save-link");
    const saves = path.join(project, "game", "saves");
    await mkdir(saves, { recursive: true });
    await writeFile(path.join(project, "game", "script.rpy"), "label start:\n    return\n");
    await writeFile(path.join(saves, "persistent"), "player data");
    try {
      await symlink(saves, path.join(project, "SharedSaves"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      context.skip();
      return;
    }
    const marker = path.join(folder, "root-link.txt");
    const fake = path.join(folder, "root-link.cjs");
    await writeFile(fake, `const fs = require("node:fs");
      const path = require("node:path");
      const linked = path.join(process.argv[4], "SharedSaves", "persistent");
      const found = fs.existsSync(linked);
      if (found) fs.writeFileSync(linked, "MUTATED");
      fs.writeFileSync(${JSON.stringify(marker)}, String(found));\n`);
    await runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      project,
      ["lint"],
      { cwd: folder },
    );
    expect(await readFile(marker, "utf8")).toBe("false");
    expect(await readFile(path.join(saves, "persistent"), "utf8")).toBe("player data");
  });

  it("rolls back completed promotions when a later atomic replace fails", async (context) => {
    if (process.platform !== "win32") {
      context.skip();
      return;
    }
    const project = path.join(folder, "promotion-rollback");
    const game = path.join(project, "game");
    await mkdir(game, { recursive: true });
    await writeFile(path.join(game, "script.rpy"), "label start:\n    return\n");
    await writeFile(path.join(game, "a.rpyc"), "old-a");
    await writeFile(path.join(game, "b.rpyc"), "old-b");
    await chmod(path.join(game, "b.rpyc"), 0o444);
    const fake = path.join(folder, "rollback.cjs");
    await writeFile(fake, `const fs = require("node:fs");
      const path = require("node:path");
      const game = path.join(process.argv[4], "game");
      fs.chmodSync(path.join(game, "b.rpyc"), 0o644);
      fs.writeFileSync(path.join(game, "a.rpyc"), "new-a");
      fs.writeFileSync(path.join(game, "b.rpyc"), "new-b");\n`);
    await expect(runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      project,
      ["compile", "--keep-orphan-rpyc"],
      { cwd: folder },
    )).rejects.toThrow(/EPERM|operation not permitted/);
    expect(await readFile(path.join(game, "a.rpyc"), "utf8")).toBe("old-a");
    expect(await readFile(path.join(game, "b.rpyc"), "utf8")).toBe("old-b");
    expect((await readdir(game)).filter((name) => name.startsWith(".ohmygame-promote-"))).toEqual([]);
  });

  it("preflights every promoted script before writing any of them", async (context) => {
    const project = path.join(folder, "promotion-preflight");
    const game = path.join(project, "game");
    const external = path.join(folder, "external-target");
    await mkdir(game, { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(path.join(game, "script.rpy"), "label start:\n    return\n");
    await writeFile(path.join(game, "a.rpyc"), "old-a");
    await writeFile(path.join(game, "z.rpyc"), "old-z");
    try {
      await symlink(external, path.join(game, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      context.skip();
      return;
    }
    const fake = path.join(folder, "preflight.cjs");
    await writeFile(fake, `const fs = require("node:fs");
      const path = require("node:path");
      const game = path.join(process.argv[4], "game");
      fs.writeFileSync(path.join(game, "a.rpyc"), "new-a");
      fs.writeFileSync(path.join(game, "z.rpyc"), "new-z");
      fs.mkdirSync(path.join(game, "linked", "newdir"), { recursive: true });
      fs.writeFileSync(path.join(game, "linked", "newdir", "outside.rpyc"), "outside");\n`);
    await expect(runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      project,
      ["compile", "--keep-orphan-rpyc"],
      { cwd: folder },
    )).rejects.toThrow(/outside the game folder/);
    expect(await readFile(path.join(game, "a.rpyc"), "utf8")).toBe("old-a");
    expect(await readFile(path.join(game, "z.rpyc"), "utf8")).toBe("old-z");
    await expect(lstat(path.join(external, "newdir"))).rejects.toThrow();
  });

  it("links a root junction so the mirror can read assets kept on another drive", async (context) => {
    const external = path.join(folder, "external-assets");
    await mkdir(external, { recursive: true });
    await writeFile(path.join(external, "note.txt"), "external asset");
    const project = path.join(folder, "junction-project");
    await mkdir(path.join(project, "game"), { recursive: true });
    await writeFile(path.join(project, "game", "script.rpy"), "label start:\n    return\n");
    try {
      await symlink(external, path.join(project, "LinkedAssets"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      context.skip();
      return;
    }
    const marker = path.join(folder, "junction-read.txt");
    const fake = path.join(folder, "junction.cjs");
    await writeFile(fake, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, require("node:fs").readFileSync(require("node:path").join(process.argv[4], "LinkedAssets", "note.txt"), "utf8"));\n`);
    const result = await runWithIsolatedSaves(
      { executable: process.execPath, prefixArgs: [fake], sdkPath: folder },
      project,
      ["lint"],
      { cwd: folder },
    );
    expect(result.validationCopy).toBe(true);
    expect(await readFile(marker, "utf8")).toBe("external asset");
  });
});

describe("OhMyGame plugin contracts", () => {
  it("passes the actual plugin manifest and package indexer", async () => {
    const result = await indexPluginPackage(path.resolve("plugins/renpy"));
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it("declares a native run that returns to the managed host", async () => {
    const manifest = JSON.parse(await readFile(path.resolve("plugins/renpy/.ohmygame-plugin/plugin.json"), "utf8")) as {
      engines: Record<string, string>;
      contributes: { commands: Array<{ id: string; run: Record<string, unknown> }> };
    };
    const run = manifest.contributes.commands.find((command) => command.id === "run-in-renpy")?.run;
    expect(run).toMatchObject({ native: "runInRenpy", changesFiles: false });
    expect(run).not.toHaveProperty("timeoutSeconds");
    expect(manifest.engines["ohmygame-api"]).toBe("^2.37.0");
  });

  it("starts Ren'Py through the project host's managed session", async () => {
    const sdk = path.join(folder, "sdk");
    await file("sdk", "renpy.py");
    if (process.platform === "win32") await file("sdk", "lib", "py3-windows-x86_64", "python.exe");
    else await file("sdk", "renpy.sh");
    let run: ((input: unknown, call: unknown) => Promise<unknown>) | undefined;
    const starts: unknown[] = [];
    activate({
      project: { folder: path.join(folder, "game") },
      pluginId: "thorstarlord/renpy",
      version: "0.1.0",
      dataFolder: folder,
      configuration: { renpySdkPath: sdk },
      nativeSessions: {
        start: async (options: unknown) => {
          starts.push(options);
          return {
            id: "session-1",
            pid: 1234,
            label: "Ren'Py",
            stop: async () => {},
            exited: Promise.resolve({ code: 0, signal: null }),
          };
        },
      },
      registerProjectType: () => {},
      registerTool: () => {},
      registerCommand: (id: string, handler: (input: unknown, call: unknown) => Promise<unknown>) => {
        if (id === "runInRenpy") run = handler;
      },
      onDispose: () => {},
    });
    const result = await run!({}, {
      configuration: { renpySdkPath: sdk },
      signal: new AbortController().signal,
      progress: () => {},
    });
    expect(starts).toEqual([{
      executable: process.platform === "win32"
        ? path.join(sdk, "lib", "py3-windows-x86_64", "python.exe")
        : path.join(sdk, "renpy.sh"),
      args: process.platform === "win32"
        ? [path.join(sdk, "renpy.py"), path.join(folder, "game"), "run"]
        : [path.join(folder, "game"), "run"],
      cwd: sdk,
      label: "Ren'Py",
      captureOutput: true,
    }]);
    expect(result).toEqual({ started: true, sessionId: "session-1", pid: 1234 });
  });

  it("registers the expected typed project and native capabilities", () => {
    const types: Record<string, unknown> = {};
    const tools: string[] = [];
    const commands: string[] = [];
    activate({
      project: { folder },
      registerProjectType: (id: string, hooks: unknown) => { types[id] = hooks; },
      registerTool: (id: string) => { tools.push(id); },
      registerCommand: (id: string) => { commands.push(id); },
      onDispose: () => {},
    });
    expect(Object.keys(types)).toEqual(["renpy-game"]);
    expect(typeof (types["renpy-game"] as { buildWeb: unknown }).buildWeb).toBe("function");
    expect(tools.sort()).toEqual(["renpy_compile", "renpy_export_web", "renpy_lint", "renpy_status", "renpy_test"].sort());
    expect(commands.sort()).toEqual(["runInRenpy", "settingsStatus"]);
  });
});

describe("Engine diagnostic observations", () => {
  it("returns project-relative findings from the validation mirror with legacy output intact", async () => {
    const fake = path.join(folder, "diagnostic.cjs");
    await writeFile(fake, "const path = require(\"node:path\"); console.log('File \"' + path.join(process.cwd(), \"game\", \"script.rpy\") + '\", line 2:'); console.log(\"Error: fixture diagnostic\"); console.log(\"game/script.rpy:3 Warning: fixture lint finding\"); process.exitCode = 1;");
    const result = await runWithIsolatedSaves({ executable: process.execPath, prefixArgs: [fake], sdkPath: folder }, folder, ["lint"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Error: fixture diagnostic");
    expect(result.outputTruncated).toBe(false);
    expect(result.diagnosticsTruncated).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "game/script.rpy", line: 2 }),
      expect.objectContaining({ severity: "error", message: "Error: fixture diagnostic" }),
      expect.objectContaining({ severity: "warning", path: "game/script.rpy", line: 3 }),
    ]));
    expect(result.validationCopy).toBe(true);
  });
});
