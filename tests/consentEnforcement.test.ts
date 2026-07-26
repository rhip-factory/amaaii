// P3-B: enforcement tests for the consent gate wired into
// processMessage (apps/server/src/messageHandler.ts) via the web /chat
// path (apps/server/src/app.ts). Mirrors tests/app.test.ts's HTTP-level
// style plus tests/llmChokepoint.test.ts's client-injection seam
// (__setClient/__resetClient) to prove the LLM chokepoint is genuinely
// skipped — not just that a canned string comes back, which could pass
// even if getAmaaiiResponse still fired an ignored network call.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs');

process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';
process.env.AUTH_SECRET = 'test-auth-secret';

const db = require('../apps/server/src/database');
const { createApp } = require('../apps/server/src/app');
const { CONSENT_VERSION } = require('@amaaii/core');
const { __setClient, __resetClient } = require('@amaaii/adapters');

beforeAll(async () => {
  await db.initializeDatabase();
});

afterEach(() => {
  __resetClient();
});

let counter = 0;
function freshPhone(): string {
  counter += 1;
  return `07000${String(counter).padStart(5, '0')}`;
}

async function loginAndGetToken(app: import('express').Express, rawPhone: string): Promise<{ token: string; phone: string }> {
  const res = await request(app).post('/auth/login').send({ phone: rawPhone });
  return { token: res.body.token as string, phone: res.body.user.phone as string };
}

// The AI/journaling gates below sit AFTER the profile-onboarding check
// in processMessage — granting consent alone still leaves a brand-new
// user's profile empty, which would route into onboarding instead of
// the AI/journal branches under test. Seed a complete profile (mirrors
// tests/messageHandler.test.js's "onboarded user" fixture) so these
// tests exercise the AI/consent gate specifically, not onboarding.
async function seedOnboardedProfile(phone: string): Promise<void> {
  // /auth/login (unlike /auth/otp/verify) never creates the user row —
  // createUser first (mirrors tests/messageHandler.test.js's "onboarded
  // user" fixture), THEN updateUser, since updateUser is a plain UPDATE
  // and silently no-ops against zero rows.
  await db.createUser(phone, { name: 'Grace' });
  await db.updateUser(phone, { age: 26, pregnancy_week: 20, location: 'Nairobi' });
}

function fakeCompletion(content: string) {
  return {
    id: 'consent-enforcement-test',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-3.5-turbo',
    choices: [
      { index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null }, logprobs: null },
    ],
  };
}

function mockOpenAiClient(content: string) {
  const create = async () => fakeCompletion(content);
  let calls = 0;
  const wrapped = async (...args: unknown[]) => {
    calls += 1;
    return create(...(args as []));
  };
  const client = { chat: { completions: { create: wrapped } } };
  __setClient(client as never);
  return {
    get callCount() {
      return calls;
    },
  };
}

describe('POST /chat — consent gate (non-consented user)', () => {
  it('returns consentRequired without processing or storing the conversation', async () => {
    const app = createApp();
    const { token, phone } = await loginAndGetToken(app, freshPhone());

    const res = await request(app)
      .post('/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'hello there, how is my week going' });

    expect(res.status).toBe(200);
    expect(res.body.consentRequired).toBe(true);
    expect(typeof res.body.response).toBe('string');
    expect(res.body.response.length).toBeGreaterThan(0);

    const history = await db.getConversationHistory(phone, 10);
    expect(history).toEqual([]);
  });

  it('a non-consented user sending "heavy bleeding" STILL gets CRITICAL escalation (vital-interests carve-out)', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());

    const res = await request(app)
      .post('/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'I have heavy bleeding' });

    expect(res.status).toBe(200);
    expect(res.body.urgencyLevel).toBe('critical');
    expect(res.body.response).toMatch(/URGENT/i);
    // CRITICAL bypasses the consent gate entirely — this is not the
    // "please consent" branch.
    expect(res.body.consentRequired).toBeUndefined();
  });

  it('a HIGH-urgency message from a non-consented user still carries the escalation copy alongside consentRequired', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());

    const res = await request(app)
      .post('/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'I have a severe headache' });

    expect(res.status).toBe(200);
    expect(res.body.consentRequired).toBe(true);
    expect(res.body.response).toMatch(/checked by a healthcare provider TODAY/i);
  });
});

