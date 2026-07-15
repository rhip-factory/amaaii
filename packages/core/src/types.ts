// Shared domain types for @amaaii/core.
//
// These mirror the actual string literals used throughout the existing
// JS services (dangerSigns.js, journalManager.js, messageHandler.js) —
// read from the code, not guessed. Keep this file free of any I/O
// (no database, no HTTP, no fs) so it can be imported from anywhere.

/** Two-letter language codes the bot currently supports. */
export type Lang = 'en' | 'sw';

/**
 * Overall urgency bucket produced by danger-sign detection. Note there
 * is no 'medium' or 'none' tier in the actual implementation — only
 * these four values are ever assigned.
 */
export type Urgency = 'critical' | 'high' | 'moderate' | 'low';

/** Mood classification returned by assessMood(). */
export type Mood = 'positive' | 'negative' | 'neutral';

/** Fixed vocabulary of symptom identifiers extractSymptoms() can return. */
export type Symptom =
  | 'nausea'
  | 'vomiting'
  | 'headache'
  | 'back_pain'
  | 'cramping'
  | 'bleeding'
  | 'swelling'
  | 'fatigue'
  | 'dizziness'
  | 'constipation'
  | 'heartburn'
  | 'insomnia';

/** A single danger sign matched inside a message. */
export interface DetectedSign {
  sign: string;
  level: 'critical' | 'high' | 'moderate';
}

/** Result of running detectDangerSigns() against a message. */
export interface DangerSignResult {
  detectedSigns: DetectedSign[];
  urgencyLevel: Urgency;
  requiresUrgentCare: boolean;
  recommendedAction: string;
}

/** Self-reported appetite level, as captured by the journal flow. */
export type AppetiteLevel = 'good' | 'moderate' | 'poor';

/**
 * Journal check-in stages, in the order the state machine visits them.
 * 'baby_movement' is only visited when pregnancyWeek >= 20 (see
 * nextJournalStage in journal.ts).
 */
export type JournalStage =
  | 'greeting'
  | 'continue'
  | 'mood'
  | 'symptoms'
  | 'sleep'
  | 'baby_movement'
  | 'water'
  | 'appetite'
  | 'questions'
  | 'notes'
  | 'completed';

/**
 * Shape of a row from the `journals` SQLite table (see
 * services/database.js). Loosely typed on purpose — this is a raw DB
 * row, and callers in this package only ever read a handful of columns.
 */
export interface JournalRow {
  id?: number;
  user_phone?: string;
  date: string;
  journal_stage?: string | null;
  physical_symptoms?: string | null;
  emotional_state?: number | null;
  mood_description?: string | null;
  energy_level?: number | null;
  sleep_quality?: number | null;
  sleep_hours?: number | null;
  appetite?: string | null;
  baby_movement_count?: number | null;
  baby_movement_time?: string | null;
  water_intake?: number | null;
  medications_taken?: string | null;
  questions_for_doctor?: string | null;
  special_notes?: string | null;
  red_flags_detected?: string | null;
  completed?: number | boolean | null;
  started_at?: string | null;
  completed_at?: string | null;
  timestamp?: string;
  /** Idempotency key set only by the PWA structured check-in form
   *  (POST /journal/entries, P2-C) — null for WhatsApp-originated rows. */
  client_entry_id?: string | null;
}

/** Aggregate row shape returned by db.getJournalAnalytics(). */
export interface JournalAnalytics {
  avg_mood?: number | null;
  avg_energy?: number | null;
  avg_sleep?: number | null;
  avg_water?: number | null;
  journal_count: number;
  red_flag_days: number;
}

/** A symptom that recurred across the trend window, with a day count. */
export interface RecurringSymptom {
  symptom: string;
  days: number;
}

/** One point of a per-day averaged series (Insights mood/sleep charts). */
export interface DailySeriesPoint {
  /** YYYY-MM-DD, matches journals.date. */
  date: string;
  value: number;
}

/** One bar of the Insights "common symptoms" chart. */
export interface SymptomFrequency {
  /** Human-readable (underscores replaced with spaces), e.g. "back pain". */
  symptom: string;
  count: number;
}

/** Rolled-up recent-history summary produced by computeTrend(). */
export interface TrendSummary {
  windowDays: number;
  totalEntries: number;
  completedEntries: number;
  distinctDaysJournaled: number;
  avgMood: number | null;
  avgSleepHours: number | null;
  avgSleepQuality: number | null;
  avgWaterGlasses: number | null;
  redFlagDays: number;
  recurringSymptoms: RecurringSymptom[];
  lastMood: number | null;
  yesterdaySymptoms: string[];
  yesterdayMood: number | null;
  yesterdayFlagged: boolean;
}
