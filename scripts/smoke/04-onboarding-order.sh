#!/usr/bin/env bash
set -euo pipefail

# Smoke test for workstream 7.4 (onboarding-order).
# Drives a fresh phone number through the full onboarding ladder
# (name → age → pregnancy week → location) and asserts every column
# is populated in the users table afterwards.
#
# P3-B update: data_processing consent is now REQUIRED and gates
# profile onboarding for every un-onboarded WhatsApp user (see
# messageHandler.ts's consent-gate block) — a brand-new phone gets a
# consent prompt before the name prompt. "Hi" -> "I AGREE" is inserted
# below to grant consent (both purposes, per the WhatsApp channel
# decision) before continuing the existing name/age/week/location
# ladder, keeping this script's original assertions' intent intact.

source "$(dirname "$0")/lib/send.sh"

export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-smoke-dummy}"
PORT="${PORT:-3000}"
SMOKE_BASE_URL="http://localhost:${PORT}"

PHONE="whatsapp:+254700009904"
# Scratch DB via DB_PATH — never touch the repo's ./amaaii.db, which may
# back a live demo server.
DB_FILE=$(mktemp -u /tmp/amaaii-smoke-04-XXXXXX.db)

cleanup() {
  if [ -n "${SID:-}" ]; then
    kill "$SID" 2>/dev/null || true
    wait "$SID" 2>/dev/null || true
  fi
  rm -f "$DB_FILE"
}
trap cleanup EXIT

# Start fresh; we don't want a stale row for $PHONE.
rm -f "$DB_FILE"

# P1-E: server.js is gone — the entry point is now
# apps/server/src/index.ts, assembled from TypeScript throughout, so it must run under tsx, not plain node.
PORT="$PORT" DB_PATH="$DB_FILE" TWILIO_SIGNATURE_ENFORCE=false ./node_modules/.bin/tsx apps/server/src/index.ts > /tmp/amaaii-04.log 2>&1 &
SID=$!
wait_for_server "http://localhost:${PORT}"

# Grant consent first (P3-B) — a brand-new phone's first turn is now the
# consent prompt, not the name prompt; "I AGREE" records consent and the
# very same reply moves straight into the name prompt.
send "$PHONE" "Hi" "" >/dev/null
send "$PHONE" "I AGREE" "" >/dev/null

# Drive the onboarding ladder. Pass profile="" so the bot must elicit
# the name (D5 path) rather than pre-fill it from Twilio's ProfileName.
send "$PHONE" "Grace" "" >/dev/null
send "$PHONE" "26" "" >/dev/null
send "$PHONE" "20 weeks" "" >/dev/null
send "$PHONE" "Nairobi" "" >/dev/null
sleep 1

# Verify the users row has every column populated. Use node (sqlite3
# CLI may not be installed in dev/CI); the sqlite3 npm package is a
# direct dependency.
node -e "
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('$DB_FILE');
db.get('SELECT name, age, pregnancy_week, location FROM users WHERE phone_number = ?', ['$PHONE'], (err, row) => {
  if (err || !row) { console.error('FAIL: no users row for $PHONE', err); process.exit(1); }
  const expect = { name: 'Grace', age: 26, pregnancy_week: 20, location: 'Nairobi' };
  for (const [k, v] of Object.entries(expect)) {
    if (row[k] !== v) { console.error('FAIL:', k, '=', row[k], '(expected', v + ')'); process.exit(1); }
  }
  process.exit(0);
});
"

# Regression check: a HIGH-urgency first turn from a NEW phone should
# never be silently dropped — pre-P3-B this meant "still asks for the
# name"; now onboarding itself is gated behind consent, so the same
# intent (danger copy surfaces, AND the bot still moves the user toward
# being usable — consent first, then name) means it should carry the
# HIGH escalation copy AND the consent prompt, not a bare danger message
# with nothing else.
PHONE2="whatsapp:+254700009905"
curl -sS -X POST \
  --data-urlencode "From=$PHONE2" \
  --data-urlencode "Body=I have a severe headache" \
  "$SMOKE_BASE_URL/webhook" >/dev/null
sleep 0.5
node -e "
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('$DB_FILE');
db.get('SELECT response FROM conversations WHERE user_phone = ? ORDER BY timestamp DESC LIMIT 1', ['$PHONE2'], (err, row) => {
  if (err || !row || !/checked by a healthcare provider TODAY/i.test(row.response)) {
    console.error('FAIL: HIGH-urgency new user did not get escalation copy');
    console.error(row && row.response);
    process.exit(1);
  }
  if (!/Reply \*I AGREE\*/i.test(row.response)) {
    console.error('FAIL: HIGH-urgency new user did not get the consent prompt (P3-B)');
    console.error(row && row.response);
    process.exit(1);
  }
  process.exit(0);
});
"

echo "PASS: onboarding-order"
