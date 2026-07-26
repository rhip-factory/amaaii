// P3-B: HTTP-level tests for the consent endpoints wired into
// apps/server/src/app.ts (GET/POST /me/consent, POST /me/consent/revoke).
// Follows tests/app.test.ts's pattern (tsx/cjs require, in-memory DB,
// createApp() per test). The pure decision logic these endpoints call
// into is already covered by tests/consent.test.ts; the SQLite-backed
// ledger plumbing by tests/consentAuditRepository.test.ts — this file
// only proves the routes themselves (validation, shapes, audit wiring).
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

let counter = 0;
function freshPhone(): string {
  counter += 1;
  return `07000${String(counter).padStart(5, '0')}`;
}

async function loginAndGetToken(app: import('express').Express, phone: string): Promise<string> {
  const res = await request(app).post('/auth/login').send({ phone });
  return res.body.token as string;
}

describe('GET /me/consent', () => {
  it('requires auth', async () => {
    const app = createApp();
    const res = await request(app).get('/me/consent');
    expect(res.status).toBe(401);
  });

  it('a brand-new user needs consent: no purposes active, canUseAi false', async () => {
    const app = createApp();
    const token = await loginAndGetToken(app, freshPhone());
    const res = await request(app).get('/me/consent').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(CONSENT_VERSION);
    expect(res.body.needsConsent).toBe(true);
    expect(res.body.canUseAi).toBe(false);
    expect(res.body.purposes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ purpose: 'data_processing', granted: false, active: false }),
        expect.objectContaining({ purpose: 'ai_responses', granted: false, active: false }),
      ])
    );
  });
});

describe('POST /me/consent', () => {
  it('granting both purposes flips GET /me/consent to fully consented', async () => {
    const app = createApp();
    const token = await loginAndGetToken(app, freshPhone());

    const postRes = await request(app)
      .post('/me/consent')
      .set('Authorization', `Bearer ${token}`)
      .send({ grants: { data_processing: true, ai_responses: true } });
    expect(postRes.status).toBe(200);
    expect(postRes.body.needsConsent).toBe(false);
    expect(postRes.body.canUseAi).toBe(true);

    const getRes = await request(app).get('/me/consent').set('Authorization', `Bearer ${token}`);
    expect(getRes.body.needsConsent).toBe(false);
    expect(getRes.body.canUseAi).toBe(true);
    expect(getRes.body.purposes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ purpose: 'data_processing', granted: true, active: true, version: CONSENT_VERSION }),
        expect.objectContaining({ purpose: 'ai_responses', granted: true, active: true, version: CONSENT_VERSION }),
      ])
    );
  });

  it('declining ai_responses only (data_processing granted) leaves needsConsent false but canUseAi false', async () => {
    const app = createApp();
    const token = await loginAndGetToken(app, freshPhone());
    const res = await request(app)
      .post('/me/consent')
      .set('Authorization', `Bearer ${token}`)
      .send({ grants: { data_processing: true, ai_responses: false } });
    expect(res.status).toBe(200);
    expect(res.body.needsConsent).toBe(false);
    expect(res.body.canUseAi).toBe(false);
  });

  it('cannot set data_processing to false here — 400 directs to /me/consent/revoke', async () => {
    const app = createApp();
    const token = await loginAndGetToken(app, freshPhone());
    const res = await request(app)
      .post('/me/consent')
      .set('Authorization', `Bearer ${token}`)
      .send({ grants: { data_processing: false } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('cannot_decline_required');
    expect(res.body.message).toMatch(/revoke/i);

    // And it must not have silently recorded anything.
    const getRes = await request(app).get('/me/consent').set('Authorization', `Bearer ${token}`);
    expect(getRes.body.needsConsent).toBe(true);
  });

  it('rejects an unknown purpose with 400', async () => {
    const app = createApp();
    const token = await loginAndGetToken(app, freshPhone());
    const res = await request(app)
      .post('/me/consent')
      .set('Authorization', `Bearer ${token}`)
      .send({ grants: { marketing: true } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_purpose');
  });

  it('rejects a non-boolean grant value with 400', async () => {
    const app = createApp();
    const token = await loginAndGetToken(app, freshPhone());
    const res = await request(app)
      .post('/me/consent')
      .set('Authorization', `Bearer ${token}`)
      .send({ grants: { ai_responses: 'yes' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant_value');
  });

  it('writes a consent_grant audit row per purpose, visible via listAuditForUser', async () => {
    const app = createApp();
    const rawPhone = freshPhone();
    const token = await loginAndGetToken(app, rawPhone);
    const login = await request(app).post('/auth/login').send({ phone: rawPhone });
    const phone = login.body.user.phone as string;

    await request(app)
      .post('/me/consent')
      .set('Authorization', `Bearer ${token}`)
      .send({ grants: { data_processing: true, ai_responses: true } });

    const events = await db.listAuditForUser(phone);
    const grants = events.filter((e: { action: string }) => e.action === 'consent_grant');
    expect(grants.length).toBeGreaterThanOrEqual(2);
    expect(grants.every((e: { resource: string; resource_owner: string }) => e.resource === 'consent' && e.resource_owner === phone)).toBe(true);
  });
});

describe('POST /me/consent/revoke', () => {
  it('revoking ai_responses turns canUseAi false while data_processing stays active', async () => {
    const app = createApp();
    const token = await loginAndGetToken(app, freshPhone());
    await request(app)
      .post('/me/consent')
      .set('Authorization', `Bearer ${token}`)
      .send({ grants: { data_processing: true, ai_responses: true } });

    const revokeRes = await request(app)
      .post('/me/consent/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ purpose: 'ai_responses' });
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.canUseAi).toBe(false);
    expect(revokeRes.body.needsConsent).toBe(false);
    expect(revokeRes.body.note).toBeUndefined();
  });

  it('revoking data_processing flips needsConsent back to true and returns an explanatory note', async () => {
    const app = createApp();
    const token = await loginAndGetToken(app, freshPhone());
    await request(app)
      .post('/me/consent')
      .set('Authorization', `Bearer ${token}`)
      .send({ grants: { data_processing: true, ai_responses: true } });

    const revokeRes = await request(app)
      .post('/me/consent/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ purpose: 'data_processing' });
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.needsConsent).toBe(true);
    expect(typeof revokeRes.body.note).toBe('string');
    expect(revokeRes.body.note.toLowerCase()).toMatch(/stop processing|export|delete/);

    const getRes = await request(app).get('/me/consent').set('Authorization', `Bearer ${token}`);
    expect(getRes.body.needsConsent).toBe(true);
  });

  it('rejects an unknown purpose with 400', async () => {
    const app = createApp();
    const token = await loginAndGetToken(app, freshPhone());
    const res = await request(app)
      .post('/me/consent/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ purpose: 'not_a_real_purpose' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_purpose');
  });

  it('writes a consent_revoke audit row', async () => {
    const app = createApp();
    const rawPhone = freshPhone();
    const token = await loginAndGetToken(app, rawPhone);
    const login = await request(app).post('/auth/login').send({ phone: rawPhone });
    const phone = login.body.user.phone as string;

    await request(app)
      .post('/me/consent')
      .set('Authorization', `Bearer ${token}`)
      .send({ grants: { data_processing: true, ai_responses: true } });
    await request(app)
      .post('/me/consent/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ purpose: 'ai_responses' });

    const events = await db.listAuditForUser(phone);
    expect(events.some((e: { action: string; resource: string }) => e.action === 'consent_revoke' && e.resource === 'consent')).toBe(true);
  });
});
