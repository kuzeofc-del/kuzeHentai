import { db, isFirebaseConfigured, doc, getDoc, getDocFromServer } from './firebase';
import { Anime } from '../types';

export interface CachedPortadaRecord {
  id: string;
  portadaVersion: number;
  thumb?: string; // WebP thumbnail (~40 KB, max width 300px)
  full?: string;  // Full original base64 cover (saved only when user opens AnimeDetail)
  updatedAt: number;
}

const DB_NAME = 'kh_portadas_cache_v1';
const DB_VERSION = 1;
const STORE_NAME = 'portadas';

let idbInstancePromise: Promise<IDBDatabase | null> | null = null;
let idbUnavailable = false;

// Session in-memory caches for instant 0ms hits and graceful fallback when IndexedDB fails/is full
const memoryThumbCache = new Map<string, { version: number; dataUrl: string }>();
const memoryFullCache = new Map<string, { version: number; dataUrl: string }>();
const inFlightPortadaFetches = new Map<string, Promise<{ imagen: string; portadaVersion: number } | null>>();
const inFlightThumbGenerations = new Map<string, Promise<string>>();

function openPortadasDb(): Promise<IDBDatabase | null> {
  if (idbUnavailable || typeof window === 'undefined' || !('indexedDB' in window) || !window.indexedDB) {
    return Promise.resolve(null);
  }
  if (idbInstancePromise) return idbInstancePromise;

  idbInstancePromise = new Promise((resolve) => {
    try {
      const req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        try {
          const database = req.result;
          if (!database.objectStoreNames.contains(STORE_NAME)) {
            database.createObjectStore(STORE_NAME, { keyPath: 'id' });
          }
        } catch {
          // Ignore upgrade errors
        }
      };
      req.onsuccess = () => {
        const database = req.result;
        database.onversionchange = () => {
          try {
            database.close();
          } catch {}
          idbInstancePromise = null;
        };
        resolve(database);
      };
      req.onerror = () => {
        idbUnavailable = true;
        idbInstancePromise = null;
        resolve(null);
      };
      req.onblocked = () => {
        resolve(null);
      };
    } catch {
      idbUnavailable = true;
      idbInstancePromise = null;
      resolve(null);
    }
  });

  return idbInstancePromise;
}

export async function getPortadaFromIdb(id: string): Promise<CachedPortadaRecord | null> {
  if (!id || idbUnavailable) return null;
  try {
    const database = await openPortadasDb();
    if (!database) return null;
    return await new Promise<CachedPortadaRecord | null>((resolve) => {
      try {
        const tx = database.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(id);
        req.onsuccess = () => resolve((req.result as CachedPortadaRecord) || null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  } catch {
    return null;
  }
}

export async function putPortadaInIdb(record: CachedPortadaRecord): Promise<void> {
  if (!record?.id || idbUnavailable) return;
  try {
    const database = await openPortadasDb();
    if (!database) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = database.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(record);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        tx.onabort = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  } catch {
    // Graceful degradation on QuotaExceededError or restricted storage
  }
}

export async function deletePortadaFromIdb(id: string): Promise<void> {
  if (!id) return;
  memoryThumbCache.delete(id);
  memoryFullCache.delete(id);
  if (idbUnavailable) return;
  try {
    const database = await openPortadasDb();
    if (!database) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = database.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  } catch {}
}

function estimateDataUrlBytes(dataUrl: string): number {
  const commaIdx = dataUrl.indexOf(',');
  const payloadLen = commaIdx !== -1 ? dataUrl.length - commaIdx - 1 : dataUrl.length;
  return Math.round(payloadLen * 0.75);
}

/**
 * Generates a WebP thumbnail (~40 KB, max width ~300px) using a browser canvas.
 */
export function generateWebpThumbnail(
  sourceDataUrl: string,
  maxWidth: number = 300,
  targetMaxBytes: number = 42000
): Promise<string> {
  if (!sourceDataUrl || typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.resolve(sourceDataUrl);
  }

  const cacheKey = `${sourceDataUrl.length}:${sourceDataUrl.slice(0, 40)}:${sourceDataUrl.slice(-32)}`;
  const existingGen = inFlightThumbGenerations.get(cacheKey);
  if (existingGen) return existingGen;

  const task = new Promise<string>((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const origW = img.naturalWidth || img.width || maxWidth;
        const origH = img.naturalHeight || img.height || Math.round(maxWidth * 1.5);
        const targetW = Math.max(1, Math.min(maxWidth, origW));
        const targetH = Math.max(1, Math.round((origH * targetW) / origW));

        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(sourceDataUrl);
          return;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, targetW, targetH);

        const mime = 'image/webp';
        let quality = 0.78;
        let out = canvas.toDataURL(mime, quality);

        // Fallback to JPEG if browser lacks WebP canvas encoding
        const formatToUse = out.startsWith('data:image/webp') ? mime : 'image/jpeg';
        if (formatToUse !== mime) {
          out = canvas.toDataURL(formatToUse, quality);
        }

        while (estimateDataUrlBytes(out) > targetMaxBytes && quality > 0.32) {
          quality = Math.max(0.3, +(quality - 0.1).toFixed(2));
          out = canvas.toDataURL(formatToUse, quality);
        }

        resolve(out || sourceDataUrl);
      } catch {
        resolve(sourceDataUrl);
      }
    };
    img.onerror = () => resolve(sourceDataUrl);
    img.src = sourceDataUrl;
  }).finally(() => {
    inFlightThumbGenerations.delete(cacheKey);
  });

  inFlightThumbGenerations.set(cacheKey, task);
  return task;
}

/**
 * Fetches full base64 portada from Firestore `portadas/{id}` with deduplication.
 */
export async function fetchPortadaFromFirestore(
  animeId: string,
  expectedVersion?: number
): Promise<{ imagen: string; portadaVersion: number } | null> {
  if (!animeId || !db || !isFirebaseConfigured) return null;

  const flightKey = `${animeId}:${expectedVersion ?? 'any'}`;
  const existing = inFlightPortadaFetches.get(flightKey);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const ref = doc(db, 'portadas', animeId);
      let snap = await getDoc(ref).catch(() => null);
      let data = snap && snap.exists() ? snap.data() : null;
      let snapVersion = typeof data?.portadaVersion === 'number' ? data.portadaVersion : 1;

      // If expectedVersion is newer than cached doc or doc not found locally, try server
      if (
        (!data || !data.imagen || (expectedVersion !== undefined && snapVersion < expectedVersion)) &&
        (typeof navigator === 'undefined' || navigator.onLine !== false)
      ) {
        const srvSnap = await getDocFromServer(ref).catch(() => null);
        if (srvSnap && srvSnap.exists()) {
          snap = srvSnap;
          data = srvSnap.data();
          snapVersion = typeof data?.portadaVersion === 'number' ? data.portadaVersion : 1;
        }
      }

      if (data && typeof data.imagen === 'string' && data.imagen.startsWith('data:image')) {
        return {
          imagen: data.imagen,
          portadaVersion: snapVersion
        };
      }
      return null;
    } catch {
      return null;
    }
  })().finally(() => {
    inFlightPortadaFetches.delete(flightKey);
  });

  inFlightPortadaFetches.set(flightKey, promise);
  return promise;
}

