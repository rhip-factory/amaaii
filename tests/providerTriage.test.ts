// P6: HTTP-level tests for the provider triage queue / escalation feed /
// cohort analytics work package — apps/server/src/app.ts's new
// /provider/escalations, /provider/escalations/ack, /provider/cohort
// routes, the triage-field extension to GET /provider/patients, and the
// GET /provider/summary privacy fix (escalations7d must count only
// consented mothers). Follows tests/providerPortal.test.ts's pattern:
// tsx/cjs require, in-memory DB, createApp() per test, dummy
// +2547000000xx phones. Rows are seeded directly through the database.ts
// facade where that's faster than going through HTTP.
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
const providerAuth = require('../apps/server/src/providerAuth');
const { CONSENT_VERSION, MIN_COHORT_N } = require('@amaaii/core');

beforeAll(async () => {
  await db.initializeDatabase();
});

let phoneCounter = 90000;
function freshPhone(): string {
  phoneCounter += 1;
  return `07000${String(phoneCounter).padStart(5, '0')}`;
}

let facilityCounter = 0;
async function seedFacilityAndProvider(): Promise<{
  facility: { id: number; name: string; code: string };
  provider: { id: number; facility_id: number; email: string; name: string; role: string };
  password: string;
}> {
  facilityCounter += 1;
  const facility = await db.createFacility({
    name: `Triage Test Hospital ${facilityCounter}`,
    code: `TTH-${facilityCounter}`,
    county: 'Nairobi',
  });
  const password = 'correct horse battery staple';
  const provider = await db.createProvider({
    facilityId: facility.id,
    email: `provider${facilityCounter}@triage-test.example`,
    name: 'Nurse Test',
    role: 'nurse',
    passwordHash: providerAuth.hashPassword(password),
  });
  return { facility, provider, password };
}

async function providerToken(app: import('express').Express, email: string, password: string): Promise<string> {
  const res = await request(app).post('/provider/auth/login').send({ email, password });
  return res.body.token as string;
}

async function motherPhoneAndToken(
  app: import('express').Express,
  rawPhone: string
): Promise<{ phone: string; token: string }> {
  const res = await request(app).post('/auth/login').send({ phone: rawPhone });
  return { phone: res.body.user.phone as string, token: res.body.token as string };
}

/** Enrolls `rawPhone` at `facilityId`, grants provider_access consent
 *  (so she's fully "in the panel"), and records a single CRITICAL
 *  danger_escalation audit row for her — the same shape
 *  auditDangerEscalation() writes in production. Returns her phone. */
async function seedConsentedMotherWithEscalation(
  app: import('express').Express,
  facilityId: number,
  providerTok: string,
  rawPhone: string,
  urgencyLevel: 'critical' | 'high' = 'critical'
): Promise<string> {
  const { phone } = await motherPhoneAndToken(app, rawPhone);
  await request(app)
    .post('/provider/enroll')
    .set('Authorization', `Bearer ${providerTok}`)
    .send({ phone: rawPhone, name: 'Test Mother' });
  await db.recordConsent(phone, 'provider_access', true, CONSENT_VERSION);
  await db.recordAudit({
    actor: 'system',
    action: 'danger_escalation',
    resource: 'conversation',
    resourceOwner: phone,
    metadata: { urgencyLevel },
  });
  return phone;
}

// --- PRIVACY FIX: GET /provider/summary escalations7d -----------------------

