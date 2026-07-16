# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Amaaii is a maternal-health companion for pregnant/postpartum mothers in Kenya, reachable on two surfaces that share one brain and one identity (users keyed by `phone_number` = the raw `whatsapp:+E.164` string): a Twilio-sandbox WhatsApp bot and a PWA. The bot gives AI-generated support, detects pregnancy danger signs deterministically, and runs a multi-step daily journaling flow; the PWA adds OTP login, a structured check-in form, offline sync, and insights charts.

## Layout (TypeScript monorepo)

- `packages/core` — pure domain logic, no I/O, deterministic given inputs. Modules: `dangerSigns` (regex triage engine), `journal` (stage-machine transitions + parsers + summaries), `onboarding` (name/week/LMP parsers, EDD), `i18n` (EN + `sw` canned copy), `trend` (`computeTrend`, `computeDailySeries`, `computeSymptomCounts`, `computeRedFlagDates`), `redaction` (LLM/log PII masking — read its FIRST-NAME POLICY header before touching), `otp` (rate-limit/expiry decisions, no crypto), `repositories` (interfaces), `types`.
- `packages/adapters` — I/O implementations: `sqlite/` (one repository class per table + `connection.ts` schema/migrations), `twilio.ts` (lazy client, `__setSendImpl` test seam), `llm.ts` (the single OpenAI chokepoint — see below).
- `apps/server` — Express in TS. Entry `apps/server/src/index.ts` (import order load-bearing: `register-paths` → `dotenv/config` → app). `app.ts` is the `createApp()` factory with all routes; `database.ts` is a stable facade over the SQLite adapter; plus `messageHandler`, `journalManager`, `userManager`, `amaaii` (prompts + AI reply), `llmExtract`, `trend`, `auth`, `otp` (crypto half), `logger` (PII-redacting), `middleware/twilioSignature`.
- `apps/web` — Next.js 15 static-export PWA (the only pnpm workspace package; `packages/*` have no package.json and resolve via root tsconfig paths / vitest aliases / `register-paths.ts` for compiled dist).
- `public/` — the older vanilla-JS PWA, still served by Express and still working. Swapping Express to serve `apps/web/out` was deliberately deferred; both PWAs hit the same API.
- `tests/` — root vitest suite (228 tests) with golden fixtures (`danger-signs-golden.json`, `redaction-golden.json`). `scripts/smoke/` — shell E2E scripts, DB-isolated via scratch `DB_PATH`.

## Commands

pnpm only (`packageManager: pnpm@10.33.0`; `sqlite3` is in `pnpm.onlyBuiltDependencies` — `npm install` can leave the native module unbuilt).

- `pnpm install`
- `pnpm dev` / `pnpm start` — Express server via `tsx` (watch / no-watch), port from `PORT` (default 3000)
- `pnpm test` / `pnpm test:watch` — vitest (228 tests in `tests/`)
- `pnpm typecheck` — `tsc --noEmit` over packages + apps/server (apps/web has its own `pnpm --filter web typecheck`)
- `pnpm build` — `tsc -p tsconfig.build.json` → `dist/`; boot the artifact with `node dist/apps/server/src/index.js` (works because of `register-paths.ts` + `paths.ts` — see their headers before touching import resolution)
- `pnpm dev:web` — `next dev` for the PWA; point it at a running API with `AMAAII_API_ORIGIN`, e.g. `AMAAII_API_ORIGIN=http://localhost:3100 pnpm dev:web` (rewrites proxy API calls in dev)
- `pnpm build:web` — static export to `apps/web/out`. **TRAP:** `next build` always writes into the literal `.next/` even with `NEXT_DIST_DIR` set, so it clobbers a running `next dev`'s state — build only in an isolated git worktree (documented in `apps/web/next.config.ts`).
- Smoke suite: `PORT=4690 bash scripts/smoke/run-all.sh` — each script boots its own server on `$PORT` (default 3000; override when 3000 is busy) against a scratch DB. Never touches `./amaaii.db`.
- `ngrok http <port>` — expose `/webhook` for the Twilio sandbox.

There is no linter. Do not add one unless asked.

## Environment (`.env`)

- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER` — **optional**: both the Twilio and OpenAI clients are lazy, so the server boots without any credentials. With Twilio creds absent, `/auth/otp/request` switches to dev mode (code logged + returned inline as `devCode`, only when `NODE_ENV !== 'production'`).
- `OPENAI_API_KEY` — lazy too; AI replies fail at call time (with a canned fallback), not at boot.
- `PORT` — default 3000.
- `AUTH_SECRET` — HMAC secret for PWA bearer tokens and OTP code hashes (insecure dev default if unset).
- `DB_PATH` — SQLite path, default `./amaaii.db`. Read at module load: set it before anything imports `apps/server/src/database.ts` (tests set `:memory:` first).
- `TWILIO_SIGNATURE_ENFORCE` — `true`/`false`/unset; unset enforces webhook signatures only when `NODE_ENV=production`.
- `AMAAII_API_ORIGIN` — dev-only: where `next dev`'s rewrites proxy API calls (default `http://localhost:3000`).
- `NEXT_PUBLIC_API_ORIGIN` — baked into the static export at build time; a deployed `apps/web/out` calls this origin directly (no server, no rewrites).

## Architecture

Every inbound message (Twilio `POST /webhook` → `app.ts` → `messageHandler.ts#handleIncomingMessage`) runs `processMessage(from, message, profileName)` — **the shared brain**, also called by the PWA's `POST /chat`. Routing priority inside it:

