# Amaaii — Phase 0 Stabilization Spec

**Status:** Ready for implementation
**Scope:** POC stabilization only (Phase 0 of a 5-phase plan)
**Intended orchestrator:** Superpowers plugin for Claude Code
**Document owner:** Architect
**Last updated:** 2026-04-18

---

## 0. How to use this document with Superpowers

This spec is written as the **design-document input** to the Superpowers workflow. The Socratic brainstorming has already happened (across prior architecture conversations); this document captures the conclusions.

Recommended workflow in Claude Code:

1. Start a fresh Claude Code session in the Amaaii repo.
2. Paste or reference this file as context.
3. Invoke `/superpowers:write-plan` referencing this spec as the approved design.
4. Review the generated plan per workstream (see §7) — each workstream should map to one git worktree.
5. Invoke `/superpowers:execute-plan` per workstream, in the sequence defined in §8.
6. Between workstreams, ensure the merge gate in §11 passes before starting the next.

The `using-git-worktrees`, `test-driven-development`, `requesting-code-review`, and `finishing-a-development-branch` skills are expected to activate automatically; this spec is written assuming they will.

---

## 1. Context & background

Amaaii is a WhatsApp-based maternal health companion for pregnant and postpartum mothers in Kenya. A working proof-of-concept exists (Node.js / Express / SQLite / OpenAI GPT-3.5 / Twilio WhatsApp sandbox) with:

- User onboarding via free-text
- Danger-sign detection (regex-based)
- Daily journal state machine (in-memory sessions)
- OpenAI-backed conversational responses
- Conversation and symptom persistence

The POC proves the concept but carries real defects that must be resolved before any capability expansion or architectural refactor. Those defects are catalogued in §4.

Phase 0 is **stabilization only**: fix correctness, privacy, and security bugs on the existing codebase without restructuring it. Phase 1 (monorepo, TypeScript, layered architecture) starts from a clean Phase 0 baseline and is out of scope here.

---

## 2. Goals & non-goals

### Goals

- Eliminate false-positive danger-sign escalations that damage user trust.
- Remove PII leakage via logs and enforce webhook authenticity.
- Make journal sessions durable across process restarts.
- Persist the onboarding name-capture step correctly.
- Delete dead code paths and fix parser bugs that produce incorrect journal data.
- Introduce a test runner and a smoke-test harness that will carry forward into later phases.
- Produce a green-test baseline that Phase 1 can build on.

### Non-goals (explicitly deferred)

- Monorepo restructuring, TypeScript migration, ESM conversion — Phase 1.
- Swapping OpenAI for another LLM provider (we confirmed OpenAI for Phase 0).
- PWA client — Phase 2.
- PostgreSQL migration — Phase 5 / production.
- Twilio Business API onboarding (stays in sandbox) — Phase 4+.
- Consent / audit log / DPA surface — Phase 3.
- Any feature work (ANC reminders, PMTCT pathway, community, Kiswahili, etc.) — v1.1+.

If a Superpowers subagent proposes work outside these goals, it is out of scope. Reject and continue.

---

## 3. Roadmap at a glance

| Phase | Title | Scope | Target |
|-------|-------|-------|--------|
| 0 | Stabilization | **This spec.** Bug fixes + test harness. | 1–2 weeks |
| 1 | Architectural refactor | Monorepo, TypeScript, `core`/`adapters`/`server` layering, LLM redaction layer. | 2–3 weeks |
| 2 | PWA v1 | Next.js client, OTP auth, structured journal, trend charts, offline sync. | 3–4 weeks |
| 3 | DPA compliance surface | Consent screens, audit log, data export/deletion, privacy policy. | 1 week |
| 4 | Pilot hardening | Durable job queue, health checks, rate limits, observability. | 1 week |

[Speculation — ranges assume solo part-time hours.]

---

## 4. Current-state audit — defects addressed in Phase 0

Evidence gathered from a full-repo read (see Appendix A). Each defect is mapped to a workstream in §7.

### 4.1 Correctness — danger-sign detection

| ID | Defect | Evidence |
|----|--------|----------|
| D1 | `/bleeding\|spotting\|blood/i` matches "blood pressure", "blood test" — false-positive HIGH escalations. | `services/dangerSigns.js` HIGH tier pattern. |
| D2 | `/tired\|exhausted\|fatigue\|no energy/i` matches "tired of waiting" — false-positive MODERATE. | `services/dangerSigns.js` MODERATE tier pattern. |
| D3 | `/discharge\|leaking\|fluid/i` matches "drinking fluids" — false-positive MODERATE. | Same file, MODERATE tier. |
| D4 | Two parallel danger-sign detectors exist (`services/dangerSigns.js#detectDangerSigns` used; `services/amaaii.js#analyzeForDangerSigns` dead) — rule-drift risk. | §17 of audit. |

### 4.2 Correctness — onboarding & journal flow

