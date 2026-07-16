import { describe, it, expect } from 'vitest';
import golden from './fixtures/redaction-golden.json' with { type: 'json' };
import {
  redactText,
  redactKnownName,
  redactForLLM,
  WHATSAPP_PHONE_PATTERN,
  INTL_PHONE_PATTERN,
  LOCAL_PHONE_PATTERN,
  LOCAL_PHONE_NO_LEADING_ZERO_PATTERN,
  EMAIL_PATTERN,
  URL_WITH_USERINFO_PATTERN,
  LONG_DIGIT_RUN_PATTERN,
} from '@amaaii/core';

type GoldenCase = {
  fn: 'redactText' | 'redactKnownName' | 'redactForLLM';
  note: string;
  input: string;
  name?: string | null;
  expected: string;
};

function run(entry: GoldenCase): string {
  switch (entry.fn) {
    case 'redactText':
      return redactText(entry.input);
    case 'redactKnownName':
      return redactKnownName(entry.input, entry.name);
    case 'redactForLLM':
      return redactForLLM(entry.input, entry.name ? { name: entry.name } : undefined);
    default:
      throw new Error(`Unknown fn in golden fixture: ${(entry as GoldenCase).fn}`);
  }
}

describe('redaction golden fixtures', () => {
  for (const entry of golden as GoldenCase[]) {
    it(`[${entry.fn}] ${entry.note}`, () => {
      expect(run(entry), entry.input).toBe(entry.expected);
    });
  }
});

describe('redactText — unit behaviour', () => {
  it('is a no-op on empty string', () => {
    expect(redactText('')).toBe('');
  });

  it('leaves non-PII text completely untouched', () => {
    const msg = 'Walking 20 minutes after dinner can help.';
    expect(redactText(msg)).toBe(msg);
  });

  it('exported patterns are the ones actually used internally (regression guard for logger reuse)', () => {
    expect('whatsapp:+254700000011'.replace(WHATSAPP_PHONE_PATTERN, '[PHONE]')).toBe('[PHONE]');
    expect('+254700000011'.replace(INTL_PHONE_PATTERN, '[PHONE]')).toBe('[PHONE]');
    expect('0700000011'.replace(LOCAL_PHONE_PATTERN, '[PHONE]')).toBe('[PHONE]');
    expect('700000011'.replace(LOCAL_PHONE_NO_LEADING_ZERO_PATTERN, '[PHONE]')).toBe('[PHONE]');
    expect('grace@example.com'.replace(EMAIL_PATTERN, '[EMAIL]')).toBe('[EMAIL]');
    expect('http://a:b@example.com'.replace(URL_WITH_USERINFO_PATTERN, '[URL]')).toBe('[URL]');
    expect('25470000001199'.replace(LONG_DIGIT_RUN_PATTERN, '[NUMBER]')).toBe('[NUMBER]');
  });

  it('respects skip options', () => {
    // skipPhone alone still lets the generic long-digit-run fallback
    // catch the digits (a separate, independently-toggleable category) —
    // disable both to prove the number survives untouched.
    expect(redactText('+254700000011', { skipPhone: true, skipLongDigits: true })).toBe(
      '+254700000011'
    );
    expect(redactText('grace@example.com', { skipEmail: true })).toBe('grace@example.com');
    // skipUrl alone still lets the email pattern catch the "user@host"
    // tail (a separate category) — disable both to prove it survives.
    expect(
      redactText('http://a:b@example.com', { skipUrl: true, skipEmail: true })
    ).toBe('http://a:b@example.com');
    expect(redactText('25470000001199', { skipLongDigits: true })).toBe('25470000001199');
  });

  it('does not mask short standalone numbers regardless of digit count option interplay', () => {
    // 1-2 digit numbers (weeks, ages, mood scores) never match any
    // pattern, with or without opts — this is the ID-NUMBER DECISION
    // documented in redaction.ts, exercised directly rather than only
    // via the golden fixture.
    expect(redactText('week 22, age 34, mood 4')).toBe('week 22, age 34, mood 4');
  });
});

describe('redactKnownName — unit behaviour', () => {
  it('returns text unchanged when name is undefined/null/empty', () => {
    expect(redactKnownName('Grace is here', undefined)).toBe('Grace is here');
    expect(redactKnownName('Grace is here', null)).toBe('Grace is here');
    expect(redactKnownName('Grace is here', '')).toBe('Grace is here');
  });

  it('is case-insensitive and word-boundary anchored (does not mangle substrings)', () => {
    // "Gracelyn" contains "Grace" as a substring but is a different word —
    // word-boundary anchoring must not mask it.
    expect(redactKnownName('Gracelyn called', 'Grace')).toBe('Gracelyn called');
  });
});

describe('redactForLLM — unit behaviour', () => {
  it('never throws on non-string input and passes it through', () => {
    // @ts-expect-error deliberately exercising a non-string input
    expect(redactForLLM(null)).toBe(null);
  });

  it('composes redactText + redactKnownName in one call', () => {
    const out = redactForLLM('Grace, call 0700000011', { name: 'Grace' });
    expect(out).toBe('[NAME], call [PHONE]');
  });
});
