// Meta WhatsApp Cloud API client (Graph API, no SDK — two endpoints and a
// bearer token don't justify a dependency). Like twilio.ts, everything is
// read from process.env at CALL time, so the server boots without any
// Meta credentials and tests can stub env after import.
//
// Identity: the rest of the app keys users by the Twilio-era
// `whatsapp:+E.164` string. The Cloud API speaks bare digits
// (`254712345678`) in both directions, so translation happens at this
// boundary and nowhere else — see toMetaRecipient() here and
// fromMetaSender() in apps/server/src/whatsappCloudWebhook.ts. Getting
// this wrong would make every existing user look brand new.

import { log } from '../../../apps/server/src/logger';

const DEFAULT_GRAPH_VERSION = 'v23.0';
// Outbound IPv6 doesn't route on red-bridge (see CLAUDE.md) — never let a
// hung Graph call stall the webhook's reply path indefinitely.
const REQUEST_TIMEOUT_MS = 10000;

export class CloudApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    // Meta's numeric error code, e.g. 131047 = outside the 24-hour
    // customer-service window (a free-form message needs a template).
    readonly code: number | undefined
  ) {
    super(message);
    this.name = 'CloudApiError';
  }
}

export function isCloudConfigured(): boolean {
  return !!(process.env.META_WA_ACCESS_TOKEN && process.env.META_WA_PHONE_NUMBER_ID);
}

/** `whatsapp:+254712345678` → `254712345678` (what the Graph API expects). */
export function toMetaRecipient(phone: string): string {
  return phone.replace(/^whatsapp:/, '').replace(/^\+/, '');
}

async function postToGraph(path: string, body: Record<string, unknown>): Promise<unknown> {
  const version = process.env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION;
  const res = await fetch(`https://graph.facebook.com/${version}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.META_WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; code?: number };
  };
  if (!res.ok) {
    const code = json.error?.code;
    throw new CloudApiError(
      `WhatsApp Cloud API ${res.status}${code ? ` (code ${code})` : ''}: ${json.error?.message ?? 'unknown error'}`,
      res.status,
      code
    );
  }
  return json;
}

function messagesPath(): string {
  return `${process.env.META_WA_PHONE_NUMBER_ID}/messages`;
}

export async function sendCloudText(to: string, message: string): Promise<unknown> {
  try {
    const response = (await postToGraph(messagesPath(), {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toMetaRecipient(to),
      type: 'text',
      text: { body: message, preview_url: false },
    })) as { messages?: { id?: string }[] };
    log.info(`Message sent successfully. WAMID: ${response.messages?.[0]?.id}`);
    return response;
  } catch (error) {
    log.error('Error sending WhatsApp message (Cloud API)', error);
    throw error;
  }
}

/**
 * Sends a sign-in code through an approved AUTHENTICATION template — the
 * only way to reach a user outside the 24-hour window, which is the normal
 * case for a PWA login (the user may never have messaged the bot). Meta
 * fixes the template's wording; we only supply the code, once for the body
 * and once for the copy-code button.
 */
export async function sendCloudOtpTemplate(to: string, code: string, templateName: string): Promise<unknown> {
  try {
    const response = await postToGraph(messagesPath(), {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toMetaRecipient(to),
      type: 'template',
      template: {
        name: templateName,
        language: { code: process.env.META_WA_OTP_TEMPLATE_LANG || 'en' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
        ],
      },
    });
    log.info('OTP template sent (Cloud API)');
    return response;
  } catch (error) {
    log.error('Error sending OTP template (Cloud API)', error);
    throw error;
  }
}

/**
 * Blue ticks + a "typing…" bubble while the reply (often an LLM call) is
 * being produced. Purely cosmetic: failures are logged and swallowed so
 * they can never block the actual reply.
 */
export async function markReadWithTyping(messageId: string): Promise<void> {
  if (!isCloudConfigured()) return;
  try {
    await postToGraph(messagesPath(), {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    });
  } catch (error) {
    log.warn('Could not mark message read (Cloud API)', { error: error instanceof Error ? error.message : String(error) });
  }
}
