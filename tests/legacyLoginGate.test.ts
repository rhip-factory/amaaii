// Pins the production gate on the legacy phone-only login endpoint.
//
// POST /auth/login issues a full 30-day bearer token from a phone number
// alone — no OTP, no secret. That is a deliberate dev/test convenience (a
// dozen test files use it as a token factory), but on a publicly-reachable
// deployment it is a complete authentication bypass: a phone number is public
// information, so anyone could mint a token for any mother's number and then
// read, export, or erase her health data.
//
// This was found live against the first hosted deployment, not in review —
// the endpoint answered 200 with a working token on the public URL, and that
// token then opened /me, /history, /insights and /me/activity. Hence a test
// rather than only a comment: the gate must not regress, and the "still works
// outside production" half must not silently break the suites that rely on it.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

process.env.DB_PATH = ':memory:';

import request from 'supertest';
import { createApp } from '../apps/server/src/app';
import { initializeDatabase } from '../apps/server/src/database';

const app = createApp();
const PHONE = '+254700000771';

beforeAll(async () => {
  await initializeDatabase();
});

describe('legacy POST /auth/login production gate', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    // Restore exactly, including the "was undefined" case — leaking
    // NODE_ENV=production into sibling tests would change Twilio signature
    // enforcement and /metrics gating too.
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  });

  it('404s in production instead of issuing a token', async () => {
    process.env.NODE_ENV = 'production';
    const res = await request(app).post('/auth/login').send({ phone: PHONE });
    expect(res.status).toBe(404);
    expect(res.body.token).toBeUndefined();
  });

  it('does not leak a token even for an already-known phone in production', async () => {
    process.env.NODE_ENV = 'production';
    const res = await request(app).post('/auth/login').send({ phone: PHONE });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/eyJ|token/i);
  });

  it('still issues a token outside production (dev/test token factory)', async () => {
    process.env.NODE_ENV = 'test';
    const res = await request(app).post('/auth/login').send({ phone: PHONE });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.user.phone).toBe('whatsapp:+254700000771');
  });

  it('still validates the phone outside production', async () => {
    process.env.NODE_ENV = 'test';
    const res = await request(app).post('/auth/login').send({ phone: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_phone');
  });
});
