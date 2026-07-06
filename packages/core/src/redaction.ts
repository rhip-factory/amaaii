// LLM / log redaction — pure, deterministic, regex-based text masking.
// This is the single source of truth for "what does personal data look
// like in free text" for BOTH outbound paths that can leak PII:
//   - utils/logger.js  (PII must never sit in stdout/stderr)
//   - packages/adapters/src/llm.ts (PII must never reach the OpenAI API)
// Previously each had its own copy of a phone regex; see CLAUDE.md's
// P1-D work package ("LLM redaction layer") for why they now share one.
//
// No I/O, no environment reads, nothing non-deterministic — every
// function here is a pure string -> string transform, safe to unit test
// with a golden fixture (tests/fixtures/redaction-golden.json) and safe
// to call from anywhere without side effects.
//
// ---------------------------------------------------------------------
// FIRST-NAME POLICY (load-bearing — read this before touching call sites)
// ---------------------------------------------------------------------
// The user's stored `name` column can be multi-word ("Grace Wanjiru").
// Exactly ONE piece of that is ever allowed to reach the OpenAI API in
// the clear: the FIRST TOKEN, and only inside a system-role prompt that
// OUR OWN CODE constructs (services/amaaii.js's USER_CONTEXT block says
// "Name: Grace", never "Name: Grace Wanjiru"). That first name is what
// lets replies read as personal ("Grace, that's normal at week 18...").
//
// This module has no concept of "system vs. user/assistant" — it just
// masks text. The trust decision belongs entirely to the chokepoint
// (packages/adapters/src/llm.ts#chat()): it must call redactForLLM() on
// every user/assistant message, and must NEVER run redaction over a
// system message it received (system content is our own code's trusted
// output, including the one deliberately-allowed first name — redacting
// it would just be masking our own prompt for no benefit).
//
// redactForLLM()/redactKnownName() mask the user's FULL stored name —
// deliberately MORE aggressive than the first-name allowance — because:
//   - a past assistant reply (now sitting in conversationHistory) may
//     already contain the full name if it was ever captured verbatim;
//   - the user's own message text can contain their full name freely
//     ("hi this is Grace Wanjiru").
// None of that should be replayed back into a fresh completion request
// unmasked, even though the current turn's system prompt is allowed to
// carry the first token alone.
//
// ---------------------------------------------------------------------
// ID-NUMBER DECISION (documented per work order — do not silently add
// standalone-number masking later without re-reading this)
// ---------------------------------------------------------------------
// Kenyan national ID numbers are commonly 7-8 bare digits with no
// distinguishing prefix, punctuation, or format — indistinguishable, by
// pattern alone, from a pregnancy week ("22"), an age ("34"), a mood
// score, a glasses-of-water count, a sleep-hours figure, or any of the
// countless other short numbers this bot handles constantly in free
// text. We looked for a regex-only heuristic (keyword lookbehind like
// "ID 12345678", punctuation context, etc.) and could not find one that
// didn't also risk false-positiving on ordinary health-tracking numbers
// or, worse, mangling a danger-sign sentence mid-triage. Given the
// explicit instruction to prefer skipping over guessing wrong on a
// safety-relevant path, standalone 7-8 digit numbers are NOT masked by
// this module. Only long digit runs (11+, effectively phone-shaped —
// e.g. a phone number typed with country code but no leading '+') are
// caught by the generic fallback below. If ID masking is ever required,
// it should be driven by an explicit labelled field (e.g. a structured
// "national_id" column) rather than a bare-number regex over free text.
//
// Also out of scope, for the same "don't guess" reason: phone numbers
// written with internal spaces or dashes ("0722 178 177", "0722-178-
// 177"). Handling that reliably without also matching things like
// step-by-step instructions ("take 2 - 3 tablets") is a much harder
// problem than this module needs to solve today; only contiguous-digit
// phone forms are masked. (For reference: this is why the mental-health
// helpline number in services/amaaii.js's MENTAL_HEALTH_PROMPT is safe
// to leave as "0722 178 177" — it's a system-authored string, never run
// through redaction anyway per the policy above.)

/** Minimal shape this module needs from a stored user record. */
export interface RedactableUser {
  name?: string | null;
}

/** Toggles for redactText(); all default to "on" (i.e. everything gets
 *  redacted unless a caller opts a category out). No caller in this
 *  codebase currently needs to opt out of anything — these exist so a
 *  future caller (e.g. a debug/log-inspection tool) can selectively
 *  disable a category without duplicating the regexes. */
export interface RedactOptions {
  skipPhone?: boolean;
  skipEmail?: boolean;
  skipUrl?: boolean;
  skipLongDigits?: boolean;
}

// --- Patterns (exported individually so utils/logger.js and any other
// consumer can reuse the exact same source of truth rather than keeping
// a parallel copy). Order matters when composed in redactText() below —
// see the comment there. ---------------------------------------------

/** `whatsapp:+254797000011` style — Twilio's `From`/`To` field shape. */
export const WHATSAPP_PHONE_PATTERN = /whatsapp:\+\d{7,15}/gi;

/** Bare international form, e.g. `+254797000011`. Matches the original
 *  utils/logger.js pattern (`/\+\d{10,}/g`) exactly, just centralized. */
