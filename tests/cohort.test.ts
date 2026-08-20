// Pure decision logic for packages/core/src/cohort.ts (P6 provider
// triage queue — GET /provider/cohort). No I/O, no server, no database —
// same "unit behaviour" style as tests/triage.test.ts / tests/jobs.test.ts
// for other pure core modules.

import { describe, it, expect } from 'vitest';
import { MIN_COHORT_N, computeCohortAggregate, type CohortMotherInput } from '@amaaii/core';

const NOW = new Date('2026-06-15T12:00:00.000Z');

function mother(overrides: Partial<CohortMotherInput> = {}): CohortMotherInput {
  return {
    pregnancyWeek: 20,
    ancVisits: 2,
    avgMood: 7,
    avgSleepHours: 7,
    lastCheckInAt: NOW.toISOString(),
    hadRedFlag: false,
    ...overrides,
  };
}

describe('MIN_COHORT_N', () => {
  it('is 5, per the P6 spec', () => {
    expect(MIN_COHORT_N).toBe(5);
  });
});

describe('computeCohortAggregate — small-cell suppression', () => {
  it('suppresses (no statistics at all) below MIN_COHORT_N', () => {
    const mothers = [mother(), mother(), mother(), mother()]; // 4 < 5
    const result = computeCohortAggregate(mothers, NOW);
    expect(result).toEqual({ suppressed: true, minimumN: MIN_COHORT_N, cohortSize: 4 });
  });

  it('suppresses an empty cohort too, not just a small nonzero one', () => {
    const result = computeCohortAggregate([], NOW);
    expect(result).toEqual({ suppressed: true, minimumN: MIN_COHORT_N, cohortSize: 0 });
  });

  it('a suppressed result never carries any statistic field', () => {
    const result = computeCohortAggregate([mother(), mother()], NOW);
    expect(result.suppressed).toBe(true);
    expect(Object.keys(result).sort()).toEqual(['cohortSize', 'minimumN', 'suppressed'].sort());
  });

  it('computes real statistics at exactly MIN_COHORT_N', () => {
    const mothers = Array.from({ length: MIN_COHORT_N }, () => mother());
    const result = computeCohortAggregate(mothers, NOW);
    expect(result.suppressed).toBe(false);
    if (!result.suppressed) {
      expect(result.cohortSize).toBe(MIN_COHORT_N);
    }
  });
});

describe('computeCohortAggregate — never carries per-mother data', () => {
  it('the unsuppressed result shape has no field that could hold a phone, name, or per-row array', () => {
    const mothers = Array.from({ length: 6 }, () => mother());
    const result = computeCohortAggregate(mothers, NOW);
    expect(result.suppressed).toBe(false);
    // Every value in the result is a number, a boolean, or a small fixed
    // {first,second,third} bucket object — never an array, never a string
    // that could be a phone/name.
    for (const [key, value] of Object.entries(result)) {
      if (key === 'gestationalBuckets') {
        expect(Object.keys(value as object).sort()).toEqual(['first', 'second', 'third']);
        continue;
      }
      expect(Array.isArray(value)).toBe(false);
      expect(typeof value === 'number' || typeof value === 'boolean' || value === null).toBe(true);
    }
  });
});

