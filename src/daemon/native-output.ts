import type { ChildProcess } from "node:child_process";
import type { NativeSessionOutput } from "../shared/native-sessions.js";

// Match the wire bound. Keep only a tail per stream and never put it in the
// extension host's general logs. A stuck IPC consumer cannot queue snapshots.
const MAX_CHARS = 4_096;
const PUBLISH_MS = 750;
const DRAIN_MS = 200;

type Publish = (output: NativeSessionOutput, done: () => void) => void;

/** Drain an explicitly observed child; never keep its close waiting on inherited pipes. */
export function captureNativeOutput(child: ChildProcess, publish: Publish): void {
  let stdout = "";
  let stderr = "";
  let omitted = false;
  let dirty = true;
  let sending = false;
  let drain: ReturnType<typeof setTimeout> | undefined;
  const streams = [child.stdout, child.stderr];
  for (const [index, stream] of streams.entries()) {
    if (!stream) { omitted = true; continue; }
    stream.setEncoding("utf8");
    stream.on("data", (text: string) => {
      const old = index === 0 ? stdout : stderr;
      if (old.length + text.length > MAX_CHARS) omitted = true;
      const next = (old + text).slice(-MAX_CHARS);
      if (index === 0) stdout = next;
      else stderr = next;
      dirty = true;
    });
    stream.on("error", () => { omitted = true; dirty = true; });
  }
  const flush = (terminal = false) => {
    if (!dirty || (sending && !terminal)) return;
    dirty = false;
    sending = true;
    try { publish({ stdout, stderr, omitted }, () => { sending = false; }); }
    catch { sending = false; }
  };
  const timer = setInterval(() => flush(), PUBLISH_MS);
  timer.unref();
  child.once("exit", () => {
    drain = setTimeout(() => {
      for (const stream of streams) {
        if (stream && !stream.destroyed && !stream.readableEnded) {
          omitted = true;
          dirty = true;
          stream.destroy();
        }
      }
    }, DRAIN_MS);
    drain.unref();
  });
  // Registered before the session's own close listener, so its final output
  // is sent before the terminal state. No extra process or lifetime hold.
  child.once("close", () => {
    clearInterval(timer);
    clearTimeout(drain);
    flush(true);
  });
}
