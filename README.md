# Amaaii

A maternal-health companion for pregnant and postpartum mothers in Kenya — a WhatsApp bot (Twilio sandbox) and a PWA sharing one AI brain, one user identity (phone number), and one conversation history. **Demo-stage software**: it runs on the Twilio WhatsApp *sandbox* and OpenAI GPT-3.5, and has not been through clinical review or a production deployment.

## Quickstart

```bash
pnpm install          # pnpm only — sqlite3 native build is configured for pnpm
pnpm dev              # Express API on http://localhost:3000 (tsx watch)
```

The server boots with **no credentials at all** — Twilio and OpenAI clients are lazy. Without an `OPENAI_API_KEY`, AI replies fall back to a canned message; danger-sign detection, journaling, and the web API all work regardless.

### PWA (Next.js)

```bash
# In a second terminal — proxies API calls to the Express server:
AMAAII_API_ORIGIN=http://localhost:3000 pnpm dev:web
```

Open the printed URL and sign in with any Kenyan-format phone number. **OTP dev mode:** with no Twilio credentials configured, the 6-digit code is returned by the API and shown right on the login screen (non-production only), so the whole flow works offline from Twilio.

There is also an older vanilla-JS PWA served by the Express server itself at `http://localhost:3000/`.

### WhatsApp webhook (optional)

```bash
ngrok http 3000
```

Point the Twilio WhatsApp sandbox webhook at `https://<your-ngrok>/webhook` (POST), join the sandbox from your phone, and message it.

### Tests

```bash
pnpm test                              # vitest — 228 tests
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

## Notes

- Demo/dev setup only: WhatsApp Business API approval, real auth, and clinical review are all future work.
- The bot never diagnoses or prescribes; escalation copy directs users to clinics/999 and includes disclaimers.
- Example/test phone numbers in this repo use the dummy `+254700000xxx` range.
