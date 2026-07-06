// Deterministic onboarding parsers, extracted from utils/messageHandler.js
// (see commit "fix(onboarding): smarter name + week parsing + 3-strikes
// LLM fallback"). The LLM fallback itself (3-strikes escalation to
// services/llmExtract.js#extractWeekOrLMP) stays in messageHandler.js —
// only the regex/date-math parsing that runs before it moves here.

/** Result of parsing a pregnancy-week or last-menstrual-period answer. */
export interface WeekOrLmp {
  weeks: number;
  lmp?: string;
}

// LMP year inference: if the month suggests an LMP within ~10 months
// of today, use this year; otherwise last year. Most pregnancies span
// less than a year so this heuristic works in 95%+ of demo cases.
export function inferLMPYear(month: number): number {
  const now = new Date();
  const thisYear = now.getUTCFullYear();
  const thisMonth = now.getUTCMonth() + 1;
  // If the named month is in the future relative to today, assume last year.
  return month > thisMonth ? thisYear - 1 : thisYear;
}

export function weeksFromLMP(lmp: string): number {
  const lmpDate = new Date(lmp);
  if (Number.isNaN(lmpDate.getTime())) return 0;
  const diffMs = Date.now() - lmpDate.getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24 * 7)));
}

// Liberal parser for the pregnancy-week answer. Returns
// { weeks: int, lmp?: 'YYYY-MM-DD' } or null. Accepts any of:
//   - "20 weeks" / "20 wks" / "i'm at 20" / "20"
//   - "wiki 20" / "20 wiki" (SW)
//   - "22/3/2026" / "2026-03-22" (numeric LMP)
//   - "22 march" / "march 22" / "22nd of march 2026" (month name LMP)
//   - "22 machi" (SW month name)
export function parseWeekOrLMP(raw: string): WeekOrLmp | null {
  if (typeof raw !== 'string') return null;
  const lower = raw.trim().toLowerCase();

  // `m` intentionally untyped: it's reassigned from several different
  // regex matches below, and one branch reshapes the captured groups
  // into a normalised [_, day, month, year] tuple that doesn't fit
  // RegExpMatchArray's shape. The function's public surface (input/
  // return type) stays strict; this local variable does not.
  // Numeric date forms first (most specific).
  let m: RegExpMatchArray | (string | undefined)[] | null = lower.match(/(\d{4})[\-\/](\d{1,2})[\-\/](\d{1,2})/);
  if (m) {
    const lmp = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    return { weeks: weeksFromLMP(lmp), lmp };
  }
  m = lower.match(/(\d{1,2})[\-\/](\d{1,2})[\-\/](\d{2,4})/);
  if (m) {
    let yr = parseInt(m[3] as string, 10);
    if (yr < 100) yr += 2000;
    const lmp = `${yr}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    return { weeks: weeksFromLMP(lmp), lmp };
  }

  // Month-name forms: "22 march", "march 22", "22nd of march", with
  // optional year. SW months included.
  const MONTHS: Record<string, number> = {
    jan: 1, january: 1, januari: 1,
    feb: 2, february: 2, februari: 2,
    mar: 3, march: 3, machi: 3,
    apr: 4, april: 4, aprili: 4,
    may: 5, mei: 5,
    jun: 6, june: 6, juni: 6,
    jul: 7, july: 7, julai: 7,
    aug: 8, august: 8, agosti: 8,
    sep: 9, sept: 9, september: 9, septemba: 9,
    oct: 10, october: 10, oktoba: 10,
    nov: 11, november: 11, novemba: 11,
    dec: 12, december: 12, desemba: 12,
  };
  const monthAlt = Object.keys(MONTHS).join('|');
  // "22 march" / "22nd of march" / "22 march 2026"
  m = lower.match(new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthAlt})(?:\\s+(\\d{4}))?`, 'i'));
  if (!m) {
    // "march 22" / "march 22 2026"
    const m2 = lower.match(new RegExp(`(${monthAlt})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?`, 'i'));
    if (m2) m = [m2[0], m2[2], m2[1], m2[3]]; // normalise to [_, day, month, year]
  }
  if (m) {
    const day = parseInt(m[1] as string, 10);
    const mo = MONTHS[(m[2] as string).toLowerCase()];
    if (day >= 1 && day <= 31 && mo) {
      const yr = m[3] ? parseInt(m[3], 10) : inferLMPYear(mo);
      const lmp = `${yr}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return { weeks: weeksFromLMP(lmp), lmp };
    }
  }

  // Week patterns (most → least specific).
  m =
    lower.match(/(\d+)\s*(?:weeks?|wks?|w\b)/i) ||
    lower.match(/(\d+)\s*wiki/i) ||
    lower.match(/wiki\s*(\d+)/i) ||
    lower.match(/(?:i'?m|im|i\s*am|niko|niko\s*kwa|nina)\s+(?:at\s+|kwa\s+)?(\d+)\b/i);
  if (m) {
    const w = parseInt(m[1] as string, 10);
    if (w >= 1 && w <= 42) return { weeks: w };
  }

  // Last resort: bare integer in a plausible week range, with no other
  // numbers in the message. "22" → 22 weeks. "22 march" was already
  // caught above, so this only fires for genuinely bare numbers.
  m = lower.match(/^\s*(\d+)\s*$/);
  if (m) {
    const n = parseInt(m[1] as string, 10);
    if (n >= 1 && n <= 42) return { weeks: n };
  }

  return null;
}

// Strip common framing so "Hey, my name is Mboga" / "I'm Mboga" /
// "Hi I am Mboga" / "Habari, jina langu ni Mboga" all yield "Mboga".
export function cleanName(raw: string): string {
  let s = (raw || '').trim();
  // Drop a leading greeting if present.
  s = s.replace(/^(?:hey|hi|hello|habari|niaje|sasa|poa|hujambo)\s*[,!.\-]*\s*/i, '');
  // Strip introductions: "my name is X", "I'm X", "I am X", "call me X",
  // SW: "jina langu ni X", "ninaitwa X", "mimi ni X".
  const intros = [
    /^(?:my\s+name\s+is)\s+/i,
    /^(?:i\s*am|i'?m)\s+/i,
    /^(?:call\s+me)\s+/i,
    /^(?:it'?s|this\s+is)\s+/i,
    /^(?:jina\s+langu\s+ni)\s+/i,
    /^(?:ninaitwa)\s+/i,
    /^(?:mimi\s+ni)\s+/i,
  ];
  for (const re of intros) s = s.replace(re, '');
  // If anything is left wrapped in quotes, unwrap.
  s = s.replace(/^["']\s*/, '').replace(/\s*["']$/, '');
  // Final trim + collapse internal whitespace.
  s = s.trim().replace(/\s+/g, ' ');
  // Cap at first sentence-ending punctuation — names don't have periods.
  s = s.split(/[.!?,]/)[0].trim();
  return s;
}

export function calculateEDDFromWeeks(currentWeeks: number): string {
  const today = new Date();
  const daysPregnant = currentWeeks * 7;
  const daysRemaining = 280 - daysPregnant;
  const edd = new Date(today);
  edd.setDate(edd.getDate() + daysRemaining);
  return edd.toISOString().split('T')[0];
}
