// P4-B: minimal alerting seam — proportionate for a single-process pilot
// deployment (the work order is explicit: do NOT build a full alerting
// system). `notifyCritical` is the one entry point every critical-path
// caller goes through: apps/server/src/errorHandler.ts on every request
// that reaches the global backstop, and apps/server/src/jobWorker.ts
// when the job queue's per-cycle failure count crosses a threshold.
//
// CONTRACT:
//  - ALWAYS logs one ERROR-level line via the redacting logger — even
//    when ALERT_WEBHOOK_URL is unset, so a pilot that hasn't wired a
//    webhook yet still has something to alert on: most hosts (Render,
//    Railway, a systemd journal, ...) offer log-line-based alerting
//    (grep/CloudWatch-style filters on "[ERROR]") even without a
//    dedicated integration. See the PILOTS note below.
//  - When ALERT_WEBHOOK_URL is set, ALSO POSTs a small JSON payload —
//    { event, message, requestId, timestamp } — to that URL, and
//    NOTHING else: no phone numbers, names, or message content.
//    `message` is additionally passed through core's redactText() as a
//    defense-in-depth belt-and-braces measure before it ever leaves the
//    process (the log line above already gets this for free from
//    logger.ts's own redact() pass; the outbound webhook body does not
//    share that pipeline, so it's applied explicitly here).
//  - Fire-and-forget: the POST is never awaited by the caller, and any
//    failure (network error, non-2xx, timeout) is caught and logged,
//    never thrown — this function must never be able to break or slow
//    down the request that triggered it.
//
// PILOTS: point ALERT_WEBHOOK_URL at a Slack incoming webhook or a
// pager/on-call tool's HTTP intake (most accept a generic JSON POST
// directly, or can be fronted with a tiny relay if the payload shape
// needs adapting). Until that's wired up, rely on host log-based
// alerting against the ERROR-level lines this always emits.
import { redactText } from '@amaaii/core';
import { log } from './logger';

export interface AlertContext {
  /** Short human-readable description. Defaults to `event` if omitted. */
  message?: string;
  /** Correlation id of the request that triggered this alert, if any. */
  requestId?: string | null;
}

const WEBHOOK_TIMEOUT_MS = 5000;

function postWebhook(url: string, payload: Record<string, unknown>): void {
  // Fire-and-forget — deliberately not awaited by notifyCritical below.
  // AbortSignal.timeout keeps a slow/hanging endpoint from accumulating
  // dangling requests indefinitely.
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  })
    .then((res) => {
      if (!res.ok) {
        log.warn('alerts: webhook responded non-2xx (swallowed, non-fatal)', { status: res.status });
      }
    })
    .catch((err) => {
      log.error('alerts: webhook POST failed (swallowed, non-fatal)', err);
    });
}

/**
 * Fires a critical alert. `event` is a short machine-readable name (e.g.
 * 'unhandled_error', 'jobs_failed_threshold') — always a fixed string
 * chosen by the caller, never derived from user input. Never pass a
 * phone number, name, or message content anywhere in `context` — this
 * is a hard rule, same as every other log/metrics call site in this
 * codebase (see this file's header).
 */
export function notifyCritical(event: string, context: AlertContext = {}): void {
  const timestamp = new Date().toISOString();
  const message = redactText(context.message ?? event);
  const requestId = context.requestId ?? null;
  const payload = { event, message, requestId, timestamp };

  log.error(`ALERT: ${event}`, undefined, payload);

  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;

  try {
    postWebhook(url, payload);
  } catch (err) {
    // postWebhook's own promise chain already handles every async
    // failure mode (network error, non-2xx, timeout) — this synchronous
    // try/catch is defense against something unexpected throwing before
    // fetch() even starts (e.g. a malformed URL), so notifyCritical can
    // never itself throw back into its caller (the global error
    // handler, which must never fail while already handling a failure).
    log.error('alerts: failed to initiate webhook POST (swallowed, non-fatal)', err);
  }
}
