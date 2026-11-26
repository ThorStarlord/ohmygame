import type { RuntimeEventData } from "../shared/contracts.js";
import type { NativeWindowCapture, NativeWindowCaptureInput } from "../shared/engine-observations.js";
import { WindowClaims } from "./window-claims.js";

/** How long the project's desktop windows have to take a visual observation request. */
export const NATIVE_CAPTURE_START_MS = 20_000;
/** How long a claimed capture has to finish. */
export const NATIVE_CAPTURE_FINISH_MS = 20_000;

/** What one request is bound to: a specific managed session, root process and label. */
export interface NativeCaptureTarget {
  sessionId: string;
  rootPid: number;
  label: string;
}

/** A window's answer to a visual observation request. */
export type NativeCaptureRequestAnswer =
  | { started: true }
  | { declined: string }
  | { error: string }
  | { image: NativeWindowCaptureInput };

export interface NativeCaptureRequestsOptions {
  publish<T extends "native.capture.request" | "native.capture.cancel">(
    projectId: string,
    type: T,
    data: RuntimeEventData[T],
  ): void;
  /** How many windows of the app have the project open, each of which may take a request. */
  windows(projectId: string): number;
}

/**
 * One-time, person-authorized still captures of a managed native session.
 * The daemon has no page of its own, so a request goes to the project's open
 * desktop windows; one window claims it, uses the existing desktop capture
 * adapter and answers. A request is bound to one session and root process and
 * is removed as soon as it settles, so it cannot authorize another capture.
 */
export class NativeCaptureRequests {
  readonly #claims: WindowClaims<NativeWindowCapture, NativeCaptureTarget>;

  constructor(private readonly options: NativeCaptureRequestsOptions) {
    this.#claims = new WindowClaims({
      windows: options.windows,
      cancel: (projectId, request) => options.publish(projectId, "native.capture.cancel", { request }),
      error: (_kind, message) => new Error(message),
    });
  }

  request(projectId: string, target: NativeCaptureTarget, signal?: AbortSignal): Promise<NativeWindowCapture> {
    return this.#claims.request(projectId, target, {
      startMs: NATIVE_CAPTURE_START_MS,
      unclaimed: "No OhMyGame desktop window took the visual observation request. Keep the project open in the desktop app and try again.",
      ...(signal ? { signal } : {}),
      publish: (request, expires) => this.options.publish(projectId, "native.capture.request", {
        request,
        sessionId: target.sessionId,
        rootPid: target.rootPid,
        label: target.label,
        expires,
      }),
    });
  }

  /** The session and root process a pending request is bound to. */
  target(projectId: string, request: string): NativeCaptureTarget | undefined {
    return this.#claims.detail(projectId, request);
  }

  claim(projectId: string, request: string): boolean {
    return this.#claims.claim(projectId, request, NATIVE_CAPTURE_FINISH_MS,
      "The game window was not captured in time. Make sure it is visible and try again.");
  }

  decline(projectId: string, request: string, reason: string): boolean {
    return this.#claims.decline(projectId, request, reason);
  }

  fail(projectId: string, request: string, message: string): boolean {
    return this.#claims.fail(projectId, request, message);
  }

  resolve(projectId: string, request: string, capture: NativeWindowCapture): boolean {
    return this.#claims.resolve(projectId, request, capture);
  }

  /** A stopped or replaced session no longer authorizes an outstanding request. */
  cancelSession(projectId: string, sessionId: string): void {
    this.#claims.cancelWhere(projectId, (target) => target.sessionId === sessionId,
      "The managed native session ended before it was captured.");
  }

  forget(projectId: string): void {
    this.#claims.cancelProject(projectId);
  }
}
