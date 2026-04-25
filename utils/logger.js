'use strict';

const PHONE_PATTERNS = [
  /whatsapp:\+\d+/gi,
  /\+\d{10,}/g,
];

const REDACT_KEYS = new Set(['name', 'location', 'body', 'profilename', 'message']);

function redactString(s) {
  let out = s;
  for (const re of PHONE_PATTERNS) out = out.replace(re, '[PHONE]');
  return out;
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
