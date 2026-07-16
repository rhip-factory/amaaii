// Shapes mirrored from apps/server/src/app.ts (read directly — do not
// invent fields). See also public/app.js, which drives the same API.

export type Language = "en" | "sw";
export type Urgency = "critical" | "high" | "moderate" | "low";

export interface SessionUser {
  phone: string;
}

export interface LoginResponse {
  token: string;
  user: SessionUser;
}

export interface ApiErrorBody {
  error?: string;
  message?: string;
}

export interface MeUser {
  phone: string;
  name: string | null;
  age: number | null;
  pregnancy_week: number | null;
  edd: string | null;
  location: string | null;
  language: Language;
  trimester: string | null;
}

export interface TodayJournal {
  completed: boolean;
  emotional_state: number | null;
  sleep_hours: number | null;
  water_intake: number | null;
  appetite: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface TrendSummary {
  totalEntries: number;
  windowDays: number;
  distinctDaysJournaled: number;
  avgMood: number | null;
  avgSleepHours: number | null;
  avgWaterGlasses: number | null;
  recurringSymptoms: { symptom: string; days: number }[];
  redFlagDays: number;
}

export interface MeResponse {
  user: MeUser;
  todayJournal: TodayJournal | null;
  todayCheckinCount?: number;
  weekDescription: string | null;
  tip: { headline: string; body: string } | null;
  trend?: TrendSummary;
}

export interface ProfileUpdate {
  name?: string;
  age?: number;
  pregnancy_week?: number;
  location?: string;
  language?: Language;
}

export interface ChatRequest {
  message: string;
}

export interface ChatResponse {
  response: string;
  urgencyLevel: Urgency;
  context?: unknown;
}

export interface HistoryRow {
  label: string;
  value: string;
}

export interface HistoryDay {
  label: string;
  rows: HistoryRow[];
}

export interface HistoryResponse {
  days: HistoryDay[];
}

// Client-side chat transcript entry (the /chat and /history endpoints
// don't share one shape, so the UI normalizes into this for rendering).
export interface ChatMessage {
  id: string;
  role: "user" | "bot";
  text: string;
  urgency?: Urgency;
  timestamp: string;
}

// --- Structured journal check-in form (P2-C) --------------------------------
// Shapes mirrored from apps/server/src/app.ts's POST /journal/entries,
// GET /journal/today, GET /journal/entries — read directly, not invented.

export type Appetite = "good" | "moderate" | "poor";

export interface JournalEntryInput {
  mood: number;
  symptoms: string[];
  symptomsText?: string;
  sleepHours: number;
  appetite: Appetite;
  babyMovement?: number;
  note?: string;
  clientEntryId: string;
}

export interface JournalEntry {
  id: number;
  date: string;
  clientEntryId: string | null;
  mood: number | null;
  symptoms: string[];
  symptomsText: string | null;
  sleepHours: number | null;
  appetite: string | null;
  babyMovement: number | null;
  note: string | null;
  hasRedFlags: boolean;
  completed: boolean;
  startedAt: string | null;
  completedAt: string | null;
}

export interface JournalEntrySubmitResponse {
  entry: JournalEntry;
  deduped: boolean;
  urgencyLevel: Urgency;
  escalation?: string;
}

export interface JournalTodayResponse {
  entries: JournalEntry[];
  count: number;
}

export interface JournalHistoryDay {
  date: string;
  entries: JournalEntry[];
}

export interface JournalHistoryResponse {
  days: JournalHistoryDay[];
}

// --- Insights (P2-E) ---------------------------------------------------------
// Shapes mirrored from apps/server/src/app.ts's GET /insights (which passes
// through packages/core/src/trend.ts's computeTrend / computeDailySeries /
// computeSymptomCounts / computeRedFlagDates output).

export type InsightsWindow = 14 | 30;

/** One per-day averaged observation (multiple same-day check-ins are
 *  averaged server-side — see computeDailySeries in core). */
export interface SeriesPoint {
  /** YYYY-MM-DD (UTC), matches journals.date. */
  date: string;
  value: number;
}

export interface SymptomCount {
  /** Humanized (underscores already replaced), e.g. "back pain". */
  symptom: string;
  count: number;
}

export interface InsightsResponse {
  window: InsightsWindow;
  /** Completed check-ins in the window (mirrors GET /me's todayCheckinCount semantics). */
  checkinsCount: number;
  /** Core computeTrend output (completed-only averages); null when no history. */
  trend: TrendSummary | null;
  moodSeries: SeriesPoint[];
  sleepSeries: SeriesPoint[];
  /** Top 6 by count. */
  symptomCounts: SymptomCount[];
  /** Distinct YYYY-MM-DD dates with any red-flagged check-in, ascending. */
  redFlagDates: string[];
}
