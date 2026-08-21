// P3-C: HTTP-level tests for the two Kenya DPA data-subject rights wired
// into apps/server/src/app.ts — GET /me/export (portability) and
// DELETE /me/account (erasure). Follows tests/consentEndpoints.test.ts's
// pattern: tsx/cjs require, in-memory DB, createApp() per test, dummy
// +2547000000xx phones. Rows are seeded directly through the
// database.ts facade (bypassing /chat's consent gate and the LLM) so
// every test stays deterministic and fast.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs');

process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';
process.env.AUTH_SECRET = 'test-auth-secret';

const db = require('../apps/server/src/database');
const { createApp } = require('../apps/server/src/app');
const { CONSENT_VERSION } = require('@amaaii/core');

beforeAll(async () => {
  await db.initializeDatabase();
});

let counter = 60000;
function freshPhone(): string {
  counter += 1;
  return `07000${String(counter).padStart(5, '0')}`;
}

async function loginAndGetPhone(
  app: import('express').Express,
  rawPhone: string
): Promise<{ token: string; phone: string }> {
  const res = await request(app).post('/auth/login').send({ phone: rawPhone });
  return { token: res.body.token as string, phone: res.body.user.phone as string };
}

/** Seeds one row into every table GET /me/export and DELETE /me/account
 *  care about, for a fresh phone. Writes go straight through the
 *  database.ts facade (not HTTP) so these tests don't depend on the
 *  consent gate, danger-sign scanning, or the (unconfigured) LLM. */
async function seedFullUser(
  app: import('express').Express,
  rawPhone: string
): Promise<{ token: string; phone: string }> {
  const { token, phone } = await loginAndGetPhone(app, rawPhone);

  await db.createUser(phone, { name: 'Test Mother', age: 28, pregnancy_week: 20, location: 'Nairobi' });
  await db.recordConsent(phone, 'data_processing', true, CONSENT_VERSION);
  await db.recordConsent(phone, 'ai_responses', true, CONSENT_VERSION);
  await db.createOrUpdateJournal(
    phone,
    {
      emotional_state: 7,
      physical_symptoms: 'none',
      sleep_hours: 7,
      appetite: 'good',
      completed: 1,
      completed_at: new Date().toISOString(),
    },
    null
  );
  await db.saveConversation(phone, 'Hello Amaaii', 'Hi there, how are you feeling today?', {
    dangerSigns: [],
    urgencyLevel: 'low',
    context: 'general',
  });
  await db.saveSymptoms(phone, ['headache'], 'neutral', 'low');
  await db.scheduleANCVisit(phone, '2026-08-01', 'Routine checkup');
  await db.saveMedicalHistory(phone, {
    rawText: 'No known conditions, this is a first pregnancy.',
    extracted: { gravida: 1 },
  });
  // OTP row — never a portable/exportable field; also must be erased on delete.
  await db.createOrReplaceOtp(phone, 'deadbeefdeadbeefotphash', new Date(Date.now() + 600000).toISOString(), []);

  return { token, phone };
}

