// Repository interfaces mirroring services/database.js's real operations
// and row shapes (P1-C: repository pattern + Postgres-ready seam — see
// CLAUDE.md). Types only: no sqlite3, no I/O, nothing that touches a
// filesystem or network. A concrete adapter (packages/adapters/src/sqlite
// today; a future packages/adapters/src/postgres/ tomorrow) implements
// these against a real store.
//
// Every method signature here is a 1:1 mirror of the corresponding
// function currently exported by services/database.js — same argument
// order, same optional/defaulted params, same resolved shape (including
// the undefined-vs-null distinctions sqlite3's callback API produces).
// Do not "clean up" a signature here without also updating the adapter
// and the services/database.js shim that delegates to it.

import type { JournalRow, JournalAnalytics } from './types';
import type { ConsentPurpose } from './consent';
import type { JobStatus } from './jobs';

// --- Users ------------------------------------------------------------

/**
 * Row shape of the `users` table (see initializeDatabase() in
 * services/database.js for the canonical CREATE TABLE / migrations).
 */
export interface UserRow {
  phone_number: string;
  name: string | null;
  age: number | null;
  pregnancy_week: number | null;
  edd: string | null;
  location: string | null;
  risk_level: string;
  lmp: string | null;
  anc_visits: number;
  language: string;
  created_at: string;
  updated_at: string;
}

/**
 * Input accepted by createUser(). The UI / Twilio occasionally sends
 * `pregnancyWeek` camelCase — the real implementation maps it to the
 * snake_case `pregnancy_week` column (see USER_FIELD_MAP).
 */
export interface CreateUserInput {
  name?: string;
  age?: number;
  pregnancyWeek?: number;
  pregnancy_week?: number;
  edd?: string | null;
  location?: string;
  lmp?: string | null;
  risk_level?: string;
  anc_visits?: number;
  language?: string;
}

/**
 * Input accepted by updateUser(). Only these keys are allowed — anything
 * else must reject with an Error (the UPDATE_USER_ALLOWED whitelist in
 * services/database.js; defense in depth against SQL-identifier
 * injection via user-controlled keys).
 */
export interface UpdateUserInput {
  name?: string;
  age?: number;
  pregnancy_week?: number;
  edd?: string | null;
  location?: string;
  lmp?: string | null;
  risk_level?: string;
  anc_visits?: number;
  language?: string;
}

export interface UserRepository {
  /**
   * Upsert-ish create: if the phone number already has a row, only the
   * provided fields are UPDATEd (never nulls out columns the caller
   * didn't pass — see commit 5c22647 / D15). Otherwise INSERTs a fresh
   * row. Resolves the new row's `lastID` on the insert path; on the
   * update path resolves `existing.rowid` if present — which, because
   * `phone_number` is a TEXT PRIMARY KEY (not an alias for SQLite's
   * implicit rowid), is never actually present on a `SELECT *` row, so
   * in practice this branch always resolves `null`. Preserved as-is;
   * nothing in the codebase depends on this return value.
   */
  createUser(phoneNumber: string, userData?: CreateUserInput): Promise<number | null>;
  getUser(phoneNumber: string): Promise<UserRow | undefined>;
  /** Rejects with an Error if `updates` contains any non-whitelisted key. */
  updateUser(phoneNumber: string, updates: UpdateUserInput): Promise<number>;
}

// --- Conversations ------------------------------------------------------

/** Row shape of the `conversations` table. */
export interface ConversationRow {
  id: number;
  user_phone: string;
  message: string | null;
  response: string | null;
  /** JSON-stringified array of detected danger signs. */
  danger_signs_detected: string | null;
  urgency_level: string | null;
  context: string | null;
  timestamp: string;
}

export interface ConversationAnalysis {
  dangerSigns?: unknown[];
  urgencyLevel?: string;
  context?: string;
}

export interface LastBotMessageRow {
  response: string;
  context: string | null;
}