describe('POST /chat — AI purpose gate (consented users)', () => {
  it('a consented+AI user gets an AI-generated reply, and the chokepoint IS called', async () => {
    const app = createApp();
    const { token, phone } = await loginAndGetToken(app, freshPhone());
    await seedOnboardedProfile(phone);
    await db.recordConsent(phone, 'data_processing', true, CONSENT_VERSION);
    await db.recordConsent(phone, 'ai_responses', true, CONSENT_VERSION);
    const mock = mockOpenAiClient('This is a mocked AI reply for the enforcement test.');

    const res = await request(app)
      .post('/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'would exercise help me sleep better?' });

    expect(res.status).toBe(200);
    expect(res.body.consentRequired).toBeUndefined();
    expect(res.body.response).toContain('This is a mocked AI reply for the enforcement test.');
    expect(mock.callCount).toBe(1);
  });

  it('a consented+AI-DECLINED user gets the deterministic canned reply, and the chokepoint is NOT called', async () => {
    const app = createApp();
    const { token, phone } = await loginAndGetToken(app, freshPhone());
    await seedOnboardedProfile(phone);
    await db.recordConsent(phone, 'data_processing', true, CONSENT_VERSION);
    await db.recordConsent(phone, 'ai_responses', false, CONSENT_VERSION);
    const mock = mockOpenAiClient('SHOULD NEVER BE RETURNED');

    const res = await request(app)
      .post('/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'would exercise help me sleep better?' });

    expect(res.status).toBe(200);
    expect(res.body.consentRequired).toBeUndefined();
    expect(res.body.response).toMatch(/AI-powered replies are turned off/i);
    expect(res.body.response).not.toContain('SHOULD NEVER BE RETURNED');
    expect(mock.callCount).toBe(0);
  });

  it('journaling still works end-to-end for an AI-declined user, and the chokepoint is never called', async () => {
    const app = createApp();
    const { token, phone } = await loginAndGetToken(app, freshPhone());
    await seedOnboardedProfile(phone);
    await db.recordConsent(phone, 'data_processing', true, CONSENT_VERSION);
    await db.recordConsent(phone, 'ai_responses', false, CONSENT_VERSION);
    const mock = mockOpenAiClient('SHOULD NEVER BE RETURNED');

    const start = await request(app)
      .post('/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'journal' });
    expect(start.status).toBe(200);
    expect(start.body.context).toBe('journaling');
    expect(start.body.response).toMatch(/how are you feeling emotionally today/i);

    const moodTurn = await request(app)
      .post('/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: '7' });
    expect(moodTurn.status).toBe(200);
    expect(moodTurn.body.context).toBe('journaling');

    expect(mock.callCount).toBe(0);
  });

  it('a critical danger sign still escalates even for a fully consented+AI user, without calling the chokepoint', async () => {
    const app = createApp();
    const { token, phone } = await loginAndGetToken(app, freshPhone());
    await db.recordConsent(phone, 'data_processing', true, CONSENT_VERSION);
    await db.recordConsent(phone, 'ai_responses', true, CONSENT_VERSION);
    const mock = mockOpenAiClient('SHOULD NEVER BE RETURNED');

    const res = await request(app)
      .post('/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'I am bleeding heavily' });

    expect(res.body.urgencyLevel).toBe('critical');
    expect(res.body.response).toMatch(/URGENT/i);
    expect(mock.callCount).toBe(0);
  });
});

describe('POST /chat — audit wiring', () => {
  it('an AI-used /chat call writes an ai_call audit row visible via listAuditForUser', async () => {
    const app = createApp();
    const { token, phone } = await loginAndGetToken(app, freshPhone());
    await seedOnboardedProfile(phone);
    await db.recordConsent(phone, 'data_processing', true, CONSENT_VERSION);
    await db.recordConsent(phone, 'ai_responses', true, CONSENT_VERSION);
    mockOpenAiClient('mocked reply for audit test');

    await request(app)
      .post('/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'hello!' });

    const events = await db.listAuditForUser(phone);
    expect(events.some((e: { action: string; resource: string; resource_owner: string }) =>
      e.action === 'ai_call' && e.resource === 'conversation' && e.resource_owner === phone
    )).toBe(true);
  });

  it('a critical escalation writes a danger_escalation audit row (actor "system")', async () => {
    const app = createApp();
    const { token, phone } = await loginAndGetToken(app, freshPhone());

    await request(app)
      .post('/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'I have heavy bleeding' });

    const events = await db.listAuditForUser(phone);
    expect(events.some((e: { action: string; actor: string }) => e.action === 'danger_escalation' && e.actor === 'system')).toBe(true);
  });
});
