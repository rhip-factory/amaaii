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

// Mirrors packages/core/src/triage.ts's TriageResult#band exactly.
// Priority order per the P6 spec: 'urgent' > 'watch' > 'ok'.
export type TriageBand = "urgent" | "watch" | "ok";

// Mirrors packages/core/src/triage.ts's TriageResult, and the exact wire
// shape apps/server/src/app.ts's buildPatientPanelRow attaches as
// `row.triage` (confirmed by reading that function directly — not a
// guess). `reasons` are plain clinical phrases from assessTriage(),
// verbatim (never empty — a mother with nothing flagged still gets
// "No concerns flagged recently") — render them as-is, never invent new
// ones here. `score` exists ONLY as a client-side sort key (see
// sortForTriageQueue in page.tsx) — the UI must NEVER render this number,
// only `band` (the "Needs attention" grouping/badge) and `reasons`.
export interface ProviderTriage {
  score: number;
  band: TriageBand;
  reasons: string[];
}

// Safe to render WITHOUT `provider_access` consent (enrollment metadata
// only, per the spec). The clinical fields — including `triage` — are
// present ONLY when consentGranted is true; a non-consenting row's
// triage is unknowable, not absent-meaning-fine.
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
  triage?: ProviderTriage;
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

// ---------------------------------------------------------------------
// P6 — escalation feed (GET /provider/escalations, POST /provider/escalations/ack)
// ---------------------------------------------------------------------

// Only enrolled AND consented mothers ever appear here (server-enforced),
// so unlike ProviderPanelRow every field is always present.
export interface ProviderEscalationFeedItem {
  phone: string;
  displayName: string;
  /** Only 'critical' | 'high' are ever recorded (auditDangerEscalation's
   *  own funnel), but kept as `string` — same looseness as the existing
   *  ProviderEscalation#urgency above — so an unexpected value degrades
   *  to UrgencyBadge's neutral "other" style instead of a type error. */
  urgency: string;
  /** The audit row's created_at — also the natural key POSTed back as
   *  `escalationAt` on acknowledge (see escalation_acks' UNIQUE constraint). */
  createdAt: string;
  acknowledged: boolean;
  /** providers.id per the escalation_acks schema — a raw id, not a name,
   *  so the UI only ever renders "acknowledged by you" (compares against
   *  the signed-in provider's own id) rather than inventing a name for
   *  someone else's id it has no directory to resolve. */
  acknowledgedBy?: number;
  acknowledgedAt?: string;
}

// Confirmed against apps/server/src/app.ts's GET /provider/escalations
// handler (`res.json({ escalations: items })`) — not a guess.
// fetchProviderEscalations in providerApi.ts also accepts a bare array
// defensively, which costs nothing if this ever changes.
export interface ProviderEscalationsResponse {
  escalations: ProviderEscalationFeedItem[];
}

// POST body for /provider/escalations/ack.
export interface ProviderAckEscalationRequest {
  phone: string;
  escalationAt: string;
}

// Confirmed against the same route's ack handler
// (`res.json({ acknowledged: true, acknowledgedBy: ack.acknowledgedBy,
// acknowledgedAt: ack.acknowledgedAt })`) — always present on success.
// Still merged with an optimistic client-side fallback in the escalations
// page's handleAck as defense in depth, not because this is uncertain.
export interface ProviderAckEscalationResponse {
  acknowledged: boolean;
  acknowledgedBy: number;
  acknowledgedAt: string;
}

// ---------------------------------------------------------------------
// P6 — cohort analytics (GET /provider/cohort)
// ---------------------------------------------------------------------

// Small-cell suppression (core's MIN_COHORT_N, currently 5 per the spec —
// read `minimumN` off the response rather than hard-coding it here, so
// this UI stays correct if the backend's threshold ever changes).
export interface ProviderCohortSuppressed {
  suppressed: true;
  minimumN: number;
  cohortSize: number;
}

export interface ProviderCohortGestationalBuckets {
  first: number;
  second: number;
  third: number;
}

// Confirmed against packages/core/src/cohort.ts's CohortStats — field for
// field. NEVER carries per-mother data (no phones, no names, no per-row
// arrays) — aggregate-only by construction, safe to project.
export interface ProviderCohortStats {
  suppressed: false;
  cohortSize: number;
  ancAdherencePct: number;
  avgMood: number | null;
  avgSleepHours: number | null;
  checkInRatePct: number;
  redFlagMothers: number;
  gestationalBuckets: ProviderCohortGestationalBuckets;
}

export type ProviderCohortResponse = ProviderCohortSuppressed | ProviderCohortStats;
