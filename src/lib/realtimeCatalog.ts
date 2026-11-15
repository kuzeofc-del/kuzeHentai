/**
 * Real-time Firestore catalog listener backed by Firestore persistentLocalCache.
 * Emits locally cached data immediately on startup/offline, then streams server changes silently.
 */

import {
  db,
  isFirebaseConfigured,
  collection,
  getDocsFromCache,
  onSnapshot,
  firebaseConnectionReady
} from './firebase';
import { Anime, Studio, Genre, normalizeAnimeYear } from '../types';
import { normalizeEpisodesList } from '../utils/episodeUtils';

export interface RealtimeCatalogCallbacks {
  onAnimesUpdate: (animes: Anime[], meta: { fromCache: boolean }) => void;
  onStudiosUpdate: (studios: Studio[], meta: { fromCache: boolean }) => void;
  onGenresUpdate: (genres: Genre[], meta: { fromCache: boolean }) => void;
  onInitialReady?: () => void;
}

export function mapFirestoreAnimeDoc(docSnap: any): Anime {
  const d = docSnap.data();
  const resolvedImage = String(d.image || d.coverUrl || '');
  const hasExternalUrl = /^https?:\/\//i.test(resolvedImage);
  const resolvedStudioIds: string[] = Array.isArray(d.studioIds)
    ? d.studioIds.map(String).filter(Boolean)
    : (d.studioId ? [String(d.studioId)] : []);

  return {
    id: String(d.id || docSnap.id),
    name: d.name || '',
    image: resolvedImage,
    coverData: hasExternalUrl
      ? undefined
      : (d.coverData || (resolvedImage.startsWith('data:') ? resolvedImage : undefined)),
    year: d.year ? normalizeAnimeYear(d.year) : '',
    releaseMonth: d.releaseMonth || d.release_month || '',
    telegramUrl: d.telegramUrl || '',
    episodes: normalizeEpisodesList(d.episodes),
    studioId: d.studioId || resolvedStudioIds[0] || '',
    studioIds: resolvedStudioIds,
    genreIds: d.genreIds || [],
    status: d.status || 'Finalizado',
    description: d.description || '',
    continuationType: d.continuationType || d.continuation_type || undefined,
    continuationAnimeIds: Array.isArray(d.continuationAnimeIds)
      ? d.continuationAnimeIds.map(String)
      : Array.isArray(d.continuation_anime_ids)
      ? d.continuation_anime_ids.map(String)
      : undefined,
    hidden: Boolean(d.hidden),
    downloads: Number(d.downloads) || 0,
    orderIndex: typeof d.orderIndex === 'number' ? d.orderIndex : undefined,
    createdAt: d.createdAt || '',
    updatedAt: d.updatedAt || '',
    storageLocation: 'Firebase Firestore',
    savedInFirestore: true
  } as Anime;
}

export function sortAnimeCatalog(a: Anime, b: Anime): number {
  const hasIdxA = typeof a.orderIndex === 'number';
  const hasIdxB = typeof b.orderIndex === 'number';
  if (hasIdxA && hasIdxB && a.orderIndex !== b.orderIndex) {
    return (a.orderIndex as number) - (b.orderIndex as number);
  }
  const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  if (timeA !== timeB) return timeA - timeB;
  return 0;
}

export function mapFirestoreStudioDoc(docSnap: any): Studio {
  const d = docSnap.data();
  return {
    id: String(d.id || docSnap.id),
    name: d.name || '',
    image: d.image || '',
    order: typeof d.order === 'number' ? d.order : 10,
    orderIndex: typeof d.orderIndex === 'number' ? d.orderIndex : undefined,
    storageLocation: 'Firebase Firestore'
  } as Studio;
}

export function mapFirestoreGenreDoc(docSnap: any): Genre {
  const d = docSnap.data();
  return {
    id: String(d.id || docSnap.id),
    name: d.name || '',
    image: d.image || '',
    order: typeof d.order === 'number' ? d.order : 10,
    orderIndex: typeof d.orderIndex === 'number' ? d.orderIndex : undefined,
    storageLocation: 'Firebase Firestore'
  } as Genre;
}

/**
 * Subscribes to animes, studios, and genres using real-time Firestore onSnapshot listeners.
 * Serves locally persisted data immediately (even offline) and syncs server updates in real time.
 */
