import type { FastifyInstance } from "fastify";
import type { ProjectState } from "../shared/contracts.js";
import type {
  ScenarioCheckpoint,
  ScenarioCheckpointSummary,
  ScenarioDiscovery,
  ScenarioRunMode,
  ScenarioRunSummary,
} from "../shared/engine-observations.js";

export interface ScenarioRouteService {
  discover(project: ProjectState, signal?: AbortSignal): Promise<ScenarioDiscovery>;
  run(project: ProjectState, input: { scenario: string; mode?: ScenarioRunMode; baselineDirectory?: string }, signal?: AbortSignal): Promise<ScenarioRunSummary>;
  list(projectId: string): ScenarioRunSummary[];
  find(projectId: string, checkpointId: string): ScenarioCheckpointSummary | undefined;
  checkpoint(projectId: string, checkpointId: string): ScenarioCheckpoint;
}

export interface ScenarioRoutesOptions {
  projects: { get(id: string): ProjectState | undefined };
  playtests: ScenarioRouteService;
}

/** Discovery, explicit execution, run history and exact checkpoint retrieval. */
export function registerScenarioRoutes(app: FastifyInstance, options: ScenarioRoutesOptions): void {
  app.post<{ Params: { projectId: string } }>("/projects/:projectId/scenarios/discover", async (request, reply) => {
    const project = options.projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    const abort = new AbortController();
    request.raw.once("close", () => { if (!reply.raw.writableEnded) abort.abort(); });
    try {
      return await options.playtests.discover(project, abort.signal);
    } catch (cause) {
      return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  });

  app.post<{ Params: { projectId: string }; Body: { scenario: string; mode?: ScenarioRunMode; baselineDirectory?: string } }>(
    "/projects/:projectId/scenario-runs",
    {
      schema: {
        body: {
          type: "object", additionalProperties: false, required: ["scenario"],
          properties: {
            scenario: { type: "string", minLength: 1, maxLength: 200 },
            mode: { enum: ["exploratory", "regression"] },
            baselineDirectory: { type: "string", minLength: 1, maxLength: 300 },
          },
        },
      },
    },
    async (request, reply) => {
      const project = options.projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const abort = new AbortController();
      request.raw.once("close", () => { if (!reply.raw.writableEnded) abort.abort(); });
      try {
        return await options.playtests.run(project, {
          scenario: request.body.scenario,
          ...(request.body.mode ? { mode: request.body.mode } : {}),
          ...(request.body.baselineDirectory ? { baselineDirectory: request.body.baselineDirectory } : {}),
        }, abort.signal);
      } catch (cause) {
        return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  app.get<{ Params: { projectId: string } }>("/projects/:projectId/scenario-runs", async (request, reply) => {
    const project = options.projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    return { runs: options.playtests.list(project.id) };
  });

  app.get<{ Params: { projectId: string; checkpointId: string } }>(
    "/projects/:projectId/scenario-checkpoints/:checkpointId",
    async (request, reply) => {
      const project = options.projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const summary = options.playtests.find(project.id, request.params.checkpointId);
      if (!summary) return reply.code(404).send({ error: "That scenario checkpoint is no longer retained" });
      if (!summary.retained) return reply.code(410).send({ error: "That scenario checkpoint's image is no longer retained" });
      try {
        return options.playtests.checkpoint(project.id, request.params.checkpointId);
      } catch (cause) {
        return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );
}
