// Pure decision logic for packages/core/src/triage.ts (P6 provider
// triage queue). No I/O, no server, no database — every case constructs
// its own `now`/input shape by hand, same "unit behaviour" style as
// tests/jobs.test.ts / tests/consent.test.ts for other pure core
// modules.

import { describe, it, expect } from 'vitest';
import { assessTriage, expectedAncContacts, daysSince, type TriageInput } from '@amaaii/core';

const NOW = new Date('2026-06-15T12:00:00.000Z');

function baseInput(overrides: Partial<TriageInput> = {}): TriageInput {
  return {
    redFlags7d: 0,
    riskLevel: 'low',
    lastCheckInAt: NOW.toISOString(),
    pregnancyWeek: 20,
    ancVisits: 3,
    ...overrides,
  };
}

describe('assessTriage — band ordering', () => {
  it('a mother with no signals lands in "ok" with a reassuring reason, never an empty reasons array', () => {
    const result = assessTriage(baseInput(), NOW);
    expect(result.band).toBe('ok');
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons[0]).toMatch(/no concerns/i);
  });

  it('any danger sign in the last 7 days alone is enough to reach "urgent" — dominates everything else', () => {
    const result = assessTriage(baseInput({ redFlags7d: 1 }), NOW);
    expect(result.band).toBe('urgent');
    expect(result.reasons.some((r) => /danger sign/i.test(r))).toBe(true);
  });

  it('riskLevel "high" (critical escalation this week) alone is also enough to reach "urgent"', () => {
    const result = assessTriage(baseInput({ riskLevel: 'high' }), NOW);
    expect(result.band).toBe('urgent');
    expect(result.reasons.some((r) => /high risk/i.test(r))).toBe(true);
  });

  it('riskLevel "moderate" alone reaches "watch", not "urgent"', () => {
    const result = assessTriage(baseInput({ riskLevel: 'moderate' }), NOW);
    expect(result.band).toBe('watch');
    expect(result.reasons.some((r) => /moderate risk/i.test(r))).toBe(true);
  });

  it('more danger-sign days score higher than fewer — sortable within the urgent band', () => {
    const one = assessTriage(baseInput({ redFlags7d: 1 }), NOW);
    const three = assessTriage(baseInput({ redFlags7d: 3 }), NOW);
    expect(one.band).toBe('urgent');
    expect(three.band).toBe('urgent');
    expect(three.score).toBeGreaterThan(one.score);
  });

  it('danger signs outrank riskLevel high, which outranks riskLevel moderate, in score', () => {
    const danger = assessTriage(baseInput({ redFlags7d: 1 }), NOW);
    const high = assessTriage(baseInput({ riskLevel: 'high' }), NOW);
    const moderate = assessTriage(baseInput({ riskLevel: 'moderate' }), NOW);
    expect(danger.score).toBeGreaterThan(high.score);
    expect(high.score).toBeGreaterThan(moderate.score);
  });
});

describe('assessTriage — quiet-day thresholds', () => {
  it('a check-in 2 days ago is NOT a quiet-day signal (below the 3-day floor)', () => {
    const twoDaysAgo = new Date(NOW.getTime() - 2 * 24 * 3600 * 1000).toISOString();
    const result = assessTriage(baseInput({ lastCheckInAt: twoDaysAgo }), NOW);
    expect(result.band).toBe('ok');
    expect(result.reasons.some((r) => /no check-in/i.test(r))).toBe(false);
  });

  it('a check-in exactly 3 days ago crosses into "watch" ("3+ days is a watch signal")', () => {
    const threeDaysAgo = new Date(NOW.getTime() - 3 * 24 * 3600 * 1000).toISOString();
    const result = assessTriage(baseInput({ lastCheckInAt: threeDaysAgo }), NOW);
    expect(result.band).toBe('watch');
    expect(result.reasons.some((r) => /no check-in in 3 days/i.test(r))).toBe(true);
  });

  it('a check-in 7+ days ago is a STRONGER watch signal than 3-6 days, but still not urgent by itself', () => {
    const sixDaysAgo = new Date(NOW.getTime() - 6 * 24 * 3600 * 1000).toISOString();
    const sevenDaysAgo = new Date(NOW.getTime() - 7 * 24 * 3600 * 1000).toISOString();
    const midWeek = assessTriage(baseInput({ lastCheckInAt: sixDaysAgo }), NOW);
    const fullWeek = assessTriage(baseInput({ lastCheckInAt: sevenDaysAgo }), NOW);
    expect(midWeek.band).toBe('watch');
    expect(fullWeek.band).toBe('watch');
    expect(fullWeek.score).toBeGreaterThan(midWeek.score);
  });

  it('never having checked in at all (null) is only a MILD signal — she may just be newly enrolled', () => {
    const result = assessTriage(baseInput({ lastCheckInAt: null }), NOW);
    expect(result.band).toBe('ok');
    expect(result.reasons.some((r) => /no check-ins recorded yet/i.test(r))).toBe(true);
  });

  it('a "future" lastCheckInAt (clock skew) is clamped to 0 quiet days, not negative', () => {
    const future = new Date(NOW.getTime() + 3600_000).toISOString();
    const result = assessTriage(baseInput({ lastCheckInAt: future }), NOW);
    expect(result.band).toBe('ok');
  });
});

