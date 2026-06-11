// Small reusable display atoms — status tag, agent avatar, agent stack.
// Translated from design's components.jsx.

import type { Agent, ColorTag } from "../mock/mission-data";
import { agentById } from "../mock/mission-data";
import {
  STATUS_LABEL,
  STATUS_TAG,
  type MissionStatus,
} from "../state/types";

// Color tag → CSS var lookup. Mirrors design's COLOR_BG / COLOR_FG so
// callers can pass a semantic color (info/accent/success/warning/danger/muted)
// and get the right background + foreground without inline literals.
export const COLOR_BG: Record<ColorTag, string> = {
  info: "var(--info-soft)",
  accent: "var(--accent-soft)",
  success: "var(--success-soft)",
  warning: "var(--warning-soft)",
  danger: "var(--danger-soft)",
  muted: "var(--muted-soft)",
};
export const COLOR_FG: Record<ColorTag, string> = {
  info: "var(--info)",
  accent: "var(--accent)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
  muted: "var(--text-muted)",
};

/** Pill with a status dot + human label. A non-success closeout overrides
 *  the cheerful "Done" presentation: the flow ended, the goal did not. */
export function StatusTag({
  status,
  closeout,
}: {
  status: MissionStatus;
  closeout?: "bounded_failure" | "approval_timeout";
}) {
  if (status === "done" && closeout) {
    return (
      <span className="tag warning">
        <span className="status-dot blocked" style={{ width: 6, height: 6 }} />
        {closeout === "bounded_failure" ? "Closed · blocked" : "Closed · no approval"}
      </span>
    );
  }
  const tone = STATUS_TAG[status];
  return (
    <span className={"tag " + tone}>
      <span className={"status-dot " + status} style={{ width: 6, height: 6 }} />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Square-rounded avatar showing an agent's 2-char monogram. */
export function AgentAvatar({
  agent,
  size = 24,
}: {
  agent: Agent | undefined;
  size?: number;
}) {
  if (!agent) return null;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 6,
        display: "grid",
        placeItems: "center",
        background: COLOR_BG[agent.color],
        color: COLOR_FG[agent.color],
        fontFamily: "var(--font-sans)",
        fontWeight: 600,
        fontSize: Math.round(size * 0.42),
        flexShrink: 0,
      }}
    >
      {agent.ava}
    </div>
  );
}

/** Stacked circular avatars with a +N tail when over `max`. */
export function AgentStack({ ids, max = 5 }: { ids: string[]; max?: number }) {
  const shown = ids.slice(0, max);
  return (
    <div className="avatars">
      {shown.map((id) => {
        const a = agentById(id);
        if (!a) return null;
        return (
          <div
            key={id}
            className="ava"
            style={{
              background: COLOR_BG[a.color],
              color: COLOR_FG[a.color],
              fontWeight: 600,
            }}
            title={a.name}
          >
            {a.ava}
          </div>
        );
      })}
      {ids.length > max && (
        <div
          className="ava"
          style={{ background: "var(--muted-soft)", color: "var(--text-muted)" }}
        >
          +{ids.length - max}
        </div>
      )}
    </div>
  );
}
