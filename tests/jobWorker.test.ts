// apps/server/src/jobWorker.ts (P4-A poller) + the migrated check-in
// follow-up in apps/server/src/messageHandler.ts. Follows
// tests/messageHandler.test.js's pattern (tsx/cjs require, in-memory DB,
// dummy +2547000000xx phones, twilio __setSendImpl seam) since jobWorker
// and messageHandler both pull in the apps/server/src/database.ts
// process-wide singleton.
//
// TEST DESIGN NOTE: every test in this file shares ONE in-memory jobs
// table (same singleton `db`, same reasoning tests/messageHandler.test.js
// already relies on). Rather than asserting on runOnce()'s aggregate
// RunOnceResult counts (which would include whatever ELSE happens to be
// due in the shared table at that moment — fragile, order-dependent),
// each test tracks its OWN handler's calls via a local closure and uses
// a job `type` unique to that test, then asserts on what ITS OWN handler
// saw. This makes every test's correctness independent of what other
// tests in this file have left behind, without needing a separate
// scratch DB per test (see tests/jobsRepository.test.ts for the
// adapter-level suite, which DOES use one file per test — that one
// tests the storage layer directly and needed exact `countByStatus()`
// equality; this file tests the worker's execution loop and doesn't).
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs');

process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';

const db = require('../apps/server/src/database');
const tw = require('../packages/adapters/src/twilio');
const worker = require('../apps/server/src/jobWorker');
const mh = require('../apps/server/src/messageHandler');

const sent: { to: string; message: string }[] = [];

beforeAll(async () => {
  await db.initializeDatabase();
  tw.__setSendImpl(async (to: string, message: string) => {
    sent.push({ to, message });
    return { sid: 'mocked' };
  });
});

afterAll(() => {
  tw.__resetSendImpl();
  worker.stopJobWorker();
});

afterEach(() => {
  sent.length = 0;
  worker.__clearJobHandlers();
});

let phoneCounter = 5000;
function nextPhone(): string {
  phoneCounter += 1;
  return `whatsapp:+254700000${phoneCounter}`;
}

let typeCounter = 0;
function nextType(): string {
  typeCounter += 1;
  return `worker_test_job_${typeCounter}`;
}

describe('runOnce — executing a due job', () => {
  it('claims a due job, runs its registered handler, and marks it done', async () => {
    const type = nextType();
    const calls: unknown[] = [];
    worker.registerJobHandler(type, async (payload: unknown) => {
      calls.push(payload);
    });

    const job = await db.enqueueJob({ type, payload: { hello: 'world' }, runAt: '2020-01-01T00:00:00.000Z' });

    const now = new Date('2026-01-01T00:00:00.000Z');
    await worker.runOnce(now, { limit: 1000 });

    expect(calls).toEqual([{ hello: 'world' }]);

    // Running it again later must NOT call the handler a second time —
    // the job is 'done', never due again.
    await worker.runOnce(new Date(now.getTime() + 60_000), { limit: 1000 });
    expect(calls).toHaveLength(1);
    void job;
  });

  it('does not execute a job whose run_at is still in the future', async () => {
    const type = nextType();
    const calls: unknown[] = [];
    worker.registerJobHandler(type, async () => {
      calls.push(true);
    });
    await db.enqueueJob({ type, payload: {}, runAt: '2099-01-01T00:00:00.000Z' });

    await worker.runOnce(new Date('2026-01-01T00:00:00.000Z'), { limit: 1000 });
    expect(calls).toHaveLength(0);
  });
});

describe('runOnce — a throwing handler retries then fails', () => {
  it('retries per the backoff schedule, then gives up once maxAttempts is exhausted', async () => {
    const type = nextType();
    const attemptsSeenAtCall: number[] = [];
    worker.registerJobHandler(type, async (_payload: unknown, job: { attempts: number }) => {
      attemptsSeenAtCall.push(job.attempts);
      throw new Error('handler always fails');
    });

    await db.enqueueJob({ type, payload: {}, runAt: '2020-01-01T00:00:00.000Z', maxAttempts: 2 });

    const t0 = new Date('2026-02-01T00:00:00.000Z');
    await worker.runOnce(t0, { limit: 1000 }); // 1st attempt (attempts=0 at call time) -> fails -> requeued
    expect(attemptsSeenAtCall).toEqual([0]);

    // Not due yet (1-minute backoff hasn't elapsed) — handler not called again.
    await worker.runOnce(t0, { limit: 1000 });
    expect(attemptsSeenAtCall).toEqual([0]);

    const t1 = new Date(t0.getTime() + 61_000);
    await worker.runOnce(t1, { limit: 1000 }); // 2nd attempt (attempts=1) -> fails -> maxAttempts=2 exhausted -> failed
    expect(attemptsSeenAtCall).toEqual([0, 1]);

    // Permanently failed — never claimed/executed again, even much later.
    const t2 = new Date(t1.getTime() + 3_600_000);
    await worker.runOnce(t2, { limit: 1000 });
    expect(attemptsSeenAtCall).toEqual([0, 1]);
  });
});

