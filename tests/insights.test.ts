// P2-E: GET /insights — chart-ready aggregates for the PWA Insights tab.
// Follows tests/journalEntries.test.ts's pattern (tsx/cjs require,
// createApp() per test, per-test phone numbers). Uses a FILE-backed
// scratch DB (not :memory:) so tests can backdate journals.date through a
// second raw sqlite3 connection — the window/series tests need real
// historical dates, and `date` is deliberately not a whitelisted
// createOrUpdateJournal column.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
require('tsx/cjs');

// Set env BEFORE the application modules load — apps/server/src/database
// reads DB_PATH at module top-level.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amaaii-insights-test-'));
const dbFile = path.join(scratchDir, 'insights-test.db');
process.env.DB_PATH = dbFile;
process.env.OPENAI_API_KEY = 'sk-test-dummy';
process.env.AUTH_SECRET = 'test-auth-secret';
process.env.NODE_ENV = 'development';

const db = require('../apps/server/src/database');
const { createApp } = require('../apps/server/src/app');
const sqlite3 = require('sqlite3');

beforeAll(async () => {
  await db.initializeDatabase();
});

afterAll(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

// Dummy Kenyan-shaped numbers, not real subscribers — see CLAUDE.md / project
// PII policy. Distinct 0709 prefix so these can't collide with other suites.
let counter = 0;
function freshPhone(): string {
  counter += 1;
  return `07090${String(1000000 + counter).slice(1)}`;
}

async function loginAndGetToken(app: import('express').Express, localPhone: string): Promise<{ token: string; phone: string }> {
  const res = await request(app).post('/auth/login').send({ phone: localPhone });
  expect(res.status).toBe(200);
  return { token: res.body.token as string, phone: res.body.user.phone as string };
}

function baseEntry(overrides: Record<string, unknown> = {}) {
  return {
    mood: 7,
    symptoms: [],
    sleepHours: 6.5,
    appetite: 'good',
    clientEntryId: `insights-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

// Rewrites journals.date directly (second connection onto the same file DB)
// — the only way to plant historical rows, since `date` always defaults to
// date('now') on insert and is not a writable column via the repository.
function backdateJournal(journalId: number, daysAgo: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const raw = new sqlite3.Database(dbFile);
    raw.run(
      `UPDATE journals SET date = date('now', ?) WHERE id = ?`,
      [`-${daysAgo} days`, journalId],
      (err: Error | null) => {
        raw.close(() => (err ? reject(err) : resolve()));
      }
    );
  });
}

function utcDateDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 3600 * 1000).toISOString().split('T')[0];
}

const today = () => utcDateDaysAgo(0);

describe('GET /insights (P2-E)', () => {
  it('requires a bearer token (401)', async () => {
    const app = createApp();
    const res = await request(app).get('/insights');
    expect(res.status).toBe(401);
  });

  it('returns the full response shape with real data (default window 14)', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());

    await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ mood: 8, sleepHours: 7, symptoms: ['nausea'] }));

    const res = await request(app).get('/insights').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.window).toBe(14);
    expect(res.body.checkinsCount).toBe(1);
    // trend is core computeTrend's output, passed through verbatim.
    expect(res.body.trend).not.toBeNull();
    expect(res.body.trend.windowDays).toBe(14);
    expect(res.body.trend.avgMood).toBe(8);
    expect(res.body.moodSeries).toEqual([{ date: today(), value: 8 }]);
    expect(res.body.sleepSeries).toEqual([{ date: today(), value: 7 }]);
    expect(res.body.symptomCounts).toEqual([{ symptom: 'nausea', count: 1 }]);
    expect(res.body.redFlagDates).toEqual([]);
  });

  it('empty case: a user with no journals gets null trend, zero count, empty series', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());

    const res = await request(app).get('/insights').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.window).toBe(14);
    expect(res.body.checkinsCount).toBe(0);
    expect(res.body.trend).toBeNull();
    expect(res.body.moodSeries).toEqual([]);
    expect(res.body.sleepSeries).toEqual([]);
    expect(res.body.symptomCounts).toEqual([]);
    expect(res.body.redFlagDates).toEqual([]);
  });

  it('rejects a days value outside {14, 30} with an honest 400', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());

    for (const bad of ['21', '0', '-7', 'abc', '14.5']) {
      const res = await request(app).get(`/insights?days=${bad}`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_days');
    }
    // The two legal values both work.
    const ok14 = await request(app).get('/insights?days=14').set('Authorization', `Bearer ${token}`);
    expect(ok14.status).toBe(200);
    expect(ok14.body.window).toBe(14);
    const ok30 = await request(app).get('/insights?days=30').set('Authorization', `Bearer ${token}`);
    expect(ok30.status).toBe(200);
    expect(ok30.body.window).toBe(30);
  });

  it('averages multiple same-day check-ins per metric (mood 4 & 8 -> one point at 6)', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());

    await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ mood: 4, sleepHours: 6 }));
    await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ mood: 8, sleepHours: 8 }));

    const res = await request(app).get('/insights').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.checkinsCount).toBe(2);
    // One point per DAY, not per entry — averaged, rounded to 1 decimal.
    expect(res.body.moodSeries).toEqual([{ date: today(), value: 6 }]);
    expect(res.body.sleepSeries).toEqual([{ date: today(), value: 7 }]);
  });

  it('a backdated check-in shows up in the series under its historical date, ascending', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());

    const old = await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ mood: 3, sleepHours: 5 }));
    await backdateJournal(old.body.entry.id, 5);
    await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ mood: 9, sleepHours: 8 }));

    const res = await request(app).get('/insights').set('Authorization', `Bearer ${token}`);
    expect(res.body.moodSeries).toEqual([
      { date: utcDateDaysAgo(5), value: 3 },
      { date: today(), value: 9 },
    ]);
    expect(res.body.sleepSeries).toEqual([
      { date: utcDateDaysAgo(5), value: 5 },
      { date: today(), value: 8 },
    ]);
  });

  it('window filtering: a 20-day-old check-in is in days=30 but not days=14', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());

    const old = await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ mood: 2, sleepHours: 4 }));
    await backdateJournal(old.body.entry.id, 20);
    await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ mood: 8 }));

    const res14 = await request(app).get('/insights?days=14').set('Authorization', `Bearer ${token}`);
    expect(res14.body.checkinsCount).toBe(1);
    expect(res14.body.moodSeries).toEqual([{ date: today(), value: 8 }]);

    const res30 = await request(app).get('/insights?days=30').set('Authorization', `Bearer ${token}`);
    expect(res30.body.checkinsCount).toBe(2);
    expect(res30.body.moodSeries).toEqual([
      { date: utcDateDaysAgo(20), value: 2 },
      { date: today(), value: 8 },
    ]);
  });

  it('red-flag dates: a danger entry marks its day, deduped per day, sorted ascending', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());

    const oldDanger = await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ mood: 3, symptomsText: 'heavy bleeding' }));
    expect(oldDanger.body.urgencyLevel).toBe('critical');
    await backdateJournal(oldDanger.body.entry.id, 4);
    // Two flagged entries TODAY -> today appears once (deduped).
    await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ mood: 4, symptomsText: 'severe bleeding' }));
    await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ mood: 5, note: 'severe headache with blurred vision' }));
    // And one clean entry that must NOT add a date.
    await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ mood: 7 }));

    const res = await request(app).get('/insights').set('Authorization', `Bearer ${token}`);
    expect(res.body.redFlagDates).toEqual([utcDateDaysAgo(4), today()]);
  });

  it('caps symptomCounts at the top 6 by count, humanized names, deterministic order', async () => {
    const app = createApp();
    const { token } = await loginAndGetToken(app, freshPhone());

    const seven = ['nausea', 'back_pain', 'fatigue', 'heartburn', 'constipation', 'insomnia', 'swelling'];
    await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ symptoms: seven }));
    await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ symptoms: seven.slice(0, 6) }));
    await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ symptoms: ['nausea'] }));

    const res = await request(app).get('/insights').set('Authorization', `Bearer ${token}`);
    const counts = res.body.symptomCounts as { symptom: string; count: number }[];
    expect(counts).toHaveLength(6);
    expect(counts[0]).toEqual({ symptom: 'nausea', count: 3 });
    // The 1-count 7th symptom fell off the chart.
    expect(counts.some((c) => c.symptom === 'swelling')).toBe(false);
    // Underscored vocabulary is humanized for display.
    expect(counts.some((c) => c.symptom === 'back pain' && c.count === 2)).toBe(true);
    // Sorted by count desc.
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i - 1].count).toBeGreaterThanOrEqual(counts[i].count);
    }
  });

  it('checkinsCount counts completed check-ins only, but a partial check-in\'s recorded mood still charts', async () => {
    const app = createApp();
    const { token, phone } = await loginAndGetToken(app, freshPhone());

    // A WhatsApp-style check-in abandoned mid-flow: mood recorded, never
    // completed (completed stays 0 — e.g. a danger escalation ended the
    // flow early, or the user just stopped replying).
    await db.createOrUpdateJournal(phone, { emotional_state: 4 }, null);
    await request(app).post('/journal/entries').set('Authorization', `Bearer ${token}`)
      .send(baseEntry({ mood: 8 }));

    const res = await request(app).get('/insights').set('Authorization', `Bearer ${token}`);
    expect(res.body.checkinsCount).toBe(1);
    // The partial mood is a real observation — averaged into the day.
    expect(res.body.moodSeries).toEqual([{ date: today(), value: 6 }]);
  });
});
