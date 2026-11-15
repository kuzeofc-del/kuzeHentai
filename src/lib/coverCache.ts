import {
  db,
  isFirebaseConfigured,
  doc,
  collection,
  query,
  where,
  documentId,
  getDocFromCache,
  getDocFromServer,
  getDocsFromServer,
} from './firebase';
import { Anime } from '../types';

export interface PortadaData {
  imagen: string;
  portadaVersion: number;
}

const SERVER_BATCH_WINDOW_MS = 50;
const FIRESTORE_IN_QUERY_MAX = 30;

// In-memory session cache for covers already read in this session
const memoryPortadaCache = new Map<string, PortadaData>();

// Batched server fetch queue (~50ms collection window, chunks of up to 30 IDs)
const inFlightBatchedRequests = new Map<string, Promise<PortadaData | null>>();
const pendingQueueResolvers = new Map<string, (result: PortadaData | null) => void>();
let batchTimer: ReturnType<typeof setTimeout> | null = null;

// Direct single-doc deduplication (used by AdminPanel edit/export)
const inFlightDirectRequests = new Map<string, Promise<PortadaData | null>>();

export function isExternalHttpCover(anime: Partial<Anime>): boolean {
  const img = (anime.image || '').trim();
  const cUrl = (anime.coverUrl || '').trim();
  return /^https?:\/\//i.test(img) || /^https?:\/\//i.test(cUrl);
}

export function getSyncCachedPortada(
  animeId: string | undefined,
  expectedVersion?: number
): string | null {
  if (!animeId) return null;
  const hit = memoryPortadaCache.get(animeId);
  if (!hit) return null;
  if (expectedVersion === undefined || hit.portadaVersion === expectedVersion) {
    return hit.imagen;
  }
  return null;
}

export function upsertPortadaMemoryCache(
  animeId: string,
  imagen: string,
  portadaVersion: number
): void {
  if (!animeId || !imagen || !imagen.startsWith('data:image')) return;
  memoryPortadaCache.set(animeId, {
    imagen,
    portadaVersion: typeof portadaVersion === 'number' ? portadaVersion : 1,
  });
}

export function deletePortadaMemoryCache(animeId: string): void {
  if (!animeId) return;
  memoryPortadaCache.delete(animeId);
}

async function flushServerBatchQueue(): Promise<void> {
  batchTimer = null;
  if (pendingQueueResolvers.size === 0) return;

  const entries = Array.from(pendingQueueResolvers.entries());
  pendingQueueResolvers.clear();

  if (!db || !isFirebaseConfigured) {
    for (const [id, resolve] of entries) {
      inFlightBatchedRequests.delete(id);
      resolve(null);
    }
    return;
  }

  // Split into chunks of max 30 IDs (Firestore `in` query limit)
  const chunks: Array<Array<[string, (result: PortadaData | null) => void]>> = [];
  for (let i = 0; i < entries.length; i += FIRESTORE_IN_QUERY_MAX) {
    chunks.push(entries.slice(i, i + FIRESTORE_IN_QUERY_MAX));
  }

  await Promise.all(
    chunks.map(async (chunkEntries) => {
      const ids = chunkEntries.map(([id]) => id);
      const foundMap = new Map<string, PortadaData>();

      try {
        const q = query(
          collection(db, 'portadas'),
          where(documentId(), 'in', ids)
        );
        const snap = await getDocsFromServer(q);

        snap.docs.forEach((docSnap) => {
          const data = docSnap.data();
          if (data && typeof data.imagen === 'string' && data.imagen.startsWith('data:image')) {
            const portadaVersion =
              typeof data.portadaVersion === 'number' ? data.portadaVersion : 1;
            const entry: PortadaData = {
              imagen: data.imagen,
              portadaVersion,
            };
            foundMap.set(docSnap.id, entry);
            memoryPortadaCache.set(docSnap.id, entry);
          }
        });
      } catch {
        // Network / offline error — handled by caller's stale-cache fallback
      } finally {
        for (const [id, resolve] of chunkEntries) {
          inFlightBatchedRequests.delete(id);
          resolve(foundMap.get(id) || null);
        }
      }
    })
  );
}

/**
 * Collects cover IDs over a ~50ms window and queries `portadas` from server
 * in batches of up to 30 IDs (`where(documentId(), 'in', ids)`).
 * Results are automatically stored in Firestore's persistentLocalCache.
 */
function requestPortadaFromServerBatched(animeId: string): Promise<PortadaData | null> {
  const existing = inFlightBatchedRequests.get(animeId);
  if (existing) return existing;

  const promise = new Promise<PortadaData | null>((resolve) => {
    pendingQueueResolvers.set(animeId, resolve);
    if (!batchTimer) {
      batchTimer = setTimeout(() => {
        flushServerBatchQueue().catch(() => {});
      }, SERVER_BATCH_WINDOW_MS);
    }
  });

  inFlightBatchedRequests.set(animeId, promise);
  return promise;
}

