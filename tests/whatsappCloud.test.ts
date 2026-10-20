// Meta WhatsApp Cloud API transport: the Graph client
// (packages/adapters/src/whatsappCloud.ts), provider selection + OTP
// routing (packages/adapters/src/whatsapp.ts), and the /webhook/meta
// handshake, signature check, parsing, dedupe, and reply path
// (apps/server/src/whatsappCloudWebhook.ts). Follows tests/otpAuth.test.ts's
// pattern: tsx/cjs require, in-memory DB, createApp() per test. Phones are
// dummy Kenyan-shaped numbers, not real subscribers.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs');

process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';
process.env.AUTH_SECRET = 'test-auth-secret';
process.env.NODE_ENV = 'development';
for (const k of [
  'WHATSAPP_PROVIDER',
  'META_WA_ACCESS_TOKEN',
  'META_WA_PHONE_NUMBER_ID',
  'META_WA_OTP_TEMPLATE',
  'META_APP_SECRET',
  'META_WEBHOOK_VERIFY_TOKEN',
  'META_SIGNATURE_ENFORCE',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_NUMBER',
]) {
  delete process.env[k];
}

const db = require('../apps/server/src/database');
const { createApp } = require('../apps/server/src/app');
const wa = require('../packages/adapters/src/whatsapp');
const cloud = require('../packages/adapters/src/whatsappCloud');
const hook = require('../apps/server/src/whatsappCloudWebhook');

const SECRET = 'test-app-secret';
const PHONE_NUMBER_ID = '111222333';

function sign(body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

function inbound(message: Record<string, unknown>, opts: { name?: string; phoneNumberId?: string } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550000000', phone_number_id: opts.phoneNumberId ?? PHONE_NUMBER_ID },
              contacts: [{ wa_id: message.from, profile: { name: opts.name ?? 'Test Mum' } }],
              messages: [{ timestamp: '1760000000', ...message }],
            },
          },
        ],
      },
    ],
  };
}

let counter = 0;
function freshWaId(): string {
  counter += 1;
  return `2547000090${String(counter).padStart(2, '0')}`;
}

const sent: { to: string; message: string }[] = [];

beforeAll(async () => {
  await db.initializeDatabase();
});

afterAll(() => {
  wa.__resetSendImpl();
});

beforeEach(() => {
  sent.length = 0;
  hook.__resetSeenMessages();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  wa.__resetSendImpl();
});

function recordSends() {
  wa.__setSendImpl(async (to: string, message: string) => {
    sent.push({ to, message });
    return { mocked: true };
  });
}

function mockFetch(status = 200, json: unknown = { messages: [{ id: 'wamid.OUT' }] }) {
  const fetchMock = vi.fn(async () => ({ ok: status < 400, status, json: async () => json }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Cloud API client', () => {
  beforeEach(() => {
    vi.stubEnv('META_WA_ACCESS_TOKEN', 'test-token');
    vi.stubEnv('META_WA_PHONE_NUMBER_ID', PHONE_NUMBER_ID);
  });

  it('maps the whatsapp:+E.164 identity to bare digits and back', () => {
    expect(cloud.toMetaRecipient('whatsapp:+254700000001')).toBe('254700000001');
    expect(hook.fromMetaSender('254700000001')).toBe('whatsapp:+254700000001');
  });

  it('sends free-form text to the configured phone number id', async () => {
    const fetchMock = mockFetch();
    await cloud.sendCloudText('whatsapp:+254700000001', 'Hello');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect(JSON.parse(init.body as string)).toMatchObject({
      messaging_product: 'whatsapp',
      to: '254700000001',
      type: 'text',
      text: { body: 'Hello' },
    });
  });

  it('surfaces Meta error codes (e.g. 131047, outside the 24h window)', async () => {
    mockFetch(400, { error: { message: 'Re-engagement message', code: 131047 } });
    await expect(cloud.sendCloudText('whatsapp:+254700000001', 'Hi')).rejects.toMatchObject({
      name: 'CloudApiError',
      status: 400,
      code: 131047,
    });
  });

  it('retries a network failure (no HTTP response) and then delivers', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.OUT' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    await cloud.sendCloudText('whatsapp:+254700000001', 'Hello');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after two retries and names the underlying cause', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(cloud.sendCloudText('whatsapp:+254700000001', 'Hi')).rejects.toMatchObject({
      name: 'CloudApiError',
      status: 0,
      message: expect.stringContaining('ENOTFOUND'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never retries once Meta has answered, even with a 5xx (could double-send)', async () => {
    const fetchMock = mockFetch(500, { error: { message: 'Internal error', code: 1 } });
    await expect(cloud.sendCloudText('whatsapp:+254700000001', 'Hi')).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never retries our own timeout (the send may already be in flight)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(cloud.sendCloudText('whatsapp:+254700000001', 'Hi')).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the OTP as an authentication template with the code in body and button', async () => {
    const fetchMock = mockFetch();
    await cloud.sendCloudOtpTemplate('whatsapp:+254700000001', '123456', 'amaaii_otp');
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('amaaii_otp');
    expect(body.template.language).toEqual({ code: 'en' });
    expect(body.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: '123456' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '123456' }] },
    ]);
  });
});

