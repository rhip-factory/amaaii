// Ported 1:1 from services/twilio.js (P1-C). The lazy client init is
// load-bearing — commit 19af4a2 made this lazy specifically so the
// server can boot without Twilio credentials (e.g. in smoke tests / dev
// without a sandbox number configured). Do not make `getClient()` eager.

import twilio from 'twilio';

// P1-E: utils/logger.js is gone — the logger now lives in
// apps/server/src/logger.ts as real TypeScript, so this can be a normal
// `import` instead of the untyped `require()` the old CJS shim needed.
// See packages/adapters/src/sqlite/connection.ts for the note on why
// this package depends on a file inside apps/server (pre-existing
// shortcut, carried over unchanged from P1-C).
import { log } from '../../../apps/server/src/logger';

export type SendImpl = (to: string, message: string) => Promise<unknown>;

let cachedClient: ReturnType<typeof twilio> | null = null;

export function getClient(): ReturnType<typeof twilio> {
  if (cachedClient) return cachedClient;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  cachedClient = twilio(accountSid, authToken);
  return cachedClient;
}

async function defaultSend(to: string, message: string): Promise<unknown> {
  try {
    const response = await getClient().messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to,
    });

    log.info(`Message sent successfully. SID: ${response.sid}`);
    return response;
  } catch (error) {
    log.error('Error sending WhatsApp message', error);
    throw error;
  }
}

// Test seam: callers (e.g. utils/messageHandler.js) destructure
// `sendWhatsAppMessage` at require time, so we wrap a swappable impl
// behind a stable function reference. Tests call __setSendImpl to inject
// a no-op recorder; reset to defaultSend afterwards.
let _impl: SendImpl = defaultSend;

export async function sendWhatsAppMessage(to: string, message: string): Promise<unknown> {
  return _impl(to, message);
}

export function __setSendImpl(fn?: SendImpl): void {
  _impl = fn || defaultSend;
}

export function __resetSendImpl(): void {
  _impl = defaultSend;
}
