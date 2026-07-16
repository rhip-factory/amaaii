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
  ConversationAnalysis,
  ConversationRow,
  CreateUserInput,
  JournalAnalytics,
  JournalPatch,
  JournalRow,
  JournalSession,
  JournalSessionInput,
  LastBotMessageRow,
  MedicalHistoryInput,
  MedicalHistoryRecord,
  OtpRecord,
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

export async function scheduleANCVisit(userPhone: string, scheduledDate: string, notes = ''): Promise<number> {
  return adapter.ancVisits.scheduleANCVisit(userPhone, scheduledDate, notes);
}

export async function getUpcomingANCVisits(userPhone: string): Promise<AncVisitRow[]> {
  return adapter.ancVisits.getUpcomingANCVisits(userPhone);
}

export async function markANCVisitAttended(visitId: number): Promise<number> {
  return adapter.ancVisits.markANCVisitAttended(visitId);
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
