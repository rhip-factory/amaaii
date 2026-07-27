// P4-B: HTTP-level tests for the observability surface added in this
// work package — GET /health, GET /health/ready, GET /metrics (auth
// gating + exposition content + PII-freeness), the X-Request-Id
// correlation id + per-request log line, the global error handler, and
// that danger_escalations_total / llm_calls_total / llm_failures_total
// increment from their REAL call sites (audit.ts#auditDangerEscalation,
// the llm.ts chokepoint) rather than a metric-only stand-in for them.
// Follows tests/consentEnforcement.test.ts's pattern (tsx/cjs require,
// in-memory DB, createApp() per test, __setClient/__resetClient for the
// LLM chokepoint) and tests/logger.test.js's stdout-spy pattern for
// asserting on the actual emitted log line.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
require('tsx/cjs');

process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';
process.env.AUTH_SECRET = 'test-auth-secret';

const db = require('../apps/server/src/database');
const { createApp } = require('../apps/server/src/app');
const { __resetMetrics } = require('../apps/server/src/metrics');
const { CONSENT_VERSION } = require('@amaaii/core');
const { __setClient, __resetClient } = require('@amaaii/adapters');

beforeAll(async () => {
  await db.initializeDatabase();
});

beforeEach(() => {
  __resetMetrics();
});

afterEach(() => {
  __resetClient();
  vi.unstubAllEnvs();
  delete process.env.METRICS_TOKEN;
});

// A path guaranteed not to exist, so tests that don't care about PWA
// static serving get the deterministic "not built" branch regardless of
// whether a real `pnpm build:web` happens to have been run on whatever
// machine runs this suite — same technique as tests/app.test.ts's
// missingOutDir.
const missingOutDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'amaaii-observability-test-')), 'out');
afterAll(() => {
  fs.rmSync(path.dirname(missingOutDir), { recursive: true, force: true });
});

let counter = 0;
function freshPhone(): string {
  counter += 1;
  return `07200${String(counter).padStart(5, '0')}`;
}

async function loginAndGetToken(app: import('express').Express, rawPhone: string): Promise<{ token: string; phone: string }> {
  const res = await request(app).post('/auth/login').send({ phone: rawPhone });
  return { token: res.body.token as string, phone: res.body.user.phone as string };
}

async function seedOnboardedProfile(phone: string): Promise<void> {
  await db.createUser(phone, { name: 'Grace' });
  await db.updateUser(phone, { age: 26, pregnancy_week: 20, location: 'Nairobi' });
}

function fakeCompletion(content: string) {
  return {
    id: 'observability-test',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-3.5-turbo',
    choices: [
      { index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null }, logprobs: null },
    ],
  };
}

/** Parses one counter/gauge value out of the Prometheus text exposition
 *  body — mirrors metrics.ts#serializeLabels' own "sort keys
 *  alphabetically" rule so the constructed match string lines up with
 *  what renderMetrics() actually emits, regardless of the order labels
 *  were passed in at the call site. Returns 0 (not undefined) when the
 *  series doesn't appear at all — a counter with no observations yet is
 *  indistinguishable from "zero" for these tests' purposes. */
function extractMetricValue(body: string, name: string, labels: Record<string, string> = {}): number {
  const keys = Object.keys(labels).sort();
  const labelStr = keys.length ? `\\{${keys.map((k) => `${k}="${labels[k]}"`).join(',')}\\}` : '';
  const re = new RegExp(`^${name}${labelStr} (\\d+(?:\\.\\d+)?)$`, 'm');
  const m = body.match(re);
  return m ? Number(m[1]) : 0;
}

describe('GET /health', () => {
  it('returns 200 with status ok, a numeric uptime, and a version string, unauthenticated', async () => {
    const app = createApp({ webOutDirOverride: missingOutDir });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
    expect(typeof res.body.version).toBe('string');
    expect(res.body.version.length).toBeGreaterThan(0);
  });
});

