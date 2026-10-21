// Reply buttons on canned prompts (core actionButtons.ts). Messages that
// used to say "type 'none'" or "Reply *I AGREE*" now say "tap *None*" and
// carry that word as a WhatsApp reply button / app chip. A tap arrives as
// the button's title, so every label is driven through processMessage
// here to prove it routes exactly like typing it.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs');

process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';
process.env.AUTH_SECRET = 'test-auth-secret';
process.env.LLM_TRIAGE_RAISE = '0';

const db = require('../apps/server/src/database');
const wa = require('../packages/adapters/src/whatsapp');
const { createApp } = require('../apps/server/src/app');
const { processMessage, handleIncomingMessage } = require('../apps/server/src/messageHandler');
const {
  CONSENT_VERSION,
  STRINGS,
  ACTION_PROMPTS,
  MAX_ACTION_BUTTONS,
  actionButtonsFor,
  withButtonHint,
  t,
} = require('@amaaii/core');
const { __setClient, __resetClient } = require('@amaaii/adapters');

const sent: { to: string; message: string }[] = [];

beforeAll(async () => {
  await db.initializeDatabase();
});

beforeEach(() => {
  sent.length = 0;
  const create = async (req: { messages: { role: string; content: string }[] }) => {
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    const content = system.includes('STRICT JSON') || system.includes('Return JSON') ? '{}' : 'A friendly answer.';
    return {
      id: 'x', object: 'chat.completion', created: 0, model: 'stub',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null }, logprobs: null }],
    };
  };
  __setClient({ chat: { completions: { create } } } as never);
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
function phone(): string {
  n += 1;
  return `whatsapp:+2547230${String(n).padStart(5, '0')}`;
}
async function onboarded(language = 'en'): Promise<string> {
  const p = phone();
  await db.createUser(p, { name: 'Joy' });
  await db.updateUser(p, { age: 27, pregnancy_week: 9, location: 'Nairobi', language });
  await db.recordConsent(p, 'data_processing', true, CONSENT_VERSION);
  await db.recordConsent(p, 'ai_responses', true, CONSENT_VERSION);
  return p;
}
const say = (p: string, msg: string) => processMessage(p, msg, null, { channel: 'whatsapp' });

