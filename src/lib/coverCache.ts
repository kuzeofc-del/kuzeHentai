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

export interface ResolvedPortadaResult {
  imagen: string;
  fromCache: boolean;
}

const VISIBLE_BATCH_WINDOW_MS = 16;
const ANTICIPATED_BATCH_WINDOW_MS = 35;
const FIRESTORE_IN_QUERY_MAX = 30;
const BATCH_SERVER_TIMEOUT_MS = 4000;
const SINGLE_DOC_MAX_RETRIES = 2;
const PRELOAD_BATCH_LIMIT = 12;
const PRELOAD_TOTAL_LIMIT = 24;

// In-memory session cache for covers already read in this session
const memoryPortadaCache = new Map<string, PortadaData>();

// Global deduplication map for EVERY active server fetch by animeId (across all tiers & batch preloaders)
const inFlightServerById = new Map<string, Promise<PortadaData | null>>();

// Pub-sub listeners so any mounted SmartAnimeCover waiting on an ID updates the instant it arrives
type PortadaReadyListener = (data: PortadaData, meta: { fromCache: boolean }) => void;
const portadaReadyListeners = new Map<string, Set<PortadaReadyListener>>();

// Tier 1: Visible requests (rootMargin 300px) — immediate, 16ms grouping, chunks up to 30
const visibleQueue = new Map<string, Array<(result: PortadaData | null) => void>>();
const pendingVisiblePromises = new Map<string, Promise<PortadaData | null>>();
let visibleBatchTimer: ReturnType<typeof setTimeout> | null = null;
let activeVisibleBatches = 0;

// Tier 2: Anticipated requests (rootMargin 1500px) — waits until visible queue is idle; never cancelled mid-flight
const anticipatedQueue = new Map<string, Array<(result: PortadaData | null) => void>>();
const pendingAnticipatedPromises = new Map<string, Promise<PortadaData | null>>();
let anticipatedBatchTimer: ReturnType<typeof setTimeout> | null = null;
let activeAnticipatedBatches = 0;

// Idle queue coordination listeners
const visibleIdleListeners = new Set<() => void>();
const foregroundIdleListeners = new Set<() => void>();

// Tier 3: Background idle preload lock (max 1 batch at a time)
let isPreloadBatchRunning = false;

// Direct single-doc deduplication (used by AdminPanel edit/export)
const inFlightDirectRequests = new Map<string, Promise<PortadaData | null>>();

export function isSaveDataEnabled(): boolean {
  if (typeof navigator === 'undefined') return false;
  const conn = (navigator as Navigator & {
    connection?: { saveData?: boolean };
  }).connection;
  return Boolean(conn?.saveData);
}

export function triggerCoversReobserve(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new Event('kh_reobserve_covers'));
  } catch {}
}

export function isExternalHttpCover(anime: Partial<Anime>): boolean {
  const img = (anime.image || '').trim();
  const cUrl = (anime.coverUrl || '').trim();
  return /^https?:\/\//i.test(img) || /^https?:\/\//i.test(cUrl);
}

function setPortadaInMemoryAndNotify(
  animeId: string,
  entry: PortadaData,
  fromCache: boolean
): void {
  if (!animeId || !entry.imagen || !entry.imagen.startsWith('data:image')) return;
  memoryPortadaCache.set(animeId, entry);
  const listeners = portadaReadyListeners.get(animeId);
  if (listeners && listeners.size > 0) {
    listeners.forEach((cb) => {
      try {
        cb(entry, { fromCache });
      } catch {}
    });
  }
}

export function subscribePortadaReady(
  animeId: string,
  listener: PortadaReadyListener
): () => void {
  if (!animeId) return () => {};
  let set = portadaReadyListeners.get(animeId);
  if (!set) {
    set = new Set();
    portadaReadyListeners.set(animeId, set);
  }
  set.add(listener);
  return () => {
    const current = portadaReadyListeners.get(animeId);
    if (current) {
      current.delete(listener);
      if (current.size === 0) {
        portadaReadyListeners.delete(animeId);
      }
    }
  };
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
  setPortadaInMemoryAndNotify(
    animeId,
    {
      imagen,
      portadaVersion: typeof portadaVersion === 'number' ? portadaVersion : 1,
    },
    true
  );
}

