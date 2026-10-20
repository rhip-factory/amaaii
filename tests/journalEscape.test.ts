// The 2026-10 mother simulation's "journal trap": substring commands
// opened check-ins nobody asked for, sessions never expired or cancelled,
// danger signs mid-journal were swallowed (urgency forced to 'low', no
// follow-up, no audit), and a WhatsApp check-in captured PWA messages.
// Also covers the raise-only AI triage (messageHandler.ts#llmTriageRaise).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs');

process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';

const db = require('../apps/server/src/database');
const { processMessage } = require('../apps/server/src/messageHandler');
const { CONSENT_VERSION } = require('@amaaii/core');
const { __setClient, __resetClient } = require('@amaaii/adapters');

// Stub model: the triage prompt gets `triage`, extraction prompts get an
// empty JSON object, everything else (the AI reply) gets `reply`.
let triage = '{"urgency":"low","reason":"ok"}';
let reply = 'Here is some friendly advice.';
let triageCalls = 0;
function installStub(): void {
  const create = async (req: { messages: { role: string; content: string }[] }) => {
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    let content = reply;
    if (system.includes('triage nurse')) {
      triageCalls += 1;
      content = triage;
    } else if (system.includes('STRICT JSON') || system.includes('Return JSON')) {
      content = '{}';
    }
    return {
      id: 'x', object: 'chat.completion', created: 0, model: 'stub',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null }, logprobs: null }],
    };
  };
  __setClient({ chat: { completions: { create } } } as never);
}

beforeAll(async () => {
  await db.initializeDatabase();
});

beforeEach(() => {
  triage = '{"urgency":"low","reason":"ok"}';
  reply = 'Here is some friendly advice.';
  triageCalls = 0;
  delete process.env.LLM_TRIAGE_RAISE;
  delete process.env.LLM_TRIAGE_MAX;
  installStub();
});

afterEach(() => {
  __resetClient();
});

let n = 0;
async function onboardedPhone(): Promise<string> {
  n += 1;
  const phone = `whatsapp:+2547110${String(n).padStart(5, '0')}`;
  await db.createUser(phone, { name: 'Faith' });
  await db.updateUser(phone, { age: 23, pregnancy_week: 24, location: 'Kisumu' });
  await db.recordConsent(phone, 'data_processing', true, CONSENT_VERSION);
  await db.recordConsent(phone, 'ai_responses', true, CONSENT_VERSION);
  return phone;
}

async function say(phone: string, msg: string, channel: 'whatsapp' | 'web' = 'whatsapp') {
  return processMessage(phone, msg, null, { channel });
}

describe('journal commands are whole-message only', () => {
  it('"I\'ll recheck in an hour" does not open a check-in', async () => {
    const phone = await onboardedPhone();
    const r = await say(phone, "I'll recheck in an hour");
    expect(r.context).not.toBe('journaling');
    expect(await db.getJournalSession(phone)).toBeNull();
  });

  it('"what is journal?" is answered, not turned into a check-in', async () => {
    const phone = await onboardedPhone();
    const r = await say(phone, 'what is journal?');
    expect(r.context).not.toBe('journaling');
  });

  it('"journal summary" shows the summary instead of starting a journal', async () => {
    const phone = await onboardedPhone();
    const r = await say(phone, 'journal summary');
    expect(r.context).toBe('journal_summary');
    expect(r.response).toMatch(/check-in today/i);
    expect(await db.getJournalSession(phone)).toBeNull();
  });
});

