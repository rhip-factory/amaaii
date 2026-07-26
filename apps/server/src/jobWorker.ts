// Job worker/poller (P4-A). Drains the durable SQLite job queue
// (apps/server/src/database.ts's enqueueJob/claimDueJobs/... facade,
// backed by packages/adapters/src/sqlite/jobRepository.ts) via a plain
// setInterval poll loop. Replaces the in-process
// `setTimeout(..., 3600000)` the check-in follow-up used to run directly
// out of handleIncomingMessage — see CLAUDE.md's Architecture section
// and messageHandler.ts's sendCheckinFollowup for the migrated handler.
//
// TEST ISOLATION: nothing in this file runs a timer merely by being
// imported. `startJobWorker()` is the only thing that calls
// `setInterval`, and the only caller of `startJobWorker()` in this
// codebase is apps/server/src/index.ts's `startServer()` — which no
// test imports (vitest drives the app via `createApp()` /
// `handleIncomingMessage()` directly; index.ts is boot-only wiring).
// `runOnce()` is exported separately precisely so tests can drive a
// single poll cycle deterministically instead of waiting on a real
// timer — see tests/jobWorker.test.ts.

import { log } from './logger';
import * as db from './database';
import type { JobRecord } from '@amaaii/core';

export type JobHandler = (payload: Record<string, unknown>, job: JobRecord) => Promise<void>;

// Env-configurable poll interval — read lazily inside startJobWorker
// (not at module load) so tests that set process.env.JOB_POLL_MS after
// import still take effect, same "read env at call time, not import
// time" pattern as messageHandler.ts#privacyNoticeUrl.
const DEFAULT_POLL_MS = 15_000;
const DEFAULT_CLAIM_LIMIT = 10;
// A job stuck in 'running' longer than this is presumed to belong to a
// worker that crashed mid-execution (the process died before markDone/
// markFailedOrRetry ever ran) — see reclaimStuck's doc comment in
// repositories.ts. Comfortably longer than any handler this codebase
// registers should ever take (a single WhatsApp send), short enough
// that a genuine crash doesn't leave a job stranded for long.
const DEFAULT_STALE_MS = 5 * 60_000;

const handlers = new Map<string, JobHandler>();

/** Registers the handler for a job `type`. Call once per type, typically
 *  at server boot (apps/server/src/index.ts) before starting the
 *  poller. Registering the same type twice replaces the previous
 *  handler — convenient for tests, harmless in production (boot only
 *  registers each type once). */
export function registerJobHandler(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

/** Test seam: clears every registered handler, so a test can assert on
 *  "unregistered type" behavior or simulate a fresh process re-doing
 *  its boot-time registration from scratch. Never called from
 *  production code. */
export function __clearJobHandlers(): void {
  handlers.clear();
}

export interface RunOnceOptions {
  /** Max jobs claimed in this cycle. Default DEFAULT_CLAIM_LIMIT. */
  limit?: number;
  /** Identifies this worker in the jobs table's locked_by column
   *  (prefixed onto a unique per-claim token — see the SQLite adapter).
   *  Default derived from the process id. */
  workerId?: string;
  /** How long a 'running' job can go unfinished before reclaimStuck
   *  treats it as crashed. Default DEFAULT_STALE_MS. */
  staleMs?: number;
}

export interface RunOnceResult {
  reclaimed: number;
  claimed: number;
  succeeded: number;
  failed: number;
}

/**
 * Runs exactly one poll cycle: reclaim stale 'running' jobs, claim due
 * 'pending' ones, execute each via its registered handler. Never throws
 * — every failure mode (a throwing handler, an unregistered type, a
 * malformed payload, even a DB error on reclaim/claim) is caught and
 * turned into either a per-job retry/failure or a logged-and-swallowed
 * cycle-level error, so a caller (the setInterval loop below, or a test)
 * never needs its own try/catch around this.
 */
export async function runOnce(now: Date = new Date(), opts: RunOnceOptions = {}): Promise<RunOnceResult> {
  const nowIso = now.toISOString();
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const workerId = opts.workerId ?? `worker-${process.pid}`;
  const limit = opts.limit ?? DEFAULT_CLAIM_LIMIT;

  let reclaimed = 0;
  try {
    reclaimed = await db.reclaimStuckJobs(nowIso, staleMs);
    if (reclaimed > 0) log.info(`jobWorker: reclaimed ${reclaimed} stale job(s)`);
  } catch (err) {
    log.error('jobWorker: reclaimStuck failed', err);
  }

  let claimed: JobRecord[] = [];
  try {
    claimed = await db.claimDueJobs(nowIso, limit, workerId);
  } catch (err) {
    log.error('jobWorker: claimDueJobs failed', err);
    return { reclaimed, claimed: 0, succeeded: 0, failed: 0 };
  }

  let succeeded = 0;
  let failed = 0;

  for (const job of claimed) {
    try {
      const handler = handlers.get(job.type);
      if (!handler) {
        throw new Error(`No job handler registered for type "${job.type}"`);
      }
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(job.payload) as Record<string, unknown>;
      } catch {
        throw new Error('Job payload is not valid JSON');
      }
      await handler(payload, job);
      await db.markJobDone(job.id);
      succeeded += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      log.error(`jobWorker: job ${job.id} (type "${job.type}") failed`, err);
      try {
        await db.markJobFailedOrRetry(job.id, message, nowIso);
      } catch (markErr) {
        // The handler failed AND we couldn't even record that failure —
        // log loudly, but still don't throw: this job is stuck
        // 'running' until reclaimStuck picks it up on a later cycle,
        // which is the documented crash-recovery path, not a special
        // case we need to invent here.
        log.error(`jobWorker: failed to record failure for job ${job.id}`, markErr);
      }
    }
  }

  return { reclaimed, claimed: claimed.length, succeeded, failed };
}

let intervalHandle: NodeJS.Timeout | null = null;

/**
 * Starts the poll loop on an interval (default JOB_POLL_MS env var, else
 * DEFAULT_POLL_MS). Idempotent — calling this while already running logs
 * a warning and returns the existing stop function rather than starting
 * a second overlapping loop. Returns `stopJobWorker` for convenience
 * (`const stop = startJobWorker(); ...; stop();`).
 */
export function startJobWorker(pollMs?: number): () => void {
  if (intervalHandle) {
    log.warn('jobWorker: startJobWorker() called while already running — ignoring');
    return stopJobWorker;
  }
  const interval = pollMs ?? (Number(process.env.JOB_POLL_MS) || DEFAULT_POLL_MS);
  log.info(`jobWorker: starting (poll interval ${interval}ms)`);

  intervalHandle = setInterval(() => {
    // runOnce() already catches every failure mode internally (see its
    // own doc comment); this .catch is a final backstop so a bug in
    // that guarantee still can't take the interval — and therefore the
    // server process — down.
    runOnce().catch((err) => {
      log.error('jobWorker: unexpected error escaped runOnce()', err);
    });
  }, interval);

  // Doesn't hold the process open on its own — a host that forgets to
  // call stopJobWorker() on shutdown (or a test that never starts the
  // worker in the first place) is never blocked by this timer alone.
  intervalHandle.unref?.();

  return stopJobWorker;
}

/** Stops the poll loop started by startJobWorker(). Safe to call even if
 *  the worker was never started (no-op). */
export function stopJobWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    log.info('jobWorker: stopped');
  }
}