describe('GET /health/ready', () => {
  it('returns 200 {status: "ok"} when the DB is reachable, unauthenticated', async () => {
    const app = createApp({ webOutDirOverride: missingOutDir });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
  // NOTE: the 503-on-failure path (DatabaseAdapter#ping rejecting) is
  // implemented (see app.ts's try/catch) but not exercised here — this
  // suite's DB is a single process-wide `:memory:` singleton shared by
  // the whole test file (apps/server/src/database.ts's module-level
  // `adapter`), and there is no seam to make ONE request's ping() fail
  // without closing that shared connection out from under every other
  // test in this file. Documented as a deliberate gap, not an oversight
  // — see the P4-B final report.
});

describe('X-Request-Id correlation', () => {
  it('a normal response carries an X-Request-Id header', async () => {
    const app = createApp({ webOutDirOverride: missingOutDir });
    const res = await request(app).get('/health');
    expect(typeof res.headers['x-request-id']).toBe('string');
    expect(res.headers['x-request-id'].length).toBeGreaterThan(0);
  });

  it('echoes back a sane incoming X-Request-Id unchanged', async () => {
    const app = createApp({ webOutDirOverride: missingOutDir });
    const res = await request(app).get('/health').set('X-Request-Id', 'my-correlation-id-123');
    expect(res.headers['x-request-id']).toBe('my-correlation-id-123');
  });

  it('replaces an insane incoming X-Request-Id (whitespace/control characters) with a freshly minted one', async () => {
    const app = createApp({ webOutDirOverride: missingOutDir });
    const res = await request(app).get('/health').set('X-Request-Id', 'not a sane id!! <script>');
    expect(res.headers['x-request-id']).not.toBe('not a sane id!! <script>');
    expect(res.headers['x-request-id'].length).toBeGreaterThan(0);
  });

  it('two different requests get two different correlation ids', async () => {
    const app = createApp({ webOutDirOverride: missingOutDir });
    const a = await request(app).get('/health');
    const b = await request(app).get('/health');
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });

  it('emits exactly one structured "http_request" log line per request, shaped like the existing logger output, with no request body/query logged', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const app = createApp({ webOutDirOverride: missingOutDir });
      await request(app).get('/health?should=never-appear-in-logs');

      const httpRequestLines = stdout.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes('"http_request"') || line.includes('http_request'));
      // Exactly one line for this one request (not zero, not duplicated).
      const matching = httpRequestLines.filter((l) => l.includes('/health'));
      expect(matching).toHaveLength(1);

      const line = matching[0];
      // Same "[LEVEL] message {json}" shape logger.ts's format() produces.
      expect(line).toMatch(/^\[INFO\] "?http_request"? /);
      expect(line).toContain('"method":"GET"');
      expect(line).toContain('"path":"/health"');
      expect(line).toContain('"status":200');
      expect(line).toMatch(/"duration_ms":\d/);
      expect(line).toMatch(/"requestId":"[^"]+"/);
      // The query string is never logged.
      expect(line).not.toContain('should=never-appear-in-logs');
    } finally {
      stdout.mockRestore();
    }
  });
});

describe('GET /metrics — auth gating', () => {
  it('is served without a token in non-production (dev/CI/smoke convenience)', async () => {
    const app = createApp({ webOutDirOverride: missingOutDir });
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
  });

  it('is 404 without a token when NODE_ENV=production and METRICS_TOKEN is unset', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const app = createApp({ webOutDirOverride: missingOutDir });
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(404);
  });

  it('requires the correct bearer token when METRICS_TOKEN is set (missing header, wrong token, and correct token)', async () => {
    process.env.METRICS_TOKEN = 'super-secret-metrics-token';
    const app = createApp({ webOutDirOverride: missingOutDir });

    const noAuth = await request(app).get('/metrics');
    expect(noAuth.status).toBe(401);

    const wrongAuth = await request(app).get('/metrics').set('Authorization', 'Bearer wrong-token');
    expect(wrongAuth.status).toBe(401);

    const rightAuth = await request(app).get('/metrics').set('Authorization', 'Bearer super-secret-metrics-token');
    expect(rightAuth.status).toBe(200);
  });

  it('the METRICS_TOKEN bearer requirement also protects /metrics in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.METRICS_TOKEN = 'prod-token';
    const app = createApp({ webOutDirOverride: missingOutDir });
    const res = await request(app).get('/metrics').set('Authorization', 'Bearer prod-token');
    expect(res.status).toBe(200);
  });
});

