  # CLAUDE.md

  This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

  ## Project

  Amaaii is a WhatsApp-based maternal health chatbot for pregnant/postpartum mothers in Kenya. Users message a Twilio WhatsApp number; the bot replies with AI-generated support, detects pregnancy danger signs, and runs a multi-step daily journaling flow.

  ## Commands

  - `npm install` — install dependencies
  - `npm start` — run the Express server (`node server.js`)
  - `npm run dev` — run with nodemon auto-reload
  - `ngrok http 3000` — expose the webhook so Twilio can reach `/webhook` locally

  There is **no test suite, linter, or build step**. Do not add one unless asked.

  ## Required environment (`.env`)

  - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER` (e.g. `whatsapp:+14155238886`)
  - `OPENAI_API_KEY`
  - `PORT` (defaults to 3000)

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

  Keep these non-obvious points in mind when editing:

  - **Two AI service files exist.** `services/amaaii.js` is the one wired in (context-aware system prompts: `BASE`, `ONBOARDING`, `JOURNALING`, `MENTAL_HEALTH`; model `gpt-3.5-turbo`). `services/openai.js` is an older, simpler version not used in the main flow — prefer editing `amaaii.js`.
  - **Two danger-sign detectors exist.** The regex-based `services/dangerSigns.js#detectDangerSigns` is what `messageHandler` actually calls; `amaaii.js#analyzeForDangerSigns` is a legacy keyword-match path that callers no longer use. Keep them consistent if you change detection rules.
  - **Journal sessions are in-memory** (`JournalManager.journalSessions` Map). They do not survive a process restart — only the committed rows in the `journals` table do. The stage machine in `processJournalResponse` branches at week ≥ 20 to ask about fetal movement.
  - **SQLite file is committed.** The DB lives at `./amaaii.db` (relative to project root) and is created/migrated by `initializeDatabase()` on server start. Tables: `users`, `conversations`, `symptoms`, `anc_visits`, `journals`. Users are keyed by `phone_number` (the raw Twilio `From` like `whatsapp:+254...`), not a synthetic id.
  - **Onboarding is stateless** — it re-reads the user row each turn and infers the next question from which column is null (`name` → `age` → `pregnancy_week` → `location`). Don't introduce a separate onboarding state machine unless you're migrating the whole flow.
  - **System prompt doctrine** lives in `amaaii_ai_prompts_guardrails.md` and is partially duplicated inside `services/amaaii.js`. The safety rules there (never diagnose, never prescribe, escalate danger signs, Kenyan/Kiswahili context) are load-bearing — don't soften them casually.

  ## Aspirational vs. actual stack — important

  `CLAUDE_CODE_PROMPT.md` describes a planned rewrite on **Python / FastAPI / PostgreSQL / Anthropic Claude / WhatsApp Business API**. None of that is implemented. The live code is **Node.js / Express / SQLite / OpenAI GPT-3.5 / Twilio WhatsApp sandbox**. Treat `CLAUDE_CODE_PROMPT.md` as a spec for a future port, not a description of this repo — don't refactor toward it without explicit instruction.
