#!/usr/bin/env bash
set -euo pipefail

rm -f amaaii.db

# services/twilio.js's successor (packages/adapters/src/twilio.ts)
# constructs its client lazily, so the server boots fine without
# TWILIO_* env. The OpenAI client (packages/adapters/src/llm.ts) is also
# lazy (P1-D), but we still pass a non-empty dummy key inline for parity
# with the other smoke scripts. No network calls happen.
export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-smoke-dummy}"

# Port — defaults to 3000 to match the spec; override with PORT=NNNN for
# environments where 3000 is taken.
PORT="${PORT:-3000}"

LOG=$(mktemp)

# Run tsx directly (skipping the pnpm wrapper). pnpm start spawns
# pnpm -> sh -> tsx; killing pnpm leaves tsx orphaned on port 3000.
# Going direct means $SERVER_PID IS the server process, so trap-based
# cleanup is reliable. Equivalent to `pnpm start` per package.json.
# P1-E: server.js is gone — the entry point is now
# apps/server/src/index.ts, assembled from TypeScript throughout
# (apps/server/src + packages/core + packages/adapters), so it still
# must run under tsx, not plain node.
PORT="$PORT" ./node_modules/.bin/tsx apps/server/src/index.ts > "$LOG" 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -f "$LOG"
}
trap cleanup EXIT

sleep 2

# 1. Boot log line — smoke scripts and ops muscle memory grep for this
#    exact text, so it's asserted directly against the process's own
#    stdout rather than inferred from an HTTP response.
grep -q "Amaaii server started on port ${PORT}" "$LOG" || {
  echo "FAIL: boot log line missing"; cat "$LOG"; exit 1;
}

# 2. GET / returns HTTP 200 (PWA index.html; the plaintext banner this
#    script used to grep for hasn't been served here since the PWA
#    landed — GET / now serves public/index.html).
code=$(curl -sS -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/")
[ "$code" = "200" ] || { echo "FAIL: GET / returned $code, expected 200"; exit 1; }

# 3. One JSON endpoint responds end-to-end: POST /auth/login with a
#    dummy phone returns a bearer token in dev (no OTP — demo auth only).
token=$(curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"phone":"0712345678"}' \
  "http://localhost:${PORT}/auth/login" | node -e "
    let data = '';
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => {
      try { process.stdout.write(JSON.parse(data).token || ''); } catch (_) {}
    });
  ")
[ -n "$token" ] || { echo "FAIL: POST /auth/login did not return a token"; exit 1; }

test -f amaaii.db   # DB was auto-recreated
echo "PASS: server boot + db auto-create"
