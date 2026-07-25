// Connection + schema for the SQLite adapter (P1-C). Ported 1:1 from the
// top of services/database.js — see CLAUDE.md's "Repository pattern"
// work package. This is the only file in the SQLite adapter that reads
// process.env or touches the filesystem path; every repository class
// below just receives an already-open sqlite3.Database.

import sqlite3 from 'sqlite3';
import path from 'path';

// This file lives at packages/adapters/src/sqlite/connection.ts, four
// directories below the repo root (sqlite -> src -> adapters -> packages
// -> root). The original services/database.js computed its default path
// as `path.join(__dirname, '..', 'amaaii.db')` from services/ (one level
// up from the repo root) — this is the same default, just re-anchored
// for this file's location.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/** Resolves the on-disk DB path exactly like the original module did:
 *  `DB_PATH` env override (tests pass `:memory:`), else `<repoRoot>/amaaii.db`. */
export function resolveDbPath(explicitPath?: string): string {
  if (explicitPath) return explicitPath;
  return process.env.DB_PATH || path.join(REPO_ROOT, 'amaaii.db');
}

/** Opens (or creates) the sqlite3 database file at the resolved path. */
export function createConnection(dbPath?: string): sqlite3.Database {
  return new sqlite3.Database(resolveDbPath(dbPath));
}

// P1-E: utils/logger.js is gone — the logger now lives in
// apps/server/src/logger.ts as real TypeScript, so this can be a normal
// `import` instead of the untyped `require()` the old CJS shim needed.
// This does mean packages/adapters depends on a file inside apps/server
// (the reverse of the usual app -> package direction); that's an
// intentional, pre-existing shortcut carried over unchanged from P1-C
// (it previously depended on utils/logger.js the same way) — not
// something introduced by this migration.
import { log } from '../../../../apps/server/src/logger';

/**
 * Creates tables/indexes and runs idempotent migrations. Ported 1:1 from
 * services/database.js#initializeDatabase(), including the PRAGMA-based
 * "does this column already exist" checks that avoid the "duplicate
 * column" error a bare ALTER TABLE would throw on a fresh schema, and
 * the db.serialize() wrapper that keeps every statement's execution
 * order deterministic under sqlite3's async callback API.
 */
