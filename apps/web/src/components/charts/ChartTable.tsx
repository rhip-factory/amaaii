// "View as list" — the accessibility twin every chart carries (dataviz
// rule: tooltips enhance, never gate; every plotted value must also be
// reachable as text). Collapsed <details> so it never competes with the
// chart visually.
import styles from "./charts.module.css";

export interface ChartTableRow {
  label: string;
  value: string;
  /** e.g. "Danger signs noted" on flagged mood days. */
  note?: string;
}

interface ChartTableProps {
  /** Column headers: [labelHeader, valueHeader] (+ notes column when any row has one). */
  headers: [string, string];
  rows: ChartTableRow[];
  summary?: string;
}

export default function ChartTable({ headers, rows, summary = "View as list" }: ChartTableProps) {
  const hasNotes = rows.some((r) => r.note);
  return (
    <details className={styles.tableDetails}>
      <summary className={styles.tableSummary}>{summary}</summary>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{headers[0]}</th>
            <th scope="col">{headers[1]}</th>
            {hasNotes && <th scope="col">Notes</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.label}-${r.value}`}>
              <td>{r.label}</td>
              <td className={styles.num}>{r.value}</td>
              {hasNotes && <td className={styles.note}>{r.note ?? ""}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
