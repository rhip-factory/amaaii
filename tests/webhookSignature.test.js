import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import bodyParser from 'body-parser';
import request from 'supertest';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Registers Node module hooks so this native `require()` can load
// apps/server/src/middleware/twilioSignature.ts directly, same as `tsx`
// does for `pnpm start`/`pnpm dev`.
require('tsx/cjs');

const TOKEN = 'test-auth-token-123';

function expectedSignature(url, params) {
  const data = Object.keys(params).sort().reduce(
    (acc, k) => acc + k + params[k],
    url,
  );
  return crypto.createHmac('sha1', TOKEN).update(data).digest('base64');
}

function buildApp() {
  vi.resetModules();
  // Defer require until env is set so the middleware sees current env.
  const twilioSignature = require('../apps/server/src/middleware/twilioSignature');
  const app = express();
  app.use(bodyParser.urlencoded({ extended: false }));
  app.post('/webhook', twilioSignature, (req, res) => {
    res.status(200).send('ok');
  });
  return app;
}

describe('twilio signature middleware', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  });

  it('returns 403 in production when signature is missing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TWILIO_SIGNATURE_ENFORCE', '');
    const app = buildApp();
    const res = await request(app)
      .post('/webhook')
      .type('form')
      .send({ From: 'whatsapp:+254700000001', Body: 'hi' });
    expect(res.status).toBe(403);
  });

  it('returns 200 in production when signature is valid', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TWILIO_SIGNATURE_ENFORCE', '');
    const app = buildApp();
    const params = { From: 'whatsapp:+254700000001', Body: 'hi' };
    // supertest binds an ephemeral port; build URL the way the middleware will.
    // We must pre-resolve host:port by issuing through .agent or using the
    // server callback. Easiest: spin the server explicitly.
    const server = app.listen(0);
    try {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}/webhook`;
      const sig = expectedSignature(url, params);
      const res = await request(server)
        .post('/webhook')
        .set('Host', `127.0.0.1:${port}`)
        .set('X-Twilio-Signature', sig)
        .type('form')
        .send(params);
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('returns 200 with no signature when TWILIO_SIGNATURE_ENFORCE=false', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TWILIO_SIGNATURE_ENFORCE', 'false');
    const app = buildApp();
    const res = await request(app)
      .post('/webhook')
      .type('form')
      .send({ From: 'whatsapp:+254700000001', Body: 'hi' });
    expect(res.status).toBe(200);
  });

  it('honors X-Forwarded-Proto when reconstructing URL', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TWILIO_SIGNATURE_ENFORCE', '');
    const app = buildApp();
    const params = { From: 'whatsapp:+254700000001', Body: 'hi' };
    const server = app.listen(0);
    try {
      const port = server.address().port;
      const url = `https://example.test/webhook`;
      const sig = expectedSignature(url, params);
      const res = await request(server)
        .post('/webhook')
        .set('Host', 'example.test')
        .set('X-Forwarded-Proto', 'https')
        .set('X-Twilio-Signature', sig)
        .type('form')
        .send(params);
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });
});
