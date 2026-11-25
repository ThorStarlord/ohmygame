import { useEffect, useState } from "react";
import type { EngineCheckStatus, EngineDiagnostic, EngineObservationSnapshot } from "../shared/engine-observations.js";
import type { NativeSessionView } from "../shared/native-sessions.js";
import { request } from "./api.js";
import { usePluginSlot } from "./project-plugin-contributions.js";
import { t } from "./i18n.js";
import { Button } from "./ui/index.js";

function checkStatus(status: EngineCheckStatus): string {
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
  async function runLint() {
    if (!lint || checking) return;
    setChecking(true);
    setCheckError(undefined);
    try { await commands.run(lint); }
    catch (cause) { setCheckError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setChecking(false); setRefresh((value) => value + 1); }
  }

  return <aside className="preview-logs" aria-label={t("engineObservations.title")} data-native-preview-overlay="">
    <header><strong>{t("engineObservations.title")}</strong>
      <Button size="sm" variant="ghost" onClick={() => setRefresh((value) => value + 1)}>{t("engineObservations.refresh")}</Button>
      <button type="button" onClick={onClose} aria-label={t("engineObservations.close")}>×</button>
    </header>
    <p>{t("engineObservations.retention")}</p>
    {lint ? <Button size="sm" disabled={checking || current?.checks.some((run) => run.operation === "lint" && run.status === "running")} onClick={() => void runLint()}>{checking ? t("engineObservations.lintBusy") : t("engineObservations.lint")}</Button> : null}
    {checkError ? <p role="alert">{checkError}</p> : null}
    {error ? <p role="alert">{t("engineObservations.unavailable")}</p> : null}
    {!current && !error ? <p role="status">{t("engineObservations.loading")}</p> : null}
    {current ? <>
      <p><strong>{t("engineObservations.preview")}</strong> · {current.preview.status}{current.preview.phase ? ` · ${current.preview.phase}` : ""}</p>
      {current.preview.error ? <pre>{current.preview.error}</pre> : null}
      {current.preview.diagnostics.map((item, index) => <details key={index}><summary>{item.kind}{item.path ? ` · ${item.path}` : ""}</summary><pre>{item.message}</pre></details>)}
      <p><strong>{t("engineObservations.native")}</strong></p>
      {current.nativeSessions.length ? current.nativeSessions.map((session) => <div key={session.id}>
        <p>{session.label} · {nativeStatus(session.state)}{session.exitCode != null ? ` · ${session.exitCode}` : ""}</p>
        {session.error ? <pre>{session.error}</pre> : null}
      </div>) : <p>{t("engineObservations.nativeEmpty")}</p>}
      <p><strong>{t("engineObservations.history")}</strong></p>
      {selected ? <>
        <select aria-label={t("engineObservations.history")} value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>
          {current.checks.map((run) => <option key={run.id} value={run.id}>{run.operation} · {checkStatus(run.status)} · {new Date(run.startedAt).toLocaleTimeString()}</option>)}
        </select>
        <p>{t("engineObservations.sdk")}: {selected.plugin} {selected.version} · {t("engineObservations.phase")}: {selected.operation}{selected.exitCode != null ? ` · ${selected.exitCode}` : ""}</p>
        {selected.validationCopy ? <p>{t("engineObservations.mirror")}</p> : null}
        {selected.failure ? <pre>{selected.failure}</pre> : null}
        {selected.cleanupWarning ? <p>{t("engineObservations.cleanup")}: {selected.cleanupWarning}</p> : null}
        <p>{t("engineObservations.partial")}</p>
        {selected.comparison ? <p>{t("engineObservations.comparison", { newly: selected.comparison.newlyReported, recurring: selected.comparison.recurring, absent: selected.comparison.noLongerReported })}</p> : null}
        {onAskAgent ? <Button size="sm" variant="ghost" onClick={() => onAskAgent(`Inspect engine_observations for this project with runId ${selected.id}. Explain the observed findings, distinguish evidence from hypotheses, and use an explicit engine check to verify any authorized change. Do not treat absence of a reported diagnostic as proof of repair.`)}>{t("engineObservations.inspect")}</Button> : null}
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
