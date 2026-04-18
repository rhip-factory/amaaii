#!/usr/bin/env bash
set -euo pipefail

rm -f amaaii.db

# services/twilio.js constructs the Twilio client at module import time,
# so a missing .env crashes the boot before Express binds the port. Fall
# back to .env.example for the smoke run. 7.2 (pii-and-webhook) is
# expected to lazy-init the client and render this shim unnecessary.
[ -f .env ] || cp .env.example .env

pnpm start &
SERVER_PID=$!

cleanup() {
  pkill -P "$SERVER_PID" 2>/dev/null || true
  kill "$SERVER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

sleep 2
curl -fsS http://localhost:3000/ | grep -q "WhatsApp Pregnancy Bot Server is running!"
test -f amaaii.db   # DB was auto-recreated
echo "PASS: server boot + db auto-create"
