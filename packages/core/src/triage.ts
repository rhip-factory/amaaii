// Pure triage-ordering logic for the provider portal (P6 — provider
// triage queue). Turns the handful of clinical signals GET
// /provider/patients already computes per mother into a single sortable
// `score`, a coarse `band` for UI grouping ("Needs attention"), and a
// short list of plain-language `reasons` a midwife would accept at a
// glance. Same discipline as dangerSigns.ts / otp.ts / jobs.ts elsewhere
// in this package: no I/O, no `Date.now()` inside — `now` is always
// passed in explicitly, so this is deterministic given its inputs and
// testable without faking the system clock.
//
// THIS IS NOT DANGER-SIGN DETECTION. detectDangerSigns() (dangerSigns.ts)
// stays the one deterministic, LLM-free safety triage engine and is
// never touched or duplicated here — assessTriage() only re-orders
// signals *already* produced elsewhere (journal red flags, the audit
// trail's danger_escalation rows, check-in cadence, ANC attendance) into
// a queue a provider can work top-to-bottom. A mother with zero danger
// signs can still land in the 'watch' band (e.g. she's gone quiet for a
// week) — that's the point of this feature, not a bug.
//
// CLINICAL WEIGHTING (read before tuning): the ordering intent in the P6
// spec is a strict priority — (1) danger signs in the last 7 days, which
// "dominate everything else", (2) riskLevel high > moderate > low, (3)
// quiet days since last check-in, (4) ANC contacts behind schedule for
// gestational age. The weights below are chosen so that priority holds
// via SCORE MAGNITUDE alone (no separate band-forcing branch to keep in
// sync): any single tier-1 or tier-2 "severe" signal by itself already
// clears the 'urgent' threshold; a tier-2 "moderate" or a strong tier-3
// signal clears 'watch' but not 'urgent' on its own; tier-4 (ANC) is
// weighted lightest and only reaches 'watch' when meaningfully behind,
// never 'urgent' by itself. Tune the numbers, but preserve that ordering
// property — it's what a future reader would break by, say, bumping
// ANC_BEHIND_CAP above RISK_MODERATE without noticing.

/** The band a mother's triage score maps to — the coarse grouping the
 *  provider panel sorts/groups by. 'urgent' -> "needs attention today";
 *  'watch' -> worth a look this week; 'ok' -> nothing currently flagged. */
export type TriageBand = 'urgent' | 'watch' | 'ok';

/**
 * Everything assessTriage() needs about one mother, already computed by
 * the caller (GET /provider/patients' buildPatientPanelRow in
 * apps/server/src/app.ts) from data this codebase already produces —
 * this module invents no new data source. `riskLevel` is the provider
 * panel's existing derived risk classification (computeProviderRiskLevel
 * in app.ts), not the unused `users.risk_level` column — see that
 * function's own comment for why.
 */
export interface TriageInput {
  /** Count of days in the last 7 with a red-flagged journal entry
   *  (mirrors TrendSummary#redFlagDays over a 7-day window). */
  redFlags7d: number;
  riskLevel: 'high' | 'moderate' | 'low' | null;
  /** ISO timestamp of the most recent check-in, or null if none on
   *  record (never journaled, or her last entry fell outside whatever
   *  window the caller queried). */
  lastCheckInAt: string | null;
  pregnancyWeek: number | null;
  /** Count of ANC visits attended so far (users.anc_visits). */
  ancVisits: number | null;
}

export interface TriageResult {
  /** Higher = needs attention sooner. Meaningful only for SORTING within
   *  a panel — never shown to a user (see the file header on `reasons`
   *  being the user-facing surface instead) and not comparable across
   *  releases of this module (the weights are free to change). */
  score: number;
  /** Short, plain-clinical-language phrases explaining the score, most
   *  important first — these render directly in the provider UI, so no
   *  jargon and no raw numbers/weights leak into them. Never empty:
   *  a mother with nothing flagged still gets one reassuring phrase
   *  (`NO_CONCERNS_REASON`) so the UI always has something to show. */
  reasons: string[];
  band: TriageBand;
}

// --- Weights (see file header for the priority-via-magnitude rationale) ----

/** Tier 1 — danger signs dominate everything else. A single red-flagged
 *  day this week already clears URGENT_THRESHOLD on its own. */
const DANGER_SIGN_BASE = 50;
/** Each additional red-flag day nudges the score further (so a mother
 *  with 3 flagged days outranks one with 1, both already 'urgent') —
 *  capped so a very high count can't make the score meaningless for
 *  sorting against other urgent mothers. */
const DANGER_SIGN_PER_EXTRA_DAY = 6;
const DANGER_SIGN_EXTRA_DAY_CAP = 4; // extra days beyond the first that still count

/** Tier 2 — riskLevel. 'high' specifically means a CRITICAL escalation
 *  in the panel's own recent window (computeProviderRiskLevel in app.ts)
 *  — clinically as serious as an active danger sign, so it also clears
 *  URGENT_THRESHOLD alone. 'moderate' (any escalation, or any red-flag
 *  day, without a critical one) is a real but lesser signal — clears
 *  WATCH_THRESHOLD, not urgent, on its own. */
const RISK_HIGH = 45;
const RISK_MODERATE = 18;

