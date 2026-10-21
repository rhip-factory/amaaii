// "What did you mean?" for a journal answer that fits the question in
// more than one way. Prod, 2026-10-20: "It was a 7" to "Rate quality
// (1-10) and hours slept" was read as "pain 7/10" by the triage model and
// paused the check-in with an escalation. Now an answer like that gets up
// to three options (WhatsApp reply buttons, app chips, or a numbered list
// on any other transport), one of which always leads to triage.
//
// Labels are built here from validated fields, never taken from model
// output, so a button can only say what the code can save.

import { t } from './i18n';
import { parseSleepAnswer } from './journal';
import type { AppetiteLevel } from './types';

/** One journal stage's answer, as the stage machine saves it. */
export interface JournalFields {
  mood?: number;
  quality?: number;
  hours?: number;
  count?: number;
  glasses?: number;
  appetite?: AppetiteLevel;
}

export interface ClarifyOption {
  label: string;
  /** Saved as the stage's answer when chosen. */
  fields?: JournalFields;
  /** Chosen = she may be unwell: close the check-in and triage. */
  unwell?: boolean;
}

export interface PendingClarify {
  stage: string;
  options: ClarifyOption[];
}

/** WhatsApp allows three reply buttons, 20 characters each. */
export const MAX_CLARIFY_OPTIONS = 3;
export const CLARIFY_LABEL_MAX = 20;

/** The stages whose answer is a score, count or level. */
export const JOURNAL_SCORE_STAGES = new Set(['mood', 'sleep', 'baby_movement', 'water', 'appetite']);

const inRange = (n: unknown, lo: number, hi: number): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;

/** Keeps only the fields that belong to `stage` and are in range. */
export function validJournalFields(stage: string, raw: unknown): JournalFields | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out: JournalFields = {};
  if (stage === 'mood' && Number.isInteger(r.mood) && inRange(r.mood, 1, 10)) out.mood = r.mood;
  if (stage === 'sleep') {
    if (Number.isInteger(r.quality) && inRange(r.quality, 1, 10)) out.quality = r.quality;
    if (inRange(r.hours, 0, 16)) out.hours = Math.round(r.hours * 2) / 2;
  }
  if (stage === 'baby_movement' && Number.isInteger(r.count) && inRange(r.count, 0, 200)) out.count = r.count;
  if (stage === 'water' && Number.isInteger(r.glasses) && inRange(r.glasses, 0, 30)) out.glasses = r.glasses;
  if (stage === 'appetite' && (r.appetite === 'good' || r.appetite === 'moderate' || r.appetite === 'poor')) {
    out.appetite = r.appetite;
  }
  return Object.keys(out).length ? out : null;
}

export function journalFieldsLabel(fields: JournalFields, lang: string): string | null {
  let label: string | null = null;
  if (fields.quality != null && fields.hours != null) label = t(lang, 'opt_sleep_both', { q: fields.quality, h: fields.hours });
  else if (fields.quality != null) label = t(lang, 'opt_sleep_quality', { n: fields.quality });
  else if (fields.hours != null) label = t(lang, 'opt_sleep_hours', { n: fields.hours });
  else if (fields.mood != null) label = t(lang, 'opt_mood', { n: fields.mood });
  else if (fields.count != null) label = t(lang, 'opt_movement', { n: fields.count });
  else if (fields.glasses != null) label = t(lang, 'opt_water', { n: fields.glasses });
  else if (fields.appetite) label = t(lang, `opt_appetite_${fields.appetite}`);
  return label && label.length <= CLARIFY_LABEL_MAX ? label : null;
}

/**
 * Options for the possible readings of her answer, plus one that always
 * leads to triage ("Pain 7/10" when she gave a bare number, else "I feel
 * unwell"). Null when fewer than two distinct readings survive.
 */
export function buildClarifyOptions(
  readings: JournalFields[],
  lang: string,
  bareNumber: number | null = null
): ClarifyOption[] | null {
  const options: ClarifyOption[] = [];
  for (const fields of readings) {
    const label = journalFieldsLabel(fields, lang);
    if (label && !options.some((o) => o.label === label)) options.push({ label, fields });
    if (options.length === MAX_CLARIFY_OPTIONS - 1) break;
  }
  if (options.length < 2) return null;
  options.push(safetyOption(lang, bareNumber));
  return options;
}

/** The option that always leads to triage: "Pain 7/10" for a bare number
 *  1-10, else "I feel unwell". */
export function safetyOption(lang: string, bareNumber: number | null = null): ClarifyOption {
  const label = bareNumber != null && bareNumber >= 1 && bareNumber <= 10
    ? t(lang, 'opt_pain', { n: bareNumber })
    : t(lang, 'opt_unwell');
  return { label, unwell: true };
}

/**
 * Options the clarify model proposed, kept only when the label fits a
 * WhatsApp button and the fields are a valid answer to this stage; the
 * safety option is always added last by code, never by the model.
 * Empty when none survive (the question then goes without buttons).
 */
export function modelClarifyOptions(
  drafts: { label: string; answer: Record<string, unknown> }[],
  stage: string,
  lang: string,
  bareNumber: number | null = null
): ClarifyOption[] {
  const safety = safetyOption(lang, bareNumber);
  const options: ClarifyOption[] = [];
  for (const d of drafts) {
    const label = d.label.replace(/\s+/g, ' ').trim();
    const fields = validJournalFields(stage, d.answer);
    if (!label || label.length > CLARIFY_LABEL_MAX || /[[\]{}<>]/.test(label) || !fields) continue;
    const key = label.toLowerCase();
    if (key === safety.label.toLowerCase() || options.some((o) => o.label.toLowerCase() === key)) continue;
    options.push({ label, fields });
    if (options.length === MAX_CLARIFY_OPTIONS - 1) break;
  }
  return options.length ? [...options, safety] : [];
}

const words = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean);

/**
 * A short sleep answer with one bare number and nothing saying which value
 * it is ("7", "It was a 7"): quality and hours both fit. Other stages ask
 * for one value, so a bare number there is simply the answer.
 */
export function bareSleepNumber(message: string): number | null {
  if (words(message).length > 5) return null;
  const parsed = parseSleepAnswer(message);
  if (parsed.quality != null || parsed.hours != null) return null;
  const nums = message.match(/\d+(?:\.\d+)?/g);
  if (!nums || nums.length !== 1) return null;
  const n = Number(nums[0]);
  return n >= 1 && n <= 10 ? n : null;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}/]+/gu, ' ').trim();

/** Which option she picked: a button title, its exact label, or its number. */
export function matchClarifyOption(message: string, options: ClarifyOption[]): number | null {
  const m = message.trim().match(/^\(?([1-9])[).]?$/);
  if (m) {
    const i = Number(m[1]) - 1;
    return i < options.length ? i : null;
  }
  const said = norm(message);
  const i = options.findIndex((o) => norm(o.label) === said);
  return i >= 0 ? i : null;
}

/** The text form of a question with options, for transports without buttons. */
export function withOptionList(body: string, labels: string[], lang: string): string {
  const list = labels.map((l, i) => `${i + 1}. ${l}`).join('\n');
  return `${body}\n\n${list}\n\n${t(lang, 'journal_clarify_hint')}`;
}
