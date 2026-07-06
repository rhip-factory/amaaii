'use strict';

// Text-pattern redaction (phone/email/url/long-digit-run) now lives in
// packages/core/src/redaction.ts (P1-D: LLM redaction layer — see
// CLAUDE.md) so log-redaction and LLM-redaction share one source of
// truth instead of each keeping its own copy of "what does a phone
// number look like". This module used to define PHONE_PATTERNS locally
// (`/whatsapp:\+\d+/gi`, `/\+\d{10,}/g`); redactText() below covers both
// of those exactly, plus emails/URLs-with-userinfo/long digit runs —
// strictly more coverage, same "leave short numbers alone" guarantee
// (weeks/ages/mood scores never match).
//
// `tsx/cjs` registers Node module hooks that let a plain CommonJS
// `require()` load TypeScript sources under vitest, tsx, and plain
// `node` alike. Safe/idempotent to call from multiple files.
require('tsx/cjs');
const { redactText } = require('../packages/core/src/index.ts');

const REDACT_KEYS = new Set(['name', 'location', 'body', 'profilename', 'message']);

function redactString(s) {
  return redactText(s);
}

function redact(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redact(v);
    }
  }
  return out;
}

function format(level, msg, ctx) {
  const safeMsg = typeof msg === 'string' ? redactString(msg) : redact(msg);
  const parts = [`[${level}] ${safeMsg}`];
  if (ctx !== undefined) {
    try {
      parts.push(JSON.stringify(redact(ctx)));
    } catch (e) {
      parts.push('[unserializable ctx]');
    }
  }
  return parts.join(' ');
}

function emit(stream, line) {
  try {
    stream.write(line + '\n');
  } catch (e) {
    // last-resort fallback; logger's own failure path may use console.error
    console.error('[logger] write failed:', e && e.message);
  }
}

const log = {
  info(msg, ctx) {
    emit(process.stdout, format('INFO', msg, ctx));
  },
  warn(msg, ctx) {
    emit(process.stderr, format('WARN', msg, ctx));
  },
  error(msg, err, ctx) {
    const errPart = err
      ? ` :: ${err && err.message ? err.message : String(err)}`
      : '';
    emit(process.stderr, format('ERROR', msg, ctx) + errPart);
  },
};

module.exports = { log, redact };