describe('provider selection', () => {
  it('defaults to Twilio', () => {
    expect(wa.whatsappProvider()).toBe('twilio');
  });

  it('WHATSAPP_PROVIDER=meta sends through the Cloud API', async () => {
    vi.stubEnv('WHATSAPP_PROVIDER', 'meta');
    vi.stubEnv('META_WA_ACCESS_TOKEN', 'test-token');
    vi.stubEnv('META_WA_PHONE_NUMBER_ID', PHONE_NUMBER_ID);
    const fetchMock = mockFetch();
    expect(wa.isWhatsAppConfigured()).toBe(true);
    await wa.sendWhatsAppMessage('whatsapp:+254700000001', 'Hi');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('OTP uses the template on Meta when one is configured, plain text otherwise', async () => {
    vi.stubEnv('WHATSAPP_PROVIDER', 'meta');
    vi.stubEnv('META_WA_ACCESS_TOKEN', 'test-token');
    vi.stubEnv('META_WA_PHONE_NUMBER_ID', PHONE_NUMBER_ID);
    const fetchMock = mockFetch();

    await wa.sendWhatsAppOtp('whatsapp:+254700000001', '654321', 'Your code is 654321');
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).type).toBe('text');

    vi.stubEnv('META_WA_OTP_TEMPLATE', 'amaaii_otp');
    await wa.sendWhatsAppOtp('whatsapp:+254700000001', '654321', 'Your code is 654321');
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).type).toBe('template');
  });
});

describe('GET /webhook/meta (subscription handshake)', () => {
  it('echoes hub.challenge when the verify token matches', async () => {
    vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', 'verify-me');
    const res = await request(createApp()).get('/webhook/meta').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'verify-me',
      'hub.challenge': '1158201444',
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('1158201444');
  });

  it('403s on a wrong token, and when no token is configured at all', async () => {
    vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', 'verify-me');
    const wrong = await request(createApp())
      .get('/webhook/meta')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' });
    expect(wrong.status).toBe(403);

    vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', '');
    const unset = await request(createApp())
      .get('/webhook/meta')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' });
    expect(unset.status).toBe(403);
  });
});

describe('POST /webhook/meta (signature)', () => {
  it('403s an unsigned or wrongly signed delivery in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('META_APP_SECRET', SECRET);
    const body = JSON.stringify(inbound({ from: freshWaId(), id: 'wamid.S1', type: 'text', text: { body: 'hi' } }));

    const unsigned = await request(createApp()).post('/webhook/meta').set('Content-Type', 'application/json').send(body);
    expect(unsigned.status).toBe(403);

    const tampered = await request(createApp())
      .post('/webhook/meta')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body.replace('hi', 'yo')))
      .send(body);
    expect(tampered.status).toBe(403);
  });

  it('accepts a correctly signed delivery', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('META_APP_SECRET', SECRET);
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const res = await request(createApp())
      .post('/webhook/meta')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);
    expect(res.status).toBe(200);
  });
});