export interface ConversationRepository {
  saveConversation(
    userPhone: string,
    message: string,
    response: string,
    analysis?: ConversationAnalysis
  ): Promise<number>;
  getConversationHistory(userPhone: string, limit?: number): Promise<ConversationRow[]>;
  getLastBotMessage(userPhone: string): Promise<LastBotMessageRow | null>;
  /**
   * ALL conversation rows for this user, oldest first (unlike
   * getConversationHistory's newest-first + LIMIT, which exists to feed
   * the AI prompt's last-N-turns window). P3-C data-portability export
   * (GET /me/export) is the only caller — a data-subject's "complete
   * data" view needs every row, not a capped recent slice.
   */
  getAllForUser(userPhone: string): Promise<ConversationRow[]>;
}

// --- Journals -------------------------------------------------------------

/** Patch applied to a `journals` row — only whitelisted columns
 *  (JOURNAL_COLUMNS in services/database.js) are ever written. */
export type JournalPatch = Partial<Omit<JournalRow, 'id' | 'user_phone' | 'date' | 'timestamp'>>;

export interface JournalRepository {
  /**
   * `journalId == null` always INSERTs a fresh row (multi-checkin
   * support: each `journal` command after a previous completion opens a
   * new row); a truthy `journalId` UPDATEs that row instead. Resolves
   * the row id either way.
   */
  createOrUpdateJournal(
    userPhone: string,
    journalData: JournalPatch,
    journalId?: number | null
  ): Promise<number>;
  /** Most recent journal row for *today* (in-progress or completed). */
  getTodaysJournal(userPhone: string): Promise<JournalRow | undefined>;
  /** All of today's journal rows, oldest first. */
  getTodaysJournals(userPhone: string): Promise<JournalRow[]>;
  getJournalHistory(userPhone: string, days?: number): Promise<JournalRow[]>;
  getJournalAnalytics(userPhone: string, days?: number): Promise<JournalAnalytics>;
  /**
   * Idempotency lookup for the PWA structured check-in form (P2-C):
   * finds the journal row previously written for this (userPhone,
   * clientEntryId) pair, if any — backed by the partial UNIQUE index on
   * journals(user_phone, client_entry_id). Returns undefined when no
   * such row exists (including for WhatsApp-originated rows, which never
   * set client_entry_id).
   */
  findByClientEntryId(userPhone: string, clientEntryId: string): Promise<JournalRow | undefined>;
  /**
   * ALL journal rows for this user, oldest first — unlike
   * getJournalHistory's `days`-windowed query (which backs trend/insights
   * charts with a fixed lookback), this ignores date entirely. P3-C
   * data-portability export (GET /me/export) is the only caller.
   */
  getAllForUser(userPhone: string): Promise<JournalRow[]>;
}

// --- Journal sessions -------------------------------------------------------

/** In-memory shape of a journal session, as returned by
 *  getJournalSession() — note the camelCase remap from the
 *  `journal_sessions` table's snake_case columns. */
export interface JournalSession {
  currentStage: string;
  journalData: Record<string, unknown>;
  journalId: number | null;
  channel: string;
  startedAt: string;
  updatedAt: string;
}

export interface JournalSessionInput {
  currentStage: string;
  journalData: Record<string, unknown>;
  journalId?: number | null;
  channel?: string;
}

export interface JournalSessionRepository {
  getJournalSession(userPhone: string): Promise<JournalSession | null>;
  upsertJournalSession(userPhone: string, input: JournalSessionInput): Promise<number>;
  deleteJournalSession(userPhone: string): Promise<number>;
}

// --- Symptoms ---------------------------------------------------------------

/**
 * Row shape of the `symptoms` table — WhatsApp free-text danger-sign
 * detections (distinct from `journals.physical_symptoms`, which is the
 * structured daily check-in's own symptom field). `symptoms` is a
 * JSON-stringified array, same encoding saveSymptoms() writes.
 */
export interface SymptomRow {
  id: number;
  user_phone: string;
  symptoms: string | null;
  mood: string | null;
  urgency: string | null;
  timestamp: string;
}

export interface SymptomRepository {
  saveSymptoms(
    userPhone: string,
    symptoms: unknown[],
    mood: string,
    urgency: string
  ): Promise<number>;
  /**
   * ALL symptom rows for this user, oldest first. No prior reader of this
   * table existed before P3-C — GET /me/export (data-portability) is the
   * first and only caller.
   */
  getAllForUser(userPhone: string): Promise<SymptomRow[]>;
}

// --- Medical history ---------------------------------------------------------

