// SQLite implementation of JobRepository (P4-A durable job queue). See
// packages/core/src/repositories.ts's Jobs section for the interface
// contract and packages/core/src/jobs.ts for the pure backoff/retry
// policy this file leans on (computeBackoff/nextRunAt/shouldRetry) —
// this file is storage + the atomic-claim mechanics only.
//
// CONCURRENCY / SQLITE LIMITS (claimDueJobs):
//
// The pending -> running transition happens inside a SINGLE UPDATE
// statement whose target rows are chosen by a LIMIT-bounded subquery:
//
//   UPDATE jobs SET status='running', ...
//   WHERE id IN (SELECT id FROM jobs WHERE status='pending' AND run_at
//                <= ? ORDER BY run_at, id LIMIT ?)
//
// SQLite executes a single statement as one atomic unit against a
// consistent snapshot, and only one writer can hold the database's write
// lock at a time (enforced at the FILE level — see connection.ts's
// busyTimeout comment). So two callers — whether two calls on this same
// connection, or two entirely separate processes each with their own
// connection to the same file — can never both flip the SAME row from
// 'pending' to 'running': whichever UPDATE's write transaction commits
// first "wins" every row it touched, and the loser's subquery (evaluated
// as part of ITS OWN statement, against the post-first-UPDATE state)
// simply no longer sees status='pending' for those rows.
//
// Each call still needs to know exactly WHICH rows it personally won,
// since two callers' candidate-selection windows can legitimately
// overlap before either commits (e.g. both see job #7 as a pending
// candidate; only one of them actually claims it). We tag every claim
// with a per-call-unique token — `${workerId}:${randomUUID()}` — written
// into locked_by, then read back exactly the rows carrying that exact
// token. This is stronger than keying off workerId alone: two calls that
// happen to share a workerId (e.g. a naive multi-instance deployment
// with a hostname-derived id) still can't be confused with each other.
//
// LIMITS:
//  - SQLite allows only one writer across the WHOLE file at a time. A
//    writer that can't get the lock within connection.ts's busyTimeout
//    gets a hard SQLITE_BUSY rejection, not a queued wait — the caller
//    (apps/server/src/jobWorker.ts's poll loop) simply retries on its
//    next cycle; a single busy failure just delays that batch by one
//    poll interval, not silent data loss.
//  - This is FILE-level locking, not a distributed lock — the whole
//    design assumes one SQLite file backing one logical queue, matching
//    this codebase's current single-node deployment (see CLAUDE.md's
//    "Repository pattern is the Postgres seam" note). A future
//    horizontally-scaled deployment on Postgres would use that store's
//    own primitives (e.g. `SELECT ... FOR UPDATE SKIP LOCKED`) instead
//    of this SQLite-specific claim mechanism — a new adapter's problem,
//    not something this file needs to anticipate.
//  - At pilot scale (one Node process running one poller against one
//    local file) neither limit is ever actually exercised; they matter
//    if this pattern is later reused with multiple worker processes.

import type sqlite3 from 'sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  EnqueueJobInput,
  JobRecord,
  JobRepository,
  JobStatus,
} from '@amaaii/core';
import { nextRunAt, shouldRetry, DEFAULT_JOB_MAX_ATTEMPTS } from '@amaaii/core';

interface JobRow {
  id: number;
  type: string;
  payload: string;
  run_at: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  locked_at: string | null;
  locked_by: string | null;
  dedupe_key: string | null;
  created_at: string;
  updated_at: string;
}

function toJobRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    runAt: row.run_at,
    status: row.status as JobStatus,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Same duck-typed "does this look like a UNIQUE violation" check as
// apps/server/src/app.ts's isUniqueConstraintError — kept as a private
// copy here rather than shared, matching how that check already isn't
// shared with journalRepository.ts's own client_entry_id race handling.
function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

export class SqliteJobRepository implements JobRepository {
  constructor(private readonly db: sqlite3.Database) {}

