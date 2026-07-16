// Pure journal-flow logic extracted from services/journalManager.js:
// answer parsers, the stage-machine transition table, and summary/
// insight text formatting. All DB access, session persistence, and
// LLM-fallback orchestration stay in services/journalManager.js, which
// is now a consumer of this module.

import { detectDangerSigns, extractSymptoms } from './dangerSigns';
import { dangerCopy, t } from './i18n';
import type { AppetiteLevel, JournalAnalytics, JournalStage, Urgency } from './types';

// ---- Generic number extraction -------------------------------------------

// Bare-integer extraction shared by the mood / baby_movement / water
// stages before they fall back to the LLM extractor.
export function extractNumber(message: string): number | null {
  const match = message.match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

// ---- Answer parsers (regex-only; LLM fallback stays in journalManager) ---

export interface SleepAnswer {
  quality?: number;
  hours?: number;
}

export function parseSleepAnswer(message: string): SleepAnswer {
  const qualityMatch =
    message.match(/(\d+)\s*(?:\/|out of)\s*10/i) ||
    message.match(/\b(\d+)\s+for\s+sleep\b/i) ||
    message.match(/\bsleep(?:\s+(?:was|is))?(?:\s+(?:a|an))?\s+(\d+)\b/i);
  const hoursMatch = message.match(/(\d+(?:\.\d+)?)\s*(?:h(?:ours?|rs?)?\b)/i);

  const result: SleepAnswer = {};
  if (qualityMatch) {
    const q = parseInt(qualityMatch[1], 10);
    if (q >= 1 && q <= 10) result.quality = q;
  }
  if (hoursMatch) {
    result.hours = parseFloat(hoursMatch[1]);
  }
  return result;
}

// Returns null when no regex matched, so the caller knows to fall back
// to the LLM extractor. The "not poor" / "si mbaya" override always
// runs last, exactly as in the original inline logic (so "not poor at
// all" resolves to 'moderate', never 'poor').
export function parseAppetiteAnswer(message: string): AppetiteLevel | null {
  const lower = message.toLowerCase();
  let appetiteLevel: AppetiteLevel | null = null;
  let regexHit = false;
  if (/\bpoor\b/.test(lower) || /\bno appetite\b/.test(lower) || /\bno good appetite\b/.test(lower) || /\bmbaya\b/.test(lower)) {
    appetiteLevel = 'poor'; regexHit = true;
  } else if (/\bgood\b/.test(lower) || /\bgreat\b/.test(lower) || /\bnzuri\b/.test(lower)) {
    appetiteLevel = 'good'; regexHit = true;
  } else if (/\bmoderate\b/.test(lower) || /\bok(?:ay)?\b/.test(lower) || /\bwastani\b/.test(lower)) {
    appetiteLevel = 'moderate'; regexHit = true;
  }
  if (/\bnot\s+poor\b/.test(lower) || /\bsi\s+mbaya\b/.test(lower)) {
    appetiteLevel = 'moderate'; regexHit = true;
  }
  return regexHit ? appetiteLevel : null;
}

export interface SymptomsAnswer {
  symptoms: ReturnType<typeof extractSymptoms>;
  /** The exact string to store in journals.physical_symptoms. */
  value: string;
}

// No-symptoms sentinels: "none" (EN), "hapana"/"la"/"sina"/
// "najisikia vyema" (SW common ways to say "no" / "I'm fine").
export function parseSymptomsAnswer(message: string): SymptomsAnswer {
  const symptoms = extractSymptoms(message);
  const lower = message.toLowerCase();
  const isNone =
    /\bnone\b/.test(lower) ||
    /\bhapana\b/.test(lower) ||
    /^la[\s,.]/.test(lower) || /^la$/.test(lower) ||
    /\bsina\b/.test(lower) ||
    /najisikia\s+(?:vyema|vizuri|sawa)/.test(lower);
  const value = symptoms.length > 0 ? JSON.stringify(symptoms) : (isNone ? 'none' : message);
  return { symptoms, value };
}

// ---- Stage machine ---------------------------------------------------------

export interface JournalTransitionInput {
  pregnancyWeek: number;
  /** Only consulted for the 'mood' stage. */
  moodValid?: boolean;
  /** Only consulted for the 'symptoms' stage. */
  dangerUrgency?: Urgency;
}

// Pure transition table for the daily check-in flow, including the
// week >= 20 fetal-movement branch. Deliberately NOT called for the
// 'completed' stage by journalManager — that stage is unreachable in
// practice (the session row is deleted the moment a journal
// completes) and the original code left `nextStage` unset there.
export function nextJournalStage(stage: JournalStage, input: JournalTransitionInput): JournalStage {
  switch (stage) {
    case 'greeting':
    case 'continue':
      return 'mood';
    case 'mood':
      return input.moodValid ? 'symptoms' : 'mood';
    case 'symptoms':
      return (input.dangerUrgency === 'critical' || input.dangerUrgency === 'high') ? 'completed' : 'sleep';
    case 'sleep':
      return input.pregnancyWeek >= 20 ? 'baby_movement' : 'water';
    case 'baby_movement':
      return 'water';
    case 'water':
      return 'appetite';
    case 'appetite':
      return 'questions';
    case 'questions':
      return 'notes';
    case 'notes':
      return 'completed';
    case 'completed':
    default:
      return 'completed';
  }
}

// ---- Free-text symptom + danger scanning -----------------------------------

export interface FreeTextScanResult {
  headsUp: string;
  /** Set when new symptoms were found — value for journalUpdate.physical_symptoms. */
  physicalSymptomsPatch?: string;
  /** Set when a critical/high danger sign was found in free text. */
  redFlagsPatch?: string;
}

// Free-text journal stages (questions, notes) re-run symptom + danger
// detection so anything disclosed there isn't silently logged. Pure:
// takes the existing physical_symptoms value and returns patches for
// the caller to apply, rather than mutating anything itself.
export function scanFreeText(message: string, existingPhysicalSymptoms: unknown, lang?: string | null): FreeTextScanResult {
  const sx = extractSymptoms(message);
  const danger = detectDangerSigns(message);
  const result: FreeTextScanResult = { headsUp: '' };

  if (sx.length > 0) {
    let arr: string[] = [];
    if (typeof existingPhysicalSymptoms === 'string' && existingPhysicalSymptoms.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(existingPhysicalSymptoms);
        if (Array.isArray(parsed)) arr = parsed;
      } catch (_) { /* ignore */ }
    }
    result.physicalSymptomsPatch = JSON.stringify(Array.from(new Set([...arr, ...sx])));
  }

  if (danger.urgencyLevel === 'critical' || danger.urgencyLevel === 'high') {
    result.redFlagsPatch = JSON.stringify(danger.detectedSigns);
    result.headsUp = `${dangerCopy(danger.urgencyLevel, lang)}\n\n`;
    return result;
  }
  if (sx.length > 0) {
    const niceList = sx.map((s) => s.replace(/_/g, ' ')).join(', ');
    result.headsUp = t(lang, 'heads_up_symptoms', { list: niceList });
  }
  return result;
}

