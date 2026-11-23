import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexPluginPackage } from "../src/daemon/plugin-index.js";
// @ts-expect-error Plugin native modules are intentionally plain JavaScript.
import { resolveRenpy, runRenpy, exportWeb, renpyErrors } from "../plugins/renpy/native/renpy.mjs";
// @ts-expect-error Plugin native modules are intentionally plain JavaScript.
import { activate } from "../plugins/renpy/native/index.mjs";

let folder: string;
beforeEach(async () => { folder = await mkdtemp(path.join(tmpdir(), "ohmygame-renpy-")); });
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
    const result = await exportWeb(folder, command, { execute: async (_sdk: unknown, argv: string[]) => {
      args.push(argv);
      const destination = argv.at(-1)!;
      await writeFile(path.join(destination, "index.html"), "new-build");
      return { exitCode: 0, output: "built", errors: [] };
    } });
    expect(result.exitCode).toBe(0);
    expect(args[0]?.slice(0, 4)).toEqual(["launcher", "web_build", folder, "--destination"]);
    expect(await readFile(path.join(web, "index.html"), "utf8")).toBe("new-build");
    expect(await readdir(path.dirname(web))).toEqual(["web"]);
  });

  it("keeps the previous preview intact when Ren'Py fails to export", async () => {
    const web = path.join(folder, ".ohmygame", "build", "web");
    await mkdir(web, { recursive: true });
    await writeFile(path.join(web, "index.html"), "last-working-build");
    await expect(exportWeb(folder, { executable: "renpy", prefixArgs: [], sdkPath: folder }, {
      execute: async () => ({ exitCode: 2, output: "Error: export failed", errors: ["Error: export failed"] }),
    })).rejects.toThrow(/export failed/);
    expect(await readFile(path.join(web, "index.html"), "utf8")).toBe("last-working-build");
    expect(await readdir(path.dirname(web))).toEqual(["web"]);
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

  it("detects Ren'Py traceback markers", () => {
    expect(renpyErrors("starting\nI'm sorry, but an uncaught exception occurred.\nTraceback (most recent call last):\n"))
      .toContain("Traceback (most recent call last):");
  });
});

describe("OhMyGame plugin contracts", () => {
  it("passes the actual plugin manifest and package indexer", async () => {
    const result = await indexPluginPackage(path.resolve("plugins/renpy"));
    expect(result.ok, JSON.stringify(result)).toBe(true);
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
    expect(tools.sort()).toEqual(["renpy_compile", "renpy_export_web", "renpy_lint", "renpy_status"].sort());
    expect(commands.sort()).toEqual(["runInRenpy", "settingsStatus"]);
  });
});
