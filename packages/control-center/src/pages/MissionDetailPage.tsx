// Mission Detail — the core screen.
//
// Rewritten in K3.5 to drop the K1 mock-driven three-pane layout.
// What lives here now is the LIVE coordination view: timeline pulled
// from `/missions/:id/timeline` (polling every 2s), a follow-up input
// that posts to the linked team-runtime thread. K4+ will reintroduce
// a work-plan / approvals pane once those have real backing data.
//
// Missions without a `threadId` are bootstrap-demo fixtures or stale
// records — they render an explanatory placeholder rather than the
// K1 fake three-pane that hardcoded MSN-1042-specific content.

import { useCallback, useMemo, useState, type ReactNode } from "react";

import type {
  ActivityEvent,
  Artifact,
  ApprovalRow,
  ContextSource,
  Mission,
  MissionObservabilitySnapshot,
  RecoveryRun,
  RecoveryRunAction,
  RoleRunState,
  ThreadSessionMemoryRecord,
  WorkerSessionRecord,
} from "../api/mission-api";
import {
  useCancelToolCalls,
  useCancelRoleRun,
  useCancelWorkerSession,
  useArchiveMission,
  useApprovals,
  useArtifacts,
  useContextSources,
  useMission,
  useMissionMetrics,
  useMissions,
  useReconcileMission,
  useRecoveryRunAction,
  useRecoveryRuns,
  useRoleRuns,
  useSendMissionMessage,
  useSessionMemory,
  useTimeline,
  useWorkerSessions,
} from "../api/useMissionData";
import { formatRelativeAgo, formatTimeOfDay } from "../util/format-time";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { StatusTag } from "../components/atoms";
import { useAppState } from "../state/AppState";
import { canUseOperatorActions, OPERATOR_ACTION_SCOPE_HINT } from "../state/scopeAccess";
import {
  formatDurationMs,
  getCancellableToolCallsForProcess,
  groupTimelineForReplay,
  type TimelineReplayItem,
  type ToolProcessItem,
} from "../state/toolReplay";
import { buildMissionProgressNow, type MissionProgressNow } from "../state/missionProgress";

type TraceFilter = "all" | "agent" | "tools" | "approvals" | "recovery" | "evidence";

const TRACE_FILTERS: Array<{ id: TraceFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "agent", label: "Agent" },
  { id: "tools", label: "Tools" },
  { id: "approvals", label: "Approvals" },
  { id: "recovery", label: "Recovery" },
  { id: "evidence", label: "Evidence" },
];

export function MissionDetailPage({ missionId }: { missionId: string }) {
  const { state, setRoute } = useAppState();
  const missions = useMissions([]);
  const archiveMission = useArchiveMission();
  const listMission = missions.value.find((m) => m.id === missionId) ?? null;
  const missionDetail = useMission(missionId, listMission, { pollIntervalMs: 2000 });
  const mission = missionDetail.value ?? listMission;
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const refetchMissions = missions.refetch;
  const refetchMissionDetail = missionDetail.refetch;
  const onMissionUpdated = useCallback(() => {
    refetchMissionDetail();
    refetchMissions();
  }, [refetchMissionDetail, refetchMissions]);
  const canArchiveMission =
    mission !== null &&
    canUseOperatorActions(state.scope) &&
    (mission.status === "done" || mission.status === "blocked");
  const onArchiveMission = useCallback(async () => {
    if (!mission || !canArchiveMission || archiving) return;
    setArchiving(true);
    setArchiveError(null);
    try {
      await archiveMission(mission.id);
      refetchMissions();
      setRoute("missions");
      window.location.hash = "#/missions";
    } catch (err) {
      setArchiveError(err instanceof Error ? err.message : String(err));
    } finally {
      setArchiving(false);
    }
  }, [archiveMission, archiving, canArchiveMission, mission, refetchMissions, setRoute]);

  if (!mission && !missions.isLive && !missionDetail.isLive) {
    return (
      <div className="page" style={{ padding: 28 }}>
        <p className="muted">Loading mission…</p>
      </div>
    );
  }

  if (!mission) {
    return (
      <div className="page" style={{ padding: 28 }}>
        <p className="muted">
          Mission <span className="mono">{missionId}</span> is no longer
          available. It may have been archived.
        </p>
        <button type="button" className="btn primary" onClick={() => setRoute("missions")}>
          ← Back to Missions
        </button>
      </div>
    );
  }

  return (
    <>
      <MissionBar
        mission={mission}
        onBack={() => setRoute("missions")}
        canArchive={canArchiveMission}
        archiving={archiving}
        archiveError={archiveError}
        onArchive={onArchiveMission}
      />
      {mission.threadId ? (
        <LiveMissionView mission={mission} onMissionUpdated={onMissionUpdated} />
      ) : (
        <UnlinkedMissionView mission={mission} />
      )}
    </>
  );
}

function MissionBar({
  mission,
  onBack,
  canArchive,
  archiving,
  archiveError,
  onArchive,
}: {
  mission: Mission;
  onBack: () => void;
  canArchive: boolean;
  archiving: boolean;
  archiveError: string | null;
  onArchive: () => void;
}) {
  return (
    <div className="mission-bar">
      <button type="button" className="btn ghost" onClick={onBack} style={{ padding: "2px 6px" }}>
        ← Missions
      </button>
      <span className="mono faint" style={{ fontSize: 10.5 }}>{mission.shortId}</span>
      <h2 style={{ marginLeft: 4 }}>{mission.title}</h2>
      <StatusTag status={mission.status} />
      <div className="meta">created {mission.createdAt} · {mission.modeLabel}</div>
      <div className="right">
        {archiveError && (
          <span role="alert" className="mono" style={{ fontSize: 10.5, color: "var(--danger)" }}>
            {archiveError}
          </span>
        )}
        <button
          type="button"
          className="btn ghost"
          disabled={!canArchive || archiving}
          onClick={onArchive}
          title={canArchive ? "Archive this terminal mission" : "Only done or blocked missions can be archived"}
        >
          {archiving ? "Archiving..." : "Archive"}
        </button>
      </div>
    </div>
  );
}

function UnlinkedMissionView({ mission }: { mission: Mission }) {
  // bootstrap-demo missions land here. They have no team-runtime
  // thread, so there's no live timeline to render. We don't fake one.
  return (
    <div className="page" style={{ padding: 28, maxWidth: 720 }}>
      <p style={{ marginTop: 0 }}>{mission.desc}</p>
      <div
        className="card"
        style={{ marginTop: 16, padding: 16, background: "var(--surface)" }}
      >
        <div className="label" style={{ fontSize: 11, marginBottom: 6 }}>
          No linked coordination thread
        </div>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
          This mission was imported via <code>POST /missions/bootstrap-demo</code>{" "}
          (design fixture) and has no live agent team attached. To run a real
          coordination, start a fresh mission with the <b>New mission</b>{" "}
          button on the Missions page.
        </div>
      </div>
    </div>
  );
}

