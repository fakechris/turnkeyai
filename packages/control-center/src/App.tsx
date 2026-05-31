// Mission Control shell — sidebar + main column with toolbar + page.
//
// The Mission Detail page renders WITHOUT a toolbar because it owns its
// own mission-bar header (with mission title + status). Other pages get
// a breadcrumb toolbar.

import { useEffect, useState } from "react";

import { Sidebar, type SidebarCounts } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import { Icon } from "./components/Icon";
import { NewMissionModal } from "./components/NewMissionModal";
import { useHashRoute } from "./hooks/useHashRoute";
import { AgentConnectPage } from "./pages/AgentConnectPage";
import { AgentsPage } from "./pages/AgentsPage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { ContextSourcesPage } from "./pages/ContextSourcesPage";
import { MissionDetailPage } from "./pages/MissionDetailPage";
import { MissionsPage } from "./pages/MissionsPage";
import { NoTokenPage } from "./pages/NoTokenPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { RuntimePage } from "./pages/RuntimePage";
import { SettingsPage } from "./pages/SettingsPage";
import type { ApprovalRow } from "./api/mission-api";
import {
  useAgents,
  useApprovals,
  useContextSources,
  useMissions,
  useRuntimeSummary,
  useOnboardingState,
} from "./api/useMissionData";
import { useAppState } from "./state/AppState";
import { canUseOperatorActions } from "./state/scopeAccess";

export function App() {
  useHashRoute();
  const { state, openMission } = useAppState();
  const canCreateMission = state.token !== null && canUseOperatorActions(state.scope);
  const openNewMission = () => {
    if (canCreateMission) {
      setNewMissionOpen(true);
    }
  };
  // PR K3.5: the modal is now real — it POSTs /missions and the
  // daemon spawns a linked team-runtime thread. On success we navigate
  // to Mission Detail so the user can watch the coordination engine
  // pick the new mission up.
  const [newMissionOpen, setNewMissionOpen] = useState(false);

  // K3.5: sidebar counts are LIVE (driven by the daemon stores) instead
  // of K1 mock fixtures. Each hook falls back to [] so the page renders
  // immediately and the counts populate as fetches resolve.
  const missions = useMissions([]).value;
  const approvals = useApprovals([]).value;
  const agents = useAgents([]).value;
  const contextSources = useContextSources([]).value;
  const runtimeSummary = useRuntimeSummary(null, { limit: 1 }).value;
  const onboarding = useOnboardingState(null);
  const pendingApprovals = approvals.filter(
    (a) => !a.decision && !state.decisions[a.id]
  );
  const counts: SidebarCounts = {
    missions: missions.filter((m) => m.status !== "archived").length,
    // Approvals: subtract optimistic local decisions while the daemon
    // decision POST refetches, so the sidebar moves immediately.
    approvals: pendingApprovals.length,
    agents: agents.length,
    context: contextSources.length,
    recoveries: runtimeSummary?.attentionCount ?? 0,
  };

  useEffect(() => {
    if (
      state.token !== null &&
      onboarding.isLive &&
      onboarding.value?.completedAt == null &&
      state.route === "missions" &&
      state.scope !== "read"
    ) {
      window.location.hash = "#/onboarding";
    }
  }, [onboarding.isLive, onboarding.value?.completedAt, state.route, state.scope, state.token]);

  if (state.token === null) {
    return (
      <div className="app">
        <Sidebar counts={counts} canCreateMission={false} onNewMission={openNewMission} />
        <div className="main">
          <Toolbar crumbs="home" />
          <div className="content">
            <NoTokenPage />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar counts={counts} canCreateMission={canCreateMission} onNewMission={openNewMission} />
      <div className="main">
        {state.route !== "mission" && <PageToolbar />}
        {pendingApprovals.length > 0 && <ApprovalBanner approvals={pendingApprovals} />}
        <div className="content">
          <RoutedPage onNewMission={openNewMission} />
        </div>
      </div>
      <NewMissionModal
        open={newMissionOpen && canCreateMission}
        onClose={() => setNewMissionOpen(false)}
        onCreated={(missionId) => {
          setNewMissionOpen(false);
          openMission(missionId);
        }}
      />
    </div>
  );
}

function ApprovalBanner({ approvals }: { approvals: ApprovalRow[] }) {
  const highestPriority = approvals.find((approval) => approval.severity === "high") ?? approvals[0];
  const count = approvals.length;
  const mission = highestPriority?.missionTitle ? ` · ${highestPriority.missionTitle}` : "";
  const action = highestPriority?.action ? ` · ${highestPriority.action}` : "";
  const openApprovals = () => {
    window.location.hash = "#/approvals";
  };
  return (
    <div className="approval-banner" role="region" aria-label="Pending approvals">
      <span className="warn-dot" aria-hidden="true" />
      <span>
        {count} pending approval{count === 1 ? "" : "s"} may be blocking agent work
        {mission}
        {action}.
      </span>
      <div className="actions">
        <button type="button" className="btn primary" onClick={openApprovals}>
          <Icon name="approvals" size={13} /> Review approvals
        </button>
      </div>
    </div>
  );
}

function PageToolbar() {
  const { state } = useAppState();
  switch (state.route) {
    case "missions":
      return <Toolbar crumbs="home" title="Missions" right={<SearchSlot />} />;
    case "onboarding":
      return <Toolbar crumbs="home / first-run" right={<SearchSlot />} />;
    case "approvals":
      return <Toolbar crumbs="home / approvals" right={<SearchSlot />} />;
    case "agents":
      return <Toolbar crumbs="home / agents" right={<SearchSlot />} />;
    case "context":
      return <Toolbar crumbs="home / context" right={<SearchSlot />} />;
    case "agent-connect":
      return <Toolbar crumbs="home / agent-connect" right={<SearchSlot />} />;
    case "runtime":
      return <Toolbar crumbs="home / runtime" right={<SearchSlot />} />;
    case "settings":
      return <Toolbar crumbs="home / settings" right={<SearchSlot />} />;
    default:
      return null;
  }
}

function SearchSlot() {
  return (
    <div className="row" style={{ gap: 6 }}>
      <button type="button" className="btn ghost" style={{ padding: "3px 8px" }}>
        <Icon name="search" size={12} /> Search
      </button>
      <span className="kbd">⌘K</span>
    </div>
  );
}

function RoutedPage({ onNewMission }: { onNewMission: () => void }) {
  const { state } = useAppState();
  switch (state.route) {
    case "missions":
      return <MissionsPage onNewMission={onNewMission} />;
    case "onboarding":
      return <OnboardingPage />;
    case "mission": {
      // K3.5: route directly to the selected mission. MissionDetailPage
      // owns the "loading" / "no such mission" empty states.
      if (!state.selectedMissionId) {
        return <MissionsPage onNewMission={onNewMission} />;
      }
      return <MissionDetailPage missionId={state.selectedMissionId} />;
    }
    case "approvals":
      return <ApprovalsPage />;
    case "agents":
      return <AgentsPage />;
    case "context":
      return <ContextSourcesPage />;
    case "agent-connect":
      return <AgentConnectPage />;
    case "runtime":
      return <RuntimePage />;
    case "settings":
      return <SettingsPage />;
    default:
      return <MissionsPage onNewMission={onNewMission} />;
  }
}
