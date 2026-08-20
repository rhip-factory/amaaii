// SQLite implementation of FacilityRepository (P5-A, provider portal).
// Facility rows are a hospital's own organisation record, not mother
// data — see packages/core/src/repositories.ts's "Provider portal"
// section header for why this table is outside the DPA erasure cascade.

import type sqlite3 from 'sqlite3';
import type { CreateFacilityInput, FacilityRepository, FacilityRow } from '@amaaii/core';

export class SqliteFacilityRepository implements FacilityRepository {
  constructor(private readonly db: sqlite3.Database) {}

  getById(id: number): Promise<FacilityRow | undefined> {
    return new Promise((resolve, reject) => {
      this.db.get<FacilityRow>(`SELECT * FROM facilities WHERE id = ?`, [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  getByCode(code: string): Promise<FacilityRow | undefined> {
    return new Promise((resolve, reject) => {
      this.db.get<FacilityRow>(`SELECT * FROM facilities WHERE code = ?`, [code], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  // Seed/test seam only — no HTTP route creates a facility (see this
  // repository's header comment); production rows are inserted by hand.
  create(input: CreateFacilityInput): Promise<FacilityRow> {
    const db = this.db;
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO facilities (name, code, county) VALUES (?, ?, ?)`,
        [input.name, input.code, input.county ?? null],
        function (err) {
          if (err) return reject(err);
          const id = this.lastID;
          db.get<FacilityRow>(`SELECT * FROM facilities WHERE id = ?`, [id], (err2, row) => {
            if (err2) return reject(err2);
            if (!row) return reject(new Error('facilities row vanished immediately after insert'));
            resolve(row);
          });
        }
      );
    });
  }
}
