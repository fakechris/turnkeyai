// Mission Control shell — sidebar + main column with toolbar + page.
//
// The Mission Detail page renders WITHOUT a toolbar because it owns its
// own mission-bar header (with mission title + status). Other pages get
// a breadcrumb toolbar.

import { useEffect, useState } from "react";

import { CommandPalette } from "./components/CommandPalette";
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
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // K3.5: sidebar counts are LIVE (driven by the daemon stores) instead
  // of K1 mock fixtures. Each hook falls back to [] so the page renders
  // immediately and the counts populate as fetches resolve.
  const missions = useMissions([]).value;
  const approvals = useApprovals([]).value;
  const agents = useAgents([]).value;
  const contextSources = useContextSources([]).value;
  const runtimeSummary = useRuntimeSummary(null, { limit: 1 }).value;
  const onboarding = useOnboardingState(null);
  const counts: SidebarCounts = {
    missions: missions.filter((m) => m.status !== "archived").length,
    // Approvals: subtract optimistic local decisions while the daemon
    // decision POST refetches, so the sidebar moves immediately.
    approvals: approvals.filter(
      (a) => !a.decision && !state.decisions[a.id]
    ).length,
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

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      setCommandPaletteOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
        {state.route !== "mission" && <PageToolbar onOpenCommandPalette={() => setCommandPaletteOpen(true)} />}
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
      <CommandPalette
        open={commandPaletteOpen}
        missions={missions}
        canCreateMission={canCreateMission}
        onClose={() => setCommandPaletteOpen(false)}
        onNewMission={openNewMission}
      />
    </div>
  );
}

function PageToolbar({ onOpenCommandPalette }: { onOpenCommandPalette: () => void }) {
  const { state } = useAppState();
  switch (state.route) {
    case "missions":
      return <Toolbar crumbs="home" title="Missions" right={<SearchSlot onOpen={onOpenCommandPalette} />} />;
    case "onboarding":
      return <Toolbar crumbs="home / first-run" right={<SearchSlot onOpen={onOpenCommandPalette} />} />;
    case "approvals":
      return <Toolbar crumbs="home / approvals" right={<SearchSlot onOpen={onOpenCommandPalette} />} />;
    case "agents":
      return <Toolbar crumbs="home / agents" right={<SearchSlot onOpen={onOpenCommandPalette} />} />;
    case "context":
      return <Toolbar crumbs="home / context" right={<SearchSlot onOpen={onOpenCommandPalette} />} />;
    case "agent-connect":
      return <Toolbar crumbs="home / agent-connect" right={<SearchSlot onOpen={onOpenCommandPalette} />} />;
    case "runtime":
      return <Toolbar crumbs="home / runtime" right={<SearchSlot onOpen={onOpenCommandPalette} />} />;
    case "settings":
      return <Toolbar crumbs="home / settings" right={<SearchSlot onOpen={onOpenCommandPalette} />} />;
    default:
      return null;
  }
}

function SearchSlot({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="row" style={{ gap: 6 }}>
      <button
        type="button"
        className="btn ghost"
        style={{ padding: "3px 8px" }}
        aria-label="Open command palette"
        onClick={onOpen}
      >
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
