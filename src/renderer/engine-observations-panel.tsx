import { useEffect, useState } from "react";
import type { EngineCheck, EngineCheckStatus, EngineDiagnostic, EngineObservationSnapshot, NativeWindowCapture, NativeWindowCaptureSummary } from "../shared/engine-observations.js";
import type { NativeSessionView } from "../shared/native-sessions.js";
import { request } from "./api.js";
import { usePluginSlot } from "./project-plugin-contributions.js";
import { t } from "./i18n.js";
import { Button } from "./ui/index.js";

function checkStatus(run: EngineCheck): string {
  if (run.status === "failed" && run.reportedErrors && run.exitCode === 0) return t("engineObservations.reportedErrors");
  const status: EngineCheckStatus = run.status;
  return ({
    running: t("engineObservations.running"), passed: t("engineObservations.passed"),
    failed: t("engineObservations.failed"), unknown: t("engineObservations.unknown"),
    cancelled: t("engineObservations.cancelled"), "invocation-error": t("engineObservations.invocationError"),
  })[status];
}
function severity(value: EngineDiagnostic["severity"]): string {
  return ({
    error: t("engineObservations.severityError"), warning: t("engineObservations.severityWarning"),
    info: t("engineObservations.severityInfo"), unknown: t("engineObservations.severityUnknown"),
  })[value];
}
function nativeStatus(value: NativeSessionView["state"]): string {
  return ({
    starting: t("engineObservations.nativeStarting"), running: t("engineObservations.nativeRunning"),
    stopping: t("engineObservations.nativeStopping"), exited: t("engineObservations.nativeExited"),
    failed: t("engineObservations.nativeFailed"),
  })[value];
}
function captureLabel(capture: NativeWindowCaptureSummary): string {
  return `${new Date(capture.capturedAt).toLocaleTimeString()} · ${capture.title}`;
}
function captureProvenance(capture: NativeWindowCaptureSummary): string {
  return `${capture.width}×${capture.height} · ${capture.sessionId.slice(0, 8)}${capture.plugin ? ` · ${capture.plugin}` : ""}`;
}

