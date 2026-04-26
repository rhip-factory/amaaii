import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';

const db = require('../services/database');
const journalManager = require('../services/journalManager');

const seededUsers = new Set();

async function seedUser(phone, week = 18) {
  if (seededUsers.has(phone)) return;
  await db.createUser(phone, { name: 'Test' });
  await db.updateUser(phone, { age: 28, pregnancy_week: week, location: 'Nairobi' });
  seededUsers.add(phone);
}

beforeAll(async () => {
  await db.initializeDatabase();
});

let counter = 5000;
function nextPhone() {
  counter += 1;
  return `whatsapp:+254700005${counter}`;
}

describe('journal session persistence', () => {
  it('persists session to journal_sessions after the greeting reply', async () => {
    const phone = nextPhone();
    await seedUser(phone);
    const user = await db.getUser(phone);
    const session = await journalManager.startJournalSession(phone, user);
    // The greeting → mood transition runs on the FIRST processJournalResponse.
    await journalManager.processJournalResponse(phone, 'journal', session.currentStage);

    const row = await db.getJournalSession(phone);
    expect(row).not.toBeNull();
    expect(row.currentStage).toBe('mood');
  });

  it('survives a "process restart" — session reads back with the same stage', async () => {
    const phone = nextPhone();
    await seedUser(phone);
    const user = await db.getUser(phone);
    let session = await journalManager.startJournalSession(phone, user);
    await journalManager.processJournalResponse(phone, 'journal', session.currentStage);
    // After mood reply we should be at 'symptoms'.
    await journalManager.processJournalResponse(phone, '7', 'mood');

    // Simulate a restart: drop any in-memory state by re-fetching the
    // session purely from the DB.
    const restored = await journalManager.getJournalSession(phone);
    expect(restored).not.toBeNull();
    expect(restored.currentStage).toBe('symptoms');

    // Continue the flow from the restored stage.
    const result = await journalManager.processJournalResponse(phone, 'none', restored.currentStage);
    expect(result.nextStage).toBe('sleep');
  });

  it('two concurrent users keep independent sessions', async () => {
    const phoneA = nextPhone();
    const phoneB = nextPhone();
    await seedUser(phoneA);
    await seedUser(phoneB);
    const userA = await db.getUser(phoneA);
    const userB = await db.getUser(phoneB);

    const sA = await journalManager.startJournalSession(phoneA, userA);
    const sB = await journalManager.startJournalSession(phoneB, userB);
    await journalManager.processJournalResponse(phoneA, 'journal', sA.currentStage);
    await journalManager.processJournalResponse(phoneB, 'journal', sB.currentStage);

    // Advance A only.
    await journalManager.processJournalResponse(phoneA, '8', 'mood');

    const rowA = await db.getJournalSession(phoneA);
    const rowB = await db.getJournalSession(phoneB);
    expect(rowA.currentStage).toBe('symptoms');
    expect(rowB.currentStage).toBe('mood');
  });

  it('session row is deleted when the journal completes', async () => {
    const phone = nextPhone();
    await seedUser(phone, 18); // week<20 → no baby_movement step
    const user = await db.getUser(phone);
    const s = await journalManager.startJournalSession(phone, user);

    await journalManager.processJournalResponse(phone, 'journal', s.currentStage); // greeting → mood
    await journalManager.processJournalResponse(phone, '7', 'mood');               // mood → symptoms
    await journalManager.processJournalResponse(phone, 'none', 'symptoms');         // → sleep
    await journalManager.processJournalResponse(phone, '8/10, 7 hours', 'sleep'); // → water
    await journalManager.processJournalResponse(phone, '8 glasses', 'water');      // → appetite
    await journalManager.processJournalResponse(phone, 'good', 'appetite');        // → questions
    await journalManager.processJournalResponse(phone, 'none', 'questions');       // → notes
    const final = await journalManager.processJournalResponse(phone, 'done', 'notes'); // → completed

    expect(final.completed).toBe(true);

    const row = await db.getJournalSession(phone);
    expect(row).toBeNull();

    const todays = await db.getTodaysJournal(phone);
    expect(todays).not.toBeNull();
    expect(todays.completed).toBe(1);
  });
});
