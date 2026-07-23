// Atelier (light) ↔ Vault (dark) toggle. Flips data-theme on <html> and
// persists to localStorage; the no-flash boot in main.tsx reads it back.
// Quiet-utility ethos: hover tints, no movement — a plain icon control.

import { useEffect, useState } from "react";

import { Icon } from "./Icon";

type Theme = "light" | "dark";

function currentTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "light";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("turnkey-theme", theme);
    } catch {
      /* private mode / storage disabled — theme still applies for the session */
    }
  }, [theme]);

  const next: Theme = theme === "light" ? "dark" : "light";
  return (
    <button
      type="button"
      className="theme-toggle"
      title={theme === "light" ? "Switch to Vault (dark)" : "Switch to Atelier (light)"}
      aria-label="Toggle theme"
      onClick={() => setTheme(next)}
    >
      <Icon name={theme === "light" ? "moon" : "sun"} size={15} />
    </button>
  );
}
