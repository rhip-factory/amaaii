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

  // Months ("I'm 5 months", "miezi mitano") — before the bare "i'm N"
  // pattern below, which used to read "I'm 5 months" as week 5.
  const monthWeeks = parseMonthsAsWeeks(lower);
  if (monthWeeks != null) return { weeks: monthWeeks };

  // Week patterns (most → least specific).
  m =
    lower.match(/(\d+)\s*(?:weeks?|wks?|w\b)/i) ||
    lower.match(/(\d+)\s*wiki/i) ||
    lower.match(/wiki\s*(\d+)/i) ||
    lower.match(/(?:i'?m|im|i\s*am|niko|niko\s*kwa|nina)\s+(?:at\s+|kwa\s+)?(\d+)\b(?!\s*(?:months?|mwezi|miezi|years?|yrs?|miaka|days?|siku))/i);
  if (!m) {
    // "wiki ishirini na mbili" / "ishirini na mbili wiki"
    const sw = lower.match(/\bwiki\s+((?:\w+\s*){1,3})/) || lower.match(/((?:\w+\s+){1,3})wiki\b/);
    const n = sw ? parseSwahiliNumber(sw[1]) : null;
    if (n != null && n >= 1 && n <= 42) return { weeks: n };
  }
  if (m) {
    const w = parseInt(m[1] as string, 10);
    // Lower bound is 0, not 1: an LMP within the last 6 days legitimately
    // dates to week 0, and a woman that early is exactly who benefits most
    // from being enrolled. Everything downstream treats pregnancy_week with
    // explicit null checks rather than truthiness so a stored 0 is a real
    // value, not "unset" — see userManager.getUserContext.
    if (w >= 0 && w <= 42) return { weeks: w };
  }

  // Last resort: bare integer in a plausible week range, with no other
  // numbers in the message. "22" → 22 weeks. "22 march" was already
  // caught above, so this only fires for genuinely bare numbers.
  m = lower.match(/^\s*(\d+)\s*$/);
  if (m) {
    const n = parseInt(m[1] as string, 10);
    if (n >= 0 && n <= 42) return { weeks: n };
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

// ---------------------------------------------------------------------------
// Where she is NOW. The stored pregnancy_week used to be a snapshot taken at
// onboarding and never advanced (the 2026-10 simulation: all 24 runs stayed
// on their onboarding week for months, so a mother admitted with
// pre-eclampsia at 33 weeks was told "at 8 weeks…"). The edd is the anchor:
// week = 40 - weeks-to-edd. delivery_date switches her to postpartum.
// ---------------------------------------------------------------------------
export type PregnancyStatus =
  | { phase: 'pregnant'; week: number; days: number; overdue: boolean }
  | { phase: 'postpartum'; days: number; weeks: number }
  | { phase: 'unknown' };

const DAY_MS = 24 * 60 * 60 * 1000;

function dayDiff(later: Date, earlier: unknown): number | null {
  // Defensive: these come from DB columns a client can write.
  if (typeof earlier !== 'string') return null;
  const d = new Date(`${earlier.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const today = Date.UTC(later.getUTCFullYear(), later.getUTCMonth(), later.getUTCDate());
  return Math.floor((today - d.getTime()) / DAY_MS);
}

export function pregnancyStatus(
  user: { pregnancy_week?: number | null; edd?: string | null; lmp?: string | null; delivery_date?: string | null },
  now: Date
): PregnancyStatus {
  if (user.delivery_date) {
    const days = dayDiff(now, user.delivery_date);
    if (days != null && days >= 0) return { phase: 'postpartum', days, weeks: Math.floor(days / 7) };
  }
  let gaDays: number | null = null;
  if (user.edd) {
    const toEdd = dayDiff(now, user.edd); // negative while pregnant
    if (toEdd != null) gaDays = 280 + toEdd;
  } else if (user.lmp) {
    gaDays = dayDiff(now, user.lmp);
  }
  if (gaDays != null && gaDays >= 0 && gaDays <= 46 * 7) {
    return {
      phase: 'pregnant',
      week: Math.min(42, Math.floor(gaDays / 7)),
      days: gaDays,
      // Three days past the due date with no birth recorded: time to ask.
      overdue: gaDays >= 283,
    };
  }
  if (user.pregnancy_week != null) {
    return { phase: 'pregnant', week: user.pregnancy_week, days: user.pregnancy_week * 7, overdue: false };
  }
  return { phase: 'unknown' };
}

// ---------------------------------------------------------------------------
// Onboarding fast paths. These run before (and are cheaper than) the LLM
// slot filler; anything they can't read confidently returns null.
// ---------------------------------------------------------------------------

/** Age 12–55. A number followed by a unit ("250mg", "11 weeks",
 *  "5 months") is never an age. Accepts Kiswahili number words
 *  ("miaka kumi na tisa"). */
export function parseAge(raw: string): number | null {
  const text = (raw || '').toLowerCase();
  const UNIT = /^\s*(?:mg|kg|g|ml|weeks?|wks?|wiki|months?|mwezi|miezi|days?|siku|hours?|hrs?|masaa|glasses?|cm|%|\/)/;
  const re = /\d+/g;
  let m: RegExpExecArray | null;
  const candidates: number[] = [];
  while ((m = re.exec(text))) {
    const rest = text.slice(m.index + m[0].length);
    const before = text.slice(Math.max(0, m.index - 1), m.index);
    if (UNIT.test(rest) || before === '/' || before === '.') continue;
    candidates.push(parseInt(m[0], 10));
  }
  const fromDigits = candidates.find((n) => n >= 12 && n <= 55);
  if (fromDigits != null) return fromDigits;
  const words = parseSwahiliNumber(text.replace(/^.*?\bmiaka\b/, ''));
  if (words != null && words >= 12 && words <= 55) return words;
  return null;
}

const SW_UNITS: Record<string, number> = {
  moja: 1, mbili: 2, tatu: 3, nne: 4, tano: 5, sita: 6, saba: 7, nane: 8, tisa: 9,
};
const SW_TENS: Record<string, number> = {
  kumi: 10, ishirini: 20, thelathini: 30, arobaini: 40, hamsini: 50,
};

/** "kumi na tisa" -> 19, "ishirini na mbili" -> 22, "tano" -> 5. */
export function parseSwahiliNumber(raw: string): number | null {
  const words = (raw || '').toLowerCase().match(/[a-z]+/g) || [];
  for (let i = 0; i < words.length; i++) {
    const tens = SW_TENS[words[i]];
    if (tens != null) {
      if (words[i + 1] === 'na' && SW_UNITS[words[i + 2]] != null) return tens + SW_UNITS[words[i + 2]];
      return tens;
    }
    if (SW_UNITS[words[i]] != null) return SW_UNITS[words[i]];
  }
  return null;
}

const EN_NUMBER: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};

/** "4 months", "5 MONTHS", "miezi mitano", "mwezi wa nne", "four months"
 *  -> weeks (months x 4.33, rounded). "mwezi wa N" is the Nth month,
 *  i.e. N-1 completed months plus about half a month. */
export function parseMonthsAsWeeks(raw: string): number | null {
  const text = (raw || '').toLowerCase();
  const SW_ADJ: Record<string, number> = {
    mmoja: 1, miwili: 2, mitatu: 3, minne: 4, mitano: 5, sita: 6, saba: 7, minane: 8, tisa: 9,
  };
  let months: number | null = null;
  let m = text.match(/(\d{1,2}(?:\.\d)?)\s*(?:months?|mnths?|mths?|miezi|mwezi)\b/);
  if (m) months = parseFloat(m[1]);
  if (months == null) {
    m = text.match(/\b(one|two|three|four|five|six|seven|eight|nine)\s+months?\b/);
    if (m) months = EN_NUMBER[m[1]];
  }
  if (months == null) {
    m = text.match(/\bmiezi\s+(mmoja|miwili|mitatu|minne|mitano|sita|saba|minane|tisa|\d{1,2})\b/);
    if (m) months = SW_ADJ[m[1]] ?? parseInt(m[1], 10);
  }
  if (months == null) {
    m = text.match(/\bmwezi\s+wa\s+(\w+)/);
    if (m) {
      const n = SW_UNITS[m[1]] ?? (/^\d+$/.test(m[1]) ? parseInt(m[1], 10) : null);
      if (n != null) months = n - 0.5;
    }
  }
  if (months == null || months <= 0 || months > 10) return null;
  return Math.round(months * 4.33);
}
