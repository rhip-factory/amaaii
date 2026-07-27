// SQLite-backed integration tests for JobRepository (P4-A durable job
// queue): packages/adapters/src/sqlite/jobRepository.ts, exercised
// directly through createSqliteDatabaseAdapter (NOT through the
// apps/server/src/database.ts facade — that facade is a process-wide
// singleton bound to one DB_PATH at import time, which is exactly what
// this file needs to get AROUND: several tests below construct TWO
// independent adapter instances against the SAME scratch DB file to
// prove claims are exclusive across separate connections, and — the
// restart-durability proof — that a job enqueued via one connection is
// visible to and claimable by an entirely different, later-constructed
// connection, the same way a freshly-booted server process would open
// the same on-disk file after a restart and find the row still there).
//
// Each test gets its OWN scratch DB file (not one shared across the
// whole suite): claimDueJobs' due-jobs query has no per-test namespacing
// (unlike e.g. saveConversation's user_phone column), so jobs left
// pending by one test (deliberately, e.g. the "respects the limit"
// test) would otherwise accumulate and pollute run_at-ordered claims in
// every test that runs after it. A fresh file per test — like
// tests/insights.test.ts's single shared scratch file, but taken one
// step further — makes every test fully order-independent.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqliteDatabaseAdapter } from '@amaaii/adapters';
import type { DatabaseAdapter } from '@amaaii/core';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amaaii-jobs-repo-test-'));