function LiveMissionView({ mission, onMissionUpdated }: { mission: Mission; onMissionUpdated: () => void }) {
  const { state, setRoute } = useAppState();
  const canUseMissionActions = canUseOperatorActions(state.scope);
  const timeline = useTimeline(mission.id, []);
  const metrics = useMissionMetrics(mission.id, null);
  const workerSessions = useWorkerSessions(mission.threadId, []);
  const recoveryRuns = useRecoveryRuns(mission.threadId, { totalRuns: 0, runs: [] });
  const sessionMemory = useSessionMemory(mission.threadId, null);
  const roleRuns = useRoleRuns(mission.threadId, []);
  const artifacts = useArtifacts(mission.id, []);
  const contextSources = useContextSources([]);
  const approvals = useApprovals([]);
  const send = useSendMissionMessage();
  const cancelToolCalls = useCancelToolCalls();
  const cancelRoleRun = useCancelRoleRun();
  const cancelWorkerSession = useCancelWorkerSession();
  const executeRecoveryRunAction = useRecoveryRunAction();
  const reconcileMission = useReconcileMission();
  const [pending, setPending] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reconcilingMission, setReconcilingMission] = useState(false);
  const [roleRunActionKey, setRoleRunActionKey] = useState<string | null>(null);
  const [sessionActionKey, setSessionActionKey] = useState<string | null>(null);
  const [toolCallActionKey, setToolCallActionKey] = useState<string | null>(null);
  const [recoveryActionKey, setRecoveryActionKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acceptedNotice, setAcceptedNotice] = useState<string | null>(null);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [traceFilter, setTraceFilter] = useState<TraceFilter>("all");
  const replayItems = useMemo(() => groupTimelineForReplay(timeline.value), [timeline.value]);
  const traceFilterCounts = useMemo(() => buildTraceFilterCounts(replayItems), [replayItems]);
  const visibleReplayItems = useMemo(
    () => replayItems.filter((item) => traceFilterMatches(item, traceFilter)),
    [replayItems, traceFilter]
  );
  const missionApprovals = useMemo(
    () => approvals.value.filter((approval) => approval.missionId === mission.id),
    [approvals.value, mission.id]
  );
  const missionContextSources = useMemo(
    () => selectMissionContextSources(contextSources.value, timeline.value, missionApprovals),
    [contextSources.value, missionApprovals, timeline.value]
  );
  const browserContinuitySignals = useMemo(
    () => buildBrowserContinuitySignals(missionContextSources, workerSessions.value, timeline.value),
    [missionContextSources, timeline.value, workerSessions.value]
  );
  const evidenceSettled =
    (contextSources.isLive || Boolean(contextSources.error)) &&
    (artifacts.isLive || Boolean(artifacts.error)) &&
    (approvals.isLive || Boolean(approvals.error));
  const browserContinuitySettled =
    (contextSources.isLive || Boolean(contextSources.error)) &&
    (workerSessions.isLive || Boolean(workerSessions.error)) &&
    (timeline.isLive || Boolean(timeline.error));
  const toolProcessCount = replayItems.filter((item) => item.kind === "tool-process").length;
  const toolStepCount = replayItems.reduce(
    (count, item) => count + (item.kind === "tool-process" ? item.toolEvents.length : 0),
    0
  );
  const finalAnswer = latestFinalAnswer(timeline.value);
  const progressNow = useMemo(
    () =>
      buildMissionProgressNow({
        mission,
        metrics: metrics.value,
        timeline: timeline.value,
        roleRuns: roleRuns.value,
        workerSessions: workerSessions.value,
      }),
    [metrics.value, mission, roleRuns.value, timeline.value, workerSessions.value]
  );
  const { refetch: refetchTimeline } = timeline;
  const { refetch: refetchMetrics } = metrics;
  const { refetch: refetchRecoveryRuns } = recoveryRuns;
  const { refetch: refetchRoleRuns } = roleRuns;
  const { refetch: refetchWorkerSessions } = workerSessions;
  const refetchMissionRuntime = useCallback(() => {
    onMissionUpdated();
    refetchTimeline();
    refetchMetrics();
    refetchRecoveryRuns();
    refetchRoleRuns();
    refetchWorkerSessions();
  }, [onMissionUpdated, refetchMetrics, refetchRecoveryRuns, refetchRoleRuns, refetchTimeline, refetchWorkerSessions]);

  const onReconcileMission = useCallback(async () => {
    if (!canUseMissionActions || reconcilingMission) return;
    setReconcilingMission(true);
    setError(null);
    setAcceptedNotice(null);
    try {
      const result = await reconcileMission(mission.id);
      setAcceptedNotice(`Mission reconciled. Appended ${result.appended} event(s).`);
      refetchMissionRuntime();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReconcilingMission(false);
    }
  }, [canUseMissionActions, mission.id, reconcileMission, reconcilingMission, refetchMissionRuntime]);

  const onSend = useCallback(async () => {
    const content = pending.trim();
    if (!canUseMissionActions || !content || submitting) return;
    setSubmitting(true);
    setError(null);
    setAcceptedNotice(null);
    try {
      await send({ missionId: mission.id, content });
      setPending("");
      setAcceptedNotice("Follow-up accepted. The team is working; updates will appear in the timeline.");
      refetchMissionRuntime();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [canUseMissionActions, pending, submitting, send, mission.id, refetchMissionRuntime]);

  const onContinueSession = useCallback(
    async (session: WorkerSessionRecord) => {
      if (!canUseMissionActions || sessionActionKey) return;
      setSessionActionKey(session.workerRunKey);
      setError(null);
      setAcceptedNotice(null);
      try {
        await send({
          missionId: mission.id,
          content: [
            `Continue sub-agent session ${session.workerRunKey}.`,
            "Inspect its session history first, continue only the still-open work, and summarize the result for this mission.",
          ].join(" "),
        });
        setAcceptedNotice("Session follow-up accepted. The lead will continue from the stored sub-agent history.");
        refetchMissionRuntime();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSessionActionKey(null);
      }
    },
    [canUseMissionActions, mission.id, send, sessionActionKey, refetchMissionRuntime]
  );

  const onCancelRoleRun = useCallback(
    async (run: RoleRunState) => {
      if (!canUseMissionActions || roleRunActionKey) return;
      setRoleRunActionKey(run.runKey);
      setError(null);
      setAcceptedNotice(null);
      try {
        await cancelRoleRun({
          runKey: run.runKey,
          reason: "operator cancelled active role run from Mission replay",
        });
        setAcceptedNotice("Active role run cancellation requested.");
        refetchMissionRuntime();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRoleRunActionKey(null);
      }
    },
    [canUseMissionActions, cancelRoleRun, roleRunActionKey, refetchMissionRuntime]
  );

  const onCancelToolCalls = useCallback(
    async (process: ToolProcessItem) => {
      const cancellable = getCancellableToolCallsForProcess(process);
      if (!canUseMissionActions || toolCallActionKey || !cancellable) return;
      setToolCallActionKey(process.id);
      setError(null);
      setAcceptedNotice(null);
      try {
        const result = await cancelToolCalls({
          messageId: cancellable.messageId,
          threadId: mission.threadId,
          toolCallIds: cancellable.toolCallIds,
          reason: "operator cancelled active tool calls from Mission replay",
        });
        setAcceptedNotice(
          result.cancelled
            ? `Tool cancellation requested for ${result.toolCallIds.length} call${result.toolCallIds.length === 1 ? "" : "s"}.`
            : "No active tool calls remained to cancel."
        );
        refetchMissionRuntime();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setToolCallActionKey(null);
      }
    },
    [cancelToolCalls, canUseMissionActions, mission.threadId, refetchMissionRuntime, toolCallActionKey]
  );

  const onRecoveryRunAction = useCallback(
    async (run: RecoveryRun, action: Exclude<RecoveryRunAction, "dispatch">) => {
      if (!canUseMissionActions || recoveryActionKey) return;
      const actionKey = `${run.recoveryRunId}:${action}`;
      setRecoveryActionKey(actionKey);
      setError(null);
      setAcceptedNotice(null);
      try {
        await executeRecoveryRunAction({
          threadId: run.threadId,
          recoveryRunId: run.recoveryRunId,
          action,
        });
        setAcceptedNotice(`Recovery action requested: ${recoveryActionLabel(action)}.`);
        refetchMissionRuntime();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRecoveryActionKey(null);
      }
    },
    [canUseMissionActions, executeRecoveryRunAction, recoveryActionKey, refetchMissionRuntime]
  );

  const onCancelSession = useCallback(
    async (session: WorkerSessionRecord) => {
      if (!canUseMissionActions || sessionActionKey) return;
      setSessionActionKey(session.workerRunKey);
      setError(null);
      setAcceptedNotice(null);
      try {
        await cancelWorkerSession({
          workerRunKey: session.workerRunKey,
          reason: "operator cancelled sub-agent session from Mission replay",
        });
        setAcceptedNotice("Sub-agent session cancelled.");
        refetchMissionRuntime();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSessionActionKey(null);
      }
    },
    [canUseMissionActions, cancelWorkerSession, sessionActionKey, refetchMissionRuntime]
  );

  return (
    <div className="mission-shell mission-shell-single">
      <div className="mission-pane center mission-detail-pane">
        <div className="timeline-head">
          <span className="lbl label">Mission replay</span>
          <span className="mono faint" style={{ fontSize: 10.5, marginRight: 8 }}>
            {timeline.value.length} event{timeline.value.length === 1 ? "" : "s"}
          </span>
          <span className="spacer" />
          {timeline.error && (
            <span className="mono" style={{ fontSize: 10.5, color: "var(--danger)" }}>
              {timeline.error}
            </span>
          )}
        </div>
        {mission.pendingApprovals > 0 && (
          <div className="mission-approval-callout">
            <div>
              <div className="label" style={{ fontSize: 11 }}>Approval required</div>
              <div className="muted" style={{ fontSize: 11.5 }}>
                {mission.pendingApprovals} pending decision
                {mission.pendingApprovals === 1 ? "" : "s"} are blocking at least one action.
              </div>
            </div>
            <button type="button" className="btn primary" onClick={() => setRoute("approvals")}>
              <Icon name="approvals" size={13} /> Review approvals
            </button>
          </div>
        )}
        <div className="mission-detail-scroll">
          <MissionProgressNowCard progress={progressNow} />
          <ActiveRoleRunsCard
            runs={roleRuns.value}
            isLive={roleRuns.isLive}
            error={roleRuns.error}
            actionKey={roleRunActionKey}
            canAct={canUseMissionActions}
            onCancel={onCancelRoleRun}
          />
          <MissionMetricsCard
            metrics={metrics.value}
            isLive={metrics.isLive}
            error={metrics.error}
            canAct={canUseMissionActions}
            busy={reconcilingMission}
            onReconcile={onReconcileMission}
          />
          <ContextContinuityCard
            memory={sessionMemory.value}
            isLive={sessionMemory.isLive}
            error={sessionMemory.error}
          />
          <MissionRecoveryCasesCard
            response={recoveryRuns.value}
            isLive={recoveryRuns.isLive}
            error={recoveryRuns.error}
            actionKey={recoveryActionKey}
            canAct={canUseMissionActions}
            onAction={onRecoveryRunAction}
          />
          <BrowserContinuityCard
            signals={browserContinuitySignals}
            isSettled={browserContinuitySettled}
            errors={[contextSources.error, workerSessions.error, timeline.error].filter(
              (value): value is string => Boolean(value)
            )}
          />
          <SubAgentSessionsCard
            sessions={workerSessions.value}
            isLive={workerSessions.isLive}
            error={workerSessions.error}
            actionKey={sessionActionKey}
            canAct={canUseMissionActions}
            onContinue={onContinueSession}
            onCancel={onCancelSession}
          />
          <section className="card thinking-card">
            <div className="thinking-card-head">
              <div>
                <div className="label" style={{ fontSize: 11 }}>Work trace</div>
                <div className="muted" style={{ fontSize: 11.5 }}>
                  Tool calls, progress, approvals, and source-gathering steps before the answer
                </div>
              </div>
              <div className="thinking-card-meta">
                <span>{toolProcessCount} process{toolProcessCount === 1 ? "" : "es"}</span>
                <span>{toolStepCount} tool step{toolStepCount === 1 ? "" : "s"}</span>
              </div>
              <button
                type="button"
                className="btn ghost"
                aria-expanded={thinkingExpanded}
                aria-controls="thinking-record-timeline"
                onClick={() => setThinkingExpanded((value) => !value)}
              >
                {thinkingExpanded ? "Collapse trace" : "Show trace"}
              </button>
            </div>
            {!thinkingExpanded && (
              <div className="thinking-card-preview">
                {timeline.value.length === 0
                  ? timeline.isLive
                    ? "Waiting for the first agent event."
                    : "Loading activity."
                  : `${timeline.value.length} replay event${timeline.value.length === 1 ? "" : "s"} captured. Final answer remains below.`}
              </div>
            )}
            {thinkingExpanded && (
              <>
                <div className="trace-filter-bar" role="group" aria-label="Trace filters">
                  {TRACE_FILTERS.map((filter) => (
                    <button
                      key={filter.id}
                      type="button"
                      className="trace-filter-chip"
                      data-active={traceFilter === filter.id}
                      aria-pressed={traceFilter === filter.id}
                      onClick={() => setTraceFilter(filter.id)}
                    >
                      <span>{filter.label}</span>
                      <span className="mono">{traceFilterCounts[filter.id]}</span>
                    </button>
                  ))}
                  <span className="spacer" />
                  <button
                    type="button"
                    className="trace-filter-chip"
                    disabled={!timeline.hasMore || timeline.isLoadingOlder}
                    onClick={timeline.loadOlder}
                  >
                    <span>{timeline.isLoadingOlder ? "Loading older" : "Load older"}</span>
                  </button>
                </div>
                {timeline.olderError && (
                  <div className="inline-error">
                    {timeline.olderError}
                  </div>
                )}
                <div id="thinking-record-timeline" className="timeline">
                {timeline.value.length === 0 ? (
                  <div className="muted" style={{ padding: 28, textAlign: "center", fontSize: 11.5 }}>
                    {timeline.isLive
                      ? "No activity yet. Agents will reply here as they work — the timeline refreshes every 2 seconds."
                      : "Loading activity…"}
                  </div>
                ) : visibleReplayItems.length === 0 ? (
                  <div className="muted" style={{ padding: 28, textAlign: "center", fontSize: 11.5 }}>
                    No trace entries match this filter.
                  </div>
                ) : (
                  visibleReplayItems.map((item) =>
                    item.kind === "event" ? (
                      <LiveTimelineRow key={item.event.id} event={item.event} />
                    ) : (
                      <ToolProcessRow
                        key={item.id}
                        process={item}
                        workerSessions={workerSessions.value}
                        actionKey={sessionActionKey}
                        toolCallActionKey={toolCallActionKey}
                        canAct={canUseMissionActions}
                        onContinue={onContinueSession}
                        onCancel={onCancelSession}
                        onCancelToolCalls={onCancelToolCalls}
                      />
                    )
                  )
                )}
              </div>
              </>
            )}
          </section>
          <MissionEvidenceCard
            contextSources={missionContextSources}
            artifacts={artifacts.value}
            approvals={missionApprovals}
            isSettled={evidenceSettled}
            errors={[contextSources.error, artifacts.error, approvals.error].filter(
              (value): value is string => Boolean(value)
            )}
          />
          {finalAnswer && (
            <section className="card final-answer-card">
              <div className="label" style={{ fontSize: 11, marginBottom: 8 }}>
                Final answer
              </div>
              <Markdown text={finalAnswer.text} />
            </section>
          )}
        </div>
        <div className="row mission-follow-up-bar">
          <textarea
            aria-label="Follow-up message to mission team"
            value={pending}
            onChange={(e) => {
              setPending(e.target.value);
              if (acceptedNotice) setAcceptedNotice(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void onSend();
              }
            }}
            placeholder="Follow up with the team… (⌘↩ to send)"
            rows={2}
            disabled={submitting || !canUseMissionActions}
            title={canUseMissionActions ? undefined : OPERATOR_ACTION_SCOPE_HINT}
            className="mission-follow-up-input"
          />
          <button
            type="button"
            className="btn primary"
            disabled={submitting || pending.trim().length === 0 || !canUseMissionActions}
            onClick={onSend}
            title={canUseMissionActions ? undefined : OPERATOR_ACTION_SCOPE_HINT}
          >
            <Icon name="send" size={13} /> {submitting ? "Sending…" : "Send"}
          </button>
        </div>
        {error && (
          <div role="alert" style={{ padding: "6px 12px", color: "var(--danger)", fontSize: 11.5 }}>
            {error}
          </div>
        )}
        {acceptedNotice && !error && (
          <div
            role="status"
            aria-live="polite"
            style={{ padding: "6px 12px", color: "var(--muted)", fontSize: 11.5 }}
          >
            {acceptedNotice}
          </div>
        )}
      </div>
    </div>
  );
}

function MissionProgressNowCard({ progress }: { progress: MissionProgressNow }) {
  return (
    <section className="card mission-progress-card" data-tone={progress.tone}>
      <div className="mission-progress-main">
        <div>
          <div className="label" style={{ fontSize: 11 }}>Mission now</div>
          <h3>{progress.title}</h3>
        </div>
        <div className="mission-progress-meta">
          {progress.meta.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      </div>
      <div className="mission-progress-detail">{progress.detail}</div>
      <div className="mission-progress-grid">
        <MissionProgressLine
          label="Latest event"
          value={progress.latestEvent ? progress.latestEvent.label : "Waiting for replay"}
          detail={progress.latestEvent?.text}
        />
        <MissionProgressLine
          label="Latest tool"
          value={progress.latestTool ? `${progress.latestTool.name} · ${progress.latestTool.phase}` : "No tool step yet"}
          detail={progress.latestTool?.text}
        />
      </div>
    </section>
  );
}

function MissionProgressLine({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="mission-progress-line">
      <span>{label}</span>
      <b>{value}</b>
      {detail && <p>{detail}</p>}
    </div>
  );
}

function ContextContinuityCard({
  memory,
  isLive,
  error,
}: {
  memory: ThreadSessionMemoryRecord | null;
  isLive: boolean;
  error: string | null;
}) {
  const totalItems = memory
    ? memory.activeTasks.length +
      memory.openQuestions.length +
      memory.recentDecisions.length +
      memory.constraints.length +
      memory.continuityNotes.length +
      memory.latestJournalEntries.length
    : 0;
  return (
    <section className="card context-continuity-card">
      <div className="subagent-session-head">
        <div>
          <div className="label" style={{ fontSize: 11 }}>Context continuity</div>
          <div className="muted" style={{ fontSize: 11.5 }}>
            Pending work, open questions, decisions, and carry-forward notes retained for re-entry
          </div>
        </div>
        <div className="thinking-card-meta">
          <span>{memory?.activeTasks.length ?? 0} active</span>
          <span>{memory?.openQuestions.length ?? 0} open</span>
          <span>{memory?.continuityNotes.length ?? 0} continuity</span>
          {memory?.memoryVersion != null && <span>v{memory.memoryVersion}</span>}
        </div>
      </div>
      {error && (
        <div className="subagent-session-error" role="alert">
          {error}
        </div>
      )}
      {!memory ? (
        <div className="subagent-session-empty">
          {isLive ? "No session memory has been written for this mission yet." : "Loading context continuity…"}
        </div>
      ) : totalItems === 0 ? (
        <div className="subagent-session-empty">
          Session memory exists but has no active tasks, open questions, decisions, constraints, or continuity notes.
        </div>
      ) : (
        <>
          <div className="context-continuity-grid">
            <ContextContinuityColumn title="Active work" items={memory.activeTasks} empty="No active work carried forward." />
            <ContextContinuityColumn title="Open questions" items={memory.openQuestions} empty="No open questions." />
            <ContextContinuityColumn title="Continuity notes" items={memory.continuityNotes} empty="No continuity notes." />
            <ContextContinuityColumn title="Decisions" items={memory.recentDecisions} empty="No recent decisions." />
            <ContextContinuityColumn title="Constraints" items={memory.constraints} empty="No constraints." />
            <ContextContinuityColumn title="Journal" items={memory.latestJournalEntries} empty="No recent journal entries." />
          </div>
          <div className="context-continuity-footer">
            <span className="mono">thread {memory.threadId}</span>
            {memory.sourceMessageCount != null && <span>{memory.sourceMessageCount} source messages</span>}
            <span>updated {formatRelativeAgo(memory.updatedAt)}</span>
            {memory.sectionFingerprint && <span className="mono">fp {memory.sectionFingerprint}</span>}
          </div>
        </>
      )}
    </section>
  );
}

function ContextContinuityColumn({
  title,
  items,
  empty,
}: {
  title: string;
  items: string[];
  empty: string;
}) {
  return (
    <div className="context-continuity-column">
      <div className="context-continuity-column-head">
        <span>{title}</span>
        <span className="mono">{items.length}</span>
      </div>
      <div className="context-continuity-list">
        {items.length === 0 ? (
          <div className="context-continuity-empty">{empty}</div>
        ) : (
          items.slice(0, 3).map((item, index) => (
            <div key={`${title}:${index}:${item}`} className="context-continuity-item">
              {item}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function MissionRecoveryCasesCard({
  response,
  isLive,
  error,
  actionKey,
  canAct,
  onAction,
}: {
  response: { totalRuns: number; runs: RecoveryRun[] };
  isLive: boolean;
  error: string | null;
  actionKey: string | null;
  canAct: boolean;
  onAction: (run: RecoveryRun, action: Exclude<RecoveryRunAction, "dispatch">) => void;
}) {
  const runs = response.runs;
  const attentionCount = runs.filter((run) => recoveryRunNeedsAttention(run)).length;
  const recoveringCount = runs.filter((run) => recoveryRunIsRecovering(run.status)).length;
  const recoveredCount = runs.filter((run) => run.status === "recovered").length;
  return (
    <section className="card mission-recovery-card">
      <div className="subagent-session-head">
        <div>
          <div className="label" style={{ fontSize: 11 }}>Recovery cases</div>
          <div className="muted" style={{ fontSize: 11.5 }}>
            Runtime recovery gates, next actions, and browser resume outcomes for this mission
          </div>
        </div>
        <div className="thinking-card-meta">
          <span>{attentionCount} attention</span>
          <span>{recoveringCount} recovering</span>
          <span>{recoveredCount} recovered</span>
          {response.totalRuns > runs.length && <span>{response.totalRuns} total</span>}
        </div>
      </div>
      {!canAct && runs.some((run) => listOperatorRecoveryActions(run.status).length > 0) && (
        <div className="subagent-session-error" role="note">
          Recovery actions require an operator or admin token.
        </div>
      )}
      {error && (
        <div className="subagent-session-error" role="alert">
          {error}
        </div>
      )}
      {runs.length === 0 ? (
        <div className="subagent-session-empty">
          {isLive ? "No recovery cases for this mission." : "Loading recovery cases…"}
        </div>
      ) : (
        <div className="mission-recovery-list">
          {runs.map((run) => (
            <MissionRecoveryCaseRow
              key={run.recoveryRunId}
              run={run}
              actionKey={actionKey}
              canAct={canAct}
              onAction={onAction}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function MissionRecoveryCaseRow({
  run,
  actionKey,
  canAct,
  onAction,
}: {
  run: RecoveryRun;
  actionKey: string | null;
  canAct: boolean;
  onAction: (run: RecoveryRun, action: Exclude<RecoveryRunAction, "dispatch">) => void;
}) {
  const tone = recoveryRunTone(run);
  const latestAttempt = run.attempts.find((attempt) => attempt.attemptId === run.currentAttemptId) ?? run.attempts.at(-1);
  const browserSession = latestAttempt?.browserSession ?? run.browserSession;
  const failure = latestAttempt?.failure ?? run.latestFailure;
  const browserOutcome = latestAttempt?.browserOutcome;
  const browserOutcomeSummary = latestAttempt?.browserOutcomeSummary;
  const gate = describeRecoveryGate(run.status);
  const actions = listOperatorRecoveryActions(run.status);
  return (
    <div className="mission-recovery-row" data-tone={tone}>
      <div className="mission-recovery-main">
        <span className="mission-recovery-status">{statusLabel(run.status)}</span>
        <span className="mission-recovery-title">{run.latestSummary || run.sourceGroupId}</span>
        {run.requiresManualIntervention && <span className="mission-recovery-gate">manual gate</span>}
      </div>
      <div className="mission-recovery-detail">
        <span>{gate}</span>
        {run.nextAction && run.nextAction !== "none" && <span>next: {run.nextAction}</span>}
        {run.waitingReason && <span>{run.waitingReason}</span>}
      </div>
      <div className="mission-recovery-meta">
        <span className="mono">{run.recoveryRunId}</span>
        <span>{run.targetWorker ?? "unknown worker"}</span>
        <span>{run.targetLayer ?? "unknown layer"}</span>
        <span>{run.attempts.length} attempt{run.attempts.length === 1 ? "" : "s"}</span>
        <span>updated {formatRelativeAgo(run.updatedAt)}</span>
        {run.confirmed === false && <span>inferred</span>}
      </div>
      {(browserSession || browserOutcome || browserOutcomeSummary || failure) && (
        <div className="mission-recovery-runtime">
          {browserSession?.sessionId && <span className="mono">session {browserSession.sessionId}</span>}
          {browserSession?.targetId && <span className="mono">target {browserSession.targetId}</span>}
          {browserSession?.resumeMode && <span>{browserSession.resumeMode}</span>}
          {browserOutcome && <span>{browserOutcome}</span>}
          {browserOutcomeSummary && <span>{browserOutcomeSummary}</span>}
          {failure?.category && <span>{failure.category}</span>}
          {failure?.message && <span>{failure.message}</span>}
          {failure?.recommendedAction && <span>recommend: {failure.recommendedAction}</span>}
        </div>
      )}
      {actions.length > 0 && (
        <div className="mission-recovery-actions">
          {actions.map((action) => {
            const key = `${run.recoveryRunId}:${action}`;
            const busy = actionKey === key;
            const blocked = actionKey !== null && !busy;
            const disabled = !canAct || busy || blocked;
            return (
              <button
                key={action}
                type="button"
                className={`btn ${action === "approve" || action === "retry" || action === "resume" ? "primary" : "ghost"}`}
                disabled={disabled}
                onClick={() => onAction(run, action)}
                title={canAct ? undefined : OPERATOR_ACTION_SCOPE_HINT}
              >
                {busy ? "Requesting…" : recoveryActionLabel(action)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function listOperatorRecoveryActions(status: RecoveryRun["status"]): Array<Exclude<RecoveryRunAction, "dispatch">> {
  switch (status) {
    case "waiting_approval":
      return ["approve", "reject"];
    case "planned":
    case "waiting_external":
    case "superseded":
    case "failed":
      return ["retry", "fallback", "resume", "reject"];
    case "running":
    case "retrying":
    case "fallback_running":
    case "resumed":
      return ["reject"];
    case "recovered":
    case "aborted":
    default:
      return [];
  }
}

function recoveryActionLabel(action: Exclude<RecoveryRunAction, "dispatch">): string {
  switch (action) {
    case "approve":
      return "Approve recovery";
    case "reject":
      return "Reject";
    case "retry":
      return "Retry";
    case "fallback":
      return "Fallback";
    case "resume":
      return "Resume";
  }
}

function recoveryRunNeedsAttention(run: RecoveryRun): boolean {
  return run.requiresManualIntervention || run.status === "failed" || run.status === "waiting_approval" || run.status === "waiting_external";
}

function recoveryRunIsRecovering(status: RecoveryRun["status"]): boolean {
  return status === "running" || status === "retrying" || status === "fallback_running" || status === "resumed" || status === "superseded";
}

function recoveryRunTone(run: RecoveryRun): "ok" | "warning" | "danger" | "muted" {
  if (run.status === "recovered") return "ok";
  if (run.status === "failed" || run.status === "aborted") return "danger";
  if (recoveryRunNeedsAttention(run) || recoveryRunIsRecovering(run.status)) return "warning";
  return "muted";
}

function describeRecoveryGate(status: RecoveryRun["status"]): string {
  switch (status) {
    case "waiting_approval":
      return "waiting for approval";
    case "waiting_external":
      return "waiting for external/manual follow-up";
    case "retrying":
      return "retrying same layer";
    case "fallback_running":
      return "running fallback transport";
    case "resumed":
      return "resuming existing session";
    case "running":
      return "dispatch in progress";
    case "recovered":
      return "recovered";
    case "failed":
      return "failed and awaiting next recovery action";
    case "aborted":
      return "aborted";
    case "superseded":
      return "superseded by a newer recovery attempt";
    case "planned":
    default:
      return "planned";
  }
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

function MissionEvidenceCard({
  contextSources,
  artifacts,
  approvals,
  isSettled,
  errors,
}: {
  contextSources: ContextSource[];
  artifacts: Artifact[];
  approvals: ApprovalRow[];
  isSettled: boolean;
  errors: string[];
}) {
  const pendingApprovals = approvals.filter((approval) => !approval.decision).length;
  const decidedApprovals = approvals.length - pendingApprovals;
  return (
    <section className="card mission-evidence-card">
      <div className="subagent-session-head">
        <div>
          <div className="label" style={{ fontSize: 11 }}>Mission evidence</div>
          <div className="muted" style={{ fontSize: 11.5 }}>
            Context, artifacts, and approval decisions linked to this mission
          </div>
        </div>
        <div className="thinking-card-meta">
          <span>{contextSources.length} context</span>
          <span>{artifacts.length} artifact{artifacts.length === 1 ? "" : "s"}</span>
          <span>{pendingApprovals} pending</span>
          {decidedApprovals > 0 && <span>{decidedApprovals} decided</span>}
        </div>
      </div>
      {errors.map((error) => (
        <div key={error} className="subagent-session-error" role="alert">
          {error}
        </div>
      ))}
      {!isSettled && contextSources.length === 0 && artifacts.length === 0 && approvals.length === 0 ? (
        <div className="subagent-session-empty">Loading mission evidence…</div>
      ) : contextSources.length === 0 && artifacts.length === 0 && approvals.length === 0 ? (
        <div className="subagent-session-empty">
          No linked context sources, artifacts, or approvals have been recorded yet.
        </div>
      ) : (
        <div className="mission-evidence-grid">
          <EvidenceColumn title="Context sources" count={contextSources.length}>
            {contextSources.length === 0 ? (
              <EmptyEvidenceLine text="No context sources referenced yet." />
            ) : (
              contextSources.slice(0, 4).map((source) => (
                <ContextSourceLine key={source.id} source={source} />
              ))
            )}
          </EvidenceColumn>
          <EvidenceColumn title="Artifacts" count={artifacts.length}>
            {artifacts.length === 0 ? (
              <EmptyEvidenceLine text="No artifacts saved yet." />
            ) : (
              artifacts.slice(0, 4).map((artifact) => (
                <ArtifactLine key={artifact.id} artifact={artifact} />
              ))
            )}
          </EvidenceColumn>
          <EvidenceColumn title="Approvals" count={approvals.length}>
            {approvals.length === 0 ? (
              <EmptyEvidenceLine text="No approval decisions for this mission." />
            ) : (
              approvals.slice(0, 4).map((approval) => (
                <ApprovalLine key={approval.id} approval={approval} />
              ))
            )}
          </EvidenceColumn>
        </div>
      )}
    </section>
  );
}

function EvidenceColumn({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div className="mission-evidence-column">
      <div className="mission-evidence-column-head">
        <span>{title}</span>
        <span className="mono">{count}</span>
      </div>
      <div className="mission-evidence-list">{children}</div>
    </div>
  );
}

function EmptyEvidenceLine({ text }: { text: string }) {
  return <div className="mission-evidence-empty">{text}</div>;
}

function ContextSourceLine({ source }: { source: ContextSource }) {
  return (
    <div className="mission-evidence-line">
      <div className="mission-evidence-line-main">
        <span className="mission-evidence-kind">{source.kind}</span>
        <span>{source.title}</span>
      </div>
      <div className="mission-evidence-line-meta">
        <span>{source.state}</span>
        {source.transport && <span>{source.transport}</span>}
        {source.session && <span className="mono">{source.session}</span>}
      </div>
    </div>
  );
}

function ArtifactLine({ artifact }: { artifact: Artifact }) {
  return (
    <div className="mission-evidence-line">
      <div className="mission-evidence-line-main">
        <span className="mission-evidence-kind">{artifact.kind}</span>
        <span>{artifact.label}</span>
      </div>
      <div className="mission-evidence-line-meta">
        <span className="mono">{artifact.id}</span>
        {typeof artifact.sizeBytes === "number" && <span>{formatBytes(artifact.sizeBytes)}</span>}
      </div>
    </div>
  );
}

function ApprovalLine({ approval }: { approval: ApprovalRow }) {
  const status = approval.decision?.decision ?? "pending";
  return (
    <div className="mission-evidence-line" data-status={status}>
      <div className="mission-evidence-line-main">
        <span className="mission-evidence-kind">{approval.severity}</span>
        <span>{approval.title}</span>
      </div>
      <div className="mission-evidence-line-meta">
        <span>{approval.action}</span>
        <span>{status}</span>
      </div>
    </div>
  );
}

function selectMissionContextSources(
  sources: ContextSource[],
  timeline: ActivityEvent[],
  approvals: ApprovalRow[]
): ContextSource[] {
  const referencedIds = new Set<string>();
  for (const event of timeline) {
    if (event.target?.trim()) referencedIds.add(event.target.trim());
  }
  for (const approval of approvals) {
    for (const affected of approval.affects) {
      if (affected.trim()) referencedIds.add(affected.trim());
    }
  }
  const selected = sources.filter((source) => referencedIds.has(source.id));
  if (selected.length > 0) return selected;
  return sources.slice(0, 4);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} kB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

type BrowserContinuitySignal = {
  key: string;
  source: "context" | "worker" | "timeline";
  title: string;
  state: string;
  detail: string;
  sessionId?: string;
  targetId?: string;
  transport?: string;
  resumeMode?: string;
  targetResolution?: string;
  tone: "ok" | "warning" | "danger" | "muted";
};

function BrowserContinuityCard({
  signals,
  isSettled,
  errors,
}: {
  signals: BrowserContinuitySignal[];
  isSettled: boolean;
  errors: string[];
}) {
  const detachedCount = signals.filter((signal) => isDetachedBrowserState(signal.state)).length;
  const reconnectCount = signals.filter(
    (signal) =>
      signal.resumeMode === "cold" ||
      signal.targetResolution === "reconnect" ||
      signal.targetResolution === "reopen" ||
      signal.state === "reconnecting"
  ).length;
  const activeCount = signals.filter((signal) => signal.tone === "ok").length;
  return (
    <section className="card browser-continuity-card">
      <div className="subagent-session-head">
        <div>
          <div className="label" style={{ fontSize: 11 }}>Browser continuity</div>
          <div className="muted" style={{ fontSize: 11.5 }}>
            Session state, target reuse, and reconnect/reopen signals visible to the operator
          </div>
        </div>
        <div className="thinking-card-meta">
          <span>{activeCount} active</span>
          <span>{detachedCount} detached</span>
          <span>{reconnectCount} reconnect/reopen</span>
        </div>
      </div>
      {errors.map((error) => (
        <div key={error} className="subagent-session-error" role="alert">
          {error}
        </div>
      ))}
      {signals.length === 0 ? (
        <div className="subagent-session-empty">
          {isSettled ? "No browser continuity signals for this mission yet." : "Loading browser continuity…"}
        </div>
      ) : (
        <div className="browser-continuity-list">
          {signals.slice(0, 6).map((signal) => (
            <BrowserContinuityRow key={signal.key} signal={signal} />
          ))}
        </div>
      )}
    </section>
  );
}

function BrowserContinuityRow({ signal }: { signal: BrowserContinuitySignal }) {
  return (
    <div className="browser-continuity-row" data-tone={signal.tone}>
      <div className="browser-continuity-main">
        <span className="browser-continuity-kind">{signal.source}</span>
        <span>{signal.title}</span>
        <span className="mono">{signal.state}</span>
      </div>
      <div className="browser-continuity-detail">{signal.detail}</div>
      <div className="browser-continuity-meta">
        {signal.sessionId && <span className="mono">session {signal.sessionId}</span>}
        {signal.targetId && <span className="mono">target {signal.targetId}</span>}
        {signal.transport && <span>{signal.transport}</span>}
        {signal.resumeMode && <span>{signal.resumeMode}</span>}
        {signal.targetResolution && <span>{signal.targetResolution}</span>}
      </div>
    </div>
  );
}

function buildBrowserContinuitySignals(
  contextSources: ContextSource[],
  workerSessions: WorkerSessionRecord[],
  timeline: ActivityEvent[]
): BrowserContinuitySignal[] {
  const signals: BrowserContinuitySignal[] = [];
  const seen = new Set<string>();
  for (const source of contextSources) {
    if (source.kind !== "browser") continue;
    const key = `context:${source.id}`;
    seen.add(key);
    signals.push({
      key,
      source: "context",
      title: source.title,
      state: source.state || "unknown",
      detail: source.url ? `Current browser context at ${source.url}` : "Live browser context surfaced by the daemon.",
      ...(source.session ? { sessionId: source.session } : {}),
      ...(source.transport ? { transport: source.transport } : {}),
      tone: browserContinuityTone(source.state),
    });
  }

  for (const session of workerSessions) {
    if (session.state.workerType !== "browser") continue;
    const payload = isRecord(session.state.lastResult?.payload) ? session.state.lastResult.payload : null;
    const sessionId = stringField(payload, "sessionId") ?? stringField(payload, "browserSessionId");
    const targetId = stringField(payload, "targetId");
    const resumeMode = stringField(payload, "resumeMode");
    const targetResolution = stringField(payload, "targetResolution");
    const transport = stringField(payload, "transportLabel");
    const key = `worker:${session.workerRunKey}`;
    seen.add(key);
    signals.push({
      key,
      source: "worker",
      title: session.context?.label?.trim() || session.workerRunKey,
      state: session.state.status,
      detail: session.state.lastResult?.summary ?? session.state.continuationDigest?.summary ?? "Browser worker has no result summary yet.",
      ...(sessionId ? { sessionId } : {}),
      ...(targetId ? { targetId } : {}),
      ...(transport ? { transport } : {}),
      ...(resumeMode ? { resumeMode } : {}),
      ...(targetResolution ? { targetResolution } : {}),
      tone: browserContinuityTone(session.state.status, targetResolution),
    });
  }

  for (const event of timeline) {
    const runtime = event.runtime ?? {};
    const sessionId = runtime.browserSessionId ?? runtime.sessionId;
    const targetId = runtime.browserTargetId ?? runtime.targetId;
    const targetResolution = runtime.targetResolution;
    const resumeMode = runtime.resumeMode;
    const diagnosticBucket = runtime.browserDiagnosticBucket ?? runtime.closeKind;
    if (!sessionId && !targetId && !targetResolution && !resumeMode && !diagnosticBucket) continue;
    const key = `timeline:${event.id}`;
    if (seen.has(key)) continue;
    signals.push({
      key,
      source: "timeline",
      title: event.actor,
      state: diagnosticBucket ?? targetResolution ?? resumeMode ?? event.kind,
      detail: stripTags(event.text),
      ...(sessionId ? { sessionId } : {}),
      ...(targetId ? { targetId } : {}),
      ...(runtime.transport ? { transport: runtime.transport } : {}),
      ...(resumeMode ? { resumeMode } : {}),
      ...(targetResolution ? { targetResolution } : {}),
      tone: browserContinuityTone(diagnosticBucket ?? targetResolution ?? resumeMode ?? event.kind, targetResolution),
    });
  }

  return signals.sort((left, right) => browserSignalRank(left) - browserSignalRank(right)).slice(0, 8);
}

function browserSignalRank(signal: BrowserContinuitySignal): number {
  const toneRank = signal.tone === "danger" ? 0 : signal.tone === "warning" ? 1 : signal.tone === "ok" ? 2 : 3;
  const sourceRank = signal.source === "timeline" ? 0 : signal.source === "worker" ? 1 : 2;
  return toneRank * 10 + sourceRank;
}

function browserContinuityTone(state: string | undefined, targetResolution?: string): BrowserContinuitySignal["tone"] {
  const blob = `${state ?? ""} ${targetResolution ?? ""}`.toLowerCase();
  if (/\b(failed|cancelled|closed|owner_mismatch|unknown|terminal)\b/.test(blob)) return "danger";
  if (/\b(detached|reconnecting|reconnect|reopen|cold|timeout|lease_conflict|transport_failure|resumable)\b/.test(blob)) {
    return "warning";
  }
  if (/\b(attached|ready|busy|running|done|completed|resolved|hot|send|spawn)\b/.test(blob)) return "ok";
  return "muted";
}

function isDetachedBrowserState(state: string): boolean {
  return /\b(detached|disconnected|reconnecting|reconnect|reopen|cold|resumable)\b/i.test(state);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "").trim();
}

function MissionMetricsCard({
  metrics,
  isLive,
  error,
  canAct,
  busy,
  onReconcile,
}: {
  metrics: MissionObservabilitySnapshot | null;
  isLive: boolean;
  error: string | null;
  canAct: boolean;
  busy: boolean;
  onReconcile: () => void;
}) {
  const qualityLabel = metrics ? qualityStatusLabel(metrics.qualityGate.status) : isLive ? "No data" : "Loading";
  const qualityEmph =
    metrics?.qualityGate.status === "blocked"
      ? "danger"
      : metrics?.qualityGate.status === "needs_attention"
        ? "warn"
        : metrics?.qualityGate.status === "passed"
          ? "success"
          : undefined;
  return (
    <section className="card mission-metrics-card">
      <div className="subagent-session-head">
        <div>
          <div className="label" style={{ fontSize: 11 }}>Mission health</div>
          <div className="muted" style={{ fontSize: 11.5 }}>
            Runtime position, tool execution, and answer quality signals
          </div>
        </div>
        <div className="mission-quality-pill" data-emph={qualityEmph}>
          {qualityLabel}
        </div>
      </div>
      {error && (
        <div className="subagent-session-error" role="alert">
          {error}
        </div>
      )}
      {!metrics ? (
        <div className="subagent-session-empty">
          {isLive ? "No mission metrics are available yet." : "Loading mission metrics…"}
        </div>
      ) : (
        <>
          <MissionQualityActionPanel
            metrics={metrics}
            canAct={canAct}
            busy={busy}
            onReconcile={onReconcile}
          />
          <div className="mission-metrics-grid">
            <MetricTile label="wall clock" value={formatDurationMs(0, metrics.wallClockMs)} />
            <MetricTile label="events" value={String(metrics.timelineEventCount)} />
            <MetricTile label="tool calls" value={`${metrics.tool.requested}/${metrics.tool.results}`} />
            <MetricTile label="sessions" value={`${metrics.sessions.spawned} spawned · ${metrics.sessions.continued} continued`} />
            <MetricTile label="skipped" value={String(metrics.tool.skipped)} tone={metrics.tool.skipped > 0 ? "warn" : undefined} />
            <MetricTile label="timeouts" value={String(metrics.tool.timeouts)} tone={metrics.tool.timeouts > 0 ? "warn" : undefined} />
            <MetricTile label="failed" value={String(metrics.tool.failed)} tone={metrics.tool.failed > 0 ? "danger" : undefined} />
            <MetricTile
              label="runtime"
              value={`${metrics.liveness.active} active · ${metrics.liveness.waiting} waiting`}
              tone={metrics.liveness.stale > 0 ? "danger" : undefined}
            />
            <MetricTile label="stale" value={String(metrics.liveness.stale)} tone={metrics.liveness.stale > 0 ? "danger" : undefined} />
            <MetricTile label="evidence" value={String(metrics.qualityGate.evidenceEvents)} />
          </div>
          {metrics.liveness.staleSubjects.length > 0 && (
            <div className="mission-liveness-alert" role="alert">
              {metrics.liveness.staleSubjects.slice(0, 3).map((subject) => (
                <div key={`${subject.subjectKind}:${subject.subjectId}`}>
                  <span className="mono">{subject.subjectKind}</span>
                  <span>{subject.summary}</span>
                  <span className="mono">{formatDurationMs(0, subject.overdueMs)} overdue</span>
                </div>
              ))}
            </div>
          )}
          <div className="mission-quality-checks">
            {metrics.qualityGate.checks.map((check) => (
              <div key={check.name} className="mission-quality-check" data-status={check.status} title={check.detail}>
                <span>{check.name.replace("_", " ")}</span>
                <span>{check.status}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function MissionQualityActionPanel({
  metrics,
  canAct,
  busy,
  onReconcile,
}: {
  metrics: MissionObservabilitySnapshot;
  canAct: boolean;
  busy: boolean;
  onReconcile: () => void;
}) {
  const visibleChecks = metrics.qualityGate.checks.filter(
    (check) => check.status === "fail" || check.status === "warn"
  );
  if (visibleChecks.length === 0 && metrics.qualityGate.status === "passed") {
    return null;
  }
  const action = missionQualityAction(metrics, visibleChecks);
  return (
    <div className="mission-quality-action-panel" data-status={metrics.qualityGate.status}>
      <div className="mission-quality-action-head">
        <span>{metrics.qualityGate.status === "running" ? "Still running" : "Attention points"}</span>
        <span>{action}</span>
        <button
          type="button"
          className="btn"
          disabled={!canAct || busy}
          onClick={onReconcile}
          title={canAct ? "Force a mission/thread mirror pass now." : OPERATOR_ACTION_SCOPE_HINT}
        >
          <Icon name="refresh" size={13} /> {busy ? "Reconciling…" : "Reconcile"}
        </button>
      </div>
      {visibleChecks.length > 0 ? (
        <div className="mission-quality-action-list">
          {visibleChecks.map((check) => (
            <div key={check.name} className="mission-quality-action-line" data-status={check.status}>
              <span>{check.name.replace("_", " ")}</span>
              <span>{check.detail}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mission-quality-action-empty">
          Waiting for a final answer, evidence, and runtime closeout.
        </div>
      )}
    </div>
  );
}

function MetricTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warn" | "danger";
}) {
  return (
    <div className="mission-metric-tile" data-tone={tone}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function missionQualityAction(
  metrics: MissionObservabilitySnapshot,
  visibleChecks: MissionObservabilitySnapshot["qualityGate"]["checks"]
): string {
  if (metrics.liveness.stale > 0) {
    return "Inspect stale runs, then cancel or continue from the stored session.";
  }
  if (metrics.tool.timeouts > 0 || visibleChecks.some((check) => check.name === "failure_free")) {
    return "Open the trace, use the tool result or recovery event, then continue with bounded scope.";
  }
  if (visibleChecks.some((check) => check.name === "final_answer")) {
    return "Continue the mission so the lead can synthesize a final answer.";
  }
  if (visibleChecks.some((check) => check.name === "evidence_backed")) {
    return "Ask a follow-up that gathers source evidence before synthesis.";
  }
  if (visibleChecks.some((check) => check.name === "evidence_usage")) {
    return "Ask a follow-up to tie each claim to the captured evidence.";
  }
  if (visibleChecks.some((check) => check.name === "tool_fallback_answer")) {
    return "Continue with a narrower tool-backed request or inspect tool availability before accepting the answer.";
  }
  if (visibleChecks.some((check) => check.name === "answer_substance")) {
    return "Ask a follow-up for a fuller answer with concrete findings and next steps.";
  }
  if (visibleChecks.some((check) => check.name === "unsupported_uncertainty")) {
    return "Ask a follow-up to replace placeholders with verified facts or explicit residual risk.";
  }
  if (visibleChecks.some((check) => check.name === "residual_risk")) {
    return "Ask a follow-up to name residual risk or unverified scope.";
  }
  if (metrics.qualityGate.status === "running") {
    return "Wait for active tool and session progress, or cancel stale work.";
  }
  return "Review the trace and continue with a narrower follow-up.";
}

function qualityStatusLabel(status: MissionObservabilitySnapshot["qualityGate"]["status"]): string {
  switch (status) {
    case "passed":
      return "Quality passed";
    case "needs_attention":
      return "Needs attention";
    case "blocked":
      return "Blocked";
    case "running":
      return "Running";
  }
}

function ActiveRoleRunsCard({
  runs,
  isLive,
  error,
  actionKey,
  canAct,
  onCancel,
}: {
  runs: RoleRunState[];
  isLive: boolean;
  error: string | null;
  actionKey: string | null;
  canAct: boolean;
  onCancel: (run: RoleRunState) => void;
}) {
  const visibleRuns = runs.filter((run) => !["done", "failed", "idle"].includes(run.status));
  const cancellableCount = visibleRuns.filter(isCancellableRoleRun).length;
  return (
    <section className="card subagent-session-card role-run-card">
      <div className="subagent-session-head">
        <div>
          <div className="label" style={{ fontSize: 11 }}>Active role runs</div>
          <div className="muted" style={{ fontSize: 11.5 }}>
            Lead and member runs currently coordinating this mission
          </div>
        </div>
        <div className="thinking-card-meta">
          <span>{visibleRuns.length} active</span>
          <span>{cancellableCount} cancellable</span>
        </div>
      </div>
      {error && (
        <div className="subagent-session-error" role="alert">
          {error}
        </div>
      )}
      {visibleRuns.length === 0 ? (
        <div className="subagent-session-empty">
          {isLive ? "No active role runs for this mission." : "Loading active role runs…"}
        </div>
      ) : (
        <div className="subagent-session-list">
          {visibleRuns.map((run) => (
            <RoleRunRow
              key={run.runKey}
              run={run}
              busy={actionKey === run.runKey}
              blocked={actionKey !== null && actionKey !== run.runKey}
              canAct={canAct}
              onCancel={() => onCancel(run)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RoleRunRow({
  run,
  busy,
  blocked,
  canAct,
  onCancel,
}: {
  run: RoleRunState;
  busy: boolean;
  blocked: boolean;
  canAct: boolean;
  onCancel: () => void;
}) {
  const cancellable = isCancellableRoleRun(run);
  const workerCount = Object.keys(run.workerSessions ?? {}).length;
  const queuedCount = run.inbox?.length ?? 0;
  return (
    <div className="role-run-row">
      <div className="role-run-main">
        <span className="mono">{run.roleId}</span>
        <span>{run.status.replace("_", " ")}</span>
        <span className="faint mono">{run.runKey}</span>
      </div>
      <div className="role-run-meta">
        <span className="mono">
          {run.iterationCount}/{run.maxIterations}
        </span>
        {workerCount > 0 && <span>{workerCount} worker{workerCount === 1 ? "" : "s"}</span>}
        {queuedCount > 0 && <span>{queuedCount} queued</span>}
        <span>updated {formatTimeOfDay(run.lastActiveAt)}</span>
      </div>
      <button
        type="button"
        className="btn ghost"
        disabled={!canAct || !cancellable || busy || blocked}
        onClick={onCancel}
        title={
          !canAct
            ? OPERATOR_ACTION_SCOPE_HINT
            : cancellable
              ? "Cancel this active role run"
              : "Only currently running role generations can be cancelled"
        }
      >
        {busy ? "Cancelling…" : "Cancel run"}
      </button>
    </div>
  );
}

function isCancellableRoleRun(run: RoleRunState): boolean {
  return run.status === "running";
}

function SubAgentSessionsCard({
  sessions,
  isLive,
  error,
  actionKey,
  canAct,
  onContinue,
  onCancel,
}: {
  sessions: WorkerSessionRecord[];
  isLive: boolean;
  error: string | null;
  actionKey: string | null;
  canAct: boolean;
  onContinue: (session: WorkerSessionRecord) => void;
  onCancel: (session: WorkerSessionRecord) => void;
}) {
  const activeCount = sessions.filter((session) => !isTerminalSession(session)).length;
  return (
    <section className="card subagent-session-card worker-session-card">
      <div className="subagent-session-head">
        <div>
          <div className="label" style={{ fontSize: 11 }}>Sub-agent sessions</div>
          <div className="muted" style={{ fontSize: 11.5 }}>
            Durable child work with history, continuation, and cancellation controls
          </div>
        </div>
        <div className="thinking-card-meta">
          <span>{sessions.length} session{sessions.length === 1 ? "" : "s"}</span>
          <span>{activeCount} active</span>
        </div>
      </div>
      {error && (
        <div className="subagent-session-error" role="alert">
          {error}
        </div>
      )}
      {sessions.length === 0 ? (
        <div className="subagent-session-empty">
          {isLive ? "No sub-agent sessions have been created for this mission yet." : "Loading sub-agent sessions…"}
        </div>
      ) : (
        <div className="subagent-session-list">
          {sessions.map((session) => (
            <SubAgentSessionRow
              key={session.workerRunKey}
              session={session}
              busy={actionKey === session.workerRunKey}
              blocked={actionKey !== null && actionKey !== session.workerRunKey}
              canAct={canAct}
              onContinue={() => onContinue(session)}
              onCancel={() => onCancel(session)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SubAgentSessionRow({
  session,
  busy,
  blocked,
  canAct,
  onContinue,
  onCancel,
}: {
  session: WorkerSessionRecord;
  busy: boolean;
  blocked: boolean;
  canAct: boolean;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const history = session.state.history ?? [];
  const latestHistory = history.slice(-4).reverse();
  const terminal = isTerminalSession(session);
  const summary = session.state.lastResult?.summary ?? session.state.continuationDigest?.summary ?? "No result summary yet.";
  const label = session.context?.label?.trim();
  return (
    <details className="subagent-session-row">
      <summary>
        <span className="subagent-session-main">
          <span className="mono">{session.state.workerType}</span>
          {label && <span>{label}</span>}
          <span>{session.state.status.replace("_", " ")}</span>
          <span className="faint mono">{session.workerRunKey}</span>
        </span>
        <span className="subagent-session-time">
          updated {formatTimeOfDay(session.state.updatedAt)}
        </span>
      </summary>
      <div className="subagent-session-body">
        <div className="subagent-session-summary">{summary}</div>
        <div className="subagent-session-actions">
          <button
            type="button"
            className="btn"
            disabled={!canAct || busy || blocked}
            onClick={onContinue}
            title={canAct ? undefined : OPERATOR_ACTION_SCOPE_HINT}
          >
            <Icon name="send" size={13} /> {busy ? "Sending…" : "Continue"}
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={!canAct || busy || blocked || terminal}
            onClick={onCancel}
            title={canAct ? undefined : OPERATOR_ACTION_SCOPE_HINT}
          >
            {busy ? "Cancelling…" : "Cancel"}
          </button>
        </div>
        <div className="subagent-session-history">
          {latestHistory.length === 0 ? (
            <div className="muted" style={{ fontSize: 11.5 }}>No child transcript entries yet.</div>
          ) : (
            latestHistory.map((entry) => (
              <div key={entry.id} className="subagent-session-history-entry" data-role={entry.role}>
                <div className="subagent-session-history-head">
                  <span>{entry.role}</span>
                  {entry.toolName && <span className="mono">{entry.toolName}</span>}
                  <span className="mono faint">{formatTimeOfDay(entry.createdAt)}</span>
                </div>
                <div>{entry.content}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </details>
  );
}

function isTerminalSession(session: WorkerSessionRecord): boolean {
  return ["done", "failed", "cancelled"].includes(session.state.status);
}

function latestFinalAnswer(events: ActivityEvent[]): ActivityEvent | null {
  const candidates = events.filter(
    (event) =>
      event.kind === "thought" &&
      event.text.trim().length > 0 &&
      (event.runtime?.route === "lead-role" || event.actor === "role-lead")
  );
  return candidates.at(-1) ?? null;
}

function buildTraceFilterCounts(items: TimelineReplayItem[]): Record<TraceFilter, number> {
  const counts: Record<TraceFilter, number> = {
    all: 0,
    agent: 0,
    tools: 0,
    approvals: 0,
    recovery: 0,
    evidence: 0,
  };
  for (const item of items) {
    counts.all += 1;
    const matches = classifyTraceItem(item);
    if (matches.agent) counts.agent += 1;
    if (matches.tools) counts.tools += 1;
    if (matches.approvals) counts.approvals += 1;
    if (matches.recovery) counts.recovery += 1;
    if (matches.evidence) counts.evidence += 1;
  }
  return counts;
}

function traceFilterMatches(item: TimelineReplayItem, filter: TraceFilter): boolean {
  if (filter === "all") return true;
  const matches = classifyTraceItem(item);
  switch (filter) {
    case "agent":
      return matches.agent;
    case "tools":
      return matches.tools;
    case "approvals":
      return matches.approvals;
    case "recovery":
      return matches.recovery;
    case "evidence":
      return matches.evidence;
    default: {
      const exhaustive: never = filter;
      return exhaustive;
    }
  }
}

function classifyTraceItem(item: TimelineReplayItem): Record<Exclude<TraceFilter, "all">, boolean> {
  const matches = {
    agent: false,
    tools: item.kind === "tool-process",
    approvals: false,
    recovery: false,
    evidence: false,
  };
  const visit = (event: ActivityEvent) => {
    if (event.kind === "plan" || event.kind === "thought") matches.agent = true;
    if (event.kind === "tool") matches.tools = true;
    if (event.kind === "approval") matches.approvals = true;
    if (event.kind === "recovery" || event.emph === "danger") matches.recovery = true;
    if (event.kind === "browser" || event.kind === "doc" || event.kind === "artifact") matches.evidence = true;
  };
  if (item.kind === "event") {
    visit(item.event);
  } else {
    for (const event of item.toolEvents) visit(event);
    for (const event of item.processEvents) visit(event);
  }
  return matches;
}

function ToolProcessRow({
  process,
  workerSessions,
  actionKey,
  toolCallActionKey,
  canAct,
  onContinue,
  onCancel,
  onCancelToolCalls,
}: {
  process: ToolProcessItem;
  workerSessions: WorkerSessionRecord[];
  actionKey: string | null;
  toolCallActionKey: string | null;
  canAct: boolean;
  onContinue: (session: WorkerSessionRecord) => void;
  onCancel: (session: WorkerSessionRecord) => void;
  onCancelToolCalls: (process: ToolProcessItem) => void;
}) {
  const toolNames = [...new Set(process.toolEvents.map((event) => event.runtime?.toolName).filter(Boolean))];
  const statusLabel =
    process.status === "failed" ? "failed" : process.status === "running" ? "running" : "completed";
  const resultCount = process.toolEvents.filter((event) => event.runtime?.toolPhase === "result").length;
  const progressCount = process.toolEvents.filter((event) => event.runtime?.toolPhase === "progress").length;
  const skippedCount = process.toolEvents.filter(
    (event) => event.runtime?.toolPhase === "result" && event.runtime?.admission === "skipped"
  ).length;
  const processEventCount = process.processEvents.length;
  const processSteps = useMemo(
    () =>
      [...process.toolEvents, ...process.processEvents].sort(
        (left, right) => left.tMs - right.tMs || left.id.localeCompare(right.id)
      ),
    [process.processEvents, process.toolEvents]
  );
  const duration = formatDurationMs(process.startMs, process.endMs);
  const emph = process.status === "failed" ? "danger" : process.status === "completed" ? "success" : undefined;
  const processSessions = useMemo(
    () => findWorkerSessionsForProcess(process, workerSessions),
    [process, workerSessions]
  );
  const cancellableToolCalls = getCancellableToolCallsForProcess(process);
  const toolCancelBusy = toolCallActionKey === process.id;
  const toolCancelBlocked = toolCallActionKey !== null && toolCallActionKey !== process.id;

  return (
    <div className="tl-event tool-process" data-kind="tool">
      <div className="tl-time mono">{formatTimeOfDay(process.startMs)}</div>
      <div className="tl-gutter">
        <div className="tl-marker" />
      </div>
      <div className="tl-body tool-process-body" data-emph={emph}>
        <div className="tl-actor">
          {process.actor}
          <span className="role-mini">
            thought process · {statusLabel} · {duration}
          </span>
        </div>
        <div className="tool-process-summary">
          <span>{toolNames.length ? toolNames.join(", ") : "tool chain"}</span>
          <span>{process.toolEvents.length} step{process.toolEvents.length === 1 ? "" : "s"}</span>
          <span>{resultCount} result{resultCount === 1 ? "" : "s"}</span>
          {skippedCount > 0 && <span>{skippedCount} skipped</span>}
          {progressCount > 0 && <span>{progressCount} progress</span>}
          {processEventCount > 0 && <span>{processEventCount} runtime event{processEventCount === 1 ? "" : "s"}</span>}
        </div>
        {process.finalThought && (
          <div className="tool-process-answer-link">Final answer appears below this trace.</div>
        )}
        {cancellableToolCalls && (
          <div className="tool-process-session-actions">
            <div className="tool-process-session-action-row tool-process-tool-action-row">
              <span className="mono">active tools</span>
              <span>
                {cancellableToolCalls.toolCallIds.length} call
                {cancellableToolCalls.toolCallIds.length === 1 ? "" : "s"} still awaiting result
              </span>
              <span className="mono">{cancellableToolCalls.messageId}</span>
              <button
                type="button"
                className="btn ghost"
                disabled={!canAct || toolCancelBusy || toolCancelBlocked}
                onClick={() => onCancelToolCalls(process)}
                title={canAct ? undefined : OPERATOR_ACTION_SCOPE_HINT}
              >
                <Icon name="x" size={13} /> {toolCancelBusy ? "Cancelling..." : "Cancel tool calls"}
              </button>
            </div>
          </div>
        )}
        {processSessions.length > 0 && (
          <div className="tool-process-session-actions">
            {processSessions.map((session) => {
              const busy = actionKey === session.workerRunKey;
              const blocked = actionKey !== null && actionKey !== session.workerRunKey;
              const terminal = isTerminalSession(session);
              return (
                <div key={session.workerRunKey} className="tool-process-session-action-row">
                  <span className="mono">{session.state.workerType}</span>
                  <span>{session.context?.label?.trim() || session.workerRunKey}</span>
                  <span>{session.state.status.replace("_", " ")}</span>
                  <button
                    type="button"
                    className="btn"
                    disabled={!canAct || busy || blocked}
                    onClick={() => onContinue(session)}
                    title={canAct ? undefined : OPERATOR_ACTION_SCOPE_HINT}
                  >
                    <Icon name="send" size={13} /> {busy ? "Sending..." : "Continue session"}
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={!canAct || busy || blocked || terminal}
                    onClick={() => onCancel(session)}
                    title={canAct ? undefined : OPERATOR_ACTION_SCOPE_HINT}
                  >
                    {busy ? "Cancelling..." : "Cancel session"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <details className="tool-process-details">
          <summary>Show tool calls, progress, and results</summary>
          <div className="tool-process-steps">
            {processSteps.map((event) => (
              <div key={event.id} className="tool-process-step" data-phase={event.runtime?.toolPhase ?? event.kind}>
                <div className="step-head">
                  <span className="mono">{event.runtime?.toolPhase ?? event.kind}</span>
                  <span>{event.runtime?.toolName ?? event.target ?? event.kind}</span>
                  <span className="mono faint">{event.t ?? formatTimeOfDay(event.tMs)}</span>
                </div>
                <div className="step-text">{event.text}</div>
                <ToolEventInspector event={event} />
              </div>
            ))}
          </div>
        </details>
      </div>
    </div>
  );
}

function findWorkerSessionsForProcess(
  process: ToolProcessItem,
  sessions: WorkerSessionRecord[]
): WorkerSessionRecord[] {
  const sessionKeys = new Set<string>();
  const toolCallIds = new Set<string>();
  for (const event of process.toolEvents) {
    const toolCallId = event.runtime?.toolCallId?.trim();
    if (toolCallId) toolCallIds.add(toolCallId);
    const resultContent = event.runtime?.resultContent;
    if (typeof resultContent === "string") {
      for (const key of extractSessionKeys(resultContent)) {
        sessionKeys.add(key);
      }
    }
  }
  return sessions.filter((session) => {
    if (sessionKeys.has(session.workerRunKey)) return true;
    if (session.context?.parentSessionKey && sessionKeys.has(session.context.parentSessionKey)) return true;
    if (session.context?.toolCallId && toolCallIds.has(session.context.toolCallId)) return true;
    return false;
  });
}

function extractSessionKeys(content: string): string[] {
  const keys = new Set<string>();
  for (const pattern of [
    /"session_key"\s*:\s*"([^"]+)"/g,
    /"workerRunKey"\s*:\s*"([^"]+)"/g,
    /"worker_run_key"\s*:\s*"([^"]+)"/g,
  ]) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]?.trim()) keys.add(match[1].trim());
    }
  }
  return [...keys];
}

function LiveTimelineRow({ event }: { event: ActivityEvent }) {
  const isUser = event.kind === "plan" && event.actor === "user";
  const isFailure = event.kind === "recovery";
  const emph = isFailure ? "danger" : event.emph;
  const isToolEvent = event.kind === "tool";
  const toolPhase = event.runtime?.toolPhase;
  const toolName = event.runtime?.toolName;
  const kindLabel =
    isToolEvent && toolPhase === "call"
      ? `tool → ${toolName ?? "?"}`
      : isToolEvent && toolPhase === "progress"
        ? `tool · ${toolName ?? "?"}`
      : isToolEvent && toolPhase === "result"
        ? `tool ← ${toolName ?? "?"}`
        : event.kind;

  // PR K3.6: tool events get an expandable inspector. The inline
  // `text` is already a capped human-readable preview; the
  // expanded view shows the full structured JSON (call args) or
  // full result content (truncated only at the 8 kB server-side
  // cap). Without this the timeline is a black box —
  // "returned (2.0 kB)" with no way to see WHAT.
  const expandable =
    isToolEvent &&
    ((toolPhase === "call" && event.runtime?.callInput) ||
      (toolPhase === "progress" && event.runtime?.progressDetail) ||
      (toolPhase === "result" && event.runtime?.resultContent));

  return (
    <div className="tl-event" data-kind={event.kind}>
      <div className="tl-time mono">{event.t ?? formatTimeOfDay(event.tMs)}</div>
      <div className="tl-gutter">
        <div className="tl-marker" />
      </div>
      <div className="tl-body" data-emph={emph}>
        <div className="tl-actor">
          {isUser ? "You" : event.actor}
          <span className="role-mini">{kindLabel}</span>
        </div>
        <div
          className="tl-msg"
          style={{
            whiteSpace: "pre-wrap",
            ...(isToolEvent
              ? {
                  fontFamily: "var(--font-mono)",
                  fontSize: 11.5,
                  color: "var(--text-muted)",
                  background: "var(--surface)",
                  padding: "4px 8px",
                  borderRadius: "var(--r-sm)",
                  border: "1px solid var(--border)",
                }
              : {}),
          }}
        >
          {event.text}
        </div>
        {expandable && <ToolEventInspector event={event} />}
      </div>
    </div>
  );
}

function ToolEventInspector({ event }: { event: ActivityEvent }) {
  const toolPhase = event.runtime?.toolPhase;
  const callInput = event.runtime?.callInput;
  const progressDetail = event.runtime?.progressDetail;
  const resultContent = event.runtime?.resultContent;
  const resultTruncated = event.runtime?.resultTruncated === "true";
  const progressTruncated = event.runtime?.progressTruncated === "true";

  const body =
    toolPhase === "call" && callInput
      ? prettyJson(callInput)
      : toolPhase === "progress" && progressDetail
        ? prettyJson(progressDetail)
      : toolPhase === "result" && resultContent
        ? resultContent
        : null;
  if (!body) return null;
  const label =
    toolPhase === "call"
      ? "Show full arguments"
      : toolPhase === "progress"
        ? progressTruncated
          ? "Show progress detail (truncated at 16 kB)"
          : "Show progress detail"
      : resultTruncated
        ? "Show captured result (truncated at 8 kB)"
        : "Show full result";

  return (
    <details style={{ marginTop: 4 }}>
      <summary
        style={{
          cursor: "pointer",
          fontSize: 10.5,
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          padding: "2px 0",
          userSelect: "none",
        }}
      >
        {label}
      </summary>
      <pre
        style={{
          marginTop: 4,
          padding: 8,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: "var(--r-sm)",
          fontSize: 11,
          lineHeight: 1.5,
          color: "var(--text)",
          maxHeight: 400,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {body}
      </pre>
    </details>
  );
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
