#!/usr/bin/env node
/* eslint-disable no-console */
//
// Seeds a realistic PANEL for the provider portal demo: 14 mothers with
// deliberately varied clinical situations, so the triage queue and the cohort
// view actually demonstrate something.
//
// Why not just reuse scripts/seed-demo-user.js: that script generates one
// mother on a fixed 60-day story arc with no danger signs, no quiet periods,
// and no ANC variation. A triage queue over rows that are all identical sorts
// nothing, and a cohort of 3 is suppressed by the small-cell rule (correctly).
// This script exists to produce the spread those two features are about.
//
// Everything here is FICTIONAL. Phone numbers stay inside the documented
// +254700000xxx dummy range (see README's Notes).
//
// Run:
//   DB_PATH=/path/to/demo.db node scripts/seed-cohort-demo.js
//
// Then seed the facility/provider/enrollment side:
//   DB_PATH=... node scripts/seed-provider-demo.js

const sqlite3 = require('sqlite3').verbose();

require('tsx/cjs');
const { CONSENT_VERSION } = require('../packages/core/src/consent');

const DB_PATH = process.env.DB_PATH;
if (!DB_PATH) {
  console.error('DB_PATH is required.');
  process.exit(1);
}

const ALL = ['data_processing', 'ai_responses', 'provider_access'];
const NO_PROVIDER = ['data_processing', 'ai_responses'];

// quietDays  — days since her last check-in (0 = checked in today). Drives the
//              triage "gone quiet" signal, which is both a safety and a churn
//              indicator.
// escalations — seeded danger_escalation audit rows, which is where the
//              escalation feed reads from. critical/high only, matching
//              auditDangerEscalation's own constraint.
// ancVisits  — contacts attended so far; Kenya MoH targets 8 across pregnancy,
//              so a low count at a high week is "behind schedule".
const MOTHERS = [
  { name: 'Amina',   phone: '+254700000888', week: 22, consent: ALL,         quietDays: 0, ancVisits: 4, escalations: [] },
  { name: 'Grace',   phone: '+254700000889', week: 34, consent: ALL,         quietDays: 0, ancVisits: 6, escalations: [] },
  { name: 'Mary',    phone: '+254700000890', week: 22, consent: NO_PROVIDER, quietDays: 1, ancVisits: 4, escalations: [] },
  { name: 'Faith',   phone: '+254700000891', week: 12, consent: NO_PROVIDER, quietDays: 2, ancVisits: 2, escalations: [] },
  // The two the triage queue must surface first.
  { name: 'Halima',  phone: '+254700000892', week: 30, consent: ALL, quietDays: 0, ancVisits: 5, escalations: [{ urgency: 'critical', daysAgo: 1 }] },
  { name: 'Njeri',   phone: '+254700000893', week: 27, consent: ALL, quietDays: 1, ancVisits: 4, escalations: [{ urgency: 'high', daysAgo: 3 }] },
  // Gone quiet — no danger sign, but nobody has heard from them.
  { name: 'Wanjiru', phone: '+254700000894', week: 19, consent: ALL, quietDays: 9, ancVisits: 3, escalations: [] },
  { name: 'Akinyi',  phone: '+254700000895', week: 36, consent: ALL, quietDays: 4, ancVisits: 6, escalations: [] },
  // Behind on ANC contacts for how far along she is.
  { name: 'Nafula',  phone: '+254700000896', week: 15, consent: ALL, quietDays: 2, ancVisits: 0, escalations: [] },
  { name: 'Atieno',  phone: '+254700000897', week: 39, consent: ALL, quietDays: 1, ancVisits: 7, escalations: [] },
  // Routine — the majority, so the queue has a clear "nothing needed" tail.
  { name: 'Cherono', phone: '+254700000898', week: 8,  consent: ALL, quietDays: 0, ancVisits: 1, escalations: [] },
  { name: 'Chebet',  phone: '+254700000899', week: 24, consent: ALL, quietDays: 1, ancVisits: 4, escalations: [] },
  { name: 'Muthoni', phone: '+254700000900', week: 6,  consent: ALL, quietDays: 2, ancVisits: 1, escalations: [] },
  { name: 'Zawadi',  phone: '+254700000901', week: 33, consent: ALL, quietDays: 0, ancVisits: 5, escalations: [] },
];

const db = new sqlite3.Database(DB_PATH);
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));

