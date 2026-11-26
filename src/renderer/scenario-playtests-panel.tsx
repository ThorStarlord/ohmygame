import { useEffect, useState } from "react";
import type {
  ScenarioCheckpoint,
  ScenarioCheckpointKind,
  ScenarioDiscovery,
  ScenarioRunMode,
  ScenarioRunStatus,
  ScenarioRunSummary,
} from "../shared/engine-observations.js";
import { request } from "./api.js";
import { t } from "./i18n.js";
import { Button } from "./ui/index.js";

function runStatus(status: ScenarioRunStatus): string {
  return ({
    passed: t("engineObservations.scenarioStatusPassed"),
    failed: t("engineObservations.scenarioStatusFailed"),
    skipped: t("engineObservations.scenarioStatusSkipped"),
    "timed-out": t("engineObservations.scenarioStatusTimedOut"),
    cancelled: t("engineObservations.scenarioStatusCancelled"),
    "not-found": t("engineObservations.scenarioStatusNotFound"),
    "invocation-error": t("engineObservations.scenarioStatusInvocationError"),
    unknown: t("engineObservations.scenarioStatusUnknown"),
  })[status];
}

function modeLabel(mode: ScenarioRunMode): string {
  return mode === "regression"
    ? t("engineObservations.scenarioModeRegression")
    : t("engineObservations.scenarioModeExploratory");
}

function kindLabel(kind: ScenarioCheckpointKind): string {
  return ({
    exploratory: t("engineObservations.scenarioKindExploratory"),
    mismatched: t("engineObservations.scenarioKindMismatched"),
    "no-baseline": t("engineObservations.scenarioKindNoBaseline"),
    difference: t("engineObservations.scenarioKindDifference"),
  })[kind];
}

function severityLabel(value: "error" | "warning" | "info" | "unknown"): string {
  return ({
    error: t("engineObservations.severityError"),
    warning: t("engineObservations.severityWarning"),
    info: t("engineObservations.severityInfo"),
    unknown: t("engineObservations.severityUnknown"),
  })[value];
}

function rememberImage(current: Record<string, string>, id: string, data: string): Record<string, string> {
  const next = { ...current, [id]: data };
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - 6))) delete next[key];
  return next;
}

/**
 * Engine-native scenario playtesting inside Problems & engine status. Runs are
 * explicit; a discovery or run starts the engine in the plugin's disposable
 * mirror. Checkpoint images are distinct from desktop captures.
 */
