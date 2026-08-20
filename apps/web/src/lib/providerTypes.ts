// Shapes for the PROVIDER portal (Stage B demo slice, P5-B) — read from
// scratchpad/PROVIDER_PORTAL_SPEC.md's "Web UI" section and API table,
// NOT from apps/server code the way lib/types.ts's mother-app shapes
// are (apps/web has no path alias into packages/core — see CLAUDE.md —
// and per the P5-B work split, apps/server's /provider routes are owned
// by a parallel work package that did not exist yet when this frontend
// was built). These are this frontend's best-faith reading of the
// spec's fixed API contract.
//
// Where the spec's shape is identical to something the mother app
// already has a type for (a plain {symptom,count}[] / {date,value}[]),
// this file reuses lib/types.ts's SymptomCount / SeriesPoint / Urgency
// instead of redeclaring them — only genuinely provider-only concepts
// get a new type here.

export type ProviderRole = "midwife" | "nurse" | "chv" | "doctor" | "admin";

export interface ProviderFacility {
  id: number;
  name: string;
  code: string;
}

export interface ProviderSessionUser {
  id: number;
  name: string;
  role: ProviderRole;
  facility: ProviderFacility;
}

export interface ProviderLoginResponse {
  token: string;
  provider: ProviderSessionUser;
}

export interface ProviderSummary {
  enrolledCount: number;
  activeCount: number;
  monthlyRevenueKes: number;
  annualRevenueKes: number;
  escalations7d: number;
}

export type RiskLevel = "high" | "moderate" | "low";
export type EnrollmentStatus = "active" | "ended";

// Safe to render WITHOUT `provider_access` consent (enrollment metadata
// only, per the spec). The clinical fields are present ONLY when
// consentGranted is true — the panel must never assume they exist.
export interface ProviderPanelRow {
  phone: string;
  displayName: string;
  enrolledAt: string;
  status: EnrollmentStatus;
  consentGranted: boolean;
  pregnancyWeek?: number | null;
  riskLevel?: RiskLevel;
  lastCheckInAt?: string | null;
  redFlags7d?: number;
}

export interface ProviderPatientsResponse {
  patients: ProviderPanelRow[];
}

// Mirrors packages/core/src/trend.ts's TrendSummary as it's documented
// to cross the wire on GET /provider/patients/detail ("Reuse
// packages/core/src/trend.ts — do NOT write new aggregation logic").
export interface ProviderTrendSummary {
  totalEntries: number;
  windowDays: number;
  distinctDaysJournaled: number;
  avgMood: number | null;
  avgSleepHours: number | null;
  avgWaterGlasses: number | null;
  recurringSymptoms: { symptom: string; days: number }[];
  redFlagDays: number;
}

export interface ProviderEscalation {
  urgency: string;
  createdAt: string;
}

// ONE genuine ambiguity in the spec, flagged rather than silently
// guessed past: the API table lists a single
// `dailySeries: [...] // computeDailySeries, 14d` field, but core's
// computeDailySeries (packages/core/src/trend.ts) produces ONE series
// per metric call — the existing GET /insights calls it twice (once for
// mood, once for sleep) into two separate top-level arrays
// (moodSeries/sleepSeries — see lib/types.ts's InsightsResponse). The
// provider spec's singular, non-plural field name reads more naturally
// as ONE merged per-day array, so that's what this type — and
// providerApi.ts's fetchProviderPatientDetail — assumes. If the real
// endpoint instead mirrors InsightsResponse's two-array shape, this is
// a small, isolated adapter to fix in one place (see providerApi.ts).
export interface ProviderDailyPoint {
  date: string;
  mood: number | null;
  sleepHours: number | null;
}

export interface ProviderPatientDetail {
  phone: string;
  displayName: string;
  pregnancyWeek: number | null;
  edd: string | null;
  riskLevel: RiskLevel;
  trend: ProviderTrendSummary | null;
  dailySeries: ProviderDailyPoint[];
  symptomCounts: { symptom: string; count: number }[];
  redFlagDates: string[];
  recentEscalations: ProviderEscalation[];
}

export interface ProviderEnrollResponse {
  enrolled: boolean;
  /** Whatever GET /provider/patients/detail's consent gate keys off —
   *  treated as a plain boolean-ish truthiness by the UI so a boolean
   *  OR a status string ("granted"/"pending") both render sensibly. */
  consentStatus: boolean | string;
}