describe('runOnce — an unregistered job type', () => {
  it('fails gracefully: does not throw, and does not crash the poll cycle', async () => {
    const type = nextType(); // deliberately never registered
    await db.enqueueJob({ type, payload: {}, runAt: '2020-01-01T00:00:00.000Z', maxAttempts: 1 });

    await expect(worker.runOnce(new Date('2026-01-01T00:00:00.000Z'), { limit: 1000 })).resolves.toBeDefined();
  });

  it('an unregistered job with maxAttempts=1 is permanently failed on its first cycle — even registering a handler afterward never gets called', async () => {
    const type = nextType();
    await db.enqueueJob({ type, payload: {}, runAt: '2020-01-01T00:00:00.000Z', maxAttempts: 1 });

    await worker.runOnce(new Date('2026-01-01T00:00:00.000Z'), { limit: 1000 });

    // Register a handler only NOW (too late — the job already exhausted
    // its single attempt while unregistered) and confirm it's simply
    // never claimable again, so the handler is never invoked.
    const calls: unknown[] = [];
    worker.registerJobHandler(type, async () => {
      calls.push(true);
    });
    await worker.runOnce(new Date('2027-01-01T00:00:00.000Z'), { limit: 1000 });
    expect(calls).toHaveLength(0);
  });
});

describe('MIGRATION — the check-in follow-up runs through the durable queue, not setTimeout', () => {
  it('a CRITICAL message enqueues a checkin_followup job; the worker sends it via the twilio seam exactly once once due', async () => {
    worker.registerJobHandler(mh.CHECKIN_FOLLOWUP_JOB_TYPE, (payload: unknown) => mh.sendCheckinFollowup(payload));

    const phone = nextPhone();
    await mh.handleIncomingMessage(phone, 'I am bleeding heavily', null);

    // Immediate reply already sent (the CRITICAL escalation copy).
    const immediate = sent.filter((s) => s.to === phone);
    expect(immediate).toHaveLength(1);
    expect(immediate[0].message).toMatch(/URGENT/i);

    // The follow-up isn't due for another hour — running the worker
    // "now" must NOT send it early.
    await worker.runOnce(new Date(), { limit: 1000 });
    expect(sent.filter((s) => s.to === phone)).toHaveLength(1);

    // Fast-forward past the 1-hour mark (runOnce takes an explicit
    // `now`, so this doesn't require real waiting or fake timers).
    const oneHourLater = new Date(Date.now() + 3_700_000);
    await worker.runOnce(oneHourLater, { limit: 1000 });

    const afterFollowup = sent.filter((s) => s.to === phone);
    expect(afterFollowup).toHaveLength(2);
    expect(afterFollowup[1].message).toBe(mh.CHECKIN_FOLLOWUP_MESSAGE);

    // Running the worker again must not send a SECOND follow-up — the
    // job is 'done'. This is the "exactly once in the common case"
    // guarantee (see sendCheckinFollowup's doc comment for the
    // documented at-least-once caveat under a genuine mid-send crash).
    await worker.runOnce(new Date(oneHourLater.getTime() + 60_000), { limit: 1000 });
    expect(sent.filter((s) => s.to === phone)).toHaveLength(2);
  });

  it('a non-high/critical urgency message never schedules a follow-up job at all', async () => {
    worker.registerJobHandler(mh.CHECKIN_FOLLOWUP_JOB_TYPE, (payload: unknown) => mh.sendCheckinFollowup(payload));
    const phone = nextPhone();
    // A brand-new phone's first message always lands on the consent
    // prompt (see messageHandler.ts's consent gate) with no danger signs
    // in "Hi there" — urgencyLevel resolves to 'low' either way, which
    // is all this test needs: proof that low/moderate urgency never
    // enqueues a follow-up, regardless of what branch produced it.
    await mh.handleIncomingMessage(phone, 'Hi there', null);

    const oneHourLater = new Date(Date.now() + 3_700_000);
    await worker.runOnce(oneHourLater, { limit: 1000 });

    const followups = sent.filter((s) => s.to === phone && s.message === mh.CHECKIN_FOLLOWUP_MESSAGE);
    expect(followups).toHaveLength(0);
  });
});

describe('RESTART DURABILITY (worker level)', () => {
  it('a pending+due job enqueued before "restart" is picked up by a freshly re-registered handler set — the worker holds no dependency on in-memory state from whoever scheduled it', async () => {
    const type = nextType();

    // "Before restart": something enqueues a job (could be a completely
    // different process — the point is the worker doesn't need to be
    // the one who scheduled it).
    await db.enqueueJob({
      type,
      payload: { note: 'scheduled before restart' },
      runAt: '2020-01-01T00:00:00.000Z',
    });

    // "Restart": wipe the in-memory handler registry (nothing has been
    // registered yet in a freshly-booted process) — the SQLite row is
    // the only thing that actually persisted.
    worker.__clearJobHandlers();

    // Re-registration is the first thing a real boot does (see
    // apps/server/src/index.ts's startServer(), which registers every
    // handler BEFORE calling startJobWorker()).
    const calls: unknown[] = [];
    worker.registerJobHandler(type, async (payload: unknown) => {
      calls.push(payload);
    });

    const result = await worker.runOnce(new Date('2026-01-01T00:00:00.000Z'), { limit: 1000 });

    expect(calls).toEqual([{ note: 'scheduled before restart' }]);
    expect(result.succeeded).toBeGreaterThanOrEqual(1);
  });
});

describe('startJobWorker / stopJobWorker lifecycle', () => {
  it('start then immediately stop does not throw, and stop is idempotent', () => {
    const stop = worker.startJobWorker(50);
    expect(() => stop()).not.toThrow();
    expect(() => worker.stopJobWorker()).not.toThrow(); // calling twice is a no-op
  });

  it('starting twice warns and returns the stop function without spawning a second loop', () => {
    const stopA = worker.startJobWorker(50);
    const stopB = worker.startJobWorker(50);
    expect(stopA).toBe(stopB);
    worker.stopJobWorker();
  });
});