/**
 * Cache-first base64 cover resolution for catalog/cards/detail:
 * a) Memory Map (session hits) & Firestore persistent cache (`getDocFromCache`) matching `portadaVersion`.
 * b) If missing in cache or version mismatch, batched server fetch (~50ms, max 30 IDs).
 * c) If offline or server fails and a cached copy exists, returns cached copy even with mismatched version.
 * Always uses the original image without resizing or recompression.
 */
export async function resolveAnimeCoverBase64(
  anime: Partial<Anime>
): Promise<string | null> {
  const animeId = anime.id ? String(anime.id) : '';
  const hasExplicitVersion = typeof anime.portadaVersion === 'number';
  const expectedVersion = hasExplicitVersion ? (anime.portadaVersion as number) : 1;

  // Inline base64 support (if any document still contains inline base64)
  if (anime.coverData && anime.coverData.startsWith('data:image')) {
    if (animeId) upsertPortadaMemoryCache(animeId, anime.coverData, expectedVersion);
    return anime.coverData;
  }
  if (anime.image && anime.image.startsWith('data:image')) {
    if (animeId) upsertPortadaMemoryCache(animeId, anime.image, expectedVersion);
    return anime.image;
  }

  if (!animeId) return null;

  // d) In-memory Map hit check for current session
  const memHit = memoryPortadaCache.get(animeId);
  if (memHit && (!hasExplicitVersion || memHit.portadaVersion === expectedVersion)) {
    return memHit.imagen;
  }

  if (!db || !isFirebaseConfigured) {
    return memHit ? memHit.imagen : null;
  }

  // a) Try Firestore local persistent cache first
  let staleCached: PortadaData | null = null;
  try {
    const cacheSnap = await getDocFromCache(doc(db, 'portadas', animeId));
    if (cacheSnap.exists()) {
      const data = cacheSnap.data();
      if (data && typeof data.imagen === 'string' && data.imagen.startsWith('data:image')) {
        const cachedVersion =
          typeof data.portadaVersion === 'number' ? data.portadaVersion : 1;
        const cachedEntry: PortadaData = {
          imagen: data.imagen,
          portadaVersion: cachedVersion,
        };
        if (!hasExplicitVersion || cachedVersion === expectedVersion) {
          memoryPortadaCache.set(animeId, cachedEntry);
          return cachedEntry.imagen;
        }
        staleCached = cachedEntry;
      }
    }
  } catch {
    // Document not yet in Firestore persistent cache
  }

  // c) Offline fallback: show cached copy even if version differs
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return staleCached?.imagen || memHit?.imagen || null;
  }

  // b) Missing from cache or version mismatch -> batched server fetch
  const serverResult = await requestPortadaFromServerBatched(animeId);
  if (serverResult?.imagen) {
    return serverResult.imagen;
  }

  // c) If server failed/returned nothing (e.g. offline/network hiccup), fall back to cached copy
  return staleCached?.imagen || memHit?.imagen || null;
}

/**
 * Direct cache-first fetch of `portadas/{id}` for AdminPanel (edit cover / backup export).
 */
export async function fetchPortadaFromFirestore(
  animeId: string,
  expectedVersion?: number
): Promise<PortadaData | null> {
  if (!animeId) return null;

  const hasExplicitVersion = typeof expectedVersion === 'number';
  const memHit = memoryPortadaCache.get(animeId);
  if (memHit && (!hasExplicitVersion || memHit.portadaVersion === expectedVersion)) {
    return memHit;
  }

  if (!db || !isFirebaseConfigured) {
    return memHit || null;
  }

  const flightKey = `${animeId}:${expectedVersion ?? 'any'}`;
  const existing = inFlightDirectRequests.get(flightKey);
  if (existing) return existing;

  const promise = (async (): Promise<PortadaData | null> => {
    let staleCached: PortadaData | null = null;

    try {
      const cacheSnap = await getDocFromCache(doc(db, 'portadas', animeId));
      if (cacheSnap.exists()) {
        const data = cacheSnap.data();
        if (data && typeof data.imagen === 'string' && data.imagen.startsWith('data:image')) {
          const cachedVersion =
            typeof data.portadaVersion === 'number' ? data.portadaVersion : 1;
          const cachedEntry: PortadaData = {
            imagen: data.imagen,
            portadaVersion: cachedVersion,
          };
          if (!hasExplicitVersion || cachedVersion === expectedVersion) {
            memoryPortadaCache.set(animeId, cachedEntry);
            return cachedEntry;
          }
          staleCached = cachedEntry;
        }
      }
    } catch {
      // Cache miss
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return staleCached || memHit || null;
    }

    try {
      const srvSnap = await getDocFromServer(doc(db, 'portadas', animeId));
      if (srvSnap.exists()) {
        const data = srvSnap.data();
        if (data && typeof data.imagen === 'string' && data.imagen.startsWith('data:image')) {
          const srvVersion =
            typeof data.portadaVersion === 'number' ? data.portadaVersion : 1;
          const entry: PortadaData = {
            imagen: data.imagen,
            portadaVersion: srvVersion,
          };
          memoryPortadaCache.set(animeId, entry);
          return entry;
        }
      }
    } catch {
      // Server unavailable
    }

    return staleCached || memHit || null;
  })().finally(() => {
    inFlightDirectRequests.delete(flightKey);
  });

  inFlightDirectRequests.set(flightKey, promise);
  return promise;
}

