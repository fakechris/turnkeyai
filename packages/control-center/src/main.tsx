import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { AppStateProvider } from "./state/AppState";
import "./styles/app.css";

// Default to the "calm modern" light theme. data-theme="dark" can be
// toggled by user setting later (K3 Settings page). We set it here once
// so CSS variables resolve before first paint and the user never sees
// an unstyled flash.
document.documentElement.setAttribute("data-theme", "light");

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Mission Control: #root element missing in index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <AppStateProvider>
      <App />
    </AppStateProvider>
  </StrictMode>
);