describe('computeCohortAggregate — statistics', () => {
  it('ancAdherencePct: % of mothers (with a known week) meeting expectedAncContacts', () => {
    // week 20 -> 2 contacts expected.
    const mothers = [
      mother({ pregnancyWeek: 20, ancVisits: 2 }), // adherent
      mother({ pregnancyWeek: 20, ancVisits: 2 }), // adherent
      mother({ pregnancyWeek: 20, ancVisits: 0 }), // not adherent
      mother({ pregnancyWeek: 20, ancVisits: 5 }), // adherent (ahead counts too)
      mother({ pregnancyWeek: null }), // unknown week -> excluded from both num/denom
    ];
    const result = computeCohortAggregate(mothers, NOW);
    expect(result.suppressed).toBe(false);
    if (!result.suppressed) {
      // 3 of 4 known-week mothers adherent -> 75%.
      expect(result.ancAdherencePct).toBe(75);
    }
  });

  it('avgMood / avgSleepHours: mean across mothers who have a value, ignoring nulls; null when nobody has one', () => {
    const mothers = [
      mother({ avgMood: 6, avgSleepHours: 6 }),
      mother({ avgMood: 8, avgSleepHours: 8 }),
      mother({ avgMood: null, avgSleepHours: null }),
      mother({ avgMood: 7, avgSleepHours: 7 }),
      mother({ avgMood: 7, avgSleepHours: 7 }),
    ];
    const result = computeCohortAggregate(mothers, NOW);
    expect(result.suppressed).toBe(false);
    if (!result.suppressed) {
      expect(result.avgMood).toBe(7); // (6+8+7+7)/4 = 7
      expect(result.avgSleepHours).toBe(7);
    }

    const noData = Array.from({ length: 5 }, () => mother({ avgMood: null, avgSleepHours: null }));
    const noDataResult = computeCohortAggregate(noData, NOW);
    expect(noDataResult.suppressed).toBe(false);
    if (!noDataResult.suppressed) {
      expect(noDataResult.avgMood).toBeNull();
      expect(noDataResult.avgSleepHours).toBeNull();
    }
  });

  it('checkInRatePct: % of the WHOLE cohort checked in within 7 days (denominator is cohortSize, not just those with a check-in)', () => {
    const mothers = [
      mother({ lastCheckInAt: NOW.toISOString() }), // today
      mother({ lastCheckInAt: new Date(NOW.getTime() - 6 * 24 * 3600 * 1000).toISOString() }), // 6d ago
      mother({ lastCheckInAt: new Date(NOW.getTime() - 8 * 24 * 3600 * 1000).toISOString() }), // 8d ago -> not within 7
      mother({ lastCheckInAt: null }), // never -> not within 7
      mother({ lastCheckInAt: null }),
    ];
    const result = computeCohortAggregate(mothers, NOW);
    expect(result.suppressed).toBe(false);
    if (!result.suppressed) {
      expect(result.checkInRatePct).toBe(40); // 2 of 5
    }
  });

  it('redFlagMothers: a raw count of mothers with hadRedFlag=true, not a percentage', () => {
    const mothers = [
      mother({ hadRedFlag: true }),
      mother({ hadRedFlag: true }),
      mother({ hadRedFlag: false }),
      mother({ hadRedFlag: false }),
      mother({ hadRedFlag: false }),
    ];
    const result = computeCohortAggregate(mothers, NOW);
    expect(result.suppressed).toBe(false);
    if (!result.suppressed) {
      expect(result.redFlagMothers).toBe(2);
    }
  });

  it('gestationalBuckets: counts by trimester, excluding unknown weeks', () => {
    const mothers = [
      mother({ pregnancyWeek: 10 }), // first
      mother({ pregnancyWeek: 12 }), // first (still < 13)
      mother({ pregnancyWeek: 20 }), // second
      mother({ pregnancyWeek: 30 }), // third
      mother({ pregnancyWeek: null }), // unknown -> excluded
    ];
    const result = computeCohortAggregate(mothers, NOW);
    expect(result.suppressed).toBe(false);
    if (!result.suppressed) {
      expect(result.gestationalBuckets).toEqual({ first: 2, second: 1, third: 1 });
    }
  });
});

describe('computeCohortAggregate — now is honoured, no hidden clock', () => {
  it('checkInRatePct changes depending on the `now` passed in for the same mothers', () => {
    const lastCheckIn = new Date('2026-06-01T00:00:00.000Z').toISOString();
    const mothers = Array.from({ length: 5 }, () => mother({ lastCheckInAt: lastCheckIn }));

    const soonAfter = computeCohortAggregate(mothers, new Date('2026-06-02T00:00:00.000Z'));
    const longAfter = computeCohortAggregate(mothers, new Date('2026-06-20T00:00:00.000Z'));
    expect(soonAfter.suppressed).toBe(false);
    expect(longAfter.suppressed).toBe(false);
    if (!soonAfter.suppressed && !longAfter.suppressed) {
      expect(soonAfter.checkInRatePct).toBe(100);
      expect(longAfter.checkInRatePct).toBe(0);
    }
  });
});