const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
const iso = (d) => d.toISOString();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const sqlTs = (d) => iso(d).slice(0, 19).replace('T', ' ');
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const between = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

async function seedMother(m) {
  const phone = `whatsapp:${m.phone}`;
  // Idempotent: wipe just this fictional mother, then rebuild her.
  for (const t of ['journals', 'consents', 'conversations', 'symptoms', 'medical_history']) {
    await run(`DELETE FROM ${t} WHERE user_phone = ?`, [phone]);
  }
  await run(`DELETE FROM audit_log WHERE resource_owner = ?`, [phone]);
  await run('DELETE FROM users WHERE phone_number = ?', [phone]);

  const edd = daysAgo(-(280 - m.week * 7));
  await run(
    `INSERT INTO users (phone_number, name, age, pregnancy_week, edd, location, language, anc_visits)
     VALUES (?, ?, ?, ?, ?, ?, 'en', ?)`,
    [phone, m.name, between(21, 36), m.week, ymd(edd), pick(['Nairobi', 'Kiambu', 'Machakos', 'Kajiado']), m.ancVisits]
  );

  for (const purpose of m.consent) {
    await run('INSERT INTO consents (user_phone, purpose, granted, version) VALUES (?, ?, 1, ?)', [phone, purpose, CONSENT_VERSION]);
  }

  // 30 days of history, stopping `quietDays` ago so "last check-in" is
  // controllable — that gap is exactly what the triage quiet signal reads.
  let entries = 0;
  for (let d = 30; d >= m.quietDays; d--) {
    if (d > 0 && Math.random() < 0.25) continue; // realistic gaps
    const day = daysAgo(d);
    const at = new Date(day); at.setHours(between(7, 20), between(0, 59), 0, 0);
    const flagged = m.escalations.some((e) => e.daysAgo === d);
    const mood = flagged ? between(2, 4) : between(5, 9);
    const symptoms = flagged ? JSON.stringify(['bleeding']) : (Math.random() < 0.4 ? JSON.stringify([pick(['nausea', 'fatigue', 'back_pain', 'heartburn'])]) : 'none');
    await run(
      `INSERT INTO journals (user_phone, date, journal_stage, physical_symptoms, emotional_state,
         sleep_quality, sleep_hours, appetite, water_intake, baby_movement_count,
         red_flags_detected, completed, started_at, completed_at, timestamp)
       VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [phone, ymd(day), symptoms, mood, between(4, 9), +(between(50, 90) / 10).toFixed(1),
       pick(['good', 'moderate', 'poor']), between(4, 10),
       m.week >= 20 ? between(8, 20) : null,
       flagged ? JSON.stringify(['bleeding']) : null,
       iso(at), iso(at), iso(at)]
    );
    entries++;
  }

  // Escalation audit rows — the escalation feed's actual source. Inserted
  // directly rather than via auditDangerEscalation() so created_at can be
  // backdated; the row shape matches that function exactly.
  for (const e of m.escalations) {
    const at = new Date(daysAgo(e.daysAgo)); at.setHours(between(8, 18), between(0, 59), 0, 0);
    await run(
      `INSERT INTO audit_log (actor, action, resource, resource_owner, metadata, created_at)
       VALUES ('system', 'danger_escalation', 'conversation', ?, ?, ?)`,
      [phone, JSON.stringify({ urgencyLevel: e.urgency }), sqlTs(at)]
    );
  }

  return { name: m.name, entries, consented: m.consent.includes('provider_access'), escalations: m.escalations.length };
}

async function main() {
  const results = [];
  for (const m of MOTHERS) results.push(await seedMother(m));

  const consented = results.filter((r) => r.consented).length;
  console.log('\n✓ Cohort seeded.');
  for (const r of results) {
    console.log(`  ${r.name.padEnd(9)} entries=${String(r.entries).padStart(2)} ` +
      `provider_access=${r.consented ? 'yes' : 'NO '} escalations=${r.escalations}`);
  }
  const totals = await all('SELECT COUNT(*) n FROM users');
  console.log(`\n  users: ${totals[0].n} | consented to provider access: ${consented}`);
  console.log(`  cohort size ${consented} ${consented >= 5 ? '>= 5, analytics will report' : '< 5, analytics will suppress'}`);
  process.exit(0);
}

main().catch((e) => { console.error('Cohort seed failed:', e); process.exit(1); });
