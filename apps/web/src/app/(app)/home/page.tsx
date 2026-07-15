"use client";

import Link from "next/link";
import cardStyles from "@/components/Card.module.css";
import PageContainer from "@/components/PageContainer";
import WeekRibbon from "@/components/WeekRibbon";
import LineChart from "@/components/charts/LineChart";
import { useMe } from "@/lib/MeContext";
import {
  computeMoodDirection,
  moodDirectionBody,
  moodDirectionHeadline,
  sliceLastDays,
} from "@/lib/insights";
import { useInsights } from "@/lib/useInsights";
import { resolveGestationalWeek } from "@/lib/pregnancy";
import styles from "./home.module.css";

export default function HomePage() {
  const { me, loading, error, stale } = useMe();
  // Shares the Insights tab's default cache key (insights:14) — either
  // screen warms the offline cache for the other. The card itself only
  // charts the last 7 days.
  const { data: insights } = useInsights(14);

  const name = me?.user.name?.trim().split(/\s+/)[0] || "there";
  const isSw = me?.user.language === "sw";
  const week = resolveGestationalWeek(me?.user ?? null);

  const weekMood = insights ? sliceLastDays(insights.moodSeries, 7) : [];
  const direction = computeMoodDirection(weekMood);

  return (
    <PageContainer>
      <div className={styles.stack}>
        {loading && !me ? (
          <div className={styles.skeleton} aria-hidden="true" />
        ) : (
          <div data-stagger style={{ ["--stagger-index" as string]: 0 }}>
            <h1 className={styles.greeting}>
              {isSw ? `Habari, ${name} 💚` : `Hello, ${name} 💚`}
            </h1>
            <p className={styles.subgreeting}>
              {week ? `Week ${week} of your journey.` : "Tell me about your pregnancy to personalize this page."}
              {stale && (
                <span className={styles.staleNote}>
                  {" "}
                  {isSw ? "· taarifa za mwisho zilizohifadhiwa" : "· showing your last saved info"}
                </span>
              )}
            </p>
          </div>
        )}

        {error && <p className={styles.errorNote}>{error}</p>}

        <WeekRibbon week={week} style={{ ["--stagger-index" as string]: 1 } as React.CSSProperties} />

        <article
          className={`${cardStyles.card} ${cardStyles.primary}`}
          data-stagger
          style={{ ["--stagger-index" as string]: 2 } as React.CSSProperties}
        >
          <p className={cardStyles.eyebrow}>Today</p>
          <h2 className={cardStyles.title}>
            {me?.todayJournal?.completed ? "Do another check-in" : "Start today's check-in"}
          </h2>
          <p className={cardStyles.body}>
            {me?.todayJournal?.completed
              ? "You've already checked in today — another one is always welcome."
              : "A two-minute journal helps me notice patterns and catch anything that needs attention early."}
          </p>
          <Link href="/journal" className={cardStyles.primaryBtn}>
            Start today's check-in →
          </Link>
        </article>

        {/* Trends card (P2-E): honest direction wording derived from the
            per-day mood series + a 7-day sparkline. No fake positivity —
            a dip is named gently and paired with a check-in suggestion. */}
        <article
          className={`${cardStyles.card} ${cardStyles.quiet}`}
          data-stagger
          style={{ ["--stagger-index" as string]: 3 } as React.CSSProperties}
        >
          <p className={cardStyles.eyebrow}>Your trends</p>
          {direction && weekMood.length >= 2 ? (
            <>
              <h2 className={cardStyles.title}>{moodDirectionHeadline(direction)}</h2>
              <LineChart
                mini
                points={weekMood}
                yDomain={[1, 10]}
                windowDays={7}
                height={44}
                ariaLabel="Mood over the last 7 days"
              />
              <p className={cardStyles.body}>{moodDirectionBody(direction)}</p>
              <Link href="/insights" className={cardStyles.cta}>
                See your trends →
              </Link>
            </>
          ) : (
            <>
              <h2 className={cardStyles.title}>Not enough data yet</h2>
              <p className={cardStyles.body}>Your trends will appear here after a few check-ins.</p>
              <Link href="/journal" className={cardStyles.cta}>
                Start today&apos;s check-in →
              </Link>
            </>
          )}
        </article>
      </div>
    </PageContainer>
  );
}
