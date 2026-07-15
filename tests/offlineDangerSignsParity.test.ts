// P2-D design item 5 (clinically load-bearing): apps/web/src/lib/
// localDangerSigns.ts duplicates the CRITICAL/HIGH tiers of
// packages/core/src/dangerSigns.ts so the PWA can show the escalation
// card immediately for an offline-queued entry, before it ever reaches
// the server-side detector. Verbatim duplication drifts silently unless
// something pins it — this test imports BOTH copies and asserts the
// pattern lists are identical, so a change to a CRITICAL/HIGH regex in
// core fails this test until the same change is copied into
// localDangerSigns.ts.
import { describe, it, expect } from 'vitest';
import { DANGER_SIGNS } from '@amaaii/core';
import { LOCAL_DANGER_SIGNS, detectLocalDangerSigns } from '../apps/web/src/lib/localDangerSigns';

describe('offline local danger-sign regex parity (P2-D)', () => {
  it('duplicates exactly the CRITICAL and HIGH tiers — no MODERATE, no missing tier', () => {
    expect(Object.keys(LOCAL_DANGER_SIGNS).sort()).toEqual(['CRITICAL', 'HIGH']);
  });

  (['CRITICAL', 'HIGH'] as const).forEach((level) => {
    it(`${level} tier: pattern list matches packages/core/src/dangerSigns.ts exactly, in order`, () => {
      const core = DANGER_SIGNS[level].signs;
      const local = LOCAL_DANGER_SIGNS[level];

      expect(local.length).toBe(core.length);
      core.forEach((coreSign, i) => {
        expect(local[i].sign).toBe(coreSign.sign);
        expect(local[i].pattern.source).toBe(coreSign.pattern.source);
        expect(local[i].pattern.flags).toBe(coreSign.pattern.flags);
      });
    });
  });

  it('flags "heavy bleeding" as critical, matching the core detector\'s tier', () => {
    const text = 'I have heavy bleeding';
    expect(detectLocalDangerSigns(text).urgencyLevel).toBe('critical');
  });

  it('flags a terrible/worst headache as high, matching the core detector\'s tier', () => {
    expect(detectLocalDangerSigns('I have a terrible headache').urgencyLevel).toBe('high');
  });

  it('CRITICAL still wins over a co-occurring HIGH-tier phrase, same as core', () => {
    // "bleeding" alone is HIGH; "heavy bleeding" is CRITICAL — both
    // patterns can match the same string, and CRITICAL must win, exactly
    // like core's detectDangerSigns loop (CRITICAL breaks the tier walk).
    const result = detectLocalDangerSigns('heavy bleeding and a fever');
    expect(result.urgencyLevel).toBe('critical');
  });

  it('returns low (no escalation) for ordinary check-in text', () => {
    expect(detectLocalDangerSigns('feeling okay, slept fine, good appetite').urgencyLevel).toBe('low');
    expect(detectLocalDangerSigns('feeling okay, slept fine, good appetite').detectedSigns).toEqual([]);
  });
});
