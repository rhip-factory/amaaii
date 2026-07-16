"use client";

// Insights tab (P2-E): stat tiles + mood line + sleep line + symptom
// bars, all computed server-side from journal data (WhatsApp- and
// form-sourced check-ins share one table — GET /insights). Reads go
// through offlineCache's stale-while-revalidate path (useInsights), so
// last-known insights render offline. Two measures of different scale
// (mood 1–10, sleep hours) are two separate charts — never dual-axis.

import { useState } from "react";
import cardStyles from "@/components/Card.module.css";
import EmptyState from "@/components/EmptyState";
import PageContainer from "@/components/PageContainer";
import BarChart from "@/components/charts/BarChart";
import ChartTable from "@/components/charts/ChartTable";
import LineChart from "@/components/charts/LineChart";
import StatTile from "@/components/charts/StatTile";
import chartStyles from "@/components/charts/charts.module.css";
import { InsightsIcon } from "@/components/icons";
import { computeMoodDirection, moodDirectionWord } from "@/lib/insights";
import { useInsights } from "@/lib/useInsights";
import type { InsightsWindow, SeriesPoint } from "@/lib/types";
import styles from "./insights.module.css";

const WINDOWS: InsightsWindow[] = [14, 30];

function formatDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

// Sleep y-scale: 0 up to a clean even ceiling (at least 8h so a normal
// night doesn't fill the chart), four hairlines.
function sleepScale(points: SeriesPoint[]): { domain: [number, number]; ticks: number[] } {
  const max = Math.max(8, ...points.map((p) => p.value));
  const top = Math.ceil(max / 2) * 2;
  const step = top / 4;
  return { domain: [0, top], ticks: [step, 2 * step, 3 * step, top] };
}

export default function InsightsPage() {
  const [days, setDays] = useState<InsightsWindow>(14);
  const { data, stale, fetching, error } = useInsights(days);

  const hasEnough = (data?.moodSeries.length ?? 0) >= 2;
  const dangerInSeries = data ? data.moodSeries.some((p) => data.redFlagDates.includes(p.date)) : false;
  const direction = data ? computeMoodDirection(data.moodSeries) : null;
  const sleep = data ? sleepScale(data.sleepSeries) : null;

  return (
    <PageContainer title="Insights" subhead="Mood, sleep, and symptom patterns over time.">
      <div className={styles.stack}>
        <div className={styles.segRow}>
          <div className={styles.seg} role="radiogroup" aria-label="Time window">
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                className={styles.segOpt}
                role="radio"
                aria-checked={days === w}
                onClick={() => setDays(w)}
              >
                {w} days
              </button>
            ))}
          </div>
        </div>

        {stale && data && (
          <p className={styles.staleNote}>Showing your last saved trends — they&apos;ll refresh when you&apos;re back online.</p>
        )}
        {error && !data && <p className={styles.errorNote}>{error}</p>}
        {fetching && !data && !error && <div className={styles.skeleton} aria-hidden="true" />}

        {data && !hasEnough && (
          <EmptyState
            Icon={InsightsIcon}
            title="Nothing to show yet"
            body="Your trends will appear after a few check-ins — mood, sleep, and anything worth watching."
            ctaLabel="Start today's check-in"
            ctaHref="/journal"
          />
        )}

        {data && hasEnough && (
          <div
            className={`${styles.content} ${fetching ? styles.contentFetching : ""}`}
            aria-busy={fetching}
          >
            <div className={chartStyles.tileRow}>
              <StatTile label="Check-ins" value={String(data.checkinsCount)} hint={`last ${data.window} days`} />
              <StatTile
                label="Mood"
                value={moodDirectionWord(direction)}
                hint={data.trend?.avgMood != null ? `avg ${data.trend.avgMood}/10` : undefined}
              />
              <StatTile
                label="Sleep"
                value={data.trend?.avgSleepHours != null ? `${data.trend.avgSleepHours}h` : "—"}
                hint="avg per night"
              />
            </div>

            <article className={cardStyles.card}>
              <p className={cardStyles.eyebrow}>Mood</p>
              <h2 className={cardStyles.title}>How you&apos;ve been feeling</h2>
              <LineChart
                points={data.moodSeries}
                yDomain={[1, 10]}
                yTicks={[2, 4, 6, 8, 10]}
                windowDays={data.window}
                markedDates={data.redFlagDates}
                formatValue={(v) => String(v)}
                ariaLabel={`Mood from 1 to 10 over the last ${data.window} days`}
              />
              {dangerInSeries && (
                <p className={chartStyles.legend}>
                  <span className={chartStyles.legendDiamond} aria-hidden="true" />
                  Danger signs noted
                </p>
              )}
              <ChartTable
                headers={["Date", "Mood"]}
                rows={data.moodSeries.map((p) => ({
                  label: formatDay(p.date),
                  value: `${p.value}/10`,
                  note: data.redFlagDates.includes(p.date) ? "Danger signs noted" : undefined,
                }))}
              />
            </article>

            <article className={cardStyles.card}>
              <p className={cardStyles.eyebrow}>Sleep</p>
              <h2 className={cardStyles.title}>Hours of sleep</h2>
              {data.sleepSeries.length >= 2 && sleep ? (
                <>
                  <LineChart
                    points={data.sleepSeries}
                    yDomain={sleep.domain}
                    yTicks={sleep.ticks}
                    windowDays={data.window}
                    formatValue={(v) => `${v}h`}
                    ariaLabel={`Hours of sleep per night over the last ${data.window} days`}
                  />
                  <ChartTable
                    headers={["Date", "Sleep"]}
                    rows={data.sleepSeries.map((p) => ({
                      label: formatDay(p.date),
                      value: `${p.value} h`,
                    }))}
                  />
                </>
              ) : (
                <p className={styles.chartNote}>
                  Not enough sleep data in this window yet — it&apos;s part of every daily check-in.
                </p>
              )}
            </article>

            <article className={cardStyles.card}>
              <p className={cardStyles.eyebrow}>Symptoms</p>
              <h2 className={cardStyles.title}>Most mentioned</h2>
              {data.symptomCounts.length > 0 ? (
                <>
                  <BarChart
                    bars={data.symptomCounts}
                    ariaLabel={`Most mentioned symptoms over the last ${data.window} days`}
                  />
                  <ChartTable
                    headers={["Symptom", "Check-ins"]}
                    rows={data.symptomCounts.map((s) => ({
                      label: s.symptom,
                      value: String(s.count),
                    }))}
                  />
                </>
              ) : (
                <p className={styles.chartNote}>No symptoms logged in this window — that&apos;s good news.</p>
              )}
            </article>
          </div>
        )}
      </div>
    </PageContainer>
  );
}
