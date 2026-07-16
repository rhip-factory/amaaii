// Ported 1:1 from services/database.js — getMedicalHistory,
// saveMedicalHistory.

import type sqlite3 from 'sqlite3';
import type {
  MedicalHistoryInput,
  MedicalHistoryRecord,
  MedicalHistoryRepository,
} from '@amaaii/core';

interface MedicalHistoryRow {
  raw_text: string | null;
  extracted_json: string | null;
  updated_at: string;
}

export class SqliteMedicalHistoryRepository implements MedicalHistoryRepository {
  constructor(private readonly db: sqlite3.Database) {}

  getMedicalHistory(userPhone: string): Promise<MedicalHistoryRecord | null> {
    return new Promise((resolve, reject) => {
      this.db.get<MedicalHistoryRow>(
        `SELECT raw_text, extracted_json, updated_at FROM medical_history WHERE user_phone = ?`,
        [userPhone],
        (err, row) => {
          if (err) return reject(err);
          if (!row) return resolve(null);
          let parsed: Record<string, unknown> | null = null;
          if (row.extracted_json) {
            try {
              parsed = JSON.parse(row.extracted_json);
            } catch (_) {
              /* ignore */
            }
          }
          resolve({ rawText: row.raw_text, ...(parsed || {}), updatedAt: row.updated_at });
        }
      );
    });
  }

  saveMedicalHistory(userPhone: string, { rawText, extracted }: MedicalHistoryInput): Promise<number> {
    const json = JSON.stringify(extracted || {});
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO medical_history (user_phone, raw_text, extracted_json, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(user_phone) DO UPDATE SET
           raw_text = excluded.raw_text,
           extracted_json = excluded.extracted_json,
           updated_at = datetime('now')`,
        [userPhone, rawText || null, json],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
  }
}
