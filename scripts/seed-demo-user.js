#!/usr/bin/env node
/* eslint-disable no-console */
//
// Seed a "demo" user with 2 months of realistic journal history.
// Use this to populate the History page + Insights card before an
// investor demo so the trend story is rich, not empty.
//
// Phone:   whatsapp:+254700000888  (Amina, 32, Nairobi)
// Span:    60 days, 2 check-ins/day = 120 rows, with a deliberate
//          story arc (good → rough patch → recovery → strong).
// Medical history: pre-populated, structured.
//
// Run:
//   DB_PATH=/home/k_nurf/amaai/amaaii.db node scripts/seed-demo-user.js
//
// To wipe and re-seed:
//   DB_PATH=/home/k_nurf/amaai/amaaii.db node scripts/seed-demo-user.js --reset

const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'amaaii.db');
const RESET = process.argv.includes('--reset');

// Phone/name are overridable so the same story arc can be seeded onto a
// SECOND, real number. This matters for any deployment running with
// NODE_ENV=production and real Twilio credentials: OTP sign-in there does a
// genuine WhatsApp delivery (the inline `devCode` fallback is disabled
// outside dev), so the default +254700000888 — a dummy number that has never
// joined the Twilio sandbox — can receive no code and therefore cannot be
// signed into. Seeding a sandbox-joined number as well gives the demo an
// account that is actually reachable.
//
//   SEED_PHONE='whatsapp:+2547XXXXXXXX' SEED_NAME='Amina' \
//     DB_PATH=... node scripts/seed-demo-user.js
const PHONE = process.env.SEED_PHONE || 'whatsapp:+254700000888';
const NAME = process.env.SEED_NAME || 'Amina';
const AGE = 32;
const LOCATION = 'Nairobi';
// Span: 60 days. Story arc start week = 14, end week ≈ 22.5.
const TOTAL_DAYS = 60;

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this.lastID);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

// Story-arc generator. Returns the synthetic state for day N (0..59).
function dayState(dayIndex) {
  // 0..14   : adjusting (good baseline)
  // 15..24  : rough patch — mood ↓, sleep ↓, headache cluster
  // 25..40  : recovery
  // 41..59  : strong stretch (≥ week 20 → baby movement step active)
  let phase;
  if (dayIndex < 15) phase = 'baseline';
  else if (dayIndex < 25) phase = 'rough';
  else if (dayIndex < 41) phase = 'recovery';
  else phase = 'strong';

  const week = 14 + Math.floor(dayIndex / 7);

  // helpers
  const j = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
  const f = (lo, hi) => +(lo + Math.random() * (hi - lo)).toFixed(1);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  let mood, sleepHours, sleepQuality, water, appetite, symptoms = [];
  let redFlag = null;

  switch (phase) {
    case 'baseline':
      mood = j(6, 8);
      sleepHours = f(7, 8.5);
      sleepQuality = j(6, 8);
      water = j(6, 9);
      appetite = pick(['good', 'good', 'moderate']);
      if (Math.random() < 0.35) symptoms.push('nausea');
      if (Math.random() < 0.15) symptoms.push('fatigue');
      break;
    case 'rough':
      mood = j(3, 5);
      sleepHours = f(3.5, 5.5);
      sleepQuality = j(2, 4);
      water = j(3, 6);
      appetite = pick(['poor', 'poor', 'moderate']);
      // Headache cluster — fires most days of this phase
      if (Math.random() < 0.8) symptoms.push('headache');
      if (Math.random() < 0.6) symptoms.push('fatigue');
      if (Math.random() < 0.4) symptoms.push('nausea');
      if (Math.random() < 0.25) symptoms.push('back_pain');
      break;
    case 'recovery':
      mood = j(5, 7);
      sleepHours = f(6, 7.5);
      sleepQuality = j(5, 7);
      water = j(5, 8);
      appetite = pick(['moderate', 'good', 'good']);
      if (Math.random() < 0.3) symptoms.push('headache');
      if (Math.random() < 0.25) symptoms.push('fatigue');
      break;
    case 'strong':
      mood = j(7, 9);
      sleepHours = f(7, 8.5);
      sleepQuality = j(7, 9);
      water = j(7, 10);
      appetite = pick(['good', 'good', 'good']);
      if (Math.random() < 0.15) symptoms.push('back_pain');
      break;
  }

  // De-dupe symptoms.
  symptoms = Array.from(new Set(symptoms));

  return { phase, week, mood, sleepHours, sleepQuality, water, appetite, symptoms, redFlag };
}

