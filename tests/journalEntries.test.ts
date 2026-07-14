// P2-C: structured check-in form API — POST /journal/entries,
// GET /journal/today, GET /journal/entries. Follows tests/otpAuth.test.ts's
// pattern (tsx/cjs require, createApp() per test, in-memory DB). Also
// verifies cross-path visibility: a form-written journal row must be
// visible to the WhatsApp weekly-summary/trend code paths exactly like a
// WhatsApp-written one (packages/adapters/src/sqlite/journalRepository.ts
// stores both through the same `journals` table columns).
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

const db = require('../apps/server/src/database');
const { createApp } = require('../apps/server/src/app');
const { getRecentTrend } = require('../apps/server/src/trend');
const journalManager = require('../apps/server/src/journalManager');

beforeAll(async () => {
  await db.initializeDatabase();
});

// Dummy Kenyan-shaped numbers, not real subscribers — see CLAUDE.md / project
// PII policy. Each test uses its own phone so state from one test can't
// bleed into another.
let counter = 0;
function freshPhone(): string {
  counter += 1;
  return `07000${String(1000000 + counter).slice(1)}`;
}

async function loginAndGetToken(app: import('express').Express, localPhone: string): Promise<{ token: string; phone: string }> {
  const res = await request(app).post('/auth/login').send({ phone: localPhone });
  expect(res.status).toBe(200);
  return { token: res.body.token as string, phone: res.body.user.phone as string };
}

