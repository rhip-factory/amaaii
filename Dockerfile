# Production image for the Amaaii server — single-process, single-origin:
# Express serves BOTH the API and the Next.js static export (apps/web/out)
# on one port, exactly as documented under "Production shape" in CLAUDE.md.
#
# Why a Dockerfile rather than Railway's Nixpacks autodetection: this repo
# needs three things Nixpacks does not reliably infer together — a pinned
# pnpm (10.33.0, via corepack), a native module that must actually compile
# (sqlite3 is in pnpm.onlyBuiltDependencies, so an unbuilt binding is a
# silent boot failure), and a TWO-step build where the web export must
# finish before the server build so `apps/web/out` exists in the image.
#
# RUNTIME LAYOUT IS LOAD-BEARING — three separate mechanisms in this
# codebase resolve paths at runtime, and all three must hold in the final
# stage (see apps/server/src/paths.ts and register-paths.ts for the full
# rationale). Do not "tidy" the COPY list without re-reading those files:
#
#   1. paths.ts#findRepoRoot walks UP from __dirname looking for the first
#      package.json. It runs from /app/dist/apps/server/src, so
#      /app/package.json MUST exist or REPO_ROOT silently resolves wrong.
#   2. register-paths.ts maps @amaaii/core and @amaaii/adapters with a
#      FIXED three-hop climb from its own location, so the compiled
#      packages must sit at /app/dist/packages/* — i.e. `dist/` has to be
#      copied whole, preserving the apps/ <-> packages/ sibling nesting.
#   3. paths.ts#WEB_OUT_DIR is REPO_ROOT/apps/web/out — the static export
#      lives in the SOURCE tree, not under dist/, so it is copied to that
#      exact path rather than anywhere inside dist/.

# ---------------------------------------------------------------------------
# Builder — full toolchain, dev dependencies, both build steps.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="/pnpm:$PATH"
RUN corepack enable

WORKDIR /app

# sqlite3 compiles from source when no prebuilt binary matches this exact
# platform/ABI. Installing the toolchain unconditionally makes the build
# deterministic instead of dependent on prebuild availability.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Manifests first so `pnpm install` is cached independently of source edits.
# apps/web is the only workspace package (see pnpm-workspace.yaml).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json

RUN pnpm install --frozen-lockfile

COPY . .

# NEXT_PUBLIC_API_ORIGIN is deliberately LEFT UNSET here. Baking an origin
# into the export makes the PWA call an absolute URL; unset, apps/web/src/lib/
# api.ts emits relative paths (fetch("/insights")) which land on whichever
# origin served the page — the same Express process. Set it only if the
# export is ever hosted separately from the API.
#
# Order matters: build:web must precede build so the server image already
# contains the export it will serve.
RUN pnpm build:web && pnpm build

# Drop dev dependencies (typescript, vitest, tsx, next, ...) from the store
# now, so the runtime stage can copy node_modules wholesale and still stay
# lean. Done here rather than in the runtime stage to avoid shipping a
# package manager step into the final image.
#
# CI=true is REQUIRED, not cosmetic: `pnpm prune` purges the modules
# directory, and pnpm refuses to do that non-interactively without it —
# failing the build with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY.
#
# The require.resolve guard turns a bad prune into a BUILD failure rather
# than a runtime one. Without it, an over-aggressive prune would produce an
# image that looks fine and then dies on its first boot with
# MODULE_NOT_FOUND — after deploy, in front of users. These five are every
# runtime dependency in package.json.
RUN CI=true pnpm prune --prod \
 && node -e "['express','sqlite3','twilio','openai','dotenv'].forEach(m=>{require.resolve(m);console.log('resolved '+m)})"

# ---------------------------------------------------------------------------
# Runtime — no compilers, no package manager, no source.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

# ca-certificates: TLS roots for the outbound Twilio / OpenAI HTTPS calls.
# gosu: used by docker-entrypoint.sh to drop from root to `node` AFTER the
# data volume has been chowned — see that script's header for why the
# ownership fix cannot happen at build time.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      gosu \
    && rm -rf /var/lib/apt/lists/*

# See the RUNTIME LAYOUT note at the top before changing any of these paths.
COPY --from=builder /app/package.json  ./package.json
COPY --from=builder /app/node_modules  ./node_modules
COPY --from=builder /app/dist          ./dist
COPY --from=builder /app/apps/web/out  ./apps/web/out

COPY --from=builder /app/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Deliberately NOT `USER node` here. The container must start as root so the
# entrypoint can take ownership of the root-owned volume mount; it drops to
# `node` via gosu immediately afterwards, before exec'ing the command below.
# Setting USER node here instead would reintroduce the SQLITE_CANTOPEN crash
# loop this entrypoint exists to fix.

# Documentation only — Railway injects the real PORT, and index.ts reads it.
EXPOSE 3000

# index.ts installs SIGTERM/SIGINT handlers that stop the job-queue poller
# and exit; exec form (no shell wrapper) plus the entrypoint's `exec gosu`
# is what lets those signals actually reach node on redeploy/shutdown.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/apps/server/src/index.js"]