| ID | Defect | Evidence |
|----|--------|----------|
| D5 | First-turn "What's your name?" reply is not persisted — branch returns prompt but next turn only saves age. | `utils/messageHandler.js#handleOnboarding`. |
| D6 | Onboarding is invoked only in the low/moderate urgency branch — any MODERATE/HIGH false positive (see D1–D3) stalls data collection. | `utils/messageHandler.js` priority ordering. |
| D7 | Journal sessions live in an in-process `Map` — lost on restart, incoherent across channels. | `services/journalManager.js#journalSessions`. |
| D8 | Sleep-quality parser captures the first digit, conflating quality and hours ("6 hours, 7/10" → quality=6). | `case 'sleep'` in `processJournalResponse`. |
| D9 | Appetite parser: `.includes('no')` after `.includes('good')` produces wrong tags for "no good appetite" and "not poor". | `case 'appetite'` in `processJournalResponse`. |
| D10 | `extractWeeklySymptoms` `JSON.parse`s text that may be raw user input — silent try/catch swallows the error. | `services/journalManager.js`. |

### 4.3 Privacy & security

| ID | Defect | Evidence |
|----|--------|----------|
| D11 | PII (phone, name, location, message body) logged to stdout every turn. | `server.js:17`, `utils/messageHandler.js:10,15,64`. |
| D12 | No Twilio signature validation on `POST /webhook` — forged requests can trigger outbound sends. | `server.js`. |
| D13 | `amaaii.db` tracked in git with whatever test data was last written. | No `.gitignore` present for DB files. |
| D14 | `updateUser` interpolates `Object.keys(updates)` into SQL — safe via current callers (`validFields` filter in `userManager`) but unguarded at the DB layer. | `services/database.js#updateUser`. |
| D15 | `createUser` uses `INSERT OR REPLACE`, which nulls fields not passed. Mitigated today by the `getOrCreateUser` guard, but brittle. | `services/database.js#createUser`. |

### 4.4 Dead code & hygiene

| ID | Defect | Evidence |
|----|--------|----------|
| D16 | `services/openai.js` superseded by `services/amaaii.js`, still exported. | §12 of audit. |
| D17 | `services/amaaii.js#analyzeForDangerSigns` has no callers. | §18 of audit. |
| D18 | `JOURNALING_PROMPT` in `services/amaaii.js` is unreachable — journal flow never reaches the LLM path. | §18 of audit. |
| D19 | `Math.random() < 0.3` reminder suffix makes conversation replay non-deterministic. | `utils/messageHandler.js`. |
| D20 | `setTimeout(..., 3600000)` in-process follow-up is lost on restart; also ignores Twilio's 24-hour window. | `utils/messageHandler.js`. |

**D20** is noted but deferred: replacing it requires a durable job queue, which lands in Phase 4. In Phase 0 we document the limitation and leave the code in place with an explicit inline comment. (Justification: fixing D20 properly expands scope beyond stabilization. A half-fix would be worse than the current behavior.)

---

## 5. Technical decisions (locked)

| Decision | Value | Rationale |
|----------|-------|-----------|
| LLM provider | OpenAI (Phase 0 only; revisit in Phase 1) | Keep POC's provider; no paperwork churn mid-stabilization. |
| Language (Phase 0) | JavaScript (existing); new utilities added in JS. | TS migration is Phase 1; don't mix concerns. |
| Package manager | pnpm | Confirmed by owner. |
| Test runner | Vitest + supertest | Works with JS and later TS; fast; minimal config. |
| DB | SQLite via `sqlite3` (existing driver) | No driver change in Phase 0. `better-sqlite3` migration deferred to Phase 1. |
| Hosting | Deferred | Not blocking Phase 0. |
| Git branching | One feature branch per workstream; each merges to `main` before the next starts. | Linear history, simpler review. |
| Branch naming | `<workstream-name>` — no mention of Claude, Superpowers, or AI agents. | Owner preference. |
| Commit style | Conventional Commits (`fix:`, `chore:`, `feat:`, `test:`). | Standard. |
| Worktree strategy | One git worktree per workstream (Superpowers `using-git-worktrees` skill). | Parallel development, clean isolation. |

---

## 6. Architecture principles (applicable to Phase 0)

Phase 0 does **not** restructure the codebase. It does, however, establish conventions that Phase 1 will harden:

1. **PII never leaves the process untagged.** Every outbound boundary (logs, LLM calls, HTTP clients) runs through a redaction step. Phase 0 introduces the logger redaction; Phase 1 adds the LLM redaction.
2. **Triage is deterministic, never LLM-driven.** Danger-sign classification is rule-based. The LLM generates supportive language around a deterministic triage result, never the triage itself.
3. **Critical/high urgency bypasses the LLM.** Canned, reviewable copy. This is already the POC's behavior and we preserve it.
4. **Tests before fixes.** RED first. Every Phase 0 fix has a failing test that captures the defect as a regression probe.
5. **Evidence over claims.** A workstream is not "done" until the smoke test in its section passes and the merge gate in §11 passes.

---

## 7. Phase 0 workstreams

Six workstreams, six feature branches. Each workstream is self-contained, testable, and mergeable independently in the order specified in §8.

Every workstream section includes: **Branch**, **Purpose**, **Files touched**, **Tasks**, **Tests (RED first)**, **Smoke test**, **Acceptance criteria**.

---

### 7.1 Workstream — `repo-hygiene`

**Branch:** `repo-hygiene`
**Purpose:** Establish the test runner, smoke-test harness, and repo hygiene needed by every subsequent workstream. Addresses **D13**.