export function getSyncCachedPortada(
  animeId: string | undefined,
  mode: 'thumb' | 'full',
  expectedVersion: number
): string | null {
  if (!animeId) return null;
  if (mode === 'thumb') {
    const hit = memoryThumbCache.get(animeId);
    if (hit && hit.version === expectedVersion) return hit.dataUrl;
  } else {
    const hit = memoryFullCache.get(animeId);
    if (hit && hit.version === expectedVersion) return hit.dataUrl;
  }
  return null;
}

export function isExternalHttpCover(anime: Partial<Anime>): boolean {
  const img = (anime.image || '').trim();
  const cUrl = (anime.coverUrl || '').trim();
  return /^https?:\/\//i.test(img) || /^https?:\/\//i.test(cUrl);
}

/**
 * Resolves a base64 / Firestore `portadas/{id}` cover:
 * - Compares `anime.portadaVersion` against IndexedDB record.
 * - Uses IndexedDB directly if version matches (0 Firestore reads).
 * - For `mode === 'thumb'`, generates ~40KB WebP (<=300px) via canvas and caches it in IndexedDB.
 * - For `mode === 'full'`, persists `full` in IndexedDB ONLY when `saveFull === true` (when user opens the anime).
 * - Falls back seamlessly to Firestore + memory if IndexedDB fails or is full.
 */
