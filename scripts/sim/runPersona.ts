// One simulated mother x one Amaaii arm, months of WhatsApp chat on a
// fast-forwarded clock. Usage:
//   tsx scripts/sim/runPersona.ts <personaId> <arm H|S> <outDir> [maxBeats]
// Drives the REAL WhatsApp entry point (handleIncomingMessage) in-process
// against a scratch SQLite file; nothing is ever sent to WhatsApp.
/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
import fs from 'fs';
import path from 'path';
import { installSimClock, setSimTime, advance, simNow } from './simClock';
import { PERSONAS, Persona, Beat } from './personas';

const [personaId, arm, outDir, maxBeatsArg] = process.argv.slice(2);
const persona = PERSONAS.find((p) => p.id === personaId);
if (!persona || !['H', 'S'].includes(arm) || !outDir) {
  console.error('usage: runPersona.ts <personaId> <H|S> <outDir> [maxBeats]');
  process.exit(2);
}
const maxBeats = maxBeatsArg ? Number(maxBeatsArg) : Infinity;

// --- env: OpenRouter only, no transports, scratch DB ------------------------
require('dotenv').config({ path: process.env.SIM_ENV_FILE || '.env', quiet: true });
for (const k of Object.keys(process.env)) {
  if (/^(TWILIO_|META_|TEST_PHONE|WHATSAPP_PROVIDER|PUBLIC_BASE_URL|ALERT_WEBHOOK)/.test(k)) delete process.env[k];
}
delete process.env.OPENAI_API_KEY; // Claude via OpenRouter only — never gpt
// Production sets this, so the consent copy carries a real privacy link.
process.env.PUBLIC_BASE_URL = process.env.SIM_PUBLIC_BASE_URL || 'https://amaaii.com';
// A dedicated sim key (separate budget) wins over the production one.
const OR_KEY = process.env.SIM_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
if (!OR_KEY) throw new Error('OPENROUTER_API_KEY missing');
process.env.OPENROUTER_API_KEY = OR_KEY;
const HAIKU = 'anthropic/claude-haiku-5.5';
const SONNET = 'anthropic/claude-sonnet-5.5';
process.env.LLM_MODEL = arm === 'H' ? HAIKU : SONNET;
process.env.LLM_EXTRACT_MODEL = HAIKU;
process.env.NODE_ENV = 'development';
fs.mkdirSync(outDir, { recursive: true });
const dbPath = path.join(outDir, 'amaaii.db');
for (const f of [dbPath, dbPath + '-journal']) if (fs.existsSync(f)) fs.unlinkSync(f);
process.env.DB_PATH = dbPath;
// SIM_DRY=1: no network — scripted mother + canned LLM, to check the plumbing for free.
const DRY = process.env.SIM_DRY === '1';
const BUDGET_CAP = Number(process.env.SIM_BUDGET_CAP || 90);
const BASELINE_USAGE = Number(process.env.SIM_BASELINE_USAGE || 0);

// --- simulated time ----------------------------------------------------------
const DAY = 86400000;
const parseAt = (p: Persona, at: string): number =>
  at.startsWith('pp') ? p.deliverWeek + Number(at.slice(2)) / 7 : Number(at.slice(1));
const JOIN_GA = parseAt(persona, persona.joinAt);
const JOIN_DATE = Date.UTC(2026, 2, 2, 6, 0, 0); // 2 Mar 2026, 09:00 EAT
function trueStatus(t: number) {
  const ga = JOIN_GA + (t - JOIN_DATE) / (7 * DAY);
  if (ga >= persona!.deliverWeek) return { pregnant: false, ppDay: Math.floor((ga - persona!.deliverWeek) * 7), ga: null };
  return { pregnant: true, ga: Math.round(ga * 10) / 10, ppDay: null };
}
const statusText = (s: ReturnType<typeof trueStatus>) =>
  s.pregnant ? `${Math.floor(s.ga!)} weeks + ${Math.round((s.ga! % 1) * 7)} days pregnant` : `delivered ${s.ppDay} days ago (postpartum)`;

installSimClock();
setSimTime(JOIN_DATE);

