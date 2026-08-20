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

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import PageContainer from "@/components/PageContainer";
import EnrollMotherForm from "@/components/EnrollMotherForm";
import RiskBadge from "@/components/RiskBadge";
import StatTile from "@/components/charts/StatTile";
import { LockIcon } from "@/components/icons";
import { ProviderApiError, fetchProviderPatients, fetchProviderSummary } from "@/lib/providerApi";
import { formatDate, formatKes, formatRelative, stripWhatsappPrefix } from "@/lib/providerFormat";
import type { ProviderPanelRow, ProviderSummary } from "@/lib/providerTypes";
import styles from "./panel.module.css";

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
            <p className={styles.sectionSub}>Tap a row to open a mother&rsquo;s record.</p>
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

        {patients && patients.length > 0 && (
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
                {patients.map((p) => (
                  // The whole row is clickable as a pointer convenience
                  // (onClick), but keyboard/screen-reader access goes
                  // through the real <Link> in the name cell below —
                  // overriding a <tr>'s role to "link" would break its
                  // native row/cell table semantics for assistive tech.
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
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </PageContainer>
  );
}
