"use client";

// P5-B: provider panel — the facility's home screen. Summary tiles
// (enrolled, active, annual revenue, escalations this week) then the
// patient table. Rows for a mother who hasn't granted `provider_access`
// consent render "Awaiting her consent" instead of clinical values —
// see panel.module.css's header comment: this is the demo's
// differentiator, not an error state, so it's styled calm and
// intentional. Every row is clickable (including no-consent rows) —
// clicking one without consent still navigates to the detail page,
// which then shows the real, server-enforced 403 panel. That's
// deliberate: it proves the enforcement is real end-to-end, not just a
// table hint.
//
// P6: the table became a TRIAGE QUEUE — see sortForTriageQueue below.
// Consenting rows sort by triage urgency (danger signs dominate, per
// packages/core/src/triage.ts#assessTriage, the backend's pure scoring
// function this frontend never imports directly — see providerTypes.ts's
// header on why apps/web can't reach packages/core). Non-consenting rows
// sort BELOW every clinical row, unconditionally: we know nothing about
// a mother who hasn't granted access, so she cannot be prioritised
// against mothers we *do* have signal on — that's not a UI choice, it's
// what "we know nothing" means. The raw numeric `triage.score` is never
// rendered (see ProviderTriage's doc comment) — only `band` (as the
// "Needs attention" grouping/badge) and `reasons` (verbatim, API-supplied
// clinical phrases) ever reach the screen.

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import PageContainer from "@/components/PageContainer";
import EnrollMotherForm from "@/components/EnrollMotherForm";
import RiskBadge from "@/components/RiskBadge";
import StatTile from "@/components/charts/StatTile";
import { AlertIcon, LockIcon } from "@/components/icons";
import { ProviderApiError, fetchProviderPatients, fetchProviderSummary } from "@/lib/providerApi";
import { formatDate, formatKes, formatRelative, stripWhatsappPrefix } from "@/lib/providerFormat";
import type { ProviderPanelRow, ProviderSummary, TriageBand } from "@/lib/providerTypes";
import styles from "./panel.module.css";

function bandRank(band: TriageBand | undefined): number {
  if (band === "urgent") return 0;
  if (band === "watch") return 1;
  return 2; // "ok" or missing — never HIGHER priority than a known band.
}

// Sort into: [urgent, watch/ok, awaiting-consent] — never interleaved.
// Within the consenting group, prefer the API's own triage score (a
// straight magnitude comparison) when present; fall back to band rank +
// red-flag count so the queue still orders sensibly even if a row is
// missing a score (e.g. a future API revision that sends band/reasons
// without the numeric field this frontend treats as optional).
function sortForTriageQueue(patients: ProviderPanelRow[]): ProviderPanelRow[] {
  const consenting = patients.filter((p) => p.consentGranted);
  const awaitingConsent = patients.filter((p) => !p.consentGranted);

  consenting.sort((a, b) => {
    const aScore = a.triage?.score ?? null;
    const bScore = b.triage?.score ?? null;
    if (aScore != null && bScore != null && aScore !== bScore) return bScore - aScore;
    const bandDiff = bandRank(a.triage?.band) - bandRank(b.triage?.band);
    if (bandDiff !== 0) return bandDiff;
    return (b.redFlags7d ?? 0) - (a.redFlags7d ?? 0);
  });

  return [...consenting, ...awaitingConsent];
}

