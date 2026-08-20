// SQLite implementation of EscalationAckRepository (P6, provider triage
// queue). The one provider-portal table in this section that IS mother
// data — see erasure.ts's ERASURE_TARGETS, which clears this table on
// DELETE /me/account, same enrollments/jobs precedent.

import type sqlite3 from 'sqlite3';
import type { AckEscalationInput, EscalationAckRepository, EscalationAckRow } from '@amaaii/core';

interface EscalationAckDbRow {
  id: number;
  facility_id: number;
  user_phone: string;
  escalation_at: string;
  acknowledged_by: number | null;
  acknowledged_at: string;
}

function toEscalationAckRow(row: EscalationAckDbRow): EscalationAckRow {
  return {
    id: row.id,
    facilityId: row.facility_id,
    userPhone: row.user_phone,
    escalationAt: row.escalation_at,
    // acknowledged_by is nullable at the schema level (see connection.ts)
    // but every INSERT this repository issues always supplies it (see
    // ack() below) — the column only stays nullable for defensive schema
    // hygiene, not because a real ack row is ever missing it. Cast, not
    // re-validated, matching AckEscalationInput#acknowledgedBy's own
    // `number` (never optional) type.
    acknowledgedBy: row.acknowledged_by as number,
    acknowledgedAt: row.acknowledged_at,
  };
}

// Same duck-typed "does this look like a UNIQUE violation" check as
// enrollmentRepository.ts's own copy (kept private here rather than
// shared, matching that file's own precedent).
function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

export class SqliteEscalationAckRepository implements EscalationAckRepository {
  constructor(private readonly db: sqlite3.Database) {}

  getByFacility(facilityId: number): Promise<EscalationAckRow[]> {
    return new Promise((resolve, reject) => {
      this.db.all<EscalationAckDbRow>(
        `SELECT * FROM escalation_acks WHERE facility_id = ?`,
        [facilityId],
        (err, rows) => {
          if (err) reject(err);
          else resolve((rows || []).map(toEscalationAckRow));
        }
      );
    });
  }

  private getOne(facilityId: number, userPhone: string, escalationAt: string): Promise<EscalationAckRow | undefined> {
    return new Promise((resolve, reject) => {
      this.db.get<EscalationAckDbRow>(
        `SELECT * FROM escalation_acks WHERE facility_id = ? AND user_phone = ? AND escalation_at = ?`,
        [facilityId, userPhone, escalationAt],
        (err, row) => {
          if (err) reject(err);
          else resolve(row ? toEscalationAckRow(row) : undefined);
        }
      );
    });
  }

  // Pre-check-then-insert-then-catch-the-race shape, same idiom as
  // EnrollmentRepository#enroll / JobRepository#enqueue's dedupeKey
  // handling — the UNIQUE index is the actual race guard; this resolves
  // the existing row instead of erroring on a repeat ack() call for the
  // same (facility, phone, escalation).
  ack(input: AckEscalationInput): Promise<EscalationAckRow> {
    const db = this.db;

    const insert = (): Promise<EscalationAckRow> =>
      new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO escalation_acks (facility_id, user_phone, escalation_at, acknowledged_by)
           VALUES (?, ?, ?, ?)`,
          [input.facilityId, input.userPhone, input.escalationAt, input.acknowledgedBy],
          function (err) {
            if (err) return reject(err);
            const id = this.lastID;
            db.get<EscalationAckDbRow>(`SELECT * FROM escalation_acks WHERE id = ?`, [id], (err2, row) => {
              if (err2) return reject(err2);
              if (!row) return reject(new Error('escalation_acks row vanished immediately after insert'));
              resolve(toEscalationAckRow(row));
            });
          }
        );
      });

    return insert().catch((err) => {
      if (!isUniqueConstraintError(err)) throw err;
      return this.getOne(input.facilityId, input.userPhone, input.escalationAt).then((row) => {
        if (!row) throw err; // shouldn't happen; don't swallow the original error silently
        return row;
      });
    });
  }
}
