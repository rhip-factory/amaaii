"use client";

// P6: cohort analytics — aggregate-only view over this facility's
// enrolled AND consented mothers. NEVER carries per-mother data (no
// phones, no names, no per-row arrays) — safe to project on a screen in
// front of a county officer, which is exactly what this page is for
// (the "why a county buys it" story, vs. the triage queue's "why a
// midwife opens this every morning" story).
//
// Small-cell suppression is the headline privacy feature here, not an
// afterthought: below MIN_COHORT_N (read off the response as
// `minimumN`, never hard-coded — see providerTypes.ts) the API returns
// no statistics at all, because an aggregate over a handful of people
// stops being anonymous. This page renders that as a confident, explicit
// explanation — not a generic "nothing here" empty state — because the
// suppression IS the feature being demonstrated.

import { useCallback, useEffect, useState } from "react";
import cardStyles from "@/components/Card.module.css";
import PageContainer from "@/components/PageContainer";
import BarChart from "@/components/charts/BarChart";
import ChartTable from "@/components/charts/ChartTable";
import StatTile from "@/components/charts/StatTile";
import { ShieldIcon } from "@/components/icons";
import { ProviderApiError, fetchProviderCohort } from "@/lib/providerApi";
import type { ProviderCohortResponse } from "@/lib/providerTypes";
import styles from "./cohort.module.css";

export default function CohortPage() {
  const [data, setData] = useState<ProviderCohortResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchProviderCohort());
    } catch (err) {
      setError(
        err instanceof ProviderApiError ? err.message : "Could not load cohort analytics. Please try again."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <PageContainer
      title="Cohort analytics"
      subhead="Aggregate patterns across your consented patients — never one mother's data."
    >
      <div className={styles.stack}>
        {error && <p className={styles.errorNote}>{error}</p>}

        {loading && !data && <div className={styles.skeleton} aria-hidden="true" />}

        {data && data.suppressed && (
          <div className={styles.suppressedCard}>
            <div className={styles.suppressedIcon}>
              <ShieldIcon width={26} height={26} />
            </div>
            <h2 className={styles.suppressedTitle}>Not enough mothers to report</h2>
            <p className={styles.suppressedBody}>
              Only {data.cohortSize} consenting mother{data.cohortSize === 1 ? "" : "s"} at your facility right
              now — reporting an average across that few would risk identifying someone by elimination.
              Amaaii needs at least {data.minimumN} consenting mothers before it will show a cohort number.
              That&rsquo;s a deliberate privacy floor, not a bug: as more mothers grant your facility access,
              this view fills in on its own.
            </p>
          </div>
        )}

        {data && !data.suppressed && (
          <>
            <div className={styles.tileRow}>
              <StatTile label="Cohort size" value={String(data.cohortSize)} hint="consenting mothers" />
              <StatTile
                label="ANC adherence"
                value={`${data.ancAdherencePct}%`}
                hint="on the MoH 8-contact schedule"
              />
              <StatTile
                label="Check-in rate"
                value={`${data.checkInRatePct}%`}
                hint="checked in within 7 days"
              />
              <StatTile
                label="Avg. mood"
                value={data.avgMood != null ? `${data.avgMood}/10` : "—"}
                hint="self-reported"
              />
              <StatTile
                label="Avg. sleep"
                value={data.avgSleepHours != null ? `${data.avgSleepHours}h` : "—"}
                hint="per night"
              />
              <StatTile
                label="Red-flag mothers"
                value={String(data.redFlagMothers)}
                hint="≥1 danger sign, 30 days"
              />
            </div>

            <article className={cardStyles.card}>
              <p className={cardStyles.eyebrow}>Gestational stage</p>
              <h2 className={cardStyles.title}>Trimester mix</h2>
              <BarChart
                bars={[
                  { symptom: "First trimester", count: data.gestationalBuckets.first },
                  { symptom: "Second trimester", count: data.gestationalBuckets.second },
                  { symptom: "Third trimester", count: data.gestationalBuckets.third },
                ]}
                ariaLabel="Mothers by trimester"
                unit="mother"
              />
              <ChartTable
                headers={["Trimester", "Mothers"]}
                rows={[
                  { label: "First trimester", value: String(data.gestationalBuckets.first) },
                  { label: "Second trimester", value: String(data.gestationalBuckets.second) },
                  { label: "Third trimester", value: String(data.gestationalBuckets.third) },
                ]}
              />
            </article>
          </>
        )}
      </div>
    </PageContainer>
  );
}