export function ScenarioPlaytestsPanel({ projectId, runs, onChanged, onAskAgent }: {
  projectId: string;
  runs: readonly ScenarioRunSummary[];
  onChanged: () => void;
  onAskAgent?: (text: string) => void;
}) {
  const [discovery, setDiscovery] = useState<ScenarioDiscovery>();
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string>();
  const [scenario, setScenario] = useState("");
  const [mode, setMode] = useState<ScenarioRunMode>("exploratory");
  const [baselineDirectory, setBaselineDirectory] = useState("tests/screenshots");
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string>();
  const [images, setImages] = useState<Record<string, string>>({});
  const [viewing, setViewing] = useState<string>();
  const [imageError, setImageError] = useState<string>();
  const [beforeId, setBeforeId] = useState<string>();
  const [afterId, setAfterId] = useState<string>();

  const retained = runs.flatMap((run) => run.checkpoints
    .filter((checkpoint) => checkpoint.retained)
    .map((checkpoint) => ({ run, checkpoint })));
  const retainedKey = retained.map(({ checkpoint }) => checkpoint.id).join("|");
  const newestRunId = runs[0]?.id;

  useEffect(() => {
    if (!retained.length) return;
    const newest = retained[0]!;
    setAfterId(newest.checkpoint.id);
    const match = retained.find((item) => item.run.id !== newest.run.id
      && item.checkpoint.scenario === newest.checkpoint.scenario
      && item.checkpoint.name === newest.checkpoint.name
      && item.checkpoint.mode === newest.checkpoint.mode);
    setBeforeId(match?.checkpoint.id);
  }, [retainedKey, newestRunId]);

  const before = retained.find((item) => item.checkpoint.id === beforeId);
  const after = retained.find((item) => item.checkpoint.id === afterId);
  const reasons: string[] = [];
  if (before && after) {
    if (before.checkpoint.scenario !== after.checkpoint.scenario) reasons.push(t("engineObservations.scenarioReasonScenario"));
    if (before.checkpoint.name !== after.checkpoint.name) reasons.push(t("engineObservations.scenarioReasonName"));
    if (before.checkpoint.mode !== after.checkpoint.mode) reasons.push(t("engineObservations.scenarioReasonMode"));
    if (before.checkpoint.kind === "difference" || after.checkpoint.kind === "difference") reasons.push(t("engineObservations.scenarioReasonKind"));
    if (before.checkpoint.width !== after.checkpoint.width || before.checkpoint.height !== after.checkpoint.height)
      reasons.push(t("engineObservations.scenarioReasonSize"));
  }
  const comparable = Boolean(before && after) && reasons.length === 0;

  async function discoverScenarios() {
    if (discovering) return;
    setDiscovering(true);
    setDiscoverError(undefined);
    try {
      const result = await request<ScenarioDiscovery>(`/projects/${encodeURIComponent(projectId)}/scenarios/discover`, { method: "POST" });
      setDiscovery(result);
      if (result.scenarios.length)
        setScenario((current) => result.scenarios.some((item) => item.name === current)
          ? current
          : result.scenarios.find((item) => item.default)?.name ?? result.scenarios[0]!.name);
    } catch (cause) {
      setDiscoverError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDiscovering(false);
    }
  }

  async function runScenario() {
    if (running || discovering || !scenario) return;
    setRunning(true);
    setRunError(undefined);
    try {
      await request(`/projects/${encodeURIComponent(projectId)}/scenario-runs`, {
        method: "POST",
        body: JSON.stringify({
          scenario,
          mode,
          ...(mode === "regression" && baselineDirectory.trim() ? { baselineDirectory: baselineDirectory.trim() } : {}),
        }),
      });
      onChanged();
    } catch (cause) {
      setRunError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  }

  async function viewCheckpoint(checkpointId: string) {
    if (viewing) return;
    setViewing(checkpointId);
    setImageError(undefined);
    try {
      const image = await request<ScenarioCheckpoint>(`/projects/${encodeURIComponent(projectId)}/scenario-checkpoints/${encodeURIComponent(checkpointId)}`);
      setImages((current) => rememberImage(current, checkpointId, image.data));
    } catch (cause) {
      setImageError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setViewing(undefined);
    }
  }

  return <section data-scenario-playtests="">
    <p><strong>{t("engineObservations.scenarios")}</strong></p>
    <p>{t("engineObservations.scenarioDiscoverHint")}</p>
    <Button size="sm" disabled={discovering} onClick={() => void discoverScenarios()}>
      {discovering ? t("engineObservations.scenarioDiscovering") : t("engineObservations.scenarioDiscover")}
    </Button>
    {discoverError ? <p role="alert">{discoverError}</p> : null}
    {discovery ? <>
      {discovery.status !== "passed" ? <p role="alert">{discovery.failure ?? t("engineObservations.scenarioDiscoveryFailed")}</p> : null}
      {discovery.scenarios.length ? <>
        <label>{t("engineObservations.scenario")}
          <select value={scenario} onChange={(event) => setScenario(event.target.value)}>
            {discovery.scenarios.map((item) => <option key={item.name} value={item.name}>
              {item.name} · {item.kind}{item.file ? ` · ${item.file}${item.line ? `:${item.line}` : ""}` : ""}{item.parameterized ? ` · ${t("engineObservations.scenarioParameterized")}` : ""}
            </option>)}
          </select>
        </label>
        <label>{t("engineObservations.scenarioMode")}
          <select value={mode} onChange={(event) => setMode(event.target.value === "regression" ? "regression" : "exploratory")}>
            <option value="exploratory">{t("engineObservations.scenarioModeExploratory")}</option>
            <option value="regression">{t("engineObservations.scenarioModeRegression")}</option>
          </select>
        </label>
        {mode === "regression" ? <label>{t("engineObservations.scenarioBaselineDirectory")}
          <input value={baselineDirectory} maxLength={300} onChange={(event) => setBaselineDirectory(event.target.value)} />
          <small>{t("engineObservations.scenarioBaselineHint")}</small>
        </label> : null}
        <Button size="sm" disabled={running || !scenario} onClick={() => void runScenario()}>
          {running ? t("engineObservations.scenarioRunning") : t("engineObservations.scenarioRun")}
        </Button>
        <p>{t("engineObservations.scenarioModeHint")}</p>
      </> : <p>{discovery.truncated ? t("engineObservations.scenarioTruncated") : t("engineObservations.scenarioNone")}</p>}
      {discovery.errors.length ? <details><summary>{t("engineObservations.scenarioEngineOutput")}</summary><pre>{discovery.errors.join("\n")}</pre></details> : null}
    </> : null}
    {runError ? <p role="alert">{runError}</p> : null}
    {imageError ? <p role="alert">{imageError}</p> : null}

    <p><strong>{t("engineObservations.scenarioRuns")}</strong></p>
    {runs.length ? runs.map((run) => <details key={run.id} open={runs[0]?.id === run.id}>
      <summary>{run.scenario} · {modeLabel(run.mode)} · {runStatus(run.status)} · {new Date(run.startedAt).toLocaleTimeString()}</summary>
      <p>{t("engineObservations.scenarioRunProvenance", { run: run.engineRunId.slice(0, 8), version: run.pluginVersion })}</p>
      {run.executedSelection ? <p>{t("engineObservations.scenarioExecuted", { selection: run.executedSelection })}</p> : null}
      {run.baselineFiles !== undefined ? <p>{t("engineObservations.scenarioBaselines", { count: run.baselineFiles })}</p> : null}
      {run.baselineDirectory ? <p>{t("engineObservations.scenarioBaselineFolder", { folder: run.baselineDirectory })}</p> : null}
      {run.failure ? <pre>{run.failure}</pre> : null}
      {run.checkpointLimitReached ? <p>{t("engineObservations.scenarioLimitReached")}</p> : null}
      {run.checkpointWarnings.map((warning, index) => <p key={index}>{warning}</p>)}
      {run.diagnostics.map((item, index) => <div key={`diagnostic-${index}`}>
        <p>{severityLabel(item.severity)}{item.path ? ` · ${item.path}${item.line != null ? `:${item.line}` : ""}` : ""}</p>
        <pre>{item.message}</pre>
      </div>)}
      {run.outputExcerpt ? <details>
        <summary>{t("engineObservations.scenarioEngineOutput")}</summary>
        <pre>{run.outputExcerpt}</pre>
        {run.outputOmitted ? <p>{t("engineObservations.scenarioOutputOmitted")}</p> : null}
      </details> : null}
      {run.checkpoints.length ? run.checkpoints.map((checkpoint) => <div key={checkpoint.id}>
        <p>{checkpoint.order + 1}. {checkpoint.name} · {kindLabel(checkpoint.kind)} · {checkpoint.width}×{checkpoint.height}</p>
        {checkpoint.retained
          ? <Button size="sm" variant="ghost" disabled={viewing === checkpoint.id} onClick={() => void viewCheckpoint(checkpoint.id)}>
              {viewing === checkpoint.id ? t("engineObservations.scenarioViewing") : t("engineObservations.scenarioViewCheckpoint")}
            </Button>
          : <small>{t("engineObservations.scenarioEvicted")}</small>}
        {checkpoint.retained && images[checkpoint.id] ? <figure>
          <img src={`data:image/png;base64,${images[checkpoint.id]}`} alt={t("engineObservations.scenarioCheckpointAlt", { name: checkpoint.name })} style={{ maxWidth: "100%", height: "auto" }} />
          <figcaption>{checkpoint.scenario} · {checkpoint.name} · {modeLabel(checkpoint.mode)}</figcaption>
        </figure> : null}
      </div>) : <p>{t("engineObservations.scenarioNoCheckpoints")}</p>}
      {onAskAgent ? <Button size="sm" variant="ghost" onClick={() => onAskAgent(`Inspect the retained scenario run with engine_observations runId ${run.id} for this project. Retrieve its retained checkpoints with engine_scenario_checkpoint by exact checkpointId, and use engine_scenario_compare for corresponding checkpoints. Distinguish observed differences, your interpretation, possible causes, and remaining uncertainty. Do not claim improvement from an image difference or a passing assertion alone.`)}>{t("engineObservations.scenarioInspect")}</Button> : null}
    </details>) : <p>{t("engineObservations.scenarioNoRuns")}</p>}

    <p><strong>{t("engineObservations.scenarioCompare")}</strong></p>
    {retained.length >= 2 ? <>
      {!before ? <p>{t("engineObservations.scenarioNeedMatchingRun")}</p> : null}
      <div className="capture-compare-pickers">
        <label>{t("engineObservations.scenarioBefore")}
          <select value={beforeId ?? ""} onChange={(event) => {
            const id = event.target.value;
            if (!id) { setBeforeId(undefined); return; }
            setBeforeId(id);
            void viewCheckpoint(id);
          }}>
            {!beforeId ? <option value="">{t("engineObservations.scenarioChooseCheckpoint")}</option> : null}
            {retained.map(({ run, checkpoint }) => <option key={checkpoint.id} value={checkpoint.id}>
              {run.scenario} · {checkpoint.name} · {new Date(run.startedAt).toLocaleTimeString()}
            </option>)}
          </select>
        </label>
        <label>{t("engineObservations.scenarioAfter")}
          <select value={afterId ?? ""} onChange={(event) => { setAfterId(event.target.value); void viewCheckpoint(event.target.value); }}>
            {retained.map(({ run, checkpoint }) => <option key={checkpoint.id} value={checkpoint.id}>
              {run.scenario} · {checkpoint.name} · {new Date(run.startedAt).toLocaleTimeString()}
            </option>)}
          </select>
        </label>
      </div>
      {before && after ? <p>{comparable ? t("engineObservations.scenarioComparable") : t("engineObservations.scenarioNotComparable", { reason: reasons.join("; ") })}</p> : null}
      <div className="capture-compare-images">
        {[before, after].map((item, index) => item ? <figure key={`${index}:${item.checkpoint.id}`}>
          <figcaption>{index === 0 ? t("engineObservations.scenarioBefore") : t("engineObservations.scenarioAfter")} · {item.checkpoint.name}</figcaption>
          {images[item.checkpoint.id]
            ? <img src={`data:image/png;base64,${images[item.checkpoint.id]}`} alt={t("engineObservations.scenarioCheckpointAlt", { name: item.checkpoint.name })} style={{ maxWidth: "100%", height: "auto" }} />
            : <Button size="sm" variant="ghost" disabled={viewing === item.checkpoint.id} onClick={() => void viewCheckpoint(item.checkpoint.id)}>
                {viewing === item.checkpoint.id ? t("engineObservations.scenarioViewing") : t("engineObservations.scenarioViewCheckpoint")}
              </Button>}
          <small>{item.run.scenario} · {modeLabel(item.checkpoint.mode)} · {kindLabel(item.checkpoint.kind)} · {item.checkpoint.width}×{item.checkpoint.height} · {new Date(item.run.startedAt).toLocaleTimeString()}</small>
        </figure> : null)}
      </div>
      <p>{t("engineObservations.scenarioHint")}</p>
    </> : <p>{t("engineObservations.scenarioNeedTwo")}</p>}
  </section>;
}