afterAll(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

let fileCounter = 0;
function freshDbPath(): string {
  fileCounter += 1;
  return path.join(scratchDir, `jobs-${fileCounter}.db`);
}

/** A fresh adapter (= a fresh sqlite3.Database connection) against a
 *  BRAND NEW scratch file, unless `dbPath` is passed — pass the same
 *  path twice to get two independent connections to the same file
 *  (what the cross-connection tests need). */
async function freshAdapter(dbPath: string = freshDbPath()): Promise<DatabaseAdapter> {
  const adapter = createSqliteDatabaseAdapter(dbPath);
  await adapter.initialize();
  return adapter;
}

describe('JobRepository#enqueue', () => {
  it('inserts a pending job with the given type/payload/runAt', async () => {
    const db = await freshAdapter();
    const runAt = '2026-01-01T00:00:00.000Z';
    const job = await db.jobs.enqueue({ type: 'checkin_followup', payload: { phone: 'whatsapp:+254700000101' }, runAt });
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(0);
    expect(job.runAt).toBe(runAt);
    expect(JSON.parse(job.payload)).toEqual({ phone: 'whatsapp:+254700000101' });
    expect(job.lockedAt).toBeNull();
    expect(job.lockedBy).toBeNull();
  });

  it('defaults maxAttempts when not provided', async () => {
    const db = await freshAdapter();
    const job = await db.jobs.enqueue({ type: 'checkin_followup', payload: {}, runAt: '2026-01-01T00:00:00.000Z' });
    expect(job.maxAttempts).toBeGreaterThan(0);
  });

  it('respects an explicit maxAttempts', async () => {
    const db = await freshAdapter();
    const job = await db.jobs.enqueue({
      type: 'checkin_followup',
      payload: {},
      runAt: '2026-01-01T00:00:00.000Z',
      maxAttempts: 2,
    });
    expect(job.maxAttempts).toBe(2);
  });

  it('a second enqueue with the same dedupeKey is a no-op returning the EXISTING job', async () => {
    const db = await freshAdapter();
    const dedupeKey = 'checkin_followup:whatsapp:+254700000102:2026-01-01T09';
    const first = await db.jobs.enqueue({
      type: 'checkin_followup',
      payload: { attempt: 1 },
      runAt: '2026-01-01T00:00:00.000Z',
      dedupeKey,
    });
    const second = await db.jobs.enqueue({
      type: 'checkin_followup',
      payload: { attempt: 2 }, // different payload — must be ignored
      runAt: '2099-01-01T00:00:00.000Z', // different runAt — must be ignored
      dedupeKey,
    });
    expect(second.id).toBe(first.id);
    expect(JSON.parse(second.payload)).toEqual({ attempt: 1 });
    expect(second.runAt).toBe('2026-01-01T00:00:00.000Z');

    const third = await db.jobs.enqueue({
      type: 'checkin_followup',
      payload: {},
      runAt: '2026-01-01T00:00:00.000Z',
      dedupeKey,
    });
    expect(third.id).toBe(first.id);

    const counts = await db.jobs.countByStatus();
    expect(counts.pending).toBe(1); // exactly one row total in this fresh file
  });

  // P4-B: DPA erasure gap fix — jobs.user_phone lets DELETE /me/account's
  // erasure cascade (packages/adapters/src/sqlite/erasure.ts) clear a
  // user's pending jobs. See JobRecord#userPhone's doc comment in
  // packages/core/src/repositories.ts for the full rationale.
  it('P4-B: populates userPhone from a string `phone` field in the payload', async () => {
    const db = await freshAdapter();
    const job = await db.jobs.enqueue({
      type: 'checkin_followup',
      payload: { phone: 'whatsapp:+254700000777' },
      runAt: '2026-01-01T00:00:00.000Z',
    });
    expect(job.userPhone).toBe('whatsapp:+254700000777');
  });

  it('P4-B: leaves userPhone null when the payload has no string `phone` field', async () => {
    const db = await freshAdapter();
    const withoutPhone = await db.jobs.enqueue({
      type: 'checkin_followup',
      payload: { i: 1 },
      runAt: '2026-01-01T00:00:00.000Z',
    });
    expect(withoutPhone.userPhone).toBeNull();

    const nonStringPhone = await db.jobs.enqueue({
      type: 'checkin_followup',
      payload: { phone: 12345 },
      runAt: '2026-01-01T00:00:00.000Z',
    });
    expect(nonStringPhone.userPhone).toBeNull();
  });

  it('two DIFFERENT dedupeKeys never collide with each other', async () => {
    const db = await freshAdapter();
    const a = await db.jobs.enqueue({
      type: 'checkin_followup',
      payload: {},
      runAt: '2026-01-01T00:00:00.000Z',
      dedupeKey: 'a',
    });
    const b = await db.jobs.enqueue({
      type: 'checkin_followup',
      payload: {},
      runAt: '2026-01-01T00:00:00.000Z',
      dedupeKey: 'b',
    });
    expect(a.id).not.toBe(b.id);
  });

  it('jobs with NO dedupeKey never collide, even with identical type/payload/runAt', async () => {
    const db = await freshAdapter();
    const a = await db.jobs.enqueue({ type: 'checkin_followup', payload: { x: 1 }, runAt: '2026-01-01T00:00:00.000Z' });
    const b = await db.jobs.enqueue({ type: 'checkin_followup', payload: { x: 1 }, runAt: '2026-01-01T00:00:00.000Z' });
    expect(a.id).not.toBe(b.id);
  });
});

describe('JobRepository#claimDueJobs', () => {
  it('claims only jobs that are BOTH pending and due, leaving future-dated jobs alone', async () => {
    const db = await freshAdapter();
    const due = await db.jobs.enqueue({ type: 'checkin_followup', payload: {}, runAt: '2020-01-01T00:00:00.000Z' });
    const future = await db.jobs.enqueue({ type: 'checkin_followup', payload: {}, runAt: '2099-01-01T00:00:00.000Z' });

    const claimed = await db.jobs.claimDueJobs('2026-01-01T00:00:00.000Z', 10, 'test-worker');
    const claimedIds = claimed.map((j) => j.id);
    expect(claimedIds).toContain(due.id);
    expect(claimedIds).not.toContain(future.id);
  });

  it('marks claimed jobs as running with locked_at/locked_by set', async () => {
    const db = await freshAdapter();
    const job = await db.jobs.enqueue({ type: 'checkin_followup', payload: {}, runAt: '2020-01-01T00:00:00.000Z' });

    const [claimed] = await db.jobs.claimDueJobs('2026-01-01T00:00:00.000Z', 10, 'worker-A');
    expect(claimed.id).toBe(job.id);
    expect(claimed.status).toBe('running');
    expect(claimed.lockedAt).not.toBeNull();
    expect(claimed.lockedBy).toContain('worker-A');
  });

  it('a second claim call does not re-grab a job the first call already claimed', async () => {
    const db = await freshAdapter();
    const job = await db.jobs.enqueue({ type: 'checkin_followup', payload: {}, runAt: '2020-01-01T00:00:00.000Z' });

    const firstClaim = await db.jobs.claimDueJobs('2026-01-01T00:00:00.000Z', 10, 'worker-A');
    expect(firstClaim.map((j) => j.id)).toContain(job.id);

    const secondClaim = await db.jobs.claimDueJobs('2026-01-01T00:00:00.000Z', 10, 'worker-B');
    expect(secondClaim.map((j) => j.id)).not.toContain(job.id);
  });

  it('respects the limit parameter', async () => {
    const db = await freshAdapter();
    for (let i = 0; i < 5; i += 1) {
      await db.jobs.enqueue({ type: 'checkin_followup', payload: { i }, runAt: '2020-01-01T00:00:00.000Z' });
    }
    const claimed = await db.jobs.claimDueJobs('2026-01-01T00:00:00.000Z', 3, 'worker-limit');
    expect(claimed).toHaveLength(3);
  });

  it('CROSS-CONNECTION: a job claimed by one adapter instance is not re-claimable by a second, independent instance against the same file', async () => {
    const dbPath = freshDbPath();
    const dbA = await freshAdapter(dbPath);
    const dbB = await freshAdapter(dbPath); // separate sqlite3.Database connection, same file
    const job = await dbA.jobs.enqueue({ type: 'checkin_followup', payload: {}, runAt: '2020-01-01T00:00:00.000Z' });

    const claimedByA = await dbA.jobs.claimDueJobs('2026-01-01T00:00:00.000Z', 10, 'worker-A');
    expect(claimedByA.map((j) => j.id)).toContain(job.id);

    const claimedByB = await dbB.jobs.claimDueJobs('2026-01-01T00:00:00.000Z', 10, 'worker-B');
    expect(claimedByB.map((j) => j.id)).not.toContain(job.id);
  });
});

describe('JobRepository#markDone', () => {
  it('sets status to done and clears the lock', async () => {
    const db = await freshAdapter();
    const job = await db.jobs.enqueue({ type: 'checkin_followup', payload: {}, runAt: '2020-01-01T00:00:00.000Z' });
    const [claimed] = await db.jobs.claimDueJobs('2026-01-01T00:00:00.000Z', 10, 'w1');

    await db.jobs.markDone(claimed.id);

    // Re-claim attempt should find nothing — a 'done' job is never due again.
    const reclaim = await db.jobs.claimDueJobs('2027-01-01T00:00:00.000Z', 10, 'w2');
    expect(reclaim.map((j) => j.id)).not.toContain(job.id);

    const counts = await db.jobs.countByStatus();
    expect(counts.done).toBe(1);
  });
});

describe('JobRepository#markFailedOrRetry', () => {
  it('requeues with backoff on a retryable failure (attempts < maxAttempts)', async () => {
    const db = await freshAdapter();
    const job = await db.jobs.enqueue({
      type: 'checkin_followup',
      payload: {},
      runAt: '2020-01-01T00:00:00.000Z',
      maxAttempts: 5,
    });
    const [claimed] = await db.jobs.claimDueJobs('2026-01-01T00:00:00.000Z', 10, 'w1');
    expect(claimed.id).toBe(job.id);

    const now = '2026-01-01T00:00:00.000Z';
    await db.jobs.markFailedOrRetry(claimed.id, 'boom', now);

    // Not claimable immediately at the same `now` — backoff pushed run_at forward.
    const immediateReclaim = await db.jobs.claimDueJobs(now, 10, 'w2');
    expect(immediateReclaim.map((j) => j.id)).not.toContain(job.id);

    // But IS claimable once enough time (the 1-minute first-attempt backoff) has passed.
    const later = '2026-01-01T00:01:00.000Z';
    const laterClaim = await db.jobs.claimDueJobs(later, 10, 'w3');
    expect(laterClaim.map((j) => j.id)).toContain(job.id);
    expect(laterClaim[0].attempts).toBe(1);
    expect(laterClaim[0].lastError).toBe('boom');
  });

  it('marks permanently failed once maxAttempts is exhausted', async () => {
    const db = await freshAdapter();
    await db.jobs.enqueue({
      type: 'checkin_followup',
      payload: {},
      runAt: '2020-01-01T00:00:00.000Z',
      maxAttempts: 1,
    });

    const now = '2026-01-01T00:00:00.000Z';
    const [claimed] = await db.jobs.claimDueJobs(now, 10, 'w1');
    expect(claimed.maxAttempts).toBe(1);

    await db.jobs.markFailedOrRetry(claimed.id, 'permanent failure', now);

    const counts = await db.jobs.countByStatus();
    expect(counts.failed).toBe(1);

    // Never becomes claimable again, even far in the future.
    const farFuture = '2099-01-01T00:00:00.000Z';
    const reclaim = await db.jobs.claimDueJobs(farFuture, 100, 'w2');
    expect(reclaim.map((j) => j.id)).not.toContain(claimed.id);
  });

  it('after several retries, eventually reaches failed (schedule: 1m, 5m, 30m then give up at maxAttempts=3)', async () => {
    const db = await freshAdapter();
    await db.jobs.enqueue({
      type: 'checkin_followup',
      payload: {},
      runAt: '2020-01-01T00:00:00.000Z',
      maxAttempts: 3,
    });

    let now = new Date('2026-06-01T00:00:00.000Z');
    let jobId: number | null = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await db.jobs.claimDueJobs(now.toISOString(), 10, `w${attempt}`);
      expect(claimed).toHaveLength(1);
      jobId = claimed[0].id;
      await db.jobs.markFailedOrRetry(claimed[0].id, `failure #${attempt}`, now.toISOString());
      // jump far enough forward that any backoff tier is definitely elapsed
      now = new Date(now.getTime() + 40 * 60_000);
    }

    const counts = await db.jobs.countByStatus();
    expect(counts.failed).toBe(1);
    const finalClaim = await db.jobs.claimDueJobs(now.toISOString(), 10, 'w-final');
    expect(finalClaim.map((j) => j.id)).not.toContain(jobId);
  });
});