export function deletePortadaMemoryCache(animeId: string): void {
  if (!animeId) return;
  memoryPortadaCache.delete(animeId);
}

function isVisibleBusy(): boolean {
  return visibleQueue.size > 0 || visibleBatchTimer !== null || activeVisibleBatches > 0;
}

function isAnticipatedBusy(): boolean {
  return anticipatedQueue.size > 0 || anticipatedBatchTimer !== null || activeAnticipatedBatches > 0;
}

function hasActiveForegroundRequests(): boolean {
  return isVisibleBusy() || isAnticipatedBusy();
}

function notifyQueueIdleState(): void {
  if (!isVisibleBusy() && visibleIdleListeners.size > 0) {
    const cbs = Array.from(visibleIdleListeners);
    visibleIdleListeners.clear();
    for (const cb of cbs) cb();
  }
  if (!hasActiveForegroundRequests() && foregroundIdleListeners.size > 0) {
    const cbs = Array.from(foregroundIdleListeners);
    foregroundIdleListeners.clear();
    for (const cb of cbs) cb();
  }
}

function waitForVisibleIdle(): Promise<void> {
  if (!isVisibleBusy()) return Promise.resolve();
  return new Promise((resolve) => {
    visibleIdleListeners.add(resolve);
  });
}

function waitForForegroundIdle(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (!hasActiveForegroundRequests()) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      foregroundIdleListeners.delete(done);
      signal?.removeEventListener('abort', onAbort);
      resolve(!signal?.aborted);
    };
    const onAbort = () => done();
    foregroundIdleListeners.add(done);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      reject(new Error(label));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timerId !== null) clearTimeout(timerId);
  });
}

async function fetchSingleDocFromServerWithRetry(
  animeId: string,
  maxRetries: number = SINGLE_DOC_MAX_RETRIES
): Promise<PortadaData | null> {
  if (!db || !isFirebaseConfigured || !animeId) return null;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const srvSnap = await withTimeout(
        getDocFromServer(doc(db, 'portadas', animeId)),
        BATCH_SERVER_TIMEOUT_MS,
        `getDocFromServer timeout (${animeId})`
      );
      if (!srvSnap.exists()) {
        return null;
      }
      const data = srvSnap.data();
      if (data && typeof data.imagen === 'string' && data.imagen.startsWith('data:image')) {
        const portadaVersion =
          typeof data.portadaVersion === 'number' ? data.portadaVersion : 1;
        const entry: PortadaData = {
          imagen: data.imagen,
          portadaVersion,
        };
        setPortadaInMemoryAndNotify(animeId, entry, false);
        return entry;
      }
      return null;
    } catch {
      if (attempt < maxRetries) {
        await new Promise((res) => setTimeout(res, 150 * (attempt + 1)));
      }
    }
  }

  return null;
}

async function runChunkWithFallback(chunkIds: string[]): Promise<Map<string, PortadaData>> {
  const foundMap = new Map<string, PortadaData>();
  if (!db || !isFirebaseConfigured || chunkIds.length === 0) return foundMap;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return foundMap;

  try {
    const q = query(
      collection(db, 'portadas'),
      where(documentId(), 'in', chunkIds)
    );
    const snap = await withTimeout(
      getDocsFromServer(q),
      BATCH_SERVER_TIMEOUT_MS,
      'getDocsFromServer batch timeout'
    );

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
        setPortadaInMemoryAndNotify(docSnap.id, entry, false);
      }
    });

    return foundMap;
  } catch {
    // Batch failed or timed out (>4s): retry each ID individually with getDocFromServer (up to 2 retries)
    const CONCURRENCY = 6;
    let cursor = 0;

    const worker = async () => {
      while (cursor < chunkIds.length) {
        const idx = cursor++;
        const id = chunkIds[idx];
        const entry = await fetchSingleDocFromServerWithRetry(id, SINGLE_DOC_MAX_RETRIES);
        if (entry) {
          foundMap.set(id, entry);
        }
      }
    };

    const workerCount = Math.min(CONCURRENCY, chunkIds.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return foundMap;
  }
}

/**
 * Dispatches server batch fetches for `ids` in chunks of up to 30 while strictly
 * deduplicating against `inFlightServerById`. Never cancels started requests.
 */
