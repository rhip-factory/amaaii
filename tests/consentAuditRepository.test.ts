// SQLite-backed integration tests for the P3-A consent + audit
// foundation: packages/adapters/src/sqlite/consentRepository.ts +
// auditRepository.ts, wired through the apps/server/src/database.ts
// facade (the same seam P3-B will call). Follows tests/database.test.js's
// pattern: tsx/cjs require, in-memory DB, dummy +2547000000xx phones.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs');

process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';

const db = require('../apps/server/src/database');
const { CONSENT_VERSION, deriveConsentState, hasActiveConsent, needsConsent, canUseAi } = require('@amaaii/core');

beforeAll(async () => {
  await db.initializeDatabase();
});

let counter = 9000;
function nextPhone(): string {
  counter += 1;
  return `whatsapp:+254700009${counter}`;
}

describe('ConsentRepository (via database.ts facade) — append-only ledger', () => {
  it('a brand-new user has no consent rows', async () => {
    const phone = nextPhone();
    const rows = await db.getConsents(phone);
    expect(rows).toEqual([]);
  });

  it('recordConsent inserts a grant row that reads back as active', async () => {
    const phone = nextPhone();
    const record = await db.recordConsent(phone, 'data_processing', true, CONSENT_VERSION);
    expect(record.granted).toBe(true);
    expect(record.version).toBe(CONSENT_VERSION);
    expect(record.revoked_at).toBeNull();

    const rows = await db.getConsents(phone);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_phone).toBe(phone);
    expect(rows[0].purpose).toBe('data_processing');
    expect(Boolean(rows[0].granted)).toBe(true);
    expect(rows[0].revoked_at).toBeNull();

    const state = deriveConsentState(rows);
    expect(hasActiveConsent(state, 'data_processing')).toBe(true);
    expect(needsConsent(state)).toBe(false);
  });

  it('recordConsent with granted=false (outright decline) leaves revoked_at NULL', async () => {
    const phone = nextPhone();
    const record = await db.recordConsent(phone, 'ai_responses', false, CONSENT_VERSION);
    expect(record.granted).toBe(false);
    expect(record.revoked_at).toBeNull();

    const rows = await db.getConsents(phone);
    expect(Boolean(rows[0].granted)).toBe(false);
    expect(rows[0].revoked_at).toBeNull();

    const state = deriveConsentState(rows);
    expect(canUseAi(state)).toBe(false);
  });

  it('revokeConsent appends a withdrawal row instead of mutating the grant row (append-only)', async () => {
    const phone = nextPhone();
    await db.recordConsent(phone, 'ai_responses', true, CONSENT_VERSION);
    await db.revokeConsent(phone, 'ai_responses');

    const rows = await db.getConsents(phone);
    // Both the original grant AND the withdrawal exist — nothing was
    // UPDATEd or deleted.
    expect(rows).toHaveLength(2);
    expect(Boolean(rows[0].granted)).toBe(true);
    expect(rows[0].revoked_at).toBeNull();
    expect(Boolean(rows[1].granted)).toBe(false);
    expect(rows[1].revoked_at).not.toBeNull();

    const state = deriveConsentState(rows);
    expect(canUseAi(state)).toBe(false);
    expect(hasActiveConsent(state, 'ai_responses')).toBe(false);
  });

  it('rows come back oldest-first, so the latest event is always last (deriveConsentState relies on this)', async () => {
    const phone = nextPhone();
    await db.recordConsent(phone, 'data_processing', true, CONSENT_VERSION);
    await db.recordConsent(phone, 'data_processing', false, CONSENT_VERSION);
    await db.recordConsent(phone, 'data_processing', true, CONSENT_VERSION);

    const rows = await db.getConsents(phone);
    expect(rows.map((r: any) => Boolean(r.granted))).toEqual([true, false, true]);
    const state = deriveConsentState(rows);
    expect(hasActiveConsent(state, 'data_processing')).toBe(true); // last row wins
  });

  it('consent history for one user never leaks into another user\'s ledger', async () => {
    const phoneA = nextPhone();
    const phoneB = nextPhone();
    await db.recordConsent(phoneA, 'data_processing', true, CONSENT_VERSION);
    const rowsB = await db.getConsents(phoneB);
    expect(rowsB).toEqual([]);
  });

  it('revokeConsent on a purpose never touched still produces a well-formed row (no crash)', async () => {
    const phone = nextPhone();
    await db.revokeConsent(phone, 'data_processing');
    const rows = await db.getConsents(phone);
    expect(rows).toHaveLength(1);
    expect(Boolean(rows[0].granted)).toBe(false);
    expect(rows[0].revoked_at).not.toBeNull();
  });
});

describe('AuditRepository (via database.ts facade) — append-only log', () => {
  it('a brand-new user has no audit events', async () => {
    const phone = nextPhone();
    const events = await db.listAuditForUser(phone);
    expect(events).toEqual([]);
  });

  it('record() writes a row that listForUser() reads back with JSON-stringified metadata', async () => {
    const phone = nextPhone();
    await db.recordAudit({
      actor: phone,
      action: 'read',
      resource: 'profile',
      resourceOwner: phone,
      metadata: { field: 'name' },
    });

    const events = await db.listAuditForUser(phone);
    expect(events).toHaveLength(1);
    expect(events[0].actor).toBe(phone);
    expect(events[0].action).toBe('read');
    expect(events[0].resource).toBe('profile');
    expect(events[0].resource_owner).toBe(phone);
    expect(JSON.parse(events[0].metadata)).toEqual({ field: 'name' });
  });

  it('metadata is null when omitted (not the string "null")', async () => {
    const phone = nextPhone();
    await db.recordAudit({ actor: phone, action: 'login', resource: 'account', resourceOwner: phone });
    const events = await db.listAuditForUser(phone);
    expect(events[0].metadata).toBeNull();
  });

  it('listForUser returns newest first', async () => {
    const phone = nextPhone();
    await db.recordAudit({
      actor: phone,
      action: 'consent_grant',
      resource: 'consent',
      resourceOwner: phone,
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    await db.recordAudit({
      actor: phone,
      action: 'consent_revoke',
      resource: 'consent',
      resourceOwner: phone,
      timestamp: '2026-01-02T00:00:00.000Z',
    });
    const events = await db.listAuditForUser(phone);
    expect(events.map((e: any) => e.action)).toEqual(['consent_revoke', 'consent_grant']);
  });

  it('respects an explicit limit', async () => {
    const phone = nextPhone();
    for (let i = 0; i < 5; i += 1) {
      await db.recordAudit({
        actor: phone,
        action: 'read',
        resource: 'journal',
        resourceOwner: phone,
        timestamp: `2026-01-0${i + 1}T00:00:00.000Z`,
      });
    }
    const events = await db.listAuditForUser(phone, 2);
    expect(events).toHaveLength(2);
  });

  it('actor and resource_owner can differ (system-driven event on a user\'s data)', async () => {
    const phone = nextPhone();
    await db.recordAudit({
      actor: 'system',
      action: 'danger_escalation',
      resource: 'conversation',
      resourceOwner: phone,
    });
    const events = await db.listAuditForUser(phone);
    expect(events[0].actor).toBe('system');
    expect(events[0].resource_owner).toBe(phone);
  });

  it('audit history for one user never leaks into another user\'s log', async () => {
    const phoneA = nextPhone();
    const phoneB = nextPhone();
    await db.recordAudit({ actor: phoneA, action: 'read', resource: 'profile', resourceOwner: phoneA });
    const eventsB = await db.listAuditForUser(phoneB);
    expect(eventsB).toEqual([]);
  });
});