export interface MedicalHistoryInput {
  rawText?: string | null;
  extracted?: Record<string, unknown>;
}

/** getMedicalHistory() spreads the parsed `extracted_json` blob directly
 *  onto the result alongside `rawText`/`updatedAt` — so this is
 *  intentionally open-ended, not a fixed column set. */
export interface MedicalHistoryRecord {
  rawText: string | null;
  updatedAt: string;
  [key: string]: unknown;
}

export interface MedicalHistoryRepository {
  getMedicalHistory(userPhone: string): Promise<MedicalHistoryRecord | null>;
  saveMedicalHistory(userPhone: string, input: MedicalHistoryInput): Promise<number>;
}

// --- ANC visits ---------------------------------------------------------------

/** Row shape of the `anc_visits` table. */
export interface AncVisitRow {
  id: number;
  user_phone: string;
  scheduled_date: string;
  attended: number;
  notes: string | null;
  created_at: string;
}

export interface AncVisitRepository {
  scheduleANCVisit(userPhone: string, scheduledDate: string, notes?: string): Promise<number>;
  getUpcomingANCVisits(userPhone: string): Promise<AncVisitRow[]>;
  markANCVisitAttended(visitId: number): Promise<number>;
  /**
   * ALL ANC visit rows for this user (upcoming, past, attended or not) —
   * unlike getUpcomingANCVisits' `attended = 0 AND scheduled_date >=
   * today` filter. P3-C data-portability export (GET /me/export) is the
   * only caller.
   */
  getAllForUser(userPhone: string): Promise<AncVisitRow[]>;
}

// --- OTP codes (P2-B) --------------------------------------------------------

/** Row shape of the `otp_codes` table (one row per phone; a fresh
 *  /auth/otp/request always replaces the previous row wholesale — see
 *  OtpRepository#createOrReplace). `sentTimestamps` is the rolling send
 *  history used for rate limiting (packages/core/src/otp.ts), decoded
 *  from the adapter's JSON-array column back into `string[]` here. */
export interface OtpRecord {
  phone: string;
  codeHash: string;
  expiresAt: string;
  attempts: number;
  sentTimestamps: string[];
  createdAt: string;
  updatedAt: string;
}

export interface OtpRepository {
  /**
   * Wholesale-replaces any existing OTP row for `phone`: new `codeHash`
   * / `expiresAt`, `attempts` reset to 0, `sentTimestamps` set to
   * exactly the array passed in. This method is pure persistence — the
   * caller is expected to have already computed the post-prune,
   * post-append array via packages/core/src/otp.ts#pruneSentTimestamps
   * (mirrors the rest of this file: repositories store data, they don't
   * decide rate-limit windows).
   */
  createOrReplace(
    phone: string,
    codeHash: string,
    expiresAt: string,
    sentTimestamps: string[]
  ): Promise<void>;
  get(phone: string): Promise<OtpRecord | null>;
  /** Increments `attempts` by 1 and returns the new (post-increment) count. */
  recordAttempt(phone: string): Promise<number>;
  delete(phone: string): Promise<void>;
}

// --- Consent (P3-A / Kenya DPA) ----------------------------------------------

/**
 * One row of the append-only consent ledger — never UPDATEd. A grant is
 * a fresh row with granted=1 and revoked_at=NULL. An outright decline
 * of an OPTIONAL purpose is also a fresh row, granted=0, revoked_at
 * still NULL (it was never active, so there's nothing to mark as
 * "revoked"). Withdrawing a *previously active* consent is ALSO a fresh
 * row — granted=0, but this one has revoked_at stamped on itself at
 * insert time (see ConsentRepository#revokeConsent) — which is how the
 * ledger tells "declined from the start" apart from "granted, then
 * later withdrawn" for audit purposes, without ever mutating a prior
 * row. Current state for a purpose is always just its most recent row;
 * see packages/core/src/consent.ts#deriveConsentState for the
 * (oldest-first-in, latest-wins) reconstruction.
 */
export interface ConsentRecord {
  id: number;
  user_phone: string;
  purpose: ConsentPurpose;
  /** SQLite stores this as 0/1; deriveConsentState() coerces either
   *  representation to a real boolean. */
  granted: number | boolean;
  version: number;
  granted_at: string;
  revoked_at: string | null;
}

