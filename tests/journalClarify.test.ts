// "What did you mean?" in the daily check-in. Prod, 2026-10-20: "It was a
// 7" answering "Rate quality (1-10) and hours slept" was read by the
// triage model, which never saw the question, as "pain rated 7/10", and
// paused the check-in with a HIGH escalation. Now an answer that fits the
// question more than one way gets options (sleep 7/10 / slept 7 hours /
// pain 7/10), and every journal answer the model reads comes with the
// question Amaaii asked.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs');

process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';
process.env.AUTH_SECRET = 'test-auth-secret';

const db = require('../apps/server/src/database');
const wa = require('../packages/adapters/src/whatsapp');
const cloud = require('../packages/adapters/src/whatsappCloud');
const { createApp } = require('../apps/server/src/app');
const { processMessage, handleIncomingMessage } = require('../apps/server/src/messageHandler');
const {
  CONSENT_VERSION,
  bareSleepNumber,
  buildClarifyOptions,
  matchClarifyOption,
  validJournalFields,
  withOptionList,
} = require('@amaaii/core');
const { __setClient, __resetClient } = require('@amaaii/adapters');

// Stub model, routed on the system prompt.
let triage = '{"urgency":"low","reason":"ok"}';
let interp = '{"status":"no_answer","answer":{},"readings":[],"symptom":""}';
let calls = { triage: 0, interp: 0, other: 0 };
let triageInput = '';
let interpInput = '';
function installStub(): void {
  const create = async (req: { messages: { role: string; content: string }[] }) => {
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
    let content = 'Here is some friendly advice.';
    if (system.includes('triage nurse')) {
      calls.triage += 1;
      triageInput = user;
      content = triage;
    } else if (system.includes('daily check-in and record her answer')) {
      calls.interp += 1;
      interpInput = user;
      content = interp;
    } else {
      calls.other += 1;
      if (system.includes('STRICT JSON') || system.includes('Return JSON')) content = '{}';
    }
    return {
      id: 'x', object: 'chat.completion', created: 0, model: 'stub',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null }, logprobs: null }],
    };
  };
  __setClient({ chat: { completions: { create } } } as never);
}

const sent: { to: string; message: string }[] = [];

beforeAll(async () => {
  await db.initializeDatabase();
});

beforeEach(() => {
  triage = '{"urgency":"low","reason":"ok"}';
  interp = '{"status":"no_answer","answer":{},"readings":[],"symptom":""}';
  calls = { triage: 0, interp: 0, other: 0 };
  triageInput = '';
  interpInput = '';
  sent.length = 0;
  installStub();
  wa.__setSendImpl(async (to: string, message: string) => {
    sent.push({ to, message });
    return { mocked: true };
  });
});

