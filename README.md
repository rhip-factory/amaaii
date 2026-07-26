# Amaaii

A maternal-health companion for pregnant and postpartum mothers in Kenya — a WhatsApp bot (Twilio sandbox) and a PWA sharing one AI brain, one user identity (phone number), and one conversation history. **Demo-stage software**: it runs on the Twilio WhatsApp *sandbox* and OpenAI GPT-3.5, and has not been through clinical review or a production deployment.

## Quickstart

```bash
pnpm install          # pnpm only — sqlite3 native build is configured for pnpm
pnpm dev              # Express API on http://localhost:3000 (tsx watch)
```

The server boots with **no credentials at all** — Twilio and OpenAI clients are lazy. Without an `OPENAI_API_KEY`, AI replies fall back to a canned message; danger-sign detection, journaling, and the web API all work regardless.

### PWA (Next.js)

For iterating on the PWA itself, run `next dev` against a running API in a second terminal:

```bash
AMAAII_API_ORIGIN=http://localhost:3000 pnpm dev:web
```

Open the printed URL and sign in with any Kenyan-format phone number. **OTP dev mode:** with no Twilio credentials configured, the 6-digit code is returned by the API and shown right on the login screen (non-production only), so the whole flow works offline from Twilio.

For a single-process, single-origin deployment — the production shape — build the static export first, then let Express serve it alongside the API:

```bash
pnpm build:web        # static export -> apps/web/out (build in an isolated worktree if `next dev` is also running — see CLAUDE.md)
pnpm start            # Express now serves the PWA at http://localhost:3000/ too
```

### WhatsApp webhook (optional)

```bash
ngrok http 3000
```

Point the Twilio WhatsApp sandbox webhook at `https://<your-ngrok>/webhook` (POST), join the sandbox from your phone, and message it.

### Tests

```bash
pnpm test                              # vitest — 342 tests
pnpm typecheck                         # tsc --noEmit
pnpm build                             # compile to dist/ (node dist/apps/server/src/index.js)
PORT=4690 bash scripts/smoke/run-all.sh  # shell smoke suite (boots its own servers on $PORT, scratch DBs)
```

## Environment

All optional — the server boots without any of them.

| Variable | Purpose |
|---|---|
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_WHATSAPP_NUMBER` | WhatsApp sending + OTP delivery. Absent → OTP dev mode (code shown in the login UI). |
| `OPENAI_API_KEY` | AI replies. Absent → canned fallback; triage/journaling unaffected. |
| `PORT` | Express port (default 3000). |
| `AUTH_SECRET` | HMAC secret for bearer tokens + OTP hashes. **Set before any real deployment** — insecure dev default otherwise. |
| `DB_PATH` | SQLite file (default `./amaaii.db`, auto-created). |
| `TWILIO_SIGNATURE_ENFORCE` | `true`/`false`/unset — unset enforces webhook signatures only in production. |
| `AMAAII_API_ORIGIN` | `next dev` only: where the PWA proxies API calls. |
| `NEXT_PUBLIC_API_ORIGIN` | Static PWA builds: the API origin baked in at `pnpm build:web` time. |
| `PUBLIC_BASE_URL` | Links the WhatsApp consent prompt to `{PUBLIC_BASE_URL}/privacy`. Unset (the default everywhere so far) falls back to a generic phrase instead of a broken link. |

## Architecture (one paragraph)

A TypeScript pnpm monorepo: `packages/core` holds the pure domain logic (deterministic regex danger-sign triage with a golden-fixture test suite, journal stage machine, onboarding parsers, EN/Kiswahili copy, trend math, PII redaction rules), `packages/adapters` holds the I/O (SQLite repositories behind interfaces, a lazy Twilio client, and the single OpenAI chokepoint that redacts PII from every outbound message), `apps/server` is the Express app (WhatsApp webhook + JSON API), and `apps/web` is the Next.js 15 static-export PWA. Both the WhatsApp bot and the PWA call the same `processMessage` brain and write the same journal rows, so a mother can switch surfaces without losing anything. Danger-sign triage never touches the LLM — critical/high messages get instant canned escalation copy.

## PWA features

- OTP sign-in over WhatsApp (with a no-Twilio dev fallback)
- Chat with the same AI + history as WhatsApp
- Structured daily check-in form with instant client-side danger-sign escalation (works offline)
- Offline outbox: check-ins queued in IndexedDB and synced when back online; idempotent server writes (no double entries)
- Insights: mood/sleep trends, symptom counts, red-flag dates over 14/30 days
- Home dashboard with pregnancy-week ribbon and mood sparkline
- Installable, offline-capable app shell (service worker)
- Consent gate on first login + a Profile "Privacy & data" section (AI on/off toggle, activity log, data export, account deletion)

## Privacy & data protection

Amaaii implements a Kenya Data Protection Act–shaped consent and data-rights layer. **Demo-stage**: the mechanics below are real and tested, but the privacy notice's legal wording has not had a lawyer's review — see the disclaimer in `apps/web/src/app/privacy/page.tsx`.

- **Two-tier consent.** `data_processing` is required (the app can't operate for a user without it); `ai_responses` is optional and only ever turns the AI chat replies on or off — declining it still leaves journaling and danger-sign detection fully working. Every grant/revoke is appended to a `consents` ledger (never overwritten), versioned so a future policy change can force re-consent.
- **Danger signs always escalate**, regardless of consent status — a critical message is answered and flagged before consent is even checked. This never changes.
- **Audit trail.** Every read/write of a user's own data is logged (`audit_log`, append-only); `GET /me/activity` lets a user see their own "who's accessed your data" list, and it's retained even after account deletion (the deletion event itself is part of that record).
- **Your data, your call.** `GET /me/export` downloads everything Amaaii holds about you as one JSON file; `DELETE /me/account` permanently and irreversibly erases your profile, journals, conversations, symptoms, ANC visits, medical history, and consent records (the audit log's record that you existed and deleted your account is the one thing kept, for accountability). Both are in the PWA's Profile screen; both are also plain authenticated HTTP endpoints (`GET /me/export`, `DELETE /me/account`) for anyone who wants to script it.
- **Cross-border processing disclosure.** The privacy notice discloses that AI replies are processed by OpenAI (a US-based sub-processor) — see `/privacy` in the app, or `apps/web/src/app/privacy/page.tsx` in source.
- New API surface (bearer auth, same as the rest of the web API): `GET/POST /me/consent`, `POST /me/consent/revoke`, `GET /me/activity`, `GET /me/export`, `DELETE /me/account`.

## Notes

- Demo/dev setup only: WhatsApp Business API approval and clinical review are still future work; real OTP sign-in (WhatsApp-delivered, with a no-Twilio dev fallback) is already implemented.
- The bot never diagnoses or prescribes; escalation copy directs users to clinics/999 and includes disclaimers, and always fires ahead of any consent check (see Privacy & data protection above).
- Example/test phone numbers in this repo use the dummy `+254700000xxx` range.
