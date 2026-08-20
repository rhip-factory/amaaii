# Changelog

All notable changes to Amaaii are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased]

### Security

- **Closed an authentication bypass in `POST /auth/login`.** The pre-OTP
  demo endpoint issued a full 30-day bearer token from a phone number
  alone — no code, no secret. Harmless locally (a dozen test files use it
  as a token factory) but a complete account takeover on a publicly
  reachable deployment: phone numbers are public, so anyone could mint a
  token for any mother's number and then read, export, or erase her health
  data through `/me`, `/history`, `/insights`, `/me/export`, and
  `DELETE /me/account`, bypassing both the OTP challenge and the entire
  Phase 3 data-rights layer. Confirmed live against the first hosted
  deploy before being closed. Now returns `404` when
  `NODE_ENV === 'production'` (404 rather than 403 so a deployment doesn't
  advertise the endpoint); unchanged outside production. Pinned by
  `tests/legacyLoginGate.test.ts`.
- **`AUTH_SECRET` must now be set for any real deployment.** It falls back
  to `'amaaii-dev-secret-change-me'`, a value published in this public
  repo, and keys both the bearer-token HMAC and the OTP code hashes — so
  an unset value on a public URL lets anyone forge a token for any phone
  number. Documented as mandatory in README's Deployment section and set
  on the hosted deploy.

### Added

- **Hosted deployment (Railway).** `Dockerfile`, `.dockerignore`,
  `railway.json`, and `docker-entrypoint.sh` for a single-process,
  single-origin container (Express serves the API and the Next.js static
  export on one port), with a persistent volume at `/data` backing SQLite
  and `GET /health/ready` wired as the deploy healthcheck so a missing or
  unwritable volume fails the deploy instead of quietly starting an
  amnesiac server. `docker-entrypoint.sh` chowns the root-owned volume
  mount and drops privileges via `gosu` — without it the container
  crash-loops on `SQLITE_CANTOPEN`. `PUBLIC_BASE_URL` is now set in the
  hosted environment, so WhatsApp consent messages link to the real
  `/privacy` page instead of falling back to generic copy (closes a
  Phase 3 deferred item).
- `scripts/seed-demo-user.js` accepts `SEED_PHONE` / `SEED_NAME`, so the
  demo story arc can be seeded onto a real, sandbox-joined number. In
  production the default `+254700000888` cannot be signed into: OTP
  sign-in does a genuine WhatsApp delivery there and the inline `devCode`
  fallback is disabled outside dev.

- **Phase 4 — pilot hardening** (`8403560`, `c2b4c3e`, and this commit —
  P4-A through P4-C):
  - **Durable SQLite job queue** (`8403560`): a `jobs` table
    (`packages/adapters/src/sqlite/jobRepository.ts`) with pure
    backoff/retry/due-ness decisions in `packages/core/src/jobs.ts`
    (1m/5m/30m backoff schedule, capped at 5 attempts) and a poller
    (`apps/server/src/jobWorker.ts`, default `JOB_POLL_MS=15000`) with a
    handler registry, atomic `claimDueJobs`, and `reclaimStuck` recovery
    for a worker that crashed mid-job. The 1-hour critical/high check-in
    follow-up — previously an in-process `setTimeout(..., 3600000)`, lost
    on restart — is now a durable `checkin_followup` job, deduped per
    phone/hour-bucket, delivered at-least-once. `scripts/smoke/lib/send.sh`
    gained `wait_for_server` (polls instead of a fixed sleep) after boot
    time crept past 2s under load once the worker started registering at
    boot.
  - **Observability** (`c2b4c3e`): request logging + `X-Request-Id`
    correlation (`middleware/requestObservability.ts`); a dependency-free
    Prometheus-text `GET /metrics` (`apps/server/src/metrics.ts` —
    `http_requests_total`, `http_request_duration_ms`,
    `danger_escalations_total`, `llm_calls_total`/`llm_failures_total`,
    `otp_requests_total`/`otp_verifications_total`, `jobs_total`, process
    uptime/memory), gated by `METRICS_TOKEN` (open in non-production when
    unset, `404` in production); `GET /health` (liveness) and
    `GET /health/ready` (readiness — SQLite ping, `503` on failure); a
    global Express error-handling backstop
    (`apps/server/src/errorHandler.ts`) that never leaks a stack trace or
    message to the client; process-level `unhandledRejection` (log, keep
    running) and `uncaughtException` (log, alert, exit so the host
    restarts a clean process — safe because of the durable job queue)
    handlers in `index.ts`; and a minimal alerting seam
    (`apps/server/src/alerts.ts#notifyCritical` — always logs ERROR-level,
    optionally POSTs a small PII-free JSON payload to `ALERT_WEBHOOK_URL`),
    wired to the error handler and to the job worker via
    `JOBS_FAILED_ALERT_THRESHOLD`. Every metrics label is a closed
    vocabulary (route templates, status classes, urgency/job-status
    strings) — never a phone number, name, or message content.
  - **DPA erasure gap closed**: `jobs.user_phone` (populated at enqueue
    time) is now in the erasure cascade (`erasure.ts`'s
    `ERASURE_TARGETS`) — `DELETE /me/account` clears a deleted user's
    pending/failed job rows, closing a gap where P4-A's job queue landed
    without this hook.
  - New table: `jobs`. New env vars: `JOB_POLL_MS`, `METRICS_TOKEN`,
    `ALERT_WEBHOOK_URL`, `JOBS_FAILED_ALERT_THRESHOLD`.
  - Docs (this commit, P4-C): CLAUDE.md, README, and this changelog
    brought current for Phase 4 — including correcting an Architecture
    note that had described the check-in follow-up as "in-process and
    lost on restart," which stopped being true once P4-A landed.

