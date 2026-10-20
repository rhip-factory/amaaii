// LLM-first onboarding, conversational profile updates, postpartum and
// memory (P1). Drives processMessage in-process with a stubbed model:
// the onboarding extractor gets `slots`, the AI reply gets `reply`, and
// every other extraction gets "{}".
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs');

process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';
process.env.LLM_TRIAGE_RAISE = '0';

const db = require('../apps/server/src/database');
const { processMessage } = require('../apps/server/src/messageHandler');
const { selectMemoryTurns, memoryLines } = require('../apps/server/src/amaaii');
const { CONSENT_VERSION } = require('@amaaii/core');
const { __setClient, __resetClient } = require('@amaaii/adapters');

let slots = '{}';
let reply = 'A friendly answer.';
let lastReplyRequest: { messages: { role: string; content: string }[] } | null = null;

beforeAll(async () => {
  await db.initializeDatabase();
});

beforeEach(() => {
  slots = '{}';
  reply = 'A friendly answer.';
  lastReplyRequest = null;
  const create = async (req: { messages: { role: string; content: string }[] }) => {
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    let content = reply;
    if (system.includes('pull out profile facts')) content = slots;
    else if (system.includes('STRICT JSON')) content = '{}';
    else lastReplyRequest = req;
    return {
      id: 'x', object: 'chat.completion', created: 0, model: 'stub',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null }, logprobs: null }],
    };
  };
  __setClient({ chat: { completions: { create } } } as never);
});

afterEach(() => __resetClient());

let n = 0;
function phone(): string {
  n += 1;
  return `whatsapp:+2547220${String(n).padStart(5, '0')}`;
}
async function consented(p: string): Promise<void> {
  await db.createUser(p, {});
  await db.recordConsent(p, 'data_processing', true, CONSENT_VERSION);
  await db.recordConsent(p, 'ai_responses', true, CONSENT_VERSION);
}
const say = (p: string, msg: string) => processMessage(p, msg, null, { channel: 'whatsapp' });

describe('LLM-first onboarding', () => {
  it('fills several fields from one free-text message and summarises the saved profile', async () => {
    const p = phone();
    await consented(p);
    await say(p, 'hello'); // -> name prompt
    slots = '{"name":"Wanjiru","age":19,"months":5,"location":"Kisumu"}';
    const r = await say(p, 'Mimi ni Wanjiru, nina miaka 19, mimba ya miezi mitano, niko Kisumu');
    const user = await db.getUser(p);
    expect(user).toMatchObject({ name: 'Wanjiru', age: 19, pregnancy_week: 22, location: 'Kisumu' });
    expect(user.edd).toBeTruthy();
    // The summary is built from the re-read row, so it includes the location.
    expect(r.response).toMatch(/Kisumu/);
  });

  it('never takes an age from a dose or a week count', async () => {
    const p = phone();
    await consented(p);
    await db.updateUser(p, { name: 'Grace' });
    await say(p, 'hi');
    slots = '{"age":250}';
    await say(p, 'I take methyldopa 250mg twice a day');
    expect((await db.getUser(p)).age).toBeNull();
    await say(p, '11 weeks');
    expect((await db.getUser(p)).age).toBeNull();
  });

  it('a Kiswahili age in words is understood without the model', async () => {
    const p = phone();
    await consented(p);
    await db.updateUser(p, { name: 'Wanjiru' });
    await say(p, 'habari');
    await say(p, 'Nina miaka kumi na tisa');
    expect((await db.getUser(p)).age).toBe(19);
  });

  it('"4 months" becomes about 17 weeks, not week 4', async () => {
    const p = phone();
    await consented(p);
    await db.updateUser(p, { name: 'Akinyi', age: 16 });
    await say(p, 'hi');
    await say(p, '4 months');
    expect((await db.getUser(p)).pregnancy_week).toBe(17);
  });

  it('a question at the location step is answered, not saved as the location', async () => {
    const p = phone();
    await consented(p);
    await db.updateUser(p, { name: 'Faith', age: 23, pregnancy_week: 8 });
    await db.saveConversation(p, '8', 'Great! You\'re at week 8. 🤰\n\nWhere are you located?', { context: 'onboarding' });
    reply = 'Bananas are a good snack.';
    const r = await say(p, 'What fruits are good for me?');
    expect((await db.getUser(p)).location).toBeNull();
    expect(r.response).toMatch(/Bananas/);
    expect(r.response).toMatch(/Which town or area/);
  });

  it('a mother who joins after the birth goes straight to postpartum', async () => {
    const p = phone();
    await consented(p);
    await db.updateUser(p, { name: 'Purity', age: 26 });
    await say(p, 'hi');
    slots = '{"babyBorn":true,"babyAgeDays":14}';
    const r = await say(p, 'My baby is two weeks old, I gave birth at Pumwani');
    const user = await db.getUser(p);
    expect(user.delivery_date).toBeTruthy();
    expect(r.response).toMatch(/Congratulations on your baby/);
  });

  it('a first message in Kiswahili gets the consent request in Kiswahili', async () => {
    const p = phone();
    const r = await say(p, 'Habari, nimepewa namba hii na nesi kliniki');
    expect(r.response).toMatch(/NAKUBALI/);
    expect((await db.getUser(p)).language).toBe('sw');
  });
});

