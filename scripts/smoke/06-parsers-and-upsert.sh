#!/usr/bin/env bash
set -euo pipefail

# Smoke test for workstream 7.6 (dead-code-and-parsers).
# Verifies createUser preserves prior fields across partial payloads.

export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-smoke-dummy}"
DB_FILE="$(pwd)/amaaii.db"
rm -f "$DB_FILE"

node -e "
// P1-E: services/database.js is gone; the module now lives at
// apps/server/src/database.ts. Plain 'node -e' has no TypeScript loader
// by default, so we register tsx's require hook first — same mechanism
// 'tsx server.js' used under the hood before this migration.
require('tsx/cjs');
const db = require('./apps/server/src/database');
(async () => {
  await db.initializeDatabase();
  const phone = 'whatsapp:+254700000098';
  await db.createUser(phone, { name: 'Alpha', age: 30 });
  await db.createUser(phone, { location: 'Nairobi' });   // partial update
  const u = await db.getUser(phone);
  if (u.name !== 'Alpha' || u.age !== 30 || u.location !== 'Nairobi') {
    console.error('FAIL upsert:', u); process.exit(1);
  }
  console.log('PASS: parsers-and-upsert');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
"