async function fetchPortadasBatchFromServer(ids: string[]): Promise<Map<string, PortadaData>> {
  const resultMap = new Map<string, PortadaData>();
  if (!db || !isFirebaseConfigured || ids.length === 0) return resultMap;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return resultMap;

  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  const perIdPromises = new Map<string, Promise<PortadaData | null>>();
  const idsToFetch: string[] = [];

  for (const id of uniqueIds) {
    const existingFlight = inFlightServerById.get(id);
    if (existingFlight) {
      perIdPromises.set(id, existingFlight);
    } else {
      idsToFetch.push(id);
    }
  }

  for (let i = 0; i < idsToFetch.length; i += FIRESTORE_IN_QUERY_MAX) {
    const chunkIds = idsToFetch.slice(i, i + FIRESTORE_IN_QUERY_MAX);
    const chunkPromise = runChunkWithFallback(chunkIds);

    for (const id of chunkIds) {
      const perIdPromise = chunkPromise
        .then((map) => map.get(id) || memoryPortadaCache.get(id) || null)
        .finally(() => {
          if (inFlightServerById.get(id) === perIdPromise) {
            inFlightServerById.delete(id);
          }
        });
      inFlightServerById.set(id, perIdPromise);
      perIdPromises.set(id, perIdPromise);
    }
  }

  await Promise.all(
    Array.from(perIdPromises.entries()).map(async ([id, p]) => {
      const res = await p;
      if (res) {
        resultMap.set(id, res);
      }
    })
  );

  return resultMap;
}

async function flushVisibleQueue(): Promise<void> {
  visibleBatchTimer = null;
  if (visibleQueue.size === 0) {
    notifyQueueIdleState();
    return;
  }

  const entries = Array.from(visibleQueue.entries());
  visibleQueue.clear();

  // Promote any identical IDs waiting in anticipatedQueue so they don't trigger a duplicate read
  for (const [id, resolvers] of entries) {
    const waitingAnticipated = anticipatedQueue.get(id);
    if (waitingAnticipated) {
      resolvers.push(...waitingAnticipated);
      anticipatedQueue.delete(id);
      pendingAnticipatedPromises.delete(id);
    }
  }

  activeVisibleBatches++;
  try {
    const chunks: Array<Array<[string, Array<(result: PortadaData | null) => void>]>> = [];
    for (let i = 0; i < entries.length; i += FIRESTORE_IN_QUERY_MAX) {
      chunks.push(entries.slice(i, i + FIRESTORE_IN_QUERY_MAX));
    }

    await Promise.all(
      chunks.map(async (chunkEntries) => {
        const ids = chunkEntries.map(([id]) => id);
        const foundMap = await fetchPortadasBatchFromServer(ids);

        for (const [id, resolvers] of chunkEntries) {
          pendingVisiblePromises.delete(id);
          const result = foundMap.get(id) || memoryPortadaCache.get(id) || null;
          for (const resolve of resolvers) {
            resolve(result);
          }
        }
      })
    );
  } finally {
    activeVisibleBatches--;
    notifyQueueIdleState();
  }
}

/**
 * Tier 1 (Visible, rootMargin 300px): immediate priority, grouped over ~16ms in batches of up to 30 IDs.
 */
function requestPortadaVisible(animeId: string): Promise<PortadaData | null> {
  const existingServerFlight = inFlightServerById.get(animeId);
  if (existingServerFlight) return existingServerFlight;

  const existingVisible = pendingVisiblePromises.get(animeId);
  if (existingVisible) return existingVisible;

  const promise = new Promise<PortadaData | null>((resolve) => {
    const list = visibleQueue.get(animeId) || [];
    list.push(resolve);
    visibleQueue.set(animeId, list);

    if (!visibleBatchTimer) {
      visibleBatchTimer = setTimeout(() => {
        flushVisibleQueue().catch(() => {});
      }, VISIBLE_BATCH_WINDOW_MS);
    }
  });

  pendingVisiblePromises.set(animeId, promise);
  return promise;
}

