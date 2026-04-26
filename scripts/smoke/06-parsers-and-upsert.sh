#!/usr/bin/env bash
set -euo pipefail

# Smoke test for workstream 7.6 (dead-code-and-parsers).
# Verifies createUser preserves prior fields across partial payloads.

export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-smoke-dummy}"
DB_FILE="$(pwd)/amaaii.db"
rm -f "$DB_FILE"

node -e "
const db = require('./services/database');
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
