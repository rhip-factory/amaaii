#!/bin/sh
# Fixes ownership of the mounted data volume, then drops privileges.
#
# WHY THIS EXISTS: Railway (like most container hosts) attaches a volume as a
# root-owned bind mount, and the mount happens AFTER the image is built — so a
# `chown` in the Dockerfile is pointless, it gets covered by the mount. With
# the image's `USER node` applied directly, SQLite cannot create its file on
# the volume and the server dies at boot with:
#
#   SQLITE_CANTOPEN: unable to open database file
#
# (Observed exactly this on the first Railway deploy; index.ts's
# uncaughtException handler then exits 1, so it presents as a crash loop that
# never passes the /health/ready check.)
#
# So the container starts as root, takes ownership of the mount, and only then
# becomes the unprivileged `node` user. Running the app itself as root would
# also "work" and is what a lot of deployments settle for — but this is a
# health-data service, and dropping privileges costs one exec.
set -e

DATA_DIR="$(dirname "${DB_PATH:-/data/amaaii.db}")"

if [ "$(id -u)" = "0" ]; then
  if [ -d "$DATA_DIR" ]; then
    # Small directory (one SQLite file plus its -wal/-shm siblings), so -R is
    # cheap. Non-fatal: a read-only or already-correct mount shouldn't block
    # boot — if it genuinely can't be written, the DB open below fails loudly
    # anyway, which is the clearer error to surface.
    chown -R node:node "$DATA_DIR" 2>/dev/null || true
  fi
  # `exec` so node replaces this shell as PID 1 and receives SIGTERM directly
  # — index.ts's shutdown handler stops the job-queue poller on that signal,
  # and a lingering shell parent would swallow it.
  exec gosu node "$@"
fi

exec "$@"