function checkinTimes(dayIndex) {
  // Compute the actual ISO timestamps for the morning + evening
  // check-ins on day (today - dayIndex). Day 0 = today, increasing
  // = going back in time.
  const date = new Date();
  date.setDate(date.getDate() - (TOTAL_DAYS - 1 - dayIndex));
  const morning = new Date(date);
  morning.setHours(8, 30 + Math.floor(Math.random() * 60), 0, 0);
  const morningEnd = new Date(morning.getTime() + (90 + Math.floor(Math.random() * 240)) * 1000);
  const evening = new Date(date);
  evening.setHours(20, 30 + Math.floor(Math.random() * 60), 0, 0);
  const eveningEnd = new Date(evening.getTime() + (90 + Math.floor(Math.random() * 240)) * 1000);
  return {
    date: date.toISOString().split('T')[0],
    morning: morning.toISOString(),
    morningEnd: morningEnd.toISOString(),
    evening: evening.toISOString(),
    eveningEnd: eveningEnd.toISOString(),
  };
}

async function wipe(db) {
  console.log('Wiping any existing data for', PHONE, '...');
  await run(db, 'DELETE FROM conversations WHERE user_phone = ?', [PHONE]);
  await run(db, 'DELETE FROM journals WHERE user_phone = ?', [PHONE]);
  await run(db, 'DELETE FROM journal_sessions WHERE user_phone = ?', [PHONE]);
  await run(db, 'DELETE FROM symptoms WHERE user_phone = ?', [PHONE]);
  await run(db, 'DELETE FROM anc_visits WHERE user_phone = ?', [PHONE]);
  await run(db, 'DELETE FROM medical_history WHERE user_phone = ?', [PHONE]);
  await run(db, 'DELETE FROM users WHERE phone_number = ?', [PHONE]);
}

