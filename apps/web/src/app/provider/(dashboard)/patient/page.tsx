"use client";

// P5-B: patient detail — gestational age, risk badge, mood/sleep trend,
// symptom counts, red-flag dates, escalation history. Query-param
// routed (?phone=…), NOT a [phone] dynamic segment: this app is
// `output: 'export'` (static), which cannot prerender a dynamic segment
// with no known param set at build time (see next.config.ts's header
// and CLAUDE.md). useSearchParams requires a Suspense boundary in
// Next 15 (see app/(app)/chat/page.tsx for the same pattern already in
// this codebase).
//
// The 403 { error: 'no_provider_consent' } branch is the spec's
// headline demo moment: a mother who hasn't granted `provider_access`
// blocks the read at the SERVER, and this page's job is just to render
// that block respectfully — see patientDetail.module.css's consentPanel
// comment for why it deliberately avoids the app's error/danger colors.

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import cardStyles from "@/components/Card.module.css";
import PageContainer from "@/components/PageContainer";
import RiskBadge from "@/components/RiskBadge";
import UrgencyBadge from "@/components/UrgencyBadge";
import BarChart from "@/components/charts/BarChart";
import ChartTable from "@/components/charts/ChartTable";
import LineChart from "@/components/charts/LineChart";
import StatTile from "@/components/charts/StatTile";
import chartStyles from "@/components/charts/charts.module.css";
import { LockIcon } from "@/components/icons";
import { computeMoodDirection, moodDirectionWord } from "@/lib/insights";
import { ProviderApiError, fetchProviderPatientDetail } from "@/lib/providerApi";
import { formatDate, formatDateTime, stripWhatsappPrefix } from "@/lib/providerFormat";
import type { ProviderPatientDetail } from "@/lib/providerTypes";
import type { SeriesPoint } from "@/lib/types";
import styles from "./patientDetail.module.css";

// Sleep y-scale — identical logic to the mother app's Insights tab
// (app/(app)/insights/page.tsx#sleepScale): 0 up to a clean even
// ceiling (at least 8h), four hairlines.
function sleepScale(points: SeriesPoint[]): { domain: [number, number]; ticks: number[] } {
  const max = Math.max(8, ...points.map((p) => p.value));
  const top = Math.ceil(max / 2) * 2;
  const step = top / 4;
  return { domain: [0, top], ticks: [step, 2 * step, 3 * step, top] };
}

