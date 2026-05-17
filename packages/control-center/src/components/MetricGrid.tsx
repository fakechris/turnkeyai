import type { ReactNode } from "react";

export interface MetricCell {
  key: string;
  label: ReactNode;
  value: ReactNode;
  tone?: "ok" | "warn" | "bad";
}

/** Auto-fit grid of metric cards. Matches the `.metric-grid` style. */
export function MetricGrid({ metrics }: { metrics: readonly MetricCell[] }) {
  return (
    <div className="metric-grid">
      {metrics.map((m) => (
        <div className="metric" key={m.key}>
          <div className="metric-label">{m.label}</div>
          <div className={`metric-value${m.tone ? ` ${m.tone}` : ""}`}>{m.value}</div>
        </div>
      ))}
    </div>
  );
}
