"use client";

import Link from "next/link";
import cardStyles from "@/components/Card.module.css";
import PageContainer from "@/components/PageContainer";
import WeekRibbon from "@/components/WeekRibbon";
import { useMe } from "@/lib/MeContext";
import { resolveGestationalWeek } from "@/lib/pregnancy";
import styles from "./home.module.css";

export default function HomePage() {
  const { me, loading, error, stale } = useMe();

  const name = me?.user.name?.trim().split(/\s+/)[0] || "there";
  const isSw = me?.user.language === "sw";
  const week = resolveGestationalWeek(me?.user ?? null);

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

        <article
          className={`${cardStyles.card} ${cardStyles.quiet}`}
          data-stagger
          style={{ ["--stagger-index" as string]: 3 } as React.CSSProperties}
        >
          <p className={cardStyles.eyebrow}>Your trends</p>
          <h2 className={cardStyles.title}>Not enough data yet</h2>
          <p className={cardStyles.body}>Your trends will appear here after a few check-ins.</p>
        </article>
      </div>
    </PageContainer>
  );
}
