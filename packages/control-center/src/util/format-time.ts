// Client-side time formatters (PR K3).
//
// The daemon emits raw monotonic timestamps (tMs, lastUseAtMs) and
// leaves the display-string fields blank for server-generated records
// (general rule: client owns localized formatting). These helpers turn
// those timestamps into the HH:MM:SS / "Xm ago" strings the dashboard
// shows. K2 demo fixtures continue to ship pre-formatted strings; the
// callers use `event.t ?? formatTimeOfDay(event.tMs)` so both shapes
// render identically.

export function formatTimeOfDay(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function formatRelativeAgo(epochMs: number, nowMs: number = Date.now()): string {
  const ageMs = Math.max(0, nowMs - epochMs);
  if (ageMs < 1000) return "just now";
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