**Files touched:**
- `.gitignore` (new)
- `.env.example` (new)
- `package.json` (modified)
- `tests/smoke.test.js` (new — placeholder)
- `scripts/smoke/README.md` (new)
- `scripts/smoke/00-server-boot.sh` (new)

**Tasks:**
1. Create `.gitignore` covering: `node_modules/`, `*.db`, `*.db-journal`, `.env`, `.env.local`, `.DS_Store`, `coverage/`, `dist/`, `.vitest-cache/`.
2. Remove `amaaii.db` from tracking via `git rm --cached amaaii.db` (preserves local copy; no history rewrite).
3. Create `.env.example` with every env var referenced in code, one per line, each with a short comment. No real values.
4. Convert `package-lock.json` to `pnpm-lock.yaml` via `pnpm import`, then delete `package-lock.json`.
5. Add devDependencies: `vitest`, `supertest`.
6. Add npm scripts: `"test": "vitest run"`, `"test:watch": "vitest"`.
7. Create `tests/` with a placeholder `smoke.test.js` that asserts `1 + 1 === 2`. Proves the runner boots.
8. Create `scripts/smoke/` with a README explaining the harness.
9. Create `scripts/smoke/00-server-boot.sh` (the first real smoke script — see below).

**Tests (RED first):**
- `tests/smoke.test.js` — trivial assertion; RED is the missing vitest install.

**Smoke test:** `scripts/smoke/00-server-boot.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
rm -f amaaii.db
pnpm start &
SERVER_PID=$!
sleep 2
curl -fsS http://localhost:3000/ | grep -q "WhatsApp Pregnancy Bot Server is running!"
kill $SERVER_PID
test -f amaaii.db   # DB was auto-recreated
echo "PASS: server boot + db auto-create"
```

**Acceptance criteria:**
- `pnpm install` exits 0.
- `pnpm test` exits 0 (placeholder test passes).
- `git check-ignore amaaii.db` prints the filename.
- `scripts/smoke/00-server-boot.sh` prints `PASS`.
- No application code in `services/` or `utils/` has been modified.

---

### 7.2 Workstream — `pii-and-webhook`

**Branch:** `pii-and-webhook`
**Purpose:** Plug the two most severe privacy/security holes. Addresses **D11, D12**.

**Files touched:**
- `utils/logger.js` (new)
- `middleware/twilioSignature.js` (new)
- `server.js`, `utils/messageHandler.js`, `utils/userManager.js`, `services/database.js`, `services/amaaii.js`, `services/dangerSigns.js`, `services/journalManager.js`, `services/twilio.js` (all `console.*` calls swapped for logger)
- `.env.example` (add `TWILIO_SIGNATURE_ENFORCE`)
- `tests/logger.test.js` (new)
- `tests/webhookSignature.test.js` (new)
- `scripts/smoke/02-pii-and-webhook.sh` (new)

**Tasks:**
1. Implement `utils/logger.js` exporting `{ log }` with `info(msg, ctx)`, `warn(msg, ctx)`, `error(msg, err, ctx)`. Redaction rules:
   - Any string matching `whatsapp:\+\d+` or `\+\d{10,}` → `[PHONE]`.
   - Values of keys matching (case-insensitive) `name`, `location`, `body`, `profilename`, `message` → `[REDACTED]`.
   - Nested objects traversed recursively. Arrays handled.
   - Non-PII keys (e.g. `urgencyLevel`, `stage`) pass through unchanged.
2. Replace every `console.log|warn|error` in the application with the new logger. Logger's own fallback path may use `console.error`.
3. Implement `middleware/twilioSignature.js`:
   - Uses `twilio.validateRequest(authToken, signature, url, params)`.
   - Respects `X-Forwarded-Proto` when behind a proxy.
   - Enforcement controlled by env `TWILIO_SIGNATURE_ENFORCE` (default: enforce if `NODE_ENV=production`, warn-only otherwise).
   - On failure in enforce mode: respond 403, log a redacted warning, do not call the handler.
4. Mount middleware on `POST /webhook` only.
5. Add `TWILIO_SIGNATURE_ENFORCE` to `.env.example`.

**Tests (RED first):**

`tests/logger.test.js`:
- Redacts `whatsapp:+254797437715` → `[PHONE]` in message strings.
- Redacts `+254797437715` bare → `[PHONE]`.
- Redacts `{ name: "Grace" }` → `{ name: "[REDACTED]" }` in ctx.
- Redacts `{ Body: "hello" }` → `{ Body: "[REDACTED]" }`.
- Does not redact `{ urgencyLevel: "high", stage: "mood" }`.
- Traverses nested: `{ user: { name: "G", age: 26 } }` → `{ user: { name: "[REDACTED]", age: 26 } }`.

`tests/webhookSignature.test.js` (supertest against the Express app):
- `NODE_ENV=production`, no signature → 403.
- `NODE_ENV=production`, valid signature → 200.
- `TWILIO_SIGNATURE_ENFORCE=false`, no signature → 200 (warn logged).

