# Amaaii — Investor Demo Cheat Sheet

A 5-minute live walkthrough across **WhatsApp** and the **PWA**, showing
the same Amaaii brain answering both surfaces.

## Setup (one-time)

```bash
# 1. Start the server (binds 3030 because :3000 has a stale listener)
PORT=3030 node server.js

# 2. In a second terminal, expose it for Twilio
ngrok http 3030

# 3. Paste the https URL + /webhook into Twilio sandbox settings.
#    Your phone needs to have texted the `join <code>` to the sandbox
#    number once.

# 4. Open the PWA
open http://localhost:3030
```

## Reset between runs

```bash
./scripts/demo-reset.sh         # wipes amaaii.db
# In the PWA, click the ↻ icon in the header (or clear localStorage).
```

## Suggested demo arc (~5 min)

### 1. PWA — first impression (30s)
- Open `http://localhost:3030`. Show the brand-styled welcome screen,
  the suggestion chips, the lockup in the header.
- Talking point: "Same backend as WhatsApp — one brain, two front
  doors. PWA is installable on phones (Add to Home Screen)."

### 2. PWA — onboarding (1 min)
- Tap **👋 Say hi** chip, then walk through:
  - "Grace" → name captured
  - "26" → age captured
  - "20 weeks" → pregnancy week + EDD computed
  - "Nairobi" → location, full profile summary
- Talking point: "Stateless onboarding — re-reads the user row each
  turn. Survives restarts. Same flow on WhatsApp."

### 3. WhatsApp — the same conversation (45s)
- Send `Hi` from your phone to the Twilio sandbox number.
- The bot answers using the same Amaaii backend, same DB.
- Talking point: "Lowest-friction channel for Kenya — no install,
  works on a feature phone with WhatsApp."

### 4. The danger-sign trip wire (45s)
- In the PWA (or WhatsApp), type:
  > **severe headache and seeing spots**
- Bot responds **instantly** with the canned URGENT escalation
  (no LLM in the path → no latency, no hallucination risk).
- Talking point: "Triage is deterministic. The LLM never decides
  urgency — it only generates supportive language around a
  rule-based result. This is why we can responsibly run an AI agent
  in maternal health."

### 5. The journal (1 min)
- Type **journal** → bot starts the daily check-in.
- Walk through 2-3 stages: mood → symptoms → sleep.
- Talking point: "Structured data behind the conversational surface.
  Sleep, water, mood, fetal movement — all queryable for trends and
  for the doctor report."

### 6. The privacy story (30s)
- Switch to your terminal.
- Show the server log:
  > `[INFO] Received message {"From":"[PHONE]","ProfileName":"[REDACTED]","Body":"[REDACTED]"}`
- Talking point: "Every log line that touches a user boundary goes
  through the redactor. Phone numbers, names, and message bodies
  never leave the process unredacted. Webhook signatures are
  validated in production."

## Anti-patterns to avoid in the demo

- **Don't** ask the AI a question mid-onboarding — it'll re-prompt
  for the missing field and feel awkward. Finish onboarding first.
- **Don't** open two PWA tabs with the same browser profile — they
  share `localStorage` and will collide on the same session.
- **Don't** demo on a 1995-era WiFi if you can help it. The OpenAI
  call adds 1-2s of latency on top of normal RTT.

## Quick "wow" prompts

| Prompt | What it shows |
|---|---|
| `severe headache and seeing spots` | Instant CRITICAL escalation, AI bypassed |
| `I am bleeding heavily` | CRITICAL bleeding detection (regex) |
| `I'm feeling really anxious lately` | Mental-health context + supportive AI tone |
| `journal` | Multi-step structured journal flow |
| `weekly summary` | (After a few journals) aggregated trends |
| `doctor report` | 30-day clinical-style summary |

## What to mention in the close

- "All you saw runs **locally** — no hosting yet. Phase 1 lays the
  TypeScript foundation, Phase 2 builds out the PWA proper, Phase 3
  the Kenya DPA compliance surface, Phase 4 production hardening."
- "Phase 0 (what you saw) is **103 tests green** + smoke tests
  covering every defect we fixed before this demo."
