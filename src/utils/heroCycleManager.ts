/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Anime, Studio, normalizeAnimeYear } from '../types';
import { getAnimeRatingStats, getAnimeRecent24hRatingStats } from './ratingManager';
import { getAnimeMyListSaveCount } from '../lib/userListService';
import { db, doc, getDoc, setDoc, onSnapshot } from '../lib/firebase';

const HERO_CYCLE_LOCK_STORAGE_KEY = 'kh_hero_cycle_lock_v3';
const GLOBAL_VIEWS_24H_CACHE_KEY = 'kh_global_hero_views_24h_v2';
const LEGACY_STORAGE_KEYS = ['kh_hero_cycle_v1', 'kh_hero_cycle_v2', 'kh_anime_views_24h'];

export interface HeroCycleLockState {
  cycleStartTime: number;
  slot2MostPopularId: string;
  slot3BestRatedId: string;
  slot5FeaturedId: string;
  slot5Mode: 'emision' | 'mylist';
}

interface ViewEvent24h {
  animeId: string;
  timestamp: number;
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

let globalViewEvents24h: ViewEvent24h[] = [];
let activeCycleLock: HeroCycleLockState | null = null;
let heroViewsListenerInitialized = false;
let remoteLockResolved = false;

function isValidCycleLock(lock: any, now = Date.now()): lock is HeroCycleLockState {
  if (!lock || typeof lock !== 'object') return false;
  if (typeof lock.cycleStartTime !== 'number' || !Number.isFinite(lock.cycleStartTime)) return false;
  if (lock.cycleStartTime <= 0 || lock.cycleStartTime > now + 60 * 1000) return false;
  if (now - lock.cycleStartTime >= TWENTY_FOUR_HOURS_MS) return false;
  if (typeof lock.slot2MostPopularId !== 'string' || !lock.slot2MostPopularId) return false;
  if (typeof lock.slot3BestRatedId !== 'string' || !lock.slot3BestRatedId) return false;
  if (typeof lock.slot5FeaturedId !== 'string' || !lock.slot5FeaturedId) return false;
  return true;
}

function loadCachedCycleLock(): HeroCycleLockState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(HERO_CYCLE_LOCK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (isValidCycleLock(parsed)) {
      activeCycleLock = parsed;
      return parsed;
    }
  } catch {}
  return null;
}

function saveCachedCycleLock(lock: HeroCycleLockState, syncToFirestore = false): void {
  activeCycleLock = lock;
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(HERO_CYCLE_LOCK_STORAGE_KEY, JSON.stringify(lock));
    } catch {}
  }
  if (syncToFirestore && db) {
    try {
      const lockRef = doc(db, 'app_metrics', 'hero_cycle_lock_v1');
      setDoc(lockRef, { ...lock, updatedAt: Date.now() }, { merge: true }).catch(() => {});
    } catch {}
  }
}

function getPreviousCycleLockMode(): 'emision' | 'mylist' | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(HERO_CYCLE_LOCK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.slot5Mode === 'emision' || parsed.slot5Mode === 'mylist')) {
      return parsed.slot5Mode;
    }
  } catch {}
  return null;
}

function pruneViewEvents(list: ViewEvent24h[], now = Date.now()): ViewEvent24h[] {
  const cutoff = now - TWENTY_FOUR_HOURS_MS;
  if (!Array.isArray(list)) return [];
  const filtered = list.filter(
    (item) =>
      item &&
      typeof item.animeId === 'string' &&
      item.animeId.trim().length > 0 &&
      typeof item.timestamp === 'number' &&
      item.timestamp > cutoff
  );
  return filtered.length > 300 ? filtered.slice(filtered.length - 300) : filtered;
}

function loadCachedGlobalViewEvents(): void {
  if (typeof window === 'undefined') return;
  try {
    for (const oldKey of LEGACY_STORAGE_KEYS) {
      localStorage.removeItem(oldKey);
    }
    const raw = localStorage.getItem(GLOBAL_VIEWS_24H_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        globalViewEvents24h = pruneViewEvents(parsed);
      }
    }
  } catch {}
}