export default function ProviderPanelPage() {
  const router = useRouter();
  const [summary, setSummary] = useState<ProviderSummary | null>(null);
  const [patients, setPatients] = useState<ProviderPanelRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summaryRes, patientsRes] = await Promise.all([fetchProviderSummary(), fetchProviderPatients()]);
      setSummary(summaryRes);
      setPatients(patientsRes.patients);
    } catch (err) {
      setError(
        err instanceof ProviderApiError ? err.message : "Could not load your patient panel. Please try again."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openPatient(phone: string) {
    router.push(`/provider/patient?phone=${encodeURIComponent(phone)}`);
  }

  const queue = useMemo(() => (patients ? sortForTriageQueue(patients) : []), [patients]);
  const needsAttentionCount = queue.filter((p) => p.consentGranted && p.triage?.band === "urgent").length;
  const awaitingConsentCount = queue.filter((p) => !p.consentGranted).length;

  // Section boundaries within the single sorted `queue` array, so the
  // table can insert divider rows without ever re-sorting or splitting
  // into separate <table>s (one continuous keyboard/screen-reader tab
  // order top to bottom).
  const firstOtherIdx = queue.findIndex((p) => p.consentGranted && p.triage?.band !== "urgent");
  const firstAwaitingIdx = queue.findIndex((p) => !p.consentGranted);

  return (
    <PageContainer title="Patient panel" subhead="Mothers enrolled in your facility's ANC bundle.">
      <div className={styles.stack}>
        {error && <p className={styles.errorNote}>{error}</p>}

        {loading && !summary && <div className={styles.skeleton} aria-hidden="true" />}

        {summary && (
          <div className={styles.tileRow}>
            <StatTile label="Enrolled" value={String(summary.enrolledCount)} hint="all-time" />
            <StatTile label="Active" value={String(summary.activeCount)} hint="currently in the bundle" />
            <StatTile label="Annual revenue" value={formatKes(summary.annualRevenueKes)} hint="ANC bundle, projected" />
            <StatTile
              label="Escalations"
              value={String(summary.escalations7d)}
              hint="critical / high, last 7 days"
            />
          </div>
        )}

        <div className={styles.sectionHead}>
          <div>
            <h2 className={styles.sectionTitle}>Patients</h2>
            <p className={styles.sectionSub}>
              {needsAttentionCount > 0
                ? `${needsAttentionCount} need${needsAttentionCount === 1 ? "s" : ""} attention today · tap a row to open a record.`
                : "Tap a row to open a mother’s record."}
            </p>
          </div>
          <EnrollMotherForm onEnrolled={load} />
        </div>

        {patients && patients.length === 0 && (
          <div className={styles.emptyCard}>
            <p className={styles.emptyTitle}>No mothers enrolled yet</p>
            <p className={styles.emptyBody}>
              Use &ldquo;Enroll a mother&rdquo; above to add your first patient to the ANC bundle.
            </p>
          </div>
        )}

        {queue.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Mother</th>
                  <th scope="col">Enrolled</th>
                  <th scope="col">Status</th>
                  <th scope="col">Clinical summary</th>
                  <th scope="col" aria-hidden="true" />
                </tr>
              </thead>
              <tbody>
                {needsAttentionCount > 0 && (
                  <tr className={styles.groupDivider}>
                    <td colSpan={5}>
                      <AlertIcon width={13} height={13} />
                      Needs attention &middot; {needsAttentionCount}
                    </td>
                  </tr>
                )}
                {/* "Awaiting her consent" mothers sort BELOW every clinical
                    row on purpose (see this file's header comment) — we
                    know nothing about them, so they can't be prioritised
                    against mothers we do have signal on. */}
                {queue.map((p, idx) => (
                  <Fragment key={p.phone}>
                    {idx === firstOtherIdx && idx > 0 && needsAttentionCount > 0 && idx !== firstAwaitingIdx && (
                      <tr key="divider-other" className={styles.groupDivider}>
                        <td colSpan={5}>Other patients</td>
                      </tr>
                    )}
                    {idx === firstAwaitingIdx && idx > 0 && (
                      <tr key="divider-awaiting" className={styles.groupDivider}>
                        <td colSpan={5}>Awaiting consent &middot; {awaitingConsentCount}</td>
                      </tr>
                    )}
                    {/* The whole row is clickable as a pointer convenience
                        (onClick), but keyboard/screen-reader access goes
                        through the real <Link> in the name cell below —
                        overriding a <tr>'s role to "link" would break its
                        native row/cell table semantics for assistive tech. */}
                    <tr key={p.phone} className={styles.row} onClick={() => openPatient(p.phone)}>
                      <td>
                        <div className={styles.motherCell}>
                          <Link
                            href={`/provider/patient?phone=${encodeURIComponent(p.phone)}`}
                            className={styles.motherName}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {p.displayName}
                          </Link>
                          <span className={styles.motherPhone}>{stripWhatsappPrefix(p.phone)}</span>
                        </div>
                      </td>
                      <td className={styles.muted}>{formatDate(p.enrolledAt)}</td>
                      <td>
                        <span
                          className={`${styles.statusPill} ${p.status === "active" ? styles.statusActive : styles.statusEnded}`}
                        >
                          {p.status}
                        </span>
                      </td>
                      <td>
                        {p.consentGranted ? (
                          <div className={styles.clinicalSummary}>
                            <div className={styles.clinicalBadges}>
                              {p.triage?.band === "urgent" && (
                                <span className={styles.needsAttentionBadge}>
                                  <AlertIcon width={12} height={12} />
                                  Needs attention
                                </span>
                              )}
                              {p.riskLevel && <RiskBadge level={p.riskLevel} />}
                              {p.pregnancyWeek != null && (
                                <span className={styles.summaryDetail}>Week {p.pregnancyWeek}</span>
                              )}
                              <span className={styles.summaryDetail}>{formatRelative(p.lastCheckInAt)}</span>
                              {!!p.redFlags7d && (
                                <span className={styles.redFlagChip}>
                                  {p.redFlags7d} red flag{p.redFlags7d === 1 ? "" : "s"} (7d)
                                </span>
                              )}
                            </div>
                            {/* Plain clinical phrases from the API
                                (packages/core/src/triage.ts#assessTriage) —
                                rendered verbatim, never invented here.
                                Never empty when `triage` is present (a
                                mother with nothing flagged still gets a
                                reassuring "No concerns flagged recently"). */}
                            {p.triage && p.triage.reasons.length > 0 && (
                              <p className={styles.reasons}>{p.triage.reasons.join(" · ")}</p>
                            )}
                          </div>
                        ) : (
                          <span className={styles.awaitingConsent}>
                            <LockIcon width={13} height={13} />
                            Awaiting her consent
                          </span>
                        )}
                      </td>
                      <td className={styles.chevronCell} aria-hidden="true">
                        ›
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </PageContainer>
  );
}
