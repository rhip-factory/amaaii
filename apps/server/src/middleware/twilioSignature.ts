// P1-E: ported 1:1 from middleware/twilioSignature.js (final step of the
// TS migration — see CLAUDE.md).
//
// Uses `export =` so a bare CommonJS `require()` — as used directly as
// Express middleware by both apps/server/src/app.ts and
// tests/webhookSignature.test.js — returns the function itself, exactly
// like the original `module.exports = twilioSignature;`.

import twilio from 'twilio';
import type { NextFunction, Request, Response } from 'express';
import { log } from '../logger';

function shouldEnforce(): boolean {
  const flag = process.env.TWILIO_SIGNATURE_ENFORCE;
  if (flag !== undefined && flag !== '') {
    return flag.toLowerCase() === 'true';
  }
  return process.env.NODE_ENV === 'production';
}

function buildUrl(req: Request): string {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}${req.originalUrl}`;
}

function twilioSignature(req: Request, res: Response, next: NextFunction): void {
  const signature = req.header('X-Twilio-Signature');
  const authToken = process.env.TWILIO_AUTH_TOKEN || '';
  const url = buildUrl(req);
  const params = req.body || {};

  const valid = signature
    ? twilio.validateRequest(authToken, signature, url, params)
    : false;

  if (valid) {
    next();
    return;
  }

  if (shouldEnforce()) {
    log.warn('Rejected webhook: invalid Twilio signature', {
      hasSignature: !!signature,
      url,
    });
    res.status(403).send('Forbidden');
    return;
  }

  log.warn('Twilio signature invalid (enforce=off, allowing)', {
    hasSignature: !!signature,
    url,
  });
  next();
}

export = twilioSignature;
