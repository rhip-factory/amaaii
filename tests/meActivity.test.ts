// P3-D: HTTP-level tests for GET /me/activity — the thin transparency
// endpoint the PWA's Profile "Who's accessed your data" section reads
// from. Follows tests/consentEndpoints.test.ts's pattern (tsx/cjs
// require, in-memory DB, createApp() per test). The underlying
// listAuditForUser plumbing is already covered by
// tests/consentAuditRepository.test.ts — this file only proves the
// route itself (auth, shape, ordering, isolation, and that the view
// itself gets audited without polluting the response it just returned).
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

let counter = 70000;
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

describe('GET /me/activity', () => {
  it('requires auth', async () => {
    const app = createApp();
    const res = await request(app).get('/me/activity');
    expect(res.status).toBe(401);
  });

  it('a brand-new user has an empty activity list', async () => {
    const app = createApp();
    const { token } = await loginAndGetPhone(app, freshPhone());
    const res = await request(app).get('/me/activity').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
  });

  it('returns this user\'s audit events, newest first', async () => {
    const app = createApp();
    const { token, phone } = await loginAndGetPhone(app, freshPhone());

    await request(app)
      .post('/me/consent')
      .set('Authorization', `Bearer ${token}`)
      .send({ grants: { data_processing: true, ai_responses: true } });
    await request(app)
      .post('/me/consent/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ purpose: 'ai_responses' });

    const res = await request(app).get('/me/activity').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const actions = res.body.events.map((e: { action: string }) => e.action);
    // consent_revoke is the most recent write before this GET, so it
    // must lead — proves newest-first ordering, not just "contains".
    expect(actions[0]).toBe('consent_revoke');
    expect(actions).toContain('consent_grant');
    expect(res.body.events.every((e: { resource_owner: string }) => e.resource_owner === phone)).toBe(true);
  });

  it('records a read/account audit row for the view itself, visible on the NEXT call but not the one that produced it', async () => {
    const app = createApp();
    const { token, phone } = await loginAndGetPhone(app, freshPhone());

    const first = await request(app).get('/me/activity').set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.body.events).toEqual([]); // nothing yet — the read this call itself causes hasn't been recorded when the response was built

    const events = await db.listAuditForUser(phone);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('read');
    expect(events[0].resource).toBe('account');

    const second = await request(app).get('/me/activity').set('Authorization', `Bearer ${token}`);
    expect(second.status).toBe(200);
    expect(second.body.events).toHaveLength(1);
    expect(second.body.events[0].action).toBe('read');
    expect(second.body.events[0].resource).toBe('account');
  });

  it('respects ACTIVITY_LIST_LIMIT-style capping (does not error under many rows) and stays newest-first', async () => {
    const app = createApp();
    const { token, phone } = await loginAndGetPhone(app, freshPhone());

    for (let i = 0; i < 10; i += 1) {
      await db.recordAudit({
        actor: phone,
        action: 'read',
        resource: 'journal',
        resourceOwner: phone,
        timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      });
    }
    const res = await request(app).get('/me/activity').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.events.length).toBeGreaterThanOrEqual(10);
    const timestamps = res.body.events.map((e: { created_at: string }) => new Date(e.created_at).getTime());
    const sorted = [...timestamps].sort((a, b) => b - a);
    expect(timestamps).toEqual(sorted);
  });

  it("isolation: user A's activity never contains user B's rows", async () => {
    const app = createApp();
    const { token: tokenA, phone: phoneA } = await loginAndGetPhone(app, freshPhone());
    const { token: tokenB } = await loginAndGetPhone(app, freshPhone());

    await request(app)
      .post('/me/consent')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ grants: { data_processing: true } });

    const resA = await request(app).get('/me/activity').set('Authorization', `Bearer ${tokenA}`);
    expect(resA.body.events).toEqual([]);

    const resB = await request(app).get('/me/activity').set('Authorization', `Bearer ${tokenB}`);
    expect(resB.body.events.some((e: { resource_owner: string }) => e.resource_owner === phoneA)).toBe(false);
  });

  it('metadata carries the consent purpose as JSON, parseable by the client', async () => {
    const app = createApp();
    const { token } = await loginAndGetPhone(app, freshPhone());
    await request(app)
      .post('/me/consent')
      .set('Authorization', `Bearer ${token}`)
      .send({ grants: { data_processing: true } });

    const res = await request(app).get('/me/activity').set('Authorization', `Bearer ${token}`);
    const grant = res.body.events.find((e: { action: string }) => e.action === 'consent_grant');
    expect(grant).toBeTruthy();
    expect(JSON.parse(grant.metadata)).toMatchObject({ purpose: 'data_processing', granted: true });
  });
});