function saveCachedGlobalViewEvents(events: ViewEvent24h[]): void {
  globalViewEvents24h = pruneViewEvents(events);
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(GLOBAL_VIEWS_24H_CACHE_KEY, JSON.stringify(globalViewEvents24h));
    } catch {}
  }
}

export function initHeroViewsRealtimeListener(): void {
  if (heroViewsListenerInitialized || typeof window === 'undefined') return;
  heroViewsListenerInitialized = true;
  loadCachedGlobalViewEvents();
  loadCachedCycleLock();

  if (!db) {
    remoteLockResolved = true;
    return;
  }

  try {
    const metricsRef = doc(db, 'app_metrics', 'hero_views_24h');
    const lockRef = doc(db, 'app_metrics', 'hero_cycle_lock_v1');

    const applyRemoteViewsDoc = (data: any) => {
      const remoteEvents = data && Array.isArray(data.events) ? data.events : [];
      saveCachedGlobalViewEvents(remoteEvents);
    };

    const applyRemoteLockDoc = (data: any) => {
      remoteLockResolved = true;
      if (isValidCycleLock(data)) {
        const changed =
          !activeCycleLock ||
          activeCycleLock.cycleStartTime !== data.cycleStartTime ||
          activeCycleLock.slot2MostPopularId !== data.slot2MostPopularId ||
          activeCycleLock.slot3BestRatedId !== data.slot3BestRatedId ||
          activeCycleLock.slot5FeaturedId !== data.slot5FeaturedId;

        saveCachedCycleLock({
          cycleStartTime: data.cycleStartTime,
          slot2MostPopularId: data.slot2MostPopularId,
          slot3BestRatedId: data.slot3BestRatedId,
          slot5FeaturedId: data.slot5FeaturedId,
          slot5Mode: data.slot5Mode === 'mylist' ? 'mylist' : 'emision',
        }, false);

        if (changed) {
          window.dispatchEvent(new CustomEvent('kh_hero_cycle_updated'));
        }
      } else if (activeCycleLock && isValidCycleLock(activeCycleLock)) {
        // Remote has no active lock or it expired, push our valid local lock so all clients share it
        saveCachedCycleLock(activeCycleLock, true);
      }
    };

    getDoc(metricsRef)
      .then((snap) => {
        if (snap && snap.exists()) {
          applyRemoteViewsDoc(snap.data());
        }
      })
      .catch(() => {});

    getDoc(lockRef)
      .then((snap) => {
        if (snap && snap.exists()) {
          applyRemoteLockDoc(snap.data());
        } else {
          remoteLockResolved = true;
          if (activeCycleLock && isValidCycleLock(activeCycleLock)) {
            saveCachedCycleLock(activeCycleLock, true);
          }
        }
      })
      .catch(() => {
        remoteLockResolved = true;
      });

    onSnapshot(
      lockRef,
      (snap) => {
        if (snap && snap.exists()) {
          applyRemoteLockDoc(snap.data());
        }
      },
      () => {}
    );
  } catch {
    remoteLockResolved = true;
  }
}

// Defer shared Firestore listener to background so initial cards load instantly
if (typeof window !== 'undefined') {
  setTimeout(() => {
    initHeroViewsRealtimeListener();
  }, 3500);
}

/**
 * Record an anime view/play/download in the shared rolling 24-hour window (synced via Firestore).
 * Views are accumulated in the background for the NEXT 24-hour cycle and do NOT alter the currently locked carousel.
 */
