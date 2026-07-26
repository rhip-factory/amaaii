// P3-B: WhatsApp-channel consent-gate tests, mirroring
// tests/messageHandler.test.js's style (handleIncomingMessage +
// twilio.__setSendImpl seam). Covers the stateless consent-gate flow
// (packages/core/src/i18n.ts's consent_request/consent_reprompt/
// consent_thanks + messageHandler.ts's handleConsentGate): a brand-new
// phone is asked for consent BEFORE profile onboarding, "I AGREE"
// records BOTH purposes (WhatsApp channel decision — see
// handleConsentGate's comment), a negative/unrecognized reply
// re-prompts instead of silently advancing, and danger signs still
// escalate throughout.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs');

process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';

const db = require('../apps/server/src/database');
const tw = require('../packages/adapters/src/twilio');
const { handleIncomingMessage } = require('../apps/server/src/messageHandler');
const { CONSENT_VERSION, deriveConsentState, hasActiveConsent } = require('@amaaii/core');

const sent: { to: string; message: string }[] = [];

beforeAll(async () => {
  await db.initializeDatabase();
  tw.__setSendImpl(async (to: string, message: string) => {
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
  vi.useFakeTimers();
});

let phoneCounter = 5000;
function nextPhone(): string {
  phoneCounter += 1;
  return `whatsapp:+254700005${phoneCounter}`;
}

async function deliver(phone: string, message: string, profileName: string | null = null): Promise<string> {
  const before = sent.length;
  await handleIncomingMessage(phone, message, profileName);
  return sent.slice(before).map((s) => s.message).join('\n');
}

describe('WhatsApp consent gate — new user precedence', () => {
  it('a brand-new phone gets the consent prompt, not the name prompt', async () => {
    const phone = nextPhone();
    const reply = await deliver(phone, 'Hi');
    expect(reply).toMatch(/reply \*i agree\*/i);
    expect(reply).not.toMatch(/what'?s your name/i);

    const state = deriveConsentState(await db.getConsents(phone));
    expect(hasActiveConsent(state, 'data_processing')).toBe(false);
  });

  it('"I AGREE" records BOTH purposes (WhatsApp channel default) and moves straight into the name prompt', async () => {
    const phone = nextPhone();
    await deliver(phone, 'Hi');
    const reply = await deliver(phone, 'I AGREE');

    expect(reply).toMatch(/what'?s your name/i);

    const state = deriveConsentState(await db.getConsents(phone));
    expect(hasActiveConsent(state, 'data_processing')).toBe(true);
    expect(hasActiveConsent(state, 'ai_responses')).toBe(true);
  });

  it('case-insensitive / bare "agree" also counts', async () => {
    const phone = nextPhone();
    await deliver(phone, 'Hi');
    const reply = await deliver(phone, 'agree');
    expect(reply).toMatch(/what'?s your name/i);
  });

  it('Kiswahili "NAKUBALI" also grants consent', async () => {
    const phone = nextPhone();
    await deliver(phone, 'Hi');
    const reply = await deliver(phone, 'NAKUBALI');
    expect(reply).toMatch(/what'?s your name/i);
    const state = deriveConsentState(await db.getConsents(phone));
    expect(hasActiveConsent(state, 'data_processing')).toBe(true);
  });

  it('a negative/unrecognized reply re-prompts with clearer instructions instead of proceeding to onboarding', async () => {
    const phone = nextPhone();
    await deliver(phone, 'Hi');
    const reply = await deliver(phone, 'why do you need that?');
    expect(reply).toMatch(/please reply with the word \*agree\*/i);
    expect(reply).not.toMatch(/what'?s your name/i);

    const state = deriveConsentState(await db.getConsents(phone));
    expect(hasActiveConsent(state, 'data_processing')).toBe(false);
  });

  it('repeated non-affirmative replies never advance to onboarding (no silent proceed)', async () => {
    const phone = nextPhone();
    await deliver(phone, 'Hi');
    await deliver(phone, 'no thanks');
    const third = await deliver(phone, 'still not sure');
    expect(third).toMatch(/please reply with the word \*agree\*/i);
    expect(third).not.toMatch(/what'?s your name/i);
  });
});

describe('WhatsApp consent gate — danger signs still escalate pre-consent', () => {
  it('CRITICAL escalates immediately for a brand-new, never-prompted phone (bypasses the consent gate)', async () => {
    const phone = nextPhone();
    const reply = await deliver(phone, 'I am bleeding heavily');
    expect(reply).toMatch(/URGENT/i);
    expect(reply).not.toMatch(/reply \*i agree\*/i);
  });

  it('HIGH urgency during the pre-consent phase still carries the escalation copy alongside the consent prompt', async () => {
    const phone = nextPhone();
    const reply = await deliver(phone, 'I have a severe headache');
    expect(reply).toMatch(/checked by a healthcare provider TODAY/i);
    expect(reply).toMatch(/reply \*i agree\*/i);
  });

  it('a danger sign mentioned while replying to the re-prompt still escalates', async () => {
    const phone = nextPhone();
    await deliver(phone, 'Hi');
    await deliver(phone, 'not sure'); // -> reprompt
    const reply = await deliver(phone, 'I have a severe headache and no I do not agree yet');
    expect(reply).toMatch(/checked by a healthcare provider TODAY/i);
  });
});

describe('WhatsApp consent gate — audit trail', () => {
  it('a WhatsApp grant writes two consent_grant audit rows tagged channel: whatsapp', async () => {
    const phone = nextPhone();
    await deliver(phone, 'Hi');
    await deliver(phone, 'I AGREE');

    const events = await db.listAuditForUser(phone);
    const grants = events.filter((e: { action: string }) => e.action === 'consent_grant');
    expect(grants.length).toBe(2);
    for (const g of grants) {
      const metadata = JSON.parse(g.metadata);
      expect(metadata.channel).toBe('whatsapp');
      expect(metadata.granted).toBe(true);
    }
    const purposes = grants.map((g: { metadata: string }) => JSON.parse(g.metadata).purpose).sort();
    expect(purposes).toEqual(['ai_responses', 'data_processing']);
  });
});

describe('WhatsApp consent gate — returning/migrated users', () => {
  it('an already-onboarded user with no consent history is asked to consent before normal chat resumes', async () => {
    const phone = nextPhone();
    await db.createUser(phone, { name: 'Amina' });
    await db.updateUser(phone, { age: 29, pregnancy_week: 15, location: 'Kisumu' });

    const reply = await deliver(phone, 'How is my baby doing?');
    expect(reply).toMatch(/reply \*i agree\*/i);
  });

  it('once that returning user grants consent, the confirmation appears and CONSENT_VERSION is recorded (not a name-prompt regression, since they are already onboarded)', async () => {
    const phone = nextPhone();
    await db.createUser(phone, { name: 'Amina' });
    await db.updateUser(phone, { age: 29, pregnancy_week: 15, location: 'Kisumu' });

    await deliver(phone, 'How is my baby doing?');
    const grantReply = await deliver(phone, 'I AGREE');
    expect(grantReply).not.toMatch(/what'?s your name/i);

    const state = deriveConsentState(await db.getConsents(phone));
    expect(hasActiveConsent(state, 'data_processing')).toBe(true);
    const rows = await db.getConsents(phone);
    expect(rows.every((r: { version: number }) => r.version === CONSENT_VERSION)).toBe(true);
  });
});
