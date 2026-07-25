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
 */
export async function auditDangerEscalation(
  phone: string,
  urgencyLevel: Urgency | string | undefined
): Promise<void> {
  if (urgencyLevel !== 'critical' && urgencyLevel !== 'high') return;
  await recordAuditSafe({
    actor: 'system',
    action: 'danger_escalation',
    resource: 'conversation',
    resourceOwner: phone,
    metadata: { urgencyLevel },
  });
}
