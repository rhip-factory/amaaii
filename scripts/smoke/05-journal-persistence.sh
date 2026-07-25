#!/usr/bin/env bash
set -euo pipefail

# Smoke test for workstream 7.5 (journal-persistence).
# Pre-seeds an onboarded user, drives a journal partway, kills the
# server, restarts it, and asserts the journal_sessions row survives.
#
# P3-B update: data_processing consent is now REQUIRED before any
# feature (including journaling) runs — see messageHandler.ts's
# consent-gate block, which sits ahead of the journal-command check.
# This script pre-seeds the user directly via SQL (never through the
# webhook), so consent must be pre-seeded the same way — a conversational
# "I AGREE" round-trip isn't possible before the journal flow starts.
# Both purposes are seeded to mirror what the WhatsApp channel would
# have recorded on agreement (see handleConsentGate's channel-decision
# comment in messageHandler.ts).

source "$(dirname "$0")/lib/send.sh"

export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-smoke-dummy}"
PORT="${PORT:-3000}"
SMOKE_BASE_URL="http://localhost:${PORT}"
# Scratch DB via DB_PATH — never touch the repo's ./amaaii.db, which may
# back a live demo server.
DB_FILE=$(mktemp -u /tmp/amaaii-smoke-05-XXXXXX.db)
PHONE="whatsapp:+254700099905"

cleanup() {
  if [ -n "${SID:-}" ]; then
    kill "$SID" 2>/dev/null || true
    wait "$SID" 2>/dev/null || true
  fi
  rm -f "$DB_FILE"
}
trap cleanup EXIT

rm -f "$DB_FILE"

# Boot once just to create the schema, then pre-seed the user (avoids
# racing the schema creation against our INSERT).
# P1-E: server.js is gone — the entry point is now
# apps/server/src/index.ts, assembled from TypeScript throughout, so every boot below runs under tsx, not plain node.
PORT="$PORT" DB_PATH="$DB_FILE" TWILIO_SIGNATURE_ENFORCE=false ./node_modules/.bin/tsx apps/server/src/index.ts > /tmp/amaaii-05a.log 2>&1 &
SID=$!
sleep 2
kill "$SID"; wait "$SID" 2>/dev/null || true; SID=""

node -e "
require('tsx/cjs');
const { CONSENT_VERSION } = require('./packages/core/src/consent');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('$DB_FILE');
db.serialize(() => {
  db.run(\"INSERT OR REPLACE INTO users (phone_number, name, age, pregnancy_week, location) VALUES ('$PHONE', 'TestUser', 28, 24, 'Nairobi')\", (err) => {
    if (err) { console.error(err); process.exit(1); }
  });
  // P3-B: data_processing (required) + ai_responses consent, pre-seeded
  // directly since this script never drives the WhatsApp consent
  // round-trip conversationally — see the file header note above.
  db.run('INSERT INTO consents (user_phone, purpose, granted, version) VALUES (?, ?, 1, ?)', ['$PHONE', 'data_processing', CONSENT_VERSION], (err) => {
    if (err) { console.error(err); process.exit(1); }
  });
  db.run('INSERT INTO consents (user_phone, purpose, granted, version) VALUES (?, ?, 1, ?)', ['$PHONE', 'ai_responses', CONSENT_VERSION], (err) => {
    if (err) { console.error(err); process.exit(1); }
    process.exit(0);
  });
});
"

# --- First run: drive partway through the journal -------------------------
PORT="$PORT" DB_PATH="$DB_FILE" TWILIO_SIGNATURE_ENFORCE=false ./node_modules/.bin/tsx apps/server/src/index.ts > /tmp/amaaii-05b.log 2>&1 &
SID=$!
sleep 2

send "$PHONE" "journal" "" >/dev/null   # greeting → mood
send "$PHONE" "7" "" >/dev/null         # mood → symptoms
send "$PHONE" "none" "" >/dev/null       # symptoms → sleep
sleep 1

STAGE_BEFORE=$(node -e "
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('$DB_FILE');
db.get('SELECT current_stage FROM journal_sessions WHERE user_phone = ?', ['$PHONE'], (err, row) => {
  if (err || !row) { process.exit(1); }
  process.stdout.write(row.current_stage);
});
")
[ -n "$STAGE_BEFORE" ] || { echo "FAIL: no session row before restart"; exit 1; }

# --- Restart the server mid-flow ---------------------------------------
kill "$SID"; wait "$SID" 2>/dev/null || true
PORT="$PORT" DB_PATH="$DB_FILE" TWILIO_SIGNATURE_ENFORCE=false ./node_modules/.bin/tsx apps/server/src/index.ts > /tmp/amaaii-05c.log 2>&1 &
SID=$!
sleep 2

# Continue from the persisted stage.
send "$PHONE" "8/10, 7 hours" "" >/dev/null
sleep 1

STAGE_AFTER=$(node -e "
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('$DB_FILE');
db.get('SELECT current_stage FROM journal_sessions WHERE user_phone = ?', ['$PHONE'], (err, row) => {
  if (err || !row) { process.exit(1); }
  process.stdout.write(row.current_stage);
});
")
[ -n "$STAGE_AFTER" ] || { echo "FAIL: no session row after restart"; exit 1; }

# Stage must have advanced from where we were before the restart.
if [ "$STAGE_BEFORE" = "$STAGE_AFTER" ]; then
  echo "FAIL: stage did not advance (stayed at $STAGE_BEFORE) — session likely lost"
  exit 1
fi

echo "PASS: journal session survives restart (before=$STAGE_BEFORE after=$STAGE_AFTER)"