**Smoke test:** `scripts/smoke/02-pii-and-webhook.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail

LOG=$(mktemp)
TWILIO_SIGNATURE_ENFORCE=true NODE_ENV=production pnpm start > "$LOG" 2>&1 &
SID=$!
sleep 2
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -d "From=whatsapp:+254797437715" -d "Body=hello" -d "ProfileName=Test" \
  http://localhost:3000/webhook)
kill $SID || true
[ "$code" = "403" ] || { echo "FAIL: expected 403 without signature, got $code"; exit 1; }

LOG2=$(mktemp)
TWILIO_SIGNATURE_ENFORCE=false pnpm start > "$LOG2" 2>&1 &
SID=$!
sleep 2
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -d "From=whatsapp:+254797437715" -d "Body=hello" -d "ProfileName=Test" \
  http://localhost:3000/webhook)
kill $SID || true
[ "$code" = "200" ] || { echo "FAIL: expected 200 with enforce=false, got $code"; exit 1; }

if grep -q "+254797437715" "$LOG2" || grep -q "ProfileName=Test" "$LOG2"; then
  echo "FAIL: PII leaked to logs"; exit 1
fi
grep -q "\[PHONE\]\|\[REDACTED\]" "$LOG2" || { echo "FAIL: no redaction tokens in logs"; exit 1; }

echo "PASS: pii-and-webhook"
```

**Acceptance criteria:**
- `pnpm test` green.
- Smoke test prints `PASS`.
- `grep -rn "console\." server.js utils/ services/ middleware/` returns only occurrences inside `utils/logger.js`.

---

### 7.3 Workstream — `danger-sign-regex`

**Branch:** `danger-sign-regex`
**Purpose:** Eliminate false-positive escalations and establish a golden-set test that prevents regression. Addresses **D1, D2, D3**.

**Files touched:**
- `services/dangerSigns.js` (rewrite patterns)
- `tests/dangerSigns.test.js` (new)
- `tests/fixtures/danger-signs-golden.json` (new)
- `scripts/smoke/03-danger-signs.sh` (new)

**Tasks:**
1. Rewrite patterns in `services/dangerSigns.js` with these rules:
   - Use `\b` word boundaries around every keyword.
   - Remove bare `blood` from HIGH tier. Keep `bleeding`, `blood clots`, `gushing blood`, `soaking (a )?pad`.
   - `tired|exhausted|fatigued` only match when preceded by a pronoun or a symptom verb (`feel(ing)?`, `am`, `so`, `very`, `extremely`), AND not followed by `of` (to exclude "tired of X").
   - `fluid|leaking` require contextual prefix (`gushing`, `losing`, `watery`) or suffix (`from vagina`, `down my legs`).
   - `discharge` requires a qualifier: `vaginal`, `unusual`, `thick`, `foul`, `smelly`, OR the word appears as a standalone clause (not embedded in other words).
   - All other symptom patterns get `\b` boundaries.
2. Create `tests/fixtures/danger-signs-golden.json`: an array of `{ message, expected_urgency, expected_signs, note }`. Minimum 60 entries covering:
   - 10 true CRITICAL positives.
   - 10 true HIGH positives.
   - 10 true MODERATE positives.
   - 15 "low" negatives (benign messages containing words that used to false-positive).
   - 15 adversarial edge cases (compound symptoms, negations, typos, mixed case).
3. `tests/dangerSigns.test.js` loads the golden set and asserts exact match on `urgencyLevel` for every entry.
4. **At least these negatives MUST be in the golden set and MUST resolve to `low`:**
   - `"my blood pressure was fine at the clinic"`
   - `"I'm tired of waiting for my ANC appointment"`
   - `"I've been drinking fluids all day"`
   - `"the blood test came back good"`
   - `"not feeling too tired today, actually"`

**Tests (RED first):**
- Write `tests/dangerSigns.test.js` **first** using the existing (buggy) regexes. Watch the negatives above FAIL with the current code. That is the RED.
- Then rewrite patterns. All golden entries must pass.

**Smoke test:** `scripts/smoke/03-danger-signs.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
node -e "
const { detectDangerSigns } = require('./services/dangerSigns');
const cases = [
  ['my blood pressure was fine at the clinic', 'low'],
  [\"I'm tired of waiting for my ANC appointment\", 'low'],
  [\"I've been drinking fluids all day\", 'low'],
  ['severe headache and seeing spots', 'critical'],
  ['I am bleeding heavily', 'critical'],
  ['I feel so tired and exhausted', 'moderate'],
];
let failed = 0;
for (const [msg, expected] of cases) {
  const { urgencyLevel } = detectDangerSigns(msg);
  if (urgencyLevel !== expected) {
    console.error('FAIL:', JSON.stringify(msg), '-> got', urgencyLevel, 'expected', expected);
    failed++;
  }
}
if (failed) process.exit(1);
console.log('PASS: danger-signs smoke');
"
```

**Acceptance criteria:**
- `pnpm test` green; all 60+ golden entries pass.
- Smoke test prints `PASS`.
- No regression on any previously-working CRITICAL or HIGH case.

---

### 7.4 Workstream — `onboarding-order`

**Branch:** `onboarding-order`
**Purpose:** Onboarding must run regardless of moderate/high urgency unless the urgency is CRITICAL. Also fixes the unsaved-name bug. Addresses **D5, D6**.

