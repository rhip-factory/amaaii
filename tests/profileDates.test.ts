// PUT /me now accepts edd and delivery_date (P1), which feed
// pregnancyStatus on every GET /me and provider read — so only plausible
// ISO dates may be stored, and a new week moves the due date.
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

beforeAll(async () => {
  await db.initializeDatabase();
});

let n = 0;
async function login(app: import('express').Express): Promise<string> {
  n += 1;
  const res = await request(app).post('/auth/login').send({ phone: `07330${String(n).padStart(5, '0')}` });
  return res.body.token as string;
}

const day = (offset: number) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

describe('PUT /me dates', () => {
  it.each([
    ['edd', 'not-a-date'],
    ['edd', 12345],
    ['edd', day(400)],
    ['delivery_date', day(3)],
    ['delivery_date', day(-500)],
  ])('rejects %s = %s', async (key, value) => {
    const app = createApp();
    const token = await login(app);
    const res = await request(app).put('/me').set('Authorization', `Bearer ${token}`).send({ [key]: value });
    expect(res.status).toBe(400);
  });

  it('a new week moves the due date, and GET /me reports the same week', async () => {
    const app = createApp();
    const token = await login(app);
    const put = await request(app).put('/me').set('Authorization', `Bearer ${token}`).send({ pregnancy_week: 20 });
    expect(put.status).toBe(200);
    expect(put.body.user.edd).toBe(day(140));
    const me = await request(app).get('/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.user.pregnancy_week).toBe(20);
    expect(me.body.user.phase).toBe('pregnant');
  });

  it('a delivery date switches GET /me to postpartum', async () => {
    const app = createApp();
    const token = await login(app);
    await request(app).put('/me').set('Authorization', `Bearer ${token}`).send({ delivery_date: day(-10) });
    const me = await request(app).get('/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.user.phase).toBe('postpartum');
    expect(me.body.user.postpartum_days).toBe(10);
  });
});
