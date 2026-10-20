// classifyConsentReply (packages/core/src/consent.ts) — the 2026-10
// simulation found consent being granted on "before I agree, where can I
// read it?" and "WHAT IS AGREE I DONT UNDERSTAND" by the old bare
// /\b(agree|yes|...)\b/ check. Consent must be an unambiguous yes.
import { describe, it, expect } from 'vitest';
import { classifyConsentReply } from '@amaaii/core';

describe('classifyConsentReply', () => {
  const grant = [
    'I AGREE', 'agree', '*I AGREE*', 'I agree.', 'Yes, I agree 👍', 'ok I agree', 'NAKUBALI', 'Sawa nakubali', 'Ndiyo', 'yes',
    // Real replies from the simulation that must grant: the yes comes with
    // a question or a complaint in the same message.
    'I AGREE. But who will see my messages?',
    'ok i agree 😅 but who will see my messages? i dont want my mum to know yet',
    'Sawa, I agree. Ila hii ni ya siri sio?',
    'Please I AGREE, just tell me what to do',
    'Still the same message. Let me try exactly how it is written: *I AGREE*',
    'Naona unaandika AGREE tu. Sawa nimeandika hapa: AGREE.',
    'I already said I AGREE above, please check.',
  ];
  const decline = ['STOP', 'SITAKI', "I don't agree", 'I do not agree', 'sikubali'];
  const question = [
    'before I agree, where can I read the privacy notice?',
    'WHAT IS AGREE I DONT UNDERSTAND',
    'Hii AGREE ni nini',
    'why do you need that?',
    'yes please explain',
    'Ok but what is Amaaii exactly? I will agree after I understand',
    'Okay I have read it. Before I say I agree, please who owns Amaaii?',
  ];
  const unclear = ['no thanks', 'still not sure', 'ok', 'hello'];
  // Fail closed: a refusal, a negation anywhere in the sentence, or a "?" on
  // the agree clause never grants.
  const neverGrant = [
    "I won't agree", 'I refuse to agree', 'I agree?', 'Agree? No.', 'I cannot agree to this',
    "I agree but I won't let you share it", 'Siwezi kukubali', "I didn't agree", 'Do you think I should agree?',
    'I agree if you keep it private', "I'd agree", "I agree. Actually I don't agree.", 'I agree. I changed my mind.',
  ];

  for (const m of grant) it(`grant: ${m}`, () => expect(classifyConsentReply(m)).toBe('grant'));
  for (const m of decline) it(`decline: ${m}`, () => expect(classifyConsentReply(m)).toBe('decline'));
  for (const m of question) it(`question: ${m}`, () => expect(classifyConsentReply(m)).toBe('question'));
  for (const m of unclear) it(`unclear: ${m}`, () => expect(classifyConsentReply(m)).toBe('unclear'));
  for (const m of neverGrant) it(`never grants: ${m}`, () => expect(classifyConsentReply(m)).not.toBe('grant'));
});
