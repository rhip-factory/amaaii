// P6: danger-sign urgency badge, shared by the patient detail page's
// escalation history AND the new /provider/escalations feed — pulled out
// of patient/page.tsx's old inline urgencyClass()/JSX so the two views
// can't drift on label/color, same reasoning as RiskBadge. Only
// 'critical'/'high' are ever recorded by auditDangerEscalation's funnel,
// but this accepts any string and falls back to a neutral style rather
// than throwing on an unexpected value.
import styles from "./UrgencyBadge.module.css";

const LABELS: Record<string, string> = {
  critical: "Critical",
  high: "High",
};

function variantClass(urgency: string): string {
  if (urgency === "critical") return styles.critical ?? "";
  if (urgency === "high") return styles.high ?? "";
  return styles.other ?? "";
}

export default function UrgencyBadge({ urgency }: { urgency: string }) {
  return <span className={`${styles.badge} ${variantClass(urgency)}`}>{LABELS[urgency] ?? urgency}</span>;
}
