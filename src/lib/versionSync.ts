import { db, doc, setDoc, getDoc, getDocFromServer, increment } from './firebase';

export const CACHE_VERSION_KEY = 'cacheVersion';
export const LOCAL_CATALOG_CACHE_KEY = 'kh_catalog_cache_v1';

export interface CatalogCachePayload {
  animes: any[];
  studios: any[];
  genres: any[];
  ts: number;
}

/**
 * Reads the catalog cached in localStorage for zero-latency instant startup.
 */
export function getCatalogFromLocalStorage(): CatalogCachePayload | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(LOCAL_CATALOG_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.animes) && parsed.animes.length > 0) {
      return {
        animes: parsed.animes,
        studios: Array.isArray(parsed.studios) ? parsed.studios : [],
        genres: Array.isArray(parsed.genres) ? parsed.genres : [],
        ts: typeof parsed.ts === 'number' ? parsed.ts : Date.now()
      };
    }
  } catch {}
  return null;
}

/**
 * Persists catalog to localStorage, stripping heavy base64 strings so it fits safely under the 5MB quota.
 */
export function saveCatalogToLocalStorage(animes: any[], studios: any[], genres: any[]) {
  if (typeof window === 'undefined') return;
  try {
    if (!Array.isArray(animes) || animes.length === 0) return;
    const safeAnimes = animes.map(a => {
      if (!a) return a;
      const { coverData, ...rest } = a;
      return rest;
    });
    localStorage.setItem(
      LOCAL_CATALOG_CACHE_KEY,
      JSON.stringify({
        animes: safeAnimes,
        studios: Array.isArray(studios) ? studios : [],
        genres: Array.isArray(genres) ? genres : [],
        ts: Date.now()
      })
    );
  } catch {}
}

/**
 * Reads config/version document from Firestore (bypassing stale browser cache with getDocFromServer).
 */
export async function getFirestoreConfigVersion(): Promise<number | null> {
  if (!db) return null;
  try {
    const configDocRef = doc(db, 'config', 'version');
    const snap = await getDocFromServer(configDocRef).catch(() => getDoc(configDocRef));
    if (snap && snap.exists()) {
      const data = snap.data();
      if (typeof data?.v === 'number') {
        return data.v;
      }
    }
  } catch (err) {
    console.warn('[VersionSync] Error leyendo config/version desde Firestore:', err);
  }
  return null;
}

/**
 * Increments the global config/version counter in Firestore by 1.
 * Called whenever an anime, episode, studio, genre or other catalog data is saved, edited or deleted.
 */
export async function bumpFirestoreConfigVersion(): Promise<number | null> {
  if (!db) return null;
  try {
    const configDocRef = doc(db, 'config', 'version');
    await setDoc(configDocRef, { v: increment(1) }, { merge: true });

    // Read back the fresh version to keep local admin cacheVersion updated synchronously
    const snap = await getDocFromServer(configDocRef).catch(() => getDoc(configDocRef));
    if (snap && snap.exists()) {
      const newV = snap.data()?.v;
      if (typeof newV === 'number') {
        try {
          localStorage.setItem(CACHE_VERSION_KEY, String(newV));
        } catch {}
        return newV;
      }
    }
  } catch (err) {
    console.warn('[VersionSync] Error incrementando config/version en Firestore:', err);
  }
  return null;
}

/**
 * Compares config/version from Firestore against localStorage 'cacheVersion'.
 * 1. If different: calls onVersionMismatch (re-downloads fresh data), updates cache, and saves new 'cacheVersion'.
 * 2. If identical: does nothing.
 * 3. If offline or read error: catches error silently and continues using cache without errors.
 */
export async function checkAndRevalidateCatalog(
  onVersionMismatch: () => Promise<void>
): Promise<boolean> {
  try {
    const remoteV = await getFirestoreConfigVersion();
    if (remoteV === null) {
      // Offline or network error: silently keep using cache
      return false;
    }

    const localV = typeof window !== 'undefined' ? localStorage.getItem(CACHE_VERSION_KEY) : null;

    if (localV === null || String(remoteV) !== String(localV)) {
      // Version mismatch: re-download data from Firestore
      await onVersionMismatch();
      try {
        localStorage.setItem(CACHE_VERSION_KEY, String(remoteV));
      } catch {}
      return true;
    }

    // Version matches: do nothing
    return false;
  } catch (err) {
    // Graceful offline fallback: silently use cache
    console.warn('[VersionSync] Conexión no disponible o error al leer versión, usando caché local:', err);
    return false;
  }
}
