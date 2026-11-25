import { desktopCapturer } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { analyzeBitmap } from "../shared/capture-analysis.js";
import type { NativeWindowCaptureInput } from "../shared/engine-observations.js";

const run = promisify(execFile);
const THUMBNAIL = { width: 1_920, height: 1_200 };
const POWERSHELL_TIMEOUT_MS = 10_000;

interface WindowOwner {
  hwnd: string;
  pid: number;
  title: string;
  className: string;
  width: number;
  height: number;
}

/** Windows that belong to a process but are not the game surface. */
const NON_GAME_WINDOWS = new Set(["ConsoleWindowClass", "PseudoConsoleWindow", "CASCADIA_HOSTING_WINDOW_CLASS"]);

/**
 * The visible top-level windows of a session's process tree, by HWND. This is
 * a read-only process query; it does not capture or move any window.
 */
async function sessionWindows(rootPid: number): Promise<WindowOwner[]> {
  if (process.platform !== "win32") throw new Error("Native window capture is available on Windows only");
  const script = `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [Console]::OutputEncoding
$root = ${rootPid}
$procs = Get-CimInstance Win32_Process
$ids = New-Object System.Collections.Generic.HashSet[int]
$queue = New-Object System.Collections.Queue
[void]$ids.Add($root)
$queue.Enqueue($root)
while ($queue.Count -gt 0) {
  $parent = [int]$queue.Dequeue()
  foreach ($child in $procs | Where-Object { $_.ParentProcessId -eq $parent }) {
    $childId = [int]$child.ProcessId
    if ($ids.Add($childId)) { $queue.Enqueue($childId) }
  }
}
$pidArray = [uint32[]]($ids | ForEach-Object { $_ })
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public struct OhMyGameRect { public int Left; public int Top; public int Right; public int Bottom; }
public class OhMyGameWindowEnum {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out OhMyGameRect rect);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  public static List<object> List(uint[] pids) {
    var result = new List<object>();
    EnumWindows((hwnd, _) => {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (Array.IndexOf(pids, pid) < 0 || !IsWindowVisible(hwnd)) return true;
      int length = GetWindowTextLength(hwnd);
      var title = new StringBuilder(length + 1);
      GetWindowText(hwnd, title, title.Capacity);
      var cls = new StringBuilder(256);
      GetClassName(hwnd, cls, cls.Capacity);
      OhMyGameRect rect; GetWindowRect(hwnd, out rect);
      result.Add(new { hwnd = hwnd.ToInt64().ToString(), pid = (int)pid, title = title.ToString(), className = cls.ToString(), width = rect.Right - rect.Left, height = rect.Bottom - rect.Top, iconic = IsIconic(hwnd) });
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
"@
[OhMyGameWindowEnum]::List($pidArray) | ConvertTo-Json -Compress
`;
  const { stdout } = await run("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
  ], { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 });
  if (!stdout.trim()) return [];
  const parsed: unknown = JSON.parse(stdout);
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.flatMap((value): WindowOwner[] => {
    if (!value || typeof value !== "object") return [];
    const item = value as Partial<WindowOwner> & { iconic?: unknown };
    if (typeof item.hwnd !== "string" || !/^\d+$/.test(item.hwnd)
      || typeof item.pid !== "number" || !Number.isSafeInteger(item.pid) || item.pid <= 0
      || typeof item.title !== "string" || typeof item.className !== "string"
      || typeof item.width !== "number" || typeof item.height !== "number"
      || item.iconic === true) return [];
    return [{
      hwnd: item.hwnd,
      pid: item.pid,
      title: item.title.slice(0, 500),
      className: item.className.slice(0, 100),
      width: item.width,
      height: item.height,
    }];
  }).filter((window) => !NON_GAME_WINDOWS.has(window.className) && window.width > 64 && window.height > 64);
}

/**
 * Capture one visible window owned by the session's process tree. The caller
 * has already received an explicit person action; this function never chooses
 * an unrelated window or falls back to a title guess.
 */
export async function captureNativeWindow(request: { rootPid: number; sessionId: string }): Promise<NativeWindowCaptureInput> {
  if (process.platform !== "win32") throw new Error("Native window capture is available on Windows only");
  if (!Number.isSafeInteger(request.rootPid) || request.rootPid <= 0) throw new Error("Invalid native session process");
  const owners = await sessionWindows(request.rootPid);
  if (!owners.length) throw new Error("No visible top-level window belongs to this managed session. Bring the game window on screen and try again.");
  const byHwnd = new Map(owners.map((owner) => [owner.hwnd, owner]));
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: THUMBNAIL,
    fetchWindowIcons: false,
  });
  const candidates = sources.flatMap((source) => {
    const match = /^window:(\d+):\d+$/.exec(source.id);
    const owner = match ? byHwnd.get(match[1]!) : undefined;
    const size = source.thumbnail.getSize();
    return owner && size.width > 32 && size.height > 32 ? [{ source, owner, size }] : [];
  });
  if (!candidates.length) throw new Error("No captureable visible window belongs to this managed session. Restore the game window and try again.");
  if (candidates.length > 1) {
    const listed = candidates.map(({ owner }) => `${owner.title || "(untitled)"} [pid ${owner.pid}]`).join("; ");
    throw new Error(`More than one window belongs to this managed session; close the extra windows and try again. Windows: ${listed}`);
  }
  const [{ source, owner, size }] = candidates;
  // Re-query at the last moment: a closed window's handle can be reused by an
  // unrelated process before desktopCapturer returns its source.
  const current = (await sessionWindows(request.rootPid)).find((window) => window.hwnd === owner.hwnd);
  if (!current || current.pid !== owner.pid)
    throw new Error("The managed window changed while it was being captured. Restore the game and try again.");
  if (source.thumbnail.isEmpty()) throw new Error("The managed window returned an empty capture. Restore it and try again.");
  const analysis = analyzeBitmap(source.thumbnail.toBitmap(), size.width, size.height, "bgra");
  return {
    width: size.width,
    height: size.height,
    title: (source.name || owner.title).slice(0, 500),
    hwnd: owner.hwnd,
    rootPid: request.rootPid,
    pid: owner.pid,
    mediaType: "image/png",
    analysis,
    data: source.thumbnail.toPNG().toString("base64"),
  };
}
