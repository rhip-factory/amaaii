// A check-in left half-way is paused, never thrown away (2026-10-21): she
// sees what's saved and taps Resume, Restart or Stop. And an unclear answer
// goes to a stronger model (LLM_CLARIFY_MODEL) that settles it or writes the
// "what did you mean?" question, with options the app validates and the
// canned question as the fallback.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs');

process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';
process.env.LLM_TRIAGE_RAISE = '0';

const db = require('../apps/server/src/database');
const { processMessage } = require('../apps/server/src/messageHandler');
const {
  CONSENT_VERSION,
  checkinSoFar,
  checkinStillResumable,
  parseCommand,
  isGoAhead,
} = require('@amaaii/core');
const { __setClient, __resetClient, resolveModel } = require('@amaaii/adapters');

let interp = '{"status":"no_answer","answer":{},"readings":[],"symptom":""}';
let clarify = '{}';
let calls = { interp: 0, clarify: 0 };
let replySystem = '';

beforeAll(async () => {
  await db.initializeDatabase();
});

beforeEach(() => {
  interp = '{"status":"no_answer","answer":{},"readings":[],"symptom":""}';
  clarify = '{}';
  calls = { interp: 0, clarify: 0 };
  replySystem = '';
  const create = async (req: { messages: { role: string; content: string }[] }) => {
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    let content = 'Here is some friendly advice.';
    if (system.includes("in the middle of a mother's daily check-in")) {
      calls.clarify += 1;
      content = clarify;
    } else if (system.includes('daily check-in and record her answer')) {
      calls.interp += 1;
      content = interp;
    } else if (system.includes('STRICT JSON') || system.includes('Return JSON')) {
      content = '{}';
    } else {
      replySystem = system;
    }
    return {
      id: 'x', object: 'chat.completion', created: 0, model: 'stub',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null }, logprobs: null }],
    };
  };
  __setClient({ chat: { completions: { create } } } as never);
});

