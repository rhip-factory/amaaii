#!/usr/bin/env bash
set -euo pipefail

rm -f amaaii.db

# services/twilio.js constructs the Twilio client at module import time,
# so a missing or empty-credential .env crashes the boot before Express
# binds the port. Write a minimal .env with dummy credentials that satisfy
# Twilio's prefix/length check. 7.2 (pii-and-webhook) is expected to
# lazy-init the client and render this shim unnecessary.
if [ ! -f .env ]; then
  cat > .env <<'EOF'
TWILIO_ACCOUNT_SID=AC00000000000000000000000000000000
TWILIO_AUTH_TOKEN=smoke-dummy-token
TWILIO_WHATSAPP_NUMBER=whatsapp:+10000000000
OPENAI_API_KEY=sk-smoke-dummy
PORT=3000
EOF
fi

# Run node directly (skipping the pnpm wrapper). pnpm start spawns
# pnpm -> sh -> node; killing pnpm leaves node orphaned on port 3000.
# Going direct means $SERVER_PID IS the server process, so trap-based
# cleanup is reliable. Equivalent to `pnpm start` per package.json.
node server.js &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

sleep 2
curl -fsS http://localhost:3000/ | grep -q "WhatsApp Pregnancy Bot Server is running!"
test -f amaaii.db   # DB was auto-recreated
echo "PASS: server boot + db auto-create"