export const INTL_PHONE_PATTERN = /\+\d{10,}/g;

/** Local Kenyan mobile with leading 0: `07XXXXXXXX` / `01XXXXXXXX`
 *  (10 digits total). Word-boundary anchored so it can't match a
 *  substring of a longer digit run. */
export const LOCAL_PHONE_PATTERN = /\b0[17]\d{8}\b/g;

/** Local Kenyan mobile with the leading 0 dropped: `7XXXXXXXX` /
 *  `1XXXXXXXX` (9 digits total) — e.g. copy-pasted from a +254 form
 *  with the country code stripped instead of the 0 swapped in. */
export const LOCAL_PHONE_NO_LEADING_ZERO_PATTERN = /\b[17]\d{8}\b/g;

/** Standard email shape. Deliberately unremarkable — this is not trying
 *  to be RFC 5322-complete, just to catch the emails real users type. */
export const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/** A URL that embeds userinfo before the host (`scheme://user[:pass]@host...`).
 *  Matches the whole URL (not just the credential) so nothing about the
 *  destination host/path leaks either — e.g. a password-reset link. */
export const URL_WITH_USERINFO_PATTERN = /\bhttps?:\/\/[^\s\/@:]+(?::[^\s\/@]*)?@\S+/gi;

/** Catch-all for phone-shaped numbers that don't match any of the
 *  specific formats above — e.g. a country code typed without the '+'
 *  (`254797000011`). 11 is the floor because Kenyan local numbers (9-10
 *  digits, handled above) must never fall through to this bucket; any
 *  legitimate non-phone number in this domain (weeks, ages, mood/sleep/
 *  water scores, dates-with-separators) is far shorter than 11 digits. */
export const LONG_DIGIT_RUN_PATTERN = /\b\d{11,}\b/g;

/**
 * Masks phone numbers, emails, userinfo-URLs, and long phone-shaped
 * digit runs in free text. Does NOT touch standalone short numbers
 * (pregnancy weeks, ages, mood scores, dates, times) — see the ID-NUMBER
 * DECISION above — and does NOT know about names (see redactKnownName).
 *
 * Order is deliberate: URL and email are resolved FIRST, each as a
 * single greedy match that swallows the whole token (including any
 * digits inside it), so a numeric password in a URL or a numeric local
 * part in an email address can't be partially matched by the phone/
 * digit-run patterns afterward and leave a mangled "[PHONE]@example.com"
 * instead of a clean "[URL]"/"[EMAIL]".
 */
export function redactText(text: string, opts: RedactOptions = {}): string {
  if (typeof text !== 'string' || text.length === 0) return text;

  let out = text;

  if (!opts.skipUrl) {
    out = out.replace(URL_WITH_USERINFO_PATTERN, '[URL]');
  }
  if (!opts.skipEmail) {
    out = out.replace(EMAIL_PATTERN, '[EMAIL]');
  }
  if (!opts.skipPhone) {
    out = out.replace(WHATSAPP_PHONE_PATTERN, '[PHONE]');
    out = out.replace(INTL_PHONE_PATTERN, '[PHONE]');
    out = out.replace(LOCAL_PHONE_PATTERN, '[PHONE]');
    out = out.replace(LOCAL_PHONE_NO_LEADING_ZERO_PATTERN, '[PHONE]');
  }
  if (!opts.skipLongDigits) {
    out = out.replace(LONG_DIGIT_RUN_PATTERN, '[NUMBER]');
  }

  return out;
}

/**
 * Replaces every occurrence of the user's stored name with '[NAME]',
 * word-boundary anchored and case-insensitive. Multi-word names are
 * split into tokens and each token is masked independently (so "Grace
 * Wanjiru" -> "[NAME] [NAME]") — tokens shorter than 3 characters are
 * skipped entirely to avoid mass-collateral matches on short common
 * words/initials (e.g. a name token "Jo" would otherwise mask every
 * "jo" substring... no — word-boundary prevents substring matches, but
 * a 2-letter token is still far more likely to coincide with an
 * unrelated real word than a 3+ letter one; the work order sets this
 * threshold explicitly).
 */
export function redactKnownName(text: string, name?: string | null): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (!name || typeof name !== 'string') return text;

  const tokens = name
    .trim()
    .split(/\s+/)
    .filter((tok) => tok.length >= 3);

  if (tokens.length === 0) return text;

  const escaped = tokens.map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'gi');

  return text.replace(pattern, '[NAME]');
}

/**
 * The composed function every user/assistant message must pass through
 * before it reaches the OpenAI API (see packages/adapters/src/llm.ts).
 * Applies the generic pattern-based redaction (phone/email/url/long
 * digit runs) AND, when a user record is supplied, masks the user's
 * FULL stored name too — see the FIRST-NAME POLICY block above for why
 * this is intentionally stricter than what the system prompt is allowed
 * to carry.
 */
export function redactForLLM(text: string, user?: RedactableUser | null): string {
  if (typeof text !== 'string') return text;
  let out = redactText(text);
  if (user && user.name) {
    out = redactKnownName(out, user.name);
  }
  return out;
}