export interface ConsentRepository {
  /** Every ledger row for this user, oldest first — feed straight into
   *  packages/core/src/consent.ts#deriveConsentState to get the current
   *  ConsentState. Empty array for a user who has never been asked. */
  getConsents(phone: string): Promise<ConsentRecord[]>;
  /**
   * Appends one new event to the ledger — never an UPDATE, so the full
   * history stays auditable (who consented to what, when, at which
   * notice version). Used for both an initial grant (granted=true) and
   * an outright decline of an OPTIONAL purpose (granted=false); either
   * way this call leaves revoked_at NULL on the new row — that's what
   * distinguishes it from revokeConsent() below.
   */
  recordConsent(
    phone: string,
    purpose: ConsentPurpose,
    granted: boolean,
    version: number
  ): Promise<ConsentRecord>;
  /**
   * Appends a withdrawal event for a purpose the user had previously
   * granted: a new row with granted=false AND revoked_at stamped on
   * that same new row (not a mutation of the earlier grant row) — keeps
   * the ledger append-only while still recording "this was actively
   * revoked", not just "never granted".
   */
  revokeConsent(phone: string, purpose: ConsentPurpose): Promise<void>;
}

// --- Audit log (P3-A / Kenya DPA) --------------------------------------------

/** What kind of thing happened. 'consent_grant'/'consent_revoke' log the
 *  consent ledger's own events into the audit trail too (belt-and-braces
 *  — the consent table is itself append-only and auditable, but a
 *  data-subject's unified "what happened to my data" view should not
 *  have to know to cross-reference two tables). */
export type AuditAction =
  | 'read'
  | 'write'
  | 'delete'
  | 'export'
  | 'ai_call'
  | 'consent_grant'
  | 'consent_revoke'
  | 'danger_escalation'
  | 'login';

/** What kind of data the action touched. */
export type AuditResource =
  | 'profile'
  | 'journal'
  | 'conversation'
  | 'medical_history'
  | 'insights'
  | 'consent'
  | 'account';

/**
 * Row shape of the `audit_log` table — append-only, one row per
 * data-touching event. `resource_owner` is the phone number the DATA
 * belongs to (the data subject); `actor` is who/what performed the
 * action (may be the same phone for a self-service action, or a
 * system-level identifier like "system" for an automated danger
 * escalation) — that distinction is what makes listForUser() a genuine
 * "who accessed MY data" view rather than merely "what did I do".
 */
export interface AuditEvent {
  id: number;
  actor: string;
  action: AuditAction;
  resource: AuditResource;
  resource_owner: string;
  /** JSON-stringified free-form context, or null. */
  metadata: string | null;
  created_at: string;
}

/** Input to AuditRepository#record — everything except the id/created_at
 *  the store assigns (unless `timestamp` is passed explicitly, e.g. by
 *  a test that wants a deterministic row). */
export interface AuditEventInput {
  actor: string;
  action: AuditAction;
  resource: AuditResource;
  resourceOwner: string;
  /** Arbitrary JSON-serializable context (e.g. which fields were read).
   *  Repository implementations own the JSON.stringify/parse round-trip
   *  — callers pass/receive a plain object, never a pre-serialized
   *  string. */
  metadata?: Record<string, unknown> | null;
  /** ISO timestamp. Storage layer defaults to "now" when omitted. */
  timestamp?: string;
}

export interface AuditRepository {
  /** Appends one audit row. Append-only — there is no update/delete
   *  method on this interface by design. */
  record(event: AuditEventInput): Promise<void>;
  /** Events for this user's data, newest first — the data-subject-facing
   *  "who accessed my data" view. Defaults to a reasonable page size
   *  when `limit` is omitted (see the adapter for the exact default). */
  listForUser(phone: string, limit?: number): Promise<AuditEvent[]>;
}

// --- Jobs (P4-A durable queue) -----------------------------------------------
//
// Replaces the in-process `setTimeout(..., 3600000)` follow-up
// apps/server/src/messageHandler.ts#handleIncomingMessage used to
// schedule directly (see CLAUDE.md's Architecture section, which
// documented that as explicitly deferred future work). Backed by
// SQLite today (packages/adapters/src/sqlite/jobRepository.ts); the
// pure scheduling/retry policy this repository leans on lives in
// packages/core/src/jobs.ts (computeBackoff/nextRunAt/shouldRetry/isDue)
// — this interface is storage only, same split as every other
// repository in this file.

