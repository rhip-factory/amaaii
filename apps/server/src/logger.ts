// P1-E: ported 1:1 from utils/logger.js (final step of the TS migration —
// see CLAUDE.md). Text-pattern redaction itself lives in
// packages/core/src/redaction.ts (P1-D); this module is just the
// formatting/emit layer that calls into it, same as before.
//
// `redact()` walks arbitrary log context objects and masks known PII
// keys (REDACT_KEYS below) plus any string content via redactText().
// Loosely typed on purpose — log context can be literally anything a
// caller passes (`ctx?: unknown`), and the original JS never assumed a
// shape either.

import { redactText } from '@amaaii/core';

const REDACT_KEYS = new Set(['name', 'location', 'body', 'profilename', 'message']);

function redactString(s: string): string {
  return redactText(s);
}

// `value: unknown` — this recurses over arbitrary log payloads (strings,
// arrays, nested objects, primitives). Every branch narrows before use,
// mirroring the original JS's dynamic-but-safe traversal.
export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redact(v);
    }
  }
  return out;
}

function format(level: string, msg: unknown, ctx?: unknown): string {
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

// Duck-typed "does this have a .message" check, on purpose — NOT
// `instanceof Error`. The original JS accepted anything with a truthy
// `.message` (a plain `{ message: '...' }`, an Error from another
// realm/vm context, a third-party error-like object), so `instanceof
// Error` here would be a real behavior change for those edge cases even
// though every current call site happens to pass a real Error.
function messageOf(err: unknown): unknown {
  return err && typeof err === 'object' && 'message' in err
    ? (err as { message: unknown }).message
    : err;
}

function emit(stream: NodeJS.WritableStream, line: string): void {
  try {
    stream.write(line + '\n');
  } catch (e) {
    // last-resort fallback; logger's own failure path may use console.error
    console.error('[logger] write failed:', e && messageOf(e));
  }
}

export const log = {
  info(msg: unknown, ctx?: unknown): void {
    emit(process.stdout, format('INFO', msg, ctx));
  },
  warn(msg: unknown, ctx?: unknown): void {
    emit(process.stderr, format('WARN', msg, ctx));
  },
  error(msg: unknown, err?: unknown, ctx?: unknown): void {
    const hasMessage = !!err && typeof err === 'object' && 'message' in err && !!(err as { message: unknown }).message;
    const errPart = err ? ` :: ${hasMessage ? (err as { message: unknown }).message : String(err)}` : '';
    emit(process.stderr, format('ERROR', msg, ctx) + errPart);
  },
};