- **Phase 3 — Kenya DPA compliance** (`9926703`, `db5d189`, `33e5c88`,
  `1fef028`, and this commit — P3-A through P3-E):
  - **Two-tier consent** (`packages/core/src/consent.ts`): `data_processing`
    (required — the app has no lawful basis to operate for a user without
    it) and `ai_responses` (optional — gates only the LLM chokepoint;
    declining it leaves journaling and danger detection unaffected), backed
    by an append-only `consents` ledger and a `CONSENT_VERSION` constant to
    force re-consent on a future policy change. Enforced inside the shared
    `processMessage` brain, not just at the HTTP edge: WhatsApp gets a
    stateless conversational request/reprompt (replying `I AGREE`/
    `NAKUBALI` grants both purposes together, since the WhatsApp bot is
    itself an AI chat); the web PWA's `POST /chat` returns
    `{ consentRequired: true }` instead, and the two purposes are granted
    independently via the `/consent` screen and a Profile toggle.
    **Danger signs always escalate regardless of consent state** — checked
    before consent is even loaded, the Kenya DPA vital-interests basis.
  - **Audit logging** (`apps/server/src/audit.ts`, append-only `audit_log`
    table): every profile/journal/insights/medical-history/consent
    read-or-write is recorded (actor, action, resource, metadata,
    timestamp); `GET /me/activity` lets a user see their own "who's
    accessed your data" log. Deliberately retained through account erasure
    (see below) rather than cleared with everything else.
  - **Data-subject rights**: `GET /me/export` downloads a single JSON
    document with everything Amaaii holds about a user (profile, consents,
    conversations, journals, symptoms, ANC visits, medical history, audit
    log); `DELETE /me/account` is a transactional hard-delete cascade
    across every user-owned table (audit log excepted), idempotent by
    construction.
  - **PWA UI**: a `/consent` gate on first login, a public `/privacy`
    notice (including a cross-border disclosure that AI replies are
    processed by OpenAI in the US — the notice's legal wording has not yet
    been reviewed by counsel, flagged in an HTML comment in the page
    source), and a Profile "Privacy & data" section (consent status + AI
    toggle, activity list, data export, delete-with-type-to-confirm).
  - New endpoints: `GET/POST /me/consent`, `POST /me/consent/revoke`,
    `GET /me/activity`, `GET /me/export`, `DELETE /me/account`.
  - New tables: `consents`, `audit_log`.

### Changed

- **Express now serves the Next.js PWA** (`apps/web/out`) at `/` — single
  process, single origin for both the app and the API. When `out/` isn't
  built (dev/CI/smoke boots that never ran `pnpm build:web`), `GET /` still
  returns 200 with a plaintext notice instead of pretending the app is
  there. Hashed `_next/static/*` assets get a long, immutable cache;
  `sw.js` gets `Cache-Control: no-cache` so browsers reliably pick up
  service-worker updates. A GET fallback maps extensionless routes
  (`/login`, `/home`, ...) to the export's flat `<route>.html` files,
  handling both `/route` and `/route/`; unmatched paths get the export's
  `404.html` with a real 404 status.