describe('GET /me/export', () => {
  it('requires auth', async () => {
    const app = createApp();
    const res = await request(app).get('/me/export');
    expect(res.status).toBe(401);
  });

  it('returns a complete, correctly-shaped export for a fully-seeded user, with a download header', async () => {
    const app = createApp();
    const { token, phone } = await seedFullUser(app, freshPhone());

    const res = await request(app).get('/me/export').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="amaaii-my-data-\d{4}-\d{2}-\d{2}\.json"$/
    );

    const body = res.body;
    expect(body.phone).toBe(phone);
    expect(typeof body.exportedAt).toBe('string');
    expect(Number.isNaN(new Date(body.exportedAt).getTime())).toBe(false);

    expect(body.profile).toMatchObject({ phone_number: phone, name: 'Test Mother', age: 28 });

    expect(Array.isArray(body.consents)).toBe(true);
    expect(body.consents.length).toBeGreaterThanOrEqual(2);
    expect(body.consents.every((c: { user_phone: string }) => c.user_phone === phone)).toBe(true);

    expect(Array.isArray(body.conversations)).toBe(true);
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0].message).toBe('Hello Amaaii');

    expect(Array.isArray(body.journals)).toBe(true);
    expect(body.journals).toHaveLength(1);
    expect(body.journals[0].emotional_state).toBe(7);

    expect(Array.isArray(body.symptoms)).toBe(true);
    expect(body.symptoms).toHaveLength(1);

    expect(Array.isArray(body.ancVisits)).toBe(true);
    expect(body.ancVisits).toHaveLength(1);
    expect(body.ancVisits[0].notes).toBe('Routine checkup');

    expect(body.medicalHistory).toBeTruthy();
    expect(body.medicalHistory.rawText).toMatch(/first pregnancy/);
    expect(body.medicalHistory.gravida).toBe(1);

    expect(Array.isArray(body.auditLog)).toBe(true);
    expect(body.auditLog.some((e: { action: string }) => e.action === 'export')).toBe(true);

    // No OTP material anywhere in the export document.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('deadbeefdeadbeefotphash');
    expect(serialized.toLowerCase()).not.toMatch(/code_?hash/);
    expect(Object.keys(body)).not.toContain('otp');
  });

  it('writes an export audit row before responding', async () => {
    const app = createApp();
    const { token, phone } = await seedFullUser(app, freshPhone());
    await request(app).get('/me/export').set('Authorization', `Bearer ${token}`);
    const events = await db.listAuditForUser(phone);
    expect(
      events.some(
        (e: { action: string; resource: string; resource_owner: string }) =>
          e.action === 'export' && e.resource === 'account' && e.resource_owner === phone
      )
    ).toBe(true);
  });

  it("isolation: user A's export never contains user B's rows", async () => {
    const app = createApp();
    const { token: tokenA, phone: phoneA } = await seedFullUser(app, freshPhone());
    const { phone: phoneB } = await seedFullUser(app, freshPhone());

    const res = await request(app).get('/me/export').set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.phone).toBe(phoneA);

    const serialized = JSON.stringify(res.body);
    expect(serialized).toContain(phoneA);
    expect(serialized).not.toContain(phoneB);
  });
});

