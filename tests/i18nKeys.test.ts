// Every English string needs a Kiswahili twin — t() silently falls back
// to English, which is how Kiswahili-only mothers ended up with English
// copy in the 2026-10 simulation.
import { describe, it, expect } from 'vitest';
import { STRINGS } from '../packages/core/src/i18n';

describe('i18n coverage', () => {
  it('every EN key has a SW translation', () => {
    const missing = Object.keys(STRINGS.en).filter((k) => !(k in STRINGS.sw));
    expect(missing).toEqual([]);
  });

  it('placeholders match between EN and SW', () => {
    const vars = (s: string) => (s.match(/\{\w+\}/g) || []).sort().join(',');
    const mismatched = Object.keys(STRINGS.en).filter((k) => k in STRINGS.sw && vars(STRINGS.en[k]) !== vars(STRINGS.sw[k]));
    expect(mismatched).toEqual([]);
  });
});