async function flushAnticipatedQueue(): Promise<void> {
  anticipatedBatchTimer = null;

  // Wait until ALL visible-tier requests have completed
  while (isVisibleBusy()) {
    await waitForVisibleIdle();
  }

  if (anticipatedQueue.size === 0) {
    notifyQueueIdleState();
    return;
  }

  // Drain queue without discarding cards that left range — let all requested cards finish and cache in memory
  const activeEntries: Array<[string, Array<(result: PortadaData | null) => void>]> = [];
  for (const [id, resolvers] of anticipatedQueue.entries()) {
    const memHit = memoryPortadaCache.get(id);
    if (memHit) {
      pendingAnticipatedPromises.delete(id);
      for (const r of resolvers) r(memHit);
    } else if (pendingVisiblePromises.has(id)) {
      pendingVisiblePromises.get(id)!.then((res) => {
        pendingAnticipatedPromises.delete(id);
        for (const r of resolvers) r(res);
      });
    } else if (inFlightServerById.has(id)) {
      inFlightServerById.get(id)!.then((res) => {
        pendingAnticipatedPromises.delete(id);
        for (const r of resolvers) r(res);
      });
    } else {
      activeEntries.push([id, resolvers]);
    }
  }
  anticipatedQueue.clear();

  if (activeEntries.length === 0) {
    notifyQueueIdleState();
    return;
  }

  activeAnticipatedBatches++;
  try {
    const chunks: Array<Array<[string, Array<(result: PortadaData | null) => void>]>> = [];
    for (let i = 0; i < activeEntries.length; i += FIRESTORE_IN_QUERY_MAX) {
      chunks.push(activeEntries.slice(i, i + FIRESTORE_IN_QUERY_MAX));
    }

    for (const chunkEntries of chunks) {
      // Yield to any new visible-tier requests before sending each anticipated chunk
      while (isVisibleBusy()) {
        await waitForVisibleIdle();
      }

      const stillNeeded: Array<[string, Array<(result: PortadaData | null) => void>]> = [];
      for (const [id, resolvers] of chunkEntries) {
        const memHit = memoryPortadaCache.get(id);
        if (memHit) {
          pendingAnticipatedPromises.delete(id);
          for (const r of resolvers) r(memHit);
        } else if (pendingVisiblePromises.has(id)) {
          pendingVisiblePromises.get(id)!.then((res) => {
            pendingAnticipatedPromises.delete(id);
            for (const r of resolvers) r(res);
          });
        } else if (inFlightServerById.has(id)) {
          inFlightServerById.get(id)!.then((res) => {
            pendingAnticipatedPromises.delete(id);
            for (const r of resolvers) r(res);
          });
        } else {
          stillNeeded.push([id, resolvers]);
        }
      }

      if (stillNeeded.length === 0) continue;

      const ids = stillNeeded.map(([id]) => id);
      const foundMap = await fetchPortadasBatchFromServer(ids);

      for (const [id, resolvers] of stillNeeded) {
        pendingAnticipatedPromises.delete(id);
        const result = foundMap.get(id) || memoryPortadaCache.get(id) || null;
        for (const r of resolvers) {
          r(result);
        }
      }
    }
  } finally {
    activeAnticipatedBatches--;
    notifyQueueIdleState();
  }
}

/**
 * Tier 2 (Anticipated, rootMargin 1500px): runs only when visible queue is idle.
 * Never cancelled when cards scroll out of range; reuses any existing in-flight request.
 */
function requestPortadaAnticipated(animeId: string): Promise<PortadaData | null> {
  const existingServerFlight = inFlightServerById.get(animeId);
  if (existingServerFlight) return existingServerFlight;

  const existingVisible = pendingVisiblePromises.get(animeId);
  if (existingVisible) return existingVisible;

  const existingAnticipated = pendingAnticipatedPromises.get(animeId);
  if (existingAnticipated) return existingAnticipated;

  const promise = new Promise<PortadaData | null>((resolve) => {
    const list = anticipatedQueue.get(animeId) || [];
    list.push(resolve);
    anticipatedQueue.set(animeId, list);

    if (!anticipatedBatchTimer) {
      anticipatedBatchTimer = setTimeout(() => {
        flushAnticipatedQueue().catch(() => {});
      }, ANTICIPATED_BATCH_WINDOW_MS);
    }
  });

  pendingAnticipatedPromises.set(animeId, promise);
  return promise;
}

