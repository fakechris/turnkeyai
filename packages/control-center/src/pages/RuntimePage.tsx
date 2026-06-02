// Runtime — operator surface for bridge / transport / sessions /
// diagnostics / logs.
//
// Live operator diagnostics. Sections without a stable read endpoint still
// render as explicitly-labeled placeholders rather than fixture data.

import { useState } from "react";

import { useApiClient } from "../api/useApiClient";
import type { Mission, WorkerSessionRecord } from "../api/mission-api";
import type {
  BridgeStatus,
  DiagnosticsLogs,
  DiagnosticsSnapshot,
  RuntimeSummaryReport,
  ValidationOpsRunRecord,
  ValidationOpsReport,
  ValidationOpsStatus,
} from "../api/types";
import { Icon } from "../components/Icon";
import { usePolling } from "../hooks/usePolling";
import { useAppState } from "../state/AppState";
import { pillFromStatus } from "../state/pillFromStatus";

const POLL_MS = 5_000;
const LOG_LIMIT = 50;

interface Live {
  diagnostics: DiagnosticsSnapshot | null;
  status: BridgeStatus | null;
  logs: DiagnosticsLogs | null;
  runtimeSummary: RuntimeSummaryReport | null;
  missions: Mission[];
  workerSessions: WorkerSessionRecord[];
  validationOps: ValidationOpsReport | null;
  validationOpsError: string | null;
  reachable: boolean;
}

export function RuntimePage() {
  const client = useApiClient();
  const { state, setPill, setLastStatus, openMission } = useAppState();
  const [missionReconciling, setMissionReconciling] = useState(false);
  const [missionReconcileNotice, setMissionReconcileNotice] = useState<string | null>(null);
  const [live, setLive] = useState<Live>({
    diagnostics: null,
    status: null,
    logs: null,
    runtimeSummary: null,
    missions: [],
    workerSessions: [],
    validationOps: null,
    validationOpsError: null,
    reachable: false,
  });

  usePolling(async () => {
    const shouldFetchValidationOps = state.scope === "admin" || state.scope === "unknown";
    const [diagResult, statusResult, logsResult, runtimeResult, missionsResult, sessionsResult, validationOpsResult] = await Promise.allSettled([
      client.get<DiagnosticsSnapshot>("/diagnostics"),
      client.get<BridgeStatus>("/bridge/status"),
      client.get<DiagnosticsLogs>(`/diagnostics/logs?limit=${LOG_LIMIT}`),
      client.get<RuntimeSummaryReport>("/runtime-summary?limit=8"),
      client.get<Mission[]>("/missions"),
      client.get<WorkerSessionRecord[]>("/runtime-worker-sessions?limit=8"),
      shouldFetchValidationOps
        ? client.getNoAuthReset<ValidationOpsReport>("/validation-ops?limit=6")
        : Promise.resolve(null),
    ]);

    const diagnostics = diagResult.status === "fulfilled" ? diagResult.value : null;
    const status = statusResult.status === "fulfilled" ? statusResult.value : null;
    const logs = logsResult.status === "fulfilled" ? logsResult.value : null;
    const runtimeSummary = runtimeResult.status === "fulfilled" ? runtimeResult.value : null;
    const missions = missionsResult.status === "fulfilled" ? missionsResult.value : [];
    const workerSessions = sessionsResult.status === "fulfilled" ? sessionsResult.value : [];
    const validationOps = validationOpsResult.status === "fulfilled" ? validationOpsResult.value : null;
    const validationOpsError =
      !shouldFetchValidationOps
        ? "admin token required"
        : validationOpsResult.status === "rejected"
          ? readableRuntimeError(validationOpsResult.reason)
          : null;
    const reachable = diagnostics != null || status != null || runtimeSummary != null;

    if (status) {
      setLastStatus(status);
      setPill(pillFromStatus(status));
    } else if (reachable) {
      setPill({ state: "warn", label: "Partial" });
    } else {
      // Don't blast "Unreachable" on a single transient 401 from one
      // of the three fetches — apiClient already cleared the token if
      // applicable. Only set bad when ALL three failed.
      const allUnauth = [diagResult, statusResult, logsResult, runtimeResult, missionsResult, sessionsResult, validationOpsResult].every(
        (r) => r.status === "rejected" && (r.reason as Error)?.message === "unauthorized"
      );
      if (!allUnauth) setPill({ state: "bad", label: "Unreachable" });
    }
    setLive({ diagnostics, status, logs, runtimeSummary, missions, workerSessions, validationOps, validationOpsError, reachable });
  }, POLL_MS);

  const exportBundle = () => {
    // Restored from PR H's DiagnosticsBundle (lost in the K1 rewrite).
    // Serializes the live snapshot + log tail as a JSON blob for bug
    // reports. When fetches haven't returned yet the button is disabled
    // by `bundleReady`.
    if (!live.diagnostics) return;
    const bundle = {
      diagnostics: live.diagnostics,
      bridgeStatus: live.status,
      logTail: live.logs,
      capturedAt: new Date().toISOString(),
    };
    const text = JSON.stringify(bundle, null, 2);
    void navigator.clipboard.writeText(text).catch(() => {
      // Clipboard can be blocked in non-HTTPS / unfocused contexts.
      // K2's diagnostics drawer will offer a "select manually" fallback;
      // for K1 we just no-op so the button doesn't appear to do
      // anything wrong.
    });
  };
  const reconcileMissions = async () => {
    setMissionReconciling(true);
    setMissionReconcileNotice(null);
    try {
      const result = await client.post<{ appended: number; missions: Array<{ missionId: string; appended: number }> }>(
        "/missions/reconcile"
      );
      setMissionReconcileNotice(
        `Reconciled ${result.missions.length} linked mission(s), appended ${result.appended} event(s).`
      );
    } catch (error) {
      setMissionReconcileNotice(readableRuntimeError(error));
    } finally {
      setMissionReconciling(false);
    }
  };
  const bundleReady = live.diagnostics != null;
  const replayMissionId = findReplayMissionId(live.runtimeSummary, live.missions);
  const canReconcileMissions = state.scope === "operator" || state.scope === "admin" || state.scope === "unknown";

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Runtime</h2>
          <div className="sub">
            操作员视图 · bridge / transport / sessions / 诊断 / replay。Mission 用户不需要常驻于此。
          </div>
        </div>
        <div className="right">
          <button
            type="button"
            className="btn"
            onClick={exportBundle}
            disabled={!bundleReady}
            title={bundleReady ? "Copy diagnostics bundle to clipboard" : "Waiting for first poll…"}
          >
            <Icon name="diagnose" size={13} /> Export diagnostics
          </button>
          <button
            type="button"
            className="btn"
            disabled={!replayMissionId}
            title={
              replayMissionId
                ? "Open the mission trace for the latest runtime attention item"
                : "No mission-linked runtime chain is available yet."
            }
            onClick={() => {
              if (replayMissionId) openMission(replayMissionId);
            }}
          >
            <Icon name="play" size={13} /> Open replay
          </button>
        </div>
      </div>

      <div className="runtime-grid">
        <div>
          <MetricTiles live={live} />
          <MissionHealthCard
            diagnostics={live.diagnostics}
            reachable={live.reachable}
            onOpenMission={openMission}
            canReconcile={canReconcileMissions}
            reconciling={missionReconciling}
            reconcileNotice={missionReconcileNotice}
            onReconcile={reconcileMissions}
          />
          <SetupHealthCard diagnostics={live.diagnostics} reachable={live.reachable} />
          <BrowserSessionsCard sessions={live.workerSessions} reachable={live.reachable} />
          <DaemonLogCard logs={live.logs} reachable={live.reachable} />
        </div>

        <div className="col" style={{ gap: 14 }}>
          <RecoveryCard summary={live.runtimeSummary} reachable={live.reachable} />
          <ValidationOpsCard report={live.validationOps} error={live.validationOpsError} reachable={live.reachable} />
          <TransportCard status={live.status} />
          <TokensCard />
        </div>
      </div>
    </div>
  );
}

