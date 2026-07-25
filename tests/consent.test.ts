// Pure decision logic for packages/core/src/consent.ts (P3-A). No I/O,
// no server, no database — every case here constructs a ConsentState (or
// raw ConsentLedgerEvent[]) by hand and asserts on the pure functions.
// Follows tests/redaction.test.ts's "unit behaviour" style for a pure
// core module.

import { describe, it, expect } from 'vitest';
import {
  CONSENT_VERSION,
  REQUIRED_PURPOSES,
  OPTIONAL_PURPOSES,
  hasActiveConsent,
  needsConsent,
  canUseAi,
  missingRequired,
  isStale,
  deriveConsentState,
  type ConsentState,
  type ConsentLedgerEvent,
} from '@amaaii/core';

function state(entries: Partial<ConsentState[number]>[]): ConsentState {
  return entries.map((e) => ({
    purpose: e.purpose ?? 'data_processing',
    granted: e.granted ?? true,
    version: e.version ?? CONSENT_VERSION,
    grantedAt: e.grantedAt ?? '2026-01-01T00:00:00.000Z',
    revokedAt: e.revokedAt ?? null,
  }));
}

describe('consent constants', () => {
  it('CONSENT_VERSION is a pinned integer', () => {
    expect(CONSENT_VERSION).toBe(1);
    expect(Number.isInteger(CONSENT_VERSION)).toBe(true);
  });

  it('two-tier split: data_processing required, ai_responses optional, no overlap', () => {
    expect(REQUIRED_PURPOSES).toEqual(['data_processing']);
    expect(OPTIONAL_PURPOSES).toEqual(['ai_responses']);
    const overlap = REQUIRED_PURPOSES.filter((p) => (OPTIONAL_PURPOSES as string[]).includes(p));
    expect(overlap).toEqual([]);
  });
});

describe('hasActiveConsent', () => {
  it('is false for a purpose with no entry at all (brand-new user)', () => {
    expect(hasActiveConsent([], 'data_processing')).toBe(false);
    expect(hasActiveConsent([], 'ai_responses')).toBe(false);
  });

  it('is true when granted, not revoked, at the current version', () => {
    const s = state([{ purpose: 'data_processing', granted: true }]);
    expect(hasActiveConsent(s, 'data_processing')).toBe(true);
  });

  it('is false when granted=false (explicit decline)', () => {
    const s = state([{ purpose: 'ai_responses', granted: false }]);
    expect(hasActiveConsent(s, 'ai_responses')).toBe(false);
  });

  it('is false when revoked, even though granted=true', () => {
    const s = state([
      { purpose: 'data_processing', granted: true, revokedAt: '2026-02-01T00:00:00.000Z' },
    ]);
    expect(hasActiveConsent(s, 'data_processing')).toBe(false);
  });

  it('is false when granted at an older version than CONSENT_VERSION', () => {
    const s = state([{ purpose: 'data_processing', granted: true, version: CONSENT_VERSION - 1 }]);
    expect(hasActiveConsent(s, 'data_processing')).toBe(false);
  });
});

describe('missingRequired', () => {
  it('lists data_processing for a brand-new user', () => {
    expect(missingRequired([])).toEqual(['data_processing']);
  });

  it('is empty once data_processing is actively granted', () => {
    const s = state([{ purpose: 'data_processing', granted: true }]);
    expect(missingRequired(s)).toEqual([]);
  });

  it('ai_responses being granted does not satisfy the data_processing requirement', () => {
    const s = state([{ purpose: 'ai_responses', granted: true }]);
    expect(missingRequired(s)).toEqual(['data_processing']);
  });
});

describe('needsConsent', () => {
  it('is true for a brand-new user (no ledger entries)', () => {
    expect(needsConsent([])).toBe(true);
  });

  it('is false once the required purpose is actively granted', () => {
    const s = state([{ purpose: 'data_processing', granted: true }]);
    expect(needsConsent(s)).toBe(false);
  });

  it('is true again after the required purpose is revoked', () => {
    const s = state([
      { purpose: 'data_processing', granted: true, revokedAt: '2026-02-01T00:00:00.000Z' },
    ]);
    expect(needsConsent(s)).toBe(true);
  });

  it('is true when the required purpose is stuck at a stale version', () => {
    const s = state([{ purpose: 'data_processing', granted: true, version: CONSENT_VERSION - 1 }]);
    expect(needsConsent(s)).toBe(true);
  });

  it('does not depend on the optional purpose at all', () => {
    const s = state([
      { purpose: 'data_processing', granted: true },
      { purpose: 'ai_responses', granted: false },
    ]);
    expect(needsConsent(s)).toBe(false);
  });
});

