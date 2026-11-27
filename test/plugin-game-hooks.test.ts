import { describe, expect, it, vi } from "vitest";
import { projectGameHooks } from "../src/daemon/project-types.js";
import type { PluginServices } from "../src/daemon/plugin-services.js";
import type { GameUseHookInput } from "../src/shared/extension-host-protocol.js";

describe("plugin game_use call timeouts", () => {
  it("lets open outlast the default plugin call timeout", async () => {
    const timeouts: Array<number | undefined> = [];
    const services = {
      native: {
        projectTypeHook: vi.fn(async (_type: string, _hook: string, options: { timeoutMs?: number }) => {
          timeouts.push(options.timeoutMs);
          return {};
        }),
      },
    } as unknown as PluginServices;
    const hooks = projectGameHooks("/game", services, { provider: "a/b:c", version: "1.0.0" });
    await hooks.call({ operation: "open" } satisfies GameUseHookInput);
    await hooks.call({ operation: "inspect", session: "plugin-session" });
    await hooks.call({ operation: "captureFrame", session: "plugin-session", output: "/game/frame.png", frame: 1 });
    expect(timeouts).toEqual([300_000, undefined, 600_000]);
  });
});
