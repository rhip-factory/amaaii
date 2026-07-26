// P1-E: ported 1:1 from services/database.js (final step of the TS
// migration — see CLAUDE.md). The real implementation lives in
// packages/adapters/src/sqlite/ (P1-C: repository pattern + SQLite
// adapter), built on interfaces declared in packages/core/src/
// repositories.ts. This file keeps the same 20 exports/signatures the
// old JS shim had, now with real types instead of a `require('*.ts')`
// passthrough.

import { createSqliteDatabaseAdapter } from '@amaaii/adapters';
import type {
  AncVisitRow,
  AuditEvent,
  AuditEventInput,
  ConsentPurpose,
  ConsentRecord,
  ConversationAnalysis,
  ConversationRow,
  CreateUserInput,
  EnqueueJobInput,
  JobRecord,
  JobStatus,
  JournalAnalytics,
  JournalPatch,
  JournalRow,
  JournalSession,
  JournalSessionInput,
  LastBotMessageRow,
  MedicalHistoryInput,
  MedicalHistoryRecord,
  OtpRecord,
  SymptomRow,
  UpdateUserInput,
  UserRow,
} from '@amaaii/core';

// Single connection for the whole process, created at import time — same
// timing as the original module-level `db = new sqlite3.Database(...)`,
// so DB_PATH must still be set BEFORE this module is first imported (see
// tests/*, which all set `process.env.DB_PATH = ':memory:'` ahead of
// requiring/importing the module that pulls this file in).
const adapter = createSqliteDatabaseAdapter();

// initializeDatabase is the one exception: the original module declared
// it as a plain function (not `async`), since it returns the
// db.serialize(...) Promise directly with no preceding logic that could
// throw synchronously.
export function initializeDatabase(): Promise<void> {
  return adapter.initialize();
}

// Every other export mirrors the original's `async function` declaration
// exactly (not just "returns a Promise") — e.g. updateUser's whitelist
// check throws synchronously, and only `async` turns that into a
// rejected Promise instead of an uncaught throw. See
// packages/adapters/src/sqlite/userRepository.ts for the actual check.
export async function createUser(phoneNumber: string, userData: CreateUserInput = {}): Promise<number | null> {
  return adapter.users.createUser(phoneNumber, userData);
}

export async function getUser(phoneNumber: string): Promise<UserRow | undefined> {
  return adapter.users.getUser(phoneNumber);
}

export async function updateUser(phoneNumber: string, updates: UpdateUserInput): Promise<number> {
  return adapter.users.updateUser(phoneNumber, updates);
}

export async function saveConversation(
  userPhone: string,
  message: string,
  response: string,
  analysis: ConversationAnalysis = {}
): Promise<number> {
  return adapter.conversations.saveConversation(userPhone, message, response, analysis);
}

export async function getConversationHistory(userPhone: string, limit = 10): Promise<ConversationRow[]> {
  return adapter.conversations.getConversationHistory(userPhone, limit);
}

export async function getLastBotMessage(userPhone: string): Promise<LastBotMessageRow | null> {
  return adapter.conversations.getLastBotMessage(userPhone);
}

// P3-C data-portability export (GET /me/export) — ALL conversation rows,
// not the last-N-turns slice getConversationHistory returns.
export async function getAllConversationsForUser(userPhone: string): Promise<ConversationRow[]> {
  return adapter.conversations.getAllForUser(userPhone);
}

export async function getMedicalHistory(userPhone: string): Promise<MedicalHistoryRecord | null> {
  return adapter.medicalHistory.getMedicalHistory(userPhone);
}

export async function saveMedicalHistory(userPhone: string, data: MedicalHistoryInput): Promise<number> {
  return adapter.medicalHistory.saveMedicalHistory(userPhone, data);
}

export async function getJournalSession(userPhone: string): Promise<JournalSession | null> {
  return adapter.journalSessions.getJournalSession(userPhone);
}

export async function upsertJournalSession(userPhone: string, session: JournalSessionInput): Promise<number> {
  return adapter.journalSessions.upsertJournalSession(userPhone, session);
}

export async function deleteJournalSession(userPhone: string): Promise<number> {
  return adapter.journalSessions.deleteJournalSession(userPhone);
}

export async function saveSymptoms(
  userPhone: string,
  symptoms: unknown[],
  mood: string,
  urgency: string
): Promise<number> {
  return adapter.symptoms.saveSymptoms(userPhone, symptoms, mood, urgency);
}

// P3-C data-portability export (GET /me/export) — ALL symptom rows.
export async function getAllSymptomsForUser(userPhone: string): Promise<SymptomRow[]> {
  return adapter.symptoms.getAllForUser(userPhone);
}

export async function scheduleANCVisit(userPhone: string, scheduledDate: string, notes = ''): Promise<number> {
  return adapter.ancVisits.scheduleANCVisit(userPhone, scheduledDate, notes);
}

export async function getUpcomingANCVisits(userPhone: string): Promise<AncVisitRow[]> {
  return adapter.ancVisits.getUpcomingANCVisits(userPhone);
}

export async function markANCVisitAttended(visitId: number): Promise<number> {
  return adapter.ancVisits.markANCVisitAttended(visitId);
}

