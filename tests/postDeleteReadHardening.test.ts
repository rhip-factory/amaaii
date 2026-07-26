// P3-E: pins the post-delete read-hardening fix. Before this, a stateless
// bearer token issued before DELETE /me/account still verified fine
// afterwards (tokens are HMACs, not session records — see auth.ts), and
// GET /me / GET /me/export's getOrCreateUser() call would silently
// recreate a blank `users` row on the very next read — see the P3-C flag
// and P3-D's client-only mitigation this closes server-side.
//
// The fix (userManager.ts#getUserForRead + audit.ts#wasAccountDeleted)
// distinguishes "this phone has never signed up" (still safe to
// auto-vivify — app.test.ts's "GET /me with a valid token from
// /auth/login succeeds" and otpAuth.test.ts's happy path both pin that
// this still works) from "this phone signed up, was deleted, and a stale
// token is still being presented" (must NOT be resurrected).
//
// Follows the existing HTTP-level test convention (tsx/cjs require,
// in-memory DB, createApp() per test, dummy +2547000000xx phones).
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs');

process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';
process.env.AUTH_SECRET = 'test-auth-secret';
process.env.NODE_ENV = 'development'; // devCode in OTP responses, for the re-signup test
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_WHATSAPP_NUMBER;

const db = require('../apps/server/src/database');
const { createApp } = require('../apps/server/src/app');
const { CONSENT_VERSION } = require('@amaaii/core');

beforeAll(async () => {
  await db.initializeDatabase();
});

let counter = 80000;
function freshPhone(): string {
  counter += 1;
  return `07000${String(counter).padStart(5, '0')}`;
}

/** Seeds a real account (row + consent) and deletes it via the real HTTP
 *  route, returning the now-stale token a client would still be holding. */
async function seedAndDeleteUser(
  app: import('express').Express,
  rawPhone: string
): Promise<{ staleToken: string; phone: string }> {
  const login = await request(app).post('/auth/login').send({ phone: rawPhone });
  const staleToken = login.body.token as string;
  const phone = login.body.user.phone as string;

  await db.createUser(phone, { name: 'Test Mother', age: 27, pregnancy_week: 15, location: 'Kisumu' });
  await db.recordConsent(phone, 'data_processing', true, CONSENT_VERSION);

  const del = await request(app).delete('/me/account').set('Authorization', `Bearer ${staleToken}`);
  expect(del.status).toBe(200);
  expect(del.body.deleted).toBe(true);

  // Sanity: really gone before any of the tests below run.
  expect(await db.getUser(phone)).toBeUndefined();

  return { staleToken, phone };
}

describe('post-delete read hardening (P3-E)', () => {
  it('GET /me does not resurrect a row — 401 no_account, users table stays empty for that phone', async () => {
    const app = createApp();
    const { staleToken, phone } = await seedAndDeleteUser(app, freshPhone());

    const res = await request(app).get('/me').set('Authorization', `Bearer ${staleToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('no_account');

    // The actual assertion the bug was about: no blank row got created.
    expect(await db.getUser(phone)).toBeUndefined();
  });

  it('GET /me/export returns 401 no_account instead of exporting a freshly-recreated blank profile', async () => {
    const app = createApp();
    const { staleToken, phone } = await seedAndDeleteUser(app, freshPhone());

    const res = await request(app).get('/me/export').set('Authorization', `Bearer ${staleToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('no_account');
    expect(await db.getUser(phone)).toBeUndefined();
  });

  it('GET /me/consent returns 401 no_account instead of a fresh "needsConsent: true" state', async () => {
    const app = createApp();
    const { staleToken, phone } = await seedAndDeleteUser(app, freshPhone());

    const res = await request(app).get('/me/consent').set('Authorization', `Bearer ${staleToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('no_account');
    // This route never wrote to `users` even before the fix — pinned here
    // too so a future change can't quietly reintroduce a getOrCreate call.
    expect(await db.getUser(phone)).toBeUndefined();
  });

  it('GET /me/activity returns 401 no_account instead of the deleted account\'s own retained audit history', async () => {
    const app = createApp();
    const { staleToken, phone } = await seedAndDeleteUser(app, freshPhone());

    const res = await request(app).get('/me/activity').set('Authorization', `Bearer ${staleToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('no_account');
    expect(await db.getUser(phone)).toBeUndefined();
  });

  it('the delete audit event survives all of the above reads — audit_log is retained, not touched by the 401s', async () => {
    const app = createApp();
    const { staleToken, phone } = await seedAndDeleteUser(app, freshPhone());

    await request(app).get('/me').set('Authorization', `Bearer ${staleToken}`);
    await request(app).get('/me/export').set('Authorization', `Bearer ${staleToken}`);
    await request(app).get('/me/consent').set('Authorization', `Bearer ${staleToken}`);
    await request(app).get('/me/activity').set('Authorization', `Bearer ${staleToken}`);

    const events = await db.listAuditForUser(phone, 1000);
    expect(events.some((e: { action: string; resource: string }) => e.action === 'delete' && e.resource === 'account')).toBe(true);
    // None of the rejected reads got far enough to write their own
    // 'read' audit rows (the guard runs before recordAuditSafe).
    expect(events.some((e: { action: string }) => e.action === 'read')).toBe(false);
  });

  it('a deleted phone can sign up again via a fresh OTP verify, and every /me-family route works normally afterwards', async () => {
    const app = createApp();
    const rawPhone = freshPhone();
    const { phone } = await seedAndDeleteUser(app, rawPhone);

    // Real re-signup path: request + verify a new OTP for the SAME phone.
    // OTP verify legitimately creates the row via its own
    // getOrCreateUser() call — untouched by this fix — so this must
    // still work exactly as it did before a delete ever happened.
    const otpReq = await request(app).post('/auth/otp/request').send({ phone: rawPhone });
    expect(otpReq.status).toBe(200);
    const devCode = otpReq.body.devCode as string;

    const otpVerify = await request(app).post('/auth/otp/verify').send({ phone: rawPhone, code: devCode });
    expect(otpVerify.status).toBe(200);
    const freshToken = otpVerify.body.token as string;

    expect(await db.getUser(phone)).toBeTruthy();

    const meRes = await request(app).get('/me').set('Authorization', `Bearer ${freshToken}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.phone).toBe(phone);

    const consentRes = await request(app).get('/me/consent').set('Authorization', `Bearer ${freshToken}`);
    expect(consentRes.status).toBe(200);

    const activityRes = await request(app).get('/me/activity').set('Authorization', `Bearer ${freshToken}`);
    expect(activityRes.status).toBe(200);

    const exportRes = await request(app).get('/me/export').set('Authorization', `Bearer ${freshToken}`);
    expect(exportRes.status).toBe(200);
    expect(exportRes.body.phone).toBe(phone);
  });

  it('a genuinely brand-new (never-deleted) phone is unaffected — GET /me still auto-vivifies via the legacy /auth/login path', async () => {
    const app = createApp();
    const rawPhone = freshPhone();
    const login = await request(app).post('/auth/login').send({ phone: rawPhone });
    const token = login.body.token as string;
    const phone = login.body.user.phone as string;

    // No row yet — /auth/login never creates one.
    expect(await db.getUser(phone)).toBeUndefined();

    const res = await request(app).get('/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.phone).toBe(phone);
    expect(await db.getUser(phone)).toBeTruthy();
  });
});
