// Tiny hand-rolled IndexedDB key-value store (P2-D). No dependency — the
// offline outbox and the offline-read cache both only need get/getAll/
// put/delete on a single object store, and a full library (idb, dexie)
// is a lot of surface area for that.
//
// Falls back to an in-memory Map when indexedDB isn't available — SSR
// (Next prerenders these route shells), Safari private browsing (which
// can throw on `indexedDB.open`), or a Vitest/Node test run. Callers get
// the exact same KVStore<T> interface either way, which is also what
// makes this the "injected fake storage seam" the P2-D tests use:
// MemoryKVStore below is real production fallback code, not test
// scaffolding, so tests construct one directly instead of pulling in a
// fake-indexeddb dependency to polyfill a browser API Node doesn't have.

export interface KVStore<T> {
  getAll(): Promise<T[]>;
  get(key: string): Promise<T | undefined>;
  put(value: T): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryKVStore<T> implements KVStore<T> {
  private map = new Map<string, T>();
  constructor(private keyOf: (value: T) => string) {}

  async getAll(): Promise<T[]> {
    return Array.from(this.map.values());
  }
  async get(key: string): Promise<T | undefined> {
    return this.map.get(key);
  }
  async put(value: T): Promise<void> {
    this.map.set(this.keyOf(value), value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async clear(): Promise<void> {
    this.map.clear();
  }
}

class IndexedDBStore<T> implements KVStore<T> {
  constructor(
    private dbPromise: Promise<IDBDatabase>,
    private storeName: string
  ) {}

  private async run<R>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<R>): Promise<R> {
    const db = await this.dbPromise;
    return new Promise<R>((resolve, reject) => {
      const tx = db.transaction(this.storeName, mode);
      const req = fn(tx.objectStore(this.storeName));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  getAll(): Promise<T[]> {
    return this.run<T[]>('readonly', (s) => s.getAll() as IDBRequest<T[]>);
  }
  get(key: string): Promise<T | undefined> {
    return this.run<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
  }
  async put(value: T): Promise<void> {
    await this.run<IDBValidKey>('readwrite', (s) => s.put(value));
  }
  async delete(key: string): Promise<void> {
    await this.run<undefined>('readwrite', (s) => s.delete(key) as IDBRequest<undefined>);
  }
  async clear(): Promise<void> {
    await this.run<undefined>('readwrite', (s) => s.clear() as IDBRequest<undefined>);
  }
}

const DB_NAME = 'amaaii-offline';
const DB_VERSION = 1;
export const OUTBOX_STORE = 'outbox';
export const CACHE_STORE = 'cache';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        db.createObjectStore(OUTBOX_STORE, { keyPath: 'clientEntryId' });
      }
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function idbAvailable(): boolean {
  // `typeof` never throws for an undeclared global, so this is safe in
  // Node/Vitest where `indexedDB` doesn't exist at all.
  return typeof indexedDB !== 'undefined';
}

// One in-memory fallback per store name, so a page that never gets real
// IndexedDB (denied permission, etc.) still behaves like a queue/cache
// for the lifetime of the tab instead of silently losing every write.
const memoryFallbacks = new Map<string, MemoryKVStore<unknown>>();

export function openKVStore<T>(storeName: string, keyOf: (value: T) => string): KVStore<T> {
  if (!idbAvailable()) {
    if (!memoryFallbacks.has(storeName)) {
      memoryFallbacks.set(storeName, new MemoryKVStore<unknown>(keyOf as (value: unknown) => string));
    }
    return memoryFallbacks.get(storeName) as unknown as KVStore<T>;
  }
  return new IndexedDBStore<T>(openDb(), storeName);
}
