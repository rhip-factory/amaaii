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
