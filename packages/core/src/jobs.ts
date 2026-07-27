// Pure domain logic for the durable job queue (P4-A — see CLAUDE.md's
// Architecture note on the old in-process `setTimeout` follow-up, and
// the P4-A work order for the full design). No I/O, no `Date.now()`
// inside — every function here takes `now` as an explicit argument, same
// "deterministic given its inputs" discipline as otp.ts / dangerSigns.ts
// elsewhere in this package. The concrete queue (SQLite today, a future
// Postgres/Redis adapter tomorrow) lives in packages/adapters +
// apps/server; this file only decides WHEN a job should run next and
// WHETHER it should retry — never how it's stored or executed.

/** Lifecycle states a `jobs` row can be in. 'running' means a worker has
 *  claimed it (see JobRepository#claimDueJobs) but hasn't reported
 *  success/failure yet. */
export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

/**
 * Registry of known job types. Widen this union as new job types are
 * added (today there's exactly one: the migrated check-in follow-up —
 * see apps/server/src/messageHandler.ts#CHECKIN_FOLLOWUP_JOB_TYPE). Kept
 * as a real union (not a bare `string`) so a typo in a handler
 * registration or an enqueue call is a compile-time error, mirroring
 * Urgency/Mood/Symptom in types.ts.
 */
export type JobType = 'checkin_followup';

/**
 * Retry backoff schedule, in milliseconds, indexed by attempt number
 * (1st failure -> schedule[0], 2nd -> schedule[1], ...). The last entry
 * is also the cap: any attempt beyond the schedule's length reuses it
 * rather than growing further. Chosen to give a transient failure (e.g.
 * Twilio hiccup) a quick 1-minute retry, a slower 5-minute retry if that
 * also fails, then settle at a 30-minute cadence rather than hammering a
 * genuinely broken dependency.
 */
export const JOB_BACKOFF_SCHEDULE_MS: readonly number[] = [
  60_000, // 1 minute
  5 * 60_000, // 5 minutes
  30 * 60_000, // 30 minutes (cap — every attempt beyond this reuses it)
];

/** Default ceiling on retry attempts before a job is marked permanently
 *  'failed'. Chosen to match OTP_MAX_ATTEMPTS-style "small, documented
 *  constant" conventions elsewhere in this package; callers may pass a
 *  different `maxAttempts` per job at enqueue time. */
export const DEFAULT_JOB_MAX_ATTEMPTS = 5;

/**
 * Milliseconds to wait before the NEXT attempt, given `attempts` failures
 * so far (1-indexed: pass the POST-increment count, i.e. call this with
 * `1` right after the first failure, not `0`). `attempts <= 0` is
 * treated the same as `1` (defensive — there's no such thing as backoff
 * before a first failure has happened).
 */
export function computeBackoff(attempts: number): number {
  const idx = Math.max(0, Math.min(attempts - 1, JOB_BACKOFF_SCHEDULE_MS.length - 1));
  return JOB_BACKOFF_SCHEDULE_MS[idx];
}

/** The next `run_at` instant for a job that just failed for the
 *  `attempts`-th time, computed from an explicit clock (`now`) rather
 *  than `Date.now()` — see this file's header. */
export function nextRunAt(now: Date, attempts: number): Date {
  return new Date(now.getTime() + computeBackoff(attempts));
}

/**
 * Whether a job that has now failed `attempts` times should be retried
 * (true) or given up on (false, -> status 'failed'). Strict less-than:
 * `attempts === maxAttempts` has exhausted its budget.
 */
export function shouldRetry(attempts: number, maxAttempts: number): boolean {
  return attempts < maxAttempts;
}

/** Minimal shape isDue() needs — deliberately narrower than the
 *  repository's full JobRecord (see packages/core/src/repositories.ts)
 *  so this file stays free of any storage-layer import. */
export interface DueCheckInput {
  status: JobStatus;
  /** ISO timestamp string, same encoding every other `_at` column in
   *  this codebase uses (see JournalRow.timestamp, OtpRecord.expiresAt). */
  runAt: string;
}

/** A job is due when it's still pending AND its scheduled time has
 *  arrived (inclusive: `runAt === now` counts as due). */
export function isDue(job: DueCheckInput, now: Date): boolean {
  return job.status === 'pending' && Date.parse(job.runAt) <= now.getTime();
}