afterEach(() => {
  __resetClient();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

let n = 0;
async function onboarded(opts: { ai?: boolean; language?: string } = {}): Promise<string> {
  n += 1;
  const phone = `whatsapp:+2547240${String(n).padStart(5, '0')}`;
  await db.createUser(phone, { name: 'Joy' });
  await db.updateUser(phone, { age: 24, pregnancy_week: 9, location: 'Kijabe', language: opts.language ?? 'en' });
  await db.recordConsent(phone, 'data_processing', true, CONSENT_VERSION);
  await db.recordConsent(phone, 'ai_responses', opts.ai ?? true, CONSENT_VERSION);
  return phone;
}
const say = (phone: string, msg: string, channel: 'whatsapp' | 'web' = 'whatsapp') =>
  processMessage(phone, msg, null, { channel });

/** Mood 6, symptoms nausea: the sleep question is next. */
async function atSleep(phone: string, channel: 'whatsapp' | 'web' = 'whatsapp'): Promise<void> {
  await say(phone, 'Start journal', channel);
  await say(phone, '6', channel);
  await say(phone, 'nausea', channel);
}
const paused = async (phone: string) => (await db.getJournalSession(phone))?.journalData.__paused === true;

describe('paused check-in helpers (core)', () => {
  it('shows what is saved so far, in her language', () => {
    const data = { emotional_state: 6, physical_symptoms: '["nausea"]', sleep_quality: 1, sleep_hours: 0.5, water_intake: 5, appetite: 'poor' };
    expect(checkinSoFar(data, 'en')).toBe('Mood 6/10 · Symptoms: nausea · Sleep 1/10, 0.5 hours · Water: 5 glasses · Appetite: poor');
    expect(checkinSoFar(data, 'sw')).toBe('Hali 6/10 · Dalili: nausea · Usingizi 1/10, saa 0.5 · Maji: glasi 5 · Hamu ya kula: mbaya');
    expect(checkinSoFar({}, 'en')).toBe('nothing yet');
  });

  it('stays resumable until midnight in Nairobi', () => {
    const at = (iso: string) => new Date(iso);
    // 23:59 EAT, then 00:01 EAT the next day.
    expect(checkinStillResumable(at('2026-10-21T20:59:00Z').getTime(), at('2026-10-21T21:01:00Z'))).toBe(false);
    // 00:30 EAT and 23:00 EAT the same day.
    expect(checkinStillResumable(at('2026-10-20T21:30:00Z').getTime(), at('2026-10-21T20:00:00Z'))).toBe(true);
    expect(checkinStillResumable(null, new Date())).toBe(true);
  });

  it.each([
    ['Resume check-in', 'resume'], ['continue', 'resume'], ['Endelea na jarida', 'resume'],
    ['Restart check-in', 'restart'], ['start over', 'restart'], ['Anza upya', 'restart'],
    ['Stop check-in', 'cancel'], ['Acha jarida', 'cancel'],
  ])('"%s" is %s', (msg, cmd) => expect(parseCommand(msg)).toBe(cmd));
});

describe('a question mid-check-in pauses it; Resume picks it up', () => {
  it('her scenario: answered, shown what is saved, resumed at the same question', async () => {
    const p = await onboarded();
    await atSleep(p);
    const q = await say(p, 'Is it normal to feel dizzy when I stand up?');
    expect(q.context).not.toBe('journaling');
    expect(q.response).toMatch(/^Here is some friendly advice\./);
    expect(q.response).toMatch(/Your check-in is paused\. So far: Mood 6\/10 · Symptoms: nausea\. Next: sleep\./);
    expect(q.buttons?.options).toEqual(['Resume check-in', 'Restart check-in', 'Stop check-in']);
    expect(replySystem).toMatch(/check-in is paused \(next question: sleep\)/);
    expect(await paused(p)).toBe(true);

    // Any later message keeps it in view, and is not taken as an answer.
    const later = await say(p, '7/10, 6 hours');
    expect(later.context).not.toBe('journaling');
    expect(later.buttons?.options).toEqual(['Resume check-in', 'Restart check-in', 'Stop check-in']);

    const back = await say(p, 'Resume check-in');
    expect(back.context).toBe('journaling');
    expect(back.response).toBe('Welcome back! 📝 So far: Mood 6/10 · Symptoms: nausea.\n\nHow was your sleep last night? Rate quality (1-10) and hours slept (e.g., "7/10, 6 hours")');
    expect(await paused(p)).toBe(false);
    const next = await say(p, '7/10, 6 hours');
    expect(next.response).toMatch(/glasses of water/);
    expect(await db.getTodaysJournal(p)).toMatchObject({ emotional_state: 6, sleep_quality: 7, sleep_hours: 6 });
  });

  it('"ok go ahead" after the paused card resumes', async () => {
    const p = await onboarded();
    await atSleep(p);
    await say(p, 'what fruits are good for me?');
    expect((await say(p, 'ok go ahead')).response).toMatch(/^Welcome back!/);
  });

  it('"Start journal" while one is paused asks resume or start over; Restart clears today\'s answers', async () => {
    const p = await onboarded();
    await atSleep(p);
    await say(p, 'what fruits are good for me?');
    const again = await say(p, 'Start journal');
    expect(again.response).toMatch(/^You have a check-in in progress\. 📝 So far: Mood 6\/10 · Symptoms: nausea\. Next: sleep\./);
    expect(again.buttons?.options).toEqual(['Resume check-in', 'Restart check-in', 'Stop check-in']);

    const fresh = await say(p, 'Restart check-in');
    expect(fresh.response).toMatch(/how are you feeling emotionally today/);
    const row = await db.getTodaysJournal(p);
    expect(row).toMatchObject({ emotional_state: null, physical_symptoms: null });
    expect((await db.getJournalSession(p)).currentStage).toBe('mood');
    await say(p, '8');
    expect((await db.getTodaysJournal(p)).emotional_state).toBe(8);
    expect(row.id).toBe((await db.getTodaysJournal(p)).id);
  });

  it('Stop leaves it for today: answers kept as an incomplete entry, no more card', async () => {
    const p = await onboarded();
    await atSleep(p);
    await say(p, 'what fruits are good for me?');
    const stop = await say(p, 'Stop check-in');
    expect(stop.response).toMatch(/stopped the check-in/);
    expect(await db.getJournalSession(p)).toBeNull();
    expect(await db.getTodaysJournal(p)).toMatchObject({ emotional_state: 6, completed: 0 });
    expect((await say(p, 'thanks')).response).not.toMatch(/check-in is paused/);
  });

  it('a summary asked mid-check-in is answered and the check-in waits', async () => {
    const p = await onboarded();
    await atSleep(p);
    const r = await say(p, 'Weekly summary');
    expect(r.context).toBe('journal_summary');
    expect(r.response).toMatch(/Your check-in is paused/);
    expect(await paused(p)).toBe(true);
  });

  it('a danger sign while paused gets care copy only; the check-in still waits', async () => {
    const p = await onboarded();
    await atSleep(p);
    await say(p, 'what fruits are good for me?');
    const r = await say(p, 'I am bleeding heavily and soaked two pads');
    expect(r.urgencyLevel).toBe('critical');
    expect(r.response).not.toMatch(/Resume check-in/);
    expect(await paused(p)).toBe(true);
  });

  it('started on WhatsApp, resumed in the app', async () => {
    const p = await onboarded();
    await atSleep(p, 'whatsapp');
    const web = await say(p, 'hello', 'web');
    expect(web.response).toMatch(/Your check-in is paused/);
    const back = await say(p, 'Resume check-in', 'web');
    expect(back.response).toMatch(/^Welcome back!/);
    expect((await db.getJournalSession(p)).channel).toBe('web');
    expect((await say(p, '7/10, 6 hours', 'web')).response).toMatch(/glasses of water/);
  });

  it('a check-in from an earlier day is closed, and today starts fresh', async () => {
    const p = await onboarded();
    await atSleep(p);
    await say(p, 'what fruits are good for me?');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 26 * 60 * 60 * 1000));
    const r = await say(p, 'Start journal');
    expect(r.response).toMatch(/how are you feeling emotionally today/);
    expect(r.response).not.toMatch(/in progress/);
  });

  it('Kiswahili: card and resume in her language', async () => {
    const p = await onboarded({ language: 'sw' });
    await say(p, 'Anza jarida');
    await say(p, '6');
    const q = await say(p, 'Je, ni kawaida kuhisi kizunguzungu?');
    expect(q.response).toMatch(/Jarida lako limesimamishwa\. Hadi sasa: Hali 6\/10\. Inayofuata: dalili\./);
    expect(q.buttons?.options).toEqual(['Endelea na jarida', 'Anza upya', 'Acha jarida']);
    expect((await say(p, 'Endelea na jarida')).response).toMatch(/^Karibu tena! 📝 Hadi sasa: Hali 6\/10\.\n\nUna dalili zozote/);
  });
});

