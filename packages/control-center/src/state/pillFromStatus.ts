import type { BridgeStatus, TransportMode } from "../api/types";
import type { ConnectionPill } from "./types";

/**
 * Derives the connection-pill state from a /bridge/status response.
 *
 * Carries over PR F's logic: pill is OK when transport is functioning
 * end-to-end, WARN when transport is set but missing prerequisites
 * (relay with zero peers, direct-cdp without endpoint), BAD only when
 * we can't reach the daemon at all (handled by callers; this fn only
 * runs on a successful fetch).
 */
export function pillFromStatus(status: BridgeStatus): ConnectionPill {
  const mode = status.transport?.mode;
  if (!mode) return { state: "warn", label: "Unknown" };
  if (mode === "relay" && (status.relay?.peerCount ?? 0) === 0) {
    return { state: "warn", label: "Relay — no peers" };
  }
  if (mode === "direct-cdp" && !status.directCdp?.endpoint) {
    return { state: "warn", label: "Direct CDP — no endpoint" };
  }
  return { state: "ok", label: labelForMode(mode) };
}

export function labelForMode(mode: TransportMode | string | undefined): string {
  if (mode === "local") return "Local";
  if (mode === "relay") return "Relay";
  if (mode === "direct-cdp") return "Direct CDP";
  return mode ?? "Unknown";
}