/** Tier 3 — quiet days since last check-in. "3+ days is a watch signal,
 *  7+ is stronger" (P6 spec) — QUIET_3_TO_6_DAYS is set to exactly clear
 *  WATCH_THRESHOLD (the minimum the spec asks for); QUIET_7_PLUS_DAYS is
 *  meaningfully higher (a stronger watch signal) but still well under
 *  URGENT_THRESHOLD — going silent is a safety+churn signal worth a
 *  provider's attention, not on its own the same as a confirmed danger
 *  sign or a critical escalation. A mother with NO check-in on record at
 *  all (never journaled) gets only a mild bump — she may simply be a
 *  brand-new enrollment, not someone who "went quiet".
 */
const QUIET_7_PLUS_DAYS = 25;
const QUIET_3_TO_6_DAYS = 15;
const QUIET_NEVER_CHECKED_IN = 4;
const QUIET_DAYS_STRONG_THRESHOLD = 7;
const QUIET_DAYS_WEAK_THRESHOLD = 3;

/**
 * Tier 4 — ANC contacts behind schedule. Kenya MoH's focused-ANC model
 * targets 8 contacts across a pregnancy, front-loaded toward the third
 * trimester as risk rises with gestational age (first contact before 12
 * weeks, then roughly every 4-6 weeks, tightening to every 2 weeks after
 * 36 weeks) rather than evenly spaced across all 40 weeks —
 * ANC_CONTACT_THRESHOLD_WEEKS below approximates that real schedule: the
 * Nth contact is "due" once pregnancyWeek reaches
 * ANC_CONTACT_THRESHOLD_WEEKS[N-1]. Weighted lightest of the four tiers
 * per the spec's priority order — being one contact behind barely moves
 * the score; being several behind can reach WATCH_THRESHOLD but never
 * URGENT_THRESHOLD on its own.
 */
const ANC_CONTACT_THRESHOLD_WEEKS: readonly number[] = [12, 20, 26, 30, 34, 36, 38, 40];
const ANC_BEHIND_PER_CONTACT = 5;
const ANC_BEHIND_CAP = 15;

const URGENT_THRESHOLD = 40;
const WATCH_THRESHOLD = 15;

const NO_CONCERNS_REASON = 'No concerns flagged recently';

/** Number of whole ANC contacts due by `pregnancyWeek` under Kenya MoH's
 *  8-contact schedule (see ANC_CONTACT_THRESHOLD_WEEKS above). Exported
 *  for reuse by cohort.ts's ancAdherencePct, so both features agree on
 *  the same approximation instead of drifting apart. */
export function expectedAncContacts(pregnancyWeek: number): number {
  return ANC_CONTACT_THRESHOLD_WEEKS.filter((w) => pregnancyWeek >= w).length;
}

/** Whole days between `iso` and `now`, clamped to 0 for a timestamp that
 *  (due to clock skew, or simply being "right now") reads as being in
 *  the future. Exported for reuse by cohort.ts's checkInRatePct — both
 *  features need the same "how long ago was her last check-in" math. */
export function daysSince(iso: string, now: Date): number {
  const ms = now.getTime() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / (24 * 3600 * 1000)));
}

export function assessTriage(input: TriageInput, now: Date): TriageResult {
  let score = 0;
  const reasons: string[] = [];

  // Tier 1: danger signs this week.
  if (input.redFlags7d > 0) {
    const extraDays = Math.min(input.redFlags7d - 1, DANGER_SIGN_EXTRA_DAY_CAP);
    score += DANGER_SIGN_BASE + extraDays * DANGER_SIGN_PER_EXTRA_DAY;
    reasons.push(
      input.redFlags7d === 1
        ? '1 danger sign flagged this week'
        : `${input.redFlags7d} danger signs flagged this week`
    );
  }

  // Tier 2: derived risk level.
  if (input.riskLevel === 'high') {
    score += RISK_HIGH;
    reasons.push('Recent activity marked high risk (critical escalation this week)');
  } else if (input.riskLevel === 'moderate') {
    score += RISK_MODERATE;
    reasons.push('Recent activity marked moderate risk');
  }

  // Tier 3: quiet days since last check-in.
  if (input.lastCheckInAt == null) {
    score += QUIET_NEVER_CHECKED_IN;
    reasons.push('No check-ins recorded yet');
  } else {
    const quietDays = daysSince(input.lastCheckInAt, now);
    if (quietDays >= QUIET_DAYS_STRONG_THRESHOLD) {
      score += QUIET_7_PLUS_DAYS;
      reasons.push(`No check-in in ${quietDays} days`);
    } else if (quietDays >= QUIET_DAYS_WEAK_THRESHOLD) {
      score += QUIET_3_TO_6_DAYS;
      reasons.push(`No check-in in ${quietDays} days`);
    }
  }

  // Tier 4: ANC contacts behind schedule for gestational age.
  if (input.pregnancyWeek != null && input.pregnancyWeek > 0) {
    const expected = expectedAncContacts(input.pregnancyWeek);
    const actual = input.ancVisits ?? 0;
    const behind = expected - actual;
    if (behind > 0) {
      score += Math.min(behind * ANC_BEHIND_PER_CONTACT, ANC_BEHIND_CAP);
      reasons.push(`Behind on antenatal visits (${actual} of ${expected} expected by this stage)`);
    }
  }

  const band: TriageBand =
    score >= URGENT_THRESHOLD ? 'urgent' : score >= WATCH_THRESHOLD ? 'watch' : 'ok';

  if (reasons.length === 0) reasons.push(NO_CONCERNS_REASON);

  return { score, reasons, band };
}
