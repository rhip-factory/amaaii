#!/usr/bin/env bash
# Deploy the latest `main` to red-bridge. Runs ON the server as `amaaii`:
#   ssh amaaii@151.115.89.219 /srv/amaaii/app/deploy/red-bridge/deploy.sh
#
# `main` is production (CONTRIBUTING.md): this script only ever deploys
# origin/main, and throws away any local edits in the checkout so the server
# can't drift from what's on GitHub.
set -euo pipefail

APP_DIR=/srv/amaaii/app
PORT=8002
export PATH="$HOME/.local/opt/node/bin:$PATH"
export CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0

cd "$APP_DIR"

before=$(git rev-parse --short HEAD)
git fetch --quiet origin main
git checkout --quiet main
git reset --quiet --hard origin/main
after=$(git rev-parse --short HEAD)
echo "deploy: $before -> $after ($(git log -1 --format=%s))"

pnpm install --frozen-lockfile --reporter=silent
pnpm build:web >/dev/null
pnpm build >/dev/null

sudo systemctl restart amaaii-api

# /health/ready pings SQLite, so a broken DB path fails the deploy here.
for _ in $(seq 1 30); do
  if curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$PORT/health/ready"; then
    echo "deploy: $after is live ($(curl -fsS -m 2 http://127.0.0.1:$PORT/health))"
    exit 0
  fi
  sleep 1
done

echo "deploy: FAILED — /health/ready never returned 200 after restart." >&2
echo "        journalctl -u amaaii-api -n 50 --no-pager" >&2
exit 1