/**
 * Reads Firestore local persistent cache (`getDocFromCache`) for a single anime ID.
 * If valid version match, stores in session memory Map and notifies subscribers.
 */
async function readPortadaFromFirestoreCache(
  animeId: string,
  hasExplicitVersion: boolean,
  expectedVersion: number
): Promise<{ hit: PortadaData | null; stale: PortadaData | null }> {
  if (!db || !isFirebaseConfigured || !animeId) return { hit: null, stale: null };

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
          setPortadaInMemoryAndNotify(animeId, cachedEntry, true);
          return { hit: cachedEntry, stale: null };
        }
        return { hit: null, stale: cachedEntry };
      }
    }
  } catch {
    // Document not yet in Firestore persistent cache
  }

  return { hit: null, stale: null };
}

/**
 * Cache-first base64 cover resolution for catalog/cards/detail:
 * a) Memory Map (session hits) & Firestore persistent cache (`getDocFromCache`) matching `portadaVersion` -> `fromCache: true`.
 * b) If missing in cache or version mismatch -> two-tier server fetch (`visible` 16ms priority OR `anticipated` when visible is idle) -> `fromCache: false`.
 *    If `navigator.connection?.saveData` is true, anticipated server fetch is skipped (only visible loads).
 * c) If offline or server fails and a cached copy exists -> returns cached copy (`fromCache: true`) even with mismatched version.
 * Always uses the original image without resizing or recompression.
 */
export async function resolveAnimeCoverBase64(
  anime: Partial<Anime>,
  options: {
    priority?: 'visible' | 'anticipated';
    cacheOnly?: boolean;
  } = {}
): Promise<ResolvedPortadaResult | null> {
  const { priority = 'visible', cacheOnly = false } = options;
  const animeId = anime.id ? String(anime.id) : '';
  const hasExplicitVersion = typeof anime.portadaVersion === 'number';
  const expectedVersion = hasExplicitVersion ? (anime.portadaVersion as number) : 1;

  // Inline base64 support (instant)
  if (anime.coverData && anime.coverData.startsWith('data:image')) {
    if (animeId) upsertPortadaMemoryCache(animeId, anime.coverData, expectedVersion);
    return { imagen: anime.coverData, fromCache: true };
  }
  if (anime.image && anime.image.startsWith('data:image')) {
    if (animeId) upsertPortadaMemoryCache(animeId, anime.image, expectedVersion);
    return { imagen: anime.image, fromCache: true };
  }

  if (!animeId) return null;

  // d) In-memory Map hit check for current session (instant)
  const memHit = memoryPortadaCache.get(animeId);
  if (memHit && (!hasExplicitVersion || memHit.portadaVersion === expectedVersion)) {
    return { imagen: memHit.imagen, fromCache: true };
  }

  if (!db || !isFirebaseConfigured) {
    return memHit ? { imagen: memHit.imagen, fromCache: true } : null;
  }

  // a) Try Firestore local persistent cache first (instant display if hit)
  const { hit: cacheHit, stale: staleCached } = await readPortadaFromFirestoreCache(
    animeId,
    hasExplicitVersion,
    expectedVersion
  );
  if (cacheHit) {
    return { imagen: cacheHit.imagen, fromCache: true };
  }

  if (cacheOnly) {
    return null;
  }

  // Save-Data check: skip non-visible (anticipated) server downloads when mobile data saver is active
  if (priority === 'anticipated' && isSaveDataEnabled()) {
    return null;
  }

  // c) Offline fallback: show cached copy even if version differs
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const offlineImg = staleCached?.imagen || memHit?.imagen;
    return offlineImg ? { imagen: offlineImg, fromCache: true } : null;
  }

  // b) Missing from cache or version mismatch -> prioritized batched server fetch
  const serverResult =
    priority === 'visible'
      ? await requestPortadaVisible(animeId)
      : await requestPortadaAnticipated(animeId);

  if (serverResult?.imagen) {
    return { imagen: serverResult.imagen, fromCache: false };
  }

  // c) If server failed/returned nothing (e.g. offline/network hiccup), fall back to cached copy
  const fallbackImg = staleCached?.imagen || memHit?.imagen;
  return fallbackImg ? { imagen: fallbackImg, fromCache: true } : null;
}

