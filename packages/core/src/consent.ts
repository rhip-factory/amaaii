// Pure consent domain logic (P3-A) — Kenya Data Protection Act
// compliance foundation. LOCKED product decision: two-tier consent, not
// three. 'data_processing' is REQUIRED — storing profile/journals/
// conversations is what makes the app function at all, so there is no
// meaningful "decline but keep using it" state for this purpose.
// 'ai_responses' is OPTIONAL — sending the user's messages to OpenAI for
// AI replies; declining it still leaves every deterministic feature
// (structured journaling, danger detection, canned replies) working.
// Cross-border transfer (the AI purpose's US-based processor) is
// DISCLOSED in the privacy notice, not a separate consent purpose —
// that's what keeps this a two-tier model instead of three.
//
// Everything here is deterministic given its inputs: no I/O, no
// Date.now(), no crypto, no randomness — same "pure given its inputs"
// discipline as otp.ts / dangerSigns.ts / redaction.ts elsewhere in this
// package. Callers pass in an already-reconstructed ConsentState (built
// from the append-only ledger via deriveConsentState below); nothing in
// this file talks to a database.
//
// P3-A scope note: this file is pure decision logic only. NOTHING here
// enforces anything — no route ever calls these functions yet. Wiring
// needsConsent()/canUseAi() into actual request handling (onboarding
// gate, /chat AI-vs-canned-reply branch, etc.) is P3-B. Danger-sign
// escalation in particular must NEVER be gated by any function in this
// file (vital interests override consent — see CLAUDE.md); that
// invariant is a P3-B wiring concern, but it's why needsConsent()/
// hasActiveConsent() are pure reads with no side effects of their own —
// a "no consent" state can never accidentally block a pure read of
// danger status just by existing.

/**
 * Bump this when the privacy notice's substantive content changes, to
 * force re-consent across the whole user base. Every decision function
 * below treats a ledger event recorded at a version OLDER than the
 * current CONSENT_VERSION as no longer active — even if it was granted
 * and never explicitly revoked — because the user never agreed to the
 * new notice text. This file only ever READS the constant; bumping it
 * (and deciding what "re-consent" UX that triggers) is a P3-B/product
 * concern, not something automated here.
 */
export const CONSENT_VERSION = 1;

/** The two consent purposes in the locked two-tier model. */
export type ConsentPurpose = 'data_processing' | 'ai_responses';

/**
 * Purposes the app cannot function without. Declining/revoking any of
 * these means the app has no lawful basis to keep operating for that
 * user (modulo the vital-interests exception for danger-sign
 * escalation, which is enforced independently of consent — see the file
 * header and CLAUDE.md).
 */
export const REQUIRED_PURPOSES: ConsentPurpose[] = ['data_processing'];

/**
 * Purposes the app degrades gracefully without. Declining one of these
 * turns off exactly the feature it names and nothing else.
 */
export const OPTIONAL_PURPOSES: ConsentPurpose[] = ['ai_responses'];

/**
 * One purpose's current status, already reconstructed from the ledger
 * (see deriveConsentState). Timestamps are ISO strings, not Date
 * objects, so this stays plain-JSON-serializable and never smuggles in
 * a clock.
 */
export interface ConsentPurposeState {
  purpose: ConsentPurpose;
  granted: boolean;
  version: number;
  grantedAt: string;
  revokedAt: string | null;
}

/**
 * Everything the app currently knows about a user's consents — at most
 * one entry per purpose (the reconstructed "latest event wins" view). A
 * purpose with no entry yet (brand-new user) is treated identically to
 * "not granted" by every function below; callers do not need to
 * pre-populate placeholder entries.
 */
export type ConsentState = ConsentPurposeState[];

function findPurpose(state: ConsentState, purpose: ConsentPurpose): ConsentPurposeState | undefined {
  return state.find((entry) => entry.purpose === purpose);
}

