// Prod, 2026-10-21: a 19-year-old ("Breezy") signed up in the app with
// AI replies left unticked, then on WhatsApp asked for help with symptoms
// twice and got the name and age questions back; asked "Why are you asking
// all this information?" and got the location question again; had her
// "Nope😁 Mtanitafuta" ("no, you will look for me") saved as her location;
// and got "AI-powered replies are turned off" for loose teeth, until she
// found the toggle in the app herself. This replays her conversation.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs');

process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';
process.env.LLM_TRIAGE_RAISE = '0';

const db = require('../apps/server/src/database');
const { processMessage } = require('../apps/server/src/messageHandler');
const {
  CONSENT_VERSION,
  isLocationRefusal,
  isWhyAskQuestion,
  asksForHelp,
  parseCommand,
} = require('@amaaii/core');
const { __setClient, __resetClient } = require('@amaaii/adapters');

let replies = 0;
let lastReplyText = '';

beforeAll(async () => {
  await db.initializeDatabase();
});

beforeEach(() => {
  replies = 0;
  lastReplyText = '';
  const create = async (req: { messages: { role: string; content: string }[] }) => {
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    let content = '{}';
    if (!system.includes('STRICT JSON') && !system.includes('Return JSON') && !system.includes('pull out profile facts')) {
      replies += 1;
      lastReplyText = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      content = 'Pregnancy hormones can make gums feel loose.';
    }
    return {
      id: 'x', object: 'chat.completion', created: 0, model: 'stub',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null }, logprobs: null }],
    };
  };
  __setClient({ chat: { completions: { create } } } as never);
});

afterEach(() => __resetClient());

let n = 0;
/** Signed up in the app: data consent ticked, AI replies left unticked. */
async function appSignup(ai = false): Promise<string> {
  n += 1;
  const p = `whatsapp:+2547250${String(n).padStart(5, '0')}`;
  await db.createUser(p, {});
  await db.recordConsent(p, 'data_processing', true, CONSENT_VERSION);
  await db.recordConsent(p, 'ai_responses', ai, CONSENT_VERSION);
  return p;
}
const say = (p: string, msg: string) => processMessage(p, msg, null, { channel: 'whatsapp' });
const HELP = 'So I’m going through some symptoms and would like some advice';

describe('detectors (core)', () => {
  it.each(['Nope😁\nMtanitafuta', 'No', 'nope', "I'd rather not say", 'Sitaki kusema', 'Skip', 'Ruka', 'ni siri', 'Hapana 😅'])(
    '"%s" declines the location', (m) => expect(isLocationRefusal(m)).toBe(true));
  it.each(['Kisumu', 'Homa Bay', 'Naishi Kibera', 'Nakuru town'])('"%s" is a place', (m) => expect(isLocationRefusal(m)).toBe(false));

  it.each(['Why are you asking all this information?', 'why do you need my age', 'What is this for?', 'Kwa nini unaniuliza haya yote?'])(
    '"%s" asks why we ask', (m) => expect(isWhyAskQuestion(m)).toBe(true));
  it.each(['why is my back hurting?', 'Why do I need to rest?', 'kwa nini mtoto hachezi?'])(
    '"%s" is about her, not us', (m) => expect(isWhyAskQuestion(m)).toBe(false));

  it.each([HELP, 'My teeth feel lose and I need help', 'nina maumivu ya tumbo', 'I feel sick'])(
    '"%s" asks for help', (m) => expect(asksForHelp(m)).toBe(true));
  it.each(['Breezy', '19', '22 weeks', 'Kisumu'])('"%s" does not', (m) => expect(asksForHelp(m)).toBe(false));

  it('"Turn on AI replies" is a command', () => {
    expect(parseCommand('Turn on AI replies')).toBe('ai_on');
    expect(parseCommand('Washa majibu ya AI')).toBe('ai_on');
  });
});