// No symptoms by default — several of the fixed Symptom-vocabulary chip
// values (e.g. "nausea") are themselves MODERATE-tier danger-sign
// patterns in packages/core/src/dangerSigns.ts (matching the WhatsApp
// flow: typing "nausea" as a symptoms answer registers as moderate too —
// it just doesn't interrupt the flow or add an escalation, since only
// critical/high do). Tests that care about symptom-chip -> physical_symptoms
// mapping opt in to a symptom explicitly.
function baseEntry(overrides: Record<string, unknown> = {}) {
  return {
    mood: 7,
    symptoms: [],
    sleepHours: 6.5,
    appetite: 'good',
    clientEntryId: `entry-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

describe('POST /journal/entries (P2-C)', () => {
  it('happy path: writes an entry and it is readable via GET /journal/today', async () => {
    const app = createApp();
    const { token, phone } = await loginAndGetToken(app, freshPhone());

    const postRes = await request(app)
      .post('/journal/entries')
      .set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ symptoms: ['nausea'], note: 'Feeling okay today' }));

    expect(postRes.status).toBe(201);
    expect(postRes.body.deduped).toBe(false);
    // "nausea" is itself a MODERATE-tier danger-sign pattern (matches the
    // WhatsApp flow exactly) — moderate never produces an escalation banner,
    // only critical/high do (see the dedicated danger-sign tests below).
    expect(postRes.body.urgencyLevel).toBe('moderate');
    expect(postRes.body.escalation).toBeUndefined();
    expect(postRes.body.entry.mood).toBe(7);
    expect(postRes.body.entry.symptoms).toEqual(['nausea']);
    expect(postRes.body.entry.sleepHours).toBe(6.5);
    expect(postRes.body.entry.appetite).toBe('good');
    expect(postRes.body.entry.note).toBe('Feeling okay today');
    expect(postRes.body.entry.completed).toBe(true);
    expect(postRes.body.entry.hasRedFlags).toBe(false);

    const todayRes = await request(app).get('/journal/today').set('Authorization', `Bearer ${token}`);
    expect(todayRes.status).toBe(200);
    expect(todayRes.body.count).toBe(1);
    expect(todayRes.body.entries).toHaveLength(1);
    expect(todayRes.body.entries[0].clientEntryId).toBe(postRes.body.entry.clientEntryId);

    // Sanity: the row actually landed under the normalized WhatsApp-shaped phone key.
    expect(phone).toMatch(/^whatsapp:\+254/);
  });

  it('supports multiple check-ins per day — GET /journal/today count reflects both, newest first', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());

    await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ mood: 4, clientEntryId: 'first-checkin' }));
    await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ mood: 8, clientEntryId: 'second-checkin' }));

    const todayRes = await request(app).get('/journal/today').set('Authorization', `Bearer ${token}`);
    expect(todayRes.body.count).toBe(2);
    // Newest first.
    expect(todayRes.body.entries[0].clientEntryId).toBe('second-checkin');
    expect(todayRes.body.entries[1].clientEntryId).toBe('first-checkin');
  });

  it('requires a bearer token (401)', async () => {
    const app = createApp();
    const res = await request(app).post('/journal/entries').send(baseEntry());
    expect(res.status).toBe(401);
  });

  it('rejects a missing/out-of-range mood with an honest 400', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());
    const res = await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ mood: 11 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_mood');
  });

  it('rejects an unknown symptom value with an honest 400', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());
    const res = await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ symptoms: ['not_a_real_symptom'] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_symptoms');
    expect(res.body.message).toMatch(/not_a_real_symptom/);
  });

  it('rejects an invalid appetite value with an honest 400 (real enum is good/moderate/poor, not "fair")', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());
    const res = await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ appetite: 'fair' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_appetite');
  });

  it('rejects a missing clientEntryId with an honest 400', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());
    const entry = baseEntry();
    delete (entry as Record<string, unknown>).clientEntryId;
    const res = await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`).send(entry);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_clientEntryId');
  });

  it('rejects an out-of-range sleepHours with an honest 400', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());
    const res = await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ sleepHours: 30 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_sleepHours');
  });

  it('is idempotent: replaying the same clientEntryId dedupes and never double-writes', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());
    const entry = baseEntry({ clientEntryId: 'replay-me', note: 'first submit' });

    const first = await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`).send(entry);
    expect(first.status).toBe(201);
    expect(first.body.deduped).toBe(false);

    // Client retries with the SAME clientEntryId (simulating a double-tap
    // or a network-retry), possibly with a slightly different payload —
    // must never create a second row.
    const replay = await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send({ ...entry, mood: 9 });
    expect(replay.status).toBe(200);
    expect(replay.body.deduped).toBe(true);
    // Returns the ORIGINALLY saved entry, not the replay's payload.
    expect(replay.body.entry.mood).toBe(7);
    expect(replay.body.entry.note).toBe('first submit');

    const todayRes = await request(app).get('/journal/today').set('Authorization', `Bearer ${token}`);
    expect(todayRes.body.count).toBe(1);
  });

  it('a symptomsText danger sign ("heavy bleeding") triggers escalation copy AND still persists the entry', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());

    const res = await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ symptoms: [], symptomsText: 'I have heavy bleeding today', clientEntryId: 'danger-1' }));

    expect(res.status).toBe(201);
    expect(res.body.urgencyLevel).toBe('critical');
    expect(typeof res.body.escalation).toBe('string');
    expect(res.body.escalation).toMatch(/URGENT/);
    // SAFETY: the entry must still be saved — the form must never be a
    // path that silently discards a dangerous check-in.
    expect(res.body.entry.hasRedFlags).toBe(true);
    expect(res.body.deduped).toBe(false);

    const todayRes = await request(app).get('/journal/today').set('Authorization', `Bearer ${token}`);
    expect(todayRes.body.count).toBe(1);
    expect(todayRes.body.entries[0].hasRedFlags).toBe(true);
  });

  it('a danger sign disclosed only in the free note field is still caught', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());

    const res = await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ symptoms: [], note: 'severe headache with blurred vision', clientEntryId: 'danger-note' }));

    expect(res.status).toBe(201);
    expect(['critical', 'high']).toContain(res.body.urgencyLevel);
    expect(typeof res.body.escalation).toBe('string');
    expect(res.body.entry.hasRedFlags).toBe(true);
  });

  it('a replay of a dangerous entry keeps showing the escalation (deduped, but safety copy is not silently dropped)', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());
    const entry = baseEntry({ symptoms: [], symptomsText: 'severe bleeding', clientEntryId: 'danger-replay' });

    await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`).send(entry);
    const replay = await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`).send(entry);

    expect(replay.status).toBe(200);
    expect(replay.body.deduped).toBe(true);
    expect(replay.body.urgencyLevel).toBe('critical');
    expect(typeof replay.body.escalation).toBe('string');
  });

  it('accepts babyMovement for a week >= 20 profile and stores it', async () => {
    const app = createApp();
    const localPhone = freshPhone();
    const { token, phone } = await loginAndGetToken(app, localPhone);
    await db.updateUser(phone, { age: 29, pregnancy_week: 25, location: 'Nairobi' });

    const res = await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ babyMovement: 12, clientEntryId: 'movement-1' }));

    expect(res.status).toBe(201);
    expect(res.body.entry.babyMovement).toBe(12);
  });

  it('a week < 20 profile that omits babyMovement stores it as null (field not asked in the UI)', async () => {
    const app = createApp();
    const localPhone = freshPhone();
    const { token, phone } = await loginAndGetToken(app, localPhone);
    await db.updateUser(phone, { age: 24, pregnancy_week: 10, location: 'Nairobi' });

    const res = await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ clientEntryId: 'no-movement' }));

    expect(res.status).toBe(201);
    expect(res.body.entry.babyMovement).toBeNull();
  });

  it('rejects a negative babyMovement with an honest 400', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());
    const res = await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ babyMovement: -3 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_babyMovement');
  });
});

describe('GET /journal/entries?days=N (P2-C)', () => {
  it('defaults to 14 days and groups entries by day', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());
    await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`).send(baseEntry());

    const res = await request(app).get('/journal/entries').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.days)).toBe(true);
    expect(res.body.days.length).toBeGreaterThanOrEqual(1);
    expect(res.body.days[0].entries.length).toBeGreaterThanOrEqual(1);
  });

  it('caps the days param at 90', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());
    // Just verifying the endpoint doesn't error/misbehave on an oversized
    // days value — the cap itself isn't independently observable without
    // seeding 90+ days of history, so this proves the request is well-formed.
    const res = await request(app).get('/journal/entries?days=9000').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe('Cross-path visibility: form-written entries reach WhatsApp trend/weekly-summary code (P2-C)', () => {
  it('getRecentTrend (used by the WhatsApp journal greeting + /me Insights) sees a form-written entry', async () => {
    const app = createApp();
    const localPhone = freshPhone();
    const { token, phone } = await loginAndGetToken(app, localPhone);
    await db.updateUser(phone, { age: 30, pregnancy_week: 22, location: 'Nairobi' });

    const res = await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ mood: 9, sleepHours: 7, symptoms: ['headache'], clientEntryId: 'trend-check' }));
    expect(res.status).toBe(201);

    const trend = await getRecentTrend(phone, 7);
    expect(trend).not.toBeNull();
    expect(trend.totalEntries).toBeGreaterThanOrEqual(1);
    expect(trend.completedEntries).toBeGreaterThanOrEqual(1);
    expect(trend.avgMood).toBe(9);
    expect(trend.avgSleepHours).toBe(7);
    expect(trend.recurringSymptoms.length === 0 || trend.recurringSymptoms.some((s: { symptom: string }) => s.symptom === 'headache')).toBe(true);
  });

  it('journalManager.getWeeklySummary (the "weekly summary" WhatsApp command) reflects a form-written entry', async () => {
    const app = createApp();
    const localPhone = freshPhone();
    const { token, phone } = await loginAndGetToken(app, localPhone);
    await db.updateUser(phone, { age: 27, pregnancy_week: 18, location: 'Nairobi' });

    await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ mood: 6, clientEntryId: 'weekly-check' }));

    const summary: string = await journalManager.getWeeklySummary(phone);
    expect(summary).toContain('1/7 days');
    expect(summary).toContain('6.0/10');
  });

  it('a form-written red-flag entry is counted in getJournalAnalytics red_flag_days (feeds the doctor report)', async () => {
    const app = createApp();
    const localPhone = freshPhone();
    const { token, phone } = await loginAndGetToken(app, localPhone);

    await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ symptoms: [], symptomsText: 'severe bleeding', clientEntryId: 'analytics-flag' }));

    const analytics = await db.getJournalAnalytics(phone, 7);
    expect(analytics.red_flag_days).toBeGreaterThanOrEqual(1);

    const report: string = await journalManager.generateDoctorReport(phone, 7);
    expect(report).toMatch(/Red Flags Noted/);
  });
});