afterEach(() => {
  __resetClient();
  wa.__resetSendImpl();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

let n = 0;
async function onboarded(ai = true): Promise<string> {
  n += 1;
  const phone = `whatsapp:+2547220${String(n).padStart(5, '0')}`;
  await db.createUser(phone, { name: 'Joy' });
  await db.updateUser(phone, { age: 27, pregnancy_week: 9, location: 'Nairobi' });
  await db.recordConsent(phone, 'data_processing', true, CONSENT_VERSION);
  await db.recordConsent(phone, 'ai_responses', ai, CONSENT_VERSION);
  return phone;
}

const say = (phone: string, msg: string, channel: 'whatsapp' | 'web' = 'web') =>
  processMessage(phone, msg, null, { channel });

/** Opens a check-in and answers mood + symptoms, so the sleep question is next. */
async function atSleepQuestion(phone: string, channel: 'whatsapp' | 'web' = 'web'): Promise<void> {
  await say(phone, 'journal', channel);
  await say(phone, '9', channel);
  await say(phone, 'None', channel);
}

describe('clarify helpers (core)', () => {
  it('a short bare number to the sleep question is ambiguous', () => {
    expect(bareSleepNumber('It was a 7')).toBe(7);
    expect(bareSleepNumber('7')).toBe(7);
    expect(bareSleepNumber('7/10')).toBeNull();
    expect(bareSleepNumber('6 hours')).toBeNull();
    expect(bareSleepNumber('7/10, 6 hours')).toBeNull();
    expect(bareSleepNumber('sleep was 7')).toBeNull();
    expect(bareSleepNumber('slept badly, woke up three times, maybe 4')).toBeNull();
    expect(bareSleepNumber('14')).toBeNull();
  });

  it('builds at most three short options, the last one leading to triage', () => {
    const en = buildClarifyOptions([{ quality: 7 }, { hours: 7 }], 'en', 7);
    expect(en.map((o: { label: string }) => o.label)).toEqual(['Sleep 7/10', 'Slept 7 hours', 'Pain 7/10']);
    expect(en[2].unwell).toBe(true);
    const sw = buildClarifyOptions([{ quality: 7 }, { hours: 7 }], 'sw', 7);
    expect(sw.map((o: { label: string }) => o.label)).toEqual(['Usingizi 7/10', 'Nililala saa 7', 'Maumivu 7/10']);
    for (const o of [...en, ...sw]) expect(o.label.length).toBeLessThanOrEqual(20);
    expect(buildClarifyOptions([{ hours: 5 }, { quality: 4, hours: 5 }], 'en', null)!.at(-1)!.label).toBe('I feel unwell');
    expect(buildClarifyOptions([{ hours: 5 }], 'en', 5)).toBeNull();
  });

  it('matches a reply to an option by number, button title or label', () => {
    const opts = buildClarifyOptions([{ quality: 7 }, { hours: 7 }], 'en', 7);
    expect(matchClarifyOption('2', opts)).toBe(1);
    expect(matchClarifyOption('1.', opts)).toBe(0);
    expect(matchClarifyOption('sleep 7/10', opts)).toBe(0);
    expect(matchClarifyOption('Pain 7/10', opts)).toBe(2);
    expect(matchClarifyOption('4', opts)).toBeNull();
    expect(matchClarifyOption('it was the hours', opts)).toBeNull();
  });

  it('keeps only in-range fields for the stage', () => {
    expect(validJournalFields('sleep', { quality: 7, hours: 6.4, mood: 3 })).toEqual({ quality: 7, hours: 6.5 });
    expect(validJournalFields('sleep', { quality: 70, hours: 30 })).toBeNull();
    expect(validJournalFields('mood', { mood: 0 })).toBeNull();
    expect(validJournalFields('appetite', { appetite: 'huge' })).toBeNull();
  });

  it('renders a numbered list for transports without buttons', () => {
    expect(withOptionList('What did you mean?', ['A', 'B'], 'en')).toBe('What did you mean?\n\n1. A\n2. B\n\nReply with the number.');
  });
});

describe('"It was a 7" to the sleep question', () => {
  it('asks what she meant instead of guessing or escalating', async () => {
    const phone = await onboarded();
    triage = '{"urgency":"high","reason":"Pain rated 7/10"}';
    await atSleepQuestion(phone);
    const r = await say(phone, 'It was a 7');
    expect(r.urgencyLevel).toBe('low');
    expect(r.buttons.body).toBe('Just to be sure, what did you mean by "It was a 7"?');
    expect(r.buttons.options).toEqual(['Sleep 7/10', 'Slept 7 hours', 'Pain 7/10']);
    expect(r.response).toContain('1. Sleep 7/10\n2. Slept 7 hours\n3. Pain 7/10');
    expect(calls.triage).toBe(0);
    const journal = await db.getTodaysJournal(phone);
    expect(journal.sleep_quality).toBeNull();
    expect(journal.sleep_hours).toBeNull();
  });

  it('"2" saves 7 hours and moves on', async () => {
    const phone = await onboarded();
    await atSleepQuestion(phone);
    await say(phone, 'It was a 7');
    const r = await say(phone, '2');
    expect(r.response).toMatch(/glasses of water/);
    const journal = await db.getTodaysJournal(phone);
    expect(journal.sleep_hours).toBe(7);
    expect(journal.sleep_quality).toBeNull();
  });

  it('the button title saves the quality', async () => {
    const phone = await onboarded();
    await atSleepQuestion(phone, 'whatsapp');
    await say(phone, 'It was a 7', 'whatsapp');
    await say(phone, 'Sleep 7/10', 'whatsapp');
    const journal = await db.getTodaysJournal(phone);
    expect(journal.sleep_quality).toBe(7);
  });

  it('"Pain 7/10" closes the check-in and is triaged with the question in view', async () => {
    const phone = await onboarded();
    await atSleepQuestion(phone);
    await say(phone, 'It was a 7');
    triage = '{"urgency":"high","reason":"Pain 7/10 at 9 weeks"}';
    const r = await say(phone, 'Pain 7/10');
    expect(calls.triage).toBe(1);
    expect(triageInput).toMatch(/what did you mean by "It was a 7"/);
    expect(triageInput).toMatch(/Pain 7\/10/);
    expect(r.urgencyLevel).toBe('high');
    expect(r.response).toMatch(/healthcare provider TODAY/);
    // Paused, not lost; the danger reply itself carries no check-in buttons.
    expect((await db.getJournalSession(phone))?.journalData.__paused).toBe(true);
    expect(r.response).not.toMatch(/Resume check-in/);
  });

  it('an answer that matches no option is not asked about twice', async () => {
    const phone = await onboarded();
    await atSleepQuestion(phone);
    await say(phone, 'It was a 7');
    const r = await say(phone, 'the 7 I said');
    expect(r.buttons).toBeUndefined();
    expect(r.response).toMatch(/glasses of water/);
  });

  it('works without AI consent, and "Pain" then points her to care without the model', async () => {
    const phone = await onboarded(false);
    await atSleepQuestion(phone);
    const r = await say(phone, 'It was a 7');
    expect(r.buttons.options).toHaveLength(3);
    const r2 = await say(phone, '3');
    expect(r2.response).toMatch(/nearest health facility today/);
    expect(calls).toEqual({ triage: 0, interp: 0, other: 0 });
    expect((await db.getJournalSession(phone))?.journalData.__paused).toBe(true);
  });
});

describe('the model reads journal answers against the question', () => {
  it('a longer sleep answer is read with the question asked', async () => {
    const phone = await onboarded();
    await atSleepQuestion(phone);
    interp = '{"status":"clear","answer":{"quality":3,"hours":5},"readings":[],"symptom":""}';
    await say(phone, 'honestly not great, woke up a lot, maybe five hours in total');
    expect(calls.interp).toBe(1);
    expect(interpInput).toMatch(/Amaaii asked:[\s\S]*How was your sleep last night/);
    expect(interpInput).toMatch(/five hours/);
    const journal = await db.getTodaysJournal(phone);
    expect(journal.sleep_quality).toBe(3);
    expect(journal.sleep_hours).toBe(5);
  });

  it('an ambiguous reading becomes options built from validated fields', async () => {
    const phone = await onboarded();
    await atSleepQuestion(phone);
    interp = '{"status":"ambiguous","answer":{},"readings":[{"hours":6},{"quality":6,"hours":99}],"symptom":""}';
    const r = await say(phone, 'about six I would say, not too bad overall');
    // The out-of-range hours are dropped, leaving {quality: 6}.
    expect(r.buttons.options).toEqual(['Slept 6 hours', 'Sleep 6/10', 'I feel unwell']);
  });

  it('readings that only add values she never gave are not offered as a choice', async () => {
    const phone = await onboarded();
    await atSleepQuestion(phone);
    // Real Haiku output for this reply before the prompt fix.
    interp = '{"status":"ambiguous","answer":{"hours":5},"readings":[{"quality":3,"hours":5},{"hours":5}],"symptom":""}';
    const r = await say(phone, 'honestly not great, woke up a lot, maybe five hours in total');
    expect(r.buttons).toBeUndefined();
    const journal = await db.getTodaysJournal(phone);
    expect(journal.sleep_hours).toBe(5);
    expect(journal.sleep_quality).toBeNull();
  });

  it('a score answer that mentions a symptom is triaged, with the question', async () => {
    const phone = await onboarded();
    await atSleepQuestion(phone);
    interp = '{"status":"clear","answer":{"hours":3},"readings":[],"symptom":"stomach cramps"}';
    triage = '{"urgency":"high","reason":"cramps at 9 weeks"}';
    const r = await say(phone, 'only 3 hours, the cramps in my tummy kept waking me up');
    expect(calls.triage).toBe(1);
    expect(triageInput).toMatch(/How was your sleep last night/);
    expect(r.urgencyLevel).toBe('high');
  });
});

describe('delivery of the options', () => {
  it('POST /chat returns the question and the options for chips', async () => {
    const app = createApp();
    n += 1;
    const res = await request(app).post('/auth/login').send({ phone: `07221${String(n).padStart(5, '0')}` });
    const phone = res.body.user.phone as string;
    await db.createUser(phone, { name: 'Joy' });
    await db.updateUser(phone, { age: 27, pregnancy_week: 9, location: 'Nairobi' });
    await db.recordConsent(phone, 'data_processing', true, CONSENT_VERSION);
    await db.recordConsent(phone, 'ai_responses', true, CONSENT_VERSION);
    const chat = (message: string) => request(app).post('/chat').set('Authorization', `Bearer ${res.body.token}`).send({ message });
    await chat('journal');
    await chat('9');
    await chat('None');
    const r = await chat('It was a 7');
    expect(r.body.response).toBe('Just to be sure, what did you mean by "It was a 7"?');
    expect(r.body.options).toEqual(['Sleep 7/10', 'Slept 7 hours', 'Pain 7/10']);
  });

  it('WhatsApp without Meta buttons gets the numbered list', async () => {
    const phone = await onboarded();
    await atSleepQuestion(phone, 'whatsapp');
    await handleIncomingMessage(phone, 'It was a 7', null);
    expect(sent.at(-1)!.message).toContain('1. Sleep 7/10');
  });

  it('Meta sends real reply buttons', async () => {
    vi.stubEnv('META_WA_ACCESS_TOKEN', 'test-token');
    vi.stubEnv('META_WA_PHONE_NUMBER_ID', '123');
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.OUT' }] }) }));
    vi.stubGlobal('fetch', fetchMock);
    await cloud.sendCloudButtons('whatsapp:+254700000001', 'What did you mean?', ['Sleep 7/10', 'Slept 7 hours', 'Pain 7/10']);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({
      to: '254700000001',
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'What did you mean?' },
        action: { buttons: [
          { type: 'reply', reply: { id: 'opt_1', title: 'Sleep 7/10' } },
          { type: 'reply', reply: { id: 'opt_2', title: 'Slept 7 hours' } },
          { type: 'reply', reply: { id: 'opt_3', title: 'Pain 7/10' } },
        ] },
      },
    });
  });

  it('a failed button send falls back to the numbered list', async () => {
    wa.__resetSendImpl();
    vi.stubEnv('WHATSAPP_PROVIDER', 'meta');
    vi.stubEnv('META_WA_ACCESS_TOKEN', 'test-token');
    vi.stubEnv('META_WA_PHONE_NUMBER_ID', '123');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: { message: 'bad', code: 100 } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.OUT' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    await wa.sendWhatsAppButtons('whatsapp:+254700000001', 'Q?', ['A', 'B'], 'Q?\n\n1. A\n2. B');
    const second = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(second).toMatchObject({ type: 'text', text: { body: 'Q?\n\n1. A\n2. B' } });
  });
});