describe('GET /provider/summary — escalations7d PRIVACY FIX (P6)', () => {
  it('counts escalations ONLY for mothers with active provider_access consent, not every active enrollment', async () => {
    const app = createApp();
    const { provider, password, facility } = await seedFacilityAndProvider();
    const providerTok = await providerToken(app, provider.email, password);

    // Consented mother WITH an escalation — should count.
    await seedConsentedMotherWithEscalation(app, facility.id, providerTok, freshPhone());

    // Enrolled but NOT consented mother, also with an escalation — must
    // NOT count. Before the P6 fix this row alone would have moved
    // escalations7d even though nothing about her is otherwise visible.
    const { phone: notConsentedPhone } = await motherPhoneAndToken(app, freshPhone());
    await request(app)
      .post('/provider/enroll')
      .set('Authorization', `Bearer ${providerTok}`)
      .send({ phone: notConsentedPhone });
    await db.recordAudit({
      actor: 'system',
      action: 'danger_escalation',
      resource: 'conversation',
      resourceOwner: notConsentedPhone,
      metadata: { urgencyLevel: 'critical' },
    });

    const res = await request(app).get('/provider/summary').set('Authorization', `Bearer ${providerTok}`);
    expect(res.status).toBe(200);
    // Exactly 1 — the consented mother's escalation — never 2.
    expect(res.body.escalations7d).toBe(1);
  });

  it('a facility with zero consented mothers reports escalations7d: 0, even with active enrollments and escalations', async () => {
    const app = createApp();
    const { provider, password, facility } = await seedFacilityAndProvider();
    const providerTok = await providerToken(app, provider.email, password);

    const { phone } = await motherPhoneAndToken(app, freshPhone());
    await request(app).post('/provider/enroll').set('Authorization', `Bearer ${providerTok}`).send({ phone });
    await db.recordAudit({
      actor: 'system',
      action: 'danger_escalation',
      resource: 'conversation',
      resourceOwner: phone,
      metadata: { urgencyLevel: 'critical' },
    });

    const res = await request(app).get('/provider/summary').set('Authorization', `Bearer ${providerTok}`);
    expect(res.status).toBe(200);
    expect(res.body.escalations7d).toBe(0);
  });
});

// --- GET /provider/patients — triage fields ----------------------------------

describe('GET /provider/patients — triage extension (P6)', () => {
  it('a consented row carries triage.band/score/reasons plus ancVisits, redFlags7d, lastCheckInAt', async () => {
    const app = createApp();
    const { provider, password, facility } = await seedFacilityAndProvider();
    const providerTok = await providerToken(app, provider.email, password);
    const phone = await seedConsentedMotherWithEscalation(app, facility.id, providerTok, freshPhone());

    // A red-flagged journal entry this week -> redFlags7d > 0 -> urgent band.
    await db.createOrUpdateJournal(
      phone,
      {
        emotional_state: 4,
        physical_symptoms: JSON.stringify(['bleeding']),
        sleep_hours: 5,
        appetite: 'poor',
        completed: 1,
        completed_at: new Date().toISOString(),
        red_flags_detected: JSON.stringify(['bleeding']),
      },
      null
    );

    const res = await request(app).get('/provider/patients').set('Authorization', `Bearer ${providerTok}`);
    expect(res.status).toBe(200);
    const row = res.body.patients.find((p: { phone: string }) => p.phone === phone);
    expect(row).toBeTruthy();
    expect(row.consentGranted).toBe(true);
    expect(typeof row.redFlags7d).toBe('number');
    expect(row.redFlags7d).toBeGreaterThan(0);
    expect(row).toHaveProperty('ancVisits');
    expect(row).toHaveProperty('lastCheckInAt');
    expect(row.triage).toBeTruthy();
    expect(row.triage.band).toBe('urgent');
    expect(typeof row.triage.score).toBe('number');
    expect(Array.isArray(row.triage.reasons)).toBe(true);
    expect(row.triage.reasons.length).toBeGreaterThan(0);
  });

  it('a non-consenting row carries no triage field at all — consent gates it same as every other clinical field', async () => {
    const app = createApp();
    const { provider, password } = await seedFacilityAndProvider();
    const providerTok = await providerToken(app, provider.email, password);
    const rawPhone = freshPhone();
    const { phone } = await motherPhoneAndToken(app, rawPhone);
    await request(app).post('/provider/enroll').set('Authorization', `Bearer ${providerTok}`).send({ phone: rawPhone });

    const res = await request(app).get('/provider/patients').set('Authorization', `Bearer ${providerTok}`);
    const row = res.body.patients.find((p: { phone: string }) => p.phone === phone);
    expect(row.consentGranted).toBe(false);
    expect(row.triage).toBeUndefined();
    expect(row.ancVisits).toBeUndefined();
  });
});