// P3-C data-portability export (GET /me/export) — ALL ANC visit rows,
// not just the upcoming/unattended slice getUpcomingANCVisits returns.
export async function getAllAncVisitsForUser(userPhone: string): Promise<AncVisitRow[]> {
  return adapter.ancVisits.getAllForUser(userPhone);
}

export async function createOrUpdateJournal(
  userPhone: string,
  journalData: JournalPatch,
  journalId: number | null = null
): Promise<number> {
  return adapter.journals.createOrUpdateJournal(userPhone, journalData, journalId);
}

export async function getTodaysJournal(userPhone: string): Promise<JournalRow | undefined> {
  return adapter.journals.getTodaysJournal(userPhone);
}

export async function getTodaysJournals(userPhone: string): Promise<JournalRow[]> {
  return adapter.journals.getTodaysJournals(userPhone);
}

export async function getJournalHistory(userPhone: string, days = 7): Promise<JournalRow[]> {
  return adapter.journals.getJournalHistory(userPhone, days);
}

export async function getJournalAnalytics(userPhone: string, days = 7): Promise<JournalAnalytics> {
  return adapter.journals.getJournalAnalytics(userPhone, days);
}

// P2-C idempotency lookup for POST /journal/entries.
export async function findJournalByClientEntryId(userPhone: string, clientEntryId: string): Promise<JournalRow | undefined> {
  return adapter.journals.findByClientEntryId(userPhone, clientEntryId);
}

// P3-C data-portability export (GET /me/export) — ALL journal rows,
// unbounded by the `days` window getJournalHistory uses.
export async function getAllJournalsForUser(userPhone: string): Promise<JournalRow[]> {
  return adapter.journals.getAllForUser(userPhone);
}

// --- OTP (P2-B) ---------------------------------------------------------

export async function createOrReplaceOtp(
  phone: string,
  codeHash: string,
  expiresAt: string,
  sentTimestamps: string[]
): Promise<void> {
  return adapter.otp.createOrReplace(phone, codeHash, expiresAt, sentTimestamps);
}

export async function getOtp(phone: string): Promise<OtpRecord | null> {
  return adapter.otp.get(phone);
}

export async function recordOtpAttempt(phone: string): Promise<number> {
  return adapter.otp.recordAttempt(phone);
}

export async function deleteOtp(phone: string): Promise<void> {
  return adapter.otp.delete(phone);
}

// --- Consent (P3-A) ------------------------------------------------------
// Pure foundation only — nothing in this file enforces consent yet (no
// route checks these). P3-B wires needsConsent()/canUseAi() (packages/
// core/src/consent.ts) against the ConsentState these facade functions
// let a caller reconstruct via deriveConsentState(await getConsents(...)).

export async function getConsents(phone: string): Promise<ConsentRecord[]> {
  return adapter.consents.getConsents(phone);
}

export async function recordConsent(
  phone: string,
  purpose: ConsentPurpose,
  granted: boolean,
  version: number
): Promise<ConsentRecord> {
  return adapter.consents.recordConsent(phone, purpose, granted, version);
}

export async function revokeConsent(phone: string, purpose: ConsentPurpose): Promise<void> {
  return adapter.consents.revokeConsent(phone, purpose);
}

// --- Audit log (P3-A) ------------------------------------------------------
// Same "foundation, not enforcement" note as above — nothing currently
// calls recordAudit() from a real route handler; that's P3-B.

export async function recordAudit(event: AuditEventInput): Promise<void> {
  return adapter.audit.record(event);
}

export async function listAuditForUser(phone: string, limit?: number): Promise<AuditEvent[]> {
  return adapter.audit.listForUser(phone, limit);
}

// --- Erasure (P3-C) ---------------------------------------------------------
// Kenya DPA right to erasure. See DatabaseAdapter#eraseUser's doc comment
// in packages/core/src/repositories.ts for the tables cleared, the
// transaction guarantee, and — most importantly — why audit_log is
// deliberately NOT among them.
export async function eraseUser(phone: string): Promise<void> {
  return adapter.eraseUser(phone);
}

// --- Jobs (P4-A durable queue) -----------------------------------------
// See packages/core/src/repositories.ts's Jobs section for the contract
// and apps/server/src/jobWorker.ts for the poller that drives these.

export async function enqueueJob(input: EnqueueJobInput): Promise<JobRecord> {
  return adapter.jobs.enqueue(input);
}

export async function claimDueJobs(now: string, limit: number, workerId: string): Promise<JobRecord[]> {
  return adapter.jobs.claimDueJobs(now, limit, workerId);
}

export async function markJobDone(id: number): Promise<void> {
  return adapter.jobs.markDone(id);
}

export async function markJobFailedOrRetry(id: number, error: string, now: string): Promise<void> {
  return adapter.jobs.markFailedOrRetry(id, error, now);
}

export async function reclaimStuckJobs(now: string, staleMs: number): Promise<number> {
  return adapter.jobs.reclaimStuck(now, staleMs);
}

export async function countJobsByStatus(): Promise<Record<JobStatus, number>> {
  return adapter.jobs.countByStatus();
}