describe('canUseAi', () => {
  it('is false when ai_responses has never been touched', () => {
    const s = state([{ purpose: 'data_processing', granted: true }]);
    expect(canUseAi(s)).toBe(false);
  });

  it('is true once ai_responses is actively granted', () => {
    const s = state([
      { purpose: 'data_processing', granted: true },
      { purpose: 'ai_responses', granted: true },
    ]);
    expect(canUseAi(s)).toBe(true);
  });

  it('declining ai_responses never blocks data_processing / required functionality', () => {
    const s = state([
      { purpose: 'data_processing', granted: true },
      { purpose: 'ai_responses', granted: false },
    ]);
    expect(canUseAi(s)).toBe(false);
    expect(needsConsent(s)).toBe(false); // the locked "still works without AI" decision
  });

  it('is false after ai_responses is revoked', () => {
    const s = state([
      { purpose: 'ai_responses', granted: true, revokedAt: '2026-02-01T00:00:00.000Z' },
    ]);
    expect(canUseAi(s)).toBe(false);
  });
});

describe('isStale', () => {
  it('is false for a brand-new user — "never consented" is not "stale"', () => {
    expect(isStale([])).toBe(false);
  });

  it('is false when everything is granted at the current version', () => {
    const s = state([{ purpose: 'data_processing', granted: true }]);
    expect(isStale(s)).toBe(false);
  });

  it('is true when a purpose is actively granted at an older version', () => {
    const s = state([{ purpose: 'data_processing', granted: true, version: CONSENT_VERSION - 1 }]);
    expect(isStale(s)).toBe(true);
  });

  it('is false when the stale-version entry was declined, not granted', () => {
    const s = state([{ purpose: 'ai_responses', granted: false, version: CONSENT_VERSION - 1 }]);
    expect(isStale(s)).toBe(false);
  });

  it('is false when the stale-version entry was later revoked', () => {
    const s = state([
      {
        purpose: 'data_processing',
        granted: true,
        version: CONSENT_VERSION - 1,
        revokedAt: '2026-02-01T00:00:00.000Z',
      },
    ]);
    expect(isStale(s)).toBe(false);
  });
});

describe('deriveConsentState', () => {
  it('returns an empty state for an empty ledger', () => {
    expect(deriveConsentState([])).toEqual([]);
  });

  it('the latest event per purpose wins (later array position overwrites earlier)', () => {
    const events: ConsentLedgerEvent[] = [
      { purpose: 'data_processing', granted: false, version: 1, granted_at: 't0', revoked_at: null },
      { purpose: 'data_processing', granted: true, version: 1, granted_at: 't1', revoked_at: null },
    ];
    const derived = deriveConsentState(events);
    expect(derived).toHaveLength(1);
    expect(derived[0]).toEqual({
      purpose: 'data_processing',
      granted: true,
      version: 1,
      grantedAt: 't1',
      revokedAt: null,
    });
  });

  it('coerces a raw 0/1 integer `granted` column into a real boolean', () => {
    const events: ConsentLedgerEvent[] = [
      { purpose: 'ai_responses', granted: 0, version: 1, granted_at: 't0', revoked_at: null },
    ];
    expect(deriveConsentState(events)[0].granted).toBe(false);

    const events2: ConsentLedgerEvent[] = [
      { purpose: 'ai_responses', granted: 1, version: 1, granted_at: 't0', revoked_at: null },
    ];
    expect(deriveConsentState(events2)[0].granted).toBe(true);
  });

  it('tracks independent purposes independently', () => {
    const events: ConsentLedgerEvent[] = [
      { purpose: 'data_processing', granted: true, version: 1, granted_at: 't0', revoked_at: null },
      { purpose: 'ai_responses', granted: true, version: 1, granted_at: 't1', revoked_at: null },
    ];
    const derived = deriveConsentState(events);
    expect(derived.map((e) => e.purpose).sort()).toEqual(['ai_responses', 'data_processing']);
  });

  it('round-trips into hasActiveConsent/needsConsent/canUseAi correctly', () => {
    const events: ConsentLedgerEvent[] = [
      { purpose: 'data_processing', granted: true, version: CONSENT_VERSION, granted_at: 't0', revoked_at: null },
      { purpose: 'ai_responses', granted: true, version: CONSENT_VERSION, granted_at: 't0', revoked_at: null },
      // Withdrawal event for ai_responses — self-contained row with its
      // own revoked_at, appended after the grant rather than mutating it.
      { purpose: 'ai_responses', granted: false, version: CONSENT_VERSION, granted_at: 't1', revoked_at: 't1' },
    ];
    const derived = deriveConsentState(events);
    expect(needsConsent(derived)).toBe(false);
    expect(canUseAi(derived)).toBe(false);
    expect(hasActiveConsent(derived, 'data_processing')).toBe(true);
  });
});
