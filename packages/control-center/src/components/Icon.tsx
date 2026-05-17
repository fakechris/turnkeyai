// Single-stroke icon set translated 1:1 from the design's components.jsx.
// Adding new icons: keep stroke=1.6, no fills (except where a dot/marker
// needs one), viewBox=0 0 24 24. Avoid pulling in lucide / heroicons —
// keeps the bundle small and the visual rhythm consistent with the design.

export type IconName =
  | "missions" | "agents" | "context" | "approvals" | "connect" | "runtime" | "settings"
  | "search" | "plus" | "filter" | "chevron" | "chevron-d"
  | "browser" | "doc" | "folder" | "api" | "desktop"
  | "warning" | "check" | "x" | "more"
  | "play" | "pause" | "refresh" | "external"
  | "camera" | "snapshot" | "key" | "shield" | "diagnose" | "user";

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  const p = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "missions": return <svg {...p}><path d="M4 6h10"/><path d="M4 12h16"/><path d="M4 18h7"/><circle cx="18" cy="6" r="2"/></svg>;
    case "agents": return <svg {...p}><circle cx="9" cy="9" r="3.2"/><path d="M3 19c1.6-3 4-4.5 6-4.5s4.4 1.5 6 4.5"/><path d="M16 4l1.4 2.6L20 8l-2.6 1.4L16 12l-1.4-2.6L12 8l2.6-1.4z"/></svg>;
    case "context": return <svg {...p}><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 9h18"/><circle cx="7" cy="6.5" r=".5" fill="currentColor"/></svg>;
    case "approvals": return <svg {...p}><path d="M5 12l4 4 10-10"/><circle cx="12" cy="12" r="9"/></svg>;
    case "connect": return <svg {...p}><circle cx="7" cy="12" r="3"/><circle cx="17" cy="12" r="3"/><path d="M10 12h4"/></svg>;
    case "runtime": return <svg {...p}><path d="M4 7l4 4-4 4"/><path d="M11 17h9"/></svg>;
    case "settings": return <svg {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2-1.5-2-3.5-2.4 1a7.5 7.5 0 0 0-1.7-1l-.4-2.6h-4l-.4 2.6a7.5 7.5 0 0 0-1.7 1l-2.4-1-2 3.5L4.6 11a7.5 7.5 0 0 0 0 2l-2 1.5 2 3.5 2.4-1c.5.4 1.1.7 1.7 1l.4 2.6h4l.4-2.6a7.5 7.5 0 0 0 1.7-1l2.4 1 2-3.5z"/></svg>;
    case "search": return <svg {...p}><circle cx="11" cy="11" r="6"/><path d="m20 20-4-4"/></svg>;
    case "plus": return <svg {...p}><path d="M12 5v14M5 12h14"/></svg>;
    case "filter": return <svg {...p}><path d="M4 5h16l-6 8v6l-4-2v-4z"/></svg>;
    case "chevron": return <svg {...p}><path d="m9 6 6 6-6 6"/></svg>;
    case "chevron-d": return <svg {...p}><path d="m6 9 6 6 6-6"/></svg>;
    case "browser": return <svg {...p}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><circle cx="6" cy="6.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="6.5" r=".5" fill="currentColor"/></svg>;
    case "doc": return <svg {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M8 13h8M8 17h5"/></svg>;
    case "folder": return <svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>;
    case "api": return <svg {...p}><path d="M4 7h7M4 12h12M4 17h7"/><circle cx="17" cy="7" r="2"/><circle cx="19" cy="17" r="2"/></svg>;
    case "desktop": return <svg {...p}><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>;
    case "warning": return <svg {...p}><path d="M12 3 2 20h20z"/><path d="M12 10v5M12 18h.01"/></svg>;
    case "check": return <svg {...p}><path d="m5 12 5 5 9-12"/></svg>;
    case "x": return <svg {...p}><path d="M6 6l12 12M18 6 6 18"/></svg>;
    case "more": return <svg {...p}><circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/></svg>;
    case "play": return <svg {...p}><path d="m7 5 12 7-12 7z"/></svg>;
    case "pause": return <svg {...p}><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>;
    case "refresh": return <svg {...p}><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 4v4h-4"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 20v-4h4"/></svg>;
    case "external": return <svg {...p}><path d="M14 4h6v6M10 14 20 4M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/></svg>;
    case "camera": return <svg {...p}><path d="M4 7h3l2-2h6l2 2h3v12H4z"/><circle cx="12" cy="13" r="3.5"/></svg>;
    case "snapshot": return <svg {...p}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18M7 12h10M7 16h7"/></svg>;
    case "key": return <svg {...p}><circle cx="8" cy="14" r="4"/><path d="m11 11 9-9M16 6l2 2M19 3l2 2"/></svg>;
    case "shield": return <svg {...p}><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg>;
    case "diagnose": return <svg {...p}><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>;
    case "user": return <svg {...p}><circle cx="12" cy="8" r="4"/><path d="M4 20c1.6-4 4.6-6 8-6s6.4 2 8 6"/></svg>;
  }
}

export function CtxIcon({ kind }: { kind: "browser" | "doc" | "folder" | "api" | "desktop" }) {
  return <Icon name={kind} size={14} />;
}
