// classifyConsentReply (packages/core/src/consent.ts) — the 2026-10
// simulation found consent being granted on "before I agree, where can I
// read it?" and "WHAT IS AGREE I DONT UNDERSTAND" by the old bare
// /\b(agree|yes|...)\b/ check. Consent must be an unambiguous yes.
import { describe, it, expect } from 'vitest';
import { classifyConsentReply } from '@amaaii/core';

describe('classifyConsentReply', () => {
  const grant = ['I AGREE', 'agree', '*I AGREE*', 'I agree.', 'Yes, I agree 👍', 'ok I agree', 'NAKUBALI', 'Sawa nakubali', 'Ndiyo', 'yes'];
  const decline = ['STOP', 'SITAKI', "I don't agree", 'I do not agree', 'sikubali'];
  const question = [
    'before I agree, where can I read the privacy notice?',
    'WHAT IS AGREE I DONT UNDERSTAND',
    'Hii AGREE ni nini',
    'why do you need that?',
    'yes please explain',
  ];
  const unclear = ['no thanks', 'still not sure', 'ok', 'hello'];

  for (const m of grant) it(`grant: ${m}`, () => expect(classifyConsentReply(m)).toBe('grant'));
  for (const m of decline) it(`decline: ${m}`, () => expect(classifyConsentReply(m)).toBe('decline'));
  for (const m of question) it(`question: ${m}`, () => expect(classifyConsentReply(m)).toBe('question'));
  for (const m of unclear) it(`unclear: ${m}`, () => expect(classifyConsentReply(m)).toBe('unclear'));
});
