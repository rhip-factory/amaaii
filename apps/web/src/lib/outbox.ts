// Offline submission queue (P2-D). Lives in the app layer, not the
// service worker, because it has to work in `next dev` too, where the SW
// is never registered (see ServiceWorkerRegister.tsx) — a mother
// filling in a check-in on a flaky connection during development needs
// the same guarantee a production install gets.
//
// One IndexedDB row per queued submission, keyed by clientEntryId — the
// same id JournalCheckIn.tsx already generates and the server already
// dedupes on (POST /journal/entries, see apps/server/src/app.ts). That
// makes the outbox itself idempotent for free: queuing the same
// clientEntryId twice just overwrites the row, and a flush that races a
// direct online submit of the same id is deduped server-side either way.

import { openKVStore, type KVStore } from './idbStore';
import type { JournalEntryInput, JournalEntrySubmitResponse } from './types';

export interface OutboxItem {
  clientEntryId: string;
  payload: JournalEntryInput;
  queuedAt: number;
  attempts: number;
}

const STORE_NAME = 'outbox';
const SYNC_TAG = 'amaaii-flush-outbox';

function defaultStore(): KVStore<OutboxItem> {
  return openKVStore<OutboxItem>(STORE_NAME, (item) => item.clientEntryId);
}

export async function addToOutbox(
  payload: JournalEntryInput,
  store: KVStore<OutboxItem> = defaultStore()
): Promise<OutboxItem> {
  const item: OutboxItem = { clientEntryId: payload.clientEntryId, payload, queuedAt: Date.now(), attempts: 0 };
  await store.put(item);
  void registerBackgroundSync(); // best-effort, fire and forget
  return item;
}

export async function getOutboxItems(store: KVStore<OutboxItem> = defaultStore()): Promise<OutboxItem[]> {
  const items = await store.getAll();
  return items.slice().sort((a, b) => a.queuedAt - b.queuedAt);
}

export async function removeFromOutbox(
  clientEntryId: string,
  store: KVStore<OutboxItem> = defaultStore()
): Promise<void> {
  await store.delete(clientEntryId);
}

// --- Submit-result classification ---------------------------------------
// The rule (design item 1): a network failure (fetch TypeError, timeout/
// AbortError, a 5xx, anything that isn't the server deliberately
// rejecting the payload) means "keep trying later". A 4xx means the
// server looked at this exact payload and said no — retrying it
// unmodified would just fail again, so it's dropped and surfaced instead
// of retried forever. JournalCheckIn's own online-path catch uses this
// same helper so the two call sites (direct submit, queued flush) can't
// drift on what counts as "the server rejected this".
export function isClientRejection(err: unknown): err is { status: number } {
  const status = (err as { status?: number } | null | undefined)?.status;
  // 401 is deliberately excluded: it means "not authenticated right now",
  // not "the server looked at this payload and rejected it". authedFetch
  // (api.ts) already redirects to /login on 401 as a global side effect —
  // dropping a perfectly valid queued entry because the session happened
  // to expire while it was mid-flush would lose real data for no reason.
  // Treating it as a network-style failure keeps the item queued; it'll
  // flush again next app start, once re-authenticated.
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 401;
}

export type SubmitOutcome =
  | { kind: 'success'; response: JournalEntrySubmitResponse }
  | { kind: 'network'; error: unknown }
  | { kind: 'client-error'; status: number; message: string };

async function classifySubmit(
  submit: (payload: JournalEntryInput) => Promise<JournalEntrySubmitResponse>,
  payload: JournalEntryInput
): Promise<SubmitOutcome> {
  try {
    const response = await submit(payload);
    return { kind: 'success', response };
  } catch (err) {
    if (isClientRejection(err)) {
      const message = err instanceof Error ? err.message : 'The server rejected this check-in.';
      return { kind: 'client-error', status: (err as { status: number }).status, message };
    }
    return { kind: 'network', error: err };
  }
}

export interface FlushSummary {
  synced: string[];
  dropped: { clientEntryId: string; message: string }[];
  /** Items still queued after this pass (0 unless a network failure stopped it early). */
  remaining: number;
}

export interface FlushDeps {
  submit: (payload: JournalEntryInput) => Promise<JournalEntrySubmitResponse>;
  onItemSynced?: (item: OutboxItem, response: JournalEntrySubmitResponse) => void;
  onItemDropped?: (item: OutboxItem, message: string) => void;
  store?: KVStore<OutboxItem>;
}

let inFlightFlush: Promise<FlushSummary> | null = null;

// Re-entrancy-safe: a caller that arrives while a flush is already
// running gets the SAME promise instead of starting a second concurrent
// pass over the store (which could submit an item twice — once from each
// pass — before either has a chance to delete it).
export function flushOutbox(deps: FlushDeps): Promise<FlushSummary> {
  if (inFlightFlush) return inFlightFlush;
  inFlightFlush = runFlush(deps).finally(() => {
    inFlightFlush = null;
  });
  return inFlightFlush;
}

export function isFlushInFlight(): boolean {
  return inFlightFlush !== null;
}

async function runFlush(deps: FlushDeps): Promise<FlushSummary> {
  const store = deps.store ?? defaultStore();
  const items = await getOutboxItems(store);
  const summary: FlushSummary = { synced: [], dropped: [], remaining: 0 };

  for (let i = 0; i < items.length; i++) {
    // Non-null assertion: `i` is always < items.length here, but
    // noUncheckedIndexedAccess (apps/web/tsconfig.json) can't see that.
    const item = items[i]!;
    const outcome = await classifySubmit(deps.submit, item.payload);

    if (outcome.kind === 'success') {
      await store.delete(item.clientEntryId);
      summary.synced.push(item.clientEntryId);
      deps.onItemSynced?.(item, outcome.response);
      continue;
    }

    if (outcome.kind === 'client-error') {
      await store.delete(item.clientEntryId);
      summary.dropped.push({ clientEntryId: item.clientEntryId, message: outcome.message });
      deps.onItemDropped?.(item, outcome.message);
      continue;
    }

    // Network failure: keep the item (bump attempts) and stop — the rest
    // of the queue is presumably equally unreachable right now. The next
    // trigger ('online' event, app start, or a later successful submit —
    // wired up in OutboxContext) picks up where this left off.
    await store.put({ ...item, attempts: item.attempts + 1 });
    summary.remaining = items.length - i;
    return summary;
  }

  return summary;
}

// --- Background Sync registration (progressive enhancement) -------------
// Best-effort: asks the browser to wake the service worker with a 'sync'
// event once connectivity returns, even if this tab has since closed.
// Not supported in Safari/Firefox — feature-detected below, and NOT
// required for correctness: the guaranteed path is the app-layer flush
// (on 'online' / app start / after each successful submit — see
// OutboxContext.tsx). The service worker itself can't perform the
// authenticated POST: the bearer token lives in localStorage, which a
// service worker cannot read. So public/sw.js's 'sync' handler just
// wakes any open tab to run this same authenticated flush rather than
// re-implementing auth in plain-JS SW code.
export async function registerBackgroundSync(): Promise<void> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    const syncable = reg as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } };
    if (syncable.sync) await syncable.sync.register(SYNC_TAG);
  } catch {
    /* best effort — app-layer flush triggers still cover this */
  }
}

export const OUTBOX_SYNC_TAG = SYNC_TAG;
