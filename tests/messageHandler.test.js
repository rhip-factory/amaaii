import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';

// Application modules are CommonJS. vitest's `await import` returns an
// ESM-wrapper namespace whose closure-scoped state is a separate instance
// from the one Node's CJS `require` chain sees. We use createRequire here
// so the test, services/database, services/twilio, and utils/messageHandler
// share the same singleton state.
const require = createRequire(import.meta.url);

// Set env BEFORE the application modules load — services/database reads
// DB_PATH at module top-level, and services/amaaii constructs an OpenAI
// client at import time.
process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';

const db = require('../services/database');
const tw = require('../services/twilio');
const { handleIncomingMessage } = require('../utils/messageHandler');

const sent = [];

beforeAll(async () => {
  await db.initializeDatabase();
  tw.__setSendImpl(async (to, message) => {
    sent.push({ to, message });
    return { sid: 'mocked' };
  });
});

afterAll(() => {
  tw.__resetSendImpl();
  vi.useRealTimers();
});

beforeEach(() => {
  sent.length = 0;
  // Fake timers prevent the in-process 1-hour follow-up setTimeout from
  // keeping vitest alive after CRITICAL/HIGH urgency tests.
  vi.useFakeTimers();
});

let phoneCounter = 1000;
function nextPhone() {
  phoneCounter += 1;
  return `whatsapp:+254700000${phoneCounter}`;
}

async function deliver(phone, message, profileName = null) {
  const before = sent.length;
  await handleIncomingMessage(phone, message, profileName);
  return sent.slice(before).map((s) => s.message).join('\n');
}

describe('routing — onboarding precedence', () => {
  it('new user sending a moderate-symptom message gets the name prompt, not a moderate response', async () => {
    const phone = nextPhone();
    const reply = await deliver(phone, 'I have a headache');
    expect(reply).toMatch(/what'?s your name/i);
  });

  it('new user sending "Hi" gets the name prompt', async () => {
    const phone = nextPhone();
    const reply = await deliver(phone, 'Hi');
    expect(reply).toMatch(/what'?s your name/i);
  });

  it('CRITICAL urgency still short-circuits to escalation for a new user', async () => {
    const phone = nextPhone();
    const reply = await deliver(phone, 'I am bleeding heavily');
    expect(reply).toMatch(/URGENT/i);
    expect(reply).not.toMatch(/what'?s your name/i);
  });

  it('HIGH urgency from a new user still asks for name (escalation may also appear)', async () => {
    const phone = nextPhone();
    const reply = await deliver(phone, 'I have a severe headache');
    expect(reply).toMatch(/what'?s your name/i);
  });
});

describe('onboarding — name persistence', () => {
  it("persists the user's first reply as their name", async () => {
    const phone = nextPhone();
    await deliver(phone, 'Hi');
    await deliver(phone, 'Grace');
    const user = await db.getUser(phone);
    expect(user.name).toBe('Grace');
  });

  it('then captures age, then pregnancy week (with EDD)', async () => {
    const phone = nextPhone();
    await deliver(phone, 'Hi');
    await deliver(phone, 'Grace');
    const ageReply = await deliver(phone, '26');
    expect(ageReply).toMatch(/weeks?/i);
    let user = await db.getUser(phone);
    expect(user.age).toBe(26);

    await deliver(phone, '20 weeks');
    user = await db.getUser(phone);
    expect(user.pregnancy_week).toBe(20);
    expect(user.edd).toBeTruthy();
  });
});

describe('onboarded user — danger sign still escalates', () => {
  it('CRITICAL escalation fires for fully-onboarded users', async () => {
    const phone = nextPhone();
    await db.createUser(phone, { name: 'Grace' });
    await db.updateUser(phone, {
      age: 26,
      pregnancy_week: 20,
      location: 'Nairobi',
    });
    const reply = await deliver(phone, 'I am bleeding heavily');
    expect(reply).toMatch(/URGENT/i);
  });
});
