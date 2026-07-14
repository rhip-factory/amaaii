// Pure OTP domain logic (P2-B) — rate-limit and expiry decisions,
// deterministic given their inputs (a timestamp array + a clock). No
// crypto/randomness/secrets here: code generation and hashing need a
// real secret and Node's `crypto` module, so those live in
// apps/server/src/otp.ts instead (mirroring how apps/server/src/auth.ts
// already owns token *signing* while this package stays secret-free —
// see this package's index.ts header). This file only reasons about
// timestamps and counts, same "pure given its inputs" discipline as
// dangerSigns.ts / redaction.ts elsewhere in this package.

export const OTP_CODE_DIGITS = 6;
export const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour, rolling
export const OTP_RATE_LIMIT_MAX_SENDS = 3;

/**
 * Drops any timestamp older than `windowMs` before `now`. Used both to
 * decide whether a new send is allowed and to compute the array that
 * gets persisted afterward — so `otp_codes.sent_timestamps` never grows
 * unbounded; old entries fall off the next time the same phone is
 * touched, which is also what makes the rate limit an actual *rolling*
 * hour (each send remembered individually) rather than a fixed window
 * that resets awkwardly at a wall-clock boundary.
 */
export function pruneSentTimestamps(
  sentTimestamps: string[],
  now: Date,
  windowMs: number = OTP_RATE_LIMIT_WINDOW_MS
): string[] {
  const cutoff = now.getTime() - windowMs;
  return sentTimestamps.filter((ts) => {
    const t = Date.parse(ts);
    return Number.isFinite(t) && t > cutoff;
  });
}

export interface RateLimitResult {
  limited: boolean;
  /** Milliseconds until the oldest send in the window falls out of it
   *  and a new send would be allowed again. 0 when not limited. */
  retryAfterMs: number;
  sendsInWindow: number;
}

/**
 * Decides whether another OTP send is allowed right now, given the
 * phone's full send history (pruning happens inside — pass the
 * unpruned array from storage).
 */
export function checkOtpRateLimit(
  sentTimestamps: string[],
  now: Date,
  opts: { windowMs?: number; maxSends?: number } = {}
): RateLimitResult {
  const windowMs = opts.windowMs ?? OTP_RATE_LIMIT_WINDOW_MS;
  const maxSends = opts.maxSends ?? OTP_RATE_LIMIT_MAX_SENDS;
  const pruned = pruneSentTimestamps(sentTimestamps, now, windowMs);
  if (pruned.length < maxSends) {
    return { limited: false, retryAfterMs: 0, sendsInWindow: pruned.length };
  }
  const oldest = pruned.reduce((min, ts) => (Date.parse(ts) < Date.parse(min) ? ts : min));
  const retryAfterMs = Math.max(0, Date.parse(oldest) + windowMs - now.getTime());
  return { limited: true, retryAfterMs, sendsInWindow: pruned.length };
}

/** Human copy for a 429 rate-limit response — states the wait plainly,
 *  no apology (per the work order's copy guidance). */
export function formatRateLimitMessage(retryAfterMs: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60000));
  return `Too many codes requested. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

export function isOtpExpired(expiresAt: string, now: Date): boolean {
  const t = Date.parse(expiresAt);
  return !Number.isFinite(t) || t <= now.getTime();
}

/** Copy for a wrong-code response — states tries left, explains and
 *  directs, no apology. */
export function formatWrongCodeMessage(attemptsRemaining: number): string {
  return `That code didn't match. ${attemptsRemaining} ${attemptsRemaining === 1 ? 'try' : 'tries'} left.`;
}
