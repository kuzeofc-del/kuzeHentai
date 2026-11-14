/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { db, doc, setDoc } from '../lib/firebase';
import { Anime, Episode } from '../types';
import { getEpisodeUrl } from './episodeUtils';

export interface RotationResult {
  evictedCount: number;
  evictedCoversCount: number;
  activeCount: number;
  updatedAnimes: Anime[];
}

/**
 * Removes any `undefined` properties and legacy duplicate URL fields from an Episode object
 * so Firebase Firestore stores solely `mp4Url` and never rejects the payload.
 */
export function sanitizeEpisodeForFirestore(ep: Episode): Episode {
  const LEGACY_URL_KEYS = new Set(['telegramUrl', 'url', 'videoUrl', 'link', 'embedUrl', 'streamUrl']);
  const clean: Record<string, any> = {};
  Object.entries(ep).forEach(([key, val]) => {
    if (val !== undefined && !LEGACY_URL_KEYS.has(key)) {
      clean[key] = val;
    }
  });
  clean.mp4Url = getEpisodeUrl(ep);
  return clean as Episode;
}

/**
 * Enforces the maximum limit (default 30) of active episodes (`isNew: true`) in the
 * "Últimos episodios" section. Works both in local environments and static deployments
 * like Vercel by persisting changes directly to Firebase Firestore.
 */
export async function enforceEpisodesRotation(
  animes: Anime[],
  maxNew: number = 30
): Promise<RotationResult> {
  // 1. Try backend endpoint first if available (local/server runtime)
  try {
    const res = await fetch('/api/admin/episodes/enforce-cap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => null);

    const contentType = res?.headers?.get('content-type') || '';
    if (res && res.ok && contentType.includes('application/json')) {
      const data = await res.json().catch(() => null);
      if (data && typeof data.evictedCount === 'number') {
        // Also run local pass on the passed animes array so client state stays in sync immediately
        const clientPass = await enforceEpisodesRotationInFirestore(animes, maxNew);
        return {
          evictedCount: Math.max(data.evictedCount || 0, clientPass.evictedCount),
          evictedCoversCount: Math.max(data.evictedCoversCount || 0, clientPass.evictedCoversCount),
          activeCount: clientPass.activeCount,
          updatedAnimes: clientPass.updatedAnimes,
        };
      }
    }
  } catch {
    // Fall through to direct Firestore execution (Vercel / static hosting)
  }

  // 2. Direct client + Firebase Firestore execution (works on Vercel)
  return enforceEpisodesRotationInFirestore(animes, maxNew);
}

export async function enforceEpisodesRotationInFirestore(
  animes: Anime[],
  maxNew: number = 30
): Promise<RotationResult> {
  if (!Array.isArray(animes) || animes.length === 0) {
    return { evictedCount: 0, evictedCoversCount: 0, activeCount: 0, updatedAnimes: [] };
  }

  const activeNewEpisodes: {
    animeId: string;
    epNumber: number;
    timestamp: number;
  }[] = [];

  for (const anime of animes) {
    if (!Array.isArray(anime.episodes)) continue;
    const baseTime = anime.createdAt
      ? new Date(anime.createdAt).getTime()
      : anime.updatedAt
      ? new Date(anime.updatedAt).getTime()
      : 0;

    for (const ep of anime.episodes) {
      if (ep && ep.isNew) {
        const epNum = Number(ep.number) || 1;
        const parsedTime = ep.addedToRecentAt
          ? new Date(ep.addedToRecentAt).getTime()
          : baseTime + epNum * 1000;
        const epTimestamp = Number.isNaN(parsedTime) ? baseTime + epNum * 1000 : parsedTime;

        activeNewEpisodes.push({
          animeId: anime.id,
          epNumber: epNum,
          timestamp: epTimestamp,
        });
      }
    }
  }

  // Sort newest first; tie-breaker: higher episode number first
  activeNewEpisodes.sort((a, b) => {
    if (b.timestamp !== a.timestamp) {
      return b.timestamp - a.timestamp;
    }
    return (b.epNumber || 0) - (a.epNumber || 0);
  });

  if (activeNewEpisodes.length <= maxNew) {
    return {
      evictedCount: 0,
      evictedCoversCount: 0,
      activeCount: activeNewEpisodes.length,
      updatedAnimes: [],
    };
  }

  const toEvict = activeNewEpisodes.slice(maxNew);
  const evictMap = new Map<string, Set<number>>();
  for (const item of toEvict) {
    if (!evictMap.has(item.animeId)) {
      evictMap.set(item.animeId, new Set());
    }
    evictMap.get(item.animeId)!.add(item.epNumber);
  }

  let evictedCount = 0;
  let evictedCoversCount = 0;
  const updatedAnimes: Anime[] = [];

  for (const anime of animes) {
    const epNumbersToEvict = evictMap.get(anime.id);
    if (!epNumbersToEvict || !Array.isArray(anime.episodes)) continue;

    const nextEpisodes: Episode[] = anime.episodes.map((ep) => {
      const epNum = Number(ep.number) || 1;
      if (!epNumbersToEvict.has(epNum) || !ep.isNew) {
        return sanitizeEpisodeForFirestore(ep);
      }

      const cloned: Record<string, any> = { ...ep };
      cloned.isNew = false;
      delete cloned.addedToRecentAt;

      if (cloned.coverImage) {
        // Keep thumbnail intact so the episode inside the anime page keeps its preview image
        if (!cloned.thumbnail) {
          cloned.thumbnail = cloned.coverImage;
        }
        delete cloned.coverImage;
        evictedCoversCount++;
      }

      evictedCount++;
      return sanitizeEpisodeForFirestore(cloned as Episode);
    });

    const updatedAnime: Anime = {
      ...anime,
      episodes: nextEpisodes,
      updatedAt: new Date().toISOString(),
    };

    updatedAnimes.push(updatedAnime);
  }

  // Persist all modified animes to Firebase Firestore
  if (db && updatedAnimes.length > 0) {
    await Promise.all(
      updatedAnimes.map((modAnime) =>
        setDoc(
          doc(db, 'animes', modAnime.id),
          {
            episodes: modAnime.episodes,
            updatedAt: modAnime.updatedAt,
          },
          { merge: true }
        )
      )
    );
  }

  return {
    evictedCount,
    evictedCoversCount,
    activeCount: Math.min(maxNew, activeNewEpisodes.length),
    updatedAnimes,
  };
}