// ---- Summary + insight formatting ------------------------------------------

/** Loosely-typed merged journal data (existing row + in-flight update). */
export interface JournalSummaryData {
  emotional_state?: number | null;
  physical_symptoms?: string | null;
  sleep_quality?: number | null;
  sleep_hours?: number | null;
  baby_movement_count?: number | null;
  water_intake?: number | null;
  appetite?: string | null;
  red_flags_detected?: string | null;
  [key: string]: unknown;
}

export function formatSymptoms(raw: unknown, lang?: string | null): string {
  if (!raw || raw === 'none') return t(lang, 'journal_no_symptoms');
  if (typeof raw !== 'string') return String(raw);
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr) && arr.length > 0) {
        return arr.map((s) => String(s).replace(/_/g, ' ')).join(', ');
      }
    } catch (_) { /* fall through */ }
  }
  return trimmed;
}

export function generateRecommendations(data: JournalSummaryData, lang?: string | null): string[] {
  // Casts below preserve the ORIGINAL untyped-JS coercion semantics
  // exactly (e.g. `null < 5` → `0 < 5` → true) rather than "fixing"
  // them with extra null guards — including the pre-existing asymmetry
  // that this function checks baby_movement_count against `undefined`
  // only, while generateJournalSummary() below guards both.
  const recommendations: string[] = [];
  if ((data.emotional_state as number) < 5) {
    recommendations.push(t(lang, 'rec_mood_low'));
  }
  if (data.sleep_hours && data.sleep_hours < 6) {
    recommendations.push(t(lang, 'rec_sleep'));
  }
  if (data.water_intake && data.water_intake < 8) {
    recommendations.push(t(lang, 'rec_water'));
  }
  if (data.appetite === 'poor') {
    recommendations.push(t(lang, 'rec_appetite_poor'));
  }
  if (data.baby_movement_count !== undefined && (data.baby_movement_count as number) < 10) {
    recommendations.push(t(lang, 'rec_movement'));
  }
  return recommendations;
}

