// Mission Control shell — sidebar + main column with toolbar + page.
//
// The Mission Detail page renders WITHOUT a toolbar because it owns its
// own mission-bar header (with mission title + status). Other pages get
// a breadcrumb toolbar.

import { useMemo, useState } from "react";

import { Sidebar, type SidebarCounts } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import { Icon } from "./components/Icon";
import { useHashRoute } from "./hooks/useHashRoute";
import { AgentConnectPage } from "./pages/AgentConnectPage";
import { AgentsPage } from "./pages/AgentsPage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { ContextSourcesPage } from "./pages/ContextSourcesPage";
import { MissionDetailPage } from "./pages/MissionDetailPage";
import { MissionsPage } from "./pages/MissionsPage";
import { NoTokenPage } from "./pages/NoTokenPage";
import { RuntimePage } from "./pages/RuntimePage";
import { SettingsPage } from "./pages/SettingsPage";
import { MOCK_DATA, missionById } from "./mock/mission-data";
import { useAppState } from "./state/AppState";

export function App() {
  useHashRoute();
  const { state } = useAppState();
  // Coming-soon "New mission" modal — placeholder for K2. K1 doesn't
  // ship the modal because mission creation needs a real backing store.
  const [, setNewMissionOpen] = useState(false);

  // Memoized because App re-renders on every AppState change (route,
  // pill updates from polling, etc.) but counts only actually move when
  // a decision is recorded. Mock data is module-static, so depend on
  // state.decisions and ignore the rest. (Gemini K1 review.)
  const counts: SidebarCounts = useMemo(
    () => ({
      missions: MOCK_DATA.missions.filter((m) => m.status !== "archived").length,
      approvals: MOCK_DATA.approvals.filter((a) => !state.decisions[a.id]).length,
      agents: MOCK_DATA.agents.length,
      context: MOCK_DATA.contextSources.length,
      recoveries: MOCK_DATA.recoveries.length,
    }),
    [state.decisions]
  );

  if (state.token === null) {
    return (
      <div className="app">
        <Sidebar counts={counts} onNewMission={() => setNewMissionOpen(true)} />
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
      <Sidebar counts={counts} onNewMission={() => setNewMissionOpen(true)} />
      <div className="main">
        {state.route !== "mission" && <PageToolbar />}
        <div className="content">
          <RoutedPage />
        </div>
      </div>
    </div>
  );
}

function PageToolbar() {
  const { state } = useAppState();
  switch (state.route) {
    case "missions":
      return <Toolbar crumbs="home" title="Missions" right={<SearchSlot />} />;
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

function RoutedPage() {
  const { state, openMission } = useAppState();
  switch (state.route) {
    case "missions":
      return (
        <MissionsPage
          onNewMission={() => {
            // K1: no modal yet — open the first existing mission so the
            // user can at least see Mission Detail.
            const first = MOCK_DATA.missions[0];
            if (first) openMission(first.id);
          }}
        />
      );
    case "mission": {
      // Default to msn.01 if user landed on /#/mission without picking
      // one (e.g. via URL or after sidebar nav).
      const id = state.selectedMissionId ?? "msn.01";
      const exists = missionById(id);
      return <MissionDetailPage missionId={exists ? id : "msn.01"} />;
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
      return <MissionsPage onNewMission={() => undefined} />;
  }
}