describe('which canned prompts get buttons (core)', () => {
  it.each([
    ['en', 'journal_mood_followup', ['None']],
    ['en', 'journal_questions_q', ['None']],
    ['en', 'journal_notes_q', ['Done']],
    ['en', 'journal_mood_invalid', ['Stop check-in']],
    ['en', 'journal_appetite_q', ['Good', 'Moderate', 'Poor']],
    ['en', 'journal_water_followup', ['Good', 'Moderate', 'Poor']],
    ['en', 'journal_done', ['Journal summary', 'Weekly summary']],
    ['en', 'journal_cancelled', ['Start journal']],
    ['en', 'journal_paused_note', ['Start journal']],
    ['en', 'journal_none_today', ['Start journal']],
    ['en', 'journal_reminder', ['Start journal']],
    ['en', 'location_done', ['Start journal', 'Help']],
    ['en', 'help_menu', ['Start journal', 'Weekly summary', 'Doctor report']],
    ['en', 'consent_request', ['I AGREE']],
    ['en', 'consent_reprompt', ['I AGREE']],
    ['en', 'consent_explain', ['I AGREE']],
    ['en', 'consent_explain_more', ['I AGREE']],
    ['en', 'consent_declined', ['I AGREE']],
    ['en', 'lang_set_en', ['Kiswahili']],
    ['sw', 'lang_set_sw', ['English']],
    ['sw', 'journal_mood_followup', ['Hapana']],
    ['sw', 'journal_questions_q', ['Hapana']],
    ['sw', 'journal_notes_q', ['Maliza']],
    ['sw', 'journal_mood_invalid', ['Acha jarida']],
    ['sw', 'journal_appetite_q', ['Nzuri', 'Wastani', 'Mbaya']],
    ['sw', 'journal_done', ['Muhtasari wa leo', 'Muhtasari wa wiki']],
    ['sw', 'journal_reminder', ['Anza jarida']],
    ['sw', 'location_done', ['Anza jarida', 'Msaada']],
    ['sw', 'help_menu', ['Anza jarida', 'Muhtasari wa wiki', 'Ripoti ya daktari']],
    ['sw', 'consent_request', ['NAKUBALI']],
    ['sw', 'consent_reprompt', ['NAKUBALI']],
    ['sw', 'consent_explain', ['NAKUBALI']],
    ['sw', 'consent_declined', ['NAKUBALI']],
  ])('%s %s', (lang, key, options) => {
    const text = t(lang, key, { ack: 'Thanks.', summary: 'Name: Joy', url: 'https://amaaii.com/privacy' });
    expect(actionButtonsFor(text)?.options).toEqual(options);
  });

  it('every marker is a phrase of some canned string in its language', () => {
    for (const p of ACTION_PROMPTS) {
      const copy = Object.values(STRINGS[p.lang] as Record<string, string>).map((s) => s.toLowerCase());
      expect(copy.some((s) => s.includes(p.marker)), p.marker).toBe(true);
    }
  });

  it('no canned prompt still asks her to type a word, except the error line', () => {
    for (const lang of ['en', 'sw']) {
      for (const [key, s] of Object.entries(STRINGS[lang] as Record<string, string>)) {
        if (key === 'error_generic') continue;
        expect(s, `${lang}.${key}`).not.toMatch(/\btype ['"*]|\bandika ['"*]|\breply \*i agree|\bjibu \*nakubali/i);
      }
    }
  });

  it('labels fit a WhatsApp button and a prompt never gets more than three', () => {
    for (const lang of ['en', 'sw']) {
      for (const [key, s] of Object.entries(STRINGS[lang] as Record<string, string>)) {
        if (key.startsWith('btn_')) expect(s.length, key).toBeLessThanOrEqual(20);
      }
    }
    expect(actionButtonsFor(`${t('en', 'help_menu')}\n\n${t('en', 'journal_reminder')}`)?.options).toHaveLength(MAX_ACTION_BUTTONS);
  });

  it('plain text gets no buttons, and the text form lists the words', () => {
    expect(actionButtonsFor('Bananas are a good snack.')).toBeNull();
    const b = actionButtonsFor(t('en', 'journal_notes_q'))!;
    expect(withButtonHint('Q', b)).toBe('Q\n\n(Reply with: *Done*)');
  });
});

describe('a tap routes like typing the word', () => {
  it('consent: "I AGREE" and "NAKUBALI"', async () => {
    const en = phone();
    const first = await say(en, 'Hello, a nurse at the clinic gave me this number');
    expect(first.buttons?.options).toEqual(['I AGREE']);
    expect((await say(en, 'I AGREE')).response).toMatch(/what'?s your name/i);

    const sw = phone();
    const ombi = await say(sw, 'Habari, nimepewa namba hii na nesi kliniki');
    expect(ombi.buttons?.options).toEqual(['NAKUBALI']);
    expect((await say(sw, 'NAKUBALI')).response).toMatch(/Jina lako ni nani/);
  });

  it('a whole check-in in English, answered with taps', async () => {
    const p = await onboarded();
    expect((await say(p, 'Start journal')).context).toBe('journaling');
    const symptomsQ = await say(p, '8');
    expect(symptomsQ.buttons?.options).toEqual(['None']);
    await say(p, 'None');
    await say(p, '7/10, 6 hours');
    const appetiteQ = await say(p, '6');
    expect(appetiteQ.buttons?.options).toEqual(['Good', 'Moderate', 'Poor']);
    expect((await say(p, 'Good')).buttons?.options).toEqual(['None']);
    expect((await say(p, 'None')).buttons?.options).toEqual(['Done']);
    const done = await say(p, 'Done');
    expect(done.response).toMatch(/Journal saved/);
    const j = await db.getTodaysJournal(p);
    expect(j).toMatchObject({ physical_symptoms: 'none', appetite: 'good', water_intake: 6 });
  });

  it('a whole check-in in Kiswahili, answered with taps', async () => {
    const p = await onboarded('sw');
    await say(p, 'Anza jarida');
    expect((await say(p, '5')).buttons?.options).toEqual(['Hapana']);
    await say(p, 'Hapana');
    await say(p, '6/10, saa 7');
    expect((await say(p, '4')).buttons?.options).toEqual(['Nzuri', 'Wastani', 'Mbaya']);
    expect((await say(p, 'Mbaya')).buttons?.options).toEqual(['Hapana']);
    expect((await say(p, 'Hapana')).buttons?.options).toEqual(['Maliza']);
    await say(p, 'Maliza');
    expect(await db.getTodaysJournal(p)).toMatchObject({ physical_symptoms: 'none', appetite: 'poor' });
  });

  it('"Stop check-in" ends it and offers "Start journal"', async () => {
    const p = await onboarded();
    await say(p, 'Start journal');
    const r = await say(p, 'Stop check-in');
    expect(r.response).toMatch(/stopped the check-in/);
    expect(r.buttons?.options).toEqual(['Start journal']);
  });

  it('the help menu buttons each run their command', async () => {
    const p = await onboarded();
    expect((await say(p, 'Help')).buttons?.options).toEqual(['Start journal', 'Weekly summary', 'Doctor report']);
    expect((await say(p, 'Weekly summary')).context).toBe('journal_summary');
    expect((await say(p, 'Doctor report')).context).toBe('doctor_report');
    expect((await say(p, 'Journal summary')).context).toBe('journal_summary');
    const sw = await onboarded('sw');
    expect((await say(sw, 'Msaada')).context).toBe('help');
    expect((await say(sw, 'Muhtasari wa wiki')).context).toBe('journal_summary');
    expect((await say(sw, 'Ripoti ya daktari')).context).toBe('doctor_report');
    expect((await say(sw, 'Muhtasari wa leo')).context).toBe('journal_summary');
  });

  it('language buttons switch language', async () => {
    const p = await onboarded();
    const toSw = await say(p, 'Kiswahili');
    expect(toSw.buttons?.options).toEqual(['English']);
    expect((await db.getUser(p)).language).toBe('sw');
    expect((await say(p, 'English')).buttons?.options).toEqual(['Kiswahili']);
    expect((await db.getUser(p)).language).toBe('en');
  });

  it('an AI reply with the journal reminder gets "Start journal", and history keeps what she saw', async () => {
    const p = await onboarded();
    const r = await say(p, 'What fruits are good for me?');
    expect(r.response).toMatch(/A friendly answer\.[\s\S]*Tap \*Start journal\*/);
    expect(r.buttons).toEqual({
      body: r.response,
      options: ['Start journal'],
      fallback: `${r.response}\n\n(Reply with: *Start journal*)`,
    });
    expect((await db.getLastBotMessage(p)).response).toBe(r.response);
  });
});

describe('delivery', () => {
  it('POST /chat returns the chips', async () => {
    const app = createApp();
    n += 1;
    const res = await request(app).post('/auth/login').send({ phone: `07231${String(n).padStart(5, '0')}` });
    const p = res.body.user.phone as string;
    await db.createUser(p, { name: 'Joy' });
    await db.updateUser(p, { age: 27, pregnancy_week: 9, location: 'Nairobi' });
    await db.recordConsent(p, 'data_processing', true, CONSENT_VERSION);
    await db.recordConsent(p, 'ai_responses', true, CONSENT_VERSION);
    const chat = (message: string) => request(app).post('/chat').set('Authorization', `Bearer ${res.body.token}`).send({ message });
    await chat('journal');
    const r = await chat('8');
    expect(r.body.response).toMatch(/tap \*None\*/);
    expect(r.body.options).toEqual(['None']);
  });

  it('WhatsApp without Meta buttons gets the words to reply with', async () => {
    const p = await onboarded();
    await say(p, 'journal');
    await handleIncomingMessage(p, '8', null);
    expect(sent.at(-1)!.message).toMatch(/tap \*None\*\)\n\n\(Reply with: \*None\*\)$/);
  });

  function metaFetch() {
    vi.stubEnv('WHATSAPP_PROVIDER', 'meta');
    vi.stubEnv('META_WA_ACCESS_TOKEN', 'test-token');
    vi.stubEnv('META_WA_PHONE_NUMBER_ID', '123');
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.OUT' }] }) }));
    vi.stubGlobal('fetch', fetchMock);
    const bodies = () => fetchMock.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string));
    return bodies;
  }

  it('Meta: a long reply goes as text, with its last paragraph on the buttons', async () => {
    wa.__resetSendImpl();
    const bodies = metaFetch();
    const answer = 'A long answer. '.repeat(80).trim();
    const prompt = t('en', 'journal_reminder');
    await wa.sendWhatsAppButtons('whatsapp:+254700000001', `${answer}\n\n${prompt}`, ['Start journal'], `${answer}\n\n${prompt}\n\n(Reply with: *Start journal*)`);
    const [first, second] = bodies();
    expect(first).toMatchObject({ type: 'text', text: { body: answer } });
    expect(second).toMatchObject({ type: 'interactive', interactive: { body: { text: prompt } } });
    expect(second.interactive.action.buttons[0].reply.title).toBe('Start journal');
  });

  it('Meta: a short reply is one button message', async () => {
    wa.__resetSendImpl();
    const bodies = metaFetch();
    await wa.sendWhatsAppButtons('whatsapp:+254700000001', 'Q?', ['None'], 'Q?\n\n(Reply with: *None*)');
    expect(bodies()).toHaveLength(1);
    expect(bodies()[0]).toMatchObject({ type: 'interactive', interactive: { body: { text: 'Q?' } } });
  });
});
