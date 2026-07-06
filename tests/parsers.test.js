import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Registers Node module hooks so this native `require()` can load
// TypeScript sources (apps/server/src/*.ts) directly, same as `tsx` does
// for `pnpm start`/`pnpm dev`.
require('tsx/cjs');

process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';

const db = require('../apps/server/src/database');
const journalManager = require('../apps/server/src/journalManager');

beforeAll(async () => {
  await db.initializeDatabase();
});

let counter = 7000;
function nextPhone() {
  counter += 1;
  return `whatsapp:+254700007${counter}`;
}

async function seedAndStart(phone, week = 18) {
  await db.createUser(phone, { name: 'Test' });
  await db.updateUser(phone, { age: 28, pregnancy_week: week, location: 'Nairobi' });
  const user = await db.getUser(phone);
  const session = await journalManager.startJournalSession(phone, user);
  // Drive through greeting and mood so we land on the stage we want next.
  await journalManager.processJournalResponse(phone, 'journal', session.currentStage);
  await journalManager.processJournalResponse(phone, '7', 'mood');
  await journalManager.processJournalResponse(phone, 'none', 'symptoms');
  // Now at 'sleep'.
}

async function lastJournal(phone) {
  return db.getTodaysJournal(phone);
}

describe('sleep parser', () => {
  it('parses "7/10, 6 hours" as quality=7, hours=6', async () => {
    const phone = nextPhone();
    await seedAndStart(phone);
    await journalManager.processJournalResponse(phone, '7/10, 6 hours', 'sleep');
    const j = await lastJournal(phone);
    expect(j.sleep_quality).toBe(7);
    expect(j.sleep_hours).toBe(6);
  });

  it('parses "6 hours, 7/10" as quality=7, hours=6 (order independent)', async () => {
    const phone = nextPhone();
    await seedAndStart(phone);
    await journalManager.processJournalResponse(phone, '6 hours, 7/10', 'sleep');
    const j = await lastJournal(phone);
    expect(j.sleep_quality).toBe(7);
    expect(j.sleep_hours).toBe(6);
  });

  it('parses "slept 8h" as hours=8 (no quality)', async () => {
    const phone = nextPhone();
    await seedAndStart(phone);
    await journalManager.processJournalResponse(phone, 'slept 8h', 'sleep');
    const j = await lastJournal(phone);
    expect(j.sleep_hours).toBe(8);
    expect(j.sleep_quality == null).toBe(true);
  });
});

describe('appetite parser', () => {
  async function appetite(phone, msg) {
    await journalManager.processJournalResponse(phone, msg, 'appetite');
    const j = await lastJournal(phone);
    return j.appetite;
  }

  it('"no good appetite" → poor', async () => {
    const phone = nextPhone();
    await seedAndStart(phone);
    expect(await appetite(phone, 'no good appetite')).toBe('poor');
  });

  it('"not poor at all" → moderate (must NOT be poor)', async () => {
    const phone = nextPhone();
    await seedAndStart(phone);
    expect(await appetite(phone, 'not poor at all')).toBe('moderate');
  });

  it('"good" → good', async () => {
    const phone = nextPhone();
    await seedAndStart(phone);
    expect(await appetite(phone, 'good')).toBe('good');
  });

  it('"poor" → poor', async () => {
    const phone = nextPhone();
    await seedAndStart(phone);
    expect(await appetite(phone, 'poor')).toBe('poor');
  });
});

describe('extractWeeklySymptoms', () => {
  it('does not silently swallow non-array JSON in physical_symptoms', () => {
    const noisy = [
      { physical_symptoms: 'just text from user' },
      { physical_symptoms: JSON.stringify(['nausea']) },
      { physical_symptoms: JSON.stringify(['nausea', 'headache']) },
    ];
    const top = journalManager.extractWeeklySymptoms(noisy);
    expect(top).toContain('nausea');
  });
});
