#!/usr/bin/env bash
set -euo pipefail

rm -f amaaii.db

# As of 7.2 (pii-and-webhook), services/twilio.js constructs its client
# lazily, so the server boots fine without TWILIO_* env. The OpenAI client
# in services/amaaii.js is still constructed eagerly (out of scope for 7.2),
# so we pass a non-empty dummy key inline. No network calls happen.
export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-smoke-dummy}"

# Port — defaults to 3000 to match the spec; override with PORT=NNNN for
# environments where 3000 is taken.
PORT="${PORT:-3000}"

# Run node directly (skipping the pnpm wrapper). pnpm start spawns
# pnpm -> sh -> node; killing pnpm leaves node orphaned on port 3000.
# Going direct means $SERVER_PID IS the server process, so trap-based
# cleanup is reliable. Equivalent to `pnpm start` per package.json.
PORT="$PORT" node server.js &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

sleep 2
curl -fsS "http://localhost:${PORT}/" | grep -q "WhatsApp Pregnancy Bot Server is running!"
test -f amaaii.db   # DB was auto-recreated
echo "PASS: server boot + db auto-create"
