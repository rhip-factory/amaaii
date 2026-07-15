// Stat tile (P2-E): label · value · optional hint. Value is set in
// Fraunces (this app's display face for big numbers — see WeekRibbon)
// with the font's default proportional figures, never tabular-nums at
// display sizes.
import styles from "./charts.module.css";

interface StatTileProps {
  label: string;
  value: string;
  hint?: string;
}

export default function StatTile({ label, value, hint }: StatTileProps) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
      {hint && <span className={styles.tileHint}>{hint}</span>}
    </div>
  );
}
