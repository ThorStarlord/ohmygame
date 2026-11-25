import { randomUUID } from "node:crypto";
import type { NativeWindowCapture, NativeWindowCaptureInput, NativeWindowCaptureSummary } from "../shared/engine-observations.js";

const MAX_PROJECTS = 24;
const MAX_CAPTURES = 12;

const summary = ({ data: _data, ...item }: NativeWindowCapture): NativeWindowCaptureSummary => ({ ...item });

/**
 * Person-authorized window captures for one daemon lifetime. Captures are
 * project-scoped, bounded, never written to the project and never captured by
 * this class; a desktop window must supply the PNG after the person asks.
 */
export class NativeWindowCaptures {
  readonly #projects = new Map<string, NativeWindowCapture[]>();

  add(projectId: string, sessionId: string, input: NativeWindowCaptureInput): NativeWindowCaptureSummary {
    const capture: NativeWindowCapture = {
      ...input,
      id: randomUUID(),
      sessionId,
      capturedAt: Date.now(),
    };
    const captures = [capture, ...(this.#projects.get(projectId) ?? [])]
      .filter((item, index, all) => item.sessionId !== sessionId || all.findIndex((other) => other.sessionId === sessionId) === index)
      .slice(0, MAX_CAPTURES);
    this.#projects.delete(projectId);
    this.#projects.set(projectId, captures);
    while (this.#projects.size > MAX_PROJECTS) this.#projects.delete(this.#projects.keys().next().value!);
    return summary(capture);
  }

  list(projectId: string): NativeWindowCaptureSummary[] {
    return (this.#projects.get(projectId) ?? []).map(summary);
  }

  latest(projectId: string, sessionId: string): NativeWindowCapture | undefined {
    const found = this.#projects.get(projectId)?.find((item) => item.sessionId === sessionId);
    return found ? { ...found } : undefined;
  }

  forget(projectId: string): void {
    this.#projects.delete(projectId);
  }
}
