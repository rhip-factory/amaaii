#!/usr/bin/env node
/* eslint-disable no-console */
//
// Seeds the PROVIDER side of a demo database: one facility, two staff
// logins, and enrollments for mothers who already exist in the same DB
// (seed those first with scripts/seed-demo-user.js).
//
// Goes through the real database facade rather than raw SQL so the seeded
// rows are exactly what the running app would have written — password
// hashing included (scrypt via providerAuth.hashPassword; never plaintext).
//
// Run:
//   DB_PATH=/path/to/demo.db node scripts/seed-provider-demo.js
//   DB_PATH=... PROVIDER_PASSWORD='...' node scripts/seed-provider-demo.js
//
// The password is printed on completion — these are demo accounts over
// fictional data, and whoever runs the demo needs to be able to log in.
// Do NOT reuse this script's output for anything holding real patient data.

require('tsx/cjs');

const db = require('../apps/server/src/database');
// Hashing happens HERE, not in the repository layer: CreateProviderInput
// takes an already-hashed `passwordHash`, so the adapter never sees or
// stores a plaintext password (see repositories.ts's note on ProviderRow).
const { hashPassword } = require('../apps/server/src/providerAuth');

const PASSWORD = process.env.PROVIDER_PASSWORD || 'Amaaii#Demo2026';

const FACILITY = {
  name: "Nairobi Women's Hospital",
  code: 'NWH-001',
  county: 'Nairobi',
};

const PROVIDERS = [
  { email: 'midwife@amaaii.health', name: 'Sr. Wanjiku Kamau', role: 'midwife', license_number: 'NCK-45219' },
  { email: 'doctor@amaaii.health', name: 'Dr. Achieng Otieno', role: 'doctor', license_number: 'KMPDC-11837' },
];

// Mothers to enrol. These must already exist as users in the same DB.
// Mary is enrolled but has deliberately NOT granted provider_access consent —
// that is the demo's consent-gate beat, not an oversight. Leave her here.
const MOTHERS = [
  'whatsapp:+254700000888', // Amina — consented
  'whatsapp:+254700000889', // Grace — consented
  'whatsapp:+254700000890', // Mary  — NOT consented to provider access
];

async function main() {
  await db.initializeDatabase();

  let facility = await db.getFacilityByCode(FACILITY.code);
  if (facility) {
    console.log(`Facility ${FACILITY.code} already exists (id ${facility.id})`);
  } else {
    facility = await db.createFacility(FACILITY);
    console.log(`Created facility: ${facility.name} [${facility.code}] id=${facility.id}`);
  }

  const created = [];
  for (const p of PROVIDERS) {
    const existing = await db.getProviderByEmail(p.email);
    if (existing) {
      console.log(`  provider ${p.email} already exists (id ${existing.id})`);
      created.push(existing);
      continue;
    }
    const provider = await db.createProvider({
      facilityId: facility.id,
      email: p.email,
      name: p.name,
      role: p.role,
      licenseNumber: p.license_number,
      passwordHash: hashPassword(PASSWORD),
    });
    console.log(`  created provider ${p.email} (${p.role}) id=${provider.id}`);
    created.push(provider);
  }

  const enroller = created[0] ? created[0].id : null;
  for (const phone of MOTHERS) {
    try {
      await db.enrollPatient({
        facilityId: facility.id,
        userPhone: phone,
        enrolledBy: enroller,
      });
      console.log(`  enrolled ${phone}`);
    } catch (err) {
      console.log(`  enroll ${phone}: ${err && err.message ? err.message : err}`);
    }
  }

  const rows = await db.getEnrollmentsByFacility(facility.id);
  console.log(`\n✓ Provider demo ready.`);
  console.log(`  Facility:    ${facility.name} [${facility.code}]`);
  console.log(`  Enrollments: ${rows.length}`);
  console.log(`  Logins:      ${PROVIDERS.map((p) => p.email).join(', ')}`);
  console.log(`  Password:    ${PASSWORD}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Provider seed failed:', err);
  process.exit(1);
});