async function onboarded(edd = '2027-01-12'): Promise<string> {
  const p = phone();
  await consented(p);
  await db.updateUser(p, { name: 'Chebet Kiprop', age: 29, pregnancy_week: 8, edd, location: 'Eldoret' });
  return p;
}

describe('profile updates in conversation', () => {
  it('"Kiswahili tafadhali" switches the language and confirms in Kiswahili', async () => {
    const p = await onboarded();
    const r = await say(p, 'Kiswahili tafadhali');
    expect((await db.getUser(p)).language).toBe('sw');
    expect(r.response).toMatch(/Kiswahili/);
  });

  it('"I am 28 weeks, not 16" fixes the week and moves the due date', async () => {
    const p = await onboarded('2027-06-01');
    const r = await say(p, 'I am 28 weeks, not 16');
    const user = await db.getUser(p);
    expect(user.pregnancy_week).toBe(28);
    expect(r.response).toMatch(/week 28/);
    expect((await say(p, 'what should I eat this week?')).response).toBeTruthy();
    expect((await db.getUser(p)).pregnancy_week).toBe(28);
  });

  it('"my name is …" changes the name', async () => {
    const p = await onboarded();
    await say(p, 'my name is Chebet');
    expect((await db.getUser(p)).name).toBe('Chebet');
  });

  it('"nimejifungua jana" records the birth', async () => {
    const p = await onboarded(new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10));
    const r = await say(p, 'Nimejifungua jana, ni msichana');
    const user = await db.getUser(p);
    expect(user.delivery_date).toBe(new Date(Date.now() - 864e5).toISOString().slice(0, 10));
    expect(r.response).toMatch(/Congratulations|Hongera/);
  });
});

describe('the AI sees where she is now and what came before', () => {
  it('the stored week follows the due date instead of the onboarding snapshot', async () => {
    const p = await onboarded('2027-01-12');
    await say(p, 'what can I eat for breakfast?');
    const system = lastReplyRequest!.messages[0].content;
    const user = await db.getUser(p);
    expect(user.pregnancy_week).not.toBe(8);
    expect(system).toMatch(new RegExp(`Pregnancy week: ${user.pregnancy_week}`));
  });

  it('postpartum mothers are described as postpartum, not by week', async () => {
    const p = await onboarded();
    await db.updateUser(p, { delivery_date: new Date(Date.now() - 5 * 864e5).toISOString().slice(0, 10) });
    await say(p, 'how often should the baby feed?');
    expect(lastReplyRequest!.messages[0].content).toMatch(/Postpartum: baby born 5 days ago/);
  });

  it('a [NAME] the model copies from history never reaches her', async () => {
    const p = await onboarded();
    reply = '[NAME], that is normal at this stage.';
    const r = await say(p, 'is it normal to feel tired at this stage?');
    expect(r.response).not.toMatch(/\[NAME\]/);
    expect(r.response).toMatch(/^Chebet, that is normal/);
  });

  it('memory skips consent/onboarding/journal turns and keeps the last six real ones', () => {
    const row = (i: number, context: string) => ({ id: i, message: `m${i}`, response: `r${i}`, context, timestamp: '2026-10-20 08:00:00' });
    const history = [row(9, 'general'), row(8, 'journaling'), row(7, 'general'), row(6, 'mental_health'), row(5, 'general'),
      row(4, 'danger_sign_detected'), row(3, 'general'), row(2, 'onboarding'), row(1, 'consent_gate')];
    expect(selectMemoryTurns(history).map((r: { id: number }) => r.id)).toEqual([3, 4, 5, 6, 7, 9]);
  });

  it('notes long gaps and recent escalations', () => {
    const lines = memoryLines([
      { message: 'x', response: 'y', context: 'general', urgency_level: 'high', danger_signs_detected: '[{"sign":"Fever","level":"high"}]', timestamp: '2026-10-10 08:00:00' },
    ], new Date('2026-10-20T08:00:00Z'));
    expect(lines.join('\n')).toMatch(/10 days ago/);
    expect(lines.join('\n')).toMatch(/Fever/);
  });
});
