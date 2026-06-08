// Human product shell. The public IA is Chat, Team, Settings, plus the
// work detail view opened from Chat.

import { useEffect, useState } from "react";

import { CommandPalette } from "./components/CommandPalette";
import { Sidebar, type SidebarCounts } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import { NewMissionModal } from "./components/NewMissionModal";
import { useHashRoute } from "./hooks/useHashRoute";
import { AgentConnectPage } from "./pages/AgentConnectPage";
import { AgentsPage } from "./pages/AgentsPage";
import { MissionDetailPage } from "./pages/MissionDetailPage";
import { NoTokenPage } from "./pages/NoTokenPage";
import { SettingsPage } from "./pages/SettingsPage";
import {
  useAgents,
  useMissions,
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

  const agents = useAgents([]).value;
  const missions = useMissions([]).value;
  const counts: SidebarCounts = {
    missions: 0,
    approvals: 0,
    agents: agents.length,
    context: 0,
    recoveries: 0,
  };

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
        <div className="content">
          <RoutedPage />
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
      />
    </div>
  );
}

function RoutedPage() {
  const { state } = useAppState();
  switch (state.route) {
    case "missions":
      return <AgentConnectPage />;
    case "onboarding":
      return <AgentConnectPage />;
    case "mission": {
      // K3.5: route directly to the selected mission. MissionDetailPage
      // owns the "loading" / "no such mission" empty states.
      if (!state.selectedMissionId) {
        return <AgentConnectPage />;
      }
      return <MissionDetailPage missionId={state.selectedMissionId} />;
    }
    case "approvals":
      return <AgentConnectPage />;
    case "agents":
      return <AgentsPage />;
    case "context":
      return <AgentConnectPage />;
    case "agent-connect":
      return <AgentConnectPage />;
    case "runtime":
      return <AgentConnectPage />;
    case "settings":
      return <SettingsPage />;
    default:
      return <AgentConnectPage />;
  }
}
