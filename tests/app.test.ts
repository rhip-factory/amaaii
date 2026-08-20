// P1-E: light wiring/boot test for apps/server/src/app.ts's createApp()
// factory — the biggest structural piece of this migration (server.js's
// route wiring moved wholesale into a TS factory function). The
// route-by-route BEHAVIOR (danger signs, onboarding, journaling) is
// already covered exhaustively by tests/messageHandler.test.js,
// tests/journalManager.test.js, etc.; this file only proves the Express
// app itself boots and the routes are reachable/wired correctly.
//
// express-serves-pwa: also covers the static-export serving added in
// app.ts (apps/web/out) — both the "not built yet" fallback and the
// "built" path, plus the GET /insights page-vs-API discrimination. Both
// out/-shaped assertions use `createApp({ webOutDirOverride })` (see
// app.ts's CreateAppOptions) rather than the real apps/web/out, so these
// tests are deterministic regardless of whether a real `pnpm build:web`
// happens to have been run on whatever machine the suite executes on.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
// Registers Node module hooks so this native `require()` can load
// TypeScript sources (apps/server/src/*.ts) directly, same as `tsx` does
// for `pnpm start`/`pnpm dev`.
require('tsx/cjs');

// Set env BEFORE the application modules load — apps/server/src/database
// reads DB_PATH at module top-level.
process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';
process.env.AUTH_SECRET = 'test-auth-secret';

const db = require('../apps/server/src/database');
const { createApp } = require('../apps/server/src/app');

beforeAll(async () => {
  await db.initializeDatabase();
});

// A path that's guaranteed not to exist, for the "apps/web/out isn't
// built yet" branch — a fresh subdirectory under a fresh temp dir this
// test never creates.
const missingOutDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'amaaii-app-test-missing-')), 'out');

// A minimal fixture standing in for `apps/web/out` — just enough of the
// real export's shape (flat `<route>.html` files, `_next/static/*`,
// `sw.js`, `404.html`) to exercise app.ts's serving/fallback logic
// without needing a real `next build`.
const fixtureOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amaaii-app-test-fixture-out-'));
fs.writeFileSync(path.join(fixtureOutDir, 'index.html'), '<!doctype html><body>AMAAII_TEST_FIXTURE_INDEX</body>');
fs.writeFileSync(path.join(fixtureOutDir, 'login.html'), '<!doctype html><body>AMAAII_TEST_FIXTURE_LOGIN</body>');
fs.writeFileSync(path.join(fixtureOutDir, 'insights.html'), '<!doctype html><body>AMAAII_TEST_FIXTURE_INSIGHTS_PAGE</body>');
fs.writeFileSync(path.join(fixtureOutDir, '404.html'), '<!doctype html><body>AMAAII_TEST_FIXTURE_404</body>');
// P6: the provider portal added two MORE page-vs-API GET collisions.
fs.mkdirSync(path.join(fixtureOutDir, 'provider'), { recursive: true });
fs.writeFileSync(
  path.join(fixtureOutDir, 'provider', 'escalations.html'),
  '<!doctype html><body>AMAAII_TEST_FIXTURE_PROVIDER_ESCALATIONS_PAGE</body>'
);
fs.writeFileSync(
  path.join(fixtureOutDir, 'provider', 'cohort.html'),
  '<!doctype html><body>AMAAII_TEST_FIXTURE_PROVIDER_COHORT_PAGE</body>'
);
fs.writeFileSync(path.join(fixtureOutDir, 'sw.js'), '// fixture sw.js\n');
fs.mkdirSync(path.join(fixtureOutDir, '_next', 'static'), { recursive: true });
fs.writeFileSync(path.join(fixtureOutDir, '_next', 'static', 'chunk-fixture123.js'), '// fixture hashed chunk\n');

afterAll(() => {
  fs.rmSync(path.dirname(missingOutDir), { recursive: true, force: true });
  fs.rmSync(fixtureOutDir, { recursive: true, force: true });
});