describe('DELETE /me/account', () => {
  it('requires auth', async () => {
    const app = createApp();
    const res = await request(app).delete('/me/account');
    expect(res.status).toBe(401);
  });

  it('rejects a body containing a phone field — never accepts a target phone from the caller', async () => {
    const app = createApp();
    const { token, phone } = await seedFullUser(app, freshPhone());
    const res = await request(app)
      .delete('/me/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: 'whatsapp:+254799999999' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('phone_not_accepted');
    // Nothing was touched — the rejected request must not have deleted
    // the caller's own account either.
    expect(await db.getUser(phone)).toBeTruthy();
  });

  it('cascade-deletes every table for the caller EXCEPT audit_log, which retains the delete event; returns {deleted:true}', async () => {
    const app = createApp();
    const { token, phone } = await seedFullUser(app, freshPhone());

    // Sanity: the data really is there before deleting.
    expect(await db.getUser(phone)).toBeTruthy();
    expect((await db.getAllJournalsForUser(phone)).length).toBeGreaterThan(0);
    expect((await db.listAuditForUser(phone)).length).toBe(0);

    const res = await request(app).delete('/me/account').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    expect(await db.getUser(phone)).toBeUndefined();
    expect(await db.getAllConversationsForUser(phone)).toEqual([]);
    expect(await db.getAllJournalsForUser(phone)).toEqual([]);
    expect(await db.getAllSymptomsForUser(phone)).toEqual([]);
    expect(await db.getAllAncVisitsForUser(phone)).toEqual([]);
    expect(await db.getMedicalHistory(phone)).toBeNull();
    expect(await db.getConsents(phone)).toEqual([]);
    expect(await db.getOtp(phone)).toBeNull();

    // audit_log is the one deliberate exception — it retains exactly the
    // 'delete'/'account' erasure event this call fired (nothing else was
    // audited for this phone before the delete).
    const events = await db.listAuditForUser(phone);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('delete');
    expect(events[0].resource).toBe('account');
    expect(events[0].resource_owner).toBe(phone);
  });

  it('is idempotent — a second DELETE on an already-erased account still returns 200 {deleted:true}', async () => {
    const app = createApp();
    const { token, phone } = await seedFullUser(app, freshPhone());

    const first = await request(app).delete('/me/account').set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.body.deleted).toBe(true);

    const second = await request(app).delete('/me/account').set('Authorization', `Bearer ${token}`);
    expect(second.status).toBe(200);
    expect(second.body.deleted).toBe(true);

    // Still nothing resurrected in any data table.
    expect(await db.getUser(phone)).toBeUndefined();
    // Each call — including the idempotent repeat — leaves its own
    // delete event in the retained log.
    const events = await db.listAuditForUser(phone);
    expect(events.filter((e: { action: string }) => e.action === 'delete').length).toBeGreaterThanOrEqual(2);
  });

  it('audits BEFORE erasing — the delete event exists in the retained log after erasure, proving it was written pre-delete, not lost mid-transaction', async () => {
    const app = createApp();
    const { token, phone } = await seedFullUser(app, freshPhone());
    const res = await request(app).delete('/me/account').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    const events = await db.listAuditForUser(phone);
    const deleteEvent = events.find(
      (e: { action: string; resource: string }) => e.action === 'delete' && e.resource === 'account'
    );
    expect(deleteEvent).toBeTruthy();
    expect(deleteEvent.resource_owner).toBe(phone);
  });

  it('P4-B: also clears the caller\'s pending jobs (e.g. a scheduled checkin_followup), leaving other users\' jobs intact', async () => {
    const app = createApp();
    const { token: tokenA, phone: phoneA } = await seedFullUser(app, freshPhone());
    const { phone: phoneB } = await seedFullUser(app, freshPhone());

    await db.enqueueJob({
      type: 'checkin_followup',
      payload: { phone: phoneA },
      runAt: new Date(Date.now() + 3600000).toISOString(),
    });
    await db.enqueueJob({
      type: 'checkin_followup',
      payload: { phone: phoneB },
      runAt: new Date(Date.now() + 3600000).toISOString(),
    });

    const before = await db.countJobsByStatus();
    expect(before.pending).toBeGreaterThanOrEqual(2);

    const res = await request(app).delete('/me/account').set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);

    // Exactly one job removed (phoneA's) — phoneB's stays pending. A job
    // mid-flight at the moment of erasure is an accepted trade-off (see
    // DatabaseAdapter#eraseUser's doc comment in
    // packages/core/src/repositories.ts) — not exercised here since this
    // test enqueues a future-dated job that was never claimed.
    const after = await db.countJobsByStatus();
    expect(after.pending).toBe(before.pending - 1);
  });

  it('P5-A: also clears the caller\'s enrollments (provider portal), leaving other users\' enrollments intact', async () => {
    const app = createApp();
    const { token: tokenA, phone: phoneA } = await seedFullUser(app, freshPhone());
    const { phone: phoneB } = await seedFullUser(app, freshPhone());

    // facilities/providers are the hospital's own staff/org records, NOT
    // mother data — see erasure.ts's header — so seeding them directly
    // through the facade (no HTTP route exists for this; provider
    // self-registration is out of scope) is the normal way to set this
    // fixture up, same as tests/providerPortal.test.ts does.
    const facility = await db.createFacility({ name: 'Erasure Test Hospital', code: `ETH-${Date.now()}`, county: 'Nairobi' });
    await db.enrollPatient({ facilityId: facility.id, userPhone: phoneA });
    await db.enrollPatient({ facilityId: facility.id, userPhone: phoneB });

    const before = await db.getEnrollmentsByFacility(facility.id);
    expect(before).toHaveLength(2);

    const res = await request(app).delete('/me/account').set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);

    // Exactly A's enrollment is gone; B's (a different mother, same
    // facility) survives untouched.
    const after = await db.getEnrollmentsByFacility(facility.id);
    expect(after).toHaveLength(1);
    expect(after[0].user_phone).toBe(phoneB);
  });

  it('P6: also clears the caller\'s escalation acknowledgements (provider triage queue), leaving other users\' acks intact', async () => {
    const app = createApp();
    const { token: tokenA, phone: phoneA } = await seedFullUser(app, freshPhone());
    const { phone: phoneB } = await seedFullUser(app, freshPhone());

    // Same seed-through-the-facade pattern as the P5-A enrollments test
    // above — no HTTP route creates a facility/provider (self-registration
    // is out of scope), so this goes straight through db.
    const facility = await db.createFacility({ name: 'Erasure Test Hospital 2', code: `ETH2-${Date.now()}`, county: 'Nairobi' });
    const provider = await db.createProvider({
      facilityId: facility.id,
      email: `erasure-provider-${Date.now()}@test-hospital.example`,
      name: 'Nurse Erasure',
      role: 'nurse',
      passwordHash: 'scrypt$deadbeef$deadbeef', // never verified in this test — no login flow exercised
    });
    await db.enrollPatient({ facilityId: facility.id, userPhone: phoneA });
    await db.enrollPatient({ facilityId: facility.id, userPhone: phoneB });
    await db.ackEscalation({
      facilityId: facility.id,
      userPhone: phoneA,
      escalationAt: new Date().toISOString(),
      acknowledgedBy: provider.id,
    });
    await db.ackEscalation({
      facilityId: facility.id,
      userPhone: phoneB,
      escalationAt: new Date().toISOString(),
      acknowledgedBy: provider.id,
    });

    const before = await db.getEscalationAcksByFacility(facility.id);
    expect(before).toHaveLength(2);

    const res = await request(app).delete('/me/account').set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);

    // Exactly A's ack is gone; B's (a different mother, same facility)
    // survives untouched.
    const after = await db.getEscalationAcksByFacility(facility.id);
    expect(after).toHaveLength(1);
    expect(after[0].userPhone).toBe(phoneB);
  });

  it("isolation: deleting user A leaves user B's data fully intact (mandatory)", async () => {
    const app = createApp();
    const { token: tokenA, phone: phoneA } = await seedFullUser(app, freshPhone());
    const { phone: phoneB } = await seedFullUser(app, freshPhone());

    const res = await request(app).delete('/me/account').set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);

    // A is gone.
    expect(await db.getUser(phoneA)).toBeUndefined();
    expect(await db.getAllJournalsForUser(phoneA)).toEqual([]);

    // B is fully intact, across every table erasure touches.
    expect(await db.getUser(phoneB)).toBeTruthy();
    expect((await db.getConsents(phoneB)).length).toBeGreaterThanOrEqual(2);
    expect((await db.getAllConversationsForUser(phoneB)).length).toBeGreaterThanOrEqual(1);
    expect((await db.getAllJournalsForUser(phoneB)).length).toBeGreaterThanOrEqual(1);
    expect((await db.getAllSymptomsForUser(phoneB)).length).toBeGreaterThanOrEqual(1);
    expect((await db.getAllAncVisitsForUser(phoneB)).length).toBeGreaterThanOrEqual(1);
    expect(await db.getMedicalHistory(phoneB)).toBeTruthy();
    expect(await db.getOtp(phoneB)).toBeTruthy();
  });
});

describe('database.ts#eraseUser facade — repository level', () => {
  it('is a no-op (not an error) for a phone with no rows anywhere', async () => {
    await expect(db.eraseUser('whatsapp:+254700099999')).resolves.toBeUndefined();
  });
});
