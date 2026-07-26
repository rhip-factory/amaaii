// SQLite implementation of ConsentRepository (P3-A). Append-only ledger
// — every method here is an INSERT; nothing in this file ever issues an
// UPDATE against the `consents` table. See ConsentRecord's header in
// packages/core/src/repositories.ts for the row-shape rationale.

import type sqlite3 from 'sqlite3';
import type { ConsentPurpose, ConsentRecord, ConsentRepository } from '@amaaii/core';

interface ConsentRow {
  id: number;
  user_phone: string;
  purpose: string;
  granted: number;
  version: number;
  granted_at: string;
  revoked_at: string | null;
}

function toConsentRecord(row: ConsentRow): ConsentRecord {
  return {
    id: row.id,
    user_phone: row.user_phone,
    purpose: row.purpose as ConsentPurpose,
    granted: row.granted,
    version: row.version,
    granted_at: row.granted_at,
    revoked_at: row.revoked_at,
  };
}

export class SqliteConsentRepository implements ConsentRepository {
  constructor(private readonly db: sqlite3.Database) {}

  getConsents(phone: string): Promise<ConsentRecord[]> {
    return new Promise((resolve, reject) => {
      // Oldest first — packages/core/src/consent.ts#deriveConsentState
      // relies on "later in the array wins" to reconstruct current state.
      this.db.all<ConsentRow>(
        `SELECT * FROM consents WHERE user_phone = ? ORDER BY id ASC`,
        [phone],
        (err, rows) => {
          if (err) reject(err);
          else resolve((rows || []).map(toConsentRecord));
        }
      );
    });
  }

  recordConsent(
    phone: string,
    purpose: ConsentPurpose,
    granted: boolean,
    version: number
  ): Promise<ConsentRecord> {
    return new Promise((resolve, reject) => {
      // A fresh grant/decline row never carries a revoked_at — that
      // column is only ever populated by revokeConsent() below, on the
      // withdrawal row itself, never retrofitted onto this one.
      this.db.run(
        `INSERT INTO consents (user_phone, purpose, granted, version, granted_at, revoked_at)
         VALUES (?, ?, ?, ?, datetime('now'), NULL)`,
        [phone, purpose, granted ? 1 : 0, version],
        function (err) {
          if (err) return reject(err);
          resolve({
            id: this.lastID,
            user_phone: phone,
            purpose,
            granted,
            version,
            // Not re-read from the DB — datetime('now') resolves inside
            // SQLite at insert time, so the exact string isn't available
            // to this callback. Callers needing the authoritative
            // granted_at should re-fetch via getConsents(); every other
            // caller (P3-B enforcement) only cares that the row exists.
            granted_at: new Date().toISOString(),
            revoked_at: null,
          });
        }
      );
    });
  }

  revokeConsent(phone: string, purpose: ConsentPurpose): Promise<void> {
    return new Promise((resolve, reject) => {
      // Look up the most recent row for this purpose so the withdrawal
      // event can carry forward the version it's withdrawing consent
      // from (falls back to version 1 if the purpose was never touched,
      // which is a no-op revoke on an already-absent consent — harmless,
      // the ledger just gains an explanatory row).
      this.db.get<{ version: number }>(
        `SELECT version FROM consents WHERE user_phone = ? AND purpose = ? ORDER BY id DESC LIMIT 1`,
        [phone, purpose],
        (err, row) => {
          if (err) return reject(err);
          const version = row ? row.version : 1;
          // granted=0 AND revoked_at stamped on this SAME new row —
          // that's what marks it as a withdrawal rather than an
          // outright decline (recordConsent's granted=false path always
          // leaves revoked_at NULL).
          this.db.run(
            `INSERT INTO consents (user_phone, purpose, granted, version, granted_at, revoked_at)
             VALUES (?, ?, 0, ?, datetime('now'), datetime('now'))`,
            [phone, purpose, version],
            (err2) => (err2 ? reject(err2) : resolve())
          );
        }
      );
    });
  }
}