1. CRITICAL danger signs short-circuit everything (canned escalation copy, AI bypassed).
2. Un-onboarded users → stateless onboarding (HIGH/MODERATE danger copy is prepended, not dropped).
3. Active journal session or journal command → `journalManager.ts` stage machine (persisted in `journal_sessions`, survives restart; week ≥ 20 adds fetal movement; multiple check-ins/day).
4. `journal summary` / `weekly summary` / `doctor report` commands.
5. Otherwise `detectDangerSigns` (HIGH also escalates with canned copy) else AI reply via `amaaii.ts` with last-5-turn history, 7-day trend line, and medical history in the system prompt.

`handleIncomingMessage` adds WhatsApp delivery plus a `setTimeout(..., 3600000)` follow-up for critical/high urgency — still **in-process and lost on restart** (durable queue is future work).

Web API (all in `app.ts`; bearer auth unless noted): `POST /auth/login` (legacy phone-only demo login, kept for back-compat), `POST /auth/otp/request` + `/auth/otp/verify` (real flow), `POST /chat`, `GET/PUT /me` (both getOrCreate the user row), `GET/POST /me/medical-history`, `GET /history`, `POST /journal/entries` + `GET /journal/entries?days=N` + `GET /journal/today`, `GET /insights?days=14|30` (400 on anything else), static `public/`. `/webhook` is guarded by `middleware/twilioSignature.ts`.

## Non-obvious points

- **Danger-sign triage is deterministic and duplicated on purpose.** The engine is `packages/core/src/dangerSigns.ts`, pinned by the 60-entry golden fixture. The PWA carries a verbatim CRITICAL/HIGH mirror (`apps/web/src/lib/localDangerSigns.ts`) so offline-queued entries escalate instantly client-side; `tests/offlineDangerSignsParity.test.ts` fails if the two drift. Change a CRITICAL/HIGH pattern in core → copy it to the mirror. (apps/web can't import `packages/core`: no package.json there, and apps/web's standalone tsconfig doesn't share the root path aliases.)
- **Single LLM chokepoint.** Only `packages/adapters/src/llm.ts` may import `openai`. Its `chat()` redacts every user/assistant message via core `redactForLLM` (phones, emails, userinfo-URLs, 11+ digit runs, and the user's full stored name); system prompts pass untouched and are the one place allowed to carry the user's FIRST name only. The policy rationale lives in `packages/core/src/redaction.ts`'s header.
- **Repository pattern is the Postgres seam.** Interfaces in `packages/core/src/repositories.ts`, SQLite implementations in `packages/adapters/src/sqlite/`, and `apps/server/src/database.ts` re-exports stable function signatures. A future Postgres port implements the same interfaces in a new adapter; app code shouldn't change.
- **One journal shape, two writers.** The WhatsApp stage machine and the PWA form (`POST /journal/entries`) write the same `journals` columns; `physical_symptoms` is a JSON-array string, `'none'`, or raw text — parsers in core handle all three, so summaries/reports/trends work on rows from either source. The form re-runs `detectDangerSigns` over symptoms+text+note; it is never a triage bypass.
- **Idempotency + offline outbox.** `POST /journal/entries` dedupes on (`user_phone`, `client_entry_id`) via a partial unique index; replays return the saved entry with `deduped: true` (escalation recomputed so a retry never drops the safety banner). The PWA queues failed submissions in IndexedDB (`apps/web/src/lib/outbox.ts`) keyed by the same `clientEntryId`; reads are stale-while-revalidate from IndexedDB (`offlineCache.ts`). Background Sync is a wake-up hint only — the app-layer flush is the guarantee.
- **`/chat` and `/insights` are both a page route and an API path** in the Next app. `next dev` disambiguates with `beforeFiles` rewrites gated on the `X-Amaaii-Api` header, which `apps/web/src/lib/api.ts` sets on every API call. The static export has no rewrites — it prefixes `NEXT_PUBLIC_API_ORIGIN` instead.
- **SW must not cache API GETs.** `apps/web/public/sw.js`'s `API_GET_PATHS` (incl. `/insights`) bypasses the service worker so a flaky connection can't hand JSON callers the cached offline HTML page; `tests/swApiGetPaths.test.ts` pins the list.
- **Onboarding is stateless** — it re-reads the user row each turn and infers the next question from the first null column (`name` → `age` → `pregnancy_week` → `location`), with a 3-strikes LLM fallback for unparseable name/week answers. Don't add a separate onboarding state machine.
- **OTP design:** `otp_codes` table stores only `HMAC-SHA256(phone:code)` (never plaintext), 10-min expiry, 5 verify attempts, 3 sends per rolling hour. Pure decisions in `packages/core/src/otp.ts`; crypto in `apps/server/src/otp.ts`.
- **The SQLite file is NOT committed** (`*.db` is gitignored; `git ls-files` shows none). `./amaaii.db` is created/migrated at boot by `initializeDatabase()`. Tables: `users`, `conversations`, `symptoms`, `anc_visits`, `journals`, `journal_sessions`, `medical_history`, `otp_codes`. A local `./amaaii.db` may back a live demo server — use a scratch `DB_PATH` for anything experimental.
- **System prompt doctrine** lives in `amaaii_ai_prompts_guardrails.md` and is partially duplicated in `apps/server/src/amaaii.ts`. The safety rules (never diagnose, never prescribe, escalate danger signs, Kenyan/Kiswahili context, triage never touches the LLM) are load-bearing — don't soften them casually.

## Aspirational vs. actual stack — important

`CLAUDE_CODE_PROMPT.md` describes a planned rewrite on **Python / FastAPI / PostgreSQL / Anthropic Claude / WhatsApp Business API**. None of that is implemented. The live code is **TypeScript / Express / SQLite / OpenAI GPT-3.5 / Twilio WhatsApp sandbox**, plus the Next.js PWA. Treat `CLAUDE_CODE_PROMPT.md` as a spec for a future port — don't refactor toward it without explicit instruction.