function MetricTiles({ live }: { live: Live }) {
  // Tiles always derive from live data. When the daemon hasn't returned
  // yet we render placeholder "—" rather than a fake fixture.
  const tiles =
    live.diagnostics || live.status
      ? buildLiveTiles(live)
      : ([
          { l: "Daemon", v: "—", d: "connecting…" },
          { l: "Mission health", v: "—", d: "" },
          { l: "Browser sessions", v: "—", d: "" },
          { l: "Runtime attention", v: "—", d: "" },
          { l: "Auth mode", v: "—", d: "" },
          { l: "Expert lane", v: "—", d: "" },
          { l: "Action queue", v: "—", d: "" },
        ] as Array<{ l: string; v: string; d: string }>);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 14 }}>
      {tiles.map((m) => (
        <div key={m.l} className="metric-tile">
          <div className="l">{m.l}</div>
          <div className="v">{m.v}</div>
          <div className="d">{m.d}</div>
        </div>
      ))}
    </div>
  );
}

function buildLiveTiles(live: Live): Array<{ l: string; v: string; d: string }> {
  const d = live.diagnostics;
  const s = live.status;
  const transport = d?.transport.mode ?? s?.transport.mode ?? "?";
  const transportHealth = s?.transport.health;
  const sessionCount = d?.counters.sessionCount ?? s?.sessions.count ?? 0;
  const relayPeer = d?.counters.relayPeerCount ?? s?.relay.peerCount ?? 0;
  const relayTargets = d?.counters.relayTargetCount ?? s?.relay.targetCount ?? 0;
  const runtime = live.runtimeSummary;
  const missionHealth = d?.missionHealth;
  const missionAttention =
    missionHealth
      ? Math.max(
          missionHealth.attentionMissions.length,
          missionHealth.liveness.stale,
          missionHealth.qualityGate.blocked,
          missionHealth.tool.failed,
          missionHealth.tool.timeouts
        )
      : 0;
  return [
    { l: "Daemon", v: `v${d?.daemon.version ?? "?"}`, d: `:${d?.daemon.port ?? "?"}` },
    {
      l: "Mission health",
      v: missionHealth ? `${missionHealth.active} active` : "—",
      d: missionHealth
        ? `${missionAttention} need attention, longest ${formatDurationCompact(missionHealth.duration.longestActiveMs)}`
        : "diagnostics pending",
    },
    {
      l: "Browser sessions",
      v: String(sessionCount),
      d: transportHealth
        ? `${transport}: ${transportHealth.healthy ? "healthy" : transportHealth.reason ?? "unhealthy"}`
        : `transport: ${transport}`,
    },
    { l: "Runtime attention", v: String(runtime?.attentionCount ?? 0), d: `${runtime?.activeCount ?? 0} active` },
    {
      l: "Auth mode",
      v: d?.daemon.authMode ?? "?",
      d: d ? `uptime ${formatUptimeShort(d.daemon.uptimeMs)}` : "—",
    },
    {
      l: "Expert lane",
      v: s?.expertLane.available ? "available" : "off",
      d: s?.expertLane.reason ?? "direct-CDP only",
    },
    {
      l: "Action queue",
      v: String(s?.relay.actionRequestQueueDepth ?? 0),
      d: relayPeer > 0
        ? `${relayPeer} relay peer(s), ${relayTargets} target(s)`
        : s?.relay.lastHeartbeatAgeMs != null
          ? `hb ${Math.round(s.relay.lastHeartbeatAgeMs / 1000)}s ago`
          : "no relay",
    },
  ];
}

