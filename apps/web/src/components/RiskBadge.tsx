// P5-B: pregnancy-risk badge shared by the patient panel table and the
// patient detail header — one definition so the two views can never
// drift on label/color.
import type { RiskLevel } from "@/lib/providerTypes";
import styles from "./RiskBadge.module.css";

const LABELS: Record<RiskLevel, string> = {
  high: "High risk",
  moderate: "Moderate risk",
  low: "Low risk",
};

export default function RiskBadge({ level }: { level: RiskLevel }) {
  return <span className={`${styles.badge} ${styles[level]}`}>{LABELS[level]}</span>;
}
