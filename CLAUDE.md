  # CLAUDE.md

  This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

  ## Project

  Amaaii is a WhatsApp-based maternal health chatbot for pregnant/postpartum mothers in Kenya. Users message a Twilio WhatsApp number; the bot replies with AI-generated support, detects pregnancy danger signs, and runs a multi-step daily journaling flow.

  ## Commands

  This repo uses **pnpm** (`packageManager: pnpm@10.33.0`; `sqlite3` is in `pnpm.onlyBuiltDependencies`, so `npm install` can leave the native module unbuilt — use pnpm).

  - `pnpm install` — install dependencies
  - `pnpm start` — run the Express server (`node server.js`)
  - `pnpm dev` — run with nodemon auto-reload
  - `pnpm test` / `pnpm test:watch` — vitest suite (~103 tests in `tests/`; golden fixtures under `tests/fixtures/`)
  - `ngrok http 3000` — expose the webhook so Twilio can reach `/webhook` locally

  There is **no linter or build step**. Do not add one unless asked.

  ## Required environment (`.env`)

  - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER` (e.g. `whatsapp:+14155238886`)
  - `OPENAI_API_KEY`
  - `PORT` (defaults to 3000)
  - `AUTH_SECRET` — HMAC secret for PWA bearer tokens (`services/auth.js`; falls back to an insecure dev default)
  - `DB_PATH` — override the SQLite path (defaults to `./amaaii.db`)
  - `TWILIO_SIGNATURE_ENFORCE` — `true`/`false`/unset; unset enforces webhook signatures only when `NODE_ENV=production`

  ## Architecture

  Entry flow for every inbound message (`Twilio POST /webhook` → `server.js` → `utils/messageHandler.js#handleIncomingMessage`):

  1. **User lookup / create** (`utils/userManager.js`, backed by `services/database.js`).
  2. **Routing decision** inside `handleIncomingMessage`, in priority order:
    - Active journal session or journal-start command → `services/journalManager.js` state machine.
    - `journal summary` / `weekly summary` / `doctor report` commands → summary generators in the same manager.
    - Otherwise: run `detectDangerSigns` (regex-based), `assessMood`, `extractSymptoms` from `services/dangerSigns.js`.
      - If urgency is `critical` or `high`, return the canned escalation copy directly — AI is bypassed.
      - If the user hasn't completed onboarding (`needsOnboarding`), step through `handleOnboarding` to collect name/age/pregnancy week/location.
      - Else call `services/amaaii.js#getAmaaiiResponse` with the last 5 conversation turns.
  3. **Persist** the turn via `saveConversation`, then `sendWhatsAppMessage` (`services/twilio.js`).
  4. For critical/high urgency, a `setTimeout(..., 3600000)` schedules a check-in message **in-process** (lost on restart).

  **`processMessage` is the shared brain.** `utils/messageHandler.js#processMessage(from, message, profileName)` runs the routing/AI pipeline above and returns `{ response, urgencyLevel, context }`. `handleIncomingMessage` is a thin WhatsApp wrapper around it. Both clients below hit the same core, keyed by the same `whatsapp:+E.164` phone.

  **There is a PWA + web API too** (`server.js`), not just the WhatsApp webhook. It serves `public/` (single-page app, service worker `sw.js`, `manifest.webmanifest`) and exposes JSON endpoints:
    - `POST /auth/login` — phone-only demo auth, returns an HMAC bearer token (`services/auth.js`; `normalizePhone` assumes Kenya `+254`). No OTP — demo only.
    - `POST /chat` (auth) — calls `processMessage`; shares conversation history with WhatsApp.
    - `GET`/`PUT /me`, `GET /history`, `GET`/`POST /me/medical-history` (auth).
    - `/webhook` is guarded by `middleware/twilioSignature.js` (see `TWILIO_SIGNATURE_ENFORCE`).

  Keep these non-obvious points in mind when editing:

  - **Two AI service files exist.** `services/amaaii.js` is the one wired in (context-aware system prompts: `BASE`, `ONBOARDING`, `JOURNALING`, `MENTAL_HEALTH`; model `gpt-3.5-turbo`). `services/openai.js` is an older, simpler version not used in the main flow — prefer editing `amaaii.js`.
  - **Two danger-sign detectors exist.** The regex-based `services/dangerSigns.js#detectDangerSigns` is what `messageHandler` actually calls; `amaaii.js#analyzeForDangerSigns` is a legacy keyword-match path that callers no longer use. Keep them consistent if you change detection rules.
  - **Journal sessions are now persisted** to the `journal_sessions` table, so they survive a process restart. The stage machine in `processJournalResponse` branches at week ≥ 20 to ask about fetal movement; multiple check-ins per day are supported (`getTodaysJournals`).
  - **SQLite file is committed.** The DB lives at `./amaaii.db` (override with `DB_PATH`) and is created/migrated by `initializeDatabase()` on server start. Tables: `users`, `conversations`, `symptoms`, `anc_visits`, `journals`, `journal_sessions`, `medical_history`. `users` also carries `language`, `edd`, `lmp`, `risk_level`. Users are keyed by `phone_number` (the raw Twilio `From` like `whatsapp:+254...`), not a synthetic id.
  - **More services sit in the flow now:** `services/i18n.js` (EN + `sw` Kiswahili canned copy, language hint passed to the AI), `services/llmExtract.js` (medical-history extraction + a 3-strikes LLM fallback for onboarding name/week parsing), and `services/trend.js` (`getRecentTrend`, feeding trend-aware AI replies and the PWA Insights card).
  - **Onboarding is stateless** — it re-reads the user row each turn and infers the next question from which column is null (`name` → `age` → `pregnancy_week` → `location`). Don't introduce a separate onboarding state machine unless you're migrating the whole flow.
  - **System prompt doctrine** lives in `amaaii_ai_prompts_guardrails.md` and is partially duplicated inside `services/amaaii.js`. The safety rules there (never diagnose, never prescribe, escalate danger signs, Kenyan/Kiswahili context) are load-bearing — don't soften them casually.

  ## Aspirational vs. actual stack — important

  `CLAUDE_CODE_PROMPT.md` describes a planned rewrite on **Python / FastAPI / PostgreSQL / Anthropic Claude / WhatsApp Business API**. None of that is implemented. The live code is **Node.js / Express / SQLite / OpenAI GPT-3.5 / Twilio WhatsApp sandbox**. Treat `CLAUDE_CODE_PROMPT.md` as a spec for a future port, not a description of this repo — don't refactor toward it without explicit instruction.
