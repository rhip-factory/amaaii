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
  /** Creates tables/indexes and runs idempotent migrations. Mirrors
   *  services/database.js#initializeDatabase(). */
  initialize(): Promise<void>;
  /** Closes the underlying connection/pool. New in P1-C — the original
   *  JS module never exposed a close path (it was a process-lifetime
   *  singleton); nothing currently calls this. */
  close(): Promise<void>;
  /**
   * Kenya DPA erasure right (P3-C, DELETE /me/account): hard-deletes
   * every row keyed to `phone` from users, conversations, symptoms,
   * anc_visits, journals, journal_sessions, medical_history, otp_codes,
   * and consents — in a single transaction, so a partial failure rolls
   * everything back instead of leaving some tables cleared and others
   * not (see the adapter implementation for the transaction mechanics).
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
