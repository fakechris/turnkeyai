import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { AppStateProvider } from "./state/AppState";
import "./styles/app.css";

// No-flash theme boot (Lumen pattern). Resolve the saved theme — or the OS
// preference on first run — before first paint so CSS variables settle and
// the user never sees an unstyled flash. Default is Atelier (light); Vault
// (dark) is opt-in. ThemeToggle persists the choice to localStorage.
(function bootTheme() {
  let theme: string | null = null;
  try {
    theme =
      localStorage.getItem("turnkey-theme") ?? localStorage.getItem("lumen-theme");
  } catch {
    theme = null;
  }
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  document.documentElement.setAttribute("data-theme", theme);
})();

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
