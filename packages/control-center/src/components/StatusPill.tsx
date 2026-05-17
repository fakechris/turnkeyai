import type { ConnectionPill } from "../state/types";

export function StatusPill({ pill }: { pill: ConnectionPill }) {
  return (
    <div className="status-pill" data-state={pill.state}>
      <span className="dot" />
      <span className="label">{pill.label}</span>
    </div>
  );
}