/**
 * Cache-first batch loader for Home startup, Similar Titles, and Studio/Genre immediate catalogs:
 * 1) Reads `getDocFromCache` in parallel for all non-HTTP candidates and stores valid hits in `memoryPortadaCache`.
 * 2) Fetches any missing IDs from server in batches of 30 (`getDocsFromServer`, with 4s timeout + single-doc retry).
 * 3) Optionally caps waiting time via `maxWaitMs` (without cancelling the background completion).
 */
export async function preloadPortadasBatch(
  animes: Partial<Anime>[],
  options: { maxWaitMs?: number } = {}
): Promise<void> {
  if (!db || !isFirebaseConfigured || !animes || animes.length === 0) return;

  const work = (async () => {
    const uniqueById = new Map<string, Partial<Anime>>();
    for (const anime of animes) {
      const id = anime?.id ? String(anime.id) : '';
      if (!id || uniqueById.has(id)) continue;
      if (isExternalHttpCover(anime)) continue;

      const hasExplicitVersion = typeof anime.portadaVersion === 'number';
      const expectedVersion = hasExplicitVersion ? (anime.portadaVersion as number) : 1;

      if (anime.coverData && anime.coverData.startsWith('data:image')) {
        upsertPortadaMemoryCache(id, anime.coverData, expectedVersion);
        continue;
      }
      if (anime.image && anime.image.startsWith('data:image')) {
        upsertPortadaMemoryCache(id, anime.image, expectedVersion);
        continue;
      }

      const memHit = memoryPortadaCache.get(id);
      if (memHit && (!hasExplicitVersion || memHit.portadaVersion === expectedVersion)) {
        continue;
      }

      uniqueById.set(id, anime);
    }

    if (uniqueById.size === 0) return;

    const missingIds: string[] = [];
    const staleById = new Map<string, PortadaData>();

    await Promise.all(
      Array.from(uniqueById.entries()).map(async ([id, anime]) => {
        const hasExplicitVersion = typeof anime.portadaVersion === 'number';
        const expectedVersion = hasExplicitVersion ? (anime.portadaVersion as number) : 1;
        const { hit, stale } = await readPortadaFromFirestoreCache(
          id,
          hasExplicitVersion,
          expectedVersion
        );
        if (!hit) {
          if (stale) staleById.set(id, stale);
          missingIds.push(id);
        }
      })
    );

    if (missingIds.length === 0) return;

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      staleById.forEach((entry, id) => {
        setPortadaInMemoryAndNotify(id, entry, true);
      });
      return;
    }

    await fetchPortadasBatchFromServer(missingIds);
  })();

  if (options.maxWaitMs && options.maxWaitMs > 0) {
    await withTimeout(work, options.maxWaitMs, 'preloadPortadasBatch wait cap').catch(() => {});
  } else {
    await work.catch(() => {});
  }
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

  const existingServerFlight = inFlightServerById.get(animeId);
  if (existingServerFlight) {
    const res = await existingServerFlight;
    if (res) return res;
  }

  const flightKey = `${animeId}:${expectedVersion ?? 'any'}`;
  const existing = inFlightDirectRequests.get(flightKey);
  if (existing) return existing;

  const promise = (async (): Promise<PortadaData | null> => {
    const { hit, stale: staleCached } = await readPortadaFromFirestoreCache(
      animeId,
      hasExplicitVersion,
      hasExplicitVersion ? (expectedVersion as number) : 1
    );
    if (hit) return hit;

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return staleCached || memHit || null;
    }

    const entry = await fetchSingleDocFromServerWithRetry(animeId, SINGLE_DOC_MAX_RETRIES);
    if (entry) return entry;

    return staleCached || memHit || null;
  })().finally(() => {
    inFlightDirectRequests.delete(flightKey);
  });

  inFlightDirectRequests.set(flightKey, promise);
  return promise;
}

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
      timerId = setTimeout(() => finish(!signal.aborted), 200);
    }
  });
}

/**
 * Background idle preloader for remaining Studio/Genre items beyond the initial 60.
 * Loads in batches of 30 when the browser is idle. Disabled when Save-Data is active.
 */
