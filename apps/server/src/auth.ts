// P1-E: ported 1:1 from services/auth.js (final step of the TS migration
// — see CLAUDE.md). Token signing/verification + phone normalization
// shared by BOTH sign-in paths: the original phone-only demo login
// (POST /auth/login, kept for back-compat) and the real OTP challenge
// added in P2-B (POST /auth/otp/request + /verify, apps/server/src/app.ts
// + apps/server/src/otp.ts). The token is an HMAC-signed payload
// {phone, iat, exp} so we don't trust the client to keep it honest. Real
// production deployments may still swap this for OAuth / Twilio Verify.

import crypto from 'node:crypto';

const SECRET = process.env.AUTH_SECRET || 'amaaii-dev-secret-change-me';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days for the demo

export interface TokenPayload {
  sub: string;
  iat: number;
  exp: number;
}

// Accepts either a string (JSON payload) or an already-binary digest —
// both call sites below pass one or the other. Avoids the ambiguous
// `Buffer.from(buf: string | Buffer)` overload call the original's
// single-signature helper relied on implicitly.
function b64url(buf: string | Buffer): string {
  return (typeof buf === 'string' ? Buffer.from(buf) : buf).toString('base64url');
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

// Normalize a raw phone string to a stable user key:
//   "0706249104"          → "whatsapp:+254706249104"  (assumes Kenya country code)
//   "+254 706 249 104"    → "whatsapp:+254706249104"
//   "whatsapp:+1..."      → "whatsapp:+1..." (passthrough)
//
// Returns null if the input doesn't look like a phone we can use.
// `raw: unknown` — callers pass req.body.phone, which is untyped JSON
// input; the original JS's `typeof raw !== 'string'` guard is the real
// validation, so `unknown` (not `any`) is the honest input type.
export function normalizePhone(raw: unknown, defaultCountry = '254'): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s.startsWith('whatsapp:')) s = s.slice('whatsapp:'.length);
  // Strip everything except digits and the leading +
  const hadPlus = s.startsWith('+');
  s = s.replace(/[^\d]/g, '');
  if (s.length < 7) return null;
  if (!hadPlus) {
    // 07xxxxxxxx → 2547xxxxxxxx (typical Kenya local format)
    if (s.startsWith('0')) s = defaultCountry + s.slice(1);
    else if (!s.startsWith(defaultCountry)) s = defaultCountry + s;
  }
  return `whatsapp:+${s}`;
}

export function signToken(payload: TokenPayload): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(
    crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest()
  );
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token: unknown): TokenPayload | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = b64url(
    crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest()
  );
  // Constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    // JSON.parse is inherently untyped; `as TokenPayload` documents the
    // trust boundary (the payload was HMAC-signed by us above) rather
    // than validating field-by-field, matching the original.
    const payload = JSON.parse(fromB64url(body).toString('utf8')) as TokenPayload;
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch (_) {
    return null;
  }
}

export function issueToken(phone: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signToken({ sub: phone, iat: now, exp: now + TOKEN_TTL_SECONDS });
}
