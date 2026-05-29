import { useCallback, useState } from "react";

import { Icon } from "../components/Icon";
import { useOnboardingState, useUpdateOnboardingState } from "../api/useMissionData";
import { useAppState } from "../state/AppState";

export function OnboardingPage() {
  const { state, setRoute } = useAppState();
  const onboarding = useOnboardingState(null);
  const updateOnboarding = useUpdateOnboardingState();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canWrite = state.scope !== "read";
  const completed = onboarding.value?.completedAt != null;

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

  return (
    <div className="page onboarding-page">
      <div className="page-head">
        <div>
          <h2>First run</h2>
          <div className="sub">
            Connect the local daemon, verify the browser bridge, then start a mission.
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

      <div className="onboarding-grid">
        <OnboardingStep
          n="1"
          icon="runtime"
          title="Daemon and token"
          detail="The page is already authenticated when opened through the app launcher. Runtime shows setup health, logs, and stalled work."
          action="Open Runtime"
          onAction={() => {
            setRoute("runtime");
            window.location.hash = "#/runtime";
          }}
        />
        <OnboardingStep
          n="2"
          icon="browser"
          title="Browser bridge"
          detail="Use Settings and Agent Connect to verify transport mode, bridge status, and tool capability exposure before asking an agent to browse."
          action="Open Agent Connect"
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
          action="Open Missions"
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
            Mark runtime reviewed
          </button>
          <button
            type="button"
            className="btn"
            disabled={!canWrite || busy !== null}
            onClick={() => void markStep("reviewed-agent-connect")}
          >
            Mark bridge reviewed
          </button>
        </div>
      </section>
    </div>
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
  icon: "runtime" | "browser" | "missions";
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