  enqueue(input: EnqueueJobInput): Promise<JobRecord> {
    const dedupeKey = input.dedupeKey ?? null;
    const maxAttempts = input.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS;
    const payloadJson = JSON.stringify(input.payload ?? {});
    const db = this.db;

    const readById = (id: number): Promise<JobRecord> =>
      new Promise((resolve, reject) => {
        db.get<JobRow>(`SELECT * FROM jobs WHERE id = ?`, [id], (err, row) => {
          if (err) return reject(err);
          if (!row) return reject(new Error(`jobs row ${id} vanished immediately after insert`));
          resolve(toJobRecord(row));
        });
      });

    const readByDedupeKey = (key: string): Promise<JobRecord | undefined> =>
      new Promise((resolve, reject) => {
        db.get<JobRow>(`SELECT * FROM jobs WHERE dedupe_key = ?`, [key], (err, row) => {
          if (err) return reject(err);
          resolve(row ? toJobRecord(row) : undefined);
        });
      });

    const insert = (): Promise<JobRecord> =>
      new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO jobs (type, payload, run_at, status, attempts, max_attempts, dedupe_key, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', 0, ?, ?, datetime('now'), datetime('now'))`,
          [input.type, payloadJson, input.runAt, maxAttempts, dedupeKey],
          function (err) {
            if (err) return reject(err);
            resolve(readById(this.lastID));
          }
        );
      });

    if (!dedupeKey) return insert();

    // Pre-check avoids an unnecessary failed INSERT in the common
    // no-conflict case; it is NOT what makes this race-safe on its own
    // — the catch below (racing the UNIQUE index itself) is what makes
    // it safe under a genuine concurrent double-enqueue, same
    // pre-check-then-catch shape as app.ts's POST /journal/entries
    // idempotency handling for client_entry_id.
    return readByDedupeKey(dedupeKey).then((existing) => {
      if (existing) return existing;
      return insert().catch((err) => {
        if (!isUniqueConstraintError(err)) throw err;
        return readByDedupeKey(dedupeKey).then((row) => {
          if (!row) throw err; // shouldn't happen; don't swallow the original error silently
          return row;
        });
      });
    });
  }

  claimDueJobs(now: string, limit: number, workerId: string): Promise<JobRecord[]> {
    const claimToken = `${workerId}:${randomUUID()}`;
    const db = this.db;
    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE jobs
         SET status = 'running', locked_at = ?, locked_by = ?, updated_at = ?
         WHERE id IN (
           SELECT id FROM jobs
           WHERE status = 'pending' AND run_at <= ?
           ORDER BY run_at ASC, id ASC
           LIMIT ?
         )`,
        [now, claimToken, now, now, limit],
        (err) => {
          if (err) return reject(err);
          db.all<JobRow>(
            `SELECT * FROM jobs WHERE locked_by = ? ORDER BY run_at ASC, id ASC`,
            [claimToken],
            (err2, rows) => {
              if (err2) return reject(err2);
              resolve((rows || []).map(toJobRecord));
            }
          );
        }
      );
    });
  }

  markDone(id: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE jobs
         SET status = 'done', locked_at = NULL, locked_by = NULL, updated_at = datetime('now')
         WHERE id = ?`,
        [id],
        (err) => (err ? reject(err) : resolve())
      );
    });
  }

  markFailedOrRetry(id: number, error: string, now: string): Promise<void> {
    const db = this.db;
    return new Promise((resolve, reject) => {
      db.get<JobRow>(`SELECT * FROM jobs WHERE id = ?`, [id], (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve(); // job vanished — nothing to update.

        const attempts = row.attempts + 1;
        if (shouldRetry(attempts, row.max_attempts)) {
          const runAt = nextRunAt(new Date(now), attempts).toISOString();
          db.run(
            `UPDATE jobs
             SET status = 'pending', attempts = ?, run_at = ?, last_error = ?,
                 locked_at = NULL, locked_by = NULL, updated_at = ?
             WHERE id = ?`,
            [attempts, runAt, error, now, id],
            (err2) => (err2 ? reject(err2) : resolve())
          );
        } else {
          db.run(
            `UPDATE jobs
             SET status = 'failed', attempts = ?, last_error = ?,
                 locked_at = NULL, locked_by = NULL, updated_at = ?
             WHERE id = ?`,
            [attempts, error, now, id],
            (err2) => (err2 ? reject(err2) : resolve())
          );
        }
      });
    });
  }

  reclaimStuck(now: string, staleMs: number): Promise<number> {
    const db = this.db;
    const cutoff = new Date(new Date(now).getTime() - staleMs).toISOString();

    return new Promise((resolve, reject) => {
      db.all<JobRow>(
        `SELECT * FROM jobs WHERE status = 'running' AND locked_at IS NOT NULL AND locked_at <= ?`,
        [cutoff],
        (err, rows) => {
          if (err) return reject(err);
          const stuck = rows || [];
          if (stuck.length === 0) return resolve(0);

          // Sequential, not Promise.all — these are independent UPDATEs
          // against the same connection; sequencing keeps this simple
          // and avoids any question of statement interleaving. Reclaim
          // runs once per poll cycle over a normally-tiny set, so the
          // lack of parallelism here is not a real cost.
          const applyOne = (i: number): Promise<void> => {
            if (i >= stuck.length) return Promise.resolve();
            const row = stuck[i];
            const attempts = row.attempts + 1;
            const note = shouldRetry(attempts, row.max_attempts)
              ? 'reclaimed: stale lock (worker likely crashed mid-execution)'
              : 'reclaimed: stale lock, max attempts exceeded';

            const next = (): Promise<void> => applyOne(i + 1);

            if (shouldRetry(attempts, row.max_attempts)) {
              const runAt = nextRunAt(new Date(now), attempts).toISOString();
              return new Promise<void>((res, rej) => {
                db.run(
                  `UPDATE jobs
                   SET status = 'pending', attempts = ?, run_at = ?, last_error = ?,
                       locked_at = NULL, locked_by = NULL, updated_at = ?
                   WHERE id = ? AND status = 'running'`,
                  [attempts, runAt, note, now, row.id],
                  (err2) => (err2 ? rej(err2) : res())
                );
              }).then(next);
            }
            return new Promise<void>((res, rej) => {
              db.run(
                `UPDATE jobs
                 SET status = 'failed', attempts = ?, last_error = ?,
                     locked_at = NULL, locked_by = NULL, updated_at = ?
                 WHERE id = ? AND status = 'running'`,
                [attempts, note, now, row.id],
                (err2) => (err2 ? rej(err2) : res())
              );
            }).then(next);
          };

          applyOne(0)
            .then(() => resolve(stuck.length))
            .catch(reject);
        }
      );
    });
  }

  countByStatus(): Promise<Record<JobStatus, number>> {
    return new Promise((resolve, reject) => {
      this.db.all<{ status: string; count: number }>(
        `SELECT status, COUNT(*) as count FROM jobs GROUP BY status`,
        [],
        (err, rows) => {
          if (err) return reject(err);
          const result: Record<JobStatus, number> = { pending: 0, running: 0, done: 0, failed: 0 };
          for (const row of rows || []) {
            if (row.status in result) result[row.status as JobStatus] = row.count;
          }
          resolve(result);
        }
      );
    });
  }
}