// --- GET /provider/escalations -----------------------------------------------

describe('GET /provider/escalations', () => {
  it('includes only enrolled AND consented mothers, newest first, with the documented item shape', async () => {
    const app = createApp();
    const { provider, password, facility } = await seedFacilityAndProvider();
    const providerTok = await providerToken(app, provider.email, password);

    const consentedPhone = await seedConsentedMotherWithEscalation(app, facility.id, providerTok, freshPhone(), 'high');

    // Enrolled but not consented — must contribute NOTHING to the feed.
    const { phone: notConsentedPhone } = await motherPhoneAndToken(app, freshPhone());
    await request(app)
      .post('/provider/enroll')
      .set('Authorization', `Bearer ${providerTok}`)
      .send({ phone: notConsentedPhone });
    await db.recordAudit({
      actor: 'system',
      action: 'danger_escalation',
      resource: 'conversation',
      resourceOwner: notConsentedPhone,
      metadata: { urgencyLevel: 'critical' },
    });

    const res = await request(app).get('/provider/escalations').set('Authorization', `Bearer ${providerTok}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.escalations)).toBe(true);
    expect(res.body.escalations.some((e: { phone: string }) => e.phone === notConsentedPhone)).toBe(false);

    const item = res.body.escalations.find((e: { phone: string }) => e.phone === consentedPhone);
    expect(item).toBeTruthy();
    expect(item.urgency).toBe('high');
    expect(typeof item.createdAt).toBe('string');
    expect(item.acknowledged).toBe(false);
    expect(item.acknowledgedBy).toBeUndefined();
    expect(item.acknowledgedAt).toBeUndefined();
  });

  it('sorts newest first', async () => {
    const app = createApp();
    const { provider, password, facility } = await seedFacilityAndProvider();
    const providerTok = await providerToken(app, provider.email, password);
    const { phone } = await motherPhoneAndToken(app, freshPhone());
    await request(app)
      .post('/provider/enroll')
      .set('Authorization', `Bearer ${providerTok}`)
      .send({ phone });
    await db.recordConsent(phone, 'provider_access', true, CONSENT_VERSION);

    await db.recordAudit({
      actor: 'system',
      action: 'danger_escalation',
      resource: 'conversation',
      resourceOwner: phone,
      metadata: { urgencyLevel: 'critical' },
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    await db.recordAudit({
      actor: 'system',
      action: 'danger_escalation',
      resource: 'conversation',
      resourceOwner: phone,
      metadata: { urgencyLevel: 'high' },
      timestamp: '2026-01-05T00:00:00.000Z',
    });

    const res = await request(app).get('/provider/escalations').set('Authorization', `Bearer ${providerTok}`);
    const timestamps = res.body.escalations
      .filter((e: { phone: string }) => e.phone === phone)
      .map((e: { createdAt: string }) => e.createdAt);
    expect(timestamps).toEqual(['2026-01-05T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
  });

  it('a denied (not-consented) mother is still audited, visible in her own activity log — no data shown, but a record that a provider tried', async () => {
    const app = createApp();
    const { provider, password, facility } = await seedFacilityAndProvider();
    const providerTok = await providerToken(app, provider.email, password);
    const rawPhone = freshPhone();
    const { phone, token: motherTok } = await motherPhoneAndToken(app, rawPhone);
    await request(app)
      .post('/provider/enroll')
      .set('Authorization', `Bearer ${providerTok}`)
      .send({ phone: rawPhone });

    await request(app).get('/provider/escalations').set('Authorization', `Bearer ${providerTok}`);

    const activity = await request(app).get('/me/activity').set('Authorization', `Bearer ${motherTok}`);
    const denied = activity.body.events.find(
      (e: { actor: string; action: string }) => e.actor === `provider:${provider.id}` && e.action === 'read'
    );
    expect(denied).toBeTruthy();
    void facility;
  });
});

// --- POST /provider/escalations/ack ------------------------------------------

describe('POST /provider/escalations/ack', () => {
  it('acknowledges an escalation, which then shows acknowledged:true with acknowledgedBy/acknowledgedAt in the feed', async () => {
    const app = createApp();
    const { provider, password, facility } = await seedFacilityAndProvider();
    const providerTok = await providerToken(app, provider.email, password);
    const phone = await seedConsentedMotherWithEscalation(app, facility.id, providerTok, freshPhone());

    const feedBefore = await request(app).get('/provider/escalations').set('Authorization', `Bearer ${providerTok}`);
    const item = feedBefore.body.escalations.find((e: { phone: string }) => e.phone === phone);
    expect(item.acknowledged).toBe(false);

    const ackRes = await request(app)
      .post('/provider/escalations/ack')
      .set('Authorization', `Bearer ${providerTok}`)
      .send({ phone, escalationAt: item.createdAt });
    expect(ackRes.status).toBe(200);
    expect(ackRes.body.acknowledged).toBe(true);
    expect(ackRes.body.acknowledgedBy).toBe(provider.id);
    expect(typeof ackRes.body.acknowledgedAt).toBe('string');

    const feedAfter = await request(app).get('/provider/escalations').set('Authorization', `Bearer ${providerTok}`);
    const itemAfter = feedAfter.body.escalations.find((e: { phone: string }) => e.phone === phone);
    expect(itemAfter.acknowledged).toBe(true);
    expect(itemAfter.acknowledgedBy).toBe(provider.id);
    expect(typeof itemAfter.acknowledgedAt).toBe('string');
  });

  it('is idempotent — acknowledging the same escalation twice never errors and stays acknowledged', async () => {
    const app = createApp();
    const { provider, password, facility } = await seedFacilityAndProvider();
    const providerTok = await providerToken(app, provider.email, password);
    const phone = await seedConsentedMotherWithEscalation(app, facility.id, providerTok, freshPhone());

    const feed = await request(app).get('/provider/escalations').set('Authorization', `Bearer ${providerTok}`);
    const escalationAt = feed.body.escalations[0].createdAt;

    const first = await request(app)
      .post('/provider/escalations/ack')
      .set('Authorization', `Bearer ${providerTok}`)
      .send({ phone, escalationAt });
    const second = await request(app)
      .post('/provider/escalations/ack')
      .set('Authorization', `Bearer ${providerTok}`)
      .send({ phone, escalationAt });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.acknowledged).toBe(true);
  });

  it('404s not_enrolled when the phone was never enrolled at this facility', async () => {
    const app = createApp();
    const { provider, password } = await seedFacilityAndProvider();
    const providerTok = await providerToken(app, provider.email, password);
    const { phone } = await motherPhoneAndToken(app, freshPhone());

    const res = await request(app)
      .post('/provider/escalations/ack')
      .set('Authorization', `Bearer ${providerTok}`)
      .send({ phone, escalationAt: new Date().toISOString() });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_enrolled');
  });

  it('403s no_provider_consent when enrolled but not consented — same rule as patient detail', async () => {
    const app = createApp();
    const { provider, password } = await seedFacilityAndProvider();
    const providerTok = await providerToken(app, provider.email, password);
    const rawPhone = freshPhone();
    const { phone } = await motherPhoneAndToken(app, rawPhone);
    await request(app).post('/provider/enroll').set('Authorization', `Bearer ${providerTok}`).send({ phone: rawPhone });

    const res = await request(app)
      .post('/provider/escalations/ack')
      .set('Authorization', `Bearer ${providerTok}`)
      .send({ phone, escalationAt: new Date().toISOString() });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('no_provider_consent');
  });

  it('400s on a missing escalationAt', async () => {
    const app = createApp();
    const { provider, password, facility } = await seedFacilityAndProvider();
    const providerTok = await providerToken(app, provider.email, password);
    const phone = await seedConsentedMotherWithEscalation(app, facility.id, providerTok, freshPhone());

    const res = await request(app)
      .post('/provider/escalations/ack')
      .set('Authorization', `Bearer ${providerTok}`)
      .send({ phone });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_escalationAt');
  });

  it('a facility never acknowledges another facility\'s mother (enrollment boundary applies here too)', async () => {
    const app = createApp();
    const a = await seedFacilityAndProvider();
    const b = await seedFacilityAndProvider();
    const tokenA = await providerToken(app, a.provider.email, a.password);
    const tokenB = await providerToken(app, b.provider.email, b.password);
    const phone = await seedConsentedMotherWithEscalation(app, a.facility.id, tokenA, freshPhone());

    const res = await request(app)
      .post('/provider/escalations/ack')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ phone, escalationAt: new Date().toISOString() });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_enrolled');
  });
});

// --- GET /provider/cohort -----------------------------------------------------

describe('GET /provider/cohort', () => {
  it('suppresses below MIN_COHORT_N — no statistics, just the documented notice', async () => {
    const app = createApp();
    const { provider, password, facility } = await seedFacilityAndProvider();
    const providerTok = await providerToken(app, provider.email, password);

    for (let i = 0; i < MIN_COHORT_N - 1; i += 1) {
      await seedConsentedMotherWithEscalation(app, facility.id, providerTok, freshPhone());
    }

    const res = await request(app).get('/provider/cohort').set('Authorization', `Bearer ${providerTok}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ suppressed: true, minimumN: MIN_COHORT_N, cohortSize: MIN_COHORT_N - 1 });
  });

  it('reports aggregate statistics at MIN_COHORT_N consented mothers, with no per-mother data anywhere in the response', async () => {
    const app = createApp();
    const { provider, password, facility } = await seedFacilityAndProvider();
    const providerTok = await providerToken(app, provider.email, password);

    const phones: string[] = [];
    for (let i = 0; i < MIN_COHORT_N; i += 1) {
      const rawPhone = freshPhone();
      const { phone } = await motherPhoneAndToken(app, rawPhone);
      await request(app).post('/provider/enroll').set('Authorization', `Bearer ${providerTok}`).send({ phone: rawPhone, name: `Mother ${i}` });
      await db.recordConsent(phone, 'provider_access', true, CONSENT_VERSION);
      await db.updateUser(phone, { pregnancy_week: 20 + i });
      phones.push(phone);
    }

    const res = await request(app).get('/provider/cohort').set('Authorization', `Bearer ${providerTok}`);
    expect(res.status).toBe(200);
    expect(res.body.suppressed).toBe(false);
    expect(res.body.cohortSize).toBe(MIN_COHORT_N);
    expect(typeof res.body.ancAdherencePct).toBe('number');
    expect(typeof res.body.checkInRatePct).toBe('number');
    expect(typeof res.body.redFlagMothers).toBe('number');
    expect(res.body.gestationalBuckets).toBeTruthy();

    // No phone, name, or per-mother array anywhere in the JSON body.
    const raw = JSON.stringify(res.body);
    for (const phone of phones) {
      expect(raw.includes(phone)).toBe(false);
    }
    expect(raw.includes('Mother ')).toBe(false);
    for (const value of Object.values(res.body)) {
      expect(Array.isArray(value)).toBe(false);
    }
  });

  it('a non-consenting enrolled mother does not count toward cohortSize at all — not even as a suppressed-but-present unit', async () => {
    const app = createApp();
    const { provider, password, facility } = await seedFacilityAndProvider();
    const providerTok = await providerToken(app, provider.email, password);

    // 2 consented (below MIN_COHORT_N on their own).
    await seedConsentedMotherWithEscalation(app, facility.id, providerTok, freshPhone());
    await seedConsentedMotherWithEscalation(app, facility.id, providerTok, freshPhone());
    // 5 more enrolled but NOT consented — if these wrongly counted toward
    // cohortSize, the panel would cross MIN_COHORT_N and stop suppressing.
    for (let i = 0; i < 5; i += 1) {
      const { phone } = await motherPhoneAndToken(app, freshPhone());
      await request(app).post('/provider/enroll').set('Authorization', `Bearer ${providerTok}`).send({ phone });
    }

    const res = await request(app).get('/provider/cohort').set('Authorization', `Bearer ${providerTok}`);
    expect(res.body).toEqual({ suppressed: true, minimumN: MIN_COHORT_N, cohortSize: 2 });
  });
});
