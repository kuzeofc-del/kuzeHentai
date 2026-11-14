const DB_NAME = 'KuzeHentaiAppDB';
const DB_VERSION = 2;
const STORE_NAME = 'app_persistent_data';
const STORE_COVERS = 'app_covers_cache';

/**
 * Requests browser permission to grant persistent storage (protects IndexedDB from cache eviction)
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (navigator.storage && navigator.storage.persist) {
    try {
      const isPersisted = await navigator.storage.persist();
      return isPersisted;
    } catch (e) {
      console.warn('[Storage] Could not request persistent storage:', e);
    }
  }
  return false;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB not supported'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(STORE_COVERS)) {
        db.createObjectStore(STORE_COVERS);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const ADMIN_MUTATIONS_KEY = 'kh_recent_admin_mutations_v1';

export function applyRecentAdminMutations(animes: any[]): any[] {
  return Array.isArray(animes) ? animes : [];
}

/**
 * Local catalog saving is disabled so data is always loaded directly from Firebase
 */
export async function recordAdminCatalogMutation(_updatedAnime?: any | any[], _deletedId?: string): Promise<void> {
  try {
    localStorage.removeItem(ADMIN_MUTATIONS_KEY);
  } catch {}
}

/**
 * Local catalog saving disabled: always fetch fresh from Firebase
 */
export async function saveCatalogToIDB(_animes: any[], _studios: any[], _genres: any[]): Promise<void> {
  await clearCatalogFromIDB();
}

/**
 * Purges any obsolete catalog data from IndexedDB
 */
export async function clearCatalogFromIDB(): Promise<void> {
  try {
    localStorage.removeItem(ADMIN_MUTATIONS_KEY);
    const db = await openDB();
    if (db.objectStoreNames.contains(STORE_NAME)) {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete('cached_animes');
      store.delete('cached_studios');
      store.delete('cached_genres');
      store.delete('cached_catalog_timestamp');
      store.delete('cached_animes_v3');
      store.delete('cached_studios_v3');
      store.delete('cached_genres_v3');
      store.delete('cached_catalog_timestamp_v3');
    }
  } catch (e) {}
}

/**
 * Always returns null so catalog is fetched fresh from Firebase on every page load/refresh
 */
export async function getCatalogFromIDB(): Promise<{ animes: any[]; studios: any[]; genres: any[]; timestamp: number } | null> {
  return null;
}

export async function saveCoverToIDB(_id: string, _dataUrl: string): Promise<void> {
  return;
}

export async function getCoverFromIDB(_id: string): Promise<string | null> {
  return null;
}

export async function getAllCoversFromIDB(): Promise<Record<string, string>> {
  return {};
}

export async function purgeAllCoversFromIDB(): Promise<void> {
  try {
    const db = await openDB();
    if (db.objectStoreNames.contains(STORE_COVERS)) {
      const tx = db.transaction(STORE_COVERS, 'readwrite');
      const store = tx.objectStore(STORE_COVERS);
      store.clear();
    }
  } catch (err) {
    // Silent catch
  }
}

/**
 * Saves the user's "Mi Lista" anime IDs to IndexedDB (Application Database Storage)
 */
export async function saveMyListToIDB(listIds: string[], userId?: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const key = userId ? `my_list_ids_${userId}` : 'my_list_ids_guest';
    store.put(listIds, key);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.error('[IDB] Error saving my list to IndexedDB:', err);
  }
}

/**
 * Saves full "Mi Lista" anime items (including covers) locally on the user's device
 */
export async function saveMyListAnimesToIDB(animes: any[], userId?: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const key = userId ? `my_list_animes_${userId}` : 'my_list_animes_guest';
    store.put(animes, key);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.error('[IDB] Error saving my list animes to IndexedDB:', err);
  }
}

/**
 * Loads "Mi Lista" animes (with local covers) from IndexedDB
 */
export async function getMyListAnimesFromIDB(userId?: string): Promise<any[] | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const key = userId ? `my_list_animes_${userId}` : 'my_list_animes_guest';
    const request = store.get(key);
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error('[IDB] Error loading my list animes from IndexedDB:', err);
    return null;
  }
}

/**
 * Loads "Mi Lista" anime IDs from IndexedDB
 */
export async function getMyListFromIDB(userId?: string): Promise<string[] | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const key = userId ? `my_list_ids_${userId}` : 'my_list_ids_guest';
    const request = store.get(key);
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error('[IDB] Error loading my list from IndexedDB:', err);
    return null;
  }
}
