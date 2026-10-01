#!/usr/bin/env bash
# Deploy the latest `main` to red-bridge. Runs ON the server as `amaaii`.
#
#   By hand:  ssh amaaii@151.115.89.219 /srv/amaaii/app/deploy/red-bridge/deploy.sh
#   From CI:  the `deploy` job in .github/workflows/ci.yml, via a key whose
#             authorized_keys entry forces this script as its only command.
#
# `main` is production (CONTRIBUTING.md): this script only ever deploys
# origin/main, and throws away any local edits in the checkout so the server
# can't drift from what's on GitHub.
set -euo pipefail

APP_DIR=/srv/amaaii/app
PORT=8002
LOCK_FILE=/srv/amaaii/.deploy.lock
export PATH="$HOME/.local/opt/node/bin:$PATH"
export CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Everything lives in a function that runs on the last line. `git reset` below
# replaces this very file, and bash reads a script as it executes it, so
# without the function a deploy that changes deploy.sh could run a mix of old
# and new lines. Bash parses the whole function before calling it.
main() {
  # A CI deploy and a manual one must not build in the same checkout at once.
  exec 9>"$LOCK_FILE"
  if ! flock -w 600 9; then
    echo "deploy: FAILED — another deploy held the lock for 10 minutes." >&2
    exit 1
  fi

  cd "$APP_DIR"

  local before after
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
  # Quiet curl: the first attempts land before the restarted app is listening.
  for _ in $(seq 1 30); do
    if curl -fs -m 2 -o /dev/null "http://127.0.0.1:$PORT/health/ready"; then
      echo "deploy: $after is live ($(curl -fs -m 2 "http://127.0.0.1:$PORT/health"))"
      exit 0
    fi
    sleep 1
  done

  echo "deploy: FAILED — /health/ready never returned 200 after restart." >&2
  echo "        journalctl -u amaaii-api -n 50 --no-pager" >&2
  exit 1
}

main "$@"