describe('"what did you mean?" from the stronger model', () => {
  it('runs on the clarify model: Sonnet on OpenRouter unless LLM_CLARIFY_MODEL says otherwise', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'or-test');
    vi.stubEnv('LLM_EXTRACT_MODEL', 'anthropic/claude-haiku-5.5');
    expect(resolveModel('gpt-3.5-turbo', 'clarify')).toBe('anthropic/claude-sonnet-5.5');
    vi.stubEnv('LLM_CLARIFY_MODEL', 'anthropic/claude-opus-5.5');
    expect(resolveModel('gpt-3.5-turbo', 'clarify')).toBe('anthropic/claude-opus-5.5');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('LLM_CLARIFY_MODEL', '');
    expect(resolveModel('gpt-3.5-turbo', 'clarify')).toBe('anthropic/claude-haiku-5.5');
  });

  it('"It was a 7": the model writes the question, the app adds "Pain 7/10", a tap saves the value', async () => {
    const p = await onboarded();
    await atSleep(p);
    clarify = JSON.stringify({
      action: 'ask',
      message: 'Just checking, Joy: did you sleep well, like 7 out of 10, or did you sleep 7 hours?',
      options: [{ label: 'Slept well, 7/10', answer: { quality: 7 } }, { label: 'Slept 7 hours', answer: { hours: 7 } }],
    });
    const r = await say(p, 'It was a 7');
    expect(calls.clarify).toBe(1);
    expect(r.buttons.body).toBe('Just checking, Joy: did you sleep well, like 7 out of 10, or did you sleep 7 hours?');
    expect(r.buttons.options).toEqual(['Slept well, 7/10', 'Slept 7 hours', 'Pain 7/10']);
    const next = await say(p, 'Slept 7 hours');
    expect(next.response).toMatch(/glasses of water/);
    expect(await db.getTodaysJournal(p)).toMatchObject({ sleep_hours: 7, sleep_quality: null });
  });

  it('a bare number is never settled by a guess: "save" falls back to the canned question', async () => {
    const p = await onboarded();
    await atSleep(p);
    clarify = '{"action":"save","answer":{"quality":7}}';
    const r = await say(p, 'It was a 7');
    expect(r.buttons.options).toEqual(['Sleep 7/10', 'Slept 7 hours', 'Pain 7/10']);
  });

  it('settles a longer answer the first model found ambiguous, without asking', async () => {
    const p = await onboarded();
    await atSleep(p);
    interp = '{"status":"ambiguous","answer":{},"readings":[{"hours":0.5},{"hours":1}],"symptom":""}';
    clarify = '{"action":"save","answer":{"hours":0.7}}';
    const r = await say(p, 'like an 1 /10. I slept like for 40 minutes');
    expect(r.response).toMatch(/glasses of water/);
    expect(calls.clarify).toBe(1);
    // Sleep hours are kept to the half hour.
    expect((await db.getTodaysJournal(p)).sleep_hours).toBe(0.5);
  });

  it('drops options the app cannot save or show, and keeps the safety one', async () => {
    const p = await onboarded();
    await say(p, 'Start journal');
    await say(p, '6');
    await say(p, 'nausea');
    await say(p, '7/10, 6 hours');
    interp = '{"status":"no_answer","answer":{},"readings":[],"symptom":""}';
    clarify = JSON.stringify({
      action: 'ask',
      message: 'No problem, a rough guess helps. About how many glasses today?',
      options: [
        { label: 'About 4 glasses', answer: { glasses: 4 } },
        { label: 'A very long label that will not fit', answer: { glasses: 8 } },
        { label: 'Loads', answer: { glasses: 300 } },
      ],
    });
    const r = await say(p, 'not sure, I sip all day long honestly');
    expect(r.buttons.body).toBe('No problem, a rough guess helps. About how many glasses today?');
    expect(r.buttons.options).toEqual(['About 4 glasses', 'I feel unwell']);
    await say(p, 'About 4 glasses');
    expect((await db.getTodaysJournal(p)).water_intake).toBe(4);
  });

  it('a long reply that is not an answer: the model says so and the check-in pauses', async () => {
    const p = await onboarded();
    await atSleep(p);
    clarify = '{"action":"off_topic"}';
    const r = await say(p, 'my husband keeps asking when we should tell his parents about the baby');
    expect(calls.clarify).toBe(1);
    expect(r.context).not.toBe('journaling');
    expect(r.response).toMatch(/Your check-in is paused/);
  });

  it('a long reply with no model to judge it pauses, as before', async () => {
    const p = await onboarded();
    await atSleep(p);
    clarify = 'garbage';
    const r = await say(p, 'my husband keeps asking when we should tell his parents about the baby');
    expect(r.response).toMatch(/Your check-in is paused/);
  });

  it('a model label can never stand in for the safety option', async () => {
    const p = await onboarded();
    await atSleep(p);
    interp = '{"status":"ambiguous","answer":{},"readings":[{"quality":5},{"hours":5}],"symptom":""}';
    clarify = JSON.stringify({
      action: 'ask',
      message: 'Did you mean 5 hours, or 5 out of 10?',
      options: [{ label: 'I feel unwell.', answer: { hours: 5 } }, { label: 'Slept 5 hours', answer: { hours: 5 } }],
    });
    const r = await say(p, 'maybe five, it was not a good night at all');
    expect(r.buttons.options).toEqual(['Slept 5 hours', 'I feel unwell']);
    const picked = await say(p, 'I feel unwell');
    expect(picked.context).not.toBe('journaling');
    expect((await db.getTodaysJournal(p)).sleep_hours).toBeNull();
  });

  it('a model failure falls back to the canned question', async () => {
    const p = await onboarded();
    await atSleep(p);
    interp = '{"status":"ambiguous","answer":{},"readings":[{"quality":5},{"hours":5}],"symptom":""}';
    clarify = 'not json at all';
    const r = await say(p, 'maybe five, it was not a good night at all');
    expect(r.response).toMatch(/^Just to be sure, what did you mean by/);
    expect(r.buttons.options).toEqual(['Sleep 5/10', 'Slept 5 hours', 'I feel unwell']);
  });

  it('a question is not clarified (it pauses the check-in), and without AI consent no model runs', async () => {
    const p = await onboarded();
    await atSleep(p);
    await say(p, 'what is a good amount of sleep in pregnancy?');
    expect(calls.clarify).toBe(0);

    const q = await onboarded({ ai: false });
    await atSleep(q);
    await say(q, 'It was a 7');
    expect(calls.clarify).toBe(0);
  });

  it('go-ahead words still work', () => {
    expect(isGoAhead('ok go ahead')).toBe(true);
  });
});
