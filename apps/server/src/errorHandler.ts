// P4-B: global Express error-handling middleware. Express only
// recognizes a handler as error-handling middleware by its ARITY (four
// params: err, req, res, next) — that's why `_next` below is kept even
// though it's only used on the headersSent escape hatch. Registered
// LAST in createApp() (see app.ts), after every route and after the
// static PWA serving, so it only ever engages when something throws or
// rejects WITHOUT already being caught.
//
// In practice, that's a narrow set: every route in app.ts already wraps
// its own body in try/catch and returns its own
// `{error:'internal_error'}` JSON directly (unchanged by this file — see
// the P4-B work order's "backstop, not a replacement" requirement). So
// this mostly catches body-parser's synchronous JSON-parse errors on a
// malformed request body (which Express DOES route to an error handler
// automatically), plus — deliberately, via
// `CreateAppOptions.enableTestErrorRoute` in app.ts — a test-only
// throwing route that proves this file's own behavior in isolation
// (tests/observability.test.ts).
//
// SAFETY: never leaks a stack trace, error message, or any request
// detail to the CLIENT — the JSON response is always exactly
// `{error:'internal_error', requestId}`. The error's message (never a
// stack trace) is logged SERVER-SIDE only, through the redacting
// logger, and passed to the alerting seam (which redacts it again
// before it can leave the process — see alerts.ts).
import type { NextFunction, Request, Response } from 'express';
import { log } from './logger';
import { incrementHttpServerError } from './metrics';
import { notifyCritical } from './alerts';

function routeLabel(req: Request): string {
  const routePath = req.route?.path;
  return typeof routePath === 'string' ? routePath : 'other';
}

// Duck-typed "does this look like an Error" extraction — same pattern as
// logger.ts's messageOf(), not `instanceof Error`, so a thrown string or
// plain object (which JS allows) is described just as safely as a real
// Error.
function messageOf(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

export function globalErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  const route = routeLabel(req);
  const requestId = req.requestId;
  const message = messageOf(err);

  log.error('Unhandled error reached the global error handler', err, { route, requestId });
  incrementHttpServerError(route);
  notifyCritical('unhandled_error', { message, requestId });

  if (res.headersSent) {
    // The response already started streaming — Express's own built-in
    // final handler is the only safe option left at this point (it
    // closes the connection rather than attempting a second, invalid
    // res.json() call).
    next(err);
    return;
  }

  res.status(500).json({ error: 'internal_error', requestId });
}
