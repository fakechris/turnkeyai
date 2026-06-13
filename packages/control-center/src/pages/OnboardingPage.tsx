import { useCallback, useState } from "react";

import type { BridgeStatus, DiagnosticsSnapshot, ModelsReport, ValidationOpsReport } from "../api/types";
import { useApiClient } from "../api/useApiClient";
import { Icon } from "../components/Icon";
import { usePolling } from "../hooks/usePolling";
import { useOnboardingState, useUpdateOnboardingState } from "../api/useMissionData";
import { useAppState } from "../state/AppState";

const POLL_MS = 5_000;

interface OnboardingLive {
  diagnostics: DiagnosticsSnapshot | null;
  bridgeStatus: BridgeStatus | null;
  models: ModelsReport | null;
  validationOps: ValidationOpsReport | null;
  validationOpsError: string | null;
  reachable: boolean;
}

type ReadinessState = "ok" | "warn" | "error" | "checking";

interface ReadinessItem {
  id: string;
  label: string;
  state: ReadinessState;
  detail: string;
  action: string;
  command?: string;
}

export function OnboardingPage() {
  const client = useApiClient();
  const { state, setRoute } = useAppState();
  const onboarding = useOnboardingState(null);
  const updateOnboarding = useUpdateOnboardingState();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<OnboardingLive>({
    diagnostics: null,
    bridgeStatus: null,
    models: null,
    validationOps: null,
    validationOpsError: null,
    reachable: false,
  });
  const canWrite = state.scope !== "read";
  const completed = onboarding.value?.completedAt != null;

  usePolling(async () => {
    const shouldFetchValidationOps = state.scope === "admin" || state.scope === "unknown";
    const [diagnosticsResult, bridgeResult, modelsResult, validationOpsResult] = await Promise.allSettled([
      client.get<DiagnosticsSnapshot>("/diagnostics"),
      client.get<BridgeStatus>("/bridge/status"),
      client.get<ModelsReport>("/models"),
      shouldFetchValidationOps
        ? client.getNoAuthReset<ValidationOpsReport>("/validation-ops?limit=3")
        : Promise.resolve(null),
    ]);
    const diagnostics = diagnosticsResult.status === "fulfilled" ? diagnosticsResult.value : null;
    const bridgeStatus = bridgeResult.status === "fulfilled" ? bridgeResult.value : null;
    const models = modelsResult.status === "fulfilled" ? modelsResult.value : null;
    const validationOps = validationOpsResult.status === "fulfilled" ? validationOpsResult.value : null;
    const validationOpsError =
      !shouldFetchValidationOps
        ? "admin token required"
        : validationOpsResult.status === "rejected"
          ? readableOnboardingError(validationOpsResult.reason)
          : null;
    setLive({
      diagnostics,
      bridgeStatus,
      models,
      validationOps,
      validationOpsError,
      reachable: diagnostics != null || bridgeStatus != null || models != null,
    });
  }, POLL_MS);

  const markStep = useCallback(
    async (step: string, complete = false) => {
      if (busy || !canWrite) return;
      setBusy(step);
      setError(null);
      try {
        await updateOnboarding({
          step,
          ...(complete ? { completedAt: Date.now() } : {}),
        });
        onboarding.refetch();
        if (complete) {
          setRoute("missions");
          window.location.hash = "#/missions";
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [busy, canWrite, onboarding, setRoute, updateOnboarding]
  );

  const readinessItems = buildReadinessItems(live, state.scope);
  const readinessState = summarizeReadiness(readinessItems, live.reachable);

  return (
    <div className="page onboarding-page">
      <div className="page-head">
        <div>
          <h2>First run</h2>
          <div className="sub">
            Make sure missions can run, then start real work.
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <span className={"tag " + (completed ? "success" : "warning")}>
            {completed ? "complete" : "setup open"}
          </span>
        </div>
      </div>

      {!canWrite && (
        <div className="card onboarding-scope-card">
          <div className="card-bd">
            This page is opened with a read token. Reopen Mission Control with an operator or admin token to save setup progress.
          </div>
        </div>
      )}

      {error && (
        <div className="subagent-session-error" role="alert">
          {error}
        </div>
      )}

      <ReadinessCard
        items={readinessItems}
        state={readinessState}
        onOpenRuntime={() => {
          setRoute("runtime");
          window.location.hash = "#/runtime";
        }}
        onOpenSettings={() => {
          setRoute("settings");
          window.location.hash = "#/settings";
        }}
        onOpenAgentConnect={() => {
          setRoute("agent-connect");
          window.location.hash = "#/agent-connect";
        }}
      />

      <div className="onboarding-grid">
        <OnboardingStep
          n="1"
          icon="settings"
          title="Models and policy"
          detail="Check the model route that missions will use. Policy and local details are kept here for operators."
          action="Open Models"
          onAction={() => {
            setRoute("settings");
            window.location.hash = "#/settings";
          }}
        />
        <OnboardingStep
          n="2"
          icon="connect"
          title="How you will use it"
          detail="Start in this app, or add another AI app or browser access only when your workflow needs it."
          action="Open Start"
          onAction={() => {
            setRoute("agent-connect");
            window.location.hash = "#/agent-connect";
          }}
        />
        <OnboardingStep
          n="3"
          icon="missions"
          title="Run a real mission"
          detail="Create a mission, watch the trace, inspect evidence, and use follow-up when the quality gate needs attention."
          action="Open Tasks"
          onAction={() => {
            setRoute("missions");
            window.location.hash = "#/missions";
          }}
        />
      </div>

      <section className="card onboarding-state-card">
        <div className="subagent-session-head">
          <div>
            <div className="label" style={{ fontSize: 11 }}>Setup marker</div>
            <div className="muted" style={{ fontSize: 11.5 }}>
              Stored locally in the daemon runtime root; does not change auth or browser transport settings.
            </div>
          </div>
          <button
            type="button"
            className="btn primary"
            disabled={!canWrite || busy !== null}
            onClick={() => void markStep("ready", true)}
          >
            <Icon name="check" size={13} /> {busy === "ready" ? "Saving..." : "Finish setup"}
          </button>
        </div>
        <div className="onboarding-state-row">
          <span>Current step</span>
          <b>{onboarding.value?.step ?? "not started"}</b>
        </div>
        <div className="onboarding-state-row">
          <span>Transport chosen</span>
          <b>{onboarding.value?.transportChosen ?? "not recorded"}</b>
        </div>
        <div className="onboarding-state-row">
          <span>Completed</span>
          <b>{onboarding.value?.completedAt ? "yes" : "no"}</b>
        </div>
        <div className="onboarding-state-actions">
          <button
            type="button"
            className="btn"
            disabled={!canWrite || busy !== null}
            onClick={() => void markStep("reviewed-runtime")}
          >
            Mark diagnostics reviewed
          </button>
          <button
            type="button"
            className="btn"
            disabled={!canWrite || busy !== null}
            onClick={() => void markStep("reviewed-agent-connect")}
          >
            Mark setup reviewed
          </button>
        </div>
      </section>
    </div>
  );
}

function ReadinessCard({
  items,
  state,
  onOpenRuntime,
  onOpenSettings,
  onOpenAgentConnect,
}: {
  items: ReadinessItem[];
  state: ReadinessState;
  onOpenRuntime: () => void;
  onOpenSettings: () => void;
  onOpenAgentConnect: () => void;
}) {
  return (
    <section className="card onboarding-readiness-card">
      <div className="card-hd">
        <Icon name="diagnose" size={13} />
        <h3>Production readiness</h3>
        <span className={`tag ${readinessTagTone(state)}`} style={{ marginLeft: "auto" }}>
          {readinessLabel(state)}
        </span>
      </div>
      <div className="onboarding-readiness-list">
        {items.map((item) => (
          <div key={item.id} className="onboarding-readiness-row" data-state={item.state}>
            <span className={`status-dot ${readinessDot(item.state)}`} />
            <div className="onboarding-readiness-main">
              <div className="onboarding-readiness-label">{item.label}</div>
              <div className="onboarding-readiness-detail">{item.detail}</div>
              <div className="onboarding-readiness-action">{item.action}</div>
              {item.command ? <code className="onboarding-readiness-command">{item.command}</code> : null}
            </div>
          </div>
        ))}
      </div>
      <div className="onboarding-readiness-actions">
        <button type="button" className="btn" onClick={onOpenRuntime}>
          <Icon name="runtime" size={13} /> Diagnostics
        </button>
        <button type="button" className="btn" onClick={onOpenSettings}>
          <Icon name="settings" size={13} /> Models
        </button>
        <button type="button" className="btn" onClick={onOpenAgentConnect}>
          <Icon name="play" size={13} /> Start
        </button>
      </div>
    </section>
  );
}

function OnboardingStep({
  n,
  icon,
  title,
  detail,
  action,
  onAction,
}: {
  n: string;
  icon: "runtime" | "browser" | "missions" | "connect" | "settings";
  title: string;
  detail: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <section className="card onboarding-step">
      <div className="onboarding-step-index">{n}</div>
      <div className="onboarding-step-icon">
        <Icon name={icon} size={18} />
      </div>
      <h3>{title}</h3>
      <p>{detail}</p>
      <button type="button" className="btn" onClick={onAction}>
        {action}
      </button>
    </section>
  );
}

function buildReadinessItems(live: OnboardingLive, scope: string): ReadinessItem[] {
  return [
    daemonReadiness(live),
    modelReadiness(live.models),
    bridgeReadiness(live.bridgeStatus),
    acceptanceReadiness(live.validationOps, live.validationOpsError, scope),
  ];
}

function daemonReadiness(live: OnboardingLive): ReadinessItem {
  const diagnostics = live.diagnostics;
  if (!diagnostics) {
    return {
      id: "daemon",
      label: "Daemon reachable",
      state: live.reachable ? "warn" : "checking",
      detail: live.reachable ? "Partial daemon data is available." : "Waiting for the local daemon.",
      action: "Start the app launcher or verify the daemon process.",
      command: "npm run app -- --no-open",
    };
  }
  const authMode = diagnostics.daemon.authMode;
  return {
    id: "daemon",
    label: "Daemon reachable",
    state: authMode === "disabled" ? "warn" : "ok",
    detail: `v${diagnostics.daemon.version} on port ${diagnostics.daemon.port} · auth ${authMode}`,
    action: diagnostics.readiness?.status === "error"
      ? "Open Diagnostics and clear blocking setup checks."
      : "Local service health is live.",
    command: "npm run daemon:status",
  };
}

function modelReadiness(models: ModelsReport | null): ReadinessItem {
  if (!models) {
    return {
      id: "models",
      label: "Default model route",
      state: "checking",
      detail: "Waiting for /models.",
      action: "Configure a model catalog before production missions.",
      command: "models.local.json",
    };
  }
  const selection = models.defaultSelection;
  if (!selection?.ok || !selection.primaryModelId) {
    return {
      id: "models",
      label: "Default model route",
      state: "error",
      detail: selection?.error ?? "No default model selection is available.",
      action: "Open Models and fix the default route.",
      command: "npm run acceptance:real -- --model-catalog models.local.json",
    };
  }
  const primary = models.models.find((model) => model.id === selection.primaryModelId);
  const missingFallbacks = (selection.fallbackModelIds ?? []).filter((id) => {
    const model = models.models.find((candidate) => candidate.id === id);
    return model && !model.configured;
  });
  const state: ReadinessState = primary?.configured ? (missingFallbacks.length > 0 ? "warn" : "ok") : "error";
  return {
    id: "models",
    label: "Default model route",
    state,
    detail: selection.chainId
      ? `${selection.chainId}: ${selection.primaryModelId}${selection.fallbackModelIds?.length ? ` -> ${selection.fallbackModelIds.join(" -> ")}` : ""}`
      : selection.primaryModelId,
    action: primary?.configured
      ? missingFallbacks.length > 0
        ? `Primary is configured; ${missingFallbacks.length} fallback key(s) still missing.`
        : "Primary and fallback route are configured."
      : `Set ${primary?.apiKeyEnv ?? "the primary model API key"} before running real missions.`,
    command: "npm run acceptance:real -- --model-catalog models.local.json",
  };
}

export function bridgeReadiness(status: BridgeStatus | null): ReadinessItem {
  if (!status) {
    return {
      id: "bridge",
      label: "Start path",
      state: "checking",
      detail: "Waiting for /bridge/status.",
      action: "Open Start to begin work; use the advanced section only if you need another AI app or browser access.",
    };
  }
  const health = status.transport.health;
  const healthLabel = health
    ? health.healthy
      ? "healthy"
      : health.reason ?? "unhealthy"
    : "health not reported";
  const state: ReadinessState =
    !status.ok || health?.healthy === false
      ? "error"
      : status.expertLane.available
        ? "ok"
        : "warn";
  return {
    id: "bridge",
    label: "Start path",
    state,
    detail: `${status.transport.mode} · ${status.transport.label} · ${healthLabel} · ${status.sessions.count} session(s)`,
    action: !status.ok
      ? "Start is not healthy; open Start first, then Diagnostics if it still fails."
      : health?.healthy === false
      ? "Transport needs attention before browser-backed missions."
      : status.expertLane.available
      ? "Browser access is available."
      : status.expertLane.reason ?? "Start is reachable; browser access is not available on this transport.",
    command: status.directCdp.endpoint ?? "turnkeyai bridge status",
  };
}

function acceptanceReadiness(
  report: ValidationOpsReport | null,
  error: string | null,
  scope: string
): ReadinessItem {
  if (report) {
    const gate = report.readiness.gates.find((candidate) => candidate.gateId === "real-llm-acceptance");
    return {
      id: "acceptance",
      label: "Real acceptance gate",
      state: report.readiness.status === "passed" ? "ok" : report.readiness.status === "failed" ? "error" : "warn",
      detail: gate?.summary ?? report.readiness.summary,
      action: report.readiness.nextCommand ? `Next validation: ${report.readiness.nextCommand}` : "Validation ops are recorded.",
      command: gate?.commandHint ?? "npm run acceptance:real -- --model-catalog models.local.json",
    };
  }
  return {
    id: "acceptance",
    label: "Real acceptance gate",
    state: scope === "admin" ? "checking" : "warn",
    detail: error ? `Validation ops not visible: ${error}.` : "Waiting for validation ops.",
    action: scope === "admin"
      ? "Wait for the first validation poll."
      : "Use an admin token before release to inspect recorded real LLM acceptance.",
    command: "npm run acceptance:real -- --model-catalog models.local.json",
  };
}

function summarizeReadiness(items: ReadinessItem[], reachable: boolean): ReadinessState {
  if (!reachable) return "checking";
  if (items.some((item) => item.state === "error")) return "error";
  if (items.some((item) => item.state === "warn" || item.state === "checking")) return "warn";
  return "ok";
}

function readinessTagTone(state: ReadinessState): string {
  if (state === "ok") return "success";
  if (state === "error") return "danger";
  if (state === "warn") return "warning";
  return "info";
}

function readinessLabel(state: ReadinessState): string {
  if (state === "ok") return "ready";
  if (state === "error") return "blocked";
  if (state === "warn") return "needs attention";
  return "checking";
}

function readinessDot(state: ReadinessState): string {
  if (state === "ok") return "done";
  if (state === "error") return "blocked";
  if (state === "warn") return "needs_approval";
  return "planning";
}

function readableOnboardingError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "request failed";
}
