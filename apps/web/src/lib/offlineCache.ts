// Offline-read cache (P2-D) — stale-while-revalidate for the GETs the
// offline-first screens depend on: /me, /journal/today, /journal/entries.
//
// Storage choice: IndexedDB (via idbStore.ts), the same substrate as the
// outbox, rather than the Cache API. Two reasons:
//  1. One storage system, not two. The outbox already needs IndexedDB
//     (structured objects with metadata, keyed lookups, no Request/
//     Response involved). Reusing it for cached JSON avoids maintaining
//     a second read/write path and a second "is it available" fallback.
//  2. The Cache API is designed around Request/Response objects and is
//     most ergonomic when paired with a service worker intercepting
//     fetches — it works from window too, but storing typed JSON with a
//     staleness timestamp means wrapping every read in a synthetic
//     Response just to unwrap it again. IndexedDB stores the value
//     directly. (The service worker still gets its own Cache API layer
//     for the app *shell* — see public/sw.js — that's a different job:
//     caching whole HTTP responses for hashed build assets and
//     navigations, not decorating API JSON with a stale flag.)

import { openKVStore, type KVStore } from './idbStore';

interface CacheRecord<T> {
  key: string;
  data: T;
  cachedAt: number;
}

const STORE_NAME = 'cache';

function defaultStore<T>(): KVStore<CacheRecord<T>> {
  return openKVStore<CacheRecord<T>>(STORE_NAME, (r) => r.key);
}

export async function readCache<T>(
  key: string,
  store: KVStore<CacheRecord<T>> = defaultStore<T>()
): Promise<CacheRecord<T> | undefined> {
  try {
    return await store.get(key);
  } catch {
    return undefined;
  }
}

export async function writeCache<T>(
  key: string,
  data: T,
  store: KVStore<CacheRecord<T>> = defaultStore<T>()
): Promise<void> {
  try {
    await store.put({ key, data, cachedAt: Date.now() });
  } catch {
    /* best effort — cache is a nice-to-have, never blocks the real read */
  }
}

export class OfflineNoDataError extends Error {
  constructor(key: string) {
    super(`No cached data for "${key}" yet, and the device is offline.`);
    this.name = 'OfflineNoDataError';
  }
}

export interface CachedResult<T> {
  data: T;
  /** true when this came from the cache rather than a fresh network response. */
  stale: boolean;
}

export interface CachedGetOptions {
  /** Defaults to navigator.onLine; overridable for tests. */
  isOnline?: () => boolean;
}

function defaultIsOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine;
}

// Read path used by fetchMe / fetchTodayJournal / fetchJournalHistory in
// api.ts. Behavior:
//  - Offline: skip the network entirely (it would just time out — see
//    api.ts's fetchWithTimeout) and return the cached value immediately,
//    marked stale. No cache -> throws OfflineNoDataError so the caller
//    can render an honest "nothing saved on this phone yet" empty state
//    instead of a blank screen.
//  - Online: try the network first. On success, refresh the cache and
//    return fresh data (stale: false). On ANY failure — network error,
//    timeout, or an unexpected server error — fall back to the cache
//    just like the offline path, rather than surfacing a hard error for
//    a read. (Reads have no duplicate-write risk the way POSTs do, so
//    "when in doubt, show the last-known page" is the safe default
//    here — unlike the outbox's submit path, which must distinguish
//    network failures from 4xx rejections.) Only rethrows when there's
//    truly nothing to fall back on.
export async function cachedGet<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: CachedGetOptions = {},
  store: KVStore<CacheRecord<T>> = defaultStore<T>()
): Promise<CachedResult<T>> {
  const isOnline = options.isOnline ?? defaultIsOnline;

  if (!isOnline()) {
    const cached = await readCache(key, store);
    if (cached) return { data: cached.data, stale: true };
    throw new OfflineNoDataError(key);
  }

  try {
    const data = await fetcher();
    await writeCache(key, data, store);
    return { data, stale: false };
  } catch (err) {
    const cached = await readCache(key, store);
    if (cached) return { data: cached.data, stale: true };
    throw err;
  }
}
