// Ported 1:1 from services/database.js — createUser/getUser/updateUser.
// See CLAUDE.md: commit 5c22647 fixed the createUser upsert (D15: never
// null out columns the caller didn't pass) and the updateUser key
// whitelist (D14: reject unknown columns before they ever reach SQL).
// Both fixes are load-bearing and preserved verbatim below.

import type sqlite3 from 'sqlite3';
import type {
  CreateUserInput,
  UpdateUserInput,
  UserRepository,
  UserRow,
} from '@amaaii/core';

// userData keys that can be persisted (UI / Twilio occasionally sends
// `pregnancyWeek` camelCase — we map it to the snake_case column).
const USER_FIELD_MAP: Record<string, string> = {
  name: 'name',
  age: 'age',
  pregnancyWeek: 'pregnancy_week',
  pregnancy_week: 'pregnancy_week',
  edd: 'edd',
  location: 'location',
  lmp: 'lmp',
  risk_level: 'risk_level',
  anc_visits: 'anc_visits',
  language: 'language',
};

// D14: defense in depth — reject unknown columns at the DB layer too.
// The only allowed targets are real users-table columns. Aside from the
// safety win, this means SQL identifiers can never be user-controlled.
const UPDATE_USER_ALLOWED = new Set([
  'name',
  'age',
  'pregnancy_week',
  'edd',
  'location',
  'lmp',
  'risk_level',
  'anc_visits',
  'language',
]);

export class SqliteUserRepository implements UserRepository {
  constructor(private readonly db: sqlite3.Database) {}

  async createUser(phoneNumber: string, userData: CreateUserInput = {}): Promise<number | null> {
    // D15: don't INSERT OR REPLACE — that nulls out columns we didn't pass.
    // If the row exists, UPDATE only the provided fields; otherwise INSERT.
    const existing = await this.getUser(phoneNumber);
    if (existing) {
      const updates: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(userData)) {
        const col = USER_FIELD_MAP[k];
        if (col && v !== undefined) updates[col] = v;
      }
      if (Object.keys(updates).length > 0) {
        await this.updateUser(phoneNumber, updates as UpdateUserInput);
      }
      return (existing as unknown as { rowid?: number }).rowid || null;
    }

    return new Promise((resolve, reject) => {
      const { name, age, pregnancyWeek, pregnancy_week, edd, location, lmp } = userData;
      const week = pregnancyWeek != null ? pregnancyWeek : pregnancy_week;
      this.db.run(
        `INSERT INTO users
           (phone_number, name, age, pregnancy_week, edd, location, lmp, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [phoneNumber, name, age, week, edd, location, lmp],
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  getUser(phoneNumber: string): Promise<UserRow | undefined> {
    return new Promise((resolve, reject) => {
      this.db.get<UserRow>(
        'SELECT * FROM users WHERE phone_number = ?',
        [phoneNumber],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  // async (not a plain function returning a Promise): the whitelist
  // check below throws synchronously, and only an `async` function
  // converts a thrown error into a rejected Promise. Callers rely on
  // `updateUser(...).catch()` / `await expect(...).rejects` — see
  // tests/database.test.js.
  async updateUser(phoneNumber: string, updates: UpdateUserInput): Promise<number> {
    const keys = Object.keys(updates);
    for (const key of keys) {
      if (!UPDATE_USER_ALLOWED.has(key)) {
        throw new Error(`updateUser: rejected non-whitelisted key "${key}"`);
      }
    }
    const fields = keys.map((key) => `${key} = ?`).join(', ');
    const values: unknown[] = Object.values(updates);
    values.push(phoneNumber);

    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE users SET ${fields}, updated_at = datetime('now') WHERE phone_number = ?`,
        values,
        function (err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
  }
}
