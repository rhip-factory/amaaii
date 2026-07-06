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

export interface SymptomRepository {
  saveSymptoms(
    userPhone: string,
    symptoms: unknown[],
    mood: string,
    urgency: string
  ): Promise<number>;
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
  /** Creates tables/indexes and runs idempotent migrations. Mirrors
   *  services/database.js#initializeDatabase(). */
  initialize(): Promise<void>;
  /** Closes the underlying connection/pool. New in P1-C — the original
   *  JS module never exposed a close path (it was a process-lifetime
   *  singleton); nothing currently calls this. */
  close(): Promise<void>;
}
