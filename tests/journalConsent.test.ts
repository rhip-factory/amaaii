// Declining the optional ai_responses consent must mean the model never
// sees her words — including the journal's LLM fallbacks for answers the
// regex can't read (mood/sleep/movement/water/appetite).
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs');

process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';

const db = require('../apps/server/src/database');
const { processMessage } = require('../apps/server/src/messageHandler');
const { CONSENT_VERSION } = require('@amaaii/core');
const { __setClient, __resetClient } = require('@amaaii/adapters');

let calls = 0;

beforeAll(async () => {
  await db.initializeDatabase();
});

afterEach(() => __resetClient());

function stub(): void {
  calls = 0;
  const create = async () => {
    calls += 1;
    return {
      id: 'x', object: 'chat.completion', created: 0, model: 'stub',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"mood": 6}', refusal: null }, logprobs: null }],
    };
  };
  __setClient({ chat: { completions: { create } } } as never);
}

async function seeded(phone: string, ai: boolean): Promise<void> {
  await db.createUser(phone, { name: 'Halima' });
  await db.updateUser(phone, { age: 27, pregnancy_week: 22, location: 'Mombasa' });
  await db.recordConsent(phone, 'data_processing', true, CONSENT_VERSION);
  await db.recordConsent(phone, 'ai_responses', ai, CONSENT_VERSION);
}

describe('journal LLM fallbacks respect ai_responses consent', () => {
  it('AI declined: an unreadable mood answer never reaches the model', async () => {
    const phone = 'whatsapp:+254744000001';
    await seeded(phone, false);
    stub();
    await processMessage(phone, 'journal', null);
    const r = await processMessage(phone, 'meh', null);
    expect(calls).toBe(0);
    expect(r.response).toMatch(/rate your mood/i);
  });

  it('AI granted: the same answer uses the extraction fallback', async () => {
    const phone = 'whatsapp:+254744000002';
    await seeded(phone, true);
    stub();
    await processMessage(phone, 'journal', null);
    await processMessage(phone, 'meh', null);
    expect(calls).toBeGreaterThan(0);
  });
});
