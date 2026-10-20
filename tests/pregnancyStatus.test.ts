// Pure P1 helpers: where she is now (pregnancyStatus), the onboarding fast
// paths (age, months, Kiswahili numbers), language detection and
// conversational profile updates. Phrasings come from the 2026-10 mother
// simulation, where "4 months" became week 4, "nina miaka kumi na tisa"
// looped for months and the week never advanced after onboarding.
import { describe, it, expect } from 'vitest';
import {
  pregnancyStatus,
  parseAge,
  parseMonthsAsWeeks,
  parseSwahiliNumber,
  parseWeekOrLMP,
  detectLanguage,
  parseProfileUpdate,
} from '@amaaii/core';

const NOW = new Date('2026-10-20T10:00:00Z');

describe('pregnancyStatus', () => {
  it('derives today\'s week from the due date', () => {
    expect(pregnancyStatus({ edd: '2027-01-12', pregnancy_week: 8 }, NOW)).toMatchObject({ phase: 'pregnant', week: 28 });
  });

  it('switches to postpartum once a delivery date is recorded', () => {
    expect(pregnancyStatus({ delivery_date: '2026-10-06', edd: '2026-10-10' }, NOW)).toEqual({ phase: 'postpartum', days: 14, weeks: 2 });
  });

  it('flags overdue three days past the due date with no birth recorded', () => {
    expect(pregnancyStatus({ edd: '2026-10-15' }, NOW)).toMatchObject({ phase: 'pregnant', overdue: true });
    expect(pregnancyStatus({ edd: '2026-10-19' }, NOW)).toMatchObject({ phase: 'pregnant', overdue: false });
  });

  it('falls back to lmp, then to the stored week', () => {
    expect(pregnancyStatus({ lmp: '2026-06-30' }, NOW)).toMatchObject({ week: 16 });
    expect(pregnancyStatus({ pregnancy_week: 12 }, NOW)).toMatchObject({ week: 12 });
    expect(pregnancyStatus({}, NOW)).toEqual({ phase: 'unknown' });
  });
});

describe('parseAge', () => {
  it.each([
    ['24', 24],
    ['I am 38', 38],
    ['Nina miaka kumi na tisa', 19],
    ['miaka 24', 24],
    ['methyldopa 250mg twice, I am 38', 38],
  ])('%s -> %s', (msg, age) => expect(parseAge(msg)).toBe(age));

  it.each(['11 weeks', '5 months', 'I AGREE', '250mg', '3'])('%s is not an age', (msg) => {
    expect(parseAge(msg)).toBeNull();
  });
});

describe('months and Kiswahili numbers', () => {
  it.each([
    ['4 months', 17],
    ['5 MONTHS', 22],
    ['miezi mitano', 22],
    ['four months', 17],
  ])('%s -> %s weeks', (msg, weeks) => expect(parseMonthsAsWeeks(msg)).toBe(weeks));

  it('"I\'m 5 months" is no longer stored as week 5', () => {
    expect(parseWeekOrLMP("I'm 5 months")).toEqual({ weeks: 22 });
  });

  it('reads Kiswahili week numbers', () => {
    expect(parseWeekOrLMP('wiki ishirini na mbili')).toEqual({ weeks: 22 });
    expect(parseSwahiliNumber('kumi na tisa')).toBe(19);
  });

  it('keeps the existing week and date forms', () => {
    expect(parseWeekOrLMP('20 weeks')).toEqual({ weeks: 20 });
    expect(parseWeekOrLMP('22')).toEqual({ weeks: 22 });
  });
});

describe('detectLanguage', () => {
  it('spots Kiswahili, English, and stays out of mixed or tiny messages', () => {
    expect(detectLanguage('Habari, nimepewa namba hii na nesi kliniki')).toBe('sw');
    expect(detectLanguage('MAMA AMAAII NINA HOMA NA KUTETEMEKA')).toBe('sw');
    expect(detectLanguage('Hello, a nurse at the clinic gave me this number')).toBe('en');
    expect(detectLanguage('Hello Amaaii, niko sawa leo. Hakuna bleeding, hakuna pain wala headache')).toBeNull();
    expect(detectLanguage('hi')).toBeNull();
  });
});

describe('parseProfileUpdate', () => {
  it.each([
    ['my name is Faith Otieno', { kind: 'name', name: 'Faith Otieno' }],
    ['call me Mama Brian', { kind: 'name', name: 'Mama Brian' }],
    ['I am 28 weeks, not 16', { kind: 'week', weeks: 28 }],
    ['niko wiki 30', { kind: 'week', weeks: 30 }],
    ['Im 7 months', { kind: 'week', weeks: 30 }],
    ['Kiswahili tafadhali', { kind: 'language', lang: 'sw', whole: true }],
    ['English please', { kind: 'language', lang: 'en', whole: true }],
    ['Habari, mtoto hasongi. Naomba unijibu kiswahili tu', { kind: 'language', lang: 'sw', whole: false }],
    ['I gave birth yesterday!', { kind: 'birth' }],
    ['Nimejifungua salama, ni msichana', { kind: 'birth' }],
  ])('%s', (msg, expected) => {
    expect(parseProfileUpdate(msg)).toMatchObject(expected);
  });

  it.each([
    'I am 28 weeks and my back hurts',
    'when I gave birth to my first child I bled a lot',
    'what language do you speak',
  ])('%s is not a profile update', (msg) => {
    expect(parseProfileUpdate(msg)).toBeNull();
  });
});
