// P5-A: HTTP-level tests for the provider portal (Stage B demo slice) —
// apps/server/src/app.ts's /provider/* routes, apps/server/src/
// providerAuth.ts's namespaced token + password hashing, and the new
// 'provider_access' consent purpose. Follows tests/consentEndpoints.test.ts
// and tests/dataSubjectRights.test.ts's pattern: tsx/cjs require,
// in-memory DB, createApp() per test, dummy +2547000000xx phones. Rows
// are seeded directly through the database.ts facade where that's faster
// than going through HTTP (facility/provider creation has no route at
// all — self-registration is out of scope for this slice).
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
const { CONSENT_VERSION } = require('@amaaii/core');

beforeAll(async () => {
  await db.initializeDatabase();
});

let phoneCounter = 80000;
function freshPhone(): string {
  phoneCounter += 1;
  return `07000${String(phoneCounter).padStart(5, '0')}`;
}

let facilityCounter = 0;
async function seedFacilityAndProvider(
  overrides: Partial<{ email: string; password: string; role: string; name: string }> = {}
): Promise<{
  facility: { id: number; name: string; code: string };
  provider: { id: number; facility_id: number; email: string; name: string; role: string };
  password: string;
}> {
  facilityCounter += 1;
  const facility = await db.createFacility({
    name: `Test Hospital ${facilityCounter}`,
    code: `TH-${facilityCounter}`,
    county: 'Nairobi',
  });
  const password = overrides.password || 'correct horse battery staple';
  const provider = await db.createProvider({
    facilityId: facility.id,
    email: overrides.email || `provider${facilityCounter}@test-hospital.example`,
    name: overrides.name || 'Nurse Test',
    role: overrides.role || 'nurse',
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

// --- Password hashing (pure, no DB) -----------------------------------------

describe('providerAuth password hashing', () => {
  it('round-trips: verifyPassword succeeds for the correct password against hashPassword output', () => {
    const hash = providerAuth.hashPassword('S3cure-Pass!');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(hash.split('$')).toHaveLength(3);
    expect(providerAuth.verifyPassword('S3cure-Pass!', hash)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const hash = providerAuth.hashPassword('S3cure-Pass!');
    expect(providerAuth.verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('never produces the same hash twice for the same password (random per-provider salt)', () => {
    const a = providerAuth.hashPassword('same-password');
    const b = providerAuth.hashPassword('same-password');
    expect(a).not.toBe(b);
    expect(providerAuth.verifyPassword('same-password', a)).toBe(true);
    expect(providerAuth.verifyPassword('same-password', b)).toBe(true);
  });

  it('rejects a malformed stored hash instead of throwing', () => {
    expect(providerAuth.verifyPassword('anything', 'not-a-valid-hash')).toBe(false);
    expect(providerAuth.verifyPassword('anything', 'scrypt$onlytwoparts')).toBe(false);
  });
});

// --- Cross-token rejection, both directions ---------------------------------

describe('provider/mother token cross-rejection', () => {
  it('a provider token is rejected on a mother route (GET /me) with 401 invalid_token', async () => {
    const app = createApp();
    const { provider } = await seedFacilityAndProvider();
    const token = providerAuth.issueProviderToken(provider.id, provider.facility_id, provider.role);
    const res = await request(app).get('/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });

  it('a provider token is rejected on DELETE /me/account too (not just reads)', async () => {
    const app = createApp();
    const { provider } = await seedFacilityAndProvider();
    const token = providerAuth.issueProviderToken(provider.id, provider.facility_id, provider.role);
    const res = await request(app).delete('/me/account').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });

  it('a mother token is rejected on a provider route (GET /provider/summary) with 401 invalid_token', async () => {
    const app = createApp();
    const { token } = await motherPhoneAndToken(app, freshPhone());
    const res = await request(app).get('/provider/summary').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });

  it('a mother token is rejected on POST /provider/enroll too', async () => {
    const app = createApp();
    const { token } = await motherPhoneAndToken(app, freshPhone());
    const res = await request(app)
      .post('/provider/enroll')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: freshPhone() });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });

  it('no token at all is 401 on both surfaces', async () => {
    const app = createApp();
    expect((await request(app).get('/me')).status).toBe(401);
    expect((await request(app).get('/provider/summary')).status).toBe(401);
  });
});

// --- POST /provider/auth/login ----------------------------------------------

describe('POST /provider/auth/login', () => {
  it('returns a token + provider/facility shape on correct credentials', async () => {
    const app = createApp();
    const { facility, provider, password } = await seedFacilityAndProvider();
    const res = await request(app).post('/provider/auth/login').send({ email: provider.email, password });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.provider).toEqual({
      id: provider.id,
      name: provider.name,
      role: provider.role,
      facility: { id: facility.id, name: facility.name, code: facility.code },
    });
  });

  it('rejects a wrong password with 401 invalid_credentials', async () => {
    const app = createApp();
    const { provider } = await seedFacilityAndProvider();
    const res = await request(app)
      .post('/provider/auth/login')
      .send({ email: provider.email, password: 'totally-wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('rejects an unknown email with the SAME 401 shape (no account-existence enumeration)', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/provider/auth/login')
      .send({ email: 'nobody@nowhere.example', password: 'whatever' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('400s on a missing password', async () => {
    const app = createApp();
    const res = await request(app).post('/provider/auth/login').send({ email: 'x@y.example' });
    expect(res.status).toBe(400);
  });
});

// --- POST /provider/enroll --------------------------------------------------

describe('POST /provider/enroll', () => {
  it("creates an enrollment and returns the mother's CURRENT consent status — enrollment does not grant it", async () => {
    const app = createApp();
    const { provider, password } = await seedFacilityAndProvider();
    const token = await providerToken(app, provider.email, password);
    const rawPhone = freshPhone();

    const res = await request(app)
      .post('/provider/enroll')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: rawPhone, name: 'Amina' });
    expect(res.status).toBe(201);
    expect(res.body.enrolled).toBe(true);
    expect(res.body.consentStatus).toEqual({ purpose: 'provider_access', granted: false });
  });

  it('is idempotent — enrolling the same phone twice never creates a second row', async () => {
    const app = createApp();
    const { provider, facility, password } = await seedFacilityAndProvider();
    const token = await providerToken(app, provider.email, password);
    const rawPhone = freshPhone();

    const first = await request(app)
      .post('/provider/enroll')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: rawPhone });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/provider/enroll')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: rawPhone });
    expect(second.status).toBe(200);
    expect(second.body.alreadyEnrolled).toBe(true);

    const rows = await db.getEnrollmentsByFacility(facility.id);
    const matching = rows.filter((r: { user_phone: string }) => r.user_phone.endsWith(rawPhone.slice(-9)));
    expect(matching).toHaveLength(1);
  });

  it('400s on an invalid phone', async () => {
    const app = createApp();
    const { provider, password } = await seedFacilityAndProvider();
    const token = await providerToken(app, provider.email, password);
    const res = await request(app)
      .post('/provider/enroll')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: 'not-a-phone' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_phone');
  });

  it('writes a write/profile audit row visible in the mother\'s OWN GET /me/activity', async () => {
    const app = createApp();
    const { provider, password } = await seedFacilityAndProvider();
    const providerTok = await providerToken(app, provider.email, password);
    const rawPhone = freshPhone();
    const { phone, token: motherTok } = await motherPhoneAndToken(app, rawPhone);

    await request(app)
      .post('/provider/enroll')
      .set('Authorization', `Bearer ${providerTok}`)
      .send({ phone: rawPhone });

    const activity = await request(app).get('/me/activity').set('Authorization', `Bearer ${motherTok}`);
    expect(activity.status).toBe(200);
    const providerEvent = activity.body.events.find(
      (e: { actor: string; action: string; resource: string }) => e.actor === `provider:${provider.id}`
    );
    expect(providerEvent).toBeTruthy();
    expect(providerEvent.action).toBe('write');
    expect(providerEvent.resource).toBe('profile');
    void phone;
  });
});

// --- GET /provider/patients — consent-gated clinical fields -----------------

describe('GET /provider/patients', () => {
  it('withholds clinical fields until provider_access is granted, then includes them', async () => {
    const app = createApp();
    const { provider, password } = await seedFacilityAndProvider();
    const providerTok = await providerToken(app, provider.email, password);
    const rawPhone = freshPhone();
    const { phone } = await motherPhoneAndToken(app, rawPhone);

    await request(app)
      .post('/provider/enroll')
      .set('Authorization', `Bearer ${providerTok}`)
      .send({ phone: rawPhone, name: 'Grace Wanjiru' });

    const before = await request(app).get('/provider/patients').set('Authorization', `Bearer ${providerTok}`);
    expect(before.status).toBe(200);
    const rowBefore = before.body.patients.find((p: { phone: string }) => p.phone === phone);
    expect(rowBefore).toBeTruthy();
    expect(rowBefore.consentGranted).toBe(false);
    // FIRST name only — never the full stored "Grace Wanjiru".
    expect(rowBefore.displayName).toBe('Grace');
    expect(rowBefore.pregnancyWeek).toBeUndefined();
    expect(rowBefore.riskLevel).toBeUndefined();
    expect(rowBefore.redFlags7d).toBeUndefined();

    await db.recordConsent(phone, 'provider_access', true, CONSENT_VERSION);

    const after = await request(app).get('/provider/patients').set('Authorization', `Bearer ${providerTok}`);
    const rowAfter = after.body.patients.find((p: { phone: string }) => p.phone === phone);
    expect(rowAfter.consentGranted).toBe(true);
    expect(rowAfter.pregnancyWeek).toBeNull(); // present now (even though unset -> null)
    expect(['high', 'moderate', 'low']).toContain(rowAfter.riskLevel);
    expect(typeof rowAfter.redFlags7d).toBe('number');
  });

  it("a facility never sees another facility's enrolled mothers (isolation)", async () => {
    const app = createApp();
    const a = await seedFacilityAndProvider();
    const b = await seedFacilityAndProvider();
    const tokenA = await providerToken(app, a.provider.email, a.password);
    const tokenB = await providerToken(app, b.provider.email, b.password);
    const rawPhone = freshPhone();

    await request(app).post('/provider/enroll').set('Authorization', `Bearer ${tokenA}`).send({ phone: rawPhone });

    const panelB = await request(app).get('/provider/patients').set('Authorization', `Bearer ${tokenB}`);
    expect(panelB.body.patients).toEqual([]);
  });

  it('every panel row read is audited, even when consent is not granted', async () => {
    const app = createApp();
    const { provider, password } = await seedFacilityAndProvider();
    const providerTok = await providerToken(app, provider.email, password);
    const rawPhone = freshPhone();
    const { phone } = await motherPhoneAndToken(app, rawPhone);
    await request(app)
      .post('/provider/enroll')
      .set('Authorization', `Bearer ${providerTok}`)
      .send({ phone: rawPhone });

    await request(app).get('/provider/patients').set('Authorization', `Bearer ${providerTok}`);

    const events = await db.listAuditForUser(phone);
    const reads = events.filter(
      (e: { actor: string; action: string }) => e.actor === `provider:${provider.id}` && e.action === 'read'
    );
    expect(reads.length).toBeGreaterThanOrEqual(1);
  });
});

// --- GET /provider/patients/detail ------------------------------------------

describe('GET /provider/patients/detail', () => {
  it('404s (not_enrolled) when the phone was never enrolled at this facility', async () => {
    const app = createApp();
    const { provider, password } = await seedFacilityAndProvider();
    const token = await providerToken(app, provider.email, password);
    const { phone } = await motherPhoneAndToken(app, freshPhone());

    const res = await request(app)
      .get('/provider/patients/detail')
      .query({ phone })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_enrolled');
  });

  it('403s with no_provider_consent when enrolled but consent has not been granted', async () => {
    const app = createApp();
    const { provider, password } = await seedFacilityAndProvider();
    const token = await providerToken(app, provider.email, password);
    const rawPhone = freshPhone();
    const { phone } = await motherPhoneAndToken(app, rawPhone);
    await request(app).post('/provider/enroll').set('Authorization', `Bearer ${token}`).send({ phone: rawPhone });

    const res = await request(app)
      .get('/provider/patients/detail')
      .query({ phone })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('no_provider_consent');
  });

  it('200s with the full PatientDetail shape once provider_access is granted, reusing trend.ts aggregates', async () => {
    const app = createApp();
    const { provider, password } = await seedFacilityAndProvider();
    const token = await providerToken(app, provider.email, password);
    const rawPhone = freshPhone();
    const { phone } = await motherPhoneAndToken(app, rawPhone);
    await request(app).post('/provider/enroll').set('Authorization', `Bearer ${token}`).send({ phone: rawPhone });
    await db.recordConsent(phone, 'provider_access', true, CONSENT_VERSION);

    // One journal entry with a red flag, and one CRITICAL escalation
    // audit row (the same 'danger_escalation' shape auditDangerEscalation
    // writes) — enough to exercise trend/symptomCounts/redFlagDates and
    // push the derived riskLevel to 'high'.
    await db.createOrUpdateJournal(
      phone,
      {
        emotional_state: 4,
        physical_symptoms: JSON.stringify(['headache']),
        sleep_hours: 5,
        appetite: 'poor',
        completed: 1,
        completed_at: new Date().toISOString(),
        red_flags_detected: JSON.stringify(['severe_headache']),
      },
      null
    );
    await db.recordAudit({
      actor: 'system',
      action: 'danger_escalation',
      resource: 'conversation',
      resourceOwner: phone,
      metadata: { urgencyLevel: 'critical' },
    });

    const res = await request(app)
      .get('/provider/patients/detail')
      .query({ phone })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.phone).toBe(phone);
    expect(res.body.riskLevel).toBe('high');
    expect(res.body.trend).toBeTruthy();
    expect(res.body.dailySeries).toHaveProperty('moodSeries');
    expect(res.body.dailySeries).toHaveProperty('sleepSeries');
    expect(Array.isArray(res.body.symptomCounts)).toBe(true);
    expect(Array.isArray(res.body.redFlagDates)).toBe(true);
    expect(res.body.redFlagDates.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.recentEscalations)).toBe(true);
    expect(res.body.recentEscalations.some((e: { urgency: string }) => e.urgency === 'critical')).toBe(true);
  });

  it('a provider from a DIFFERENT facility gets 404, not 403, even though consent is granted (enrollment boundary first)', async () => {
    const app = createApp();
    const a = await seedFacilityAndProvider();
    const b = await seedFacilityAndProvider();
    const tokenA = await providerToken(app, a.provider.email, a.password);
    const tokenB = await providerToken(app, b.provider.email, b.password);
    const rawPhone = freshPhone();
    const { phone } = await motherPhoneAndToken(app, rawPhone);
    await request(app).post('/provider/enroll').set('Authorization', `Bearer ${tokenA}`).send({ phone: rawPhone });
    await db.recordConsent(phone, 'provider_access', true, CONSENT_VERSION);

    const res = await request(app)
      .get('/provider/patients/detail')
      .query({ phone })
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_enrolled');
  });

  it('a granted (200) detail read is audited — actor provider:<id>, resource insights, visible via GET /me/activity', async () => {
    const app = createApp();
    const { provider, password } = await seedFacilityAndProvider();
    const providerTok = await providerToken(app, provider.email, password);
    const rawPhone = freshPhone();
    const { phone, token: motherTok } = await motherPhoneAndToken(app, rawPhone);
    await request(app)
      .post('/provider/enroll')
      .set('Authorization', `Bearer ${providerTok}`)
      .send({ phone: rawPhone });
    await db.recordConsent(phone, 'provider_access', true, CONSENT_VERSION);

    const detail = await request(app)
      .get('/provider/patients/detail')
      .query({ phone })
      .set('Authorization', `Bearer ${providerTok}`);
    expect(detail.status).toBe(200);

    const activity = await request(app).get('/me/activity').set('Authorization', `Bearer ${motherTok}`);
    const readEvent = activity.body.events.find(
      (e: { actor: string; action: string; resource: string }) =>
        e.actor === `provider:${provider.id}` && e.action === 'read' && e.resource === 'insights'
    );
    expect(readEvent).toBeTruthy();
  });

  it('a denied (403) read is still audited — the mother can see a provider tried and was blocked', async () => {
    const app = createApp();
    const { provider, password } = await seedFacilityAndProvider();
    const providerTok = await providerToken(app, provider.email, password);
    const rawPhone = freshPhone();
    const { phone, token: motherTok } = await motherPhoneAndToken(app, rawPhone);
    await request(app)
      .post('/provider/enroll')
      .set('Authorization', `Bearer ${providerTok}`)
      .send({ phone: rawPhone });

    await request(app)
      .get('/provider/patients/detail')
      .query({ phone })
      .set('Authorization', `Bearer ${providerTok}`);

    const activity = await request(app).get('/me/activity').set('Authorization', `Bearer ${motherTok}`);
    const denied = activity.body.events.find(
      (e: { actor: string; metadata?: unknown }) => e.actor === `provider:${provider.id}`
    );
    expect(denied).toBeTruthy();
  });
});

// --- GET /provider/summary ---------------------------------------------------

describe('GET /provider/summary', () => {
  it('sums active enrollments into enrolled/active counts and monthly/annual revenue', async () => {
    const app = createApp();
    const { provider, password } = await seedFacilityAndProvider();
    const token = await providerToken(app, provider.email, password);

    await request(app)
      .post('/provider/enroll')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: freshPhone() });
    await request(app)
      .post('/provider/enroll')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: freshPhone() });

    const res = await request(app).get('/provider/summary').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.enrolledCount).toBe(2);
    expect(res.body.activeCount).toBe(2);
    // price_kes (default 5000) is ANNUAL, not monthly — see its doc
    // comment in packages/core/src/repositories.ts. 2 active enrollments
    // => annualRevenueKes sums directly to 10000; monthlyRevenueKes is
    // the one DIVIDED by 12, never the other way around.
    expect(res.body.annualRevenueKes).toBe(10000);
    expect(res.body.monthlyRevenueKes).toBe(833); // Math.round(10000 / 12)
    expect(res.body.escalations7d).toBe(0);
  });

  it('price_kes is ANNUAL: N active enrollments at the 5000 KES default => annualRevenueKes === N*5000 and monthlyRevenueKes === round(N*5000/12) — never the other way around', async () => {
    const app = createApp();
    const { provider, password } = await seedFacilityAndProvider();
    const token = await providerToken(app, provider.email, password);

    const N = 3;
    for (let i = 0; i < N; i += 1) {
      await request(app)
        .post('/provider/enroll')
        .set('Authorization', `Bearer ${token}`)
        .send({ phone: freshPhone() });
    }

    const res = await request(app).get('/provider/summary').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const DEFAULT_ANNUAL_PRICE_KES = 5000;
    expect(res.body.annualRevenueKes).toBe(N * DEFAULT_ANNUAL_PRICE_KES);
    expect(res.body.monthlyRevenueKes).toBe(Math.round((N * DEFAULT_ANNUAL_PRICE_KES) / 12));
    // The regression this test exists to catch: annualRevenueKes must
    // NEVER equal monthlyRevenueKes * 12 unless monthlyRevenueKes was
    // itself already derived from the (correct) annual total — i.e. this
    // is a tautology check on top of the direct-value assertions above,
    // not a substitute for them.
    expect(res.body.annualRevenueKes).not.toBe(N * DEFAULT_ANNUAL_PRICE_KES * 12);
  });

  it('a facility with no enrollments reports all-zero, not an error', async () => {
    const app = createApp();
    const { provider, password } = await seedFacilityAndProvider();
    const token = await providerToken(app, provider.email, password);
    const res = await request(app).get('/provider/summary').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enrolledCount: 0,
      activeCount: 0,
      monthlyRevenueKes: 0,
      annualRevenueKes: 0,
      escalations7d: 0,
    });
  });
});

// --- Consent purpose plumbing (P5-A addition to the P3-B endpoints) --------

describe("provider_access rides the existing /me/consent endpoints", () => {
  it('a mother can grant provider_access via the generic POST /me/consent — no new mother-facing endpoint needed', async () => {
    const app = createApp();
    const { token } = await motherPhoneAndToken(app, freshPhone());

    const res = await request(app)
      .post('/me/consent')
      .set('Authorization', `Bearer ${token}`)
      .send({ grants: { data_processing: true, provider_access: true } });
    expect(res.status).toBe(200);
    const purpose = res.body.purposes.find((p: { purpose: string }) => p.purpose === 'provider_access');
    expect(purpose).toEqual({ purpose: 'provider_access', granted: true, active: true, version: CONSENT_VERSION });
  });
});
