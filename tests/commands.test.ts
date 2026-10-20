// Whole-message chat commands + journal-session helpers
// (packages/core/src/commands.ts) and once-per-episode escalation
// (packages/core/src/dangerSigns.ts#escalationVariant). The substring
// matchers these replace started a journal on "I'll recheck in an hour"
// and on "what is journal?" in the 2026-10 mother simulation.
import { describe, it, expect } from 'vitest';
import {
  parseCommand,
  isJournalSessionStale,
  looksLikeOffTopic,
  parseSqliteUtc,
  escalationVariant,
  dangerRepeatCopy,
  t,
} from '@amaaii/core';

describe('parseCommand', () => {
  const cases: [string, string | null][] = [
    ['journal', 'journal'],
    ['Journal 📝', 'journal'],
    ['start journal', 'journal'],
    ['anza jarida', 'journal'],
    ['Let us do my check in please', 'journal'],
    ['nataka kufanya jarida', 'journal'],
    ['journal summary', 'summary'],
    ['weekly summary', 'weekly_summary'],
    ['my progress', 'weekly_summary'],
    ['doctor report', 'doctor_report'],
    ['STOP', 'cancel'],
    ['acha', 'cancel'],
    ['please stop asking me these questions', 'cancel'],
    ['help', 'help'],
    // Not commands:
    ["I'll recheck in an hour", null],
    ['what is journal?', null],
    ['journalist', null],
    ['I need help, I am bleeding', null],
    ['My sister keeps a journal of her pregnancy and I wanted to ask you about it today', null],
  ];
  for (const [msg, expected] of cases) {
    it(`${JSON.stringify(msg)} -> ${expected}`, () => {
      expect(parseCommand(msg)).toBe(expected);
    });
  }
});

describe('journal session helpers', () => {
  it('parses SQLite datetime("now") output as UTC', () => {
    expect(parseSqliteUtc('2026-10-20 08:00:00')).toBe(Date.parse('2026-10-20T08:00:00Z'));
    expect(parseSqliteUtc(null)).toBeNull();
  });

  it('a session untouched for more than 6 hours is stale', () => {
    const now = new Date('2026-10-20T15:00:01Z');
    expect(isJournalSessionStale('2026-10-20 09:00:00', now)).toBe(true);
    expect(isJournalSessionStale('2026-10-20 14:00:00', now)).toBe(false);
    expect(isJournalSessionStale(null, now)).toBe(false);
  });

  it('questions and long free text read as off-topic; short answers do not', () => {
    expect(looksLikeOffTopic('how do I get the app?')).toBe(true);
    expect(looksLikeOffTopic('my nipples are cracked and it really hurts')).toBe(true);
    expect(looksLikeOffTopic('7')).toBe(false);
    expect(looksLikeOffTopic('not great')).toBe(false);
  });
});

describe('escalationVariant (once per episode)', () => {
  const now = new Date('2026-10-20T12:00:00Z');

  it('first escalation gets the full copy', () => {
    expect(escalationVariant('high', [], now)).toBe('full');
  });

  it('a repeat at the same level within 6 hours gets the short copy', () => {
    const recent = [{ urgency_level: 'high', timestamp: '2026-10-20 10:00:00' }];
    expect(escalationVariant('high', recent, now)).toBe('repeat');
  });

  it('a HIGHER level than the earlier one still gets the full copy', () => {
    const recent = [{ urgency_level: 'high', timestamp: '2026-10-20 10:00:00' }];
    expect(escalationVariant('critical', recent, now)).toBe('full');
  });

  it('an escalation older than the window starts a new episode', () => {
    const recent = [{ urgency_level: 'critical', timestamp: '2026-10-20 01:00:00' }];
    expect(escalationVariant('critical', recent, now)).toBe('full');
  });

  it('repeat copy is shorter but still points to care, in both languages', () => {
    for (const lang of ['en', 'sw']) {
      const short = dangerRepeatCopy('critical', lang);
      expect(short.length).toBeLessThan(t(lang, 'danger_critical').length);
      expect(short).toMatch(/999/);
    }
  });
});
