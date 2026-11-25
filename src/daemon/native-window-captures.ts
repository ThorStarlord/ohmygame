import { randomUUID } from "node:crypto";
import type { NativeWindowCapture, NativeWindowCaptureInput, NativeWindowCaptureSummary } from "../shared/engine-observations.js";
import { isNativeWindowCaptureInput } from "../shared/engine-observations.js";

const MAX_PROJECTS = 24;
const MAX_CAPTURES = 12;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PROJECT_BYTES = 32 * 1024 * 1024;

const summary = ({ data: _data, ...item }: NativeWindowCapture): NativeWindowCaptureSummary => ({ ...item });

/**
 * Validate a capture at the daemon boundary. Shape validation is shared; this
 * additionally proves the bytes are a PNG and that its dimensions match the
 * reported metadata. The input is rebuilt from allowed fields so no caller
 * field reaches storage or model-visible metadata.
 */
export function parseNativeWindowCapture(value: unknown): NativeWindowCaptureInput | undefined {
  if (!isNativeWindowCaptureInput(value)) return undefined;
  const input = value as NativeWindowCaptureInput;
  const bytes = Buffer.from(input.data, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return undefined;
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return undefined;
  if (bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") return undefined;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== input.width || height !== input.height) return undefined;
  return {
    width: input.width,
    height: input.height,
    title: input.title,
    hwnd: input.hwnd,
    pid: input.pid,
    mediaType: "image/png",
    analysis: {
      sampledPixels: input.analysis.sampledPixels,
      opaqueRatio: input.analysis.opaqueRatio,
      luminanceMean: input.analysis.luminanceMean,
      luminanceVariance: input.analysis.luminanceVariance,
      likelyBlank: input.analysis.likelyBlank,
    },
    data: input.data,
  };
}

/**
 * Person-authorized window captures for one daemon lifetime. Captures are
 * project-scoped, bounded by count and total encoded bytes, never written to
 * the project and never captured by this class.
 */
export class NativeWindowCaptures {
  readonly #projects = new Map<string, NativeWindowCapture[]>();
  readonly #bytes = new Map<string, number>();

  add(projectId: string, sessionId: string, input: NativeWindowCaptureInput): NativeWindowCaptureSummary {
    const capture: NativeWindowCapture = {
      id: randomUUID(),
      sessionId,
      capturedAt: Date.now(),
      width: input.width,
      height: input.height,
      title: input.title,
      hwnd: input.hwnd,
      pid: input.pid,
      mediaType: "image/png",
      analysis: { ...input.analysis },
      data: input.data,
    };
    const candidates = [capture, ...(this.#projects.get(projectId) ?? [])]
      .filter((item, index, all) => item.sessionId !== sessionId || all.findIndex((other) => other.sessionId === sessionId) === index);
    const captures: NativeWindowCapture[] = [];
    let bytes = 0;
    for (const item of candidates) {
      if (captures.length >= MAX_CAPTURES) break;
      if (bytes + item.data.length > MAX_PROJECT_BYTES) continue;
      captures.push(item);
      bytes += item.data.length;
    }
    this.#projects.delete(projectId);
    this.#projects.set(projectId, captures);
    this.#bytes.set(projectId, bytes);
    while (this.#projects.size > MAX_PROJECTS) {
      const oldest = this.#projects.keys().next().value!;
      this.#projects.delete(oldest);
      this.#bytes.delete(oldest);
    }
    return summary(capture);
  }

  list(projectId: string): NativeWindowCaptureSummary[] {
    return (this.#projects.get(projectId) ?? []).map(summary);
  }

  latest(projectId: string, sessionId: string): NativeWindowCapture | undefined {
    const found = this.#projects.get(projectId)?.find((item) => item.sessionId === sessionId);
    return found ? { ...found, analysis: { ...found.analysis } } : undefined;
  }

  forget(projectId: string): void {
    this.#projects.delete(projectId);
    this.#bytes.delete(projectId);
  }
}