**Files touched:**
- `utils/messageHandler.js` (branch ordering, name persistence)
- `tests/messageHandler.test.js` (new)
- `scripts/smoke/04-onboarding-order.sh` (new)

**Tasks:**
1. In `handleIncomingMessage`, change the routing order so:
   - **CRITICAL** urgency always short-circuits to the canned escalation (no change).
   - **Otherwise**, if `userContext.needsOnboarding`, run onboarding even when urgency is HIGH or MODERATE. The canned escalation copy for HIGH/MODERATE can still be appended to the onboarding prompt, but onboarding state must be captured.
2. In `handleOnboarding`, fix the first turn:
   - On the very first turn with a user whose `name` is null, the expected behavior is: bot asks "What's your name?" and persists whatever arrives next as the name.
   - Current code reaches "What's your name?" but the next inbound message is treated as "are we in the age branch?" because the `if (!user.name)` check runs again and `user.name` is still null. Fix by introducing a stateless signal: if `user.name` is null AND the bot's most recent outbound message was the name-prompt, persist the current message as `name`. Use the `conversations` table to look up the last bot message.
3. Ensure `handleOnboarding` is idempotent on reruns — multiple rapid messages must not break the progression.

**Tests (RED first):**

`tests/messageHandler.test.js` (mock Twilio send, in-memory SQLite):
- New user sends "I have a headache" as first message → bot responds with onboarding name-prompt (not a moderate-urgency response). RED on current code.
- New user sends "Hi" → bot responds with name-prompt.
- User replies "Grace" → `users.name = 'Grace'` in DB. RED on current code.
- Grace replies "26" → `users.age = 26`. 
- Grace replies "20 weeks" → `users.pregnancy_week = 20`, `users.edd` populated.
- User who has completed onboarding and sends "severe bleeding" → CRITICAL escalation (unchanged behavior).

**Smoke test:** `scripts/smoke/04-onboarding-order.sh`
End-to-end script that starts the server with `TWILIO_SIGNATURE_ENFORCE=false`, sends 4 scripted messages for a fresh phone number via curl, and asserts that after the 4 messages the `users` row has `name`, `age`, `pregnancy_week`, and `location` all populated. See §13 for the helper `smoke/lib/send.sh`.

**Acceptance criteria:**
- `pnpm test` green.
- Smoke test confirms complete onboarding for a fresh user.
- An un-onboarded user who types "tired" on turn 1 still gets asked for their name.

---

### 7.5 Workstream — `journal-persistence`

**Branch:** `journal-persistence`
**Purpose:** Persist journal session state so restarts don't break mid-journal flows. Addresses **D7**.

**Files touched:**
- `services/database.js` (new table + CRUD)
- `services/journalManager.js` (replace in-memory Map with DB calls)
- `tests/journalManager.test.js` (new)
- `scripts/smoke/05-journal-persistence.sh` (new)

**Tasks:**
1. Add `journal_sessions` table in `initializeDatabase`:
   ```sql
   CREATE TABLE IF NOT EXISTS journal_sessions (
     user_phone TEXT PRIMARY KEY,
     current_stage TEXT NOT NULL,
     journal_data TEXT NOT NULL,
     channel TEXT NOT NULL DEFAULT 'whatsapp',
     started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     FOREIGN KEY (user_phone) REFERENCES users(phone_number)
   );
   ```
   `journal_data` stores the partial journal as JSON (the same shape currently held in `session.journalData`).
2. Add repository functions to `services/database.js`:
   - `getJournalSession(userPhone)` — returns `{ current_stage, journal_data, channel }` or `null`.
   - `upsertJournalSession(userPhone, { currentStage, journalData, channel })`.
   - `deleteJournalSession(userPhone)`.
3. Refactor `services/journalManager.js`:
   - Remove the `journalSessions` Map entirely.
   - Every method reads/writes via the repository functions.
   - `getJournalSession` becomes async.
   - Call sites in `messageHandler.js` updated to `await`.
4. Ensure session is deleted when `nextStage === 'completed'`.
5. Add an index: `CREATE INDEX IF NOT EXISTS idx_journal_sessions_updated ON journal_sessions(updated_at);` — supports future cleanup jobs.

**Tests (RED first):**

`tests/journalManager.test.js` (in-memory SQLite, no mocking of the state machine):
- Start a journal for user A. Assert `journal_sessions` row exists with `current_stage = 'mood'` after the greeting response.
- Simulate a process restart by re-requiring the module. Continue the flow with user A's next message. Assert stage advances correctly.
- Complete the full flow. Assert `journal_sessions` row is deleted and a `journals` row is `completed = 1`.
- Two concurrent users (A and B) keep independent sessions.

