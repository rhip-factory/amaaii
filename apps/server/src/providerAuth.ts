// P5-A: provider-portal auth. Mirrors apps/server/src/auth.ts's HMAC
// token approach — same signToken/verifyToken primitives, same
// AUTH_SECRET — but with a NAMESPACED payload so a provider token and a
// mother token can never be used interchangeably. Providers are a
// wholly separate identity from the `phone_number`-keyed mother identity
// the rest of this codebase uses (see packages/core/src/repositories.ts's
// "Provider portal" section: facility/provider rows belong to the
// hospital, a separate DPA controller — not to any mother).
//
// NAMESPACING IS THE WHOLE SECURITY BOUNDARY. Both token types are
// signed with the SAME secret, so a provider token verifies just fine
// under auth.ts#verifyToken's HMAC check alone — it is cryptographically
// indistinguishable from a mother token at that layer. What keeps the
// two from being interchangeable is entirely the `sub` field's
// `provider:<id>` prefix:
//   - apps/server/src/app.ts's mother-facing requireAuth() rejects any
//     payload whose sub carries that prefix.
//   - verifyProviderToken() below rejects any payload whose sub does NOT
//     carry it — which covers every mother token, since
//     auth.ts#normalizePhone() always produces `whatsapp:+...`, never
//     `provider:...`.
// Both checks are load-bearing; removing either one reopens the
// cross-token hole. Both directions are pinned by
// tests/providerPortal.test.ts.

import crypto from 'node:crypto';
import { signToken, verifyToken, type TokenPayload } from './auth';

const PROVIDER_SUB_PREFIX = 'provider:';

// Shorter-lived than the mother token's 30-day demo TTL (auth.ts) — this
// is a staff work session, not a mother's long-lived app login. Still
// generous enough that a hospital's front-desk/nurse doesn't have to
// re-login mid-shift during the Friday demo. Password reset / session
// revocation is out of scope for this slice (see the P5 spec).
const PROVIDER_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface ProviderTokenPayload {
  providerId: number;
  facilityId: number;
  role: string;
  iat: number;
  exp: number;
}

// Extra fields (`fid`, `role`) riding along on the same signed JSON body
// auth.ts#signToken serializes. TokenPayload only declares
// {sub,iat,exp}; this interface documents the actual shape this module
// signs/reads, and is structurally assignable to TokenPayload (a
// superset), so it passes straight into signToken with no cast needed.
interface ProviderSignPayload extends TokenPayload {
  fid: number;
  role: string;
}

export function issueProviderToken(providerId: number, facilityId: number, role: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: ProviderSignPayload = {
    sub: `${PROVIDER_SUB_PREFIX}${providerId}`,
    iat: now,
    exp: now + PROVIDER_TOKEN_TTL_SECONDS,
    fid: facilityId,
    role,
  };
  return signToken(payload);
}

export function verifyProviderToken(token: unknown): ProviderTokenPayload | null {
  const payload = verifyToken(token);
  if (!payload || typeof payload.sub !== 'string' || !payload.sub.startsWith(PROVIDER_SUB_PREFIX)) {
    return null;
  }
  const providerId = Number(payload.sub.slice(PROVIDER_SUB_PREFIX.length));
  if (!Number.isInteger(providerId)) return null;

  // verifyToken()'s own return type only declares {sub,iat,exp}
  // (auth.ts's TokenPayload), but the actual JSON body
  // issueProviderToken() signed also carries fid/role. This cast
  // documents that trust boundary the same way auth.ts#verifyToken's own
  // `as TokenPayload` cast does for its JSON.parse — the value was
  // produced by issueProviderToken() above (or rejected by the HMAC
  // check already), so the shape is trusted, not re-validated field by
  // field beyond the typeof guards right below.
  const extra = payload as TokenPayload & { fid?: unknown; role?: unknown };
  if (typeof extra.fid !== 'number' || typeof extra.role !== 'string') return null;

  return { providerId, facilityId: extra.fid, role: extra.role, iat: payload.iat, exp: payload.exp };
}

// --- Passwords -----------------------------------------------------------
// Node's built-in scrypt (no extra dependency) with a per-provider random
// salt, stored as `scrypt$<saltHex>$<hashHex>` — never plaintext, never a
// shared/fixed salt. Comparison uses timingSafeEqual so a wrong-password
// guess can't be timed to learn how many leading bytes matched.

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, saltHex, hashHex] = parts;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  // Empty buffers would make scryptSync throw (keylen must be > 0) and
  // would never legitimately come from hashPassword() above — treat as a
  // malformed hash, not a crash.
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = crypto.scryptSync(password, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
