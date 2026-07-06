// Ported 1:1 from services/database.js — getJournalSession,
// upsertJournalSession, deleteJournalSession.

import type sqlite3 from 'sqlite3';
import type {
  JournalSession,
  JournalSessionInput,
  JournalSessionRepository,
} from '@amaaii/core';

interface JournalSessionRow {
  current_stage: string;
  journal_data: string;
  journal_id: number | null;
  channel: string;
  started_at: string;
  updated_at: string;
}

export class SqliteJournalSessionRepository implements JournalSessionRepository {
  constructor(private readonly db: sqlite3.Database) {}

  getJournalSession(userPhone: string): Promise<JournalSession | null> {
    return new Promise((resolve, reject) => {
      this.db.get<JournalSessionRow>(
        `SELECT current_stage, journal_data, journal_id, channel, started_at, updated_at
         FROM journal_sessions WHERE user_phone = ?`,
        [userPhone],
        (err, row) => {
          if (err) return reject(err);
          if (!row) return resolve(null);
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(row.journal_data);
          } catch (e) {
            return reject(
              new Error(`journal_data not valid JSON for ${userPhone}: ${(e as Error).message}`)
            );
          }
          resolve({
            currentStage: row.current_stage,
            journalData: parsed,
            journalId: row.journal_id || null,
            channel: row.channel,
            startedAt: row.started_at,
            updatedAt: row.updated_at,
          });
        }
      );
    });
  }

  upsertJournalSession(
    userPhone: string,
    { currentStage, journalData, journalId = null, channel = 'whatsapp' }: JournalSessionInput
  ): Promise<number> {
    const payload = JSON.stringify(journalData || {});
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO journal_sessions
           (user_phone, current_stage, journal_data, journal_id, channel, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_phone) DO UPDATE SET
           current_stage = excluded.current_stage,
           journal_data  = excluded.journal_data,
           journal_id    = excluded.journal_id,
           channel       = excluded.channel,
           updated_at    = datetime('now')`,
        [userPhone, currentStage, payload, journalId, channel],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
  }

  deleteJournalSession(userPhone: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.db.run(
        `DELETE FROM journal_sessions WHERE user_phone = ?`,
        [userPhone],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
  }
}