**Smoke test:** `scripts/smoke/05-journal-persistence.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail

# Assumes 04-onboarding-order smoke has been run first for phone +254700000001
# so the user is already onboarded.

source scripts/smoke/lib/send.sh

PHONE="whatsapp:+254700000099"
# Pre-seed user (bypass onboarding for this smoke)
sqlite3 amaaii.db "INSERT OR REPLACE INTO users (phone_number, name, age, pregnancy_week, location) VALUES ('$PHONE', 'TestUser', 28, 24, 'Nairobi');"

TWILIO_SIGNATURE_ENFORCE=false pnpm start > /tmp/amaaii-server.log 2>&1 &
SID=$!
sleep 2

send "$PHONE" "journal"
send "$PHONE" "7"           # mood 7/10
send "$PHONE" "none"        # symptoms
# Restart server mid-flow
kill $SID
wait $SID 2>/dev/null || true
TWILIO_SIGNATURE_ENFORCE=false pnpm start > /tmp/amaaii-server-2.log 2>&1 &
SID=$!
sleep 2

send "$PHONE" "8/10, 7 hours"  # sleep
# ... continue rest of flow

STAGE=$(sqlite3 amaaii.db "SELECT current_stage FROM journal_sessions WHERE user_phone = '$PHONE';")
kill $SID || true

[ "$STAGE" != "" ] || { echo "FAIL: no journal session persisted"; exit 1; }
echo "PASS: journal session survives restart ($STAGE)"
```

**Acceptance criteria:**
- `pnpm test` green.
- Smoke test confirms a mid-journal state survives a server restart.
- `grep -n "journalSessions" services/journalManager.js` returns no matches (the Map is gone).

---

### 7.6 Workstream — `dead-code-and-parsers`

**Branch:** `dead-code-and-parsers`
**Purpose:** Delete dead paths and fix the small parser bugs. Addresses **D4, D8, D9, D10, D14, D15, D16, D17, D18, D19**.

**Files touched:**
- `services/openai.js` (delete)
- `services/amaaii.js` (remove `analyzeForDangerSigns` export and its usage; keep `JOURNALING_PROMPT` only if we wire it in, else delete it too)
- `services/journalManager.js` (fix sleep and appetite parsers; safer JSON parse)
- `services/database.js` (rework `createUser` to real INSERT + UPDATE; reject non-whitelisted keys in `updateUser`)
- `utils/messageHandler.js` (remove `Math.random()` reminder suffix; replace with a deterministic rule: "remind if no journal today AND not already reminded this session")
- `tests/parsers.test.js` (new)
- `tests/database.test.js` (new)
- `scripts/smoke/06-parsers-and-upsert.sh` (new)

**Tasks:**
1. Delete `services/openai.js`.
2. Remove `analyzeForDangerSigns` and `getDangerSignResponse` from `services/amaaii.js` exports — verify no callers via `grep`.
3. Decide on `JOURNALING_PROMPT` and `MENTAL_HEALTH_PROMPT`:
   - `JOURNALING_PROMPT` is unreachable → delete.
   - `MENTAL_HEALTH_PROMPT` is reachable via `checkIfMentalHealth` → keep.
4. Sleep parser fix: parse in order — look for `(\d+)\s*(?:\/|out of)\s*10` as quality; `(\d+(?:\.\d+)?)\s*h(?:ours?)?` as hours. Quality and hours are independent captures.
5. Appetite parser fix: rewrite as a priority ladder — if the message contains the token "poor" or "no appetite" (exact phrase), → poor; else if "moderate" or "okay" → moderate; else if "good" or "great" → good; else default to moderate. No substring mis-hits.
6. `extractWeeklySymptoms`: detect whether `physical_symptoms` starts with `[` before `JSON.parse`. Never silently swallow.
7. `database.js#createUser`: replace `INSERT OR REPLACE` with a transaction: if a row exists, `UPDATE` only the provided fields; otherwise `INSERT`. Preserves fields not in the payload.
8. `database.js#updateUser`: whitelist keys at the DB layer too (defense in depth). Reject unknown keys with an Error.
9. Remove `Math.random() < 0.3` journal-reminder suffix. Replace with deterministic rule: append the reminder if and only if `getTodaysJournal(userPhone)` returns null AND the previous conversation turn (from DB) did not already contain the reminder marker.

**Tests (RED first):**

`tests/parsers.test.js`:
- Sleep: `"7/10, 6 hours"` → `{ quality: 7, hours: 6 }`. RED on current code.
- Sleep: `"6 hours, 7/10"` → `{ quality: 7, hours: 6 }`.
- Sleep: `"slept 8h"` → `{ hours: 8 }`.
- Appetite: `"no good appetite"` → `poor`. RED on current code.
- Appetite: `"not poor at all"` → `moderate` (explicitly not `poor`). RED on current code.
- Appetite: `"good"` → `good`.

`tests/database.test.js`:
- `createUser(phone, { name: 'A', age: 25 })` twice with different payloads preserves fields across calls.
- `updateUser(phone, { malicious_field: "x" })` throws.

**Smoke test:** `scripts/smoke/06-parsers-and-upsert.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
node -e "
const db = require('./services/database');
(async () => {
  await db.initializeDatabase();
  const phone = 'whatsapp:+254700000098';
  await db.createUser(phone, { name: 'Alpha', age: 30 });
  await db.createUser(phone, { location: 'Nairobi' });   // partial update
  const u = await db.getUser(phone);
  if (u.name !== 'Alpha' || u.age !== 30 || u.location !== 'Nairobi') {
    console.error('FAIL upsert:', u); process.exit(1);
  }
  console.log('PASS: parsers-and-upsert');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
"
```

**Acceptance criteria:**
- `pnpm test` green.
- Smoke test prints `PASS`.
- `services/openai.js` does not exist.
- `grep -rn "analyzeForDangerSigns" services/ utils/` returns no matches.