export function initializeSchema(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve) => {
    db.serialize(() => {
      db.run(
        `
        CREATE TABLE IF NOT EXISTS users (
          phone_number TEXT PRIMARY KEY,
          name TEXT,
          age INTEGER,
          pregnancy_week INTEGER,
          edd DATE,
          location TEXT,
          risk_level TEXT DEFAULT 'low',
          lmp DATE,
          anc_visits INTEGER DEFAULT 0,
          language TEXT DEFAULT 'en',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `,
        (err) => {
          if (err) log.error('Error creating users table', err);
        }
      );

      // Idempotent migration: add language column on existing DBs.
      // PRAGMA-based check avoids the "duplicate column" error from a
      // bare ALTER TABLE on a fresh schema.
      db.all<{ name: string }>(`PRAGMA table_info(users)`, (err, rows) => {
        if (err) return;
        const hasLanguage = (rows || []).some((r) => r.name === 'language');
        if (!hasLanguage) {
          db.run(`ALTER TABLE users ADD COLUMN language TEXT DEFAULT 'en'`, (e) => {
            if (e) log.error('Error adding users.language column', e);
          });
        }
      });

      db.run(
        `
        CREATE TABLE IF NOT EXISTS conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_phone TEXT NOT NULL,
          message TEXT,
          response TEXT,
          danger_signs_detected TEXT,
          urgency_level TEXT,
          context TEXT,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_phone) REFERENCES users(phone_number)
        )
      `,
        (err) => {
          if (err) log.error('Error creating conversations table', err);
        }
      );

      db.run(
        `
        CREATE TABLE IF NOT EXISTS symptoms (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_phone TEXT NOT NULL,
          symptoms TEXT,
          mood TEXT,
          urgency TEXT,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_phone) REFERENCES users(phone_number)
        )
      `,
        (err) => {
          if (err) log.error('Error creating symptoms table', err);
        }
      );

      db.run(
        `
        CREATE TABLE IF NOT EXISTS anc_visits (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_phone TEXT NOT NULL,
          scheduled_date DATE,
          attended BOOLEAN DEFAULT 0,
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_phone) REFERENCES users(phone_number)
        )
      `,
        (err) => {
          if (err) log.error('Error creating anc_visits table', err);
        }
      );

      db.run(
        `
        CREATE TABLE IF NOT EXISTS journals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_phone TEXT NOT NULL,
          date DATE DEFAULT (date('now')),
          journal_stage TEXT,
          physical_symptoms TEXT,
          emotional_state INTEGER,
          mood_description TEXT,
          energy_level INTEGER,
          sleep_quality INTEGER,
          sleep_hours REAL,
          appetite TEXT,
          baby_movement_count INTEGER,
          baby_movement_time TEXT,
          water_intake INTEGER,
          medications_taken TEXT,
          questions_for_doctor TEXT,
          special_notes TEXT,
          red_flags_detected TEXT,
          completed BOOLEAN DEFAULT 0,
          started_at DATETIME,
          completed_at DATETIME,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_phone) REFERENCES users(phone_number)
        )
      `,
        (err) => {
          if (err) log.error('Error creating journals table', err);
        }
      );

      // Idempotent migration for journals.started_at / completed_at on
      // existing DBs. PRAGMA-based check avoids the "duplicate column"
      // error from a bare ALTER TABLE on a fresh schema.
      db.all<{ name: string }>(`PRAGMA table_info(journals)`, (err, rows) => {
        if (err) return;
        const have = new Set((rows || []).map((r) => r.name));
        if (!have.has('started_at')) {
          db.run(`ALTER TABLE journals ADD COLUMN started_at DATETIME`, (e) => {
            if (e) log.error('Error adding journals.started_at', e);
          });
        }
        if (!have.has('completed_at')) {
          db.run(`ALTER TABLE journals ADD COLUMN completed_at DATETIME`, (e) => {
            if (e) log.error('Error adding journals.completed_at', e);
          });
        }
      });

      // Idempotent migration: journals.client_entry_id (P2-C). Nullable —
      // only the PWA structured check-in form (POST /journal/entries)
      // sets it, as an idempotency key so a double-tap/retry from the
      // same client can't double-write a journal row. WhatsApp-originated
      // rows never set this column.
      //
      // The CREATE UNIQUE INDEX is chained inside the ALTER's own
      // callback (rather than issued as a sibling top-level statement)
      // so it's only ever queued once the column is known to exist —
      // node-sqlite3's serialized queue guarantees relative order for
      // statements queued this way, even though the ALTER itself runs
      // inside an async PRAGMA callback (same pattern already used above
      // for started_at/completed_at and below for journal_sessions.journal_id).
      db.all<{ name: string }>(`PRAGMA table_info(journals)`, (err, rows) => {
        if (err) return;
        const have = new Set((rows || []).map((r) => r.name));
        const ensureClientEntryIndex = () => {
          // Partial unique index — only enforced when client_entry_id is
          // non-NULL, so WhatsApp rows (which never set it) never collide.
          // Partial indexes have been supported since SQLite 3.8.0 (2013),
          // well within range of the bundled sqlite3 driver.
          db.run(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_journals_client_entry_id
             ON journals(user_phone, client_entry_id)
             WHERE client_entry_id IS NOT NULL`,
            (e) => {
              if (e) log.error('Error creating journals client_entry_id index', e);
            }
          );
        };
        if (!have.has('client_entry_id')) {
          db.run(`ALTER TABLE journals ADD COLUMN client_entry_id TEXT`, (e) => {
            if (e) log.error('Error adding journals.client_entry_id', e);
            else ensureClientEntryIndex();
          });
        } else {
          ensureClientEntryIndex();
        }
      });

      db.run(
        `
        CREATE TABLE IF NOT EXISTS journal_sessions (
          user_phone TEXT PRIMARY KEY,
          current_stage TEXT NOT NULL,
          journal_data TEXT NOT NULL,
          journal_id INTEGER,
          channel TEXT NOT NULL DEFAULT 'whatsapp',
          started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_phone) REFERENCES users(phone_number),
          FOREIGN KEY (journal_id) REFERENCES journals(id)
        )
      `,
        (err) => {
          if (err) log.error('Error creating journal_sessions table', err);
        }
      );

      // Idempotent migration: journal_sessions.journal_id on older DBs.
      db.all<{ name: string }>(`PRAGMA table_info(journal_sessions)`, (err, rows) => {
        if (err) return;
        const have = new Set((rows || []).map((r) => r.name));
        if (!have.has('journal_id')) {
          db.run(`ALTER TABLE journal_sessions ADD COLUMN journal_id INTEGER`, (e) => {
            if (e) log.error('Error adding journal_sessions.journal_id', e);
          });
        }
      });

      // Medical history (Phase D). 1:1 with users. raw_text is the
      // narrative the user typed; extracted_json is the LLM-structured
      // version (gravida/parity/conditions/etc.) for downstream use.
      db.run(
        `
        CREATE TABLE IF NOT EXISTS medical_history (
          user_phone TEXT PRIMARY KEY,
          raw_text TEXT,
          extracted_json TEXT,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_phone) REFERENCES users(phone_number)
        )
      `,
        (err) => {
          if (err) log.error('Error creating medical_history table', err);
        }
      );

      db.run(
        `CREATE INDEX IF NOT EXISTS idx_journal_sessions_updated
         ON journal_sessions(updated_at)`,
        (err) => {
          if (err) log.error('Error creating journal_sessions index', err);
        }
      );

      // OTP codes (P2-B). One row per phone — a fresh /auth/otp/request
      // wholesale-replaces the row (see SqliteOtpRepository#createOrReplace).
      // sent_timestamps is a JSON array of ISO strings: the rolling send
      // history that packages/core/src/otp.ts#checkOtpRateLimit prunes
      // against to enforce "max 3 sends per phone per rolling hour".
      // code_hash is HMAC-SHA256(phone:code) — the plaintext code is
      // never persisted (see apps/server/src/otp.ts).
      db.run(
        `
        CREATE TABLE IF NOT EXISTS otp_codes (
          phone TEXT PRIMARY KEY,
          code_hash TEXT NOT NULL,
          expires_at DATETIME NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          sent_timestamps TEXT NOT NULL DEFAULT '[]',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `,
        (err) => {
          if (err) log.error('Error creating otp_codes table', err);
        }
      );

      db.run(
        `CREATE INDEX IF NOT EXISTS idx_otp_codes_expires_at ON otp_codes(expires_at)`,
        (err) => {
          if (err) log.error('Error creating otp_codes index', err);
        }
      );

      // Consent ledger (P3-A, Kenya DPA). Append-only — no UPDATE path
      // ever touches this table; see packages/core/src/repositories.ts's
      // ConsentRecord header for why granted/revoked_at live together on
      // one immutable row instead of a row that gets mutated later.
      // granted is stored as 0/1 (sqlite has no native boolean).
      db.run(
        `
        CREATE TABLE IF NOT EXISTS consents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_phone TEXT NOT NULL,
          purpose TEXT NOT NULL,
          granted INTEGER NOT NULL,
          version INTEGER NOT NULL,
          granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          revoked_at DATETIME,
          FOREIGN KEY (user_phone) REFERENCES users(phone_number)
        )
      `,
        (err) => {
          if (err) log.error('Error creating consents table', err);
        }
      );

      db.run(`CREATE INDEX IF NOT EXISTS idx_consents_user_phone ON consents(user_phone)`, (err) => {
        if (err) log.error('Error creating consents index', err);
      });

      // Audit log (P3-A, Kenya DPA). Append-only — the data-subject
      // "who accessed my data" view (AuditRepository#listForUser) and
      // any future compliance export both read this table; nothing ever
      // updates or deletes a row out of it.
      db.run(
        `
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          resource TEXT NOT NULL,
          resource_owner TEXT NOT NULL,
          metadata TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `,
        (err) => {
          if (err) log.error('Error creating audit_log table', err);
        }
      );

      db.run(
        `CREATE INDEX IF NOT EXISTS idx_audit_log_resource_owner ON audit_log(resource_owner)`,
        (err) => {
          if (err) log.error('Error creating audit_log index', err);
          else resolve();
        }
      );
    });
  });
}