export function generateJournalSummary(
  existingData: JournalSummaryData,
  newData: JournalSummaryData,
  lang: string | null | undefined = 'en',
  pregnancyWeek = 0
): string {
  const data: JournalSummaryData = { ...existingData, ...newData };
  let summary = t(lang, 'journal_summary_title');

  if (data.emotional_state) {
    const moodEmoji = data.emotional_state >= 7 ? '😊' :
      data.emotional_state >= 5 ? '😐' : '😔';
    summary += `${t(lang, 'journal_summary_mood')} ${data.emotional_state}/10 ${moodEmoji}\n`;
  }

  if (data.physical_symptoms) {
    summary += `${t(lang, 'journal_summary_symptoms')} ${formatSymptoms(data.physical_symptoms, lang)}\n`;
  }

  if (data.sleep_quality || data.sleep_hours) {
    const parts: string[] = [];
    if (data.sleep_quality) parts.push(`${data.sleep_quality}${t(lang, 'journal_summary_quality')}`);
    if (data.sleep_hours) parts.push(`${data.sleep_hours} ${t(lang, 'journal_summary_hours')}`);
    summary += `${t(lang, 'journal_summary_sleep')} ${parts.join(', ')}\n`;
  }

  if (data.baby_movement_count !== undefined && data.baby_movement_count !== null) {
    // Only flag low movement counts as concerning when clinically
    // relevant (after 28 weeks). Below 28w, regular movement isn't
    // expected at high counts and a ⚠️ here is a false alarm.
    const concerning = pregnancyWeek > 28 && data.baby_movement_count < 10;
    const movementStatus = data.baby_movement_count >= 10 ? '✅' : (concerning ? '⚠️' : '👶');
    summary += `${t(lang, 'journal_summary_movement')} ${data.baby_movement_count} ${t(lang, 'journal_summary_movement_unit')} ${movementStatus}\n`;
  }

  if (data.water_intake) {
    const waterStatus = data.water_intake >= 8 ? '✅' : '💧';
    summary += `${t(lang, 'journal_summary_water')} ${data.water_intake} ${t(lang, 'journal_summary_water_unit')} ${waterStatus}\n`;
  }

  if (data.appetite) {
    const appetiteLabel = t(lang, `appetite_${data.appetite}`);
    summary += `${t(lang, 'journal_summary_appetite')} ${appetiteLabel}\n`;
  }

  summary += '\n';

  if (data.red_flags_detected) {
    summary += t(lang, 'journal_summary_red_flag');
  }

  const recommendations = generateRecommendations(data, lang);
  if (recommendations.length > 0) {
    summary += t(lang, 'journal_summary_recs');
    recommendations.forEach((rec) => (summary += `• ${rec}\n`));
  }

  summary += t(lang, 'journal_summary_done');
  return summary;
}

/** Minimal shape extractWeeklySymptoms() and generateWeeklyInsights() need. */
export interface SymptomHistoryEntry {
  physical_symptoms?: string | null;
}

export function extractWeeklySymptoms(history: SymptomHistoryEntry[]): string[] {
  const symptomCount: Record<string, number> = {};
  history.forEach((entry) => {
    if (!entry.physical_symptoms || entry.physical_symptoms === 'none') return;
    // Only attempt JSON.parse when the value is actually a JSON array
    // payload. Free-text user input is ignored rather than silently
    // swallowed by a try/catch. (D10.)
    const value = entry.physical_symptoms.trim();
    if (!value.startsWith('[')) return;
    const symptoms = JSON.parse(value);
    if (!Array.isArray(symptoms)) return;
    symptoms.forEach((symptom: string) => {
      symptomCount[symptom] = (symptomCount[symptom] || 0) + 1;
    });
  });

  return Object.entries(symptomCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([symptom]) => symptom);
}

export function generateWeeklyInsights(analytics: JournalAnalytics, _history: SymptomHistoryEntry[]): string {
  // Casts preserve original JS coercion semantics for null/undefined
  // averages (e.g. `null < 5` → `0 < 5` → true) rather than guarding.
  let insights = '\n💡 **Insights:**\n';
  if ((analytics.avg_mood as number) >= 7) {
    insights += "• You've had a positive week emotionally! 🌟\n";
  } else if ((analytics.avg_mood as number) < 5) {
    insights += '• Your mood has been low. Consider reaching out for support. 💚\n';
  }
  if ((analytics.avg_water as number) >= 8) {
    insights += '• Great hydration this week! Keep it up! 💧\n';
  } else {
    insights += '• Try to increase your water intake. 💧\n';
  }
  if (analytics.journal_count >= 6) {
    insights += '• Excellent journaling consistency! 📝\n';
  } else if (analytics.journal_count < 3) {
    insights += '• Try to journal more regularly to track your journey. 📝\n';
  }
  return insights;
}