function PatientDetailInner() {
  const router = useRouter();
  const params = useSearchParams();
  const phone = params.get("phone") ?? "";

  const [detail, setDetail] = useState<ProviderPatientDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [consentDenied, setConsentDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!phone) {
      setLoading(false);
      setError("No patient was specified.");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setConsentDenied(false);
    (async () => {
      try {
        const data = await fetchProviderPatientDetail(phone);
        if (!cancelled) setDetail(data);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ProviderApiError && err.status === 403) {
          setConsentDenied(true);
        } else {
          setError(
            err instanceof ProviderApiError ? err.message : "Could not load this mother's record. Please try again."
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phone]);

  const backLink = (
    <button type="button" className={styles.backLink} onClick={() => router.push("/provider")}>
      ‹ Back to patients
    </button>
  );

  if (loading) {
    return (
      <PageContainer>
        <div className={styles.stack}>
          {backLink}
          <div className={styles.skeleton} aria-hidden="true" />
        </div>
      </PageContainer>
    );
  }

  if (consentDenied) {
    return (
      <PageContainer>
        <div className={styles.stack}>
          {backLink}
          <div className={styles.consentPanel}>
            <div className={styles.consentIcon}>
              <LockIcon width={26} height={26} />
            </div>
            <h1 className={styles.consentTitle}>Awaiting her consent</h1>
            <p className={styles.consentBody}>
              This mother hasn&rsquo;t yet granted your facility access to her clinical record. Her privacy
              choice is hers alone — she can grant it anytime from her own Amaaii privacy settings, and her
              record will appear here as soon as she does.
            </p>
            <button type="button" className={styles.consentBackBtn} onClick={() => router.push("/provider")}>
              Back to patients
            </button>
          </div>
        </div>
      </PageContainer>
    );
  }

  if (error || !detail) {
    return (
      <PageContainer>
        <div className={styles.stack}>
          {backLink}
          <p className={styles.errorNote}>{error ?? "Could not load this mother's record."}</p>
        </div>
      </PageContainer>
    );
  }

  const moodSeries: SeriesPoint[] = detail.dailySeries
    .filter((d) => d.mood != null)
    .map((d) => ({ date: d.date, value: d.mood as number }));
  const sleepSeries: SeriesPoint[] = detail.dailySeries
    .filter((d) => d.sleepHours != null)
    .map((d) => ({ date: d.date, value: d.sleepHours as number }));
  const direction = computeMoodDirection(moodSeries);
  const sleep = sleepScale(sleepSeries);
  const windowDays = detail.trend?.windowDays ?? 14;

  return (
    <PageContainer>
      <div className={styles.stack}>
        {backLink}

        <div className={styles.headerCard}>
          <div className={styles.identity}>
            <h1 className={styles.name}>{detail.displayName}</h1>
            <span className={styles.phone}>{stripWhatsappPrefix(detail.phone)}</span>
          </div>
          <div className={styles.metaRow}>
            <RiskBadge level={detail.riskLevel} />
            {detail.pregnancyWeek != null && <span className={styles.metaChip}>Week {detail.pregnancyWeek}</span>}
            {detail.edd && <span className={styles.metaChip}>EDD {formatDate(detail.edd)}</span>}
          </div>
        </div>

        {detail.trend && detail.trend.totalEntries > 0 ? (
          <div className={chartStyles.tileRow}>
            <StatTile
              label="Check-ins"
              value={String(detail.trend.totalEntries)}
              hint={`last ${detail.trend.windowDays} days`}
            />
            <StatTile
              label="Mood"
              value={moodDirectionWord(direction)}
              hint={detail.trend.avgMood != null ? `avg ${detail.trend.avgMood}/10` : undefined}
            />
            <StatTile
              label="Sleep"
              value={detail.trend.avgSleepHours != null ? `${detail.trend.avgSleepHours}h` : "—"}
              hint="avg per night"
            />
          </div>
        ) : (
          <p className={styles.chartNote}>No check-ins logged yet in this window.</p>
        )}

        <article className={cardStyles.card}>
          <p className={cardStyles.eyebrow}>Mood</p>
          <h2 className={cardStyles.title}>How she&rsquo;s been feeling</h2>
          {moodSeries.length >= 2 ? (
            <>
              <LineChart
                points={moodSeries}
                yDomain={[1, 10]}
                yTicks={[2, 4, 6, 8, 10]}
                windowDays={windowDays}
                markedDates={detail.redFlagDates}
                formatValue={(v) => String(v)}
                ariaLabel={`Mood from 1 to 10 over the last ${windowDays} days`}
              />
              <ChartTable
                headers={["Date", "Mood"]}
                rows={moodSeries.map((p) => ({
                  label: formatDate(p.date),
                  value: `${p.value}/10`,
                  note: detail.redFlagDates.includes(p.date) ? "Danger signs noted" : undefined,
                }))}
              />
            </>
          ) : (
            <p className={styles.chartNote}>Not enough mood check-ins in this window yet.</p>
          )}
        </article>

        <article className={cardStyles.card}>
          <p className={cardStyles.eyebrow}>Sleep</p>
          <h2 className={cardStyles.title}>Hours of sleep</h2>
          {sleepSeries.length >= 2 ? (
            <>
              <LineChart
                points={sleepSeries}
                yDomain={sleep.domain}
                yTicks={sleep.ticks}
                windowDays={windowDays}
                formatValue={(v) => `${v}h`}
                ariaLabel={`Hours of sleep per night over the last ${windowDays} days`}
              />
              <ChartTable
                headers={["Date", "Sleep"]}
                rows={sleepSeries.map((p) => ({ label: formatDate(p.date), value: `${p.value} h` }))}
              />
            </>
          ) : (
            <p className={styles.chartNote}>Not enough sleep data in this window yet.</p>
          )}
        </article>

        <article className={cardStyles.card}>
          <p className={cardStyles.eyebrow}>Symptoms</p>
          <h2 className={cardStyles.title}>Most mentioned</h2>
          {detail.symptomCounts.length > 0 ? (
            <>
              <BarChart bars={detail.symptomCounts} ariaLabel="Most mentioned symptoms" />
              <ChartTable
                headers={["Symptom", "Check-ins"]}
                rows={detail.symptomCounts.map((s) => ({ label: s.symptom, value: String(s.count) }))}
              />
            </>
          ) : (
            <p className={styles.chartNote}>No symptoms logged in this window — that&rsquo;s good news.</p>
          )}
        </article>

        <article className={cardStyles.card}>
          <p className={cardStyles.eyebrow}>Danger signs</p>
          <h2 className={cardStyles.title}>Red-flag dates</h2>
          {detail.redFlagDates.length > 0 ? (
            <div className={styles.dateChips}>
              {detail.redFlagDates.map((d) => (
                <span key={d} className={styles.dateChip}>
                  {formatDate(d)}
                </span>
              ))}
            </div>
          ) : (
            <p className={styles.chartNote}>No danger signs flagged in this window.</p>
          )}
        </article>

        <article className={cardStyles.card}>
          <p className={cardStyles.eyebrow}>History</p>
          <h2 className={cardStyles.title}>Escalations</h2>
          {detail.recentEscalations.length > 0 ? (
            <ul className={styles.escalationList}>
              {detail.recentEscalations.map((esc, i) => (
                <li key={`${esc.createdAt}-${i}`} className={styles.escalationItem}>
                  <UrgencyBadge urgency={esc.urgency} />
                  <span className={styles.escalationTime}>{formatDateTime(esc.createdAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.chartNote}>No danger-sign escalations on record.</p>
          )}
        </article>
      </div>
    </PageContainer>
  );
}

export default function PatientDetailPage() {
  return (
    <Suspense fallback={<PageContainer><div aria-busy="true" style={{ minHeight: "40vh" }} /></PageContainer>}>
      <PatientDetailInner />
    </Suspense>
  );
}
