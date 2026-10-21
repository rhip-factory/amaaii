// Chat commands, matched against the WHOLE message (after light
// normalisation) rather than as substrings. The old substring matchers
// started a journal on "I'll recheck in an hour" and "what is journal?",
// and "journal summary" (which the bot itself tells users to type)
// started a new journal instead of showing the summary. Pure, no I/O.

import { parseMonthsAsWeeks } from './onboarding';

export type ChatCommand =
  | 'journal'
  | 'summary'
  | 'weekly_summary'
  | 'doctor_report'
  | 'cancel'
  | 'help'
  | 'resume'
  | 'restart';

const COMMANDS: Record<ChatCommand, string[]> = {
  journal: [
    'journal', 'daily journal', 'my journal', 'journal now', 'check in', 'checkin', 'check-in',
    'daily check in', 'daily check-in', 'daily checkin', 'jarida', 'jarida langu', 'ukaguzi',
    'ukaguzi wa kila siku',
  ],
  summary: [
    'journal summary', 'summary', 'my summary', "today's summary", 'todays summary',
    'muhtasari', 'muhtasari wa jarida', 'muhtasari wa leo',
  ],
  weekly_summary: [
    'weekly summary', 'week summary', 'my progress', 'progress', 'how am i doing',
    'muhtasari wa wiki', 'maendeleo yangu', 'maendeleo',
  ],
  doctor_report: [
    'doctor report', "doctor's report", 'doctors report', 'report', 'generate report',
    'medical summary', 'ripoti', 'ripoti ya daktari',
  ],
  cancel: [
    'stop', 'cancel', 'exit', 'quit', 'end', 'later', 'not now', 'skip', 'acha', 'sitisha',
    'baadaye', 'sitaki', 'stop journal', 'cancel journal', 'end journal', 'skip journal',
    'stop check in', 'stop check-in', 'acha jarida', 'sitisha jarida', 'sitaki jarida',
  ],
  resume: [
    'resume', 'resume check-in', 'resume check in', 'resume checkin', 'resume journal', 'continue',
    'continue check-in', 'continue check in', 'continue journal', 'carry on', 'endelea',
    'endelea na jarida', 'endelea na ukaguzi',
  ],
  restart: [
    'restart', 'restart check-in', 'restart check in', 'restart checkin', 'restart journal',
    'start over', 'start again', 'anza upya', 'anza jarida upya', 'anza tena',
  ],
  help: [
    'help', 'menu', 'msaada', 'commands', 'options', 'what can you do', 'unaweza kufanya nini',
    'help me', 'nisaidie',
  ],
};

const LEADING = /^(?:(?:please|pls|tafadhali|ok|okay|sawa|hi|hello|habari|amaaii)\s+)*(?:(?:i\s+want\s+to|i'?d\s+like\s+to|let'?s|lets|let\s+us|let\s+me|can\s+i|can\s+we|nataka|naomba|tufanye|start|anza|open|show(?:\s+me)?|give\s+me|nipe|do)\s+)?(?:(?:kufanya|to\s+do|do)\s+)?(?:(?:my|the|a|our)\s+)?/;
const TRAILING = /(?:\s+(?:please|pls|tafadhali|now|sasa|today|leo))+$/;