/** The same bounded evidence that engine_observations gives to coding agents. */
export function EngineObservationsPanel({ projectId, onClose, onOpenFile, onAskAgent }: {
  projectId: string;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onAskAgent?: (text: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<EngineObservationSnapshot>();
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string>();
  const [captureImages, setCaptureImages] = useState<Record<string, string>>({});
  const [capturing, setCapturing] = useState<string>();
  const [captureError, setCaptureError] = useState<string>();
  const [leftId, setLeftId] = useState<string>();
  const [rightId, setRightId] = useState<string>();
  const commands = usePluginSlot("game.more");
  const lint = commands.commands.find((command) => command.id === "thorstarlord/renpy:lint-renpy");

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const next = await request<EngineObservationSnapshot>(`/projects/${encodeURIComponent(projectId)}/engine-observations`, { signal: controller.signal });
        if (!controller.signal.aborted && next.projectId === projectId) {
          setSnapshot(next);
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, 3_000);
      }
    }
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [projectId, refresh]);
  const current = snapshot?.projectId === projectId ? snapshot : undefined;
  const selected = current?.checks.find((run) => run.id === selectedId) ?? current?.checks[0];
  const captures = current?.captures ?? [];
  const captureIds = captures.map((capture) => capture.id).join("|");
  useEffect(() => {
    if (!captures.length) return;
    setLeftId((id) => (id && captures.some((capture) => capture.id === id) ? id : captures[1]?.id ?? captures[0]!.id));
    setRightId((id) => (id && captures.some((capture) => capture.id === id) ? id : captures[0]!.id));
  }, [captureIds]);
  const before = captures.find((capture) => capture.id === leftId);
  const after = captures.find((capture) => capture.id === rightId);
  const latestFor = (sessionId: string) => captures.find((capture) => capture.sessionId === sessionId);
  async function runLint() {
    if (!lint || checking) return;
    setChecking(true);
    setCheckError(undefined);
    try { await commands.run(lint); }
    catch (cause) { setCheckError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setChecking(false); setRefresh((value) => value + 1); }
  }
  async function capture(sessionId: string, pid: number) {
    const api = window.ohMyGameDesktop?.captureNativeWindow;
    if (!api || capturing) return;
    setCapturing(sessionId);
    setCaptureError(undefined);
    try {
      const image = await api({ rootPid: pid, sessionId });
      const saved = await request<NativeWindowCaptureSummary>(`/projects/${encodeURIComponent(projectId)}/native-sessions/${encodeURIComponent(sessionId)}/captures`, {
        method: "POST",
        body: JSON.stringify(image),
      });
      setCaptureImages((current) => ({ ...current, [saved.id]: image.data }));
      setRightId(saved.id);
      setRefresh((value) => value + 1);
    } catch (cause) {
      setCaptureError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCapturing(undefined);
    }
  }
  async function viewCapture(captureId: string) {
    setCaptureError(undefined);
    try {
      const image = await request<NativeWindowCapture>(`/projects/${encodeURIComponent(projectId)}/native-captures/${encodeURIComponent(captureId)}`);
      setCaptureImages((current) => ({ ...current, [captureId]: image.data }));
    } catch (cause) {
      setCaptureError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return <aside className="preview-logs" aria-label={t("engineObservations.title")} data-native-preview-overlay="">
    <header><strong>{t("engineObservations.title")}</strong>
      <Button size="sm" variant="ghost" onClick={() => setRefresh((value) => value + 1)}>{t("engineObservations.refresh")}</Button>
      <button type="button" onClick={onClose} aria-label={t("engineObservations.close")}>×</button>
    </header>
    <p>{t("engineObservations.retention")}</p>
    {lint ? <Button size="sm" disabled={checking || current?.checks.some((run) => run.operation === "lint" && run.status === "running")} onClick={() => void runLint()}>{checking ? t("engineObservations.lintBusy") : t("engineObservations.lint")}</Button> : null}
    {checkError ? <p role="alert">{checkError}</p> : null}
    {captureError ? <p role="alert">{captureError}</p> : null}
    {error ? <p role="alert">{t("engineObservations.unavailable")}</p> : null}
    {!current && !error ? <p role="status">{t("engineObservations.loading")}</p> : null}
    {current ? <>
      <p><strong>{t("engineObservations.preview")}</strong> · {current.preview.status}{current.preview.phase ? ` · ${current.preview.phase}` : ""}</p>
      {current.preview.error ? <pre>{current.preview.error}</pre> : null}
      {current.preview.diagnostics.map((item, index) => <details key={index}><summary>{item.kind}{item.path ? ` · ${item.path}` : ""}</summary><pre>{item.message}</pre></details>)}
      <p><strong>{t("engineObservations.native")}</strong></p>
      {current.nativeSessions.length ? current.nativeSessions.map((session) => {
        const latest = latestFor(session.id);
        return <div key={session.id}>
          <p>{session.label} · {nativeStatus(session.state)}{session.exitCode != null ? ` · ${session.exitCode}` : ""}</p>
          {session.error ? <pre>{session.error}</pre> : null}
          {onAskAgent && session.output ? <Button size="sm" variant="ghost" onClick={() => onAskAgent("Inspect engine_observations for nativeSessionId " + session.id + " with includeOutput true. Explain the observed output, distinguish engine evidence from hypotheses, and do not treat the process state as visual or gameplay verification. Do not stop, launch, or modify the game just to read the observations.")}>{t("engineObservations.inspect")}</Button> : null}
          {session.output ? <details><summary>{t("engineObservations.raw")}</summary>
            <p>{t("engineObservations.omitted")}</p>
            {session.output.stdout ? <><p>stdout</p><pre>{session.output.stdout}</pre></> : null}
            {session.output.stderr ? <><p>stderr</p><pre>{session.output.stderr}</pre></> : null}
          </details> : null}
          {typeof window !== "undefined" && window.ohMyGameDesktop?.platform === "win32" && window.ohMyGameDesktop.captureNativeWindow && session.state === "running" && session.pid ? (
            <Button size="sm" disabled={capturing === session.id} onClick={() => void capture(session.id, session.pid!)}>
              {capturing === session.id ? t("engineObservations.capturing") : t("engineObservations.capture")}
            </Button>
          ) : null}
          {latest && !captureImages[latest.id] ? (
            <Button size="sm" variant="ghost" onClick={() => void viewCapture(latest.id)}>{t("engineObservations.viewCapture")}</Button>
          ) : null}
          {latest && captureImages[latest.id] ? (
            <figure>
              <img src={`data:image/png;base64,${captureImages[latest.id]}`} alt={t("engineObservations.captureAlt", { label: session.label })} style={{ maxWidth: "100%", height: "auto" }} />
              <figcaption>{t("engineObservations.captureHint")}</figcaption>
            </figure>
          ) : null}
        </div>;
      }) : <p>{t("engineObservations.nativeEmpty")}</p>}
      <p><strong>{t("engineObservations.compare")}</strong></p>
      {captures.length ? <>
        <div className="capture-compare-pickers">
          <label>{t("engineObservations.before")}
            <select value={before?.id ?? ""} onChange={(event) => { setLeftId(event.target.value); void viewCapture(event.target.value); }}>
              {captures.map((capture) => <option key={capture.id} value={capture.id}>{captureLabel(capture)}</option>)}
            </select>
          </label>
          <label>{t("engineObservations.after")}
            <select value={after?.id ?? ""} onChange={(event) => { setRightId(event.target.value); void viewCapture(event.target.value); }}>
              {captures.map((capture) => <option key={capture.id} value={capture.id}>{captureLabel(capture)}</option>)}
            </select>
          </label>
        </div>
        <div className="capture-compare-images">
          {[before, after].map((capture, index) => capture ? <figure key={`${index}:${capture.id}`}>
            <figcaption>{index === 0 ? t("engineObservations.before") : t("engineObservations.after")} · {capture.title}</figcaption>
            {captureImages[capture.id]
              ? <img src={`data:image/png;base64,${captureImages[capture.id]}`} alt={t("engineObservations.captureAlt", { label: capture.title })} style={{ maxWidth: "100%", height: "auto" }} />
              : <Button size="sm" variant="ghost" onClick={() => void viewCapture(capture.id)}>{t("engineObservations.viewCapture")}</Button>}
            <small>{captureProvenance(capture)}</small>
            {capture.analysis.likelyBlank ? <small>{t("engineObservations.blankCapture")}</small> : null}
            {capture.requestId ? <small>{t("engineObservations.agentRequested")}</small> : null}
          </figure> : null)}
        </div>
        <p>{t("engineObservations.compareHint")}</p>
      </> : <p>{t("engineObservations.noCaptures")}</p>}
      <p><strong>{t("engineObservations.history")}</strong></p>
      {selected ? <>
        <select aria-label={t("engineObservations.history")} value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>
          {current.checks.map((run) => <option key={run.id} value={run.id}>{run.operation} · {checkStatus(run)} · {new Date(run.startedAt).toLocaleTimeString()}</option>)}
        </select>
        <p>{t("engineObservations.sdk")}: {selected.plugin} {selected.version} · {t("engineObservations.phase")}: {selected.operation}{selected.exitCode != null ? ` · ${selected.exitCode}` : ""}</p>
        {selected.validationCopy ? <p>{t("engineObservations.mirror")}</p> : null}
        {selected.failure ? <pre>{selected.failure}</pre> : null}
        {selected.cleanupWarning ? <p>{t("engineObservations.cleanup")}: {selected.cleanupWarning}</p> : null}
        <p>{t("engineObservations.partial")}</p>
        {selected.comparison ? <p>{t("engineObservations.comparison", { newly: selected.comparison.newlyReported, recurring: selected.comparison.recurring, absent: selected.comparison.noLongerReported })}</p> : null}
        {onAskAgent ? <Button size="sm" variant="ghost" onClick={() => onAskAgent(`Inspect engine_observations for this project with runId ${selected.id}. Explain the observed findings, distinguish evidence from hypotheses, and use an explicit engine check to verify any authorized change. Do not treat absence of a reported diagnostic as proof of repair.`)}>{t("engineObservations.inspect")}</Button> : null}
        {onAskAgent && selected.status === "failed" ? <Button size="sm" onClick={() => onAskAgent("Use engine_observations with runId " + selected.id + " and includeOutput true as the before-check evidence. Inspect the reported project source, identify a specific warranted repair, and make only that bounded change. Preserve existing player saves, unrelated game content and the validation mirror. Explicitly rerun the same engine check, retrieve the new observation, compare what was newly or no longer reported, and explain the evidence and remaining uncertainty. Do not claim success from a lower count alone. If the SDK or required tool is unavailable, state the blocker. Do not launch a native game or export just to repair a lint finding.")}>{t("engineObservations.repair")}</Button> : null}
        {selected.diagnostics.length ? selected.diagnostics.map((item, index) => <div key={index}>
          <p>{severity(item.severity)}{item.path ? ` · ${item.path}:${item.line}` : ""}</p>
          <pre>{item.message}</pre>
          {item.path ? <Button size="sm" variant="ghost" onClick={() => onOpenFile(item.path!)}>{t("engineObservations.openFile")}</Button> : null}
        </div>) : <p>{t("engineObservations.noFindings")}</p>}
        {selected.outputExcerpt ? <details><summary>{t("engineObservations.raw")}</summary><p>{t("engineObservations.omitted")}</p><pre>{selected.outputExcerpt}</pre></details> : null}
      </> : <p>{t("engineObservations.empty")}</p>}
    </> : null}
  </aside>;
}