/**
 * True when `purpose` is in force right now: granted, not revoked, and
 * recorded at the current CONSENT_VERSION. A grant at an old version
 * does NOT count — that's the entire mechanism by which bumping
 * CONSENT_VERSION forces re-consent instead of silently grandfathering
 * everyone in.
 */
export function hasActiveConsent(state: ConsentState, purpose: ConsentPurpose): boolean {
  const entry = findPurpose(state, purpose);
  if (!entry) return false;
  return entry.granted && entry.revokedAt === null && entry.version === CONSENT_VERSION;
}

/**
 * Every REQUIRED purpose that is not currently active, in
 * REQUIRED_PURPOSES declaration order. Empty array means the user has
 * fully satisfied the required tier.
 */
export function missingRequired(state: ConsentState): ConsentPurpose[] {
  return REQUIRED_PURPOSES.filter((purpose) => !hasActiveConsent(state, purpose));
}

/**
 * True when the user still needs to go through consent before the app
 * can operate normally for them — covers all three ways a REQUIRED
 * purpose can be non-active: never consented (new user), revoked, or
 * consented at a stale version. This is a pure read: it does not gate
 * anything by itself, and must never be used to gate danger-sign
 * detection (see file header).
 */
export function needsConsent(state: ConsentState): boolean {
  return missingRequired(state).length > 0;
}

/**
 * True when the OPTIONAL ai_responses purpose is currently active — the
 * one switch P3-B's message routing checks before calling the LLM
 * chokepoint. False (not an error) is the correct, fully-supported
 * "keep using deterministic features" state.
 */
export function canUseAi(state: ConsentState): boolean {
  return hasActiveConsent(state, 'ai_responses');
}

/**
 * True when the user has SOME consent history that is now stale — at
 * least one purpose was actively granted (and never revoked) at a
 * version older than the current CONSENT_VERSION. This narrows
 * needsConsent()'s three causes down to just the "returning user, terms
 * changed" case, which is the one that wants distinct re-consent copy
 * ("we updated our privacy notice") instead of first-time-consent copy.
 * A purpose that was declined or revoked at an old version is NOT
 * "stale" by this definition — it's simply not granted, same as if it
 * had never been touched at all.
 */
export function isStale(state: ConsentState): boolean {
  return state.some(
    (entry) => entry.granted && entry.revokedAt === null && entry.version < CONSENT_VERSION
  );
}

/**
 * Minimal structural shape this module needs from one row of the
 * append-only consent ledger. Field names/types match ConsentRecord in
 * repositories.ts exactly, so a real ConsentRecord[] from
 * ConsentRepository#getConsents can be passed straight into
 * deriveConsentState below via structural typing — without this pure
 * module importing the repository-interfaces file (repositories.ts
 * already imports ConsentPurpose FROM this file; importing back would
 * make it circular for no benefit).
 */
export interface ConsentLedgerEvent {
  purpose: ConsentPurpose;
  granted: boolean | number;
  version: number;
  granted_at: string;
  revoked_at: string | null;
}

/**
 * Reconstructs a ConsentState from the raw append-only ledger: the
 * latest event per purpose wins. `events` must be ordered oldest-first
 * (e.g. by id or granted_at ascending — how
 * SqliteConsentRepository#getConsents returns them); this function does
 * not re-sort, so passing newest-first silently inverts which event
 * "wins" for a purpose with more than one row.
 */
export function deriveConsentState(events: ConsentLedgerEvent[]): ConsentState {
  const latestByPurpose = new Map<ConsentPurpose, ConsentLedgerEvent>();
  for (const event of events) {
    latestByPurpose.set(event.purpose, event);
  }
  return Array.from(latestByPurpose.values()).map((event) => ({
    purpose: event.purpose,
    granted: Boolean(event.granted),
    version: event.version,
    grantedAt: event.granted_at,
    revokedAt: event.revoked_at,
  }));
}