export function recordHeroAnimeView(animeId: string) {
  if (!animeId) return;
  initHeroViewsRealtimeListener();

  const now = Date.now();
  const updated = pruneViewEvents([...globalViewEvents24h, { animeId, timestamp: now }], now);
  saveCachedGlobalViewEvents(updated);

  if (db) {
    try {
      const metricsRef = doc(db, 'app_metrics', 'hero_views_24h');
      setDoc(
        metricsRef,
        {
          events: updated,
          updatedAt: now,
        },
        { merge: true }
      ).catch(() => {});
    } catch {}
  }
}

/**
 * Helper to compute the latest active new-episode timestamp and episode number for an anime,
 * matching the exact sorting logic of the "Nuevos episodios" section in App.tsx.
 */
function getActiveNewEpisodeSortInfo(anime: Anime): { maxTime: number; maxEpNum: number } {
  const baseTime = anime.createdAt ? new Date(anime.createdAt).getTime() : 0;
  let maxTime = -1;
  let maxEpNum = 0;

  (anime.episodes || []).forEach((ep) => {
    if (!Boolean(ep.isNew)) return;
    const epNum = Number(ep.number) || 1;
    const epTimestamp = ep.addedToRecentAt
      ? new Date(ep.addedToRecentAt).getTime()
      : (baseTime + epNum * 1000);
    if (epTimestamp > maxTime || (epTimestamp === maxTime && epNum > maxEpNum)) {
      maxTime = epTimestamp;
      maxEpNum = epNum;
    }
  });

  return { maxTime, maxEpNum };
}

/**
 * Returns UTC calendar date seed (YYYYMMDD) so daily tie-breaking is identical across timezones.
 */
function getDailySeed(timestampMs = Date.now()): number {
  const d = new Date(timestampMs);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/**
 * Deterministic hash weight per anime ID, daily seed, and category salt.
 */
function getDailyRotationWeight(animeId: string, seed: number, category: string): number {
  let hash = 2166136261;
  const str = `hero_rot_${category}_${animeId}_${seed}`;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  let t = (hash ^ (hash >>> 16)) >>> 0;
  t = Math.imul(t, 2246822507);
  t ^= t >>> 13;
  t = Math.imul(t, 3266489909);
  t ^= t >>> 16;
  return t >>> 0;
}

/**
 * Reads recent 24-hour views map from the shared Firestore-backed event log.
 * Automatically prunes any expired entries older than 24 hours.
 */
function getRecentViewsMap(): Record<string, number> {
  initHeroViewsRealtimeListener();
  const rollingMap: Record<string, number> = {};
  const validEvents = pruneViewEvents(globalViewEvents24h);
  for (const item of validEvents) {
    rollingMap[item.animeId] = (rollingMap[item.animeId] || 0) + 1;
  }
  return rollingMap;
}

/**
 * Checks if a studio name or ID corresponds to Studio T-Rex.
 */
function isTRexIdentifier(val: string | undefined | null): boolean {
  if (!val) return false;
  const raw = String(val).trim().toLowerCase();
  if (raw === 'st-dced22d9' || raw === 'st-t-rex') return true;
  const clean = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s\-_.]+/g, '');
  return clean === 'trex' || clean === 'studiotrex' || clean.includes('trex');
}

/**
 * Resolves the 5 featured animes for the Hero Carousel in strict, fixed positions
 * and locks the 24-hour positions (#2, #3, #5) for a full 24-hour cycle so they NEVER
 * change prematurely before 24 hours have elapsed:
 * 1. Posición #1: El último anime del estudio T-Rex.
 * 2. Posición #2: El anime más popular en 24 horas (bloqueado por 24 horas completas).
 * 3. Posición #3: El anime mejor calificado en 24 horas (bloqueado por 24 horas completas).
 * 4. Posición #4: El penúltimo anime con nuevos episodios (1 anime).
 * 5. Posición #5: Rotación diaria (24h completas cada uno) entre:
 *    - El anime "En Emisión" destacado del día.
 *    - El anime más guardado en "Mi Lista" / Favoritos.
 */