---

## 8. Sequencing & dependency graph

```
repo-hygiene
    │
    ├─► pii-and-webhook
    │       │
    │       ├─► danger-sign-regex
    │       │       │
    │       │       └─► onboarding-order
    │       │               │
    │       │               └─► journal-persistence
    │       │                       │
    │       │                       └─► dead-code-and-parsers
```

- **Strictly linear.** Each workstream merges to `main` before the next starts.
- `repo-hygiene` unblocks everything (installs the test runner).
- `pii-and-webhook` is independent of domain logic; lands early to prevent PII leaks during subsequent debugging.
- `danger-sign-regex` must land before `onboarding-order` because the tests in 7.4 depend on the corrected urgency classifier.
- `onboarding-order` must land before `journal-persistence` because the persistence tests assume a fully-onboarded user flow.
- `dead-code-and-parsers` is last — it's a cleanup workstream whose tests depend on the corrected state machine.

---

## 9. Git workflow & conventions

- **Worktrees.** One worktree per active workstream via Superpowers' `using-git-worktrees` skill. Never work on two branches in the same working copy.
- **Branch naming.** `<workstream-name>` exactly as in §7 headings. No prefixes like `feat/`, no mention of Claude, Superpowers, or AI.
- **Commits.** Conventional Commits. `fix(danger-signs): tighten blood-pressure false positive`. `chore(repo): gitignore the sqlite db`. Max subject 72 chars.
- **Commit granularity.** One logical change per commit. Tests and the implementation that makes them green can be one commit (RED → GREEN in the diff) or two (tests red in commit N, implementation in commit N+1) — both acceptable; be consistent within a workstream.
- **PR / merge.** If GitHub is in play, open a PR per workstream. If not, merge locally with `--no-ff` to preserve the branch shape in history.
- **No force-pushes to `main`.** Force-pushes within a feature branch are fine until it merges.

---

## 10. TDD requirements

The Superpowers `test-driven-development` skill enforces RED-GREEN-REFACTOR. This spec complies with that and adds project-specific rules:

1. **Every defect in §4 has a failing test that captures it first.** The test is committed in a state that demonstrates RED against the current code. The fix commit(s) turn it GREEN.
2. **Golden-set tests over synthetic ones.** For danger-sign detection, build a fixture file (`tests/fixtures/danger-signs-golden.json`) the whole test suite iterates over. Easier to extend, easier to review.
3. **No mocking of the state machine.** Journal tests use an in-memory SQLite (`:memory:`) and exercise the real flow.
4. **Mock the outbound Twilio boundary.** All tests that trigger `sendWhatsAppMessage` stub it to a no-op that records the last outbound message for assertion.
5. **Never mock the LLM in Phase 0.** For any test that would otherwise call OpenAI, isolate via dependency injection: tests pass a stub `getAmaaiiResponse` through a setter or via an env flag. No real network calls in CI.
6. **Coverage target.** 100% on `services/dangerSigns.js`, `services/journalManager.js`, and new modules introduced by Phase 0. Other files best-effort.

---

## 11. Verification protocol (the merge gate)

A workstream is **done** when all of these are true. Do not merge otherwise.

1. `pnpm test` exits 0.
2. The workstream's smoke script in `scripts/smoke/` prints `PASS`.
3. `scripts/smoke/00-server-boot.sh` still prints `PASS` (no regression on the foundational smoke).
4. `grep -rn "console\.\(log\|warn\|error\)" server.js utils/ services/ middleware/` returns only expected occurrences (logger internals). This is a standing check from workstream 2 onward.
5. `git status` is clean.
6. Workstream's acceptance criteria in §7 are all met.
7. Superpowers' `requesting-code-review` skill has run and reports no Critical-severity issues.
8. Superpowers' `finishing-a-development-branch` skill has been invoked and reports tests green.

If any check fails, the workstream goes back into implementation. Do not merge partially-passing work.

---

## 12. Guardrails & constraints

**Do not, in Phase 0:**

- Migrate to TypeScript, ESM, a monorepo, or Postgres. [Deferred: Phase 1+.]
- Introduce a durable job queue or replace `setTimeout` for follow-ups. [Deferred: Phase 4.]
- Add new product features (ANC reminders, community, Kiswahili translations, PMTCT). [Deferred: v1.1+.]
- Change the LLM provider or model. [Deferred: Phase 1.]
- Rewrite prompts. Minor edits for safety / consistency are fine; rewrites require a separate spec.
- Refactor surrounding code beyond what is needed for the defect being fixed.
- Soften the existing safety rules in `amaaii_ai_prompts_guardrails.md` or `services/amaaii.js`.

**Must, in Phase 0:**

- Preserve the CRITICAL/HIGH canned-escalation behavior. The LLM never decides urgency.
- Keep phone numbers as the user PK. No synthetic IDs yet.
- Preserve the guardrails doc as the source of truth for system-prompt doctrine.

**Branch naming rule (owner preference):** branch names are `<feature-name>` only. No `claude/`, `ai/`, `bot/`, `agent/` prefixes. If a subagent proposes such a name, rename before committing.

---

## 13. Smoke test harness

