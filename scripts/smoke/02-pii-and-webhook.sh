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
# P1-B: server.js now pulls in TypeScript from packages/core via
# services/*.js shims, so both runs below use tsx, not plain node.

cleanup() {
  if [ -n "${SID:-}" ]; then
    kill "$SID" 2>/dev/null || true
    wait "$SID" 2>/dev/null || true
  fi
  rm -f "${LOG:-}" "${LOG2:-}"
}
trap cleanup EXIT

# OpenAI client is still constructed eagerly in services/amaaii.js (its lazy
# refactor is out of scope for 7.2). Pass a dummy key inline so the require
# chain succeeds at boot — no network calls happen in this smoke.
export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-smoke-dummy}"

# Port — defaults to 3000 to match the spec; override with PORT=NNNN for
# environments where 3000 is taken.
PORT="${PORT:-3000}"
URL="http://localhost:${PORT}/webhook"

# --- Run 1: enforce=true, missing signature → 403 ----------------------------
LOG=$(mktemp)
PORT="$PORT" TWILIO_SIGNATURE_ENFORCE=true NODE_ENV=production ./node_modules/.bin/tsx server.js > "$LOG" 2>&1 &
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
PORT="$PORT" TWILIO_SIGNATURE_ENFORCE=false ./node_modules/.bin/tsx server.js > "$LOG2" 2>&1 &
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
