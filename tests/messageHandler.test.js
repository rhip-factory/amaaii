import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';

// Application modules are CommonJS. vitest's `await import` returns an
// ESM-wrapper namespace whose closure-scoped state is a separate instance
// from the one Node's CJS `require` chain sees. We use createRequire here
// so the test, services/database, services/twilio, and utils/messageHandler
// share the same singleton state.
const require = createRequire(import.meta.url);
// Registers Node module hooks so this native `require()` can load
// TypeScript sources (apps/server/src/*.ts, packages/*/src/*.ts)
// directly, same as `tsx` does for `pnpm start`/`pnpm dev`.
require('tsx/cjs');

// Set env BEFORE the application modules load — apps/server/src/database
// reads DB_PATH at module top-level, and apps/server/src/amaaii
// constructs an OpenAI client at import time (via the LLM chokepoint).
process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';

const db = require('../apps/server/src/database');
const tw = require('../packages/adapters/src/twilio');
const { handleIncomingMessage } = require('../apps/server/src/messageHandler');

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

// P3-B: consent now precedes profile onboarding for every un-onboarded
// WhatsApp user (see messageHandler.ts's consent-gate block). These
// tests used to assert the FIRST turn gets the name prompt directly;
// that behavior legitimately changed by design (data_processing consent
// is now REQUIRED before onboarding, or anything else, proceeds) — see
// tests/consentGate.test.ts for the dedicated new-behavior coverage.
// Updated here to grant consent first, preserving each test's original
// intent (onboarding/profile-capture precedence over free-text replies,
// and danger copy still surfacing) rather than weakening it.
describe('routing — onboarding precedence', () => {
  it('new user sending a moderate-symptom message gets the consent prompt, not a moderate-only response', async () => {
    const phone = nextPhone();
    const reply = await deliver(phone, 'I have a headache');
    expect(reply).toMatch(/reply \*i agree\*/i);
  });

  it('new user sending "Hi" gets the consent prompt, not the name prompt', async () => {
    const phone = nextPhone();
    const reply = await deliver(phone, 'Hi');
    expect(reply).toMatch(/reply \*i agree\*/i);
    expect(reply).not.toMatch(/what'?s your name/i);
  });

  it('CRITICAL urgency still short-circuits to escalation for a new user (bypasses consent too — vital interests)', async () => {
    const phone = nextPhone();
    const reply = await deliver(phone, 'I am bleeding heavily');
    expect(reply).toMatch(/URGENT/i);
    expect(reply).not.toMatch(/what'?s your name/i);
    expect(reply).not.toMatch(/reply \*i agree\*/i);
  });

  it('HIGH urgency from a new user still gets the consent prompt (escalation copy also appears)', async () => {
    const phone = nextPhone();
    const reply = await deliver(phone, 'I have a severe headache');
    expect(reply).toMatch(/Important/i);
    expect(reply).toMatch(/reply \*i agree\*/i);
  });

  it('once consent is granted ("I AGREE"), the very same turn moves on to the name prompt', async () => {
    const phone = nextPhone();
    await deliver(phone, 'Hi');
    const grantReply = await deliver(phone, 'I AGREE');
    expect(grantReply).toMatch(/what'?s your name/i);
  });
});

describe('onboarding — name persistence (after granting consent)', () => {
  it("persists the user's first reply as their name", async () => {
    const phone = nextPhone();
    await deliver(phone, 'Hi');
    await deliver(phone, 'I AGREE'); // consent gate -> falls straight into the name prompt
    await deliver(phone, 'Grace');
    const user = await db.getUser(phone);
    expect(user.name).toBe('Grace');
  });

  it('then captures age, then pregnancy week (with EDD)', async () => {
    const phone = nextPhone();
    await deliver(phone, 'Hi');
    await deliver(phone, 'I AGREE');
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
