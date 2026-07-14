#!/usr/bin/env bash
set -euo pipefail

# Smoke test for workstream 7.2 (pii-and-webhook).
# Verifies:
#   - POST /webhook with TWILIO_SIGNATURE_ENFORCE=true and no signature → 403.
#   - POST /webhook with TWILIO_SIGNATURE_ENFORCE=false and no signature → 200.
#   - Logs from the second run contain no raw phone / ProfileName, only
#     redaction tokens.
#
# As of 7.2 the Twilio client is lazy-initialised (services/twilio.js), so
# the server boots without any .env. We deliberately do NOT self-provision
# dummy creds — that workaround was removed from 00-server-boot.sh.
#
# P1-E: server.js is gone — the entry point is now
# apps/server/src/index.ts, assembled from TypeScript throughout, so both runs below use tsx, not plain node.

# Scratch DB via DB_PATH — never touch the repo's ./amaaii.db, which may
# back a live demo server.
DB_FILE=$(mktemp -u /tmp/amaaii-smoke-02-XXXXXX.db)

cleanup() {
  if [ -n "${SID:-}" ]; then
    kill "$SID" 2>/dev/null || true
    wait "$SID" 2>/dev/null || true
  fi
  rm -f "${LOG:-}" "${LOG2:-}" "$DB_FILE"
}
trap cleanup EXIT

# P1-D: the OpenAI client (packages/adapters/src/llm.ts) is now
# lazy-initialised too, so this dummy key is no longer required just for
# the require chain to succeed at boot — kept anyway for parity with the
# other smoke scripts and in case a future path calls the LLM eagerly.
# No network calls happen in this smoke either way.
export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-smoke-dummy}"

# Port — defaults to 3000 to match the spec; override with PORT=NNNN for
# environments where 3000 is taken.
PORT="${PORT:-3000}"
URL="http://localhost:${PORT}/webhook"

# --- Run 1: enforce=true, missing signature → 403 ----------------------------
LOG=$(mktemp)
PORT="$PORT" DB_PATH="$DB_FILE" TWILIO_SIGNATURE_ENFORCE=true NODE_ENV=production ./node_modules/.bin/tsx apps/server/src/index.ts > "$LOG" 2>&1 &
SID=$!
sleep 2
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -d "From=whatsapp:+254797437715" -d "Body=hello" -d "ProfileName=Test" \
  "$URL")
kill "$SID" 2>/dev/null || true
wait "$SID" 2>/dev/null || true
SID=""
[ "$code" = "403" ] || { echo "FAIL: expected 403 without signature, got $code"; exit 1; }

# --- Run 2: enforce=false, missing signature → 200, redaction in logs --------
LOG2=$(mktemp)
PORT="$PORT" DB_PATH="$DB_FILE" TWILIO_SIGNATURE_ENFORCE=false ./node_modules/.bin/tsx apps/server/src/index.ts > "$LOG2" 2>&1 &
SID=$!
sleep 2
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -d "From=whatsapp:+254797437715" -d "Body=hello" -d "ProfileName=Test" \
  "$URL")
# Allow async log flush before we kill.
sleep 1
kill "$SID" 2>/dev/null || true
wait "$SID" 2>/dev/null || true
SID=""
[ "$code" = "200" ] || { echo "FAIL: expected 200 with enforce=false, got $code"; exit 1; }

if grep -q "+254797437715" "$LOG2" || grep -q "ProfileName=Test" "$LOG2" || grep -q '"Test"' "$LOG2"; then
  echo "FAIL: PII leaked to logs"
  grep -nE '\+254|ProfileName=Test|"Test"' "$LOG2" || true
  exit 1
fi
grep -q "\[PHONE\]\|\[REDACTED\]" "$LOG2" || { echo "FAIL: no redaction tokens in logs"; exit 1; }

echo "PASS: pii-and-webhook"