describe('GET /metrics — content', () => {
  it('exposes Prometheus text format with HELP/TYPE lines, http_requests_total, and the job-queue gauges', async () => {
    const app = createApp({ webOutDirOverride: missingOutDir });
    await request(app).get('/health'); // give http_requests_total at least one series
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);

    const body = res.text;
    expect(body).toContain('# HELP http_requests_total');
    expect(body).toContain('# TYPE http_requests_total counter');
    expect(body).toMatch(/http_requests_total\{method="GET",route="\/health",status_class="2xx"\} \d+/);
    expect(body).toContain('# TYPE jobs_total gauge');
    expect(body).toContain('jobs_total{status="pending"}');
    expect(body).toContain('jobs_total{status="running"}');
    expect(body).toContain('jobs_total{status="done"}');
    expect(body).toContain('jobs_total{status="failed"}');
    expect(body).toContain('process_uptime_seconds');
    expect(body).toContain('nodejs_memory_rss_bytes');
  });

  it('http_requests_total increments by exactly the number of matching requests made', async () => {
    const app = createApp({ webOutDirOverride: missingOutDir });
    const before = await request(app).get('/metrics');
    const beforeCount = extractMetricValue(before.text, 'http_requests_total', { method: 'GET', route: '/health', status_class: '2xx' });

    await request(app).get('/health');
    await request(app).get('/health');

    const after = await request(app).get('/metrics');
    const afterCount = extractMetricValue(after.text, 'http_requests_total', { method: 'GET', route: '/health', status_class: '2xx' });
    expect(afterCount).toBe(beforeCount + 2);
  });

  it('jobs_total reflects an actually-enqueued pending job', async () => {
    const app = createApp({ webOutDirOverride: missingOutDir });
    const before = await request(app).get('/metrics');
    const beforePending = extractMetricValue(before.text, 'jobs_total', { status: 'pending' });

    await db.enqueueJob({
      type: 'checkin_followup',
      payload: { phone: freshPhone() },
      runAt: new Date(Date.now() + 3600000).toISOString(),
    });

    const after = await request(app).get('/metrics');
    const afterPending = extractMetricValue(after.text, 'jobs_total', { status: 'pending' });
    expect(afterPending).toBe(beforePending + 1);
  });

  it('is PII-free: none of a real user\'s phone, name, or AI reply content appear anywhere in the output', async () => {
    const app = createApp({ webOutDirOverride: missingOutDir });
    const { token, phone } = await loginAndGetToken(app, freshPhone());
    await seedOnboardedProfile(phone);
    await db.recordConsent(phone, 'data_processing', true, CONSENT_VERSION);
    await db.recordConsent(phone, 'ai_responses', true, CONSENT_VERSION);
    __setClient({
      chat: { completions: { create: async () => fakeCompletion('mocked reply — must never leak: Grace Wanjiru 0712345678') } },
    } as never);

    await request(app).post('/chat').set('Authorization', `Bearer ${token}`).send({ message: 'I have heavy bleeding' });
    await request(app).post('/chat').set('Authorization', `Bearer ${token}`).send({ message: 'would exercise help me sleep better?' });

    const res = await request(app).get('/metrics');
    const body = res.text;
    expect(body).not.toContain(phone);
    expect(body).not.toContain('0712345678');
    expect(body).not.toContain('Grace');
    expect(body).not.toContain('Wanjiru');
    expect(body).not.toContain('mocked reply');
    expect(body).not.toContain('heavy bleeding');
  });
});

describe('danger_escalations_total', () => {
  it('increments {urgency="critical"} on a real critical-urgency /chat message (via audit.ts#auditDangerEscalation, not a separate instrumentation site)', async () => {
    const app = createApp({ webOutDirOverride: missingOutDir });
    const { token } = await loginAndGetToken(app, freshPhone());

    const before = await request(app).get('/metrics');
    const beforeCount = extractMetricValue(before.text, 'danger_escalations_total', { urgency: 'critical' });

    const res = await request(app).post('/chat').set('Authorization', `Bearer ${token}`).send({ message: 'I have heavy bleeding' });
    expect(res.body.urgencyLevel).toBe('critical');

    const after = await request(app).get('/metrics');
    const afterCount = extractMetricValue(after.text, 'danger_escalations_total', { urgency: 'critical' });
    expect(afterCount).toBe(beforeCount + 1);
  });

  it('increments {urgency="high"} on a real high-urgency /chat message', async () => {
    const app = createApp({ webOutDirOverride: missingOutDir });
    const { token } = await loginAndGetToken(app, freshPhone());

    const before = await request(app).get('/metrics');
    const beforeCount = extractMetricValue(before.text, 'danger_escalations_total', { urgency: 'high' });

    const res = await request(app).post('/chat').set('Authorization', `Bearer ${token}`).send({ message: 'I have a severe headache' });
    expect(res.body.urgencyLevel).toBe('high');

    const after = await request(app).get('/metrics');
    const afterCount = extractMetricValue(after.text, 'danger_escalations_total', { urgency: 'high' });
    expect(afterCount).toBe(beforeCount + 1);
  });
});

