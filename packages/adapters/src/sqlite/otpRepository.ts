// SQLite implementation of OtpRepository (P2-B). One row per phone;
// createOrReplace wholesale-replaces it (INSERT ... ON CONFLICT DO
// UPDATE, same idiom as journalSessionRepository.ts /
// medicalHistoryRepository.ts elsewhere in this directory).

import type sqlite3 from 'sqlite3';
import type { OtpRecord, OtpRepository } from '@amaaii/core';

interface OtpRow {
  phone: string;
  code_hash: string;
  expires_at: string;
  attempts: number;
  sent_timestamps: string;
  created_at: string;
  updated_at: string;
}

function parseRow(row: OtpRow): OtpRecord {
  let sentTimestamps: string[] = [];
  try {
    const parsed = JSON.parse(row.sent_timestamps);
    if (Array.isArray(parsed)) sentTimestamps = parsed;
  } catch (_) {
    // Corrupt/empty column — treat as no send history rather than throw;
    // worst case a phone gets one extra allowed send.
  }
  return {
    phone: row.phone,
    codeHash: row.code_hash,
    expiresAt: row.expires_at,
    attempts: row.attempts,
    sentTimestamps,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteOtpRepository implements OtpRepository {
  constructor(private readonly db: sqlite3.Database) {}

  createOrReplace(
    phone: string,
    codeHash: string,
    expiresAt: string,
    sentTimestamps: string[]
  ): Promise<void> {
    const payload = JSON.stringify(sentTimestamps || []);
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO otp_codes
           (phone, code_hash, expires_at, attempts, sent_timestamps, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, datetime('now'), datetime('now'))
         ON CONFLICT(phone) DO UPDATE SET
           code_hash = excluded.code_hash,
           expires_at = excluded.expires_at,
           attempts = 0,
           sent_timestamps = excluded.sent_timestamps,
           updated_at = datetime('now')`,
        [phone, codeHash, expiresAt, payload],
        (err) => (err ? reject(err) : resolve())
      );
    });
  }

  get(phone: string): Promise<OtpRecord | null> {
    return new Promise((resolve, reject) => {
      this.db.get<OtpRow>(`SELECT * FROM otp_codes WHERE phone = ?`, [phone], (err, row) => {
        if (err) return reject(err);
        resolve(row ? parseRow(row) : null);
      });
    });
  }

  recordAttempt(phone: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE otp_codes SET attempts = attempts + 1, updated_at = datetime('now') WHERE phone = ?`,
        [phone],
        (err) => {
          if (err) return reject(err);
          // Re-read for the authoritative new count — sqlite3's
          // `this.changes` in the callback above gives rows-affected,
          // not the post-update value.
          this.db.get<{ attempts: number }>(
            `SELECT attempts FROM otp_codes WHERE phone = ?`,
            [phone],
            (err2, row) => {
              if (err2) return reject(err2);
              resolve(row ? row.attempts : 0);
            }
          );
        }
      );
    });
  }

  delete(phone: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(`DELETE FROM otp_codes WHERE phone = ?`, [phone], (err) =>
        err ? reject(err) : resolve()
      );
    });
  }
}