describe('parseCloudWebhook', () => {
  it('extracts text, quick-reply and interactive replies with the sender mapped to whatsapp:+', () => {
    const from = freshWaId();
    const parsed = hook.parseCloudWebhook(inbound({ from, id: 'wamid.T', type: 'text', text: { body: 'Hello' } }));
    expect(parsed.messages).toEqual([
      { id: 'wamid.T', from: `whatsapp:+${from}`, profileName: 'Test Mum', type: 'text', text: 'Hello' },
    ]);
    expect(
      hook.parseCloudWebhook(inbound({ from, id: 'wamid.B', type: 'button', button: { text: 'Yes', payload: 'y' } }))
        .messages[0].text
    ).toBe('Yes');
    expect(
      hook.parseCloudWebhook(
        inbound({ from, id: 'wamid.I', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'a', title: 'Week 20' } } })
      ).messages[0].text
    ).toBe('Week 20');
  });

  it('marks voice notes / images as unreadable (text null) and drops reactions entirely', () => {
    const from = freshWaId();
    expect(hook.parseCloudWebhook(inbound({ from, id: 'wamid.A', type: 'audio', audio: { id: 'media1' } })).messages[0].text).toBeNull();
    expect(hook.parseCloudWebhook(inbound({ from, id: 'wamid.R', type: 'reaction', reaction: { emoji: '👍' } })).messages).toEqual([]);
  });

  it('ignores events addressed to a different phone number on the same account', () => {
    const payload = inbound({ from: freshWaId(), id: 'wamid.O', type: 'text', text: { body: 'hi' } }, { phoneNumberId: '999' });
    expect(hook.parseCloudWebhook(payload, PHONE_NUMBER_ID).messages).toEqual([]);
  });

  it('collects delivery statuses with their error code', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: PHONE_NUMBER_ID },
                statuses: [{ id: 'wamid.X', status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message' }] }],
              },
            },
          ],
        },
      ],
    };
    expect(hook.parseCloudWebhook(payload).statuses).toEqual([
      { id: 'wamid.X', status: 'failed', errorCode: 131047, errorTitle: 'Re-engagement message' },
    ]);
  });
});

describe('processing inbound messages', () => {
  beforeEach(() => {
    vi.stubEnv('WHATSAPP_PROVIDER', 'meta');
    recordSends();
  });

  it('replies to the sender under the existing whatsapp:+ identity', async () => {
    const from = freshWaId();
    await hook.processCloudWebhook(inbound({ from, id: `wamid.${from}`, type: 'text', text: { body: 'Hi' } }));
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(`whatsapp:+${from}`);
    // A brand-new phone hits the consent gate first (consentWhatsApp.test.ts).
    expect(await db.getUser(`whatsapp:+${from}`)).toBeDefined();
  });

  it('processes a redelivered message only once', async () => {
    const from = freshWaId();
    const payload = inbound({ from, id: `wamid.dup.${from}`, type: 'text', text: { body: 'Hi' } });
    await hook.processCloudWebhook(payload);
    await hook.processCloudWebhook(payload);
    expect(sent).toHaveLength(1);
  });

  it('answers a voice note with the text-only notice, danger-sign line included', async () => {
    const from = freshWaId();
    await hook.processCloudWebhook(inbound({ from, id: `wamid.v.${from}`, type: 'audio', audio: { id: 'm' } }));
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toMatch(/only read text/);
    expect(sent[0].message).toMatch(/nearest health facility/);
  });

  it('ignores inbound messages while WHATSAPP_PROVIDER is still twilio', async () => {
    vi.stubEnv('WHATSAPP_PROVIDER', 'twilio');
    const from = freshWaId();
    await hook.processCloudWebhook(inbound({ from, id: `wamid.t.${from}`, type: 'text', text: { body: 'Hi' } }));
    expect(sent).toHaveLength(0);
  });

  it('acks the HTTP delivery before processing, then replies', async () => {
    const from = freshWaId();
    const body = JSON.stringify(inbound({ from, id: `wamid.h.${from}`, type: 'text', text: { body: 'Hi' } }));
    const res = await request(createApp())
      .post('/webhook/meta')
      .set('Content-Type', 'application/json')
      .send(body); // NODE_ENV=development + no META_SIGNATURE_ENFORCE → unsigned allowed
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(sent.map((s) => s.to)).toContain(`whatsapp:+${from}`));
  });
});
