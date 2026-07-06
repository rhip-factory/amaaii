#!/usr/bin/env bash
set -euo pipefail

# Wipes the local DB so the next demo starts from a clean slate.
# Use between investor sessions to re-run onboarding live without
# stepping on prior conversations.

cd "$(dirname "$0")/.."

if [ -f amaaii.db ]; then
  rm -f amaaii.db amaaii.db-journal
  echo "✓ amaaii.db removed (will be recreated on next server start)"
else
  echo "✓ no amaaii.db to remove"
fi

echo
echo "Next steps:"
echo "  1. Restart the server (it auto-recreates the schema):"
echo "       PORT=3030 pnpm start"
echo "  2. (PWA) clear the browser localStorage or click the ↻ button"
echo "     in the app header to start a fresh session."
