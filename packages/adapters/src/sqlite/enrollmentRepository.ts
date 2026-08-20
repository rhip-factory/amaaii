// SQLite implementation of EnrollmentRepository (P5-A, provider portal).
// The one provider-portal table that IS mother data — see erasure.ts's
// ERASURE_TARGETS, which clears this table on DELETE /me/account.

import type sqlite3 from 'sqlite3';
import type { EnrollInput, EnrollmentRepository, EnrollmentRow } from '@amaaii/core';

// Same duck-typed "does this look like a UNIQUE violation" check as
// jobRepository.ts's own copy (kept private here rather than shared,
// matching that file's own precedent of not sharing this check either).
function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

export class SqliteEnrollmentRepository implements EnrollmentRepository {
  constructor(private readonly db: sqlite3.Database) {}

  getByFacilityAndPhone(facilityId: number, userPhone: string): Promise<EnrollmentRow | undefined> {
    return new Promise((resolve, reject) => {
      this.db.get<EnrollmentRow>(
        `SELECT * FROM enrollments WHERE facility_id = ? AND user_phone = ?`,
        [facilityId, userPhone],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  getByFacility(facilityId: number): Promise<EnrollmentRow[]> {
    return new Promise((resolve, reject) => {
      this.db.all<EnrollmentRow>(
        `SELECT * FROM enrollments WHERE facility_id = ? ORDER BY enrolled_at DESC, id DESC`,
        [facilityId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  // Pre-check-then-insert-then-catch-the-race shape, same idiom as
  // JobRepository#enqueue's dedupeKey handling and app.ts's own
  // POST /journal/entries client_entry_id dedupe — the UNIQUE index is
  // the actual race guard; this resolves the existing row instead of
  // erroring on a repeat enroll() call for the same (facility, phone).
  enroll(input: EnrollInput): Promise<EnrollmentRow> {
    const db = this.db;
    const plan = input.plan ?? 'anc_bundle';
    const priceKes = input.priceKes ?? 5000;
    const enrolledBy = input.enrolledBy ?? null;

    const insert = (): Promise<EnrollmentRow> =>
      new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO enrollments (facility_id, user_phone, enrolled_by, status, plan, price_kes)
           VALUES (?, ?, ?, 'active', ?, ?)`,
          [input.facilityId, input.userPhone, enrolledBy, plan, priceKes],
          function (err) {
            if (err) return reject(err);
            const id = this.lastID;
            db.get<EnrollmentRow>(`SELECT * FROM enrollments WHERE id = ?`, [id], (err2, row) => {
              if (err2) return reject(err2);
              if (!row) return reject(new Error('enrollments row vanished immediately after insert'));
              resolve(row);
            });
          }
        );
      });

    return insert().catch((err) => {
      if (!isUniqueConstraintError(err)) throw err;
      return this.getByFacilityAndPhone(input.facilityId, input.userPhone).then((row) => {
        if (!row) throw err; // shouldn't happen; don't swallow the original error silently
        return row;
      });
    });
  }
}
