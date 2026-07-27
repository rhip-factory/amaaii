// P4-B: correlation-id + structured per-request logging + HTTP metrics,
// wired as the very FIRST middleware in createApp() (see app.ts) so it
// wraps every request start-to-finish — including body-parsing time and
// anything a later middleware/route throws (the correlation id is
// already stashed on `req` by the time apps/server/src/errorHandler.ts's
// global backstop would ever see the request).
//
// CORRELATION ID: honors an incoming `X-Request-Id` if it looks sane
// (bounded length, safe charset — never trusts an arbitrary client
// header blindly into a log line), else mints a crypto.randomUUID().
// Echoed back on every response as `X-Request-Id`, so a client (or a
// human piecing together an incident from Twilio/ops logs) can
// correlate their request with this process's log line and, on error,
// with errorHandler.ts's response body.
//
// LOGGING: exactly one line per request, emitted on 'finish' (after the
// response has actually been sent, so `status`/`duration_ms` reflect
// what really happened — not emitted twice for a request the error
// handler also touches). NEVER logs the request body or query string —
// `req.path` is Express's path with the query string already stripped,
// and no route in this app embeds PII in a URL PATH segment (a phone
// number always comes from the bearer token or the JSON body, never the
// path) — see CLAUDE.md's PII-in-logs discipline.
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { log } from '../logger';
import { recordHttpRequest } from '../metrics';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Correlation id for this request — set by requestObservability
       *  before any route handler runs. Echoed back as the
       *  `X-Request-Id` response header and included in the global
       *  error handler's JSON body (apps/server/src/errorHandler.ts). */
      requestId?: string;
    }
  }
}

// Conservative allowlist for an INCOMING X-Request-Id: bounded length,
// safe charset. A header that fails this is treated as ABSENT (we mint
// our own UUID) rather than rejected outright — a malformed/oversized
// client header should never itself become a reason to fail the
// request.
const INCOMING_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function sanitizeIncomingRequestId(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return INCOMING_REQUEST_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/** 'Nxx' bucket — never the exact status code (see metrics.ts's
 *  cardinality/PII discipline header). */
function statusClass(statusCode: number): string {
  const bucket = Math.floor(statusCode / 100);
  return bucket >= 1 && bucket <= 5 ? `${bucket}xx` : 'other';
}

/** Matched Express route TEMPLATE (e.g. '/journal/entries'), or 'other'
 *  for anything Express didn't match to one of app.ts's explicit
 *  `app.get`/`app.post`/etc. routes — static PWA asset serving, the
 *  extensionless-route HTML fallback, and 404s all land here.
 *  `req.route` is populated by Express's router once a Route has
 *  matched (before the handler runs) and stays set through 'finish' —
 *  the PWA's catch-all regex fallback route DOES technically match as a
 *  route, but its path is a RegExp object rather than a string (the
 *  pattern passed to `app.get`), so the `typeof === 'string'` guard
 *  below correctly buckets it into 'other' too — it fronts many
 *  different underlying pages, not one template worth a dedicated
 *  series. */
function routeTemplate(req: Request): string {
  const routePath = req.route?.path;
  return typeof routePath === 'string' ? routePath : 'other';
}

export function requestObservability(req: Request, res: Response, next: NextFunction): void {
  const incoming = sanitizeIncomingRequestId(req.get('x-request-id'));
  const requestId = incoming ?? randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const route = routeTemplate(req);
    recordHttpRequest(req.method, route, statusClass(res.statusCode), durationMs);
    log.info('http_request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 100) / 100,
      requestId,
    });
  });

  next();
}
