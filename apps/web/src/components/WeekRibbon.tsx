import Link from "next/link";
import styles from "./WeekRibbon.module.css";
import { RIBBON_WEEKS, produceForWeek } from "@/lib/pregnancy";

interface WeekRibbonProps {
  week: number | null;
  style?: React.CSSProperties;
}

// The signature home-screen element: a horizontal 40-week progress
// ribbon with the week set large in Fraunces and a Kenyan-produce size
// comparison underneath. See src/lib/pregnancy.ts for the lookup table.
export default function WeekRibbon({ week, style }: WeekRibbonProps) {
  if (!week) {
    return (
      <article className={styles.card} style={style} data-stagger>
        <p className={styles.eyebrow}>This week</p>
        <p className={styles.emptyBody}>
          Once I know how far along you are, I&apos;ll show your week here — with a size comparison
          and week-by-week notes.
        </p>
        <Link href="/profile" className={styles.emptyCta}>
          Add your pregnancy week →
        </Link>
      </article>
    );
  }

  const produce = produceForWeek(week);
  const percent = Math.min(100, Math.max(0, (week / RIBBON_WEEKS) * 100));

  return (
    <article className={styles.card} style={style} data-stagger>
      <p className={styles.eyebrow}>This week</p>
      <div className={styles.weekRow}>
        <span className={`${styles.weekNumber} tabular-nums`}>Week {week}</span>
        <span className={`${styles.weekOf} tabular-nums`}>of {RIBBON_WEEKS}</span>
      </div>
      {produce && <p className={styles.produce}>{produce.phrase}</p>}

      <div className={styles.track} role="img" aria-label={`Week ${week} of ${RIBBON_WEEKS} of pregnancy`}>
        <div className={styles.fill} style={{ width: `${percent}%` }} />
        <div className={styles.dot} style={{ left: `${percent}%` }} />
      </div>
      <div className={styles.scaleLabels}>
        <span>Week 1</span>
        <span>Week {RIBBON_WEEKS}</span>
      </div>
    </article>
  );
}
