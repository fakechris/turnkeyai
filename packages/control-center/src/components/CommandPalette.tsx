import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { Mission } from "../api/mission-api";
import { useAppState } from "../state/AppState";
import type { Route } from "../state/types";
import { Icon } from "./Icon";

interface CommandPaletteItem {
  id: string;
  label: string;
  detail: string;
  kind: "page" | "mission" | "action";
  run: () => void;
}

const PAGE_COMMANDS: Array<{ route: Route; label: string; detail: string }> = [
  { route: "missions", label: "Missions", detail: "All active work and mission status" },
  { route: "approvals", label: "Approvals", detail: "Permission-gated actions waiting for a decision" },
  { route: "agents", label: "Agents", detail: "Runtime roles and connected agents" },
  { route: "context", label: "Context sources", detail: "Documents, browser sessions, and mission evidence sources" },
  { route: "agent-connect", label: "Agent Connect", detail: "Bridge endpoint and tool capability setup" },
  { route: "runtime", label: "Runtime", detail: "Diagnostics, recovery, logs, and active worker state" },
  { route: "settings", label: "Settings", detail: "Local model, browser, policy, and data-path configuration" },
  { route: "onboarding", label: "First-run setup", detail: "Setup checklist for model and browser readiness" },
];

export function CommandPalette({
  open,
  missions,
  canCreateMission,
  onClose,
  onNewMission,
}: {
  open: boolean;
  missions: Mission[];
  canCreateMission: boolean;
  onClose: () => void;
  onNewMission: () => void;
}) {
  const { setRoute, openMission } = useAppState();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const items = useMemo<CommandPaletteItem[]>(() => {
    const pageItems = PAGE_COMMANDS.map((item) => ({
      id: `page:${item.route}`,
      label: item.label,
      detail: item.detail,
      kind: "page" as const,
      run: () => {
        setRoute(item.route);
        window.location.hash = `#/${item.route}`;
      },
    }));
    const missionItems = missions
      .filter((mission) => mission.status !== "archived")
      .slice(0, 12)
      .map((mission) => ({
        id: `mission:${mission.id}`,
        label: mission.title,
        detail: `${mission.shortId} · ${mission.status.replace("_", " ")} · ${mission.modeLabel}`,
        kind: "mission" as const,
        run: () => openMission(mission.id),
      }));
    const actionItems = canCreateMission
      ? [{
          id: "action:new-mission",
          label: "New mission",
          detail: "Create a mission from a natural-language request",
          kind: "action" as const,
          run: onNewMission,
        }]
      : [];
    return [...actionItems, ...pageItems, ...missionItems];
  }, [canCreateMission, missions, onNewMission, openMission, setRoute]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items
      .map((item) => ({ item, rank: commandSearchRank(item, needle) }))
      .filter((entry) => entry.rank !== null)
      .sort((a, b) => a.rank! - b.rank! || a.item.label.localeCompare(b.item.label))
      .map((entry) => entry.item);
  }, [items, query]);
  const visibleItems = filtered.slice(0, 16);

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(visibleItems.length - 1, 0)));
  }, [visibleItems.length]);

  if (!open) return null;

  const runItem = (item: CommandPaletteItem | undefined) => {
    if (!item) return;
    item.run();
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, Math.max(visibleItems.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      runItem(visibleItems[activeIndex]);
    }
  };

  return (
    <div className="command-palette-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-palette-search">
          <Icon name="search" size={14} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search pages and missions"
            aria-label="Search pages and missions"
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="command-palette-list" role="listbox" aria-label="Command results">
          {visibleItems.length === 0 ? (
            <div className="command-palette-empty">No matching pages or missions.</div>
          ) : (
            visibleItems.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className="command-palette-item"
                data-active={index === activeIndex}
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => runItem(item)}
              >
                <span className="command-palette-kind">{item.kind}</span>
                <span className="command-palette-main">
                  <b>{item.label}</b>
                  <span>{item.detail}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function commandSearchRank(item: CommandPaletteItem, needle: string): number | null {
  const label = item.label.toLowerCase();
  const detail = item.detail.toLowerCase();
  const kind = item.kind.toLowerCase();
  if (label === needle) return 0;
  if (label.startsWith(needle)) return 1;
  if (label.includes(needle)) return 2;
  if (detail.includes(needle)) return 3;
  if (kind.includes(needle)) return 4;
  return null;
}
