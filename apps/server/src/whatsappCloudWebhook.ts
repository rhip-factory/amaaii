// Meta WhatsApp Cloud API webhook — the inbound half of the Meta
// transport (outbound lives in packages/adapters/src/whatsappCloud.ts).
// Mounted by app.ts at /webhook/meta, AHEAD of the global body parsers,
// because the signature is an HMAC over the exact raw bytes Meta sent.
//
// Differences from the Twilio /webhook that shape this file:
//  - GET is a subscription handshake: echo hub.challenge back only when
//    hub.verify_token matches META_WEBHOOK_VERIFY_TOKEN.
//  - POST is acked with 200 BEFORE processing. Meta retries any delivery
//    that isn't acked promptly, and a reply can take seconds (LLM call),
//    so processing inline would invite duplicate deliveries.
//  - Duplicates still happen occasionally, so messages are deduped on
//    their WAMID. The seen-set is in memory: a restart forgets it, which
//    only matters if Meta redelivers across that restart — rare, given we
//    ack before doing any work.
//  - Senders arrive as bare digits and are mapped back to the
//    `whatsapp:+E.164` identity every table is keyed on (fromMetaSender).
//  - Voice notes, photos, etc. arrive as their own message types. The bot
//    can only triage text, so those get a canned reply that still carries
//    the go-to-a-facility danger-sign line — a mother sending a voice note
//    about bleeding must not get silence.

import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { markReadWithTyping, sendWhatsAppMessage, whatsappProvider } from '@amaaii/adapters';
import { t } from '@amaaii/core';
import { handleIncomingMessage } from './messageHandler';
import { getUser } from './database';
import { log } from './logger';

export interface CloudInboundMessage {
  id: string;
  from: string; // already mapped to `whatsapp:+E.164`
  profileName: string | null;
  type: string;
  text: string | null; // null = a type the bot can't read (voice note, image, ...)
}

export interface CloudStatus {
  id: string;
  status: string;
  errorCode?: number;
  errorTitle?: string;
}

export interface ParsedCloudWebhook {
  messages: CloudInboundMessage[];
  statuses: CloudStatus[];
}

// Message types that need no reply at all: a reaction emoji, Meta's own
// system notices, and the "user opened the chat" welcome request.
const SILENT_TYPES = new Set(['reaction', 'system', 'request_welcome']);

/** `254712345678` → `whatsapp:+254712345678` (inverse of toMetaRecipient). */
export function fromMetaSender(waId: string): string {
  return `whatsapp:+${waId.replace(/^\+/, '')}`;
}

function textOf(m: any): string | null {
  switch (m.type) {
    case 'text':
      return m.text?.body ?? null;
    case 'button': // quick-reply button on a template
      return m.button?.text ?? null;
    case 'interactive':
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
    default:
      return null;
  }
}

/**
 * Flattens a webhook payload into the messages and delivery statuses we
 * act on. When `phoneNumberId` is given, events for any other number on
 * the same WhatsApp Business Account are dropped — a reply always goes out
 * from META_WA_PHONE_NUMBER_ID, so answering a message sent to a different
 * number would come from the wrong sender.
 */
export function parseCloudWebhook(body: unknown, phoneNumberId?: string): ParsedCloudWebhook {
  const out: ParsedCloudWebhook = { messages: [], statuses: [] };
  const payload = body as any;
  if (payload?.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) return out;

  for (const entry of payload.entry) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'messages') continue;
      const value = change.value ?? {};
      if (phoneNumberId && value.metadata?.phone_number_id !== phoneNumberId) {
        log.warn('Cloud API webhook for another phone number ignored');
        continue;
      }
      const names = new Map<string, string>();
      for (const c of value.contacts ?? []) {
        if (c?.wa_id && c.profile?.name) names.set(c.wa_id, c.profile.name);
      }
      for (const m of value.messages ?? []) {
        if (!m?.id || !m.from || SILENT_TYPES.has(m.type)) continue;
        out.messages.push({
          id: m.id,
          from: fromMetaSender(m.from),
          profileName: names.get(m.from) ?? null,
          type: m.type,
          text: textOf(m),
        });
      }
      for (const s of value.statuses ?? []) {
        if (!s?.id || !s.status) continue;
        out.statuses.push({
          id: s.id,
          status: s.status,
          errorCode: s.errors?.[0]?.code,
          errorTitle: s.errors?.[0]?.title,
        });
      }
    }
  }
  return out;
}

