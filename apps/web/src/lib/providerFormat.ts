// Small formatting helpers shared by the provider panel and patient
// detail pages — kept here rather than duplicated in both, and kept
// deliberately free of any locale dependency that might render
// differently across browsers (manual grouping, not toLocaleString with
// a region tag) so the KES figures projected on Friday look the same
// wherever the demo runs.

export function stripWhatsappPrefix(phone: string): string {
  return phone.replace(/^whatsapp:/, "");
}

export function formatKes(amount: number): string {
  const grouped = Math.round(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `KES ${grouped}`;
}

function parseDate(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "12 Aug 2026" — no time component, for enrollment/escalation dates. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = parseDate(iso);
  if (!d) return "—";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** "12 Aug, 14:05" — with time, for escalation history entries. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = parseDate(iso);
  if (!d) return "—";
  const date = d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${date}, ${time}`;
}

/** "Today" / "Yesterday" / "4 days ago" / falls back to formatDate beyond a week. */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "No check-ins yet";
  const d = parseDate(iso);
  if (!d) return "No check-ins yet";
  const dayMs = 24 * 3600 * 1000;
  const diffDays = Math.floor((Date.now() - d.getTime()) / dayMs);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return formatDate(iso);
}
