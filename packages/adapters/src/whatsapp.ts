// Provider-neutral WhatsApp send API. App code only ever calls
// sendWhatsAppMessage / sendWhatsAppOtp from here; WHATSAPP_PROVIDER
// (read at call time) picks the transport:
//   - unset / 'twilio' → twilio.ts (the sandbox era, still the default)
//   - 'meta'           → whatsappCloud.ts (Meta Cloud API, direct)
// Flipping the env var and restarting is the whole cutover — and the
// whole rollback.

import { sendViaTwilio } from './twilio';
import { isCloudConfigured, sendCloudOtpTemplate, sendCloudText } from './whatsappCloud';

export type WhatsAppProvider = 'twilio' | 'meta';
export type SendImpl = (to: string, message: string) => Promise<unknown>;

export function whatsappProvider(): WhatsAppProvider {
  return process.env.WHATSAPP_PROVIDER?.toLowerCase() === 'meta' ? 'meta' : 'twilio';
}

/** True when the selected provider has the credentials it needs to send. */
export function isWhatsAppConfigured(): boolean {
  if (whatsappProvider() === 'meta') return isCloudConfigured();
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_WHATSAPP_NUMBER
  );
}

async function defaultSend(to: string, message: string): Promise<unknown> {
  return whatsappProvider() === 'meta' ? sendCloudText(to, message) : sendViaTwilio(to, message);
}

// Test seam: callers (e.g. messageHandler.ts) import `sendWhatsAppMessage`
// once, so we wrap a swappable impl behind a stable function reference.
// Tests call __setSendImpl to inject a no-op recorder; reset to
// defaultSend afterwards.
let _impl: SendImpl = defaultSend;

export async function sendWhatsAppMessage(to: string, message: string): Promise<unknown> {
  return _impl(to, message);
}

/**
 * Delivers a sign-in code. On Meta with META_WA_OTP_TEMPLATE set, this goes
 * out as the approved authentication template (works outside the 24-hour
 * window); otherwise it's `text` as a plain message — fine for Twilio and
 * for Meta testing within the window, before the template is approved.
 */
export async function sendWhatsAppOtp(to: string, code: string, text: string): Promise<unknown> {
  const template = process.env.META_WA_OTP_TEMPLATE;
  // With a test seam installed, fall through so the recorder sees the text.
  if (whatsappProvider() === 'meta' && template && _impl === defaultSend) {
    return sendCloudOtpTemplate(to, code, template);
  }
  return sendWhatsAppMessage(to, text);
}

export function __setSendImpl(fn?: SendImpl): void {
  _impl = fn || defaultSend;
}

export function __resetSendImpl(): void {
  _impl = defaultSend;
}