function MissionHealthCard({
  diagnostics,
  reachable,
  onOpenMission,
  canReconcile,
  reconciling,
  reconcileNotice,
  onReconcile,
}: {
  diagnostics: DiagnosticsSnapshot | null;
  reachable: boolean;
  onOpenMission: (missionId: string) => void;
  canReconcile: boolean;
  reconciling: boolean;
  reconcileNotice: string | null;
  onReconcile: () => void;
}) {
  const health = diagnostics?.missionHealth;
  const attention = health?.attentionMissions ?? [];
  const hasAttention =
    health != null &&
    (attention.length > 0 ||
      health.liveness.stale > 0 ||
      health.qualityGate.blocked > 0 ||
      health.tool.failed > 0 ||
      health.tool.timeouts > 0 ||
      health.needsApproval > 0);
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-hd">
        <Icon name="runtime" size={13} />
        <h3>Mission health</h3>
        <button
          type="button"
          className="btn"
          style={{ marginLeft: "auto" }}
          disabled={!canReconcile || reconciling}
          title={canReconcile ? "Force a mission/thread mirror pass" : "Operator token required"}
          onClick={onReconcile}
        >
          {reconciling ? "Reconciling" : "Reconcile"}
        </button>
        <span className={`tag ${hasAttention ? "warning" : health ? "success" : "info"}`} style={{ marginLeft: 8 }}>
          {health ? `${health.total} missions` : reachable ? "checking" : "offline"}
        </span>
      </div>
      {health ? (
        <>
          <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border-soft)" }}>
            <div className="runtime-health-label">
              active {health.active} · approval {health.needsApproval} · blocked {health.withBlockers}
            </div>
            <div className="runtime-health-detail">
              quality passed {health.qualityGate.passed} · attention {health.qualityGate.needsAttention + health.qualityGate.blocked}
              {" · "}tool failed {health.tool.failed} · timeouts {health.tool.timeouts}
            </div>
            <div className="runtime-health-action">
              inspected {health.inspected} · sessions spawned {health.sessions.spawned} · stale runtime {health.liveness.stale}
              {" · "}profile fallback {health.browser.profileFallbacks}
              {health.browser.failureBuckets.length > 0 ? ` · browser buckets ${formatFailureBuckets(health.browser.failureBuckets)}` : ""}
              {" · "}longest active {formatDurationCompact(health.duration.longestActiveMs)}
            </div>
            {health.duration.longestActiveMissionTitle ? (
              <div className="runtime-health-action">
                oldest active: {health.duration.longestActiveMissionTitle}
              </div>
            ) : null}
            {reconcileNotice ? (
              <div className="runtime-health-action" role="status">
                {reconcileNotice}
              </div>
            ) : null}
          </div>
          {attention.length > 0 ? (
            <div style={{ display: "grid" }}>
              {attention.map((mission) => (
                <button
                  key={mission.id}
                  type="button"
                  className="runtime-health-row"
                  style={{ textAlign: "left", background: "transparent", border: 0, cursor: "pointer" }}
                  onClick={() => onOpenMission(mission.id)}
                >
                  <span className={`status-dot ${missionStatusDot(mission.status, mission.qualityGateStatus)}`} />
                  <div style={{ minWidth: 0 }}>
                    <div className="runtime-health-label">{mission.title}</div>
                    <div className="runtime-health-detail">
                      {mission.status} · {mission.qualityGateStatus}
                      {mission.pendingApprovals > 0 ? ` · ${mission.pendingApprovals} approval` : ""}
                      {mission.blockers > 0 ? ` · ${mission.blockers} blocker` : ""}
                      {mission.browserProfileFallbacks > 0 ? ` · ${mission.browserProfileFallbacks} profile fallback` : ""}
                      {mission.browserFailureBuckets.length > 0 ? ` · ${formatFailureBuckets(mission.browserFailureBuckets)}` : ""}
                    </div>
                    <div className="runtime-health-action">
                      stale {mission.staleRuntimeSubjects} · failed {mission.toolFailures} · timeouts {mission.toolTimeouts}
                      {" · "}running {formatDurationCompact(mission.wallClockMs)}
                      {mission.lastProgressAtMs ? ` · last progress ${formatRelativeAge(mission.lastProgressAtMs)}` : ""}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div style={{ padding: 14 }}>
              <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
                No mission needs operator attention right now.
              </div>
            </div>
          )}
        </>
      ) : (
        <div style={{ padding: 14 }}>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
            {reachable ? "Waiting for mission health…" : "Connect to the daemon to see mission health."}
          </div>
        </div>
      )}
    </div>
  );
}

function findReplayMissionId(summary: RuntimeSummaryReport | null, missions: Mission[]): string | null {
  if (!summary || missions.length === 0) return null;
  const missionByThread = new Map(
    missions
      .filter((mission) => typeof mission.threadId === "string" && mission.threadId.trim().length > 0)
      .map((mission) => [mission.threadId as string, mission.id])
  );
  const candidateChains = [
    ...summary.attentionChains,
    ...summary.waitingChains,
    ...summary.failedChains,
    ...summary.staleChains,
    ...summary.activeChains,
    ...summary.recentlyResolved,
  ];
  for (const chain of candidateChains) {
    const missionId = missionByThread.get(chain.threadId);
    if (missionId) return missionId;
  }
  return null;
}

function formatFailureBuckets(buckets: Array<{ bucket: string; count: number }>): string {
  return buckets.slice(0, 2).map((item) => `${item.bucket} ${item.count}`).join(", ");
}

function SetupHealthCard({
  diagnostics,
  reachable,
}: {
  diagnostics: DiagnosticsSnapshot | null;
  reachable: boolean;
}) {
  const readiness = diagnostics?.readiness;
  const checks = readiness?.checks ?? [];
  const title = setupHealthTitle(readiness?.status, reachable);
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-hd">
        <Icon name="diagnose" size={13} />
        <h3>Setup health</h3>
        <span className={`tag ${readinessStatusTone(readiness?.status)}`} style={{ marginLeft: "auto" }}>
          {title}
        </span>
      </div>
      {checks.length > 0 ? (
        <div style={{ display: "grid" }}>
          {checks.map((check) => (
            <div
              key={check.id}
              className="runtime-health-row"
              data-status={check.status}
            >
              <span className={`status-dot ${readinessDotClass(check.status)}`} />
              <div style={{ minWidth: 0 }}>
                <div className="runtime-health-label">{check.label}</div>
                <div className="runtime-health-detail">{check.detail}</div>
                {check.action ? <div className="runtime-health-action">{check.action}</div> : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="muted" style={{ padding: 14, fontSize: 12 }}>
          {reachable ? "Waiting for readiness checks…" : "Connect to the daemon to see setup health."}
        </div>
      )}
    </div>
  );
}

function setupHealthTitle(status: "ok" | "warn" | "error" | undefined, reachable: boolean): string {
  if (status === "error") return "Action needed";
  if (status === "warn") return "Needs attention";
  if (status === "ok") return "Ready";
  return reachable ? "Checking" : "Offline";
}

function readinessStatusTone(status: "ok" | "warn" | "error" | undefined): string {
  if (status === "error") return "danger";
  if (status === "warn") return "warning";
  if (status === "ok") return "success";
  return "info";
}

function readinessDotClass(status: "ok" | "warn" | "error"): string {
  if (status === "error") return "blocked";
  if (status === "warn") return "needs_approval";
  return "working";
}

function missionStatusDot(status: string, qualityStatus: string): string {
  if (status === "blocked" || qualityStatus === "blocked") return "blocked";
  if (status === "needs_approval") return "needs_approval";
  if (status === "done") return qualityStatus === "needs_attention" ? "needs_approval" : "done";
  if (status === "working") return "working";
  if (status === "archived") return "archived";
  return "planning";
}

function formatUptimeShort(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatDurationCompact(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms));
  if (safeMs < 1_000) return `${safeMs}ms`;
  const totalSeconds = Math.floor(safeMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes > 0 ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
}

function formatRelativeAge(timestamp: number): string {
  const delta = Math.max(0, Date.now() - timestamp);
  if (delta < 1_000) return "now";
  if (delta < 60_000) return `${Math.round(delta / 1_000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  return `${Math.round(delta / 3_600_000)}h ago`;
}

function workerStatusDot(status: string): string {
  if (status === "done") return "done";
  if (status === "failed" || status === "cancelled" || status === "unrecoverable") return "blocked";
  if (status === "running" || status === "resuming") return "working";
  return "planning";
}

function runtimeChainDot(state: string): string {
  if (state === "failed" || state === "stale") return "blocked";
  if (state === "waiting") return "needs_approval";
  if (state === "resolved") return "done";
  return "working";
}

function validationStatusTone(status: ValidationOpsStatus | undefined): string {
  if (status === "passed") return "success";
  if (status === "failed") return "danger";
  if (status === "missing") return "warning";
  return "info";
}

function validationStatusDot(status: ValidationOpsStatus | "stale" | undefined): string {
  if (status === "passed") return "done";
  if (status === "failed") return "blocked";
  if (status === "missing" || status === "stale") return "needs_approval";
  return "planning";
}

export function formatRealAcceptanceMissionSummary(run: ValidationOpsReport["latestRuns"][number]): string | null {
  const missionReport = run.realAcceptance?.missionReport;
  if (!missionReport) {
    return null;
  }
  return [
    `${missionReport.passedScenarios}/${missionReport.scenarioCount} mission scenarios`,
    `quality failures ${missionReport.qualityFailures}`,
    `checks warn/fail ${missionReport.qualityCheckWarnings}/${missionReport.qualityCheckFailures}`,
    `source coverage ${missionReport.sourceCoverageWarnings}/${missionReport.sourceCoverageFailures}`,
    `liveness ${missionReport.livenessActive}/${missionReport.livenessWaiting}/${missionReport.livenessStale}`,
    `tools ${missionReport.toolResults}/${missionReport.toolRequested}`,
    `evidence ${missionReport.evidenceEvents}`,
  ].join(" · ");
}

export function formatRealAcceptanceNaturalSummary(run: ValidationOpsReport["latestRuns"][number]): string | null {
  const naturalReport = run.realAcceptance?.naturalMissionReport;
  if (!naturalReport) {
    return null;
  }
  const missingCoverage =
    countOrZero(naturalReport.sourceAnswerTermsMissing) +
    countOrZero(naturalReport.sourceAnswerPatternsMissing) +
    countOrZero(naturalReport.sourceEvidencePatternsMissing);
  return [
    `${countOrZero(naturalReport.passedScenarios)}/${countOrZero(naturalReport.scenarioCount)} natural scenarios`,
    `evidence ${countOrZero(naturalReport.finalAnswerHasEvidence)}/${countOrZero(naturalReport.scenarioCount)}`,
    `useful ${countOrZero(naturalReport.finalAnswerUseful)}/${countOrZero(naturalReport.scenarioCount)}`,
    `source terms ${countOrZero(naturalReport.sourceAnswerTermsCovered)}/${countOrZero(naturalReport.sourceAnswerTermsTotal)}`,
    `source patterns ${countOrZero(naturalReport.sourceAnswerPatternsCovered)}/${countOrZero(naturalReport.sourceAnswerPatternsTotal)}`,
    `evidence patterns ${countOrZero(naturalReport.sourceEvidencePatternsCovered)}/${countOrZero(naturalReport.sourceEvidencePatternsTotal)}`,
    `missing ${missingCoverage}`,
    `unsupported ${countOrZero(naturalReport.sourceUnsupportedClaims)}`,
    `risk ${countOrZero(naturalReport.sourceResidualRiskVisible)}/${countOrZero(naturalReport.scenarioCount)}`,
  ].join(" · ");
}

export function formatRealAcceptanceCoverageSummary(run: ValidationOpsReport["latestRuns"][number]): string | null {
  const coverage = run.realAcceptance?.releaseCoverage;
  if (!coverage) {
    return null;
  }
  return [
    `${coverage.status} gate`,
    `tool-use ${formatScenarioCoverage(coverage.tooluse)}`,
    `mission ${formatScenarioCoverage(coverage.mission)}`,
    `natural ${formatScenarioCoverage(coverage.naturalMission)}`,
  ].join(" · ");
}

export function formatValidationRunArtifactPaths(
  run: ValidationOpsReport["latestRuns"][number]
): Array<{ label: string; path: string }> {
  const artifacts: Array<{ label: string; path: string }> = [];
  if (run.realAcceptance?.tooluseArtifactPath) {
    artifacts.push({ label: "tool-use artifact", path: run.realAcceptance.tooluseArtifactPath });
  }
  if (run.artifactPath) {
    artifacts.push({ label: run.realAcceptance ? "mission artifact" : "artifact", path: run.artifactPath });
  }
  if (run.realAcceptance?.naturalArtifactPath) {
    artifacts.push({ label: "natural artifact", path: run.realAcceptance.naturalArtifactPath });
  }
  return artifacts;
}

function formatScenarioCoverage(coverage: {
  requested: number;
  expected: number;
  missing: number;
}): string {
  const base = `${coverage.requested}/${coverage.expected}`;
  return coverage.missing > 0 ? `${base} (missing ${coverage.missing})` : base;
}

type NaturalScenarioProof = NonNullable<
  NonNullable<NonNullable<ValidationOpsRunRecord["realAcceptance"]>["naturalMissionReport"]>["scenarioProofs"]
>[number];

export function formatNaturalScenarioProofSummary(proof: NaturalScenarioProof): string {
  const status = proof.passed ? "passed" : "failed";
  const signals = [
    `status ${status}`,
    `browser ${proof.browserUsed ? "yes" : "no"}`,
    `sessions ${countOrZero(proof.sessionsSpawned)}/${countOrZero(proof.sessionsContinued)}`,
    `evidence ${countOrZero(proof.evidenceEvents)}`,
    `useful ${proof.finalAnswerUseful ? "yes" : "no"}`,
    `risk ${proof.sourceResidualRiskVisible ? "yes" : "no"}`,
    `missing ${naturalScenarioMissingCoverage(proof)}`,
  ];
  if (proof.approvalExercised) {
    signals.push(
      `approval ${countOrZero(proof.approvalsRequested)}/${countOrZero(proof.approvalsDecided)}/${countOrZero(proof.approvalsApplied)}`
    );
  }
  if (countOrZero(proof.toolFailed) > 0 || countOrZero(proof.toolTimeouts) > 0 || countOrZero(proof.toolCancelled) > 0) {
    signals.push(`tool f/t/c ${countOrZero(proof.toolFailed)}/${countOrZero(proof.toolTimeouts)}/${countOrZero(proof.toolCancelled)}`);
  }
  if (countOrZero(proof.browserFailureBuckets) > 0 || countOrZero(proof.browserProfileFallbacks) > 0) {
    signals.push(`browser recovery ${countOrZero(proof.browserFailureBuckets)}/${countOrZero(proof.browserProfileFallbacks)}`);
  }
  return signals.join(" · ");
}

function naturalScenarioMissingCoverage(proof: NaturalScenarioProof): number {
  return (
    countOrZero(proof.sourceAnswerTermsMissing) +
    countOrZero(proof.sourceAnswerPatternsMissing) +
    countOrZero(proof.sourceEvidencePatternsMissing)
  );
}

function countOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readableRuntimeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "request failed";
}

function BrowserSessionsCard({
  sessions,
  reachable,
}: {
  sessions: WorkerSessionRecord[];
  reachable: boolean;
}) {
  return (
    <div className="card">
      <div className="card-hd">
        <h3>Browser sessions</h3>
        <span className="mono faint" style={{ fontSize: 10 }}>
          {sessions.length > 0 ? `${sessions.length} worker session(s)` : reachable ? "none active" : "offline"}
        </span>
      </div>
      {sessions.length > 0 ? (
        <div style={{ display: "grid" }}>
          {sessions.map((session) => (
            <div key={session.workerRunKey} className="runtime-health-row">
              <span className={`status-dot ${workerStatusDot(session.state.status)}`} />
              <div style={{ minWidth: 0 }}>
                <div className="runtime-health-label">
                  {session.state.workerType} · {session.state.status}
                </div>
                <div className="runtime-health-detail">
                  {session.workerRunKey} · thread {session.context?.threadId ?? "-"}
                </div>
                <div className="runtime-health-action">
                  updated {formatRelativeAge(session.state.updatedAt)}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ padding: 14 }}>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
            {reachable
              ? "No active or recently persisted worker sessions are visible to the runtime summary."
              : "Connect to the daemon to see worker sessions."}
          </div>
        </div>
      )}
    </div>
  );
}

function RecoveryCard({
  summary,
  reachable,
}: {
  summary: RuntimeSummaryReport | null;
  reachable: boolean;
}) {
  const chains = summary?.attentionChains ?? [];
  return (
    <div className="card">
      <div className="card-hd">
        <Icon name="warning" size={13} />
        <h3>Runtime attention</h3>
        <span className={`tag ${summary && summary.attentionCount > 0 ? "warning" : "success"}`} style={{ marginLeft: "auto" }}>
          {summary ? `${summary.attentionCount} attention` : reachable ? "checking" : "offline"}
        </span>
      </div>
      {summary ? (
        <div style={{ display: "grid" }}>
          {chains.length > 0 ? (
            chains.map((chain) => (
              <div key={chain.chainId} className="runtime-health-row">
                <span className={`status-dot ${runtimeChainDot(chain.canonicalState)}`} />
                <div style={{ minWidth: 0 }}>
                  <div className="runtime-health-label">
                    {chain.headline ?? `${chain.rootKind} · ${chain.canonicalState}`}
                  </div>
                  <div className="runtime-health-detail">
                    {chain.chainId} · {chain.phase}
                    {chain.waitingReason ? ` · ${chain.waitingReason}` : ""}
                  </div>
                  {chain.nextStep || chain.staleReason ? (
                    <div className="runtime-health-action">{chain.nextStep ?? chain.staleReason}</div>
                  ) : null}
                </div>
              </div>
            ))
          ) : (
            <div style={{ padding: 14 }}>
              <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
                Runtime has no waiting, failed, stale, or attention chains.
              </div>
            </div>
          )}
        </div>
      ) : (
        <div style={{ padding: 14 }}>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
            {reachable ? "Waiting for runtime summary…" : "Connect to the daemon to see runtime attention."}
          </div>
        </div>
      )}
      {summary ? (
        <div style={{ padding: "0 14px 14px" }} className="muted">
          active {summary.activeCount} · waiting {summary.waitingCount} · failed {summary.failedCount} · stale {summary.staleCount}
        </div>
      ) : null}
    </div>
  );
}

function ValidationOpsCard({
  report,
  error,
  reachable,
}: {
  report: ValidationOpsReport | null;
  error: string | null;
  reachable: boolean;
}) {
  const gates = report?.readiness.gates ?? [];
  const runs = report?.latestRuns ?? [];
  const baselineStatus = report?.baseline.status;
  return (
    <div className="card">
      <div className="card-hd">
        <Icon name="check" size={13} />
        <h3>Release acceptance</h3>
        <span className={`tag ${validationStatusTone(report?.readiness.status)}`} style={{ marginLeft: "auto" }}>
          {report ? report.readiness.status : reachable ? "admin check" : "offline"}
        </span>
      </div>
      {report ? (
        <>
          <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border-soft)" }}>
            <div className="runtime-health-label">{report.readiness.summary}</div>
            <div className="runtime-health-detail">
              gates {report.readiness.passedGates} passed · {report.readiness.failedGates} failed · {report.readiness.missingGates} missing
            </div>
            <div className="runtime-health-action">next: {report.readiness.nextCommand}</div>
          </div>
          <div style={{ display: "grid" }}>
            {gates.map((gate) => (
              <div key={gate.gateId} className="runtime-health-row">
                <span className={`status-dot ${validationStatusDot(gate.status)}`} />
                <div style={{ minWidth: 0 }}>
                  <div className="runtime-health-label">{gate.title}</div>
                  <div className="runtime-health-detail">{gate.summary}</div>
                  <div className="runtime-health-action">{gate.commandHint}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ padding: "12px 14px", borderTop: "1px solid var(--border-soft)" }}>
            <div className="runtime-health-label">
              Closed loop · {report.closedLoop.closedLoopStatus}
            </div>
            <div className="runtime-health-detail">
              {report.closedLoop.closedLoopCases}/{report.closedLoop.totalCases} closed · measured runs {report.closedLoop.measuredRuns}
            </div>
            <div className="runtime-health-action">baseline: {baselineStatus} · {report.baseline.nextCommand}</div>
          </div>
          {runs.length > 0 ? (
            <div style={{ display: "grid" }}>
              {runs.slice(0, 3).map((run) => (
                <div key={run.runId} className="runtime-health-row">
                  <span className={`status-dot ${validationStatusDot(run.status)}`} />
                  <div style={{ minWidth: 0 }}>
                    <div className="runtime-health-label">{run.title}</div>
                    <div className="runtime-health-detail">
                      {run.runType} · {run.issueCount} issue(s) · {formatRelativeAge(run.completedAt)}
                    </div>
                    {formatValidationRunArtifactPaths(run).map((artifact) => (
                      <div key={`${run.runId}:${artifact.label}`} className="runtime-health-action runtime-artifact-path">
                        {artifact.label}: <span className="mono">{artifact.path}</span>
                      </div>
                    ))}
                    {formatRealAcceptanceCoverageSummary(run) ? (
                      <div className="runtime-health-action">
                        coverage: {formatRealAcceptanceCoverageSummary(run)}
                      </div>
                    ) : null}
                    {formatRealAcceptanceMissionSummary(run) ? (
                      <div className="runtime-health-action">
                        mission report: {formatRealAcceptanceMissionSummary(run)}
                      </div>
                    ) : null}
                    {formatRealAcceptanceNaturalSummary(run) ? (
                      <div className="runtime-health-action">
                        natural report: {formatRealAcceptanceNaturalSummary(run)}
                      </div>
                    ) : null}
                    {run.realAcceptance?.naturalMissionReport?.scenarioProofs?.slice(0, 4).map((proof, proofIndex) => (
                      <div key={`${run.runId}:${proof.scenario}:${proofIndex}`} className="runtime-health-action">
                        natural proof · <span className="mono">{proof.scenario}</span>: {formatNaturalScenarioProofSummary(proof)}
                      </div>
                    ))}
                    {countOrZero(run.realAcceptance?.naturalMissionReport?.scenarioProofs?.length) > 4 ? (
                      <div className="runtime-health-action">
                        natural proof · {countOrZero(run.realAcceptance?.naturalMissionReport?.scenarioProofs?.length) - 4} more scenario(s)
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div style={{ padding: 14 }}>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
            {reachable
              ? `Validation ops are not visible with the current token${error ? ` (${error})` : ""}. Reopen with an admin token to inspect release gates.`
              : "Connect to the daemon to see release acceptance gates."}
          </div>
        </div>
      )}
    </div>
  );
}

function DaemonLogCard({
  logs,
  reachable,
}: {
  logs: DiagnosticsLogs | null;
  reachable: boolean;
}) {
  const lines = logs?.lines ?? [];
  const isLive = reachable && lines.length > 0;
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-hd">
        <h3>Daemon log · tail</h3>
        <span className="mono faint" style={{ fontSize: 10, marginLeft: "auto" }}>
          {isLive
            ? `${lines.length} lines · live${logs?.redacted ? " · redacted" : ""}`
            : reachable
              ? "no log lines yet"
              : "daemon not reachable"}
        </span>
      </div>
      <div>
        {isLive ? (
          lines.slice(-LOG_LIMIT).map((line, i) => (
            <div key={i} className="log-row" style={{ gridTemplateColumns: "1fr" }}>
              <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{line}</span>
            </div>
          ))
        ) : (
          <div className="muted" style={{ padding: 14, fontSize: 12 }}>
            {reachable
              ? "Daemon log tail will appear here as the runtime emits records."
              : "Connect to the daemon to see live logs."}
          </div>
        )}
      </div>
    </div>
  );
}

function TransportCard({ status }: { status: BridgeStatus | null }) {
  // When live, show the actual transport's mode + label on top, and pad
  // with mock standby/idle lines below so the design's three-row layout
  // is preserved.
  const liveMode = status?.transport.mode;
  const health = status?.transport.health;
  const activeDot = health ? (health.healthy ? "done" : "needs_approval") : "working";
  const transportLabel = status?.transport.label ?? "chrome.local · 9222";
  const healthDetail = health
    ? health.healthy
      ? health.connected === false
        ? "healthy · not connected yet"
        : "healthy"
      : health.reason ?? "unhealthy"
    : null;
  return (
    <div className="card">
      <div className="card-hd"><h3>Transport</h3></div>
      <div style={{ padding: 14 }}>
        <div className="row" style={{ gap: 10 }}>
          <span className={`status-dot ${activeDot}`} />
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "var(--font-sans)", fontSize: 12.5, fontWeight: 500 }}>
              {liveMode ?? "direct-CDP available"}
            </div>
            <div className="muted mono" style={{ fontSize: 10.5 }}>
              {transportLabel}{healthDetail ? ` · ${healthDetail}` : ""}
            </div>
          </div>
        </div>
        <div className="row" style={{ gap: 10, marginTop: 10 }}>
          <span className="status-dot planning" />
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "var(--font-sans)", fontSize: 12.5, fontWeight: 500 }}>
              relay · {status?.relay.peerCount ? `${status.relay.peerCount} peer(s)` : "standby"}
            </div>
            <div className="muted mono" style={{ fontSize: 10.5 }}>
              {status?.relay.configured ? "relay configured" : "tk-relay-sea1 · token op"}
            </div>
          </div>
        </div>
        <div className="row" style={{ gap: 10, marginTop: 10 }}>
          <span className="status-dot done" />
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "var(--font-sans)", fontSize: 12.5, fontWeight: 500 }}>local · idle</div>
            <div className="muted mono" style={{ fontSize: 10.5 }}>not in use</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TokensCard() {
  return (
    <div className="card">
      <div className="card-hd">
        <Icon name="key" size={13} />
        <h3>Tokens</h3>
      </div>
      <div style={{ padding: 14, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
        Per-agent token enumeration lands later. For now configure auth
        via the env vars in <code>~/.turnkeyai/config.json</code> (the
        daemon prints accepted scopes at startup).
      </div>
    </div>
  );
}
