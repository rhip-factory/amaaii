// Chat commands, matched against the WHOLE message (after light
// normalisation) rather than as substrings. The old substring matchers
// started a journal on "I'll recheck in an hour" and "what is journal?",
// and "journal summary" (which the bot itself tells users to type)
// started a new journal instead of showing the summary. Pure, no I/O.

export type ChatCommand =
  | 'journal'
  | 'summary'
  | 'weekly_summary'
  | 'doctor_report'
  | 'cancel'
  | 'help';

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
