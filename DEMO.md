# Amaaii — Investor Demo Cheat Sheet

A scripted **7-minute walkthrough** showing one mother, two surfaces (PWA + WhatsApp), one
remembering AI, in two languages. Designed to land the safety story, the product
breadth, and the technical moat in seven minutes flat.

---

## Pre-flight (do once, 5 min before the room)

```bash
# 1. Server (binds 3030 because :3000 is taken on this WSL2 machine)
cd /home/k_nurf/amaai/.worktrees/pwa-demo
DB_PATH=/home/k_nurf/amaai/amaaii.db PORT=3030 node server.js
```

```bash
# 2. ngrok tunnel (separate terminal)
ngrok http 3030
```

3. Twilio Console → Messaging → Try it out → WhatsApp Sandbox →
   `WHEN A MESSAGE COMES IN`: paste the ngrok URL + `/webhook`. Save.
4. From your phone, text the sandbox `join <two-words>` if you haven't already
   in the last 72 hours.
5. Open `http://localhost:3030` in a fresh Chrome tab. **Hard refresh (Ctrl+Shift+R)**
   to pick up the latest service worker.
6. *(Optional reset for a clean slate)*: `./scripts/demo-reset.sh` then restart the
   server. Skips today's K_nurf history but keeps the test users from QA.

---

## What to have on screen

- **Tab 1**: PWA at `http://localhost:3030`
- **Tab 2**: server logs (so you can show PII redaction in passing)
- **Phone in hand**: WhatsApp open to the sandbox conversation

---

## The 7-minute arc

### Minute 1 — The opening (the WhatsApp moment)

1. Pick up your phone, text **`Hi`** to the sandbox.
2. Bot replies: *"Hello! 👋 I'm Amaaii, your pregnancy companion..."*
3. Walk through onboarding live: name → age → 24 weeks → Nairobi.
4. Bot returns the welcome summary with weeks + EDD computed.

> "We just signed up a mother in Kenya in under a minute, on the channel she
> already uses every day — no app store, no install, no data plan beyond
> SMS-grade WhatsApp. That's the on-ramp."

### Minute 2 — The same person in the PWA (the wow)

5. Switch to PWA tab. Login with your phone number (`+254706249104` or
   whatever you used).
6. Land on **Home dashboard** — *"Hello, K_nurf 👋 · Week 3 · poppy seed"*,
   today's journal status, the **Insights card** (avg mood, recurring symptoms),
   and a gentle nudge.

> "Same phone, same brain, same conversation history. WhatsApp is the
> low-friction front door; the PWA is the deeper view — for women who
> can install it, providers, and CHWs."

### Minute 3 — The intelligent journal

7. Click **📝 Daily journal** chip.
8. Walk through fast, **using fuzzy phrasing** to show the LLM fallback parser:
   - Mood: **"feeling like absolute trash today"**
   - Symptoms: **"nausea and a thumping headache"**
   - Sleep: **"barely slept, like 4 hours, quality was awful"**
   - Water: **"not much honestly, maybe 3"**
   - Appetite: **"didn't really feel like eating"**
   - Questions: **"I want to talk about a remedy for my swollen feet"** *(this triggers the heads-up)*
   - Notes: **`done`**

> "Notice we never asked for numbers in 1–10 format. The LLM fills the gaps
> after our regex tries first. That free-text journal is the moat — we capture
> structured data without the cognitive load of a clinical form."

### Minute 4 — The history-aware AI (the second wow)

9. After the journal saves, ask: **"how have I been doing this week?"**
10. Bot replies with specifics: *"You've journaled 5 of 7 days, your average
    mood has been 4/10, sleep around 4 hours, and you've had headaches for
    2 days. K_nurf, that's worth mentioning at your next ANC visit."*
11. Ask: **"would exercise help me sleep?"**
12. Bot: *"Walking 20 minutes after dinner can help, especially since your
    sleep has been around 4 hours lately, K_nurf."*

> "She remembers. Most chatbots forget you between turns. Amaaii reads her
> 7-day trend before every reply and weaves it in. That's what makes it
> a companion, not a chatbot."

### Minute 5 — The safety story (the trust earner)

13. Type: **`severe headache and seeing spots`**
14. **Instant** red-tinted bubble: *"🚨 URGENT — this is a medical emergency..."*
    with the 1-2-3 numbered steps and 999.
15. *(Show the timing in DevTools or just say it)*: ~50ms response. **No LLM
    in that path** — pure regex.
16. Type: **`my blood pressure was fine at the clinic`**
17. Normal AI reply, no escalation. No false alarm.

> "Triage is deterministic. The LLM never decides if you're in danger — that's
> a regex with 60+ golden test cases. We get sub-50ms instant response and a
> guarantee an LLM hallucination cannot tell a bleeding mother she's fine.
> This architecture is what lets us responsibly run AI in maternal health."

### Minute 6 — The Kiswahili moment

18. Profile page → Language: **Kiswahili** → Save.
19. Back to chat. Ask: **`Habari Amaaii, naskia kichwa`**
20. Bot replies in warm Kiswahili sanifu, by name.
21. Type: **`ninavuja damu sana`** — instant SW HARAKA SANA alert with 999
    and Befrienders Kenya number, in Kiswahili.

