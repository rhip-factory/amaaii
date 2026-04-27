// Lightweight auth for the PWA demo. Phase 0/demo only — no real OTP
// challenge (Phase 3 will add proper SMS/email verification). The token
// is an HMAC-signed payload {phone, iat, exp} so we don't trust the
// client to keep it honest. Real production deployments swap this for
// OAuth / Twilio Verify.

const crypto = require('node:crypto');

const SECRET = process.env.AUTH_SECRET || 'amaaii-dev-secret-change-me';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days for the demo

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function fromB64url(s) {
  return Buffer.from(s, 'base64url');
}

// Normalize a raw phone string to a stable user key:
//   "0706249104"          → "whatsapp:+254706249104"  (assumes Kenya country code)
//   "+254 706 249 104"    → "whatsapp:+254706249104"
//   "whatsapp:+1..."      → "whatsapp:+1..." (passthrough)
//
// Returns null if the input doesn't look like a phone we can use.
function normalizePhone(raw, defaultCountry = '254') {
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

function signToken(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(
    crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest()
  );
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
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
    const payload = JSON.parse(fromB64url(body).toString('utf8'));
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch (_) {
    return null;
  }
}

function issueToken(phone) {
  const now = Math.floor(Date.now() / 1000);
  return signToken({ sub: phone, iat: now, exp: now + TOKEN_TTL_SECONDS });
}

module.exports = { normalizePhone, signToken, verifyToken, issueToken };
