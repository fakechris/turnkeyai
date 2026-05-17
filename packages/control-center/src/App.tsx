import { TopBar } from "./components/TopBar";
import { useHashRoute } from "./hooks/useHashRoute";
import { AgentConnectPage } from "./pages/AgentConnectPage";
import { BridgePage } from "./pages/BridgePage";
import { DiagnosticsPage } from "./pages/DiagnosticsPage";
import { NoTokenPage } from "./pages/NoTokenPage";
import { SetupPage } from "./pages/SetupPage";
import { TabsPage } from "./pages/TabsPage";
import { useAppState } from "./state/AppState";
import type { Route } from "./state/types";

const ROUTE_RENDERERS: Record<Route, () => JSX.Element> = {
  setup: () => <SetupPage />,
  bridge: () => <BridgePage />,
  tabs: () => <TabsPage />,
  agent: () => <AgentConnectPage />,
  diagnostics: () => <DiagnosticsPage />,
};

export function App() {
  useHashRoute();
  const { state } = useAppState();

  return (
    <>
      <TopBar />
      <main className="page" aria-live="polite">
        {state.token === null ? <NoTokenPage /> : ROUTE_RENDERERS[state.route]()}
      </main>
    </>
  );
}