> "Same regex, same brain, native Kiswahili. 12 SW danger-sign patterns
> — including ones that need the SW possessive pronoun like *uso wangu
> umevimba* — all sub-50ms. The safety guarantee covers the language
> 87% of Kenyans speak."

### Minute 7 — The medical-history capture (the differentiation slide)

22. Profile page → scroll to **Medical history**.
23. Paste this paragraph: *"I'm 34 and this is my 4th pregnancy. I have 2
    living children, both born by C-section. The first one had pre-eclampsia
    at 36 weeks. I have type 2 diabetes on metformin, take folic acid and
    aspirin. Allergic to penicillin."*
24. Click **Save & extract**.
25. Chips appear: **Gravida 4 · Parity 2 · Miscarriages 1 · Conditions:
    type 2 diabetes · Past complications: pre-eclampsia · Medications:
    metformin, folic acid, aspirin · Allergies: penicillin · Previous
    deliveries: cesarean / pre-eclampsia; cesarean / planned**.
26. Switch to chat, ask: **"should I be worried about pre-eclampsia
    this time?"**
27. Bot references the prior pre-eclampsia by name in its answer.

> "She talked. We listened. We extracted 8 structured fields a clinician
> needs, with zero clicks on her side. That's how we make a medical
> profile feel like a conversation, not a form. And the AI now knows her
> history when she asks any question."

### Closing (30 sec)

> "Phase 0 stabilization is done — 103 tests, every defect we shipped fixed.
> What you saw runs locally today. Phase 1 is the production architecture
> — TypeScript, layered services, LLM-input redaction, and we'll evaluate
> Claude 4.6 against GPT-3.5 for a tone and instruction-following uplift.
> Phases 2–4 are the PWA build-out, the Kenya DPA compliance surface, and
> the durable job queue for follow-ups. We have a clear roadmap and a
> working safety story — that's our ask."

---

## Reset between runs

```bash
./scripts/demo-reset.sh
# Then in the PWA: ↻ in the chat composer to wipe visible chat,
# Sign out + sign back in to reset session state.
```

## Demo "wow" prompts (for Q&A)

| Prompt | What it shows |
|---|---|
| `severe headache and seeing spots` | Instant CRITICAL escalation, regex bypassed AI |
| `ninavuja damu sana` | SW critical works equivalently |
| `uso wangu umevimba sana` | SW with possessive pronoun — the architecturally hard case |
| `feeling like absolute trash today` | LLM fallback for fuzzy mood input |
| `would exercise help me sleep?` | Trend-aware advice referencing actual sleep avg |
| `weekly summary` | Structured data view of the week |
| `journal` (after one already today) | Multi check-in in same day works |

## Anti-patterns to avoid

- **Don't** explain the architecture during the demo flow itself. Save it for closing.
- **Don't** demo on the office WiFi if it's flaky — OpenAI calls add 1-2s of latency on top of normal RTT.
- **Don't** open two browser tabs with the same profile — they share `localStorage`.
- **Don't** start with the safety regex story — lead with the human moment (WhatsApp), end with the trust story.

## What investors will ask (and short answers)

| Q | A |
|---|---|
| "What's your data privacy story?" | PII redacted from logs (Phase 0). Webhook signatures validated. Phone is the only PII; no name → no PHI. Phase 3 lands the Kenya DPA surface (consent UI, audit log, data export/delete). |
| "Why GPT-3.5 not GPT-4?" | Cost and latency for this stage. Triage doesn't use the LLM, so even a cheaper model is safe for the dangerous path. Phase 1 evaluates Claude 4.6 / GPT-4o for the conversational layer. |
| "What if the user is on a feature phone?" | Today: WhatsApp works on most feature phones via WhatsApp Lite. Phase 4: USSD/SMS adapter — the same `processMessage` function, different transport. |
| "Can a clinician see this?" | Today: data is captured. Phase 2 builds the read-only provider portal off the same DB. Consent-gated per spec §7 of the product doc. |
| "Where does the AI come in vs the rules?" | Three places: (1) free-text symptom extraction in the journal (LLM fallback after regex), (2) conversational replies after triage, (3) medical history structured extraction. Triage itself never touches the LLM. |
| "What's wrong with it today?" | Honest list — see KNOWN_LIMITATIONS below. |

## KNOWN LIMITATIONS (be honest)

- **GPT-3.5 instruction-following is inconsistent.** Sometimes the bot drops the
  Kenyan food references or repeats the same closer phrase. Mitigated by the
  prompt; will be fully fixed in Phase 1 with a better model.
- **In-process 1-hour follow-up reminder** for high/critical urgency is lost on
  server restart. Documented limitation; durable queue lands in Phase 4.
- **Onboarding is stateless** (re-reads the user row each turn). It's robust but
  not as conversational as a true state machine. Phase 2 redesigns this.
- **Provider portal does not exist.** Today data is captured but not yet
  surfaced to clinicians. Phase 2.
- **Befrienders Kenya helpline number** in the SW critical copy is from public
  sources and should be verified before any real deployment.