const PRELOAD_BATCH_LIMIT = 24;
let isPreloadBatchRunning = false;

function waitForBrowserIdle(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let idleId: number | null = null;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      if (
        idleId !== null &&
        typeof window !== 'undefined' &&
        typeof (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback === 'function'
      ) {
        try {
          (window as Window & { cancelIdleCallback: (id: number) => void }).cancelIdleCallback(idleId);
        } catch {}
      }
      if (timerId !== null) {
        clearTimeout(timerId);
      }
    };

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ok);
    };

    const onAbort = () => finish(false);
    signal.addEventListener('abort', onAbort, { once: true });

    const win = typeof window !== 'undefined'
      ? (window as Window & {
          requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
        })
      : null;

    if (win && typeof win.requestIdleCallback === 'function') {
      idleId = win.requestIdleCallback(() => finish(!signal.aborted), { timeout: 1500 });
    } else {
      timerId = setTimeout(() => finish(!signal.aborted), 180);
    }
  });
}

/**
 * Background idle preloader for catalog cards:
 * - Waits for browser idle (`requestIdleCallback` with `setTimeout` fallback)
 * - Finds up to 24 uncached base64 covers from `catalogAnimes`
 * - Fetches 1 batch at a time using the same 30-ID `in` batch queue
 * - Cancels immediately via `AbortSignal` when user leaves the catalog
 */
export async function startCatalogIdlePreload(
  catalogAnimes: Partial<Anime>[],
  signal: AbortSignal
): Promise<void> {
  if (!db || !isFirebaseConfigured || catalogAnimes.length === 0) return;

  // Never run more than 1 preload batch at a time
  if (isPreloadBatchRunning) return;

  while (!signal.aborted) {
    const canProceed = await waitForBrowserIdle(signal);
    if (!canProceed || signal.aborted) return;

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return;
    }

    if (isPreloadBatchRunning) return;

    const uncachedIds: string[] = [];
    const seenIds = new Set<string>();

    for (let i = 0; i < catalogAnimes.length && uncachedIds.length < PRELOAD_BATCH_LIMIT; i += 10) {
      if (signal.aborted) return;
      const slice = catalogAnimes.slice(i, i + 10);

      const batchCheck = await Promise.all(
        slice.map(async (anime) => {
          if (signal.aborted) return null;
          const id = anime.id ? String(anime.id) : '';
          if (!id || seenIds.has(id)) return null;
          seenIds.add(id);

          if (isExternalHttpCover(anime)) return null;
          if (
            (anime.coverData && anime.coverData.startsWith('data:image')) ||
            (anime.image && anime.image.startsWith('data:image'))
          ) {
            return null;
          }

          const hasExplicitVersion = typeof anime.portadaVersion === 'number';
          const expectedVersion = hasExplicitVersion ? (anime.portadaVersion as number) : 1;

          // Already in session memory Map
          const memHit = memoryPortadaCache.get(id);
          if (memHit && (!hasExplicitVersion || memHit.portadaVersion === expectedVersion)) {
            return null;
          }

          // Check Firestore persistent cache; warm memory Map if already cached
          try {
            const cacheSnap = await getDocFromCache(doc(db, 'portadas', id));
            if (cacheSnap.exists()) {
              const data = cacheSnap.data();
              if (data && typeof data.imagen === 'string' && data.imagen.startsWith('data:image')) {
                const cachedVersion =
                  typeof data.portadaVersion === 'number' ? data.portadaVersion : 1;
                if (!hasExplicitVersion || cachedVersion === expectedVersion) {
                  memoryPortadaCache.set(id, {
                    imagen: data.imagen,
                    portadaVersion: cachedVersion,
                  });
                  return null;
                }
              }
            }
          } catch {
            // Not in cache yet -> candidate for background preload
          }

          return id;
        })
      );

      for (const id of batchCheck) {
        if (id && uncachedIds.length < PRELOAD_BATCH_LIMIT) {
          uncachedIds.push(id);
        }
      }
    }

    if (signal.aborted || uncachedIds.length === 0) {
      return;
    }

    // Fetch strictly 1 preload batch of <= 24 IDs using the 30-ID batched query queue
    isPreloadBatchRunning = true;
    try {
      await Promise.all(uncachedIds.map((id) => requestPortadaFromServerBatched(id)));
    } catch {
      return;
    } finally {
      isPreloadBatchRunning = false;
    }
  }
}

