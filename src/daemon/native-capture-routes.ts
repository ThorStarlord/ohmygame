import type { FastifyInstance } from "fastify";
import type { ProjectState } from "../shared/contracts.js";
import type { NativeWindowCaptureSummary } from "../shared/engine-observations.js";
import type { NativeSessionView } from "../shared/native-sessions.js";
import { NativeCaptureRequests } from "./native-capture-requests.js";
import { NativeWindowCaptures, parseNativeWindowCapture } from "./native-window-captures.js";

export interface NativeCaptureRoutesOptions {
  platform: NodeJS.Platform;
  projects: { get(id: string): ProjectState | undefined };
  sessions(project: ProjectState): Promise<NativeSessionView[]>;
  requests: NativeCaptureRequests;
  captures: NativeWindowCaptures;
  redactTitle(text: string, plugin: string): string;
}

/** The exact/latest reads and the claimant-token answer route for native captures. */
export function registerNativeCaptureRoutes(app: FastifyInstance, options: NativeCaptureRoutesOptions): void {
  app.get<{ Params: { projectId: string; sessionId: string } }>(
    "/projects/:projectId/native-sessions/:sessionId/capture",
    async (request, reply) => {
      const project = options.projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const capture = options.captures.latest(project.id, request.params.sessionId);
      return capture ?? reply.code(404).send({ error: "No capture is retained for this session" });
    },
  );

  app.get<{ Params: { projectId: string; captureId: string } }>(
    "/projects/:projectId/native-captures/:captureId",
    async (request, reply) => {
      const project = options.projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const capture = options.captures.get(project.id, request.params.captureId);
      return capture ?? reply.code(404).send({ error: "That capture is no longer retained" });
    },
  );

  app.post<{ Params: { projectId: string; request: string }; Body: unknown }>(
    "/projects/:projectId/native-capture-requests/:request",
    { bodyLimit: 20 * 1024 * 1024 },
    async (request, reply) => {
      if (options.platform !== "win32") return reply.code(409).send({ error: "Native window capture is available on Windows only" });
      const project = options.projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const target = options.requests.target(project.id, request.params.request);
      if (!target) return reply.code(404).send({ error: "No visual observation request is waiting" });
      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) return reply.code(400).send({ error: "Invalid observation answer" });
      const answer = body as Record<string, unknown>;
      const keys = Object.keys(answer);
      if ("started" in answer) {
        if (keys.length !== 1 || answer.started !== true) return reply.code(400).send({ error: "Invalid observation answer" });
        const claimToken = options.requests.claim(project.id, request.params.request);
        return claimToken
          ? reply.send({ claimToken })
          : reply.code(404).send({ error: "No visual observation request is waiting" });
      }
      if ("declined" in answer) {
        if (keys.length !== 1 || typeof answer.declined !== "string" || answer.declined.length > 2_000)
          return reply.code(400).send({ error: "Invalid observation answer" });
        options.requests.decline(project.id, request.params.request, answer.declined);
        return reply.code(204).send();
      }
      const claimToken = answer.claimToken;
      if (typeof claimToken !== "string" || claimToken.length > 100) return reply.code(400).send({ error: "Invalid observation answer" });
      if ("error" in answer) {
        if (keys.length !== 2 || typeof answer.error !== "string" || answer.error.length > 2_000)
          return reply.code(400).send({ error: "Invalid observation answer" });
        return options.requests.fail(project.id, request.params.request, claimToken, answer.error)
          ? reply.code(204).send()
          : reply.code(409).send({ error: "The visual observation request is no longer waiting" });
      }
      if (!("image" in answer) || keys.length !== 2) return reply.code(400).send({ error: "Invalid observation answer" });
      const session = (await options.sessions(project))
        .find((item) => item.id === target.sessionId);
      if (!session || session.state !== "running" || session.pid !== target.rootPid) {
        options.requests.fail(project.id, request.params.request, claimToken, "The managed native session changed before the capture arrived.");
        return reply.code(409).send({ error: "The managed native session changed before the capture arrived" });
      }
      const input = parseNativeWindowCapture(answer.image);
      if (!input || input.rootPid !== target.rootPid) {
        options.requests.fail(project.id, request.params.request, claimToken, "The capture did not belong to the approved session.");
        return reply.code(400).send({ error: "Invalid window capture" });
      }
      let saved: NativeWindowCaptureSummary | undefined;
      try {
        const delivered = options.requests.resolveWith(project.id, request.params.request, claimToken, () => {
          const summary = options.captures.add(project.id, target.sessionId, {
            ...input,
            title: options.redactTitle(input.title, session.plugin),
          }, { requestId: request.params.request, ...(target.grantId ? { grantId: target.grantId } : {}), plugin: session.plugin });
          saved = summary;
          return { ...summary, data: input.data };
        });
        if (!delivered) return reply.code(409).send({ error: "The visual observation request is no longer waiting" });
      } catch {
        options.requests.fail(project.id, request.params.request, claimToken, "The capture could not be retained.");
        return reply.code(500).send({ error: "The capture could not be retained" });
      }
      return saved;
    },
  );
}
