/**
 * Cache for synthesized speech, so a line spoken before plays with no network.
 * The LRU logic is pure and storage-agnostic; IndexedDB is just one backing store.
 */

export interface StoredAudio {
  key: string;
  blob: Blob;
  size: number;
  at: number; // last used
}

export interface BlobStore {
  get(key: string): Promise<StoredAudio | undefined>;
  put(rec: StoredAudio): Promise<void>;
  delete(key: string): Promise<void>;
  /** Metadata only, so eviction never has to read audio bytes. */
  entries(): Promise<{ key: string; size: number; at: number }[]>;
}

export interface CacheLimits {
  maxEntries: number;
  maxBytes: number;
}

export const DEFAULT_LIMITS: CacheLimits = { maxEntries: 150, maxBytes: 15 * 1024 * 1024 };

export function cacheKey(voiceId: string, text: string, ssml: boolean): string {
  return `${voiceId}|${ssml ? 's' : 't'}|${text}`;
}

/** Never throws: a broken cache must degrade to "no cache", not break speech. */
export class AudioCache {
  constructor(private store: BlobStore, private limits: CacheLimits = DEFAULT_LIMITS, private now: () => number = Date.now) {}

  async get(key: string): Promise<Blob | undefined> {
    try {
      const rec = await this.store.get(key);
      if (!rec) return undefined;
      await this.store.put({ ...rec, at: this.now() }); // touch: most recently used survives eviction
      return rec.blob;
    } catch {
      return undefined;
    }
  }

  async put(key: string, blob: Blob): Promise<void> {
    try {
      if (blob.size === 0 || blob.size > this.limits.maxBytes) return;
      await this.store.put({ key, blob, size: blob.size, at: this.now() });
      await this.evict();
    } catch {
      /* quota or blocked storage: ignore */
    }
  }

  private async evict(): Promise<void> {
    const all = await this.store.entries();
    let count = all.length;
    let bytes = all.reduce((n, e) => n + e.size, 0);
    for (const e of [...all].sort((a, b) => a.at - b.at)) {
      if (count <= this.limits.maxEntries && bytes <= this.limits.maxBytes) break;
      await this.store.delete(e.key);
      count--;
      bytes -= e.size;
    }
  }
}

export function memoryStore(): BlobStore {
  const m = new Map<string, StoredAudio>();
  return {
    get: async (k) => m.get(k),
    put: async (r) => void m.set(r.key, r),
    delete: async (k) => void m.delete(k),
    entries: async () => [...m.values()].map(({ key, size, at }) => ({ key, size, at })),
  };
}

const STORE = 'audio';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** IndexedDB-backed store, or null where IndexedDB is unavailable (private mode, old browsers). */
export function idbStore(dbName = 'tap-audio-cache', factory: IDBFactory | undefined = globalThis.indexedDB): BlobStore | null {
  if (!factory) return null;
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () =>
    (dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
      const open = factory.open(dbName, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: 'key' });
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    }));
  const os = async (mode: IDBTransactionMode) => (await db()).transaction(STORE, mode).objectStore(STORE);
  return {
    get: async (k) => (await req((await os('readonly')).get(k))) as StoredAudio | undefined,
    put: async (r) => void (await req((await os('readwrite')).put(r))),
    delete: async (k) => void (await req((await os('readwrite')).delete(k))),
    entries: async () => {
      const out: { key: string; size: number; at: number }[] = [];
      const store = await os('readonly');
      await new Promise<void>((resolve, reject) => {
        const cur = store.openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return resolve();
          const v = c.value as StoredAudio;
          out.push({ key: v.key, size: v.size, at: v.at });
          c.continue();
        };
        cur.onerror = () => reject(cur.error);
      });
      return out;
    },
  };
}

export function createAudioCache(limits?: CacheLimits): AudioCache | null {
  try {
    const store = idbStore();
    return store ? new AudioCache(store, limits) : null;
  } catch {
    return null;
  }
}
