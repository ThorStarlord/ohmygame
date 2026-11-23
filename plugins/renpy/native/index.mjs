// OhMyGame Ren'Py plugin entry point; runs in the project extension host.
import { resolveRenpy, runRenpy, exportWeb, launchRenpy } from "./renpy.mjs";

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
  const build = (call) => {
    const next = exporting.catch(() => {}).then(async () => {
      if (call.signal?.aborted) throw new Error("Ren'Py export cancelled");
      return exportWeb(project(), await requireSdk(call), { signal: call.signal, progress: call.progress });
    });
    exporting = next;
    return next;
  };

  context.registerProjectType("renpy-game", {
    buildWeb: async (_input, call) => {
      await build(call);
      return { folder: ".ohmygame/build/web", entry: "index.html" };
    },
  });

  context.registerTool("renpy_status", async (_input, call) => {
    const sdk = await resolveRenpy(call?.configuration?.renpySdkPath);
    return sdk
      ? { found: true, executable: sdk.executable, sdkPath: sdk.sdkPath }
      : { found: false, executable: null, sdkPath: null, problem: "Ren'Py SDK not found; configure the SDK location." };
  });

  context.registerTool("renpy_lint", async (_input, call) =>
    runRenpy(await requireSdk(call), [project(), "lint", "--error-code"], {
      cwd: project(), signal: call.signal, progress: call.progress, timeoutMs: 180_000,
    }));

  context.registerTool("renpy_compile", async (_input, call) =>
    runRenpy(await requireSdk(call), [project(), "compile", "--keep-orphan-rpyc"], {
      cwd: project(), signal: call.signal, progress: call.progress, timeoutMs: 180_000,
    }));

  context.registerTool("renpy_test", async (_input, call) =>
    runRenpy(await requireSdk(call), [project(), "test"], {
      cwd: project(), signal: call.signal, progress: call.progress, timeoutMs: 300_000,
    }));

  context.registerTool("renpy_export_web", async (_input, call) => build(call));

  context.registerCommand("settingsStatus", async (_input, call) => {
    const sdk = await resolveRenpy(call?.configuration?.renpySdkPath);
    return sdk
      ? { message: "Ren'Py SDK detected", detail: sdk.sdkPath + "\nCLI: " + sdk.executable, actions: [] }
      : { message: "Ren'Py SDK not found", detail: "Select an SDK directory in this plugin's settings or set RENPY_SDK_PATH. Native lint, compile, run, and web export require an installed SDK.", actions: [] };
  });

  context.registerCommand("runInRenpy", async (_input, call) => {
    const child = await launchRenpy(await requireSdk(call), project(), call.signal);
    context.onDispose(() => {
      if (child.exitCode === null) child.kill();
    });
    return { started: true };
  });
}
