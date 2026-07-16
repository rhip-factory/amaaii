// Ported 1:1 from services/database.js — saveSymptoms.

import type sqlite3 from 'sqlite3';
import type { SymptomRepository } from '@amaaii/core';

export class SqliteSymptomRepository implements SymptomRepository {
  constructor(private readonly db: sqlite3.Database) {}

  saveSymptoms(userPhone: string, symptoms: unknown[], mood: string, urgency: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO symptoms (user_phone, symptoms, mood, urgency) VALUES (?, ?, ?, ?)`,
        [userPhone, JSON.stringify(symptoms), mood, urgency],
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }
}
