// SQLite implementation of the @amaaii/core repository interfaces
// (P1-C). This is the concrete adapter services/database.js now
// delegates to; a future packages/adapters/src/postgres/ would export
// the same createXxxDatabaseAdapter() shape against Postgres instead.

import type sqlite3 from 'sqlite3';
import type { DatabaseAdapter } from '@amaaii/core';
import { createConnection, initializeSchema } from './connection';
import { SqliteUserRepository } from './userRepository';
import { SqliteConversationRepository } from './conversationRepository';
import { SqliteJournalRepository } from './journalRepository';
import { SqliteJournalSessionRepository } from './journalSessionRepository';
import { SqliteSymptomRepository } from './symptomRepository';
import { SqliteMedicalHistoryRepository } from './medicalHistoryRepository';
import { SqliteAncVisitRepository } from './ancVisitRepository';
import { SqliteOtpRepository } from './otpRepository';
import { SqliteConsentRepository } from './consentRepository';
import { SqliteAuditRepository } from './auditRepository';
import { SqliteJobRepository } from './jobRepository';
import { SqliteFacilityRepository } from './facilityRepository';
import { SqliteProviderRepository } from './providerRepository';
import { SqliteEnrollmentRepository } from './enrollmentRepository';
import { eraseUserData } from './erasure';

export * from './connection';
export * from './userRepository';
export * from './conversationRepository';
export * from './journalRepository';
export * from './journalSessionRepository';
export * from './symptomRepository';
export * from './medicalHistoryRepository';
export * from './ancVisitRepository';
export * from './otpRepository';
export * from './consentRepository';
export * from './auditRepository';
export * from './jobRepository';
export * from './facilityRepository';
export * from './providerRepository';
export * from './enrollmentRepository';
export * from './erasure';

/**
 * Builds a fully-wired DatabaseAdapter backed by a single sqlite3
 * connection. `dbPath` defaults to the `DB_PATH` env var, falling back
 * to `<repoRoot>/amaaii.db` — see connection.ts#resolveDbPath, the same
 * default services/database.js used to compute inline.
 */
export function createSqliteDatabaseAdapter(dbPath?: string): DatabaseAdapter {
  const db: sqlite3.Database = createConnection(dbPath);

  return {
    users: new SqliteUserRepository(db),
    conversations: new SqliteConversationRepository(db),
    journals: new SqliteJournalRepository(db),
    journalSessions: new SqliteJournalSessionRepository(db),
    symptoms: new SqliteSymptomRepository(db),
    medicalHistory: new SqliteMedicalHistoryRepository(db),
    ancVisits: new SqliteAncVisitRepository(db),
    otp: new SqliteOtpRepository(db),
    consents: new SqliteConsentRepository(db),
    audit: new SqliteAuditRepository(db),
    jobs: new SqliteJobRepository(db),
    facilities: new SqliteFacilityRepository(db),
    providers: new SqliteProviderRepository(db),
    enrollments: new SqliteEnrollmentRepository(db),
    initialize: () => initializeSchema(db),
    close: () =>
      new Promise<void>((resolve, reject) => {
        db.close((err) => (err ? reject(err) : resolve()));
      }),
    // P4-B: GET /health/ready's DB check — see DatabaseAdapter#ping's
    // doc comment in packages/core/src/repositories.ts.
    ping: () =>
      new Promise<void>((resolve, reject) => {
        db.get('SELECT 1', (err) => (err ? reject(err) : resolve()));
      }),
    eraseUser: (phone: string) => eraseUserData(db, phone),
  };
}
