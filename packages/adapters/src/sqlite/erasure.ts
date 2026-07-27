// Kenya DPA erasure right (P3-C). Implements DatabaseAdapter#eraseUser —
// see that method's doc comment in packages/core/src/repositories.ts for
// the full rationale (in particular: WHY audit_log is deliberately left
// untouched). This file is only the mechanics: a single transaction that
// hard-deletes a phone's rows from every other user-data table.

import type sqlite3 from 'sqlite3';

// (table, column) pairs to clear, in delete order. Column names differ
// per table (otp_codes keys on `phone`, users on `phone_number`,
// everything else on `user_phone`) — see connection.ts's CREATE TABLE
// statements for the canonical schema. `users` is deleted LAST: every
// other table above references phone_number via its own user_phone/phone
// column, so clearing the referencing rows first is a defensive ordering
// choice, even though SQLite FK enforcement is off in this schema (no
// `PRAGMA foreign_keys = ON` anywhere in connection.ts) and nothing here
// actually depends on the order for correctness.
//
// journal_sessions is included (erasure clears it) even though it holds
// only in-progress WhatsApp stage-machine state, not durable "data" —
// the work order is explicit that erasure covers it. audit_log is
// deliberately ABSENT from this list; see the eraseUser() doc comment.
//
// jobs (P4-B, carried over from P4-A's durable job queue landing without
// this): matched on the best-effort `user_phone` column populated at
// enqueue time from a phone-shaped payload (see JobRecord#userPhone's
// doc comment in packages/core/src/repositories.ts) — a job whose
// payload never carried a phone (none exist today, but a future job
// type might not) simply has user_phone=NULL and is untouched by this
// DELETE, same as it would be by any other WHERE-clause-scoped erasure.
const ERASURE_TARGETS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'conversations', column: 'user_phone' },
  { table: 'symptoms', column: 'user_phone' },
  { table: 'anc_visits', column: 'user_phone' },
  { table: 'journals', column: 'user_phone' },
  { table: 'journal_sessions', column: 'user_phone' },
  { table: 'medical_history', column: 'user_phone' },
  { table: 'otp_codes', column: 'phone' },
  { table: 'consents', column: 'user_phone' },
  { table: 'jobs', column: 'user_phone' },
  { table: 'users', column: 'phone_number' },
];

/**
 * Hard-deletes every row keyed to `phone` across ERASURE_TARGETS, inside
 * a single BEGIN/COMMIT transaction — a failure partway through rolls
 * everything back rather than leaving some tables cleared and others
 * not. `phone` is always bound via a `?` placeholder, never
 * interpolated, so this can never delete more than the one phone passed
 * in; table/column names above are fixed literals, never user input.
 *
 * Sequencing note: each DELETE is awaited before the next is issued
 * (rather than firing all of them synchronously inside one
 * db.serialize() callback) so that a failure on statement N is caught
 * and turned into a ROLLBACK *before* statement N+1 is ever queued —
 * queuing every statement up front and reacting to an error later would
 * let the later, already-queued statements (including COMMIT) run
 * regardless of the earlier failure. db.serialize() still wraps the
 * whole sequence so unrelated queries on this shared connection can't
 * interleave with it.
 */
export function eraseUserData(db: sqlite3.Database, phone: string): Promise<void> {
  const run = (sql: string, params: unknown[] = []): Promise<void> =>
    new Promise((resolve, reject) => {
      db.run(sql, params, (err) => (err ? reject(err) : resolve()));
    });

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      (async () => {
        try {
          await run('BEGIN TRANSACTION');
          for (const { table, column } of ERASURE_TARGETS) {
            await run(`DELETE FROM ${table} WHERE ${column} = ?`, [phone]);
          }
          await run('COMMIT');
          resolve();
        } catch (err) {
          // Best-effort rollback — reject with the ORIGINAL error either
          // way; a failed ROLLBACK isn't more informative than the
          // failure that triggered it.
          db.run('ROLLBACK', () => reject(err));
        }
      })();
    });
  });
}