describe('apps/server/src/app — wiring smoke test', () => {
  it('POST /auth/login with a valid phone returns a bearer token', async () => {
    const app = createApp();
    const res = await request(app).post('/auth/login').send({ phone: '0712345678' });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.user.phone).toBe('whatsapp:+254712345678');
  });

  it('POST /auth/login with an invalid phone returns 400', async () => {
    const app = createApp();
    const res = await request(app).post('/auth/login').send({ phone: '123' });
    expect(res.status).toBe(400);
  });

  it('GET /me without a bearer token is rejected with 401', async () => {
    const app = createApp();
    const res = await request(app).get('/me');
    expect(res.status).toBe(401);
  });

  it('GET /me with a valid token from /auth/login succeeds', async () => {
    const app = createApp();
    const login = await request(app).post('/auth/login').send({ phone: '0700111222' });
    const res = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.phone).toBe('whatsapp:+254700111222');
  });

  it('GET /webhook (health check, no signature required) responds', async () => {
    const app = createApp();
    const res = await request(app).get('/webhook');
    expect(res.status).toBe(200);
  });

  describe('static PWA serving (apps/web/out)', () => {
    it('GET / returns 200 with a plaintext build notice when apps/web/out is not built', async () => {
      const app = createApp({ webOutDirOverride: missingOutDir });
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.type).toBe('text/plain');
      expect(res.text).toMatch(/pnpm build:web/);
      expect(res.text).toMatch(/pnpm dev:web/);
    });

    it('GET / serves the static export index.html when apps/web/out is built', async () => {
      const app = createApp({ webOutDirOverride: fixtureOutDir });
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.type).toBe('text/html');
      expect(res.text).toContain('AMAAII_TEST_FIXTURE_INDEX');
    });

    it('GET /login and GET /login/ both map to the exported login.html (extensionless + trailing slash)', async () => {
      const app = createApp({ webOutDirOverride: fixtureOutDir });
      const noSlash = await request(app).get('/login');
      const withSlash = await request(app).get('/login/');
      expect(noSlash.status).toBe(200);
      expect(noSlash.text).toContain('AMAAII_TEST_FIXTURE_LOGIN');
      expect(withSlash.status).toBe(200);
      expect(withSlash.text).toContain('AMAAII_TEST_FIXTURE_LOGIN');
    });

    it('GET of an unknown path falls back to the export 404.html with a 404 status', async () => {
      const app = createApp({ webOutDirOverride: fixtureOutDir });
      const res = await request(app).get('/this-route-does-not-exist');
      expect(res.status).toBe(404);
      expect(res.text).toContain('AMAAII_TEST_FIXTURE_404');
    });

    it('GET /sw.js is served with a no-cache header so SW updates propagate', async () => {
      const app = createApp({ webOutDirOverride: fixtureOutDir });
      const res = await request(app).get('/sw.js');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-cache');
    });

    it('GET /_next/static/* assets are served with a long, immutable cache header', async () => {
      const app = createApp({ webOutDirOverride: fixtureOutDir });
      const res = await request(app).get('/_next/static/chunk-fixture123.js');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });
  });

  // P6. /insights was described in CLAUDE.md as "the one page-vs-API GET
  // collision in this app". The provider portal added two more, and they
  // shipped WITHOUT the gate: a plain click on the portal's Escalations or
  // Cohort nav link hit requireProviderAuth and rendered raw
  // `{"error":"unauthorized"}` JSON instead of the page. Caught by driving a
  // real navigation against the running server, not by review — which is why
  // these are pinned here rather than trusted to a comment.
  describe('provider portal page-vs-API discrimination', () => {
    for (const [route, marker] of [
      ['/provider/escalations', 'AMAAII_TEST_FIXTURE_PROVIDER_ESCALATIONS_PAGE'],
      ['/provider/cohort', 'AMAAII_TEST_FIXTURE_PROVIDER_COHORT_PAGE'],
    ] as const) {
      it(`a plain navigation to ${route} falls through to the exported page`, async () => {
        const app = createApp({ webOutDirOverride: fixtureOutDir });
        const res = await request(app).get(route);
        expect(res.status).toBe(200);
        expect(res.type).toBe('text/html');
        expect(res.text).toContain(marker);
      });

      it(`an API call to ${route} reaches the JSON handler and is rejected 401`, async () => {
        const app = createApp({ webOutDirOverride: fixtureOutDir });
        const res = await request(app).get(route).set('X-Amaaii-Api', '1');
        expect(res.status).toBe(401);
        expect(res.type).toBe('application/json');
      });

      it(`the page HTML for ${route} is not cacheable, so the browser cannot replay it to a fetch()`, async () => {
        // The page and the API share a URL and are told apart by HEADERS,
        // but an HTTP cache keys on URL. Without this, the browser served
        // the just-navigated page HTML to the app's own fetch() for the
        // same path — the escalation feed rendered "No escalations yet"
        // while curl against the identical endpoint returned two.
        const app = createApp({ webOutDirOverride: fixtureOutDir });
        const res = await request(app).get(route);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['vary']).toContain('X-Amaaii-Api');
      });
    }

    it('a page with no API twin keeps ordinary caching', async () => {
      const app = createApp({ webOutDirOverride: fixtureOutDir });
      const res = await request(app).get('/login');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).not.toBe('no-store');
    });
  });

  describe('GET /insights page-vs-API discrimination', () => {
    it('a plain navigation (no header, no token) falls through to the exported insights.html', async () => {
      const app = createApp({ webOutDirOverride: fixtureOutDir });
      const res = await request(app).get('/insights');
      expect(res.status).toBe(200);
      expect(res.type).toBe('text/html');
      expect(res.text).toContain('AMAAII_TEST_FIXTURE_INSIGHTS_PAGE');
    });

    it('an API call (X-Amaaii-Api header, no token) hits the JSON handler and is rejected 401', async () => {
      const app = createApp({ webOutDirOverride: fixtureOutDir });
      const res = await request(app).get('/insights').set('X-Amaaii-Api', '1');
      expect(res.status).toBe(401);
      expect(res.type).toBe('application/json');
    });

    it('an API call with a valid bearer token (no X-Amaaii-Api header) hits the JSON handler and succeeds', async () => {
      const app = createApp({ webOutDirOverride: fixtureOutDir });
      const login = await request(app).post('/auth/login').send({ phone: '0700333444' });
      const res = await request(app)
        .get('/insights')
        .set('Authorization', `Bearer ${login.body.token}`);
      expect(res.status).toBe(200);
      expect(res.type).toBe('application/json');
      expect(res.body).toHaveProperty('window');
      expect(res.body).toHaveProperty('trend');
    });
  });

  // security-review finding (pre-commit): the first cut of the extensionless
  // route -> HTML fallback built an absolute filesystem path by joining
  // `webOutDir` with a segment taken straight from `req.path`, then handed
  // that to `res.sendFile()` with no root check — a `..` segment could walk
  // it outside `webOutDir` (`fs.existsSync` on the escaped path also leaked
  // file-existence). Fixed by passing a RELATIVE name + `{ root: webOutDir }`
  // to `res.sendFile`, which delegates the boundary enforcement to Express's
  // `send` dependency (see app.ts's comment on `relativeExportHtmlPath`).
  //
  // supertest's `.get(path)` builds requests through superagent's URL
  // handling, which resolves `..` segments client-side before the request
  // is ever sent (the same normalization a browser does for a relative
  // link) — confirmed empirically that `request(app).get('/../secret')`
  // reaches Express with `req.path === '/secret'`, never a literal `..`.
  // A raw HTTP client has no such client-side resolution (verified with
  // Node's own `http.request({ path })`, which preserves the literal
  // string), so these tests drive real sockets against a real listener
  // instead of going through supertest, to exercise the actual vulnerable
  // code path a crafted request (curl, a misconfigured proxy, ...) could
  // reach.
  describe('path traversal protection (apps/web/out fallback route mapping)', () => {
    const travBase = fs.mkdtempSync(path.join(os.tmpdir(), 'amaaii-app-test-traversal-'));
    const travOutDir = path.join(travBase, 'out');
    fs.mkdirSync(travOutDir);
    fs.writeFileSync(path.join(travOutDir, 'index.html'), '<!doctype html><body>INDEX</body>');
    fs.writeFileSync(path.join(travOutDir, '404.html'), '<!doctype html><body>AMAAII_TEST_FIXTURE_404</body>');
    // Planted as a SIBLING of travOutDir (one level above it) — a
    // successful traversal escape would reach this; a correctly-scoped
    // fallback never can.
    const secretMarker = 'AMAAII_TRAVERSAL_SECRET_MUST_NEVER_BE_SERVED';
    fs.writeFileSync(path.join(travBase, 'secret.html'), `<!doctype html><body>${secretMarker}</body>`);

    afterAll(() => {
      fs.rmSync(travBase, { recursive: true, force: true });
    });

    function rawGet(server: http.Server, requestPath: string): Promise<{ status: number; body: string }> {
      return new Promise((resolve, reject) => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const req = http.request({ host: '127.0.0.1', port, path: requestPath, method: 'GET' }, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        });
        req.on('error', reject);
        req.end();
      });
    }

    async function withServer(fn: (server: http.Server) => Promise<void>): Promise<void> {
      const app = createApp({ webOutDirOverride: travOutDir });
      const server = app.listen(0);
      try {
        await new Promise<void>((resolve) => server.once('listening', resolve));
        await fn(server);
      } finally {
        server.close();
      }
    }

    it('a literal ".." segment cannot escape apps/web/out (404, no leak)', async () => {
      await withServer(async (server) => {
        const res = await rawGet(server, '/../secret');
        expect(res.status).toBe(404);
        expect(res.body).not.toContain(secretMarker);
      });
    });

    it('a ".." reached through a real route segment cannot escape either (404, no leak)', async () => {
      await withServer(async (server) => {
        const res = await rawGet(server, '/insights/../../secret');
        expect(res.status).toBe(404);
        expect(res.body).not.toContain(secretMarker);
      });
    });

    it('excessive ".." climbing past the filesystem root is still rejected (404, no leak)', async () => {
      await withServer(async (server) => {
        const res = await rawGet(server, '/../../../../../../../../etc/secret');
        expect(res.status).toBe(404);
        expect(res.body).not.toContain(secretMarker);
      });
    });

    it('a percent-encoded ".." variant is rejected too (treated as a literal filename, never decoded into a separator)', async () => {
      await withServer(async (server) => {
        const res = await rawGet(server, '/%2e%2e%2fsecret');
        expect(res.status).toBe(404);
        expect(res.body).not.toContain(secretMarker);
      });
    });
  });
});
