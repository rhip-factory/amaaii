// SQLite implementation of AuditRepository (P3-A). Append-only — the
// only write path is `record()`, and it's always an INSERT.

import type sqlite3 from 'sqlite3';
import type { AuditEvent, AuditEventInput, AuditRepository } from '@amaaii/core';

const DEFAULT_LIST_LIMIT = 50;

export class SqliteAuditRepository implements AuditRepository {
  constructor(private readonly db: sqlite3.Database) {}

  record(event: AuditEventInput): Promise<void> {
    return new Promise((resolve, reject) => {
      const metadata = event.metadata != null ? JSON.stringify(event.metadata) : null;
      if (event.timestamp) {
        this.db.run(
          `INSERT INTO audit_log (actor, action, resource, resource_owner, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [event.actor, event.action, event.resource, event.resourceOwner, metadata, event.timestamp],
          (err) => (err ? reject(err) : resolve())
        );
      } else {
        this.db.run(
          `INSERT INTO audit_log (actor, action, resource, resource_owner, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))`,
          [event.actor, event.action, event.resource, event.resourceOwner, metadata],
          (err) => (err ? reject(err) : resolve())
        );
      }
    });
  }

  listForUser(phone: string, limit = DEFAULT_LIST_LIMIT): Promise<AuditEvent[]> {
    return new Promise((resolve, reject) => {
      this.db.all<AuditEvent>(
        `SELECT * FROM audit_log
         WHERE resource_owner = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [phone, limit],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }
}
