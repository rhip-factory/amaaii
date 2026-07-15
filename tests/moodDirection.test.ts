// P2-E: honest trend-direction wording for the Home trends card + the
// Insights "Mood" stat tile (apps/web/src/lib/insights.ts). Same
// import-the-web-lib-directly pattern as tests/offlineCache.test.ts.
// The wording contract matters clinically: never claim "improving" on
// noise, never hide a decline.
import { describe, it, expect } from 'vitest';
import {
  computeMoodDirection,
  sliceLastDays,
  moodDirectionHeadline,
  moodDirectionWord,
} from '../apps/web/src/lib/insights';

function series(values: number[], startDaysAgo = values.length - 1): { date: string; value: number }[] {
  return values.map((value, i) => ({
    date: new Date(Date.now() - (startDaysAgo - i) * 24 * 3600 * 1000).toISOString().slice(0, 10),
    value,
  }));
}

describe('computeMoodDirection (P2-E)', () => {
  it('returns null below 2 points — no claim without data', () => {
    expect(computeMoodDirection([])).toBeNull();
    expect(computeMoodDirection(series([7]))).toBeNull();
  });

  it('detects a clear improvement (recent half >= 0.5 above earlier half)', () => {
    expect(computeMoodDirection(series([3, 4, 7, 8]))).toBe('improving');
  });

  it('detects a clear decline — no fake positivity', () => {
    expect(computeMoodDirection(series([8, 7, 4, 3]))).toBe('declining');
    expect(moodDirectionHeadline('declining')).toBe('Mood has dipped this week');
  });

  it('reports noise within the 0.5 threshold as steady', () => {
    expect(computeMoodDirection(series([6, 7, 6, 7]))).toBe('steady');
    expect(computeMoodDirection(series([7, 7, 7]))).toBe('steady');
  });

  it('gives the middle point of an odd-length series to the recent half', () => {
    // halves: [3] vs [3, 9] -> delta +3 -> improving.
    expect(computeMoodDirection(series([3, 3, 9]))).toBe('improving');
  });

  it('moodDirectionWord maps null to an em dash (stat tile never invents a direction)', () => {
    expect(moodDirectionWord(null)).toBe('—');
    expect(moodDirectionWord('improving')).toBe('Improving');
  });
});

describe('sliceLastDays (P2-E)', () => {
  it('keeps only points within the last N days (inclusive of today)', () => {
    const pts = series([2, 3, 4, 5, 6, 7, 8, 9], 9); // 9..2 days ago
    const last7 = sliceLastDays(pts, 7);
    // Cutoff is 6 days ago: drops the 9-, 8- and 7-day-old points.
    expect(last7).toHaveLength(5);
    expect(last7[0]?.value).toBe(5);
    expect(last7[last7.length - 1]?.value).toBe(9);
  });

  it('returns everything when the window covers the whole series', () => {
    const pts = series([4, 5, 6]);
    expect(sliceLastDays(pts, 30)).toEqual(pts);
  });
});
