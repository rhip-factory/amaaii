// P2-D: the stale-while-revalidate offline-read cache
// (apps/web/src/lib/offlineCache.ts), which fetchMe / fetchTodayJournal /
// fetchJournalHistory in api.ts build on so Home/Journal render
// last-known content offline instead of a blank screen or an infinite
// spinner. Storage seam is the same MemoryKVStore used by the outbox
// tests — see tests/outbox.test.ts's header comment for why that's
// enough without a fake-indexeddb dependency.
import { describe, it, expect, vi } from 'vitest';
import { MemoryKVStore } from '../apps/web/src/lib/idbStore';
import { cachedGet, readCache, writeCache, OfflineNoDataError } from '../apps/web/src/lib/offlineCache';

interface CacheRecord<T> {
  key: string;
  data: T;
  cachedAt: number;
}

function makeStore<T>() {
  return new MemoryKVStore<CacheRecord<T>>((r) => r.key);
}

describe('offlineCache (P2-D stale-while-revalidate)', () => {
  it('online + fetch succeeds: returns fresh data (stale: false) and writes it to the cache', async () => {
    const store = makeStore<{ n: number }>();
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    const result = await cachedGet('k', fetcher, { isOnline: () => true }, store);
    expect(result).toEqual({ data: { n: 1 }, stale: false });
    expect((await readCache('k', store))?.data).toEqual({ n: 1 });
  });

  it('offline with a cached value: returns it immediately marked stale, without calling the fetcher', async () => {
    const store = makeStore<{ n: number }>();
    await writeCache('k', { n: 7 }, store);
    const fetcher = vi.fn();
    const result = await cachedGet('k', fetcher, { isOnline: () => false }, store);
    expect(result).toEqual({ data: { n: 7 }, stale: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('offline with no cached value: throws OfflineNoDataError instead of hanging or crashing', async () => {
    const store = makeStore<{ n: number }>();
    const fetcher = vi.fn();
    await expect(cachedGet('missing', fetcher, { isOnline: () => false }, store)).rejects.toBeInstanceOf(
      OfflineNoDataError
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('online but the fetch fails (network error): falls back to a cached value, marked stale', async () => {
    const store = makeStore<{ n: number }>();
    await writeCache('k', { n: 3 }, store);
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await cachedGet('k', fetcher, { isOnline: () => true }, store);
    expect(result).toEqual({ data: { n: 3 }, stale: true });
  });

  it('online, fetch fails, and there is no cache: rethrows the original error rather than swallowing it', async () => {
    const store = makeStore<{ n: number }>();
    const err = new TypeError('Failed to fetch');
    const fetcher = vi.fn().mockRejectedValue(err);
    await expect(cachedGet('k', fetcher, { isOnline: () => true }, store)).rejects.toBe(err);
  });

  it('a later successful fetch overwrites the stale cached value for the same key', async () => {
    const store = makeStore<{ n: number }>();
    await writeCache('k', { n: 1 }, store);
    const fetcher = vi.fn().mockResolvedValue({ n: 2 });
    const result = await cachedGet('k', fetcher, { isOnline: () => true }, store);
    expect(result).toEqual({ data: { n: 2 }, stale: false });
    expect((await readCache('k', store))?.data).toEqual({ n: 2 });
  });
});
