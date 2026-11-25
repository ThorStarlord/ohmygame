import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { captureNativeOutput } from "../src/daemon/native-output.js";
import type { NativeSessionOutput } from "../src/shared/native-sessions.js";

describe("Native output observation", () => {
  it("drains a real child and bounds separate output streams", async () => {
    const child = spawn(process.execPath, ["-e", 'process.stdout.write("x".repeat(5000)+" tail"); process.stderr.write("engine warning"); process.exitCode=3'], { stdio: ["ignore", "pipe", "pipe"] });
    const views: NativeSessionOutput[] = [];
    captureNativeOutput(child, (view, done) => { views.push(view); done(); });
    const [code] = await once(child, "close");
    expect(code).toBe(3);
    expect(views.at(-1)?.stdout).toHaveLength(4096);
    expect(views.at(-1)?.stdout.endsWith(" tail")).toBe(true);
    expect(views.at(-1)).toMatchObject({ stderr: "engine warning", omitted: true });
  });
});
