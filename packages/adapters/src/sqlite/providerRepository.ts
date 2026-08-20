// SQLite implementation of ProviderRepository (P5-A, provider portal).
// Provider rows are a hospital's own staff record, not mother data — see
// packages/core/src/repositories.ts's "Provider portal" section header
// for why this table is outside the DPA erasure cascade.

import type sqlite3 from 'sqlite3';
import type { CreateProviderInput, ProviderRepository, ProviderRow } from '@amaaii/core';

export class SqliteProviderRepository implements ProviderRepository {
  constructor(private readonly db: sqlite3.Database) {}

  getById(id: number): Promise<ProviderRow | undefined> {
    return new Promise((resolve, reject) => {
      this.db.get<ProviderRow>(`SELECT * FROM providers WHERE id = ?`, [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  getByEmail(email: string): Promise<ProviderRow | undefined> {
    return new Promise((resolve, reject) => {
      this.db.get<ProviderRow>(`SELECT * FROM providers WHERE email = ?`, [email], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  // Seed/test seam only — provider self-registration is out of scope for
  // the Friday demo slice (see this repository's header comment).
  create(input: CreateProviderInput): Promise<ProviderRow> {
    const db = this.db;
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO providers (facility_id, email, name, role, license_number, password_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          input.facilityId,
          input.email,
          input.name,
          input.role,
          input.licenseNumber ?? null,
          input.passwordHash,
        ],
        function (err) {
          if (err) return reject(err);
          const id = this.lastID;
          db.get<ProviderRow>(`SELECT * FROM providers WHERE id = ?`, [id], (err2, row) => {
            if (err2) return reject(err2);
            if (!row) return reject(new Error('providers row vanished immediately after insert'));
            resolve(row);
          });
        }
      );
    });
  }
}