export function computeHeroFeaturedAnimes(animes: Anime[], studios: Studio[] = []): Anime[] {
  const visibleAnimes = animes.filter((a) => {
    if (a.hidden) return false;
    const st = (a.status || '').trim().toLowerCase();
    if (st === 'próximamente' || st === 'proximamente' || st.includes('próximamente') || st.includes('proximamente')) {
      return false;
    }
    return true;
  });
  if (visibleAnimes.length === 0) return [];

  const visibleById = new Map<string, Anime>();
  for (const a of visibleAnimes) {
    visibleById.set(a.id, a);
  }

  const selectedIds = new Set<string>();

  // ============================================================================
  // PASO A: Identificar y reservar primero las posiciones de catálogo (#1 y #4)
  // ============================================================================

  // 1. POSICIÓN #1: El último anime del estudio T-Rex
  let slot1TRexAnime: Anime | null = null;
  const tRexStudioIds = new Set<string>(['st-dced22d9', 'st-t-rex']);
  for (const st of studios) {
    if (isTRexIdentifier(st.name) || isTRexIdentifier(st.id)) {
      tRexStudioIds.add(st.id);
    }
  }

  const tRexAnimes = visibleAnimes.filter((a) => {
    const sIds = (a.studioIds && a.studioIds.length > 0)
      ? a.studioIds
      : (a.studioId ? [a.studioId] : []);
    return sIds.some((sid) => tRexStudioIds.has(sid) || isTRexIdentifier(sid));
  });

  if (tRexAnimes.length > 0) {
    tRexAnimes.sort((a, b) => {
      const yearA = parseInt(normalizeAnimeYear(a.year) || '0', 10) || 0;
      const yearB = parseInt(normalizeAnimeYear(b.year) || '0', 10) || 0;
      if (yearA !== yearB) return yearB - yearA;

      const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (timeA > 0 && timeB > 0 && timeA !== timeB) return timeB - timeA;
      if (timeA > 0 && timeB === 0) return -1;
      if (timeB > 0 && timeA === 0) return 1;

      const updA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const updB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      if (updA > 0 && updB > 0 && updA !== updB) return updB - updA;

      return (a.id || '').localeCompare(b.id || '');
    });

    slot1TRexAnime = tRexAnimes[0] || null;
    if (slot1TRexAnime) {
      selectedIds.add(slot1TRexAnime.id);
    }
  }

  // 4. POSICIÓN #4 (Reservada anticipadamente): El penúltimo anime con nuevos episodios (ep.isNew === true)
  let slot4PenultimateNewEpAnime: Anime | null = null;
  const allNewEpisodesAnimes = visibleAnimes
    .filter((a) => (a.episodes || []).some((ep) => Boolean(ep.isNew)))
    .sort((a, b) => {
      const infoA = getActiveNewEpisodeSortInfo(a);
      const infoB = getActiveNewEpisodeSortInfo(b);
      if (infoB.maxTime !== infoA.maxTime) return infoB.maxTime - infoA.maxTime;
      if (infoB.maxEpNum !== infoA.maxEpNum) return infoB.maxEpNum - infoA.maxEpNum;
      return 0;
    });

  if (allNewEpisodesAnimes.length >= 2) {
    if (!selectedIds.has(allNewEpisodesAnimes[1].id)) {
      slot4PenultimateNewEpAnime = allNewEpisodesAnimes[1];
    } else {
      const availableNewEpAnimes = allNewEpisodesAnimes.filter((a) => !selectedIds.has(a.id));
      slot4PenultimateNewEpAnime = availableNewEpAnimes[1] || availableNewEpAnimes[0] || null;
    }
  } else if (allNewEpisodesAnimes.length === 1 && !selectedIds.has(allNewEpisodesAnimes[0].id)) {
    slot4PenultimateNewEpAnime = allNewEpisodesAnimes[0];
  }

  if (slot4PenultimateNewEpAnime) {
    selectedIds.add(slot4PenultimateNewEpAnime.id);
  }

  // ============================================================================
  // PASO B: Verificar si existe un bloqueo de ciclo de 24 horas activo (< 24h).
  // Si el bloqueo está vigente, se respetan estrictamente los animes elegidos
  // para las Posiciones #2, #3 y #5 sin que cambien antes de las 24 horas.
  // ============================================================================
  const now = Date.now();
  const currentLock = (activeCycleLock && isValidCycleLock(activeCycleLock, now))
    ? activeCycleLock
    : loadCachedCycleLock();

  const dailySeed = getDailySeed(currentLock ? currentLock.cycleStartTime : now);
  const recentViewsMap = getRecentViewsMap();

  const getStrictPopularityScore = (anime: Anime): number => {
    const downloads = anime.downloads || 0;
    const recentViews = recentViewsMap[anime.id] || 0;
    return downloads + recentViews * 25;
  };

  const pickBestRatedAnime = (): Anime | null => {
    const candidateAnimesForRating = visibleAnimes.filter((a) => !selectedIds.has(a.id));
    if (candidateAnimesForRating.length === 0) return null;

    const ratedInLast24h = candidateAnimesForRating.filter((a) => {
      const r24 = getAnimeRecent24hRatingStats(a.id);
      return r24.recentVotesCount > 0 && r24.recentAverage > 0;
    });

    if (ratedInLast24h.length > 0) {
      ratedInLast24h.sort((a, b) => {
        const r24A = getAnimeRecent24hRatingStats(a.id);
        const r24B = getAnimeRecent24hRatingStats(b.id);
        if (r24B.recentAverage !== r24A.recentAverage) {
          return r24B.recentAverage - r24A.recentAverage;
        }
        if (r24B.recentVotesCount !== r24A.recentVotesCount) {
          return r24B.recentVotesCount - r24A.recentVotesCount;
        }
        const overallA = getAnimeRatingStats(a.id);
        const overallB = getAnimeRatingStats(b.id);
        if (overallB.average !== overallA.average) {
          return overallB.average - overallA.average;
        }
        if (r24B.latestTimestamp !== r24A.latestTimestamp) {
          return r24B.latestTimestamp - r24A.latestTimestamp;
        }
        return (a.id || '').localeCompare(b.id || '');
      });
      return ratedInLast24h[0] || null;
    }

    candidateAnimesForRating.sort((a, b) => {
      const statsA = getAnimeRatingStats(a.id);
      const statsB = getAnimeRatingStats(b.id);
      const hasVotesA = statsA.totalVotes > 0 && statsA.average > 0;
      const hasVotesB = statsB.totalVotes > 0 && statsB.average > 0;
      if (hasVotesA !== hasVotesB) return hasVotesA ? -1 : 1;
      if (statsB.average !== statsA.average) return statsB.average - statsA.average;
      if (statsB.totalVotes !== statsA.totalVotes) return statsB.totalVotes - statsA.totalVotes;
      const dlA = a.downloads || 0;
      const dlB = b.downloads || 0;
      if (dlB !== dlA) return dlB - dlA;
      return (a.id || '').localeCompare(b.id || '');
    });

    return candidateAnimesForRating[0] || null;
  };

  const pickMostPopularAnime = (): Anime | null => {
    const popularCandidates = visibleAnimes.filter((a) => !selectedIds.has(a.id));
    if (popularCandidates.length === 0) return null;

    popularCandidates.sort((a, b) => {
      const scoreA = getStrictPopularityScore(a);
      const scoreB = getStrictPopularityScore(b);
      if (scoreB !== scoreA) return scoreB - scoreA;
      const viewsA = recentViewsMap[a.id] || 0;
      const viewsB = recentViewsMap[b.id] || 0;
      if (viewsB !== viewsA) return viewsB - viewsA;
      const dlA = a.downloads || 0;
      const dlB = b.downloads || 0;
      if (dlB !== dlA) return dlB - dlA;
      const wA = getDailyRotationWeight(a.id, dailySeed, 'popular_tiebreak');
      const wB = getDailyRotationWeight(b.id, dailySeed, 'popular_tiebreak');
      if (wA !== wB) return wA - wB;
      return (a.id || '').localeCompare(b.id || '');
    });

    return popularCandidates[0] || null;
  };

  const pickDailyEmisionAnime = (): Anime | null => {
    const emisionCandidates = visibleAnimes.filter((a) => {
      if (selectedIds.has(a.id)) return false;
      const st = (a.status || '').trim().toLowerCase();
      return st.includes('emisi') || st.includes('emisión');
    });
    if (emisionCandidates.length === 0) return null;

    return (
      [...emisionCandidates].sort((a, b) => {
        const wA = getDailyRotationWeight(a.id, dailySeed, 'emision_featured');
        const wB = getDailyRotationWeight(b.id, dailySeed, 'emision_featured');
        if (wA !== wB) return wA - wB;
        return (a.id || '').localeCompare(b.id || '');
      })[0] || null
    );
  };

  const pickMostSavedMyListAnime = (): Anime | null => {
    const myListCandidates = visibleAnimes.filter((a) => !selectedIds.has(a.id));
    if (myListCandidates.length === 0) return null;

    const candidatesWithSaves = myListCandidates.filter((a) => getAnimeMyListSaveCount(a.id) > 0);
    if (candidatesWithSaves.length > 0) {
      candidatesWithSaves.sort((a, b) => {
        const savesA = getAnimeMyListSaveCount(a.id);
        const savesB = getAnimeMyListSaveCount(b.id);
        if (savesB !== savesA) return savesB - savesA;
        const scoreA = getStrictPopularityScore(a);
        const scoreB = getStrictPopularityScore(b);
        if (scoreB !== scoreA) return scoreB - scoreA;
        return (a.id || '').localeCompare(b.id || '');
      });
      return candidatesWithSaves[0] || null;
    }

    const sortedFavoritesFallback = [...myListCandidates].sort((a, b) => {
      const scoreA = getStrictPopularityScore(a);
      const scoreB = getStrictPopularityScore(b);
      if (scoreB !== scoreA) return scoreB - scoreA;
      return (a.id || '').localeCompare(b.id || '');
    });
    const pool = sortedFavoritesFallback.slice(0, Math.min(8, sortedFavoritesFallback.length));
    return (
      [...pool].sort((a, b) => {
        const wA = getDailyRotationWeight(a.id, dailySeed, 'mylist_fallback');
        const wB = getDailyRotationWeight(b.id, dailySeed, 'mylist_fallback');
        if (wA !== wB) return wA - wB;
        return (a.id || '').localeCompare(b.id || '');
      })[0] || null
    );
  };

  let slot2MostPopular24h: Anime | null = null;
  let slot3BestRated24h: Anime | null = null;
  let slot5FifthFeaturedAnime: Anime | null = null;

  if (currentLock && isValidCycleLock(currentLock, now)) {
    // Usar los animes bloqueados durante este ciclo de 24 horas
    const locked2 = visibleById.get(currentLock.slot2MostPopularId);
    if (locked2 && !selectedIds.has(locked2.id)) {
      slot2MostPopular24h = locked2;
      selectedIds.add(locked2.id);
    }

    const locked3 = visibleById.get(currentLock.slot3BestRatedId);
    if (locked3 && !selectedIds.has(locked3.id)) {
      slot3BestRated24h = locked3;
      selectedIds.add(locked3.id);
    }

    const locked5 = visibleById.get(currentLock.slot5FeaturedId);
    if (locked5 && !selectedIds.has(locked5.id)) {
      slot5FifthFeaturedAnime = locked5;
      selectedIds.add(locked5.id);
    }

    // Solo rellenar si alguno de los animes bloqueados fue eliminado/ocultado o pasó a ser #1/#4
    if (!slot3BestRated24h) {
      slot3BestRated24h = pickBestRatedAnime();
      if (slot3BestRated24h) selectedIds.add(slot3BestRated24h.id);
    }
    if (!slot2MostPopular24h) {
      slot2MostPopular24h = pickMostPopularAnime();
      if (slot2MostPopular24h) selectedIds.add(slot2MostPopular24h.id);
    }
    if (!slot5FifthFeaturedAnime) {
      slot5FifthFeaturedAnime =
        currentLock.slot5Mode === 'emision'
          ? (pickDailyEmisionAnime() || pickMostSavedMyListAnime())
          : (pickMostSavedMyListAnime() || pickDailyEmisionAnime());
      if (slot5FifthFeaturedAnime) selectedIds.add(slot5FifthFeaturedAnime.id);
    }
  } else {
    // Ha concluido el periodo de 24 horas (o no existía bloqueo): calcular nuevos ganadores y fijarlos por 24 horas
    const anyAnimeHasRatings = visibleAnimes.some((a) => {
      if (selectedIds.has(a.id)) return false;
      const st = getAnimeRatingStats(a.id);
      return st.totalVotes > 0 && st.average > 0;
    });

    if (anyAnimeHasRatings) {
      slot3BestRated24h = pickBestRatedAnime();
      if (slot3BestRated24h) selectedIds.add(slot3BestRated24h.id);
      slot2MostPopular24h = pickMostPopularAnime();
      if (slot2MostPopular24h) selectedIds.add(slot2MostPopular24h.id);
    } else {
      slot2MostPopular24h = pickMostPopularAnime();
      if (slot2MostPopular24h) selectedIds.add(slot2MostPopular24h.id);
      slot3BestRated24h = pickBestRatedAnime();
      if (slot3BestRated24h) selectedIds.add(slot3BestRated24h.id);
    }

    const prevMode = getPreviousCycleLockMode();
    const epochDayIndex = Math.floor(now / TWENTY_FOUR_HOURS_MS);
    const nextSlot5Mode: 'emision' | 'mylist' = prevMode
      ? (prevMode === 'emision' ? 'mylist' : 'emision')
      : (epochDayIndex % 2 === 0 ? 'emision' : 'mylist');

    slot5FifthFeaturedAnime =
      nextSlot5Mode === 'emision'
        ? (pickDailyEmisionAnime() || pickMostSavedMyListAnime())
        : (pickMostSavedMyListAnime() || pickDailyEmisionAnime());

    if (slot5FifthFeaturedAnime) {
      selectedIds.add(slot5FifthFeaturedAnime.id);
    }

    if (slot2MostPopular24h && slot3BestRated24h && slot5FifthFeaturedAnime) {
      const newLock: HeroCycleLockState = {
        cycleStartTime: now,
        slot2MostPopularId: slot2MostPopular24h.id,
        slot3BestRatedId: slot3BestRated24h.id,
        slot5FeaturedId: slot5FifthFeaturedAnime.id,
        slot5Mode: nextSlot5Mode,
      };
      // Guardar en localStorage inmediatamente y sincronizar con Firestore cuando ya respondió el estado remoto
      saveCachedCycleLock(newLock, remoteLockResolved);
    }
  }

  // Ensamblar resultado en el orden estricto 1° → 2° → 3° → 4° → 5°
  const orderedSlots = [
    slot1TRexAnime,
    slot2MostPopular24h,
    slot3BestRated24h,
    slot4PenultimateNewEpAnime,
    slot5FifthFeaturedAnime,
  ];

  return orderedSlots.filter((item): item is Anime => Boolean(item));
}

