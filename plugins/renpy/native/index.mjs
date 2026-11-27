// OhMyGame Ren'Py plugin entry point; runs in the project extension host.
import { resolveRenpy, runWithIsolatedSaves, exportWeb, renpyLaunch } from "./renpy.mjs";
import { discoverScenarios, runScenario } from "./scenario.mjs";
import { closeAllInteractiveSessions, interactiveGameUse } from "./interactive.mjs";

function requireProject(context) {
  if (!context.project?.folder) throw new Error("Ren'Py tools require an open game project");
  return context.project.folder;
}

async function requireSdk(call) {
  const sdk = await resolveRenpy(call?.configuration?.renpySdkPath);
  if (!sdk) throw new Error("Ren'Py SDK not found. Configure renpySdkPath in the plugin settings or set RENPY_SDK_PATH / RENPY_HOME.");
  return sdk;
}

export function activate(context) {
  const project = () => requireProject(context);
  let exporting = Promise.resolve();
  // Preview and explicit export share a destination; serialize them so neither
  // replaces the other's output while it is in use.
  const build = (call, throwOnFailure = true) => {
    const next = exporting.catch(() => {}).then(async () => {
      if (call.signal?.aborted) throw new Error("Ren'Py export cancelled");
      return exportWeb(project(), await requireSdk(call), { signal: call.signal, progress: call.progress, throwOnFailure });
    });
    exporting = next;
    return next;
  };

  context.registerProjectType("renpy-game", {
    buildWeb: async (_input, call) => {
      await build(call);
      return { folder: ".ohmygame/build/web", entry: "index.html" };
    },
    gameUse: async (input, call) =>
      interactiveGameUse(await requireSdk(call), project(), input, {
        signal: call?.signal,
        env: {},
        label: input?.start,
      }),
  });
  context.onDispose(() => closeAllInteractiveSessions());

  context.registerTool("renpy_status", async (_input, call) => {
    const sdk = await resolveRenpy(call?.configuration?.renpySdkPath);
    return sdk
      ? { found: true, executable: sdk.executable, sdkPath: sdk.sdkPath }
      : { found: false, executable: null, sdkPath: null, problem: "Ren'Py SDK not found; configure the SDK location." };
  });

  const lint = async (_input, call) =>
    runWithIsolatedSaves(await requireSdk(call), project(), ["lint", "--error-code"], {
      cwd: project(), signal: call.signal, progress: call.progress, timeoutMs: 180_000,
    });
  context.registerTool("renpy_lint", lint);
  // The Problems panel runs this command; declaring it read-only keeps a
  // check from becoming an Undo entry or blocking a running agent turn.
  context.registerCommand("lintRenpy", lint);

  context.registerTool("renpy_compile", async (_input, call) =>
    runWithIsolatedSaves(await requireSdk(call), project(), ["compile", "--keep-orphan-rpyc"], {
      cwd: project(), signal: call.signal, progress: call.progress, timeoutMs: 180_000,
    }));

  context.registerTool("renpy_test", async (_input, call) =>
    runWithIsolatedSaves(await requireSdk(call), project(), ["test"], {
      cwd: project(), signal: call.signal, progress: call.progress, timeoutMs: 300_000,
    }));

  // Discovery and checkpoints use the engine's own testcase registry and
  // screenshot statements. The project's testcases remain the scenario
  // definition; no second scenario language is introduced.
  context.registerTool("renpy_scenarios", async (_input, call) =>
    discoverScenarios(await requireSdk(call), project(), {
      signal: call.signal, progress: call.progress, timeoutMs: 300_000,
    }));

  context.registerTool("renpy_scenario_run", async (input, call) =>
    runScenario(await requireSdk(call), project(), input, {
      signal: call.signal, progress: call.progress, timeoutMs: 300_000,
    }));

  // A failed export is a failed check with diagnostics, not a tool crash.
  context.registerTool("renpy_export_web", async (_input, call) => build(call, false));

  context.registerCommand("settingsStatus", async (_input, call) => {
    const sdk = await resolveRenpy(call?.configuration?.renpySdkPath);
    return sdk
      ? { message: "Ren'Py SDK detected", detail: sdk.sdkPath + "\nCLI: " + sdk.executable, actions: [] }
      : { message: "Ren'Py SDK not found", detail: "Select an SDK directory in this plugin's settings or set RENPY_SDK_PATH. Native lint, compile, run, and web export require an installed SDK.", actions: [] };
  });

  context.registerCommand("runInRenpy", async (_input, call) => {
    if (!context.nativeSessions)
      throw new Error("This OhMyGame version can't manage a native Ren'Py session. Update OhMyGame.");
    const sdk = await requireSdk(call);
    const session = await context.nativeSessions.start({ ...renpyLaunch(sdk, project()), captureOutput: true });
    call.progress("Ren'Py is running");
    return { started: true, sessionId: session.id, pid: session.pid };
  });
}
