// P2-B: OTP generation + hashing helpers. Lives alongside auth.ts (same
// HMAC secret, same "crypto, not Math.random" discipline as its token
// signing) rather than in packages/core, because it needs a real secret
// and Node's crypto module — packages/core stays secret-free and
// I/O-free (see packages/core/src/otp.ts's header, which owns the pure
// rate-limit/expiry decisions instead).

import crypto from 'node:crypto';

const SECRET = process.env.AUTH_SECRET || 'amaaii-dev-secret-change-me';

/**
 * Generates a 6-digit numeric OTP using Node's CSPRNG (crypto.randomInt)
 * — never Math.random(). Zero-padded so it's always exactly 6 digits
 * ("004821", not "4821").
 */
export function generateOtpCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * HMAC-SHA256 of `${phone}:${code}` keyed with AUTH_SECRET — same
 * secret/algorithm family as auth.ts's token signing. Binding the phone
 * into the hash means a leaked hash for one phone can't be replayed
 * against another phone's OTP row even if two users were independently
 * issued the same 6-digit code. Only the hash is ever persisted — the
 * plaintext code lives only in memory (and briefly in the dev-mode
 * response / log line) for the life of one request.
 */
export function hashOtpCode(phone: string, code: string): string {
  return crypto.createHmac('sha256', SECRET).update(`${phone}:${code}`).digest('hex');
}

/**
 * Constant-time comparison of two hex-encoded hashes — mirrors
 * auth.ts#verifyToken's timingSafeEqual usage, adapted for hex strings
 * instead of base64url.
 */
export function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
