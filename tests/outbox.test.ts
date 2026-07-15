// P2-D: the offline submission queue (apps/web/src/lib/outbox.ts).
//
// Storage seam: outbox.ts's functions all take an optional KVStore<T>
// (last argument / deps.store). Tests inject a MemoryKVStore
// (apps/web/src/lib/idbStore.ts) directly instead of polyfilling
// IndexedDB with a fake-indexeddb dependency — MemoryKVStore is real
// production fallback code (used automatically when indexedDB isn't
// available, e.g. Safari private browsing), not test-only scaffolding,
// so this exercises the exact same code path a browser without
// IndexedDB would take, with no extra dev dependency required.
import { describe, it, expect, vi } from 'vitest';
import { MemoryKVStore } from '../apps/web/src/lib/idbStore';
import {
  addToOutbox,
  getOutboxItems,
  removeFromOutbox,
  flushOutbox,
  isFlushInFlight,
  isClientRejection,
  type OutboxItem,
} from '../apps/web/src/lib/outbox';
import type { JournalEntryInput, JournalEntrySubmitResponse } from '../apps/web/src/lib/types';

function makeStore() {
  return new MemoryKVStore<OutboxItem>((item) => item.clientEntryId);
}

function payload(clientEntryId: string): JournalEntryInput {
  return { mood: 7, symptoms: [], sleepHours: 7, appetite: 'good', clientEntryId };
}

function okResponse(clientEntryId: string, deduped = false): JournalEntrySubmitResponse {
  return {
    entry: {
      id: 1,
      date: '2026-07-15',
      clientEntryId,
      mood: 7,
      symptoms: [],
      symptomsText: null,
      sleepHours: 7,
      appetite: 'good',
      babyMovement: null,
      note: null,
      hasRedFlags: false,
      completed: true,
      startedAt: null,
      completedAt: null,
    },
    deduped,
    urgencyLevel: 'low',
  };
}

describe('outbox (P2-D)', () => {
  it('add/list/remove round-trip, ordered oldest-first by queuedAt', async () => {
    const store = makeStore();
    await addToOutbox(payload('b'), store);
    await addToOutbox(payload('a'), store);
    const items = await getOutboxItems(store);
    // Array.prototype.sort is stable (ES2019+), so equal-or-close
    // queuedAt timestamps still preserve insertion order deterministically.
    expect(items.map((i) => i.clientEntryId)).toEqual(['b', 'a']);
    expect(items.every((i) => i.attempts === 0)).toBe(true);

    await removeFromOutbox('b', store);
    expect((await getOutboxItems(store)).map((i) => i.clientEntryId)).toEqual(['a']);
  });

  it('isClientRejection: true for 400-499 excluding 401, false for network/5xx errors', () => {
    expect(isClientRejection(Object.assign(new Error('x'), { status: 400 }))).toBe(true);
    expect(isClientRejection(Object.assign(new Error('x'), { status: 422 }))).toBe(true);
    expect(isClientRejection(Object.assign(new Error('x'), { status: 401 }))).toBe(false);
    expect(isClientRejection(Object.assign(new Error('x'), { status: 500 }))).toBe(false);
    expect(isClientRejection(new TypeError('Failed to fetch'))).toBe(false);
    expect(isClientRejection(null)).toBe(false);
  });

  it('flush removes an item on a 2xx success response', async () => {
    const store = makeStore();
    await addToOutbox(payload('x'), store);
    const submit = vi.fn().mockResolvedValue(okResponse('x'));
    const synced: string[] = [];
    const summary = await flushOutbox({ submit, store, onItemSynced: (item) => synced.push(item.clientEntryId) });
    expect(summary.synced).toEqual(['x']);
    expect(summary.dropped).toEqual([]);
    expect(synced).toEqual(['x']);
    expect(await getOutboxItems(store)).toEqual([]);
  });

  it('flush removes an item on a deduped response (server-side idempotency replay)', async () => {
    const store = makeStore();
    await addToOutbox(payload('y'), store);
    const submit = vi.fn().mockResolvedValue(okResponse('y', true));
    const summary = await flushOutbox({ submit, store });
    expect(summary.synced).toEqual(['y']);
    expect(await getOutboxItems(store)).toEqual([]);
  });

  it('keeps an item and bumps attempts on a network failure, and stops the pass', async () => {
    const store = makeStore();
    await addToOutbox(payload('n1'), store);
    await addToOutbox(payload('n2'), store);
    const submit = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const summary = await flushOutbox({ submit, store });
    expect(summary.synced).toEqual([]);
    expect(summary.dropped).toEqual([]);
    expect(summary.remaining).toBe(2);
    expect(submit).toHaveBeenCalledTimes(1); // stopped after the first failure, n2 untouched

    const remaining = await getOutboxItems(store);
    expect(remaining.map((i) => i.clientEntryId)).toEqual(['n1', 'n2']);
    expect(remaining[0].attempts).toBe(1);
    expect(remaining[1].attempts).toBe(0);
  });

  it('drops an item and surfaces it on a 4xx, then continues to the next item', async () => {
    const store = makeStore();
    await addToOutbox(payload('bad'), store);
    await addToOutbox(payload('good'), store);
    const submit = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('invalid_mood'), { status: 400 }))
      .mockResolvedValueOnce(okResponse('good'));
    const dropped: string[] = [];
    const summary = await flushOutbox({ submit, store, onItemDropped: (item) => dropped.push(item.clientEntryId) });

    expect(summary.dropped.map((d) => d.clientEntryId)).toEqual(['bad']);
    expect(summary.synced).toEqual(['good']);
    expect(dropped).toEqual(['bad']);
    expect(await getOutboxItems(store)).toEqual([]); // both resolved — one dropped, one synced
  });

  it('a 401 is treated as a network-style failure (kept, not dropped) — session issue, not a rejected payload', async () => {
    const store = makeStore();
    await addToOutbox(payload('needs-auth'), store);
    const submit = vi.fn().mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }));
    const summary = await flushOutbox({ submit, store });
    expect(summary.dropped).toEqual([]);
    expect(summary.synced).toEqual([]);
    const remaining = await getOutboxItems(store);
    expect(remaining.map((i) => i.clientEntryId)).toEqual(['needs-auth']);
    expect(remaining[0].attempts).toBe(1);
  });

  it('is re-entrancy-safe: a concurrent flush call gets the same in-flight promise, not a second pass', async () => {
    const store = makeStore();
    await addToOutbox(payload('once'), store);
    // A small real delay inside submit so the two flushOutbox() calls
    // below genuinely overlap in time, the way an 'online' event firing
    // while an app-start flush is still awaiting the network would.
    const submit = vi.fn(async (input: JournalEntryInput) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return okResponse(input.clientEntryId);
    });

    const p1 = flushOutbox({ submit, store });
    // Synchronous: flushOutbox sets its in-flight guard before the async
    // body ever awaits anything, so this is true immediately, not just
    // eventually.
    expect(isFlushInFlight()).toBe(true);
    const p2 = flushOutbox({ submit, store });
    expect(p1).toBe(p2); // literally the same promise, not a second concurrent pass

    const [summary1, summary2] = await Promise.all([p1, p2]);
    expect(summary1).toBe(summary2);
    expect(summary1.synced).toEqual(['once']);
    expect(submit).toHaveBeenCalledTimes(1); // not double-submitted by the second caller
    expect(isFlushInFlight()).toBe(false);
  });
});
