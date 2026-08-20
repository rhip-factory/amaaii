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

// --- Consent (P3-D) -----------------------------------------------------
// Shapes mirrored from apps/server/src/app.ts's GET/POST /me/consent and
// POST /me/consent/revoke (which in turn mirror packages/core/src/
// consent.ts's ConsentPurpose/buildConsentView). Read directly, not
// invented — see CLAUDE.md's "Repository pattern" / consent notes.

// provider_access (Stage B) gates whether a healthcare facility the mother
// is enrolled with may open her clinical record. Optional tier: declining
// leaves every mother-facing feature working, it only keeps the hospital out.
export type ConsentPurpose = "data_processing" | "ai_responses" | "provider_access";

export interface ConsentPurposeView {
  purpose: ConsentPurpose;
  granted: boolean;
  /** Active RIGHT NOW at the current CONSENT_VERSION — false for a
   *  never-granted, revoked, OR stale (old-version) purpose. */
  active: boolean;
  version: number | null;
}

export interface ConsentResponse {
  version: number;
  needsConsent: boolean;
  isStale: boolean;
  purposes: ConsentPurposeView[];
  canUseAi: boolean;
  /** Present only on POST /me/consent/revoke of data_processing. */
  note?: string;
}

export interface ConsentGrants {
  data_processing?: boolean;
  ai_responses?: boolean;
  provider_access?: boolean;
}

// --- Activity / audit log (P3-D) -----------------------------------------
// Shapes mirrored from apps/server/src/app.ts's GET /me/activity, which
// passes AuditEvent rows (packages/core/src/repositories.ts) straight
// through — metadata stays a JSON string here; the UI parses it lazily
// per-event only when rendering needs a field out of it.

export type AuditAction =
  | "read"
  | "write"
  | "delete"
  | "export"
  | "ai_call"
  | "consent_grant"
  | "consent_revoke"
  | "danger_escalation"
  | "login";

export type AuditResource =
  | "profile"
  | "journal"
  | "conversation"
  | "medical_history"
  | "insights"
  | "consent"
  | "account";

export interface AuditEvent {
  id: number;
  actor: string;
  action: AuditAction;
  resource: AuditResource;
  resource_owner: string;
  metadata: string | null;
  created_at: string;
}

export interface ActivityResponse {
  events: AuditEvent[];
}

export interface DeleteAccountResponse {
  deleted: boolean;
  message: string;
}

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