All smoke tests live in `scripts/smoke/` and follow the convention `NN-<workstream>.sh`, matching §7 numbering. They are **shell scripts, not unit tests**, and exercise a running server.

### 13.1 Shared helpers — `scripts/smoke/lib/send.sh`

Created as part of workstream 7.4. A reusable function for POSTing a simulated Twilio payload:

```bash
# scripts/smoke/lib/send.sh
send() {
  local from="$1" body="$2"
  curl -sS -o /dev/null -w "%{http_code}\n" -X POST \
    -d "From=$from" -d "Body=$body" -d "ProfileName=SmokeTest" \
    http://localhost:3000/webhook
}
```

### 13.2 Running all smoke tests

```bash
# scripts/smoke/run-all.sh  (created during workstream 7.1)
for script in scripts/smoke/[0-9][0-9]-*.sh; do
  echo "=== $script ==="
  bash "$script" || { echo "FAILED: $script"; exit 1; }
done
echo "ALL SMOKE TESTS PASSED"
```

### 13.3 Claude Code usage pattern

After each workstream's implementation, the Superpowers `verification-before-completion` skill should run:
1. `pnpm test`
2. `bash scripts/smoke/<workstream-number>-*.sh`
3. `bash scripts/smoke/00-server-boot.sh` (regression)

Only then does `finishing-a-development-branch` proceed.

---

## 14. References

- Superpowers plugin: https://github.com/obra/superpowers
- Superpowers intro post: https://blog.fsck.com/2025/10/09/superpowers/
- Current POC audit: `CLAUDE.md` + audit §§3–18 in the architecture-review transcript
- System prompt doctrine: `amaaii_ai_prompts_guardrails.md`
- Kenya Data Protection Act, 2019 — applies from Phase 3 onward; Phase 0 merely avoids making things worse
- WHO maternal-health guidance: cited in `concept_note_Amaaii.pdf`
- Conventional Commits: https://www.conventionalcommits.org/

---

## Appendix A — POC file inventory (pre-Phase 0)

```
amaaii/
├── CLAUDE.md                         (kept, updated post-Phase-0)
├── CLAUDE_CODE_PROMPT.md             (deferred refactor spec — keep for Phase 1 reference)
├── README.md                         (kept; Phase 0 adds a "Testing" section)
├── amaaii_ai_prompts_guardrails.md   (kept; source of truth)
├── amaaii.db                         (removed from tracking in 7.1; regenerated locally)
├── package.json                      (updated in 7.1)
├── server.js                         (logger swap 7.2; middleware mount 7.2)
├── services/
│   ├── amaaii.js                     (trim dead exports 7.6)
│   ├── dangerSigns.js                (rewrite patterns 7.3)
│   ├── database.js                   (journal_sessions table 7.5; upsert fix 7.6)
│   ├── journalManager.js             (persistence 7.5; parser fixes 7.6)
│   ├── openai.js                     (deleted 7.6)
│   └── twilio.js                     (logger swap 7.2)
├── utils/
│   ├── messageHandler.js             (routing order 7.4; reminder fix 7.6; logger 7.2)
│   └── userManager.js                (logger 7.2)
├── middleware/
│   └── twilioSignature.js            (new 7.2)
├── tests/
│   ├── smoke.test.js                 (7.1)
│   ├── logger.test.js                (7.2)
│   ├── webhookSignature.test.js      (7.2)
│   ├── dangerSigns.test.js           (7.3)
│   ├── messageHandler.test.js        (7.4)
│   ├── journalManager.test.js        (7.5)
│   ├── parsers.test.js               (7.6)
│   ├── database.test.js              (7.6)
│   └── fixtures/
│       └── danger-signs-golden.json  (7.3)
└── scripts/
    └── smoke/
        ├── README.md                 (7.1)
        ├── run-all.sh                (7.1)
        ├── lib/
        │   └── send.sh               (7.4)
        ├── 00-server-boot.sh         (7.1)
        ├── 02-pii-and-webhook.sh     (7.2)
        ├── 03-danger-signs.sh        (7.3)
        ├── 04-onboarding-order.sh    (7.4)
        ├── 05-journal-persistence.sh (7.5)
        └── 06-parsers-and-upsert.sh  (7.6)
```

---

## Appendix B — Handoff checklist for the architect (you)

Before kicking off Phase 0:

- [ ] Confirm this spec is accurate and sign off.
- [ ] Install Superpowers in Claude Code: `/plugin marketplace add obra/superpowers-marketplace && /plugin install superpowers@superpowers-marketplace`.
- [ ] Restart Claude Code, verify the session-start hook injects.
- [ ] Run a Superpowers "hello world" to confirm the TDD skill auto-activates.
- [ ] In the Amaaii repo, ensure `main` is clean and pushed.
- [ ] Feed this spec file into the first session: "Read AMAAII_PHASE_0_SPEC.md. Use /superpowers:write-plan to produce a task plan for workstream 7.1 (repo-hygiene) only. Do not start on other workstreams yet."
- [ ] Review the generated plan, approve.
- [ ] Let Superpowers execute workstream 7.1.
- [ ] Verify merge gate (§11). Merge to `main`.
- [ ] Repeat for 7.2 through 7.6 in order.

Phase 1 spec will be produced after Phase 0 merges.

---

**End of spec.**