export async function resolveAnimeCoverBase64(options: {
  anime: Partial<Anime>;
  mode: 'thumb' | 'full';
  saveFull?: boolean;
}): Promise<string | null> {
  const { anime, mode, saveFull = false } = options;
  const animeId = anime.id ? String(anime.id) : '';
  const expectedVersion = typeof anime.portadaVersion === 'number' ? anime.portadaVersion : 1;

  // 0. Fast in-memory check
  if (animeId) {
    const syncHit = getSyncCachedPortada(animeId, mode, expectedVersion);
    if (syncHit) {
      if (mode === 'full' && saveFull) {
        // Ensure full is also persisted in IndexedDB if user opened the anime
        getPortadaFromIdb(animeId).then(async (rec) => {
          if (!rec || rec.portadaVersion !== expectedVersion || !rec.full) {
            const thumb = rec && rec.portadaVersion === expectedVersion && rec.thumb
              ? rec.thumb
              : await generateWebpThumbnail(syncHit);
            memoryThumbCache.set(animeId, { version: expectedVersion, dataUrl: thumb });
            await putPortadaInIdb({
              id: animeId,
              portadaVersion: expectedVersion,
              thumb,
              full: syncHit,
              updatedAt: Date.now()
            });
          }
        }).catch(() => {});
      }
      return syncHit;
    }
  }

  // 1. Check IndexedDB first
  const existingRecord = animeId ? await getPortadaFromIdb(animeId) : null;
  if (existingRecord && existingRecord.portadaVersion === expectedVersion) {
    if (mode === 'thumb') {
      if (existingRecord.thumb) {
        memoryThumbCache.set(animeId, { version: expectedVersion, dataUrl: existingRecord.thumb });
        return existingRecord.thumb;
      }
      if (existingRecord.full) {
        const thumb = await generateWebpThumbnail(existingRecord.full);
        memoryThumbCache.set(animeId, { version: expectedVersion, dataUrl: thumb });
        await putPortadaInIdb({
          ...existingRecord,
          thumb,
          updatedAt: Date.now()
        });
        return thumb;
      }
    } else if (mode === 'full' && existingRecord.full) {
      memoryFullCache.set(animeId, { version: expectedVersion, dataUrl: existingRecord.full });
      return existingRecord.full;
    }
  }

  // 2. Source base64 either inline (before migration) or from Firestore `portadas/{id}`
  let fullImagen: string | null = null;
  let resolvedVersion = expectedVersion;

  if (anime.coverData && anime.coverData.startsWith('data:image')) {
    fullImagen = anime.coverData;
  } else if (anime.image && anime.image.startsWith('data:image')) {
    fullImagen = anime.image;
  } else if (animeId) {
    const fsData = await fetchPortadaFromFirestore(animeId, expectedVersion);
    if (fsData?.imagen) {
      fullImagen = fsData.imagen;
      resolvedVersion = fsData.portadaVersion;
    }
  }

  if (!fullImagen) {
    return null;
  }

  // 3. Process and store according to mode
  if (mode === 'thumb') {
    const thumb = await generateWebpThumbnail(fullImagen);
    if (animeId) {
      memoryThumbCache.set(animeId, { version: resolvedVersion, dataUrl: thumb });
      const preservedFull =
        existingRecord && existingRecord.portadaVersion === resolvedVersion && existingRecord.full
          ? existingRecord.full
          : undefined;
      await putPortadaInIdb({
        id: animeId,
        portadaVersion: resolvedVersion,
        thumb,
        ...(preservedFull ? { full: preservedFull } : {}),
        updatedAt: Date.now()
      });
    }
    return thumb;
  }

  // mode === 'full'
  if (animeId) {
    memoryFullCache.set(animeId, { version: resolvedVersion, dataUrl: fullImagen });

    if (saveFull) {
      // Save full + thumb into IndexedDB because user explicitly opened this anime
      const thumb =
        existingRecord && existingRecord.portadaVersion === resolvedVersion && existingRecord.thumb
          ? existingRecord.thumb
          : await generateWebpThumbnail(fullImagen);
      memoryThumbCache.set(animeId, { version: resolvedVersion, dataUrl: thumb });
      await putPortadaInIdb({
        id: animeId,
        portadaVersion: resolvedVersion,
        thumb,
        full: fullImagen,
        updatedAt: Date.now()
      });
    } else if (!existingRecord || existingRecord.portadaVersion !== resolvedVersion || !existingRecord.thumb) {
      // In carousel: do NOT save `full` in IndexedDB, only save lightweight `thumb` if missing/outdated
      generateWebpThumbnail(fullImagen)
        .then((thumb) => {
          memoryThumbCache.set(animeId, { version: resolvedVersion, dataUrl: thumb });
          return putPortadaInIdb({
            id: animeId,
            portadaVersion: resolvedVersion,
            thumb,
            updatedAt: Date.now()
          });
        })
        .catch(() => {});
    }
  }

  return fullImagen;
}

/**
 * Updates IndexedDB + memory caches immediately after an admin edits or creates a cover.
 */
export async function upsertPortadaCache(
  animeId: string,
  fullBase64: string,
  portadaVersion: number
): Promise<void> {
  if (!animeId || !fullBase64 || !fullBase64.startsWith('data:image')) return;
  try {
    memoryFullCache.set(animeId, { version: portadaVersion, dataUrl: fullBase64 });
    const thumb = await generateWebpThumbnail(fullBase64);
    memoryThumbCache.set(animeId, { version: portadaVersion, dataUrl: thumb });
    await putPortadaInIdb({
      id: animeId,
      portadaVersion,
      thumb,
      full: fullBase64,
      updatedAt: Date.now()
    });
  } catch {}
}
