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
const PRELOAD_BATCH_LIMIT = 12;

// In-memory session cache for covers already read in this session
const memoryPortadaCache = new Map<string, PortadaData>();

// Tier 1: Visible requests (rootMargin 300px) — immediate, 16ms grouping, chunks up to 30
const visibleQueue = new Map<string, Array<(result: PortadaData | null) => void>>();
const inFlightVisible = new Map<string, Promise<PortadaData | null>>();
let visibleBatchTimer: ReturnType<typeof setTimeout> | null = null;
let activeVisibleBatches = 0;

// Tier 2: Anticipated requests (rootMargin 1200px) — waits until visible queue is idle; cancellable on fast scroll
interface AnticipatedWaiter {
  resolve: (result: PortadaData | null) => void;
  signal?: AbortSignal;
}
const anticipatedQueue = new Map<string, Set<AnticipatedWaiter>>();
const inFlightAnticipated = new Map<string, Promise<PortadaData | null>>();
let anticipatedBatchTimer: ReturnType<typeof setTimeout> | null = null;
let activeAnticipatedBatches = 0;

// Idle queue coordination listeners
const visibleIdleListeners = new Set<() => void>();
const foregroundIdleListeners = new Set<() => void>();

// Tier 3: Background idle preload lock (max 1 batch at a time, max 12 cards per batch)
let isPreloadBatchRunning = false;

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

async function fetchPortadasBatchFromServer(ids: string[]): Promise<Map<string, PortadaData>> {
  const foundMap = new Map<string, PortadaData>();
  if (!db || !isFirebaseConfigured || ids.length === 0) return foundMap;

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
  }

  return foundMap;
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
      for (const w of waitingAnticipated) {
        if (!w.signal?.aborted) {
          resolvers.push(w.resolve);
        } else {
          w.resolve(null);
        }
      }
      anticipatedQueue.delete(id);
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
          inFlightVisible.delete(id);
          const result = foundMap.get(id) || null;
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
  const existing = inFlightVisible.get(animeId);
  if (existing) return existing;

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

  inFlightVisible.set(animeId, promise);
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

  // Filter out cancelled waiters (cards that scrolled out of 1200px range)
  const activeEntries: Array<[string, Set<AnticipatedWaiter>]> = [];
  for (const [id, waiters] of anticipatedQueue.entries()) {
    const validWaiters = new Set<AnticipatedWaiter>();
    for (const w of waiters) {
      if (w.signal?.aborted) {
        w.resolve(null);
      } else {
        validWaiters.add(w);
      }
    }
    if (validWaiters.size > 0) {
      // If already resolved by a visible request or cache while waiting, resolve immediately
      const memHit = memoryPortadaCache.get(id);
      if (memHit) {
        for (const w of validWaiters) w.resolve(memHit);
      } else if (inFlightVisible.has(id)) {
        const visPromise = inFlightVisible.get(id)!;
        visPromise.then((res) => {
          for (const w of validWaiters) w.resolve(res);
        });
      } else {
        activeEntries.push([id, validWaiters]);
      }
    }
  }
  anticipatedQueue.clear();

  if (activeEntries.length === 0) {
    notifyQueueIdleState();
    return;
  }

  activeAnticipatedBatches++;
  try {
    const chunks: Array<Array<[string, Set<AnticipatedWaiter>]>> = [];
    for (let i = 0; i < activeEntries.length; i += FIRESTORE_IN_QUERY_MAX) {
      chunks.push(activeEntries.slice(i, i + FIRESTORE_IN_QUERY_MAX));
    }

    for (const chunkEntries of chunks) {
      // Yield to any new visible-tier requests before sending each anticipated chunk
      while (isVisibleBusy()) {
        await waitForVisibleIdle();
      }

      const stillValidEntries: Array<[string, Set<AnticipatedWaiter>]> = [];
      for (const [id, waiters] of chunkEntries) {
        const remainingWaiters = new Set<AnticipatedWaiter>();
        for (const w of waiters) {
          if (w.signal?.aborted) {
            w.resolve(null);
          } else {
            remainingWaiters.add(w);
          }
        }
        if (remainingWaiters.size > 0) {
          const memHit = memoryPortadaCache.get(id);
          if (memHit) {
            for (const w of remainingWaiters) w.resolve(memHit);
          } else if (inFlightVisible.has(id)) {
            inFlightVisible.get(id)!.then((res) => {
              for (const w of remainingWaiters) w.resolve(res);
            });
          } else {
            stillValidEntries.push([id, remainingWaiters]);
          }
        } else {
          inFlightAnticipated.delete(id);
        }
      }

      if (stillValidEntries.length === 0) continue;

      const ids = stillValidEntries.map(([id]) => id);
      const foundMap = await fetchPortadasBatchFromServer(ids);

      for (const [id, waiters] of stillValidEntries) {
        inFlightAnticipated.delete(id);
        const result = foundMap.get(id) || null;
        for (const w of waiters) {
          w.resolve(result);
        }
      }
    }
  } finally {
    activeAnticipatedBatches--;
    notifyQueueIdleState();
  }
}

/**
 * Tier 2 (Anticipated, rootMargin 1200px): runs only when visible queue is idle,
 * and drops entries whose AbortSignal aborted because the card left 1200px during fast scroll.
 */
