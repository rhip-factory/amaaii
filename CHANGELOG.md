# Changelog

All notable changes to Amaaii are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

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
