// WhatsApp <-> app sync and quality of life (P2): the shared chat history
// endpoint, follow-ups for app escalations, the help menu with the app
// link, voice notes on the Twilio webhook, and trimming cut-off replies.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs');

process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';
process.env.AUTH_SECRET = 'test-auth-secret';
process.env.LLM_TRIAGE_RAISE = '0';
process.env.TWILIO_SIGNATURE_ENFORCE = 'false';

const db = require('../apps/server/src/database');
const tw = require('../packages/adapters/src/whatsapp');
const { createApp } = require('../apps/server/src/app');
const { processMessage } = require('../apps/server/src/messageHandler');
const { CONSENT_VERSION, trimToLastSentence } = require('@amaaii/core');
const { __setClient, __resetClient } = require('@amaaii/adapters');

const sent: { to: string; message: string }[] = [];
let reply = 'A friendly answer.';
let finish = 'stop';

beforeAll(async () => {
  await db.initializeDatabase();
  tw.__setSendImpl(async (to: string, message: string) => {
    sent.push({ to, message });
    return { sid: 'mocked' };
  });
});

beforeEach(() => {
  sent.length = 0;
  reply = 'A friendly answer.';
  finish = 'stop';
  process.env.PUBLIC_BASE_URL = 'https://amaaii.example';
  const create = async (req: { messages: { role: string; content: string }[] }) => {
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    const content = system.includes('STRICT JSON') ? '{}' : reply;
    return {
      id: 'x', object: 'chat.completion', created: 0, model: 'stub',
      choices: [{ index: 0, finish_reason: system.includes('STRICT JSON') ? 'stop' : finish, message: { role: 'assistant', content, refusal: null }, logprobs: null }],
    };
  };
  __setClient({ chat: { completions: { create } } } as never);
});

afterEach(() => {
  __resetClient();
  delete process.env.PUBLIC_BASE_URL;
});

let n = 0;
async function loginOnboarded(app: import('express').Express): Promise<{ token: string; phone: string }> {
  n += 1;
  const res = await request(app).post('/auth/login').send({ phone: `07440${String(n).padStart(5, '0')}` });
  const phone = res.body.user.phone as string;
  await db.createUser(phone, { name: 'Mercy' });
  await db.updateUser(phone, { age: 31, pregnancy_week: 20, location: 'Nakuru' });
  await db.recordConsent(phone, 'data_processing', true, CONSENT_VERSION);
  await db.recordConsent(phone, 'ai_responses', true, CONSENT_VERSION);
  return { token: res.body.token as string, phone };
}

describe('GET /conversations — one chat across WhatsApp and the app', () => {
  it('returns WhatsApp and app turns oldest first, marked by channel, without consent-gate turns', async () => {
    const app = createApp();
    const { token, phone } = await loginOnboarded(app);
    await db.saveConversation(phone, 'Hi', 'Reply *I AGREE* to continue', { context: 'consent_gate', channel: 'whatsapp' });
    await processMessage(phone, 'what fruit is good at 20 weeks?', null, { channel: 'whatsapp' });
    await request(app).post('/chat').set('Authorization', `Bearer ${token}`).send({ message: 'and vegetables?' });

    const res = await request(app).get('/conversations').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const turns = res.body.turns as { channel: string; message: string }[];
    expect(turns.map((t) => t.message)).toEqual(['what fruit is good at 20 weeks?', 'and vegetables?']);
    expect(turns.map((t) => t.channel)).toEqual(['whatsapp', 'web']);
  });

  it('requires auth', async () => {
    const res = await request(createApp()).get('/conversations');
    expect(res.status).toBe(401);
  });
});

describe('follow-up after an escalation in the app', () => {
  it('is not scheduled for an app-only mother (WhatsApp would refuse to deliver it)', async () => {
    const app = createApp();
    const { token } = await loginOnboarded(app);
    const before = (await db.countJobsByStatus()).pending;
    await request(app).post('/chat').set('Authorization', `Bearer ${token}`).send({ message: 'I have a fever since morning' });
    expect((await db.countJobsByStatus()).pending).toBe(before);
  });

  it('is scheduled when she has been on WhatsApp in the last day', async () => {
    const app = createApp();
    const { token, phone } = await loginOnboarded(app);
    await processMessage(phone, 'hello', null, { channel: 'whatsapp' });
    const before = (await db.countJobsByStatus()).pending;
    await request(app).post('/chat').set('Authorization', `Bearer ${token}`).send({ message: 'I have a fever since morning' });
    expect((await db.countJobsByStatus()).pending).toBe(before + 1);
  });
});

describe('help', () => {
  it('"help" lists what Amaaii can do and links the app', async () => {
    const app = createApp();
    const { phone } = await loginOnboarded(app);
    const r = await processMessage(phone, 'help', null, { channel: 'whatsapp' });
    expect(r.context).toBe('help');
    expect(r.response).toMatch(/journal/);
    expect(r.response).toMatch(/https:\/\/amaaii\.example/);
  });
});

describe('voice notes on the Twilio webhook', () => {
  it('a media message with no text gets the "please type" reply with the danger line', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/webhook')
      .type('form')
      .send({ From: 'whatsapp:+254755000001', Body: '', NumMedia: '1', ProfileName: 'Atieno' });
    expect(res.status).toBe(200);
    expect(sent.at(-1)?.message).toMatch(/only read text messages/);
    expect(sent.at(-1)?.message).toMatch(/bleeding/);
  });
});

describe('empty messages', () => {
  it('an empty body never reaches the AI, on any path', async () => {
    const { handleIncomingMessage } = require('../apps/server/src/messageHandler');
    reply = 'SHOULD NOT BE SENT';
    await handleIncomingMessage('whatsapp:+254755000002', '   ', null);
    expect(sent.at(-1)?.message).toMatch(/only read text messages/);
  });
});

describe('cut-off replies', () => {
  it('trims to the last full sentence', () => {
    expect(trimToLastSentence('Rest when you can. Drink water often. If the pain gets worse, go to')).toBe('Rest when you can. Drink water often.');
    expect(trimToLastSentence('All good.')).toBe('All good.');
    expect(trimToLastSentence('Short and cut')).toBe('Short and cut…');
  });

  it('an AI reply that hit the token cap is trimmed before she sees it', async () => {
    const app = createApp();
    const { phone } = await loginOnboarded(app);
    reply = 'Mercy, at 20 weeks that is common. Try smaller meals. If it keeps you from eating, tell the';
    finish = 'length';
    const r = await processMessage(phone, 'I feel full quickly when I eat lunch', null, { channel: 'whatsapp' });
    expect(r.response.startsWith('Mercy, at 20 weeks that is common. Try smaller meals.')).toBe(true);
    expect(r.response).not.toMatch(/tell the\b/);
  });
});
