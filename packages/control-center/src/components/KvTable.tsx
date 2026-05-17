import type { ReactNode } from "react";

export interface KvRow {
  /** Stable key for React reconciliation. Often equal to `label`. */
  key: string;
  label: ReactNode;
  value: ReactNode;
}

/**
 * Two-column key/value table that matches the `.kv` style. Used by Setup,
 * Bridge Direct-CDP, Agent Connect Endpoints, Diagnostics paths/runtime.
 *
 * Rows can carry rich ReactNodes for both label and value so callers can
 * embed <code>, links, or status badges without forking the component.
 */
export function KvTable({ rows }: { rows: readonly KvRow[] }) {
  return (
    <table className="kv">
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <th>{row.label}</th>
            <td>{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