describe('getting out of a check-in', () => {
  it('"stop" ends the check-in', async () => {
    const phone = await onboardedPhone();
    await say(phone, 'journal');
    const r = await say(phone, 'stop');
    expect(r.response).toMatch(/stopped the check-in/i);
    expect(await db.getJournalSession(phone)).toBeNull();
  });

  it('a question mid-check-in is answered and the check-in pauses', async () => {
    const phone = await onboardedPhone();
    await say(phone, 'journal');
    const r = await say(phone, 'how do I get the app on my phone?');
    expect(r.context).not.toBe('journaling');
    expect(r.response).toMatch(/Here is some friendly advice/);
    expect(r.response).toMatch(/paused your daily check-in/i);
    expect(await db.getJournalSession(phone)).toBeNull();
  });

  it('two unclear mood answers skip the rating instead of looping', async () => {
    const phone = await onboardedPhone();
    await say(phone, 'journal');
    const first = await say(phone, 'eh');
    expect(first.response).toMatch(/rate your mood/i);
    const second = await say(phone, 'hmm');
    expect(second.response).toMatch(/skip the mood rating/i);
    expect((await db.getJournalSession(phone)).currentStage).toBe('symptoms');
  });

  it('a stale session (untouched for over 6 hours) no longer captures messages', async () => {
    const phone = await onboardedPhone();
    await say(phone, 'journal');
    // SQLite stamped updated_at with the real clock; move JS time 7h on.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 7 * 60 * 60 * 1000));
    try {
      const r = await say(phone, 'Is it okay to eat eggs every day?');
      expect(r.context).not.toBe('journaling');
      expect(await db.getJournalSession(phone)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a WhatsApp check-in does not swallow a web chat message', async () => {
    const phone = await onboardedPhone();
    await say(phone, 'journal', 'whatsapp');
    const r = await say(phone, '7', 'web');
    expect(r.context).not.toBe('journaling');
    // The WhatsApp session is left alone for WhatsApp to finish.
    expect((await db.getJournalSession(phone)).currentStage).toBe('mood');
  });
});

describe('danger signs interrupt a check-in', () => {
  it('CRITICAL at the mood stage escalates with real urgency, audits, and ends the session', async () => {
    const phone = await onboardedPhone();
    await say(phone, 'journal');
    const r = await say(phone, 'I am bleeding heavily and soaked two pads');
    expect(r.urgencyLevel).toBe('critical');
    expect(r.response).toMatch(/URGENT/);
    expect(r.response).toMatch(/pause the journal/i);
    expect(await db.getJournalSession(phone)).toBeNull();
    const audit = await db.listAuditForUser(phone);
    expect(audit.some((e: { action: string }) => e.action === 'danger_escalation')).toBe(true);
  });

  it('HIGH at the water stage escalates too', async () => {
    const phone = await onboardedPhone();
    await say(phone, 'journal');
    await db.upsertJournalSession(phone, { currentStage: 'water', journalData: {}, journalId: null });
    const r = await say(phone, 'nina homa ya 38.5 tangu jana');
    expect(r.urgencyLevel).toBe('high');
    expect(await db.getJournalSession(phone)).toBeNull();
  });

  it('a repeat escalation in the same episode gets the shorter copy, still HIGH', async () => {
    const phone = await onboardedPhone();
    const first = await say(phone, 'I have a fever since morning');
    expect(first.response).toMatch(/checked by a healthcare provider TODAY/);
    const second = await say(phone, 'the fever is still there and I feel weak');
    expect(second.urgencyLevel).toBe('high');
    expect(second.response).toMatch(/Have you been able to reach a clinic/);
  });

  it('a denied symptom no longer escalates', async () => {
    const phone = await onboardedPhone();
    const r = await say(phone, 'Feeling okay today, no bleeding and no headache. What exercise is safe?');
    expect(r.urgencyLevel).toBe('low');
  });
});

describe('raise-only AI triage', () => {
  it('raises a rules-missed emergency to HIGH, prepends escalation copy and audits it', async () => {
    const phone = await onboardedPhone();
    triage = '{"urgency":"critical","reason":"possible preterm labour"}';
    const r = await say(phone, 'my tummy keeps going tight and hard every few minutes since lunch');
    // Capped at HIGH by default.
    expect(r.urgencyLevel).toBe('high');
    expect(r.response).toMatch(/checked by a healthcare provider TODAY/);
    const audit = await db.listAuditForUser(phone);
    const raised = audit.filter((e: { action: string; metadata: string }) => e.action === 'danger_escalation' && JSON.parse(e.metadata).source === 'llm_raise');
    expect(raised.length).toBe(1);
  });

  it('does not repeat the escalation copy when the AI reply already says go today', async () => {
    const phone = await onboardedPhone();
    triage = '{"urgency":"high","reason":"possible labour"}';
    reply = 'Please go to the clinic today so they can check you.';
    const r = await say(phone, 'my tummy keeps going tight and hard every few minutes since lunch');
    expect(r.urgencyLevel).toBe('high');
    expect(r.response).not.toMatch(/checked by a healthcare provider TODAY/);
  });

  it('LLM_TRIAGE_MAX=critical allows a CRITICAL raise', async () => {
    process.env.LLM_TRIAGE_MAX = 'critical';
    const phone = await onboardedPhone();
    triage = '{"urgency":"critical","reason":"x"}';
    const r = await say(phone, 'something feels very wrong with me since this morning');
    expect(r.urgencyLevel).toBe('critical');
  });

  it('never lowers what the rules decided', async () => {
    const phone = await onboardedPhone();
    triage = '{"urgency":"low","reason":"x"}';
    const r = await say(phone, 'I have a terrible headache that will not go away');
    expect(r.urgencyLevel).toBe('high');
    expect(triageCalls).toBe(0);
  });

  it('a low/moderate model answer changes nothing', async () => {
    const phone = await onboardedPhone();
    triage = '{"urgency":"moderate","reason":"x"}';
    const r = await say(phone, 'what fruits are good to eat at 24 weeks');
    expect(r.urgencyLevel).toBe('low');
  });

  it('a garbage model answer fails safe (no raise)', async () => {
    const phone = await onboardedPhone();
    triage = 'I think she should be fine';
    const r = await say(phone, 'what fruits are good to eat at 24 weeks');
    expect(r.urgencyLevel).toBe('low');
  });

  it('LLM_TRIAGE_RAISE=0 turns it off', async () => {
    process.env.LLM_TRIAGE_RAISE = '0';
    const phone = await onboardedPhone();
    triage = '{"urgency":"high","reason":"x"}';
    const r = await say(phone, 'my tummy keeps going tight and hard every few minutes since lunch');
    expect(r.urgencyLevel).toBe('low');
    expect(triageCalls).toBe(0);
  });

  it('does not run without the optional ai_responses consent', async () => {
    const phone = await onboardedPhone();
    await db.recordConsent(phone, 'ai_responses', false, CONSENT_VERSION);
    triage = '{"urgency":"high","reason":"x"}';
    const r = await say(phone, 'my tummy keeps going tight and hard every few minutes since lunch');
    expect(r.urgencyLevel).toBe('low');
    expect(triageCalls).toBe(0);
  });

  it('short messages are not sent for triage', async () => {
    const phone = await onboardedPhone();
    triage = '{"urgency":"high","reason":"x"}';
    await say(phone, 'thanks');
    expect(triageCalls).toBe(0);
  });
});
