/**
 * Real-time Firestore catalog listener with persistent local caching,
 * prioritized "Últimos episodios" hydration, and seamless silent diff updates.
 */

import {
  db,
  isFirebaseConfigured,
  collection,
  doc,
  query,
  orderBy,
  limit,
  onSnapshot
} from './firebase';
import { Anime, Studio, Genre, normalizeAnimeYear } from '../types';
import { normalizeEpisodesList } from '../utils/episodeUtils';
import { saveCatalogToIDB, applyRecentAdminMutations } from './idbStorage';
import { saveCatalogToLocalStorage } from './versionSync';

export interface RealtimeCatalogCallbacks {
  onAnimesUpdate: (animes: Anime[]) => void;
  onStudiosUpdate: (studios: Studio[]) => void;
  onGenresUpdate: (genres: Genre[]) => void;
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
 * Subscribes to catalog collections using real-time Firestore onSnapshot listeners.
 * 
 * - Prioritizes "Últimos episodios" by first listening to recent animes (limit 30)
 * - Automatically handles document additions, modifications, and deletions in real-time
 * - Persists updates to IndexedDB and localStorage seamlessly in background
 * - Operates completely silently without showing alerts or popups when network is offline
 */
export function subscribeToRealtimeCatalog(callbacks: RealtimeCatalogCallbacks): () => void {
  if (!db || !isFirebaseConfigured) {
    return () => {};
  }
  const unsubs: (() => void)[] = [];
  const animeMap = new Map<string, Anime>();
  let currentStudios: Studio[] = [];
  let currentGenres: Genre[] = [];
  let isFullCatalogLoaded = false;

  const persistCurrentState = () => {
    try {
      const animesArray = Array.from(animeMap.values()).sort(sortAnimeCatalog);
      const normalizedAnimes = applyRecentAdminMutations(animesArray);
      saveCatalogToIDB(normalizedAnimes, currentStudios, currentGenres).catch(() => {});
      saveCatalogToLocalStorage(normalizedAnimes, currentStudios, currentGenres);
    } catch {}
  };

  try {
    // 1. PRIORIDAD 1: "Últimos episodios" se escucha primero con limit(30)
    // Permite que la sección de episodios recientes se actualice inmediatamente en todos los celulares
    const recentAnimesQuery = query(
      collection(db, 'animes'),
      orderBy('updatedAt', 'desc'),
      limit(30)
    );

    const unsubRecent = onSnapshot(
      recentAnimesQuery,
      { includeMetadataChanges: false },
      (snapshot) => {
        try {
          snapshot.docChanges().forEach((change) => {
            const docId = change.doc.id;
            if (change.type === 'removed') {
              // Si se eliminó y el catálogo completo aún no tomó control
              if (!isFullCatalogLoaded) {
                animeMap.delete(docId);
              }
            } else {
              const mapped = mapFirestoreAnimeDoc(change.doc);
              animeMap.set(docId, mapped);
            }
          });

          // Si el catálogo completo todavía no ha llegado, emitir los animes recientes de inmediato
          if (!isFullCatalogLoaded && animeMap.size > 0) {
            const animesList = Array.from(animeMap.values()).sort(sortAnimeCatalog);
            callbacks.onAnimesUpdate(applyRecentAdminMutations(animesList));
            persistCurrentState();
          }
        } catch (err) {
          // Silent catch
        }
      },
      (error) => {
        // Silent offline fallback
        console.warn('[Realtime Sync] Modo sin conexión en recientes:', error?.message || error);
      }
    );
    unsubs.push(unsubRecent);

    // 2. PRIORIDAD 2: Catálogo completo de animes (adiciones, ediciones, eliminaciones en tiempo real)
    const unsubFullAnimes = onSnapshot(
      collection(db, 'animes'),
      { includeMetadataChanges: false },
      (snapshot) => {
        try {
          isFullCatalogLoaded = true;

          // Procesar exactamente qué cambió (added, modified, removed)
          snapshot.docChanges().forEach((change) => {
            const docId = change.doc.id;
            if (change.type === 'removed') {
              animeMap.delete(docId);
            } else {
              const mapped = mapFirestoreAnimeDoc(change.doc);
              animeMap.set(docId, mapped);
            }
          });

          // Si es la primera carga inicial del snapshot y por alguna razón docChanges no vino completo
          if (animeMap.size === 0 && !snapshot.empty) {
            snapshot.docs.forEach((docSnap) => {
              const mapped = mapFirestoreAnimeDoc(docSnap);
              animeMap.set(mapped.id, mapped);
            });
          }

          const fullList = Array.from(animeMap.values()).sort(sortAnimeCatalog);
          const normalized = applyRecentAdminMutations(fullList);
          callbacks.onAnimesUpdate(normalized);
          persistCurrentState();
        } catch (err) {
          // Silent catch
        }
      },
      (error) => {
        console.warn('[Realtime Sync] Modo sin conexión en animes:', error?.message || error);
      }
    );
    unsubs.push(unsubFullAnimes);

    // 3. Estudios en tiempo real
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
          currentStudios = list;
          callbacks.onStudiosUpdate(list);
          persistCurrentState();
        } catch (err) {}
      },
      (error) => {
        console.warn('[Realtime Sync] Modo sin conexión en estudios:', error?.message || error);
      }
    );
    unsubs.push(unsubStudios);

    // 4. Géneros en tiempo real
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
          currentGenres = list;
          callbacks.onGenresUpdate(list);
          persistCurrentState();
        } catch (err) {}
      },
      (error) => {
        console.warn('[Realtime Sync] Modo sin conexión en géneros:', error?.message || error);
      }
    );
    unsubs.push(unsubGenres);
  } catch (err) {
    console.warn('[Realtime Sync] Error al inicializar escuchadores en tiempo real:', err);
  }

  // Función de desuscripción limpia
  return () => {
    unsubs.forEach((unsub) => {
      try {
        unsub();
      } catch {}
    });
  };
}