// --- app modules (after env + clock) ----------------------------------------
const db = require('../../apps/server/src/database');
const tw = require('../../packages/adapters/src/twilio');
const llm = require('../../packages/adapters/src/llm');
const mh = require('../../apps/server/src/messageHandler');
const jw = require('../../apps/server/src/jobWorker');
const OpenAI = require('openai').default ?? require('openai');
const request = require('supertest');
const { createApp } = require('../../apps/server/src/app');
const app = createApp({ webOutDirOverride: path.join(outDir, 'no-web-out') });
let webToken = '';
const web = {
  post: (url: string, body: unknown) => request(app).post(url).set('Authorization', `Bearer ${webToken}`).set('X-Amaaii-Api', '1').send(body),
  put: (url: string, body: unknown) => request(app).put(url).set('Authorization', `Bearer ${webToken}`).set('X-Amaaii-Api', '1').send(body),
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${webToken}`).set('X-Amaaii-Api', '1'),
};

let outbox: string[] = [];
tw.__setSendImpl(async (_to: string, message: string) => {
  outbox.push(message);
  return { sid: 'sim' };
});

// Real OpenRouter client, wrapped to meter every Amaaii-side call.
interface LlmCall { model: string; max_tokens?: number; ms: number; in?: number; out?: number; cost?: number; ok: boolean; err?: string; empty?: boolean }
let turnCalls: LlmCall[] = [];
const realClient = new OpenAI({
  apiKey: OR_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: { 'HTTP-Referer': 'https://amaaii.com', 'X-Title': 'Amaaii-sim' },
});
llm.__setClient({
  chat: {
    completions: {
      create: async (body: any, opts?: any) => {
        const t0 = performance.now();
        const rec: LlmCall = { model: body.model, max_tokens: body.max_tokens, ms: 0, ok: false };
        turnCalls.push(rec);
        try {
          const res = DRY
            ? { choices: [{ message: { content: body.response_format ? '{"value":null}' : `(dry AI reply via ${body.model})` } }], usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 } }
            : await realClient.chat.completions.create({ ...body, usage: { include: true } }, opts);
          rec.ok = true;
          rec.in = res.usage?.prompt_tokens;
          rec.out = res.usage?.completion_tokens;
          rec.cost = usd((res as any).usage);
          rec.empty = !res.choices?.[0]?.message?.content;
          return res;
        } catch (e: any) {
          rec.err = String(e?.message || e).slice(0, 200);
          throw e;
        } finally {
          rec.ms = Math.round(performance.now() - t0);
        }
      },
    },
  },
});
jw.registerJobHandler(mh.CHECKIN_FOLLOWUP_JOB_TYPE, mh.sendCheckinFollowup);

// --- mother engine (Sonnet via OpenRouter) -----------------------------------
let motherCost = 0;
interface Line { t: string; who: 'me' | 'amaaii'; text: string; surface: 'whatsapp' | 'web' }
const transcript: Line[] = [];
const fmt = (d: Date) => new Date(d.getTime() + 3 * 3600000).toISOString().replace('T', ' ').slice(0, 16) + ' EAT';

const MOTHER_SYSTEM = `You are role-playing a real Kenyan woman texting a WhatsApp number called "Amaaii" (sometimes she may use the Amaaii web app's chat screen instead — the situation will say so). Stay fully in character at all times. Never mention AI, simulations, role-play or that you are an assistant.

WHO YOU ARE
Name: ${persona.name}. Age: ${persona.age}. Lives in: ${persona.location}. Languages: ${persona.languages}.
Tech literacy: ${persona.techLiteracy}.
Background: ${persona.background}
How you text: ${persona.style}

HOW TO PLAY
- Output ONLY the exact WhatsApp message she sends next. No quotes, no narration, no stage directions.
- Write like a real person on WhatsApp: usually short (1-3 sentences), natural typos for your literacy level, code-switching as you really would.
- You only know what a real person in her situation knows. Nobody explained how the bot works; you do not know any commands, menus, or app features unless the bot told you.
- React to what the bot ACTUALLY says. If it is confusing, too long, in a language you struggle with, or gets your facts wrong, react the way she would (confusion, ignoring it, correcting it, frustration) — according to her literacy and personality.
- When the bot asks you something, answer truthfully per your real facts (name, age, location, real pregnancy status for today's date), but in your own style. Don't volunteer every fact at once unless that's your style.
- ${persona.techLiteracy === 'low' ? 'You are NOT good with technology: you often misread instructions (e.g. reply "ok", "yes" or "1" instead of an exact word it asks for), miss formatting like *asterisks*, get lost in long messages, and may ask what words like "journal", "consent", "app" mean.' : 'You use WhatsApp comfortably.'}
- To send a voice note instead of text, output exactly: [VOICE NOTE]
- When she would naturally stop texting for now (got what she needed, gave up, or has to go), output exactly: [END]  (you may put [END] alone; do not add it to a normal message).`;

async function motherSays(beat: Beat, turn: number, maxTurns: number, prevBeat?: string): Promise<string> {
  const s = trueStatus(simNow().getTime());
  const line = (l: Line) => `[${l.t}] [${l.surface === 'web' ? 'APP' : 'WhatsApp'}] ${l.who === 'me' ? 'YOU' : 'AMAAII'}: ${l.text}`;
  // The PWA chat screen starts empty on every visit (it never loads past
  // conversations), so in the app she only SEES this sitting; the rest is memory.
  const recent = beat.surface === 'web'
    ? `(What you remember from earlier chats:)\n${transcript.slice(-36, episodeStart).map(line).join('\n')}\n\n(What the app chat screen shows right now:)\n${transcript.slice(episodeStart).map(line).join('\n') || '(empty chat screen)'}`
    : transcript.slice(-36).map(line).join('\n');
  const where = beat.surface === 'web' ? 'the Amaaii web app chat screen (NOT WhatsApp)' : 'WhatsApp';
  const user = `Today: ${fmt(simNow())}. Your real status today: ${statusText(s)}.
Where you are typing right now: ${where}.
Situation for this conversation: ${beat.beat}${prevBeat ? `\n(Earlier situation: ${prevBeat})` : ''}
This is message ${turn} of at most ${maxTurns} you will send in this sitting.

Chat history so far (oldest first, most recent last):
${recent || '(no messages yet — this is your very first message to this number)'}

Write her next message now (or [END]).`;
  if (DRY) {
    const script = ['hi', 'I AGREE', 'Faith', '23', '12 weeks', 'Kasarani', 'journal', '7', 'headache', '[END]'];
    return turn <= script.length ? script[(dryIdx++) % script.length] : '[END]';
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OR_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'Amaaii-sim-mother' },
        body: JSON.stringify({
          model: SONNET,
          messages: [{ role: 'system', content: MOTHER_SYSTEM }, { role: 'user', content: user }],
          max_tokens: 600,
          temperature: 0.9,
          reasoning: { effort: 'low' },
          usage: { include: true },
        }),
        signal: AbortSignal.timeout(60000),
      });
      const j: any = await r.json();
      if (r.status === 402 || r.status === 403) { console.error('FATAL budget/auth', JSON.stringify(j).slice(0, 300)); process.exit(3); }
      if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 300));
      motherCost += usd(j.usage);
      writeLedger();
      const text = String(j.choices?.[0]?.message?.content || '').trim().replace(/^"|"$/g, '');
      if (text) return text;
    } catch (e: any) {
      process.stderr.write(`mother error: ${e?.message}\n`);
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
    }
  }
  return '[END]';
}

// BYOK keys report usage.cost = 0; the provider's charge is in cost_details.
function usd(u: any): number {
  return (u?.cost || 0) + (u?.is_byok ? u?.cost_details?.upstream_inference_cost || 0 : 0);
}
// Shared spend ledger: every process writes its running total next to the
// run; the budget guard sums them (the key's own usage misses BYOK spend).
const ledgerDir = path.resolve(outDir, '..', '..', 'ledger');
fs.mkdirSync(ledgerDir, { recursive: true });
const ledgerFile = path.join(ledgerDir, `${arm}-${personaId}.json`);
function writeLedger() {
  fs.writeFileSync(ledgerFile, JSON.stringify({ amaaii: amaaiiCost, mother: motherCost }));
}
function runSpend(): number {
  let total = 0;
  for (const f of fs.readdirSync(ledgerDir)) {
    try { const j = JSON.parse(fs.readFileSync(path.join(ledgerDir, f), 'utf8')); total += (j.amaaii || 0) + (j.mother || 0); } catch { /* mid-write */ }
  }
  return total;
}
let dryIdx = 0;
let episodeStart = 0;
async function spentSoFar(): Promise<number> {
  return runSpend();
}

// --- main loop ---------------------------------------------------------------
const phone = `whatsapp:+2547${String(100000 + PERSONAS.indexOf(persona)).padStart(8, '0')}`;
const turnsFile = fs.createWriteStream(path.join(outDir, 'turns.jsonl'));
let lastConvId = 0;
let amaaiiCost = 0;
let turnNo = 0;
const rand = (() => { let s = PERSONAS.indexOf(persona) * 7919 + (arm === 'S' ? 13 : 0) + 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();

async function sendTurn(msg: string, ctx: { beatIdx: number; beat: Beat | null; kind: string }) {
  const surface = ctx.beat?.surface === 'web' ? 'web' : 'whatsapp';
  const body = msg === '[VOICE NOTE]' ? '' : msg; // Twilio delivers a voice note as an empty Body
  outbox = [];
  turnCalls = [];
  transcript.push({ t: fmt(simNow()), who: 'me', text: msg, surface });
  const t0 = performance.now();
  let reply = '';
  let webMeta: any = null;
  if (surface === 'web') {
    // The PWA can't send a voice note or an empty message; mirror its 400.
    const res = await web.post('/chat', { message: body });
    webMeta = { status: res.status, consentRequired: !!res.body?.consentRequired, urgency: res.body?.urgencyLevel, context: res.body?.context };
    reply = res.body?.response ?? res.body?.message ?? `(HTTP ${res.status} ${res.body?.error ?? ''})`;
  } else {
    await mh.handleIncomingMessage(phone, body, persona!.profileName);
    reply = outbox.join('\n---\n');
  }
  const ms = Math.round(performance.now() - t0);
  transcript.push({ t: fmt(simNow()), who: 'amaaii', text: reply || '(no reply)', surface });
  const rows = await db.getConversationHistory(phone, 1);
  const row = rows[0] && rows[0].id > lastConvId ? rows[0] : null;
  if (row) lastConvId = row.id;
  const user = await db.getUser(phone);
  const js = await db.getJournalSession(phone);
  const cost = turnCalls.reduce((a, c) => a + (c.cost || 0), 0);
  amaaiiCost += cost;
  writeLedger();
  turnNo++;
  turnsFile.write(JSON.stringify({
    persona: persona!.id, arm, turn: turnNo, kind: ctx.kind, surface, webMeta, beatIdx: ctx.beatIdx, beatAt: ctx.beat?.at ?? null,
    expectDanger: ctx.beat?.danger ?? null, benign: !!ctx.beat?.benign, need: ctx.beat?.need ?? null,
    sim: simNow().toISOString(), true: trueStatus(simNow().getTime()),
    msg, reply, ms, urgency: row?.urgency_level ?? null, context: row?.context ?? null,
    dangerSigns: row?.danger_signs_detected ?? null,
    stored: user ? { name: user.name, age: user.age, week: user.pregnancy_week, edd: user.edd, lmp: user.lmp, location: user.location, language: user.language } : null,
    journalStage: js?.stage ?? null, llm: turnCalls, amaaiiCost: cost,
  }) + '\n');
  advance((1 + Math.floor(rand() * 4)) * 60000);
}

async function runEpisode(beat: Beat, beatIdx: number, kind: string, maxTurns: number, prevBeat?: string) {
  episodeStart = transcript.length;
  if (beat.webJournal || beat.surface === 'web') {
    // Bearer tokens live 30 days, so a returning PWA user signs in again.
    webToken = (await request(app).post('/auth/login').send({ phone })).body.token;
  }
  if (beat.webJournal) {
    const res = await web.post('/journal/entries', { clientEntryId: `sim-${persona!.id}-${beatIdx}`, ...beat.webJournal });
    turnsFile.write(JSON.stringify({ persona: persona!.id, arm, kind: 'web_journal', beatIdx, beatAt: beat.at, sim: simNow().toISOString(), status: res.status, body: res.body }) + '\n');
    transcript.push({ t: fmt(simNow()), who: 'me', surface: 'web', text: `(filled the app check-in form: ${JSON.stringify(beat.webJournal)})` });
    return;
  }
  for (let k = 1; k <= maxTurns; k++) {
    let msg = await motherSays(beat, k, maxTurns, prevBeat);
    if (msg.includes('[END]')) {
      msg = msg.replace('[END]', '').trim();
      if (msg) await sendTurn(msg, { beatIdx, beat, kind });
      break;
    }
    await sendTurn(msg, { beatIdx, beat, kind });
  }
}

async function deliverDueJobs(prevBeat: Beat, beatIdx: number) {
  outbox = [];
  await jw.runOnce(simNow());
  if (outbox.length === 0) return;
  for (const m of outbox) transcript.push({ t: fmt(simNow()), who: 'amaaii', text: m, surface: 'whatsapp' });
  turnsFile.write(JSON.stringify({ persona: persona!.id, arm, kind: 'followup_sent', beatIdx, sim: simNow().toISOString(), reply: outbox.join('\n---\n') }) + '\n');
  const fb: Beat = { at: prevBeat.at, beat: 'Amaaii just sent you a follow-up message (see the end of the chat). Respond as you naturally would given what happened, or ignore it with [END].' };
  await runEpisode(fb, beatIdx, 'followup_reply', 2, prevBeat.beat);
}

(async () => {
  await db.initializeDatabase();
  webToken = (await request(app).post('/auth/login').send({ phone })).body.token;
  if (!webToken) throw new Error('web login failed');
  if (persona!.startOn === 'web') {
    // PWA-first sign-up: consent screen, then profile form.
    const c = await web.post('/me/consent', { grants: { data_processing: true, ai_responses: true } });
    const m = await web.put('/me', persona!.webSetup);
    turnsFile.write(JSON.stringify({ persona: persona!.id, arm, kind: 'web_setup', consent: c.status, profile: m.status, me: m.body }) + '\n');
  }
  const beats = persona!.beats.slice(0, maxBeats);
  let aborted = '';
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    const target = JOIN_DATE + (parseAt(persona!, b.at) - JOIN_GA) * 7 * DAY;
    // Start somewhere between 07:00 and 21:00 EAT on that day.
    const dayStart = Math.floor((target + 3 * 3600000) / DAY) * DAY - 3 * 3600000;
    const start = Math.max(simNow().getTime() + 60000, dayStart + (7 + Math.floor(rand() * 14)) * 3600000);
    setSimTime(start);
    await deliverDueJobs(beats[Math.max(0, i - 1)], i - 1); // anything due by now (normally none)
    if ((await spentSoFar()) > BUDGET_CAP) { aborted = 'budget'; break; }
    await runEpisode(b, i, i === 0 ? 'onboarding' : 'episode', b.maxTurns ?? 6);
    if (b.surface === 'web' || b.webJournal) {
      // What the PWA would show right now: profile + chat history (incl. WhatsApp turns?).
      const me = await web.get('/me');
      const hist = await web.get('/history');
      const today = await web.get('/journal/today');
      const histRows = Array.isArray(hist.body) ? hist.body : hist.body?.history ?? hist.body?.conversations ?? [];
      turnsFile.write(JSON.stringify({ persona: persona!.id, arm, kind: 'web_view', beatIdx: i, sim: simNow().toISOString(), me: me.body, historyStatus: hist.status, historyCount: histRows.length, historySample: histRows.slice(0, 3), journalToday: today.body }) + '\n');
    }
    // 1-hour follow-up window for high/critical episodes.
    advance(61 * 60000);
    await deliverDueJobs(b, i);
    process.stderr.write(`[${persona!.id}/${arm}] beat ${i + 1}/${beats.length} done, turns=${turnNo}, amaaii=$${amaaiiCost.toFixed(3)} mother=$${motherCost.toFixed(3)}\n`);
  }
  const user = await db.getUser(phone);
  const consents = await db.getConsents(phone);
  const journals = await db.getAllJournalsForUser(phone);
  fs.writeFileSync(path.join(outDir, 'final.json'), JSON.stringify({
    persona: persona!.id, arm, aborted, turns: turnNo, amaaiiCost, motherCost,
    truth: { name: persona!.name, age: persona!.age, location: persona!.location, joinAt: persona!.joinAt, deliverWeek: persona!.deliverWeek },
    user, consents, journals: journals.length, completedJournals: journals.filter((j: any) => j.completed).length,
  }, null, 2));
  fs.writeFileSync(path.join(outDir, 'transcript.md'),
    `# ${persona!.name} (${persona!.age}) — arm ${arm}\n\n` + transcript.map((l) => `**[${l.t}]${l.surface === 'web' ? ' [APP]' : ''} ${l.who === 'me' ? persona!.name : 'Amaaii'}:** ${l.text.replace(/\n/g, '  \n')}`).join('\n\n') + '\n');
  turnsFile.end();
  process.stderr.write(`[${persona!.id}/${arm}] DONE turns=${turnNo} amaaii=$${amaaiiCost.toFixed(3)} mother=$${motherCost.toFixed(3)} ${aborted}\n`);
  setTimeout(() => process.exit(0), 200);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
