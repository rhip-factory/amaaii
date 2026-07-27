// P3-B: audit logging helpers. The append-only audit_log table and its
// facade functions (recordAudit / listAuditForUser) landed in P3-A as
// pure data foundation — nothing called them yet. This file is the
// thin, defensive wiring every real call site (app.ts's routes,
// messageHandler.ts's danger-escalation branches) goes through instead
// of calling database.ts#recordAudit directly.
//
// "Never let an audit failure break the user request" (see the P3-B
// work order) is enforced HERE, once, rather than with a try/catch at
// every call site — recordAuditSafe swallows and logs any error instead
// of rejecting.

import * as db from './database';
import { log } from './logger';
import { incrementDangerEscalation } from './metrics';
import type { AuditEventInput, Urgency } from '@amaaii/core';

export async function recordAuditSafe(event: AuditEventInput): Promise<void> {
  try {
    await db.recordAudit(event);
  } catch (err) {
    log.error('recordAudit failed (non-fatal, request continues)', err, {
      action: event.action,
      resource: event.resource,
    });
  }
}

/**
 * Fires a single 'danger_escalation' audit row for CRITICAL/HIGH urgency
 * only — MODERATE/LOW are informational, not the vital-interests
 * escalation this event exists to record. actor is 'system' rather than
 * the user's own phone: this is the deterministic danger-sign engine
 * making an automated decision, not a user-initiated data access (see
 * AuditEvent's actor-vs-resource_owner distinction in
 * packages/core/src/repositories.ts).
 *
 * P4-B: also the single funnel danger_escalations_total is incremented
 * from — every CRITICAL/HIGH escalation path (WhatsApp's danger branch,
 * the web /chat consent-gate bypass, POST /journal/entries' re-scan)
 * already calls this function for the audit row, so reusing it here
 * avoids a second, separately-maintained instrumentation site that could
 * drift out of sync with the audit one.
 */
export async function auditDangerEscalation(
  phone: string,
  urgencyLevel: Urgency | string | undefined
): Promise<void> {
  if (urgencyLevel !== 'critical' && urgencyLevel !== 'high') return;
  incrementDangerEscalation(urgencyLevel);
  await recordAuditSafe({
    actor: 'system',
    action: 'danger_escalation',
    resource: 'conversation',
    resourceOwner: phone,
    metadata: { urgencyLevel },
  });
}

// --- Post-delete read hardening (P3-E) --------------------------------------
// A stateless bearer token issued before DELETE /me/account still verifies
// fine afterwards (there's no session table to invalidate) — see
// userManager.ts#getUserForRead and its call sites in app.ts for the read
// side of this fix. wasAccountDeleted() is the primitive both lean on to
// tell apart two states that otherwise look identical from "does a `users`
// row exist for this phone?" alone:
//   - never signed up: no row, and never had one — safe to auto-vivify
//     (the legacy /auth/login demo path relies on exactly this, via
//     getOrCreateUser — see its own comment).
//   - deleted: no row NOW, but a 'delete'/'account' audit_log row exists
//     for this phone — audit_log is the one table eraseUser() deliberately
//     leaves alone (see its doc comment in packages/core/src/repositories.ts),
//     specifically so events like this survive erasure and remain queryable.
// A generous limit — not listAuditForUser's normal 50-row page default —
// so an old delete event can't fall off the scan if this same stale token
// got used against other endpoints (which don't create rows either) many
// times afterwards. Cheap: a `WHERE resource_owner = ?` scan bounded by
// however many rows this one phone actually has, same pattern GET
// /me/export's own EXPORT_AUDIT_LIMIT already uses for a "give me
// everything" read.
const DELETE_EVENT_SCAN_LIMIT = 100_000;

export async function wasAccountDeleted(phone: string): Promise<boolean> {
  const events = await db.listAuditForUser(phone, DELETE_EVENT_SCAN_LIMIT);
  return events.some((e) => e.action === 'delete' && e.resource === 'account');
}