export function subscribeToRealtimeCatalog(callbacks: RealtimeCatalogCallbacks): () => void {
  if (!db || !isFirebaseConfigured) {
    callbacks.onInitialReady?.();
    return () => {};
  }

  let disposed = false;
  const unsubs: (() => void)[] = [];
  const animeMap = new Map<string, Anime>();
  let readyEmitted = false;

  const markReady = () => {
    if (!readyEmitted) {
      readyEmitted = true;
      callbacks.onInitialReady?.();
    }
  };

  const startListeners = async () => {
    // 1. Hydrate from local persistent cache immediately (0ms) so UI shows cached catalog before network sync
    try {
      const [cachedAnimesSnap, cachedStudiosSnap, cachedGenresSnap] = await Promise.all([
        getDocsFromCache(collection(db, 'animes')).catch(() => null),
        getDocsFromCache(collection(db, 'studios')).catch(() => null),
        getDocsFromCache(collection(db, 'genres')).catch(() => null),
      ]);

      if (disposed) return;

      if (cachedStudiosSnap && !cachedStudiosSnap.empty) {
        const list = cachedStudiosSnap.docs
          .map(mapFirestoreStudioDoc)
          .filter((s) => Boolean(s.name))
          .sort((a, b) => {
            if (typeof a.orderIndex === 'number' && typeof b.orderIndex === 'number') {
              return a.orderIndex - b.orderIndex;
            }
            return (a.order || 10) - (b.order || 10);
          });
        if (list.length > 0) callbacks.onStudiosUpdate(list, { fromCache: true });
      }

      if (cachedGenresSnap && !cachedGenresSnap.empty) {
        const list = cachedGenresSnap.docs
          .map(mapFirestoreGenreDoc)
          .filter((g) => Boolean(g.name))
          .sort((a, b) => {
            if (typeof a.orderIndex === 'number' && typeof b.orderIndex === 'number') {
              return a.orderIndex - b.orderIndex;
            }
            return (a.order || 10) - (b.order || 10);
          });
        if (list.length > 0) callbacks.onGenresUpdate(list, { fromCache: true });
      }

      if (cachedAnimesSnap && !cachedAnimesSnap.empty) {
        cachedAnimesSnap.docs.forEach((docSnap) => {
          animeMap.set(docSnap.id, mapFirestoreAnimeDoc(docSnap));
        });
        const cachedList = Array.from(animeMap.values()).sort(sortAnimeCatalog);
        if (cachedList.length > 0) {
          callbacks.onAnimesUpdate(cachedList, { fromCache: true });
          markReady();
        }
      }
    } catch {}

    // 2. Let the lightweight test/connection handshake finish (~80ms when online)
    // before streaming the heavy animes collection on the shared WatchStream.
    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
      await Promise.race([
        firebaseConnectionReady,
        new Promise<void>((resolve) => setTimeout(resolve, 600))
      ]).catch(() => {});
    }

    if (disposed) return;

    try {
      // 3. Animes collection in real time (cache-first via persistentLocalCache, then live server updates)
      const unsubAnimes = onSnapshot(
        collection(db, 'animes'),
        { includeMetadataChanges: false },
        (snapshot) => {
          try {
            const changes = snapshot.docChanges();
            if (changes.length > 0) {
              changes.forEach((change) => {
                const docId = change.doc.id;
                if (change.type === 'removed') {
                  animeMap.delete(docId);
                } else {
                  const mapped = mapFirestoreAnimeDoc(change.doc);
                  animeMap.set(docId, mapped);
                }
              });
            } else if (animeMap.size === 0 && !snapshot.empty) {
              snapshot.docs.forEach((docSnap) => {
                const mapped = mapFirestoreAnimeDoc(docSnap);
                animeMap.set(docSnap.id, mapped);
              });
            }

            const fullList = Array.from(animeMap.values()).sort(sortAnimeCatalog);
            if (fullList.length > 0 || !snapshot.metadata.fromCache) {
              callbacks.onAnimesUpdate(fullList, { fromCache: snapshot.metadata.fromCache });
              markReady();
            }
          } catch {}
        },
        (error) => {
          console.warn('[Realtime Sync] Modo sin conexión en animes:', error?.message || error);
          markReady();
        }
      );
      unsubs.push(unsubAnimes);

      // 4. Studios collection in real time
      const unsubStudios = onSnapshot(
        collection(db, 'studios'),
        { includeMetadataChanges: false },
        (snapshot) => {
          try {
            const list = snapshot.docs
              .map(mapFirestoreStudioDoc)
              .filter((s) => Boolean(s.name))
              .sort((a, b) => {
                if (typeof a.orderIndex === 'number' && typeof b.orderIndex === 'number') {
                  return a.orderIndex - b.orderIndex;
                }
                return (a.order || 10) - (b.order || 10);
              });
            if (list.length > 0 || !snapshot.metadata.fromCache) {
              callbacks.onStudiosUpdate(list, { fromCache: snapshot.metadata.fromCache });
            }
          } catch {}
        },
        (error) => {
          console.warn('[Realtime Sync] Modo sin conexión en estudios:', error?.message || error);
        }
      );
      unsubs.push(unsubStudios);

      // 5. Genres collection in real time
      const unsubGenres = onSnapshot(
        collection(db, 'genres'),
        { includeMetadataChanges: false },
        (snapshot) => {
          try {
            const list = snapshot.docs
              .map(mapFirestoreGenreDoc)
              .filter((g) => Boolean(g.name))
              .sort((a, b) => {
                if (typeof a.orderIndex === 'number' && typeof b.orderIndex === 'number') {
                  return a.orderIndex - b.orderIndex;
                }
                return (a.order || 10) - (b.order || 10);
              });
            if (list.length > 0 || !snapshot.metadata.fromCache) {
              callbacks.onGenresUpdate(list, { fromCache: snapshot.metadata.fromCache });
            }
          } catch {}
        },
        (error) => {
          console.warn('[Realtime Sync] Modo sin conexión en géneros:', error?.message || error);
        }
      );
      unsubs.push(unsubGenres);
    } catch (err) {
      console.warn('[Realtime Sync] Error al inicializar escuchadores en tiempo real:', err);
      markReady();
    }
  };

  startListeners();

  return () => {
    disposed = true;
    unsubs.forEach((unsub) => {
      try {
        unsub();
      } catch {}
    });
  };
}