describe('JobRepository#reclaimStuck', () => {
  it('requeues a job stuck in running past the stale threshold', async () => {
    const db = await freshAdapter();
    await db.jobs.enqueue({ type: 'checkin_followup', payload: {}, runAt: '2020-01-01T00:00:00.000Z' });

    const claimedAt = '2026-01-01T00:00:00.000Z';
    const [claimed] = await db.jobs.claimDueJobs(claimedAt, 10, 'crashed-worker');
    expect(claimed.status).toBe('running');

    // 10 minutes later, well past a 5-minute staleMs threshold.
    const later = '2026-01-01T00:10:00.000Z';
    const reclaimedCount = await db.jobs.reclaimStuck(later, 5 * 60_000);
    expect(reclaimedCount).toBe(1);

    // reclaimStuck applies the SAME backoff policy as markFailedOrRetry
    // (a stale lock counts as a failed attempt) — the requeued run_at is
    // `later` + the 1st-attempt backoff (1 minute), not immediately due
    // at `later` itself. Confirm it's not claimable yet at `later`...
    const tooSoon = await db.jobs.claimDueJobs(later, 10, 'too-soon-worker');
    expect(tooSoon.map((j) => j.id)).not.toContain(claimed.id);

    // ...but IS claimable once that backoff has elapsed.
    const afterBackoff = '2026-01-01T00:11:00.000Z';
    const reclaimAttempt = await db.jobs.claimDueJobs(afterBackoff, 10, 'recovery-worker');
    expect(reclaimAttempt.map((j) => j.id)).toContain(claimed.id);
    expect(reclaimAttempt[0].attempts).toBe(1);
    expect(reclaimAttempt[0].lastError).toMatch(/stale lock/i);
  });

  it('leaves a running job alone if it is still within the stale threshold', async () => {
    const db = await freshAdapter();
    await db.jobs.enqueue({ type: 'checkin_followup', payload: {}, runAt: '2020-01-01T00:00:00.000Z' });

    const claimedAt = '2026-01-01T00:00:00.000Z';
    const [claimed] = await db.jobs.claimDueJobs(claimedAt, 10, 'fast-worker');

    // Only 1 minute later, well under a 5-minute staleMs threshold.
    const soon = '2026-01-01T00:01:00.000Z';
    const reclaimedCount = await db.jobs.reclaimStuck(soon, 5 * 60_000);
    expect(reclaimedCount).toBe(0);

    const counts = await db.jobs.countByStatus();
    expect(counts.running).toBe(1);
    // This specific job should not have been touched.
    const reclaimAttempt = await db.jobs.claimDueJobs(soon, 100, 'someone-else');
    expect(reclaimAttempt.map((j) => j.id)).not.toContain(claimed.id);
  });

  it('a stuck job that has exhausted maxAttempts is marked failed, not requeued forever', async () => {
    const db = await freshAdapter();
    await db.jobs.enqueue({ type: 'checkin_followup', payload: {}, runAt: '2020-01-01T00:00:00.000Z', maxAttempts: 1 });

    const claimedAt = '2026-01-01T00:00:00.000Z';
    const [claimed] = await db.jobs.claimDueJobs(claimedAt, 10, 'crash-once');
    const later = '2026-01-01T00:10:00.000Z';
    await db.jobs.reclaimStuck(later, 5 * 60_000);

    const counts = await db.jobs.countByStatus();
    expect(counts.failed).toBe(1);
    const reclaimAttempt = await db.jobs.claimDueJobs(later, 10, 'should-not-see-it');
    expect(reclaimAttempt.map((j) => j.id)).not.toContain(claimed.id);
  });
});