/** Row shape of the `jobs` table. `payload` is a JSON-stringified
 *  object — repositories store/return the raw string (same "adapter
 *  doesn't parse it for you" convention as MedicalHistoryRecord's
 *  extracted_json); callers (job handlers) JSON.parse it themselves. */
export interface JobRecord {
  id: number;
  type: string;
  payload: string;
  /** ISO timestamp — when this job becomes eligible to run. */
  runAt: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  /** ISO timestamp of the current claim, or null when not claimed. */
  lockedAt: string | null;
  /** Opaque claim token identifying which claimDueJobs() call currently
   *  holds this job (see the SQLite adapter for the exact format) — not
   *  just a bare worker id, so two calls that happen to share a worker
   *  id can never be confused with one another. Null when not claimed. */
  lockedBy: string | null;
  /** Idempotent-enqueue key, or null for jobs that don't need one. See
   *  JobRepository#enqueue. */
  dedupeKey: string | null;
  /**
   * P4-B (DPA erasure gap fix): the phone this job is FOR, when
   * derivable — populated by the adapter's enqueue() from
   * `input.payload.phone` when that field is a string (e.g. the
   * checkin_followup job's `{ phone }` payload), null otherwise. Exists
   * so DELETE /me/account's erasure cascade (packages/adapters/src/
   * sqlite/erasure.ts) can clear a user's pending jobs the same way it
   * clears every other user-data table, without needing to
   * JSON.parse(payload) and guess its shape per job type. Not every job
   * type necessarily has a phone-shaped payload — this is best-effort,
   * not a schema guarantee.
   */
  userPhone: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueJobInput {
  type: string;
  /** Plain object — the repository owns the JSON.stringify round-trip
   *  (same convention as AuditEventInput#metadata). */
  payload: Record<string, unknown>;
  /** ISO timestamp this job becomes due. */
  runAt: string;
  maxAttempts?: number;
  /** When provided, a second enqueue() with the same key is a no-op that
   *  returns the ALREADY-EXISTING row instead of inserting a duplicate —
   *  see enqueue()'s doc comment below for the exact semantics. */
  dedupeKey?: string | null;
}

export interface JobRepository {
  /**
   * Inserts a new job, unless `input.dedupeKey` is set AND a row with
   * that same key already exists — in which case this is a no-op that
   * resolves the EXISTING row (not a fresh insert, not an error). This
   * is what lets a caller "enqueue" from a code path that might run more
   * than once for the same logical event (e.g. a retried webhook)
   * without ever double-scheduling.
   */
  enqueue(input: EnqueueJobInput): Promise<JobRecord>;
  /**
   * Atomically claims up to `limit` due jobs (status='pending' AND
   * run_at <= now), flips them to status='running' with `locked_at`/
   * `locked_by` stamped, and returns exactly the rows THIS call
   * successfully claimed. Safe against a second concurrent caller (same
   * or different process) claiming the same row twice — see the SQLite
   * adapter's file header for the exact mechanism and its limits.
   */
  claimDueJobs(now: string, limit: number, workerId: string): Promise<JobRecord[]>;
  /** Marks a claimed job as permanently succeeded; clears its lock. */
  markDone(id: number): Promise<void>;
  /**
   * Records a handler failure for a claimed job: increments `attempts`,
   * then either requeues it (status back to 'pending', `run_at` pushed
   * out per packages/core/src/jobs.ts#nextRunAt, lock cleared) or marks
   * it permanently 'failed' (per packages/core/src/jobs.ts#shouldRetry
   * against the row's own `max_attempts`). `error` is stored verbatim in
   * `last_error` — callers must pass an already-redacted message if the
   * failure could contain PII (mirrors the rest of this codebase's
   * "redact before it reaches a log/store" discipline).
   */
  markFailedOrRetry(id: number, error: string, now: string): Promise<void>;
  /**
   * Requeues jobs stuck in 'running' for longer than `staleMs` — the
   * restart-recovery mechanism for a worker that crashed mid-execution
   * (a claimed job whose process died before markDone/markFailedOrRetry
   * ever ran). Applies the SAME attempts/backoff/give-up policy as
   * markFailedOrRetry (a stale lock counts as a failed attempt, so a
   * job that keeps crashing the worker eventually stops being retried
   * instead of looping forever). Returns the number of jobs reclaimed.
   */
  reclaimStuck(now: string, staleMs: number): Promise<number>;
  /** Counts of jobs per status — tests/metrics only, not on any hot path. */
  countByStatus(): Promise<Record<JobStatus, number>>;
}

// --- Provider portal (P5-A, Stage B demo slice) ------------------------------
//
// Hospital/facility staff accounts and their patient enrollments. These
// three tables are NOT peers of everything above them in this file: only
// `enrollments` is mother-keyed data (via `user_phone`) and therefore
// covered by the Kenya DPA erasure right — see DatabaseAdapter#eraseUser's
// doc comment below. `facilities` and `providers` are the hospital's own
// staff/organisation records, a separate data CONTROLLER's data, not the
// mother's — see consent.ts's header for why 'provider_access' is a real
// consent purpose in the first place (controller vs. processor). They are
// deliberately absent from erasure.ts's ERASURE_TARGETS.
//
// Self-registration (a facility or provider signing itself up) is
// explicitly out of scope for the Friday demo slice — see the P5 spec's
// "Out of scope" section. FacilityRepository#create / ProviderRepository
// #create exist only as a seed/test seam (no HTTP route calls them);
// production facility/provider rows are created by hand today.

/** Row shape of the `facilities` table. */
export interface FacilityRow {
  id: number;
  name: string;
  code: string;
  county: string | null;
  created_at: string;
}

export interface CreateFacilityInput {
  name: string;
  code: string;
  county?: string | null;
}

export interface FacilityRepository {
  getById(id: number): Promise<FacilityRow | undefined>;
  getByCode(code: string): Promise<FacilityRow | undefined>;
  /** Seed/test seam only — see this section's header. */
  create(input: CreateFacilityInput): Promise<FacilityRow>;
}

/** Row shape of the `providers` table. `password_hash` is always
 *  `scrypt$<saltHex>$<hashHex>` (apps/server/src/providerAuth.ts) —
 *  never a plaintext password. */
export interface ProviderRow {
  id: number;
  facility_id: number;
  email: string;
  name: string;
  role: string;
  license_number: string | null;
  password_hash: string;
  created_at: string;
}

export interface CreateProviderInput {
  facilityId: number;
  email: string;
  name: string;
  role: string;
  licenseNumber?: string | null;
  /** Already-hashed (apps/server/src/providerAuth.ts#hashPassword) —
   *  this layer never sees or stores a plaintext password. */
  passwordHash: string;
}

export interface ProviderRepository {
  getById(id: number): Promise<ProviderRow | undefined>;
  getByEmail(email: string): Promise<ProviderRow | undefined>;
  /** Seed/test seam only — see this section's header. */
  create(input: CreateProviderInput): Promise<ProviderRow>;
}

/** Row shape of the `enrollments` table — the one provider-portal table
 *  that IS mother data (keyed on `user_phone`), and therefore the one
 *  covered by DPA erasure (see erasure.ts's ERASURE_TARGETS).
 *
 *  `price_kes` (default 5000) is the ANNUAL per-mother subscription
 *  price — Ksh 5,000/year (~Ksh 416/month) per the shareholder pricing
 *  model this whole demo exists to validate. It is NOT a monthly figure,
 *  despite the column living on a row that also has a `plan` name —
 *  GET /provider/summary (apps/server/src/app.ts) sums this directly for
 *  annualRevenueKes and only DIVIDES by 12 for monthlyRevenueKes. Get
 *  that direction backwards (treat price_kes as monthly, multiply by 12)
 *  and annual revenue is overstated 12x — this is not a hypothetical,
 *  it shipped once and was caught before the Friday demo. */
export interface EnrollmentRow {
  id: number;
  facility_id: number;
  user_phone: string;
  enrolled_by: number | null;
  status: 'active' | 'ended';
  plan: string;
  price_kes: number;
  enrolled_at: string;
  ended_at: string | null;
}

export interface EnrollInput {
  facilityId: number;
  userPhone: string;
  enrolledBy?: number | null;
  plan?: string;
  /** ANNUAL price in KES, not monthly — see EnrollmentRow#price_kes's
   *  doc comment above for the 12x trap this note exists to prevent. */
  priceKes?: number;
}

export interface EnrollmentRepository {
  /**
   * Inserts a new enrollment row, unless (facility_id, user_phone)
   * already has one — see connection.ts's `UNIQUE(facility_id,
   * user_phone)` — in which case this resolves the EXISTING row instead
   * of inserting a duplicate or throwing. Same "pre-check, then let the
   * UNIQUE index be the real race guard" shape as JobRepository#enqueue's
   * dedupeKey handling. A facility therefore has at most ONE enrollment
   * row per mother, ever — reactivating a lapsed (`status: 'ended'`)
   * enrollment is a Stage-B follow-up, not built for the Friday slice.
   */
  enroll(input: EnrollInput): Promise<EnrollmentRow>;
  /** Every enrollment (active or ended) at one facility — backs the
   *  provider portal's patient panel (GET /provider/patients). */
  getByFacility(facilityId: number): Promise<EnrollmentRow[]>;
  /**
   * One facility's enrollment of one mother, or undefined if she was
   * never enrolled there. This is the boundary check GET
   * /provider/patients/detail uses so a provider can only look up phones
   * actually in THEIR OWN panel — not any phone in the database, even
   * one with active provider_access consent.
   */
  getByFacilityAndPhone(facilityId: number, userPhone: string): Promise<EnrollmentRow | undefined>;
}

// --- Escalation acknowledgements (P6, provider triage queue) ----------------
//
// A provider's "I've seen this and I'm on it" marker against one of the
// SAME 'danger_escalation' audit rows auditDangerEscalation() already
// writes (system actor, CRITICAL/HIGH only — see audit.ts) — this table
// does not duplicate or replace that store, it only records which of
// those events a facility has acknowledged. `escalationAt` is that audit
// row's own `created_at` string, used verbatim as the natural key (see
// EscalationAckRow#escalationAt below) rather than a foreign key to
// audit_log's id, since audit_log rows are never exposed to a provider
// by id — only by their (phone, urgency, createdAt) shape, via
// fetchRecentEscalations() in app.ts.

/** Row shape of the `escalation_acks` table. The one mother-keyed table
 *  in this section (via `userPhone`) — see erasure.ts's ERASURE_TARGETS,
 *  which clears it on DELETE /me/account, same enrollments/jobs
 *  precedent from P4-B/P5-A. */
export interface EscalationAckRow {
  id: number;
  facilityId: number;
  userPhone: string;
  /** The acknowledged audit row's own `created_at` — see this section's
   *  header for why this is a plain string natural key, not a foreign
   *  key to an audit_log id. */
  escalationAt: string;
  /** providers.id of whoever acknowledged it. */
  acknowledgedBy: number;
  acknowledgedAt: string;
}

export interface AckEscalationInput {
  facilityId: number;
  userPhone: string;
  escalationAt: string;
  acknowledgedBy: number;
}

export interface EscalationAckRepository {
  /** Every ack recorded at one facility — GET /provider/escalations
   *  reads this once per request and joins it against the live
   *  danger_escalation audit rows in memory (by (userPhone, escalationAt))
   *  to mark feed items acknowledged, rather than querying per item. */
  getByFacility(facilityId: number): Promise<EscalationAckRow[]>;
  /**
   * Records an ack, unless (facilityId, userPhone, escalationAt) already
   * has one — see connection.ts's `UNIQUE(facility_id, user_phone,
   * escalation_at)` — in which case this resolves the EXISTING row
   * instead of inserting a duplicate or throwing. Same "pre-check, then
   * let the UNIQUE index be the real race guard" shape as
   * EnrollmentRepository#enroll / JobRepository#enqueue's dedupeKey
   * handling — a provider tapping "Acknowledge" twice (double-tap, retry
   * after a dropped response) is a no-op the second time, not an error.
   */
  ack(input: AckEscalationInput): Promise<EscalationAckRow>;
}

// --- Aggregate --------------------------------------------------------------

/**
 * Aggregate seam a caller depends on instead of any concrete store.
 * packages/adapters/src/sqlite implements this today; a future
 * packages/adapters/src/postgres/ implements the exact same interface
 * against Postgres — that's the whole point of this file.
 */
export interface DatabaseAdapter {
  users: UserRepository;
  conversations: ConversationRepository;
  journals: JournalRepository;
  journalSessions: JournalSessionRepository;
  symptoms: SymptomRepository;
  medicalHistory: MedicalHistoryRepository;
  ancVisits: AncVisitRepository;
  otp: OtpRepository;
  consents: ConsentRepository;
  audit: AuditRepository;
  jobs: JobRepository;
  facilities: FacilityRepository;
  providers: ProviderRepository;
  enrollments: EnrollmentRepository;
  escalationAcks: EscalationAckRepository;
  /** Creates tables/indexes and runs idempotent migrations. Mirrors
   *  services/database.js#initializeDatabase(). */
  initialize(): Promise<void>;
  /** Closes the underlying connection/pool. New in P1-C — the original
   *  JS module never exposed a close path (it was a process-lifetime
   *  singleton); nothing currently calls this. */
  close(): Promise<void>;
  /**
   * P4-B readiness check (GET /health/ready): runs a trivial `SELECT 1`
   * against the connection and resolves if it succeeds, rejects
   * otherwise. Deliberately the cheapest possible real query — proves
   * the connection/file is actually usable (not just that this module
   * loaded), without touching any user table or row.
   */
  ping(): Promise<void>;
  /**
   * Kenya DPA erasure right (P3-C, DELETE /me/account): hard-deletes
   * every row keyed to `phone` from users, conversations, symptoms,
   * anc_visits, journals, journal_sessions, medical_history, otp_codes,
   * consents, and (P4-B) jobs — in a single transaction, so a partial
   * failure rolls everything back instead of leaving some tables cleared
   * and others not (see the adapter implementation for the transaction
   * mechanics).
   *
   * jobs is matched on the best-effort `user_phone` column (see
   * JobRecord#userPhone) — a job mid-flight (claimed by the poller,
   * status='running') at the moment of erasure is still deleted; the
   * accepted trade-off is that its in-progress side effect (e.g. an
   * already-in-transit WhatsApp send) is not recalled, only the row
   * bookkeeping it. Documented here rather than treated as a bug: an
   * erasure request racing a live job is a rare edge case, and there is
   * no way to "cancel" a send that may have already left the process.
   *
   * enrollments (P5-A, provider portal) is matched on `user_phone` the
   * same way — a deleted mother must not linger in a hospital's patient
   * panel. `facilities`/`providers` are the hospital's OWN staff/org
   * records (a separate DPA controller's data, not the mother's — see
   * consent.ts's header), and are deliberately NOT in this cascade: an
   * enrollment existing in the past doesn't give a hospital's own
   * account rows anything to do with a mother's erasure request.
   *
   * escalation_acks (P6, provider triage queue) is matched on its own
   * `user_phone` column, same enrollments/jobs precedent — a provider's
   * "acknowledged" marker against one of a mother's danger escalations
   * is still HER data (which of her escalations a facility says it has
   * seen), so it goes with her on erasure, same as everything else
   * except audit_log.
   *
   * DELIBERATE TENSION, documented here rather than left implicit:
   * this method does NOT touch `audit_log`. The two DPA obligations
   * (erasure vs. keeping a record of processing) point in opposite
   * directions for that one table, and we resolve it in favor of
   * retention: audit_log rows — including the 'delete'/'account' event
   * this very erasure fires (see apps/server/src/app.ts's DELETE
   * /me/account, which audits BEFORE calling this) — are themselves the
   * DPA-mandated record of what processing/access happened and when,
   * which by nature must survive the event it's recording. The
   * alternative (a minimal "account deleted" tombstone that also purges
   * prior audit rows for the phone) was considered and rejected: it
   * would erase the very access history a data subject or regulator
   * might need to review *because* an account was deleted. Audit rows
   * do retain the phone as `actor`/`resource_owner` after this call —
   * that residual is the accepted cost of an auditable erasure.
   *
   * Idempotent: a phone with zero rows in every table (already erased,
   * or never had any) resolves normally — `DELETE ... WHERE` matching
   * zero rows is not an error.
   */
  eraseUser(phone: string): Promise<void>;
}
