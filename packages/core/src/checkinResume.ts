// A daily check-in left half-way is paused, not thrown away: she asked a
// question, changed the subject, reported a danger sign or simply went
// quiet. It waits until she taps Resume (back to the question she stopped
// at), Restart (today's answers cleared) or Stop, and stays resumable
// until midnight in Nairobi. These helpers build what she sees about it.
// Pure, no I/O.

import { t } from './i18n';
import { formatSymptoms } from './journal';

/** The answers saved so far, as the session blob / journals row holds them. */
export interface CheckinSoFar {
  emotional_state?: number | null;
  physical_symptoms?: string | null;
  sleep_quality?: number | null;
  sleep_hours?: number | null;
  baby_movement_count?: number | null;
  water_intake?: number | null;
  appetite?: string | null;
  questions_for_doctor?: string | null;
}

const present = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

/** "Mood 6/10 · Symptoms: nausea · Sleep 1/10, 0.5 hours", or "nothing yet". */
export function checkinSoFar(data: CheckinSoFar, lang: string): string {
  const parts: string[] = [];
  if (present(data.emotional_state)) parts.push(t(lang, 'checkin_mood', { n: data.emotional_state as number }));
  if (present(data.physical_symptoms)) {
    parts.push(t(lang, 'checkin_symptoms', { list: formatSymptoms(data.physical_symptoms, lang) }));
  }
  const sleep: string[] = [];
  if (present(data.sleep_quality)) sleep.push(t(lang, 'checkin_sleep_quality', { q: data.sleep_quality as number }));
  if (present(data.sleep_hours)) sleep.push(t(lang, 'checkin_sleep_hours', { h: data.sleep_hours as number }));
  if (sleep.length) parts.push(t(lang, 'checkin_sleep', { detail: sleep.join(', ') }));
  if (present(data.baby_movement_count)) parts.push(t(lang, 'checkin_movement', { n: data.baby_movement_count as number }));
  if (present(data.water_intake)) parts.push(t(lang, 'checkin_water', { n: data.water_intake as number }));
  if (present(data.appetite)) {
    parts.push(t(lang, 'checkin_appetite', { level: t(lang, `appetite_${data.appetite}`) }));
  }
  if (present(data.questions_for_doctor)) parts.push(t(lang, 'checkin_questions'));
  return parts.length ? parts.join(' · ') : t(lang, 'journal_sofar_none');
}

// A session waiting on 'greeting' or 'continue' has asked nothing yet; its
// next question is the mood one.
const askedStage = (stage: string): string => (stage === 'greeting' || stage === 'continue' ? 'mood' : stage);

/** The next question's topic, e.g. "sleep". */
export function checkinStageLabel(stage: string, lang: string): string {
  return t(lang, `stage_${askedStage(stage)}`);
}

const STAGE_QUESTION: Record<string, string> = {
  mood: 'journal_mood_q',
  symptoms: 'journal_symptoms_q',
  sleep: 'journal_sleep_q',
  baby_movement: 'journal_baby_movement_q',
  water: 'journal_water_q',
  appetite: 'journal_appetite_q',
  questions: 'journal_questions_q',
  notes: 'journal_notes_q',
};

/** The question a resumed check-in asks again. */
export function checkinStageQuestion(stage: string, lang: string): string {
  return t(lang, STAGE_QUESTION[askedStage(stage)] ?? 'journal_mood_q');
}

/** The paused card: what's saved, what's next, and the buttons' words. */
export function checkinPausedCard(
  data: CheckinSoFar,
  stage: string,
  lang: string,
  key: 'journal_paused_card' | 'journal_pending_card' = 'journal_paused_card'
): string {
  return t(lang, key, { sofar: checkinSoFar(data, lang), next: checkinStageLabel(stage, lang) });
}

const NAIROBI_OFFSET_MS = 3 * 60 * 60 * 1000; // EAT, UTC+3, no daylight saving

function nairobiDay(ms: number): string {
  return new Date(ms + NAIROBI_OFFSET_MS).toISOString().slice(0, 10);
}

/** A paused check-in can be resumed until midnight in Nairobi on the day it
 *  started. `startedMs` null (unknown) counts as today. */
export function checkinStillResumable(startedMs: number | null, now: Date): boolean {
  if (startedMs == null) return true;
  return nairobiDay(startedMs) === nairobiDay(now.getTime());
}