describe('JobRepository#countByStatus', () => {
  it('returns a count for every known status, defaulting missing ones to 0 on a brand-new file', async () => {
    const db = await freshAdapter();
    const counts = await db.jobs.countByStatus();
    expect(counts).toEqual({ pending: 0, running: 0, done: 0, failed: 0 });
  });
});

describe('RESTART DURABILITY (repository level)', () => {
  it('a job enqueued via one connection is visible + claimable via a SECOND, later-constructed connection to the same file — proves durability survives a process restart, not just an in-memory worker instance', async () => {
    const dbPath = freshDbPath();

    // "Before restart": one process (adapter instance) schedules a job.
    const beforeRestart = await freshAdapter(dbPath);
    const scheduled = await beforeRestart.jobs.enqueue({
      type: 'checkin_followup',
      payload: { phone: 'whatsapp:+254700000199' },
      runAt: '2020-01-01T00:00:00.000Z', // already due
    });
    expect(scheduled.status).toBe('pending');

    // "After restart": a BRAND NEW adapter/connection to the SAME file —
    // this constructor call is the literal thing apps/server/src/
    // database.ts does once at process boot, so a second call to it
    // here (same dbPath) stands in for "the process restarted and
    // booted a new one".
    const afterRestart = await freshAdapter(dbPath);
    const claimed = await afterRestart.jobs.claimDueJobs('2026-01-01T00:00:00.000Z', 10, 'post-restart-worker');
    expect(claimed.map((j) => j.id)).toContain(scheduled.id);

    const claimedJob = claimed.find((j) => j.id === scheduled.id)!;
    expect(JSON.parse(claimedJob.payload)).toEqual({ phone: 'whatsapp:+254700000199' });

    await afterRestart.jobs.markDone(claimedJob.id);
    const counts = await afterRestart.jobs.countByStatus();
    expect(counts.done).toBe(1);
  });
});
