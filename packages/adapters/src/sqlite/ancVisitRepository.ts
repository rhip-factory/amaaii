// Ported 1:1 from services/database.js — scheduleANCVisit,
// getUpcomingANCVisits, markANCVisitAttended.

import type sqlite3 from 'sqlite3';
import type { AncVisitRepository, AncVisitRow } from '@amaaii/core';

export class SqliteAncVisitRepository implements AncVisitRepository {
  constructor(private readonly db: sqlite3.Database) {}

  scheduleANCVisit(userPhone: string, scheduledDate: string, notes = ''): Promise<number> {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO anc_visits (user_phone, scheduled_date, notes) VALUES (?, ?, ?)`,
        [userPhone, scheduledDate, notes],
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  getUpcomingANCVisits(userPhone: string): Promise<AncVisitRow[]> {
    return new Promise((resolve, reject) => {
      this.db.all<AncVisitRow>(
        `SELECT * FROM anc_visits
         WHERE user_phone = ? AND attended = 0 AND scheduled_date >= date('now')
         ORDER BY scheduled_date ASC`,
        [userPhone],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  markANCVisitAttended(visitId: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.db.run('UPDATE anc_visits SET attended = 1 WHERE id = ?', [visitId], function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
  }

  // P3-C data-portability export — ALL rows regardless of attended/date,
  // oldest first (unlike getUpcomingANCVisits' attended=0/future filter).
  getAllForUser(userPhone: string): Promise<AncVisitRow[]> {
    return new Promise((resolve, reject) => {
      this.db.all<AncVisitRow>(
        `SELECT * FROM anc_visits WHERE user_phone = ? ORDER BY scheduled_date ASC, id ASC`,
        [userPhone],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }
}
