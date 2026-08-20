// Pure cohort-analytics aggregation for the provider portal (P6 —
// GET /provider/cohort). A county buys AGGREGATES, not a patient list —
// see the P6 spec's framing ("a county buys aggregates, not a patient
// list") — so unlike triage.ts (which ranks individual mothers) this
// module only ever collapses an array of per-mother inputs into cohort-
// wide numbers, and its output type is structurally incapable of
// carrying a phone, a name, or a per-mother array (see CohortStats
// below). Same discipline as triage.ts / otp.ts / jobs.ts: no I/O, no
// `Date.now()` inside — `now` is passed in explicitly.
//
// SMALL-CELL SUPPRESSION IS THE POINT OF THIS FILE. An aggregate over a
// handful of people is not anonymous — on a panel of 2, "checkInRatePct:
// 50%" identifies exactly which one of the two didn't check in, the same
// way the GET /provider/summary privacy fix (see app.ts) had to close
// for escalations7d. MIN_COHORT_N is the floor below which this module
// refuses to compute or return ANY statistic, returning only a
// suppression notice instead — see computeCohortAggregate's doc comment.
// This constant (and the reasoning above) lives in core specifically so
// it's unit-testable without spinning up the HTTP route.

import { expectedAncContacts, daysSince } from './triage';

/** Minimum cohort size before GET /provider/cohort will return any
 *  statistic. Below this, even a single number (e.g. "80% checked in
 *  this week" on a panel of 4) can identify an individual by elimination
 *  — see the file header. Kept as a named, documented, testable constant
 *  rather than a magic number inline in the route. */
export const MIN_COHORT_N = 5;

/**
 * Everything computeCohortAggregate() needs about ONE consented mother,
 * already computed by the caller (GET /provider/cohort in
 * apps/server/src/app.ts) from the same journal/user data the panel and
 * triage routes already read — this module invents no new data source
 * and, critically, is never handed anything identifying (no phone, no
 * name) in the first place, so there is nothing for a bug in THIS file
 * to leak even by accident.
 */
export interface CohortMotherInput {
  pregnancyWeek: number | null;
  /** Count of ANC visits attended so far (users.anc_visits). */
  ancVisits: number | null;
  /** This mother's own average mood over whatever window the caller
   *  queried (e.g. TrendSummary#avgMood over 30 days) — null if she has
   *  no journal entries with a mood value in that window. */
  avgMood: number | null;
  avgSleepHours: number | null;
  /** ISO timestamp of her most recent check-in, or null if none in the
   *  window the caller queried. */
  lastCheckInAt: string | null;
  /** True if she had at least one red-flagged journal entry in whatever
   *  window the caller queried (P6 spec: 30 days). */
  hadRedFlag: boolean;
}

/** Aggregate-only response shape. Deliberately has NO field that could
 *  hold a phone, a name, or one entry per mother — every field here is
 *  either a single cohort-wide number or a small fixed-shape bucket
 *  count. If a future change to this interface would let it carry
 *  per-mother data, that change belongs in a different type, not here. */
export interface CohortStats {
  suppressed: false;
  cohortSize: number;
  /** % of mothers (with a known pregnancyWeek) whose ancVisits meets or
   *  exceeds expectedAncContacts(pregnancyWeek) — see triage.ts's
   *  ANC_CONTACT_THRESHOLD_WEEKS for the schedule this is measured
   *  against. A mother with no recorded pregnancyWeek is excluded from
   *  both the numerator and denominator (unknown, not "non-adherent"). */
  ancAdherencePct: number;
  /** Mean of avgMood across mothers who have one; null if none do. */
  avgMood: number | null;
  avgSleepHours: number | null;
  /** % of the WHOLE cohort (denominator is cohortSize, not just mothers
   *  with a check-in on record) who checked in within the last 7 days. */
  checkInRatePct: number;
  /** Count (not %) of mothers with >=1 red flag in the window — a raw
   *  count is fine at n >= MIN_COHORT_N since it's already suppressed
   *  below that floor, same as every other field here. */
  redFlagMothers: number;
  gestationalBuckets: { first: number; second: number; third: number };
}

/** Returned instead of CohortStats when cohortSize < MIN_COHORT_N — no
 *  statistic is computed at all (not even a rounded-away one), by
 *  design. The route surfaces this as an explicit, confident explanation
 *  in the UI rather than an empty state (see the P6 spec's Web UI
 *  section) — `cohortSize` here is safe to show on its own (a bare count
 *  with no accompanying rate/average doesn't single anyone out the way a
 *  percentage over the same small N would). */
export interface CohortSuppressed {
  suppressed: true;
  minimumN: number;
  cohortSize: number;
}

export type CohortResult = CohortStats | CohortSuppressed;

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function roundPct(n: number): number {
  return Math.round(n);
}

/**
 * Collapses `mothers` (already filtered by the caller to ENROLLED AND
 * CONSENTED mothers only — see GET /provider/cohort in app.ts, which
 * never even builds a CohortMotherInput for a mother without active
 * provider_access consent) into cohort-wide statistics, or a suppression
 * notice when the cohort is too small to report on safely. `now` is used
 * only for the checkInRatePct's "within the last 7 days" window.
 */
export function computeCohortAggregate(mothers: CohortMotherInput[], now: Date): CohortResult {
  const cohortSize = mothers.length;
  if (cohortSize < MIN_COHORT_N) {
    return { suppressed: true, minimumN: MIN_COHORT_N, cohortSize };
  }

  const moods = mothers.map((m) => m.avgMood).filter((v): v is number => typeof v === 'number');
  const sleeps = mothers.map((m) => m.avgSleepHours).filter((v): v is number => typeof v === 'number');

  let ancKnown = 0;
  let ancAdherent = 0;
  const gestationalBuckets = { first: 0, second: 0, third: 0 };
  let checkedInWithin7 = 0;
  let redFlagMothers = 0;

  for (const m of mothers) {
    if (m.pregnancyWeek != null && m.pregnancyWeek > 0) {
      ancKnown += 1;
      const expected = expectedAncContacts(m.pregnancyWeek);
      const actual = m.ancVisits ?? 0;
      if (actual >= expected) ancAdherent += 1;

      if (m.pregnancyWeek < 13) gestationalBuckets.first += 1;
      else if (m.pregnancyWeek < 27) gestationalBuckets.second += 1;
      else gestationalBuckets.third += 1;
    }

    if (m.lastCheckInAt != null && daysSince(m.lastCheckInAt, now) <= 7) {
      checkedInWithin7 += 1;
    }

    if (m.hadRedFlag) redFlagMothers += 1;
  }

  return {
    suppressed: false,
    cohortSize,
    ancAdherencePct: ancKnown > 0 ? roundPct((ancAdherent / ancKnown) * 100) : 0,
    avgMood: moods.length > 0 ? round1(average(moods) as number) : null,
    avgSleepHours: sleeps.length > 0 ? round1(average(sleeps) as number) : null,
    checkInRatePct: roundPct((checkedInWithin7 / cohortSize) * 100),
    redFlagMothers,
    gestationalBuckets,
  };
}