export async function preloadPortadasIdleChunks(
  animes: Partial<Anime>[],
  signal: AbortSignal,
  chunkSize: number = FIRESTORE_IN_QUERY_MAX
): Promise<void> {
  if (!db || !isFirebaseConfigured || animes.length === 0) return;
  if (isSaveDataEnabled()) return;

  let offset = 0;
  while (offset < animes.length && !signal.aborted) {
    const fgReady = await waitForForegroundIdle(signal);
    if (!fgReady || signal.aborted) return;

    const idleReady = await waitForBrowserIdle(signal);
    if (!idleReady || signal.aborted) return;

    if (isSaveDataEnabled()) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (hasActiveForegroundRequests()) continue;

    const slice = animes.slice(offset, offset + chunkSize);
    offset += chunkSize;
    await preloadPortadasBatch(slice);
  }
}

/**
 * Softer background idle preloader for general catalog cards:
 * - Disabled when `navigator.connection?.saveData` is true.
 * - Waits until there are NO active visible or anticipated foreground requests.
 * - Waits for browser idle (`requestIdleCallback` with `setTimeout` fallback).
 * - Preloads at most the next 24 uncached covers total, in batches of 12 (strictly 1 batch at a time).
 * - Stops queueing new batches via `AbortSignal` when user leaves the catalog.
 */
export async function startCatalogIdlePreload(
  catalogAnimes: Partial<Anime>[],
  signal: AbortSignal
): Promise<void> {
  if (!db || !isFirebaseConfigured || catalogAnimes.length === 0) return;
  if (isSaveDataEnabled()) return;
  if (isPreloadBatchRunning) return;

  let totalPreloadedInPass = 0;

  while (!signal.aborted && totalPreloadedInPass < PRELOAD_TOTAL_LIMIT) {
    if (isSaveDataEnabled()) return;

    // 1. Wait for all visible & anticipated foreground requests to finish
    const fgReady = await waitForForegroundIdle(signal);
    if (!fgReady || signal.aborted) return;

    // 2. Wait for browser idle slot
    const canProceed = await waitForBrowserIdle(signal);
    if (!canProceed || signal.aborted) return;

    if (isSaveDataEnabled()) return;
    if (hasActiveForegroundRequests()) continue;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (isPreloadBatchRunning) return;

    const remainingQuota = PRELOAD_TOTAL_LIMIT - totalPreloadedInPass;
    const batchTarget = Math.min(PRELOAD_BATCH_LIMIT, remainingQuota);
    if (batchTarget <= 0) return;

    const uncachedIds: string[] = [];
    const seenIds = new Set<string>();

    for (let i = 0; i < catalogAnimes.length && uncachedIds.length < batchTarget; i += 8) {
      if (signal.aborted || hasActiveForegroundRequests()) break;
      const slice = catalogAnimes.slice(i, i + 8);

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

          if (
            inFlightServerById.has(id) ||
            pendingVisiblePromises.has(id) ||
            pendingAnticipatedPromises.has(id)
          ) {
            return null;
          }

          const hasExplicitVersion = typeof anime.portadaVersion === 'number';
          const expectedVersion = hasExplicitVersion ? (anime.portadaVersion as number) : 1;

          const memHit = memoryPortadaCache.get(id);
          if (memHit && (!hasExplicitVersion || memHit.portadaVersion === expectedVersion)) {
            return null;
          }

          const { hit } = await readPortadaFromFirestoreCache(
            id,
            hasExplicitVersion,
            expectedVersion
          );
          if (hit) {
            return null;
          }

          return id;
        })
      );

      for (const id of batchCheck) {
        if (id && uncachedIds.length < batchTarget) {
          uncachedIds.push(id);
        }
      }
    }

    if (signal.aborted) return;
    if (hasActiveForegroundRequests()) continue;
    if (uncachedIds.length === 0) return;

    // Fetch strictly 1 batch of <= 12 IDs at a time
    isPreloadBatchRunning = true;
    try {
      await fetchPortadasBatchFromServer(uncachedIds);
      totalPreloadedInPass += uncachedIds.length;
    } catch {
      return;
    } finally {
      isPreloadBatchRunning = false;
    }
  }
}