- **`GET /insights` now discriminates page vs. API** the same way
  `next dev`'s rewrites already did: it serves the JSON API when the
  request carries `X-Amaaii-Api: 1` or an `Authorization` header, and
  falls through to the exported `insights.html` page otherwise. Previously
  every `GET /insights` required a bearer token regardless of headers,
  which meant a plain browser navigation from Express (as opposed to
  `next dev`) got a 401 instead of the page.
- The older vanilla-JS PWA under `public/` is **retired** and removed from
  the working tree (still recoverable from git history).

### Fixed

- **Path traversal in the new static-export fallback**, caught in review
  before merge: the extensionless-route → HTML mapping built an absolute
  filesystem path by joining `apps/web/out` with a segment taken from
  `req.path` and handed it to `sendFile` with no boundary check — a raw
  HTTP client (not a browser, which resolves `..` before sending) could
  send a literal `..` and read `.html` files outside `out/`. Fixed by
  passing a relative filename + `{ root: webOutDir }` to `res.sendFile`,
  which delegates the boundary enforcement to Express's `send` dependency;
  regression-tested with real sockets (supertest normalizes `..`
  client-side, so it can't reach the vulnerable path itself).
- **Post-delete read hardening (P3-E)**: a bearer token issued before
  `DELETE /me/account` still verified fine afterwards (tokens are
  stateless HMACs, not session records), and `GET /me` / `GET /me/export`
  would silently recreate a blank profile row via `getOrCreateUser` on the
  very next read — a stale session could resurrect an account a user had
  just deleted. `GET /me`, `GET /me/export`, `GET /me/consent`, and
  `GET /me/activity` now distinguish "this phone never signed up" (still
  safe to auto-vivify) from "this phone signed up, then was deleted" (via
  the retained `delete`/`account` audit event) and answer the latter with
  a clean `401 { error: 'no_account' }` instead of a resurrected row. The
  PWA's existing 401 handling already logs the session out, so no client
  change was needed.

## [0.2.0] - 2026-07-16

The Phase 1 + Phase 2 build: the Phase 0 JavaScript codebase rewritten as a
TypeScript monorepo, plus a new Next.js PWA with real OTP sign-in, a
structured journal, offline sync, and insights charts. 228 tests.

### Phase 1 — TypeScript monorepo (`2513823`…`ec2ebcc`)

- **pnpm workspace + TypeScript toolchain** (`2513823`): `pnpm typecheck`,
  `pnpm build` (tsc → `dist/`), `tsx`-based `dev`/`start`; vitest carried over.
- **`packages/core`** (`50c304d`): all pure domain logic extracted to a
  side-effect-free package — danger-sign engine, journal stage machine,
  onboarding parsers, i18n copy, trend math — deterministic and golden-fixture
  tested.
- **Repository pattern + adapters** (`2fdb2fc`): repository interfaces in
  core, SQLite implementations + schema/migrations in `packages/adapters`,
  lazy Twilio client. `apps/server/src/database.ts` is a stable facade — the
  seam for a future Postgres adapter.
- **LLM redaction chokepoint** (`6c59132`): exactly one file may talk to
  OpenAI (`packages/adapters/src/llm.ts`); every user/assistant message is
  PII-redacted (phones, emails, userinfo URLs, long digit runs, the user's
  full stored name) before leaving the process. First-name-only
  personalization policy documented in `packages/core/src/redaction.ts`.
- **`apps/server` assembly** (`ec2ebcc`): `server.js` and the old
  `services/`/`utils/` layout retired; Express app rebuilt in TS as a
  `createApp()` factory, with dist-boot support (`node dist/...`).

### Phase 2 — Next.js PWA (`6fac469`…`de2d934`)

- **PWA scaffold** (`6fac469`): Next.js 15 static export — brand shell,
  login, chat, profile; dev-mode API proxy via `AMAAII_API_ORIGIN`, static
  deploys via `NEXT_PUBLIC_API_ORIGIN`.
- **OTP login** (`25632d0`): 6-digit codes over WhatsApp, HMAC-hashed at
  rest, 10-minute expiry, 5 verify attempts, 3 sends per rolling hour; dev
  fallback returns the code inline when no Twilio creds are configured
  (non-production only). Legacy phone-only `/auth/login` kept for back-compat.
- **Structured journal check-in** (`c188770`): PWA form writing the same
  journal rows as the WhatsApp flow; `POST /journal/entries` idempotent on
  `clientEntryId` (partial unique index); danger-sign detection re-run
  server-side on every submission.
- **Offline support** (`72e4a6d`): IndexedDB outbox with app-layer flush +
  Background Sync wake-up, stale-while-revalidate offline reads, service
  worker app-shell caching, and a client-side CRITICAL/HIGH danger-sign
  mirror (parity-pinned to core by test) so escalation shows instantly even
  offline.
- **Insights** (`de2d934`): `GET /insights?days=14|30` chart aggregates
  (mood/sleep daily series, symptom counts, red-flag dates) + charts tab,
  home week-ribbon and sparkline.
- **Smoke-suite DB isolation** (`7efeb6e`): every smoke script boots against
  a scratch `DB_PATH`, never the repo DB.

### Fixed

- PWA auth calls now respect `API_BASE` for cross-origin deployments (`0c5e350`).
- `GET /me` / `PUT /me` create the user row on first access, so an
  OTP-only sign-in is no longer a ghost user (`25632d0`).
- Service worker no longer serves the offline HTML page to `GET /insights`
  API calls on flaky connections (P2-F).
- Realistic phone numbers replaced with dummy-range `+254700000xxx`
  equivalents in docs, fixtures, and smoke scripts (P2-F).

### Notes

- The SQLite database file is no longer committed (`*.db` gitignored).
- The older vanilla-JS PWA under `public/` is still served by Express and
  still works; moving Express to serve the Next.js build output was
  deliberately deferred.

## [0.1.0] - 2026-05-29

First tagged release — the Phase 0 demo build. Amaaii is a maternal-health
companion for pregnant and postpartum mothers in Kenya, reachable both on
WhatsApp and through a brand-styled PWA that shares one user identity and
conversation history (keyed by phone number).

### Added

**Conversational core**
- WhatsApp bot over the Twilio sandbox (`POST /webhook`) with AI-generated
  support via OpenAI GPT-3.5, using context-aware system prompts
  (base / onboarding / journaling / mental-health).
- Trend-aware replies that factor in the mother's recent check-in history.
- Stateless onboarding (name → age → pregnancy week → location) with a
  3-strikes LLM fallback for messy name/week parsing.

**Safety**
- Regex-based danger-sign detection with canned, no-hedging escalation copy;
  critical/high urgency bypasses the AI entirely.
- Bilingual triage and canned copy in English and Kiswahili (`services/i18n.js`).
- 60-entry golden fixture (`tests/fixtures/danger-signs-golden.json`) guarding
  detection accuracy.

**Journaling & records**
- Daily journaling state machine with multiple check-ins per day and a
  week ≥ 20 branch for fetal-movement questions.
- Journal sessions persisted to the `journal_sessions` table (survive restart).
- Medical-history capture with LLM extraction (`services/llmExtract.js`) and an
  overwrite guard that refuses to wipe a real record with unparseable input.

**PWA + web API**
- Progressive Web App (`public/`): multi-page SPA, desktop sidebar + mobile nav,
  Insights card, service worker, and web manifest.
- Phone-only demo auth issuing HMAC-signed bearer tokens (`services/auth.js`).
- JSON endpoints sharing the same brain as WhatsApp: `POST /chat`,
  `GET/PUT /me`, `GET /history`, `GET/POST /me/medical-history`.

**Security & ops**
- Twilio webhook signature middleware (`middleware/twilioSignature.js`),
  gated by `TWILIO_SIGNATURE_ENFORCE`.
- PII-redacting logger across the app; lazy Twilio client init so the server
  boots without live credentials.
- Vitest suite (~103 tests) plus shell smoke scripts; demo tooling
  (`scripts/seed-demo-user.js`, `scripts/demo-reset.sh`).

### Notes
- This is a demo build on the Twilio WhatsApp **sandbox** and OpenAI GPT-3.5.
  `AUTH_SECRET` falls back to an insecure dev default — set it before any real
  deployment. A planned Python/FastAPI/PostgreSQL/Claude port is described in
  `CLAUDE_CODE_PROMPT.md` and is **not** implemented here.

[0.1.0]: https://github.com/judejudo/amaai/releases/tag/v0.1.0
