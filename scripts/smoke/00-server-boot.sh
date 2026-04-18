#!/usr/bin/env bash
set -euo pipefail
rm -f amaaii.db
pnpm start &
SERVER_PID=$!
sleep 2
curl -fsS http://localhost:3000/ | grep -q "WhatsApp Pregnancy Bot Server is running!"
kill $SERVER_PID
test -f amaaii.db   # DB was auto-recreated
echo "PASS: server boot + db auto-create"
