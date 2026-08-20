// Week 0 is a VALID pregnancy week, not "unset".
//
// Found in production onboarding: a user answered the "how many weeks
// pregnant are you? (or tell me the date of your last period)" prompt with
// "14th August", "14 August", and "14/08/2026" — and was told "I didn't
// catch that" all three times, with re-prompt copy suggesting her FORMAT was
// wrong. It wasn't. parseWeekOrLMP understood every one of them and
// correctly dated an LMP six days earlier to week 0; the caller's truthiness
// check (`parsed.weeks && ...`) then dropped the falsy 0 before the range
// check ever ran. She gave up and typed "1", putting a wrong week in her
// record.
//
// The users this turned away are those earliest in pregnancy — precisely the
// cohort where early enrolment matters most. These tests pin both halves of
// the fix: that 0 is accepted, and that a stored 0 doesn't read back as
// "unset" anywhere (which would loop onboarding forever).

import { describe, it, expect } from 'vitest';
import { parseWeekOrLMP, weeksFromLMP } from '../packages/core/src/onboarding';

// userManager reads DB_PATH at module load (via ./database), so pin it to an
// in-memory DB before importing. Nothing here actually touches the database —
// getUserContext and assessRiskLevel are pure over the row they're handed.
process.env.DB_PATH = ':memory:';
import userManager from '../apps/server/src/userManager';

// A date N days before today, as the "DD Month" form a user would type.
function daysAgoAsText(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const month = d.toLocaleString('en-US', { month: 'long' });
  return `${d.getDate()} ${month}`;
}

function daysAgoIso(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

describe('parseWeekOrLMP accepts week 0', () => {
  it('an LMP within the last 6 days dates to week 0, not a parse failure', () => {
    const parsed = parseWeekOrLMP(daysAgoAsText(6));
    expect(parsed).not.toBeNull();
    expect(parsed!.weeks).toBe(0);
    expect(parsed!.lmp).toBe(daysAgoIso(6));
  });

  it('accepts the same date written numerically', () => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    const numeric = `${d.getDate()}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    const parsed = parseWeekOrLMP(numeric);
    expect(parsed).not.toBeNull();
    expect(parsed!.weeks).toBe(0);
  });

  it('accepts an ordinal date ("14th August" style)', () => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    const ordinal = `${d.getDate()}th ${d.toLocaleString('en-US', { month: 'long' })}`;
    // Only meaningful when the day doesn't take st/nd/rd, but the regex
    // accepts any of those suffixes regardless of correctness.
    const parsed = parseWeekOrLMP(ordinal);
    expect(parsed).not.toBeNull();
    expect(parsed!.weeks).toBe(0);
  });

  it('accepts a bare "0" as week 0', () => {
    expect(parseWeekOrLMP('0')).toEqual({ weeks: 0 });
  });

  it('still parses ordinary weeks and still rejects nonsense', () => {
    expect(parseWeekOrLMP('22')).toEqual({ weeks: 22 });
    expect(parseWeekOrLMP('22 weeks')).toEqual({ weeks: 22 });
    expect(parseWeekOrLMP('43')).toBeNull();
    expect(parseWeekOrLMP('hello there')).toBeNull();
  });

  it('weeksFromLMP floors to 0 for a very recent LMP', () => {
    expect(weeksFromLMP(daysAgoIso(0))).toBe(0);
    expect(weeksFromLMP(daysAgoIso(6))).toBe(0);
    expect(weeksFromLMP(daysAgoIso(7))).toBe(1);
  });
});

describe('a stored week 0 does not read back as "unset"', () => {
  // The second landmine: onboarding gates on the week being absent, and
  // several call sites used truthiness. With those unfixed, storing a
  // legitimate 0 makes the bot ask for the week forever and never reach the
  // location step, and hasProfile never flips true.
  const baseUser = {
    phone_number: 'whatsapp:+254700000662',
    name: 'Joy',
    age: 24,
    pregnancy_week: 0,
    location: 'Nairobi',
    edd: null,
    isNewUser: false,
  };

  it('getUserContext treats week 0 as answered', () => {
    const ctx = userManager.getUserContext({ ...baseUser } as never);
    expect(ctx.hasProfile).toBe(true);
    expect(ctx.needsOnboarding).toBe(false);
  });

  it('still reports onboarding needed when the week is genuinely absent', () => {
    const ctx = userManager.getUserContext({ ...baseUser, pregnancy_week: null } as never);
    expect(ctx.hasProfile).toBe(false);
    expect(ctx.needsOnboarding).toBe(true);
  });

  it('week 0 counts as a first-trimester risk factor', () => {
    // Paired with an out-of-range age so the two factors together reach
    // 'moderate' — proving week 0 was actually counted, since age alone
    // would only be one factor.
    const risk = userManager.assessRiskLevel({ age: 17, pregnancy_week: 0 });
    expect(risk).toBe('moderate');
  });
});