export function normalizeCommandText(message: string): string {
  return message
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    // Drop emoji / punctuation except apostrophes and hyphens inside words.
    .replace(/[^\p{L}\p{N}'\-\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseCommand(message: string): ChatCommand | null {
  const base = normalizeCommandText(message);
  if (!base || base.split(' ').length > 8) return null;
  const stripped = base.replace(LEADING, '').replace(TRAILING, '').trim();
  for (const candidate of [base, stripped]) {
    for (const cmd of Object.keys(COMMANDS) as ChatCommand[]) {
      if (COMMANDS[cmd].includes(candidate)) return cmd;
    }
  }
  // "please stop asking me these questions", "acha maswali ya jarida"
  if (/\b(?:stop|cancel|quit|exit|end|acha|sitisha|sitaki)\b.*\b(?:journal|jarida|check-?\s?in|questions?|maswali|ukaguzi)\b/.test(base)) {
    return 'cancel';
  }
  return null;
}

// "Prompt me", "let's start", "tuanze" — a go-ahead, which starts the
// check-in when Amaaii's last message invited her to (prod, 2026-10-21: the
// AI answered "Prompt me" by asking the mood question itself, so nothing
// was saved). A bare "yes"/"ok" is not one: the invitation is often the
// tail of an AI reply that asked her something else.
const GO_AHEAD = /^(?:(?:yes|yeah|yep|ok|okay|sure|sawa|ndiyo|ndio|haya|poa|alright|please|pls|tafadhali)\s+)*(?:let'?s\s+(?:go|do\s+it|start|begin)|lets\s+(?:go|do\s+it|start|begin)|go\s+ahead|start(?:\s+it)?|begin|prompt\s+me|ask\s+me|i'?m\s+ready|im\s+ready|ready|tuanze|anza|niulize|niko\s+tayari|do\s+it)(?:\s+(?:please|pls|tafadhali|now|sasa))*$/;

export function isGoAhead(message: string): boolean {
  return GO_AHEAD.test(normalizeCommandText(message));
}

/** A journal session left untouched this long is abandoned: the next
 *  message is routed normally instead of being parsed as an answer. */
export const JOURNAL_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

/** SQLite's datetime('now') has no zone suffix; it is UTC. */
export function parseSqliteUtc(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export function isJournalSessionStale(
  updatedAt: string | null | undefined,
  now: Date,
  ttlMs: number = JOURNAL_SESSION_TTL_MS
): boolean {
  const ms = parseSqliteUtc(updatedAt);
  if (ms == null) return false;
  return now.getTime() - ms > ttlMs;
}

/** True when an unparseable journal answer is really a question or a new
 *  topic ("how do I get the app?", "my nipples are bleeding, what do I
 *  do") — the journal should step aside and let normal routing answer. */
export function looksLikeOffTopic(message: string): boolean {
  const text = message.trim();
  if (text.includes('?')) return true;
  return text.split(/\s+/).filter(Boolean).length >= 6;
}

// ---------------------------------------------------------------------------
// Conversational profile updates. In the simulation, mothers asked to fix
// their week, name and language and to say the baby had arrived, and the AI
// answered "I've updated that" while nothing changed. These are matched
// deterministically; the caller applies them and confirms.
// ---------------------------------------------------------------------------
export type ProfileUpdate =
  | { kind: 'name'; name: string; whole: true }
  | { kind: 'week'; weeks: number; whole: true }
  | { kind: 'language'; lang: 'en' | 'sw'; whole: boolean }
  | { kind: 'birth'; whole: boolean };

const NAME_UPDATE = /^(?:(?:please|pls|tafadhali)\s+)?(?:my\s+name\s+is|call\s+me|i'?m\s+called|you\s+can\s+call\s+me|jina\s+langu\s+ni|niite|naitwa|ninaitwa)\s+([a-zÀ-ɏ][a-zÀ-ɏ' -]{1,38})$/i;
const WEEK_UPDATE = /^(?:(?:no|actually|sorry|hapana|kumbe)[\s,]+)?(?:i'?m|im|i\s+am|niko|nina|my\s+(?:pregnancy|week)\s+is|it'?s|its|we\s+are)\s+(?:now\s+|at\s+|kwa\s+|na\s+)?(?:wiki\s+(\d{1,2})|(\d{1,2})\s*(?:weeks?|wks?|wiki))(?:\s+(?:now|today|pregnant|sasa|leo))?(?:[\s,]+not\s+\d{1,2}(?:\s*weeks?)?)?$/i;
const MONTH_UPDATE = /^(?:(?:no|actually|sorry|hapana|kumbe)[\s,]+)?(?:i'?m|im|i\s+am|niko|nina|my\s+pregnancy\s+is|it'?s|its)\s+(?:now\s+|at\s+|na\s+)?(?:mimba\s+ya\s+)?((?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine)\s+months?|miezi\s+\w+|mwezi\s+wa\s+\w+)(?:\s+(?:now|today|pregnant|sasa|leo))?$/i;
const LANGUAGE_WHOLE = /^(?:(?:please|pls|tafadhali|naomba|can\s+we|let'?s)\s+)?(?:(?:speak|talk|reply|write|answer|tuongee|ongea|nijibu|unijibu|niandikie|jibu|use)\s+(?:(?:to\s+me|with\s+me|na\s+mimi|kwa|in)\s+)*)?(kiswahili|swahili|english|kiingereza)(?:\s+(?:please|pls|tafadhali|tu|only|pekee|language))*$/i;
const LANGUAGE_EMBEDDED = /\b(?:u?nijibu|niandikie|tuongee|ongea|reply|answer|speak|talk|write|respond)\s+(?:(?:to\s+me|with\s+me|na\s+mimi|kwa|in)\s+)*(kiswahili|swahili|english|kiingereza)\b|\b(kiswahili|swahili|english|kiingereza)\s+(?:tu|only|pekee|please|tafadhali)\b/i;
const BIRTH = /\b(?:i\s+(?:just\s+|have\s+|finally\s+)?(?:gave\s+birth|delivered|had\s+(?:my|the|a)\s+baby)|(?:my\s+|the\s+)?baby\s+(?:is\s+|was\s+|has\s+)?(?:born|arrived|here|come)|nimejifungua|nilijifungua|nimezaa|mtoto\s+(?:amezaliwa|alizaliwa|amefika))\b/i;
// "when I gave birth to my first child…" is history, not news.
const BIRTH_HISTORY = /\b(?:first|last|previous|other|older|before|ago\s+\d|zamani|kwanza|mwisho|mwingine|years?\s+ago|miaka)\b/i;

export function parseProfileUpdate(message: string): ProfileUpdate | null {
  const text = message.trim().replace(/[.!🙏💚😊]+$/u, '').trim();
  const lang = (s: string): 'en' | 'sw' => (/^(?:kiswahili|swahili)$/i.test(s) ? 'sw' : 'en');

  let m = text.match(LANGUAGE_WHOLE);
  if (m) return { kind: 'language', lang: lang(m[1]), whole: true };
  m = text.match(NAME_UPDATE);
  if (m) {
    const name = m[1].trim().replace(/\s+/g, ' ');
    if (name.split(' ').length <= 4) return { kind: 'name', name, whole: true };
  }
  m = text.match(WEEK_UPDATE);
  if (m) {
    const weeks = parseInt(m[1] ?? m[2], 10);
    if (weeks >= 1 && weeks <= 42) return { kind: 'week', weeks, whole: true };
  }
  m = text.match(MONTH_UPDATE);
  if (m) {
    const weeks = parseMonthsAsWeeks(m[1]);
    if (weeks != null) return { kind: 'week', weeks, whole: true };
  }
  if (BIRTH.test(text) && !BIRTH_HISTORY.test(text)) {
    return { kind: 'birth', whole: text.split(/\s+/).length <= 8 };
  }
  m = text.match(LANGUAGE_EMBEDDED);
  if (m) return { kind: 'language', lang: lang(m[1] || m[2]), whole: false };
  return null;
}