describe('llm_calls_total / llm_failures_total (single LLM chokepoint)', () => {
  it('llm_calls_total increments when the chokepoint is actually invoked for a consented AI reply', async () => {
    const app = createApp({ webOutDirOverride: missingOutDir });
    const { token, phone } = await loginAndGetToken(app, freshPhone());
    await seedOnboardedProfile(phone);
    await db.recordConsent(phone, 'data_processing', true, CONSENT_VERSION);
    await db.recordConsent(phone, 'ai_responses', true, CONSENT_VERSION);
    __setClient({ chat: { completions: { create: async () => fakeCompletion('a mocked, harmless reply') } } } as never);

    const before = await request(app).get('/metrics');
    const beforeCalls = extractMetricValue(before.text, 'llm_calls_total');

    const res = await request(app).post('/chat').set('Authorization', `Bearer ${token}`).send({ message: 'would exercise help me sleep better?' });
    expect(res.body.response).toContain('a mocked, harmless reply');

    const after = await request(app).get('/metrics');
    const afterCalls = extractMetricValue(after.text, 'llm_calls_total');
    expect(afterCalls).toBe(beforeCalls + 1);
  });

  it('llm_failures_total increments when the chokepoint throws, and the caller still gets the canned fallback (not a 500)', async () => {
    const app = createApp({ webOutDirOverride: missingOutDir });
    const { token, phone } = await loginAndGetToken(app, freshPhone());
    await seedOnboardedProfile(phone);
    await db.recordConsent(phone, 'data_processing', true, CONSENT_VERSION);
    await db.recordConsent(phone, 'ai_responses', true, CONSENT_VERSION);
    __setClient({
      chat: {
        completions: {
          create: async () => {
            throw new Error('simulated OpenAI outage');
          },
        },
      },
    } as never);

    const before = await request(app).get('/metrics');
    const beforeFailures = extractMetricValue(before.text, 'llm_failures_total');
    const beforeCalls = extractMetricValue(before.text, 'llm_calls_total');

    const res = await request(app).post('/chat').set('Authorization', `Bearer ${token}`).send({ message: 'would exercise help me sleep better?' });
    expect(res.status).toBe(200);
    expect(res.body.response).toMatch(/trouble processing/i);

    const after = await request(app).get('/metrics');
    expect(extractMetricValue(after.text, 'llm_failures_total')).toBe(beforeFailures + 1);
    // A failure is still a call — llm_calls_total increments too (the
    // chokepoint increments it unconditionally before attempting the
    // request, per llm.ts's own ordering).
    expect(extractMetricValue(after.text, 'llm_calls_total')).toBe(beforeCalls + 1);
  });
});

describe('global error handler', () => {
  it('a route that throws returns safe JSON {error, requestId}, never leaks the error message/stack, and increments http_server_errors_total', async () => {
    const app = createApp({ webOutDirOverride: missingOutDir, enableTestErrorRoute: true });

    const before = await request(app).get('/metrics');
    const beforeCount = extractMetricValue(before.text, 'http_server_errors_total', { route: '/__test/throw' });

    const res = await request(app).get('/__test/throw');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error', requestId: expect.any(String) });
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('boom');
    expect(raw).not.toContain('.ts:');
    expect(raw).not.toContain('at Object');

    const after = await request(app).get('/metrics');
    const afterCount = extractMetricValue(after.text, 'http_server_errors_total', { route: '/__test/throw' });
    expect(afterCount).toBe(beforeCount + 1);
  });

  it('the requestId in the error body matches the X-Request-Id response header, and echoes a caller-supplied one', async () => {
    const app = createApp({ webOutDirOverride: missingOutDir, enableTestErrorRoute: true });
    const res = await request(app).get('/__test/throw').set('X-Request-Id', 'error-test-correlation-id');
    expect(res.status).toBe(500);
    expect(res.headers['x-request-id']).toBe('error-test-correlation-id');
    expect(res.body.requestId).toBe('error-test-correlation-id');
  });

  it('the test-only throwing route does not exist unless enableTestErrorRoute is explicitly passed', async () => {
    const app = createApp({ webOutDirOverride: missingOutDir });
    const res = await request(app).get('/__test/throw');
    expect(res.status).not.toBe(500);
  });

  it('existing per-route error handling (e.g. /chat catching its own failures) is unchanged — the global handler is a backstop, not a replacement', async () => {
    // /chat already wraps its whole body in try/catch and returns its
    // own {error, response} JSON on failure; this proves that path is
    // untouched by the global handler's existence (still a 200 with the
    // documented AI-off/consent copy for an ordinary message, never a
    // 500 routed through errorHandler.ts for a case app.ts already
    // handles itself).
    const app = createApp({ webOutDirOverride: missingOutDir, enableTestErrorRoute: true });
    const { token } = await loginAndGetToken(app, freshPhone());
    const res = await request(app).post('/chat').set('Authorization', `Bearer ${token}`).send({ message: 'hello there' });
    expect(res.status).toBe(200);
  });
});
