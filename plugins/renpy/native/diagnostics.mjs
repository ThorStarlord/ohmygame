import path from "node:path";
import { realpath, stat } from "node:fs/promises";

const MAX_DIAGNOSTICS = 50;
const MAX_MESSAGE = 2_000;

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Ren'Py reports paths relative to the copied project or absolute paths in
// that copy. Only link actual script sources under the real project's game.
async function sourceLocation(reported, mirror, project) {
  const candidate = reported.replaceAll("\\", "/");
  if (candidate.includes("\0") || candidate.split("/").includes("..")) return undefined;
  const absolute = path.isAbsolute(candidate);
  // A foreign-platform drive/UNC path must never become a relative path.
  if (!absolute && (/^[A-Za-z]:/.test(candidate) || candidate.startsWith("/"))) return undefined;
  const inMirror = path.resolve(mirror, candidate);
  if (!inside(mirror, inMirror)) return undefined;
  const relative = path.relative(mirror, inMirror).split(path.sep).join("/");
  if (!relative.startsWith("game/") || !/\.(?:rpy|rpym|py)$/i.test(relative) || /^game\/(?:saves|cache)(?:\/|$)/i.test(relative)) return undefined;
  try {
    const game = await realpath(path.join(project, "game"));
    const actual = await realpath(path.join(project, relative));
    const root = await realpath(project);
    if (!inside(root, game) || !inside(game, actual) || !(await stat(actual)).isFile()) return undefined;
    const realRelative = path.relative(game, actual).split(path.sep).join("/");
    if (/^(?:saves|cache)(?:\/|$)/i.test(realRelative)) return undefined;
    return relative;
  } catch { return undefined; }
}

/** Extract only reported findings, never infer a diagnosis or severity from a path. */
export async function renpyDiagnostics(output, mirror, project) {
  const lines = output.split(/\r?\n/);
  const diagnostics = [];
  let diagnosticsTruncated = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const traceback = /^File "([^"\r\n]+)", line (\d+)(?:[:,].*)?$/i.exec(line);
    // Ren'Py lint also emits game/script.rpy:12 followed by its finding.
    const lint = /^(.+?\.(?:rpy|rpym|py)):(\d+)(?:\s+|:\s*)(.*)$/i.exec(line);
    const location = traceback ?? lint;
    const severityText = lint?.[3] || line;
    const severity = /^warning\b/i.test(severityText) ? "warning"
      : /^(?:error\b|[\w.]*Error:|exception\b|I'm sorry, but an uncaught exception)/i.test(severityText) ? "error" : "unknown";
    if (!location && severity === "unknown" && !/^Traceback\b/i.test(line)) continue;
    if (diagnostics.length === MAX_DIAGNOSTICS) { diagnosticsTruncated = true; break; }
    const file = location ? await sourceLocation(location[1], mirror, project) : undefined;
    const lineNumber = location ? Number(location[2]) : undefined;
    // Preserve the original header and its immediate detail when present.
    const detail = traceback && lines[index + 1]?.trim();
    const header = file ? line.replace(location[1], file) : line;
    const text = detail ? `${header}\n${detail}` : header;
    if (text.length > MAX_MESSAGE) diagnosticsTruncated = true;
    const message = text.slice(0, MAX_MESSAGE);
    diagnostics.push({ severity, message, ...(file && Number.isSafeInteger(lineNumber) && lineNumber > 0 ? { path: file, line: lineNumber } : {}) });
  }
  return { diagnostics, diagnosticsTruncated };
}
