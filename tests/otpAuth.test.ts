// P2-B: OTP auth flow — POST /auth/otp/request + POST /auth/otp/verify,
// plus the GET/PUT /me getOrCreate regression fixed alongside it. Follows
// tests/app.test.ts's pattern (tsx/cjs require, createApp() per test,
// in-memory DB). No Twilio creds are set, so every request here exercises
// the dev-mode path (devCode present in the response) — see
// apps/server/src/app.ts's POST /auth/otp/request for the Twilio-vs-dev
// branch itself.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs');

// Set env BEFORE the application modules load — apps/server/src/database
// reads DB_PATH at module top-level.
process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';
process.env.AUTH_SECRET = 'test-auth-secret';
process.env.NODE_ENV = 'development';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_WHATSAPP_NUMBER;

const db = require('../apps/server/src/database');
const { createApp } = require('../apps/server/src/app');
const { hashOtpCode } = require('../apps/server/src/otp');

beforeAll(async () => {
  await db.initializeDatabase();
});

// Dummy Kenyan-shaped numbers, not real subscribers — see CLAUDE.md /
// project PII policy. Each test uses its own phone so rate-limit state
// from one test can't bleed into another.
let counter = 0;
function freshPhone(): string {
  counter += 1;
  return `070000${String(counter).padStart(4, '0')}`;
}

describe('POST /auth/otp/request + /auth/otp/verify (P2-B)', () => {
  it('request -> verify happy path issues a working bearer token', async () => {
    const app = createApp();
    const phone = freshPhone();

    const reqRes = await request(app).post('/auth/otp/request').send({ phone });
    expect(reqRes.status).toBe(200);
    expect(reqRes.body.sent).toBe(true);
    expect(typeof reqRes.body.devCode).toBe('string');
    expect(reqRes.body.devCode).toMatch(/^\d{6}$/);

    const verifyRes = await request(app)
      .post('/auth/otp/verify')
      .send({ phone, code: reqRes.body.devCode });
    expect(verifyRes.status).toBe(200);
    expect(typeof verifyRes.body.token).toBe('string');
    expect(verifyRes.body.user.phone).toBe(`whatsapp:+254${phone.slice(1)}`);

    // The issued token actually authenticates against a protected route.
    const meRes = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${verifyRes.body.token}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.phone).toBe(`whatsapp:+254${phone.slice(1)}`);
  });

  it('rejects an invalid phone with 400', async () => {
    const app = createApp();
    const res = await request(app).post('/auth/otp/request').send({ phone: '123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_phone');
  });

  it('wrong code x5 locks the OTP (429) and a 6th attempt has nothing to verify', async () => {
    const app = createApp();
    const phone = freshPhone();

    const reqRes = await request(app).post('/auth/otp/request').send({ phone });
    const goodCode = reqRes.body.devCode as string;
    // Guaranteed-wrong 6-digit code, distinct from the real one.
    const wrongCode = goodCode === '000000' ? '111111' : '000000';

    let lastRes;
    for (let i = 0; i < 5; i++) {
      lastRes = await request(app).post('/auth/otp/verify').send({ phone, code: wrongCode });
    }
    // The 5th wrong attempt trips the lock.
    expect(lastRes!.status).toBe(429);
    expect(lastRes!.body.error).toBe('too_many_attempts');

    // Locked out — even the correct code no longer verifies (record was deleted).
    const afterLock = await request(app)
      .post('/auth/otp/verify')
      .send({ phone, code: goodCode });
    expect(afterLock.status).toBe(400);
    expect(afterLock.body.error).toBe('no_code');
  });

  it('reports decreasing attempts remaining on wrong guesses before the lock', async () => {
    const app = createApp();
    const phone = freshPhone();
    const reqRes = await request(app).post('/auth/otp/request').send({ phone });
    const goodCode = reqRes.body.devCode as string;
    const wrongCode = goodCode === '000000' ? '111111' : '000000';

    const first = await request(app).post('/auth/otp/verify').send({ phone, code: wrongCode });
    expect(first.status).toBe(401);
    expect(first.body.error).toBe('wrong_code');
    expect(first.body.attemptsRemaining).toBe(4);
    expect(first.body.message).toMatch(/4 tries left/);
  });

  it('rejects an expired code with 410 (expiry injected directly via the repo)', async () => {
    const app = createApp();
    const phone = `whatsapp:+254${freshPhone().slice(1)}`;
    const code = '654321';
    const alreadyExpired = new Date(Date.now() - 60_000).toISOString(); // 1 min in the past
    await db.createOrReplaceOtp(phone, hashOtpCode(phone, code), alreadyExpired, [
      new Date().toISOString(),
    ]);

    const res = await request(app).post('/auth/otp/verify').send({ phone, code });
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('expired');
  });

  it('rate limits the 4th send within the rolling hour with 429', async () => {
    const app = createApp();
    const phone = freshPhone();

    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/auth/otp/request').send({ phone });
      expect(res.status).toBe(200);
    }
    const fourth = await request(app).post('/auth/otp/request').send({ phone });
    expect(fourth.status).toBe(429);
    expect(fourth.body.error).toBe('rate_limited');
    expect(typeof fourth.body.message).toBe('string');
    expect(fourth.body.message.toLowerCase()).not.toMatch(/sorry/);
  });
});

describe('GET/PUT /me getOrCreate regression (P2-B)', () => {
  it('PUT /me before any chat turn persists — GET /me then returns the saved name', async () => {
    const app = createApp();
    const phone = freshPhone();

    // Sign in via OTP only — no /chat call ever happens, which is exactly
    // the path that used to leave no user row behind.
    const reqRes = await request(app).post('/auth/otp/request').send({ phone });
    const verifyRes = await request(app)
      .post('/auth/otp/verify')
      .send({ phone, code: reqRes.body.devCode });
    const token = verifyRes.body.token as string;

    const putRes = await request(app)
      .put('/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Wanjiku' });
    expect(putRes.status).toBe(200);
    expect(putRes.body.user.name).toBe('Wanjiku');

    const getRes = await request(app).get('/me').set('Authorization', `Bearer ${token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.user.name).toBe('Wanjiku');
  });

  it('GET /me on a brand-new phone (never chatted, never OTP verified) still returns 200 with an empty profile', async () => {
    const app = createApp();
    const phone = freshPhone();
    const login = await request(app).post('/auth/login').send({ phone });

    const getRes = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.user.phone).toBe(login.body.user.phone);
    expect(getRes.body.user.name).toBeNull();
  });
});
