# Changelog

All notable changes to Amaaii are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased]

### Added

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
