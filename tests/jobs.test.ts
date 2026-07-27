// Pure decision logic for packages/core/src/jobs.ts (P4-A durable job
// queue). No I/O, no server, no database — every case constructs its
// own `now`/job shape by hand, same "unit behaviour" style as
// tests/consent.test.ts / tests/redaction.test.ts for other pure core
// modules.

import { describe, it, expect } from 'vitest';
import {
  JOB_BACKOFF_SCHEDULE_MS,
  DEFAULT_JOB_MAX_ATTEMPTS,
  computeBackoff,
  nextRunAt,
  shouldRetry,
  isDue,
} from '@amaaii/core';

describe('computeBackoff — schedule: 1m, 5m, 30m (cap)', () => {
  it('matches the documented schedule exactly', () => {
    expect(JOB_BACKOFF_SCHEDULE_MS).toEqual([60_000, 5 * 60_000, 30 * 60_000]);
  });

  it('1st failure (attempts=1) waits 1 minute', () => {
    expect(computeBackoff(1)).toBe(60_000);
  });

  it('2nd failure (attempts=2) waits 5 minutes', () => {
    expect(computeBackoff(2)).toBe(5 * 60_000);
  });

  it('3rd failure (attempts=3) waits 30 minutes', () => {
    expect(computeBackoff(3)).toBe(30 * 60_000);
  });

  it('4th and later failures stay capped at 30 minutes', () => {
    expect(computeBackoff(4)).toBe(30 * 60_000);
    expect(computeBackoff(10)).toBe(30 * 60_000);
    expect(computeBackoff(1000)).toBe(30 * 60_000);
  });

  it('attempts <= 0 is treated as a first failure (defensive)', () => {
    expect(computeBackoff(0)).toBe(60_000);
    expect(computeBackoff(-5)).toBe(60_000);
  });
});

describe('nextRunAt', () => {
  it('adds the computed backoff onto `now`', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(nextRunAt(now, 1).toISOString()).toBe('2026-01-01T00:01:00.000Z');
    expect(nextRunAt(now, 2).toISOString()).toBe('2026-01-01T00:05:00.000Z');
    expect(nextRunAt(now, 3).toISOString()).toBe('2026-01-01T00:30:00.000Z');
  });

  it('is a pure function of its inputs — no dependency on the real clock', () => {
    const now = new Date('2020-06-15T12:34:56.000Z');
    const a = nextRunAt(now, 1);
    const b = nextRunAt(now, 1);
    expect(a.toISOString()).toBe(b.toISOString());
  });
});

describe('shouldRetry', () => {
  it('true while attempts is below maxAttempts', () => {
    expect(shouldRetry(1, DEFAULT_JOB_MAX_ATTEMPTS)).toBe(true);
    expect(shouldRetry(4, DEFAULT_JOB_MAX_ATTEMPTS)).toBe(true);
  });

  it('false once attempts reaches maxAttempts (strict, not off-by-one)', () => {
    expect(shouldRetry(DEFAULT_JOB_MAX_ATTEMPTS, DEFAULT_JOB_MAX_ATTEMPTS)).toBe(false);
  });

  it('false when attempts exceeds maxAttempts', () => {
    expect(shouldRetry(DEFAULT_JOB_MAX_ATTEMPTS + 1, DEFAULT_JOB_MAX_ATTEMPTS)).toBe(false);
  });

  it('respects a custom, smaller maxAttempts', () => {
    expect(shouldRetry(1, 1)).toBe(false);
    expect(shouldRetry(0, 1)).toBe(true);
  });
});

describe('isDue', () => {
  const now = new Date('2026-03-10T10:00:00.000Z');

  it('true for a pending job whose run_at is in the past', () => {
    expect(isDue({ status: 'pending', runAt: '2026-03-10T09:59:59.000Z' }, now)).toBe(true);
  });

  it('true (inclusive) for a pending job whose run_at is exactly now', () => {
    expect(isDue({ status: 'pending', runAt: now.toISOString() }, now)).toBe(true);
  });

  it('false for a pending job scheduled in the future', () => {
    expect(isDue({ status: 'pending', runAt: '2026-03-10T10:00:01.000Z' }, now)).toBe(false);
  });

  it('false for a non-pending job even if its run_at is due', () => {
    expect(isDue({ status: 'running', runAt: '2020-01-01T00:00:00.000Z' }, now)).toBe(false);
    expect(isDue({ status: 'done', runAt: '2020-01-01T00:00:00.000Z' }, now)).toBe(false);
    expect(isDue({ status: 'failed', runAt: '2020-01-01T00:00:00.000Z' }, now)).toBe(false);
  });
});
