// P1-E: light wiring/boot test for apps/server/src/app.ts's createApp()
// factory — the biggest structural piece of this migration (server.js's
// route wiring moved wholesale into a TS factory function). The
// route-by-route BEHAVIOR (danger signs, onboarding, journaling) is
// already covered exhaustively by tests/messageHandler.test.js,
// tests/journalManager.test.js, etc.; this file only proves the Express
// app itself boots and the routes are reachable/wired correctly.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Registers Node module hooks so this native `require()` can load
// TypeScript sources (apps/server/src/*.ts) directly, same as `tsx` does
// for `pnpm start`/`pnpm dev`.
require('tsx/cjs');

// Set env BEFORE the application modules load — apps/server/src/database
// reads DB_PATH at module top-level.
process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';
process.env.AUTH_SECRET = 'test-auth-secret';

const db = require('../apps/server/src/database');
const { createApp } = require('../apps/server/src/app');

beforeAll(async () => {
  await db.initializeDatabase();
});

describe('apps/server/src/app — wiring smoke test', () => {
  it('GET / returns 200 (serves the PWA index.html)', async () => {
    const app = createApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
  });

  it('POST /auth/login with a valid phone returns a bearer token', async () => {
    const app = createApp();
    const res = await request(app).post('/auth/login').send({ phone: '0712345678' });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.user.phone).toBe('whatsapp:+254712345678');
  });

  it('POST /auth/login with an invalid phone returns 400', async () => {
    const app = createApp();
    const res = await request(app).post('/auth/login').send({ phone: '123' });
    expect(res.status).toBe(400);
  });

  it('GET /me without a bearer token is rejected with 401', async () => {
    const app = createApp();
    const res = await request(app).get('/me');
    expect(res.status).toBe(401);
  });

  it('GET /me with a valid token from /auth/login succeeds', async () => {
    const app = createApp();
    const login = await request(app).post('/auth/login').send({ phone: '0700111222' });
    const res = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.phone).toBe('whatsapp:+254700111222');
  });

  it('GET /webhook (health check, no signature required) responds', async () => {
    const app = createApp();
    const res = await request(app).get('/webhook');
    expect(res.status).toBe(200);
  });
});