async function seedUser(db) {
  const today = new Date();
  // Set pregnancy_week to current week of the story arc (end-of-arc).
  const week = 14 + Math.floor((TOTAL_DAYS - 1) / 7);
  // EDD = today + (280 - week*7) days
  const edd = new Date(today);
  edd.setDate(edd.getDate() + (280 - week * 7));
  const eddStr = edd.toISOString().split('T')[0];

  console.log(`Creating user: ${NAME}, age ${AGE}, week ${week}, ${LOCATION}, EDD ${eddStr}`);
  await run(
    db,
    `INSERT INTO users (phone_number, name, age, pregnancy_week, edd, location, language)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [PHONE, NAME, AGE, week, eddStr, LOCATION, 'en']
  );
}

async function seedMedicalHistory(db) {
  const rawText = `I'm 32 and this is my third pregnancy. My first child was born by C-section at 38 weeks because labour stopped progressing — no complications afterwards. My second pregnancy ended in a miscarriage at 11 weeks, two years ago. I have mild iron-deficiency anaemia and I'm currently on ferrous sulphate and folic acid. No allergies. I don't smoke or drink. I'm planning to deliver at Aga Khan Hospital, same as my first.`;
  const extracted = {
    gravida: 3,
    parity: 1,
    miscarriages: 1,
    previous_deliveries: [
      { mode: 'cesarean', complications: 'failure to progress', year: null },
    ],
    chronic_conditions: ['iron-deficiency anaemia'],
    past_complications: [],
    medications: ['ferrous sulphate', 'folic acid'],
    allergies: [],
    lifestyle: { smoking: false, alcohol: false },
  };
  await run(
    db,
    `INSERT INTO medical_history (user_phone, raw_text, extracted_json, updated_at)
     VALUES (?, ?, ?, datetime('now'))`,
    [PHONE, rawText, JSON.stringify(extracted)]
  );
  console.log('  Medical history seeded.');
}

async function seedJournals(db) {
  console.log(`Seeding ${TOTAL_DAYS * 2} journal rows (${TOTAL_DAYS} days × 2 check-ins)...`);
  let inserted = 0;
  for (let i = 0; i < TOTAL_DAYS; i++) {
    const t = checkinTimes(i);
    const stateAM = dayState(i);
    const stateAM_data = {
      ...stateAM,
      water: Math.floor(stateAM.water / 2),
      sleepHours: stateAM.sleepHours,
      sleepQuality: stateAM.sleepQuality,
    };
    await insertJournal(db, t.date, t.morning, t.morningEnd, stateAM_data);
    inserted++;

    // Evening check-in: same mood ± 1, water builds up, sleep blank
    // (only in morning report).
    const eveningState = {
      ...stateAM,
      mood: Math.max(1, Math.min(10, stateAM.mood + (Math.random() < 0.5 ? -1 : 1))),
      sleepHours: null,
      sleepQuality: null,
      water: stateAM.water,
    };
    await insertJournal(db, t.date, t.evening, t.eveningEnd, eveningState);
    inserted++;
  }
  console.log(`  ${inserted} journal rows inserted.`);
}

async function insertJournal(db, date, startedAt, completedAt, s) {
  const symptomsJson = s.symptoms.length > 0 ? JSON.stringify(s.symptoms) : 'none';
  const redFlags = s.redFlag ? JSON.stringify([s.redFlag]) : null;
  await run(
    db,
    `INSERT INTO journals (
        user_phone, date, journal_stage, physical_symptoms,
        emotional_state, mood_description, sleep_quality, sleep_hours,
        appetite, water_intake, baby_movement_count,
        red_flags_detected, completed, started_at, completed_at, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      PHONE,
      date,
      'completed',
      symptomsJson,
      s.mood,
      null,
      s.sleepQuality,
      s.sleepHours,
      s.appetite,
      s.water,
      // Baby movement: only from week ≥ 20 (rough day 42 onwards in our arc)
      s.week >= 20 ? Math.max(8, 12 + Math.floor(Math.random() * 8)) : null,
      redFlags,
      1,
      startedAt,
      completedAt,
      startedAt,
    ]
  );
}

async function main() {
  const db = new sqlite3.Database(DB_PATH);
  try {
    if (RESET) {
      await wipe(db);
    } else {
      const existing = await get(db, 'SELECT phone_number FROM users WHERE phone_number = ?', [PHONE]);
      if (existing) {
        console.error(`User ${PHONE} already exists. Re-run with --reset to wipe and re-seed.`);
        process.exit(1);
      }
    }
    await seedUser(db);
    await seedMedicalHistory(db);
    await seedJournals(db);

    // Quick stats
    const journals = await get(db, 'SELECT COUNT(*) AS n FROM journals WHERE user_phone = ?', [PHONE]);
    const completed = await get(db, 'SELECT COUNT(*) AS n FROM journals WHERE user_phone = ? AND completed = 1', [PHONE]);
    const flagged = await get(db, "SELECT COUNT(*) AS n FROM journals WHERE user_phone = ? AND red_flags_detected IS NOT NULL", [PHONE]);
    console.log('\n✓ Demo user ready.');
    console.log(`  Phone:           ${PHONE}`);
    console.log(`  Login as:        ${PHONE.replace('whatsapp:', '')}`);
    console.log(`  Journal rows:    ${journals.n} (${completed.n} completed)`);
    console.log(`  Red-flag days:   ${flagged.n}`);
    console.log(`  Span:            last ${TOTAL_DAYS} days, 2 check-ins/day`);
    console.log(`  Story arc:       baseline → rough patch → recovery → strong stretch`);
    console.log('\nLogin to the PWA with that phone to see History + Insights cards populated.');
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
