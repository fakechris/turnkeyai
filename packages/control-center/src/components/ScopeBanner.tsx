import type { ReactNode } from "react";

import type { Scope } from "../state/types";

/**
 * The Agent Connect scope banner. Renders a different message based on
 * the token's resolved scope. Uses DOM-node composition (not innerHTML)
 * to avoid the XSS footgun caught by codex during PR I.
 */

interface BannerSpec {
  kind: "ok" | "warn";
  segments: ReactNode[];
}

const BANNERS: Partial<Record<Scope, BannerSpec>> = {
  admin: {
    kind: "ok",
    segments: [
      <strong key="lead">Heads up:</strong>,
      " this token has admin scope. Prefer a ",
      <code key="env">TURNKEYAI_DAEMON_OPERATOR_TOKEN</code>,
      " if you only need to drive the browser — admin tokens can call validation and relay-admin routes the dashboard never needs.",
    ],
  },
  read: {
    kind: "warn",
    segments: [
      <strong key="lead">Read-only token.</strong>,
      " The ",
      <code key="path">POST /bridge/command</code>,
      " snippet would 401 with this token, so it is hidden. To plug an agent in, set ",
      <code key="env">TURNKEYAI_DAEMON_OPERATOR_TOKEN</code>,
      " and restart the daemon, then re-run ",
      <code key="cli">turnkeyai app</code>,
      ".",
    ],
  },
};

export function ScopeBanner({ scope }: { scope: Scope }) {
  const banner = BANNERS[scope];
  if (!banner) return null;
  return <div className={`scope-banner scope-${banner.kind}`}>{banner.segments}</div>;
}

const SUMMARIES: Record<Scope, string> = {
  operator: "operator — can call /bridge/command + browser routes",
  admin: "admin — can call everything (validation/relay/admin routes too)",
  read: "read — inspection only, cannot drive the browser",
  unknown: "unknown — single-token setup (assumed to grant full access)",
};

export function scopeSummary(scope: Scope): string {
  return SUMMARIES[scope];
}