const TOP10_DAILY_LOCK_KEY = 'kh_top10_daily_lock_v1';

interface Top10DailyLock {
  daySeed: number;
  animeIds: string[];
}

/**
 * Calcula el Top 10 diario estilo Netflix:
 * - Se actualiza automáticamente cada 24 horas (fijado durante el día para que no salte en cada clic).
 * - Combina el Puntaje Híbrido Inteligente (calificación promedio + volumen de votos + descargas)
 *   con la tendencia/actividad de las últimas 24 horas (vistas recientes, votos del día y guardados en Mi Lista)
 *   y un factor de rotación diaria entre los candidatos principales para que el ranking tenga movimiento real día a día.
 */
export function computeDailyTop10Animes(animes: Anime[]): Anime[] {
  const visible = animes.filter((a) => {
    if (a.hidden) return false;
    const st = (a.status || '').trim().toLowerCase();
    if (st === 'próximamente' || st === 'proximamente' || st.includes('próximamente') || st.includes('proximamente')) {
      return false;
    }
    return true;
  });
  if (visible.length === 0) return [];

  const visibleById = new Map<string, Anime>();
  for (const a of visible) {
    visibleById.set(a.id, a);
  }

  const todaySeed = getDailySeed();

  // Verificar si ya existe el corte oficial del Top 10 de hoy (bloqueo de 24h estilo Netflix)
  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(TOP10_DAILY_LOCK_KEY);
      if (raw) {
        const parsed: Top10DailyLock = JSON.parse(raw);
        if (
          parsed &&
          parsed.daySeed === todaySeed &&
          Array.isArray(parsed.animeIds) &&
          parsed.animeIds.length > 0
        ) {
          const resolved = parsed.animeIds
            .map((id) => visibleById.get(id))
            .filter((a): a is Anime => Boolean(a));
          if (resolved.length >= Math.min(10, visible.length)) {
            return resolved.slice(0, 10);
          }
        }
      }
    } catch {}
  }

  const recentViewsMap = getRecentViewsMap();

  const scored = visible.map((anime) => {
    const downloads = Math.max(0, Number(anime.downloads) || 0);
    const stats = getAnimeRatingStats(anime.id);
    const avg = stats.average || 0;
    const votes = stats.totalVotes || 0;

    const views24h = recentViewsMap[anime.id] || 0;
    const rating24h = getAnimeRecent24hRatingStats(anime.id);
    const savesCount = getAnimeMyListSaveCount(anime.id);

    // 1. Impulso de tendencia en las últimas 24 horas (estilo Netflix)
    const momentum24hScore =
      views24h * 45 +
      rating24h.recentVotesCount * 25 +
      rating24h.recentAverage * 18 +
      savesCount * 14;

    // 2. Puntaje Híbrido Inteligente base (escala logarítmica en descargas para permitir que animes en tendencia suban de puesto)
    const popularityBase = Math.log1p(downloads) * 28 + Math.min(downloads, 150) * 0.7;
    const qualityBase = avg * 18 + avg * Math.log1p(votes) * 24 + votes * 5;

    // 3. Dinamismo diario determinista (0..38 pts) para que entre los más fuertes haya evolución de posiciones cada 24h
    const dailyVariation = (getDailyRotationWeight(anime.id, todaySeed, 'netflix_top10') % 3800) / 100;

    const totalScore = momentum24hScore + popularityBase + qualityBase + dailyVariation;

    return {
      anime,
      totalScore,
      views24h,
      avg,
      downloads,
    };
  });

  scored.sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    if (b.views24h !== a.views24h) return b.views24h - a.views24h;
    if (b.avg !== a.avg) return b.avg - a.avg;
    return b.downloads - a.downloads;
  });

  const top10 = scored.slice(0, 10).map((item) => item.anime);

  if (typeof window !== 'undefined' && top10.length > 0) {
    try {
      const lockData: Top10DailyLock = {
        daySeed: todaySeed,
        animeIds: top10.map((a) => a.id),
      };
      localStorage.setItem(TOP10_DAILY_LOCK_KEY, JSON.stringify(lockData));
    } catch {}
  }

  return top10;
}