/** Meta's `X-Hub-Signature-256: sha256=<hex>` — HMAC-SHA256 of the raw body keyed by the app secret. */
export function verifyCloudSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !secret || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = header.slice('sha256='.length);
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

// Same semantics as TWILIO_SIGNATURE_ENFORCE (middleware/twilioSignature.ts):
// explicit 'true'/'false' wins; unset enforces only in production.
function shouldEnforce(): boolean {
  const flag = process.env.META_SIGNATURE_ENFORCE;
  if (flag !== undefined && flag !== '') return flag.toLowerCase() === 'true';
  return process.env.NODE_ENV === 'production';
}

const SEEN_LIMIT = 5000;
const seenMessageIds = new Set<string>();

function firstSighting(id: string): boolean {
  if (seenMessageIds.has(id)) return false;
  seenMessageIds.add(id);
  if (seenMessageIds.size > SEEN_LIMIT) {
    // Sets iterate in insertion order, so this evicts the oldest id.
    seenMessageIds.delete(seenMessageIds.values().next().value as string);
  }
  return true;
}

export function __resetSeenMessages(): void {
  seenMessageIds.clear();
}

async function replyUnsupported(from: string): Promise<void> {
  const user = await getUser(from).catch(() => undefined);
  await sendWhatsAppMessage(from, t(user?.language, 'unsupported_message_type'));
}

export async function processCloudWebhook(body: unknown): Promise<void> {
  const { messages, statuses } = parseCloudWebhook(body, process.env.META_WA_PHONE_NUMBER_ID);

  for (const s of statuses) {
    if (s.status === 'failed') {
      // 131047 = outside the 24-hour window; 131026 = recipient can't receive.
      log.warn('WhatsApp delivery failed', { messageId: s.id, code: s.errorCode, title: s.errorTitle });
    }
  }

  if (messages.length > 0 && whatsappProvider() !== 'meta') {
    // Replies would go out through Twilio, from a different number.
    log.warn('Cloud API message ignored: WHATSAPP_PROVIDER is not "meta"');
    return;
  }

  for (const m of messages) {
    if (!firstSighting(m.id)) {
      log.info('Duplicate Cloud API delivery skipped', { messageId: m.id });
      continue;
    }
    void markReadWithTyping(m.id);
    try {
      if (m.text === null) {
        log.info('Unsupported WhatsApp message type', { From: m.from, type: m.type });
        await replyUnsupported(m.from);
        continue;
      }
      log.info('Received message', { From: m.from, ProfileName: m.profileName, Body: m.text });
      await handleIncomingMessage(m.from, m.text, m.profileName);
    } catch (error) {
      log.error('Error processing Cloud API message', error);
    }
  }
}

export function cloudWebhookVerify(req: Request, res: Response): void {
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN;
  const challenge = req.query['hub.challenge'];
  if (
    req.query['hub.mode'] === 'subscribe' &&
    expected &&
    req.query['hub.verify_token'] === expected &&
    typeof challenge === 'string'
  ) {
    res.status(200).type('text/plain').send(challenge);
    return;
  }
  log.warn('Rejected Cloud API webhook verification');
  res.sendStatus(403);
}

export function cloudWebhookReceive(req: Request, res: Response): void {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!verifyCloudSignature(raw, req.header('X-Hub-Signature-256'), process.env.META_APP_SECRET || '')) {
    if (shouldEnforce()) {
      log.warn('Rejected webhook: invalid Cloud API signature', { hasSignature: !!req.header('X-Hub-Signature-256') });
      res.status(403).send('Forbidden');
      return;
    }
    log.warn('Cloud API signature invalid (enforce=off, allowing)');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    res.status(400).send('Bad Request');
    return;
  }

  res.status(200).send('EVENT_RECEIVED');
  processCloudWebhook(payload).catch((error) => log.error('Error processing Cloud API webhook', error));
}