describe('assessTriage — ANC contacts behind schedule (lowest-priority tier)', () => {
  it('on schedule (ancVisits meets expectedAncContacts) contributes no reason', () => {
    // week 20 -> 2 contacts expected (12, 20 thresholds reached).
    const result = assessTriage(baseInput({ pregnancyWeek: 20, ancVisits: 2 }), NOW);
    expect(result.reasons.some((r) => /antenatal/i.test(r))).toBe(false);
  });

  it('meaningfully behind schedule alone reaches "watch" but never "urgent"', () => {
    // week 40 -> 8 contacts expected; 0 attended is maximally behind.
    const result = assessTriage(baseInput({ pregnancyWeek: 40, ancVisits: 0, riskLevel: 'low' }), NOW);
    expect(result.band).toBe('watch');
    expect(result.reasons.some((r) => /behind on antenatal visits/i.test(r))).toBe(true);
  });

  it('ANC-behind alone scores lower than riskLevel moderate alone — respects the priority order (tier 4 lightest)', () => {
    const ancBehind = assessTriage(baseInput({ pregnancyWeek: 40, ancVisits: 0 }), NOW);
    const moderateRisk = assessTriage(baseInput({ riskLevel: 'moderate' }), NOW);
    expect(ancBehind.score).toBeLessThan(moderateRisk.score);
  });

  it('a null pregnancyWeek is simply skipped, not treated as "behind"', () => {
    const noWeek = assessTriage(baseInput({ pregnancyWeek: null }), NOW);
    expect(noWeek.reasons.some((r) => /antenatal/i.test(r))).toBe(false);
  });

  it('a null ancVisits with a known pregnancyWeek is treated as 0 attended, not skipped', () => {
    const result = assessTriage(baseInput({ pregnancyWeek: 20, ancVisits: null }), NOW);
    expect(result.reasons.some((r) => /behind on antenatal visits \(0 of 2 expected/i.test(r))).toBe(true);
  });
});

describe('assessTriage — now is honoured, no hidden clock', () => {
  it('the same input produces a different quiet-day reading depending on the `now` passed in', () => {
    const lastCheckIn = new Date('2026-06-01T00:00:00.000Z').toISOString();
    const soonAfter = assessTriage(
      baseInput({ lastCheckInAt: lastCheckIn }),
      new Date('2026-06-02T00:00:00.000Z')
    );
    const longAfter = assessTriage(
      baseInput({ lastCheckInAt: lastCheckIn }),
      new Date('2026-06-20T00:00:00.000Z')
    );
    expect(soonAfter.band).toBe('ok');
    expect(longAfter.band).toBe('watch');
  });

  it('is a pure function of its inputs — identical calls produce identical results', () => {
    const a = assessTriage(baseInput({ redFlags7d: 2, riskLevel: 'moderate' }), NOW);
    const b = assessTriage(baseInput({ redFlags7d: 2, riskLevel: 'moderate' }), NOW);
    expect(a).toEqual(b);
  });
});

describe('expectedAncContacts', () => {
  it('matches the documented Kenya MoH 8-contact threshold schedule', () => {
    expect(expectedAncContacts(0)).toBe(0);
    expect(expectedAncContacts(11)).toBe(0);
    expect(expectedAncContacts(12)).toBe(1);
    expect(expectedAncContacts(19)).toBe(1);
    expect(expectedAncContacts(20)).toBe(2);
    expect(expectedAncContacts(40)).toBe(8);
    expect(expectedAncContacts(41)).toBe(8); // capped, never exceeds 8
  });
});

describe('daysSince', () => {
  it('counts whole days between an ISO timestamp and now', () => {
    const threeDaysAgo = new Date(NOW.getTime() - 3 * 24 * 3600 * 1000).toISOString();
    expect(daysSince(threeDaysAgo, NOW)).toBe(3);
  });

  it('clamps a future timestamp to 0 rather than a negative number', () => {
    const future = new Date(NOW.getTime() + 1000).toISOString();
    expect(daysSince(future, NOW)).toBe(0);
  });
});