describe("Breezy's conversation, replayed", () => {
  it('asks for help, asks why, declines her location, turns AI on from WhatsApp', async () => {
    const p = await appSignup();
    await say(p, 'Hi');

    const help1 = await say(p, HELP);
    expect(help1.response).toMatch(/^I'm sorry you're not feeling well/);
    expect(help1.response).toMatch(/go to the nearest health facility now/);
    expect(help1.response).toMatch(/Sorry, I didn't catch your name/);
    expect(help1.response).not.toMatch(/I'm Amaaii, your pregnancy companion/);

    await say(p, 'Breezy');
    const help2 = await say(p, HELP);
    expect(help2.response).toMatch(/^I'm sorry you're not feeling well[\s\S]*How old are you/);

    await say(p, '19');
    await say(p, 'I’m not sure');
    const weekDone = await say(p, '22 weeks');
    expect(weekDone.response).toMatch(/You can also tap \*Skip\*/);
    expect(weekDone.buttons?.options).toEqual(['Skip']);

    const why = await say(p, 'Why are you asking all this information?');
    expect(why.response).toMatch(/^Fair question 💚 I ask your name, age and how far along you are/);
    expect(why.response).toMatch(/Which town or area do you live in\?[\s\S]*tap \*Skip\*/);
    expect(why.buttons?.options).toEqual(['Skip']);
    expect(replies).toBe(0);

    const nope = await say(p, 'Nope😁\nMtanitafuta');
    expect(nope.response).toMatch(/^No problem, you don't have to share where you live\. 💚 We will never come looking for you/);
    expect(nope.response).toMatch(/Location: not shared/);
    expect(nope.response).toMatch(/AI replies are off/);
    expect(nope.buttons?.options).toEqual(['Start journal', 'Help', 'Turn on AI replies']);
    expect(await db.getUser(p)).toMatchObject({ location: null, location_declined: 1 });

    await say(p, 'Start journal');
    const teeth = await say(p, `${HELP}\nMy teeth feel lose`);
    expect(teeth.response).toMatch(/^I can't write you a personal answer, because AI replies are turned off/);
    expect(teeth.response).toMatch(/Your check-in is paused/);
    expect(teeth.buttons?.options[0]).toBe('Turn on AI replies');
    expect(replies).toBe(0);

    const on = await say(p, 'Turn on AI replies');
    expect(on.response).toMatch(/^✅ AI replies are on\.[\s\S]*Pregnancy hormones can make gums feel loose\./);
    expect(lastReplyText).toMatch(/My teeth feel lose/);
    expect(on.response).toMatch(/Your check-in is paused/);
    const audit = await db.listAuditForUser(p);
    expect(audit.some((e: { action: string; metadata: string | null }) =>
      e.action === 'consent_grant' && (e.metadata ?? '').includes('chat_button'))).toBe(true);

    expect((await say(p, 'Resume check-in')).response).toMatch(/^Welcome back!/);
  });

  it('with AI replies on, help asked for during signup is answered by the AI first', async () => {
    const p = await appSignup(true);
    await say(p, 'Hi');
    const r = await say(p, HELP);
    expect(replies).toBe(1);
    expect(r.response).toMatch(/^Pregnancy hormones can make gums feel loose\.[\s\S]*Sorry, I didn't catch your name/);
  });

  it('"Turn on AI replies" with nothing waiting asks what she wants to know; when already on, says so', async () => {
    const p = await appSignup();
    await db.updateUser(p, { name: 'Breezy', age: 19, pregnancy_week: 22, location_declined: 1 });
    expect((await say(p, 'Turn on AI replies')).response).toMatch(/^✅ AI replies are on\..*What would you like to ask\?/);
    expect((await say(p, 'Turn on AI replies')).response).toMatch(/^AI replies are already on/);
  });

  it('Kiswahili: a refusal and the Skip button', async () => {
    const p = await appSignup(true);
    await db.updateUser(p, { name: 'Wanjiru', age: 24, pregnancy_week: 20, language: 'sw' });
    await db.saveConversation(p, '20', 'Vizuri! Una wiki 20 za ujauzito. 🤰\n\nUko wapi? (Hii itanisaidia kukupendekeza vituo vya afya vya karibu inapohitajika. Unaweza pia kubonyeza *Ruka*.)', { context: 'onboarding' });
    const r = await say(p, 'Ruka');
    expect(r.response).toMatch(/^Hakuna shida, si lazima useme unakoishi/);
    expect((await db.getUser(p)).location_declined).toBe(1);
  });
});