function requestPortadaAnticipated(
  animeId: string,
  signal?: AbortSignal
): Promise<PortadaData | null> {
  if (signal?.aborted) return Promise.resolve(null);
  if (inFlightVisible.has(animeId)) {
    return inFlightVisible.get(animeId)!;
  }

  const existing = inFlightAnticipated.get(animeId);
  if (existing && !signal) return existing;

  const promise = new Promise<PortadaData | null>((resolve) => {
    const waiter: AnticipatedWaiter = { resolve, signal };
    const set = anticipatedQueue.get(animeId) || new Set<AnticipatedWaiter>();
    set.add(waiter);
    anticipatedQueue.set(animeId, set);

    if (signal) {
      const onAbort = () => {
        const currentSet = anticipatedQueue.get(animeId);
        if (currentSet && currentSet.has(waiter)) {
          currentSet.delete(waiter);
          if (currentSet.size === 0) {
            anticipatedQueue.delete(animeId);
            inFlightAnticipated.delete(animeId);
          }
          resolve(null);
          notifyQueueIdleState();
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (!anticipatedBatchTimer) {
      anticipatedBatchTimer = setTimeout(() => {
        flushAnticipatedQueue().catch(() => {});
      }, ANTICIPATED_BATCH_WINDOW_MS);
    }
  });

  if (!inFlightAnticipated.has(animeId)) {
    inFlightAnticipated.set(animeId, promise);
  }
  return promise;
}

/**
 * Cache-first base64 cover resolution for catalog/cards/detail:
 * a) Memory Map (session hits) & Firestore persistent cache (`getDocFromCache`) matching `portadaVersion` -> `fromCache: true` (instant display, no fade).
 * b) If missing in cache or version mismatch -> two-tier server fetch (`visible` 16ms priority OR `anticipated` when visible is idle) -> `fromCache: false`.
 * c) If offline or server fails and a cached copy exists -> returns cached copy (`fromCache: true`) even with mismatched version.
 * Always uses the original image without resizing or recompression.
 */
export async function resolveAnimeCoverBase64(
  anime: Partial<Anime>,
  options: {
    priority?: 'visible' | 'anticipated';
    signal?: AbortSignal;
    cacheOnly?: boolean;
  } = {}
): Promise<ResolvedPortadaResult | null> {
  const { priority = 'visible', signal, cacheOnly = false } = options;
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
          return { imagen: cachedEntry.imagen, fromCache: true };
        }
        staleCached = cachedEntry;
      }
    }
  } catch {
    // Document not yet in Firestore persistent cache
  }

  if (cacheOnly || signal?.aborted) {
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
      : await requestPortadaAnticipated(animeId, signal);

  if (signal?.aborted && priority === 'anticipated') {
    return null;
  }

  if (serverResult?.imagen) {
    return { imagen: serverResult.imagen, fromCache: false };
  }

  // c) If server failed/returned nothing (e.g. offline/network hiccup), fall back to cached copy
  const fallbackImg = staleCached?.imagen || memHit?.imagen;
  return fallbackImg ? { imagen: fallbackImg, fromCache: true } : null;
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
 * Softer background idle preloader for catalog cards:
 * - Waits until there are NO active visible or anticipated requests
 * - Waits for browser idle (`requestIdleCallback` with `setTimeout` fallback)
 * - Collects up to 12 uncached base64 covers and requests 1 batch at a time
 * - Cancels immediately via `AbortSignal` when user leaves the catalog
 */
export async function startCatalogIdlePreload(
  catalogAnimes: Partial<Anime>[],
  signal: AbortSignal
): Promise<void> {
  if (!db || !isFirebaseConfigured || catalogAnimes.length === 0) return;
  if (isPreloadBatchRunning) return;

  while (!signal.aborted) {
    // 1. Wait for all visible & anticipated foreground requests to finish
    const fgReady = await waitForForegroundIdle(signal);
    if (!fgReady || signal.aborted) return;

    // 2. Wait for browser idle slot
    const canProceed = await waitForBrowserIdle(signal);
    if (!canProceed || signal.aborted) return;

    // Re-check foreground idle after waking up from idle callback
    if (hasActiveForegroundRequests()) {
      continue;
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return;
    }

    if (isPreloadBatchRunning) return;

    const uncachedIds: string[] = [];
    const seenIds = new Set<string>();

    for (let i = 0; i < catalogAnimes.length && uncachedIds.length < PRELOAD_BATCH_LIMIT; i += 8) {
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

          if (inFlightVisible.has(id) || inFlightAnticipated.has(id)) {
            return null;
          }

          const hasExplicitVersion = typeof anime.portadaVersion === 'number';
          const expectedVersion = hasExplicitVersion ? (anime.portadaVersion as number) : 1;

          const memHit = memoryPortadaCache.get(id);
          if (memHit && (!hasExplicitVersion || memHit.portadaVersion === expectedVersion)) {
            return null;
          }

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
            // Candidate for preload
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

    if (signal.aborted) return;
    if (hasActiveForegroundRequests()) continue;
    if (uncachedIds.length === 0) return;

    // Fetch strictly 1 batch of <= 12 IDs at a time
    isPreloadBatchRunning = true;
    try {
      await fetchPortadasBatchFromServer(uncachedIds);
    } catch {
      return;
    } finally {
      isPreloadBatchRunning = false;
    }
  }
}
