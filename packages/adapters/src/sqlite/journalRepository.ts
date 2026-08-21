// Ported 1:1 from services/database.js — createOrUpdateJournal,
// getTodaysJournal, getTodaysJournals, getJournalHistory,
// getJournalAnalytics.

import type sqlite3 from 'sqlite3';
import type {
  JournalAnalytics,
  JournalPatch,
  JournalRepository,
  JournalRow,
} from '@amaaii/core';

// Whitelisted journal columns. SQL identifiers are never user-controlled.
const JOURNAL_COLUMNS = new Set([
  'journal_stage',
  'physical_symptoms',
  'emotional_state',
  'mood_description',
  'energy_level',
  'sleep_quality',
  'sleep_hours',
  'appetite',
  'baby_movement_count',
  'baby_movement_time',
  'water_intake',
  'medications_taken',
  'questions_for_doctor',
  'special_notes',
  'red_flags_detected',
  'completed',
  'started_at',
  'completed_at',
  // P2-C: idempotency key set only by the PWA structured check-in form.
  'client_entry_id',
]);

export class SqliteJournalRepository implements JournalRepository {
  constructor(private readonly db: sqlite3.Database) {}

  // Insert a NEW journal row OR update an existing one by id. Multi-checkin
  // support: passing journalId=null always inserts a fresh row, so users
  // can complete several check-ins per day. journalManager owns the id
  // after startJournalSession() and threads it through every stage update.
  createOrUpdateJournal(
    userPhone: string,
    journalData: JournalPatch,
    journalId: number | null = null
  ): Promise<number> {
    // Strip any keys that aren't whitelisted columns. Defense in depth —
    // the only writer is journalManager which controls its own keys, but
    // this protects against future regressions.
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(journalData || {})) {
      if (JOURNAL_COLUMNS.has(k)) safe[k] = v;
    }

    return new Promise((resolve, reject) => {
      if (journalId) {
        const fields = Object.keys(safe);
        if (fields.length === 0) return resolve(journalId);
        const setClause = fields.map((f) => `${f} = ?`).join(', ');
        const values = fields.map((f) => safe[f]);
        values.push(journalId);
        this.db.run(`UPDATE journals SET ${setClause} WHERE id = ?`, values, function (err) {
          if (err) reject(err);
          else resolve(journalId);
        });
      } else {
        // Fresh check-in — record start time even if journalData is empty.
        const fields = ['user_phone', 'started_at', ...Object.keys(safe)];
        const placeholders = fields.map(() => '?').join(', ');
        const values = [userPhone, new Date().toISOString(), ...Object.values(safe)];
        this.db.run(
          `INSERT INTO journals (${fields.join(', ')}) VALUES (${placeholders})`,
          values,
          function (err) {
            if (err) reject(err);
            else resolve(this.lastID);
          }
        );
      }
    });
  }

  // Returns the most recent journal row for today (could be in-progress
  // or completed). With multi-checkin, "today's journal" means "the one
  // the user is working on or just finished".
  getTodaysJournal(userPhone: string): Promise<JournalRow | undefined> {
    return new Promise((resolve, reject) => {
      const today = new Date().toISOString().split('T')[0];
      this.db.get<JournalRow>(
        `SELECT * FROM journals
         WHERE user_phone = ? AND date = ?
         ORDER BY COALESCE(started_at, timestamp) DESC, id DESC
         LIMIT 1`,
        [userPhone, today],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  // All journals for today, oldest first.
  getTodaysJournals(userPhone: string): Promise<JournalRow[]> {
    return new Promise((resolve, reject) => {
      const today = new Date().toISOString().split('T')[0];
      this.db.all<JournalRow>(
        `SELECT * FROM journals
         WHERE user_phone = ? AND date = ?
         ORDER BY COALESCE(started_at, timestamp) ASC, id ASC`,
        [userPhone, today],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  // P3-C data-portability export — ALL rows regardless of date, oldest
  // first (unlike getJournalHistory's `days`-windowed query).
  // No date window, deliberately — see the interface doc comment. Takes the
  // greatest of completed_at/started_at/timestamp rather than assuming one is
  // set: a check-in interrupted by a danger-sign escalation never gets
  // completed_at, and silently missing those would report a mother as quieter
  // than she actually is, which is the opposite of a safe failure here.
  getLastJournalAt(userPhone: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      this.db.get<{ last_at: string | null }>(
        `SELECT MAX(COALESCE(completed_at, started_at, timestamp)) AS last_at
           FROM journals
          WHERE user_phone = ?`,
        [userPhone],
        (err, row) => {
          if (err) reject(err);
          else resolve(row?.last_at ?? null);
        }
      );
    });
  }

  getAllForUser(userPhone: string): Promise<JournalRow[]> {
    return new Promise((resolve, reject) => {
      this.db.all<JournalRow>(
        `SELECT * FROM journals WHERE user_phone = ? ORDER BY date ASC, id ASC`,
        [userPhone],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  getJournalHistory(userPhone: string, days = 7): Promise<JournalRow[]> {
    return new Promise((resolve, reject) => {
      this.db.all<JournalRow>(
        `SELECT * FROM journals
         WHERE user_phone = ?
         AND date >= date('now', '-' || ? || ' days')
         ORDER BY date DESC`,
        [userPhone, days],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  // P2-C idempotency lookup — see JournalRepository#findByClientEntryId.
  findByClientEntryId(userPhone: string, clientEntryId: string): Promise<JournalRow | undefined> {
    return new Promise((resolve, reject) => {
      this.db.get<JournalRow>(
        `SELECT * FROM journals WHERE user_phone = ? AND client_entry_id = ? LIMIT 1`,
        [userPhone, clientEntryId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  getJournalAnalytics(userPhone: string, days = 7): Promise<JournalAnalytics> {
    return new Promise((resolve, reject) => {
      this.db.get<JournalAnalytics>(
        `SELECT
          AVG(emotional_state) as avg_mood,
          AVG(energy_level) as avg_energy,
          AVG(sleep_quality) as avg_sleep,
          AVG(water_intake) as avg_water,
          COUNT(*) as journal_count,
          SUM(CASE WHEN red_flags_detected IS NOT NULL THEN 1 ELSE 0 END) as red_flag_days
         FROM journals
         WHERE user_phone = ?
         AND date >= date('now', '-' || ? || ' days')`,
        [userPhone, days],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }
}
