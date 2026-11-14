/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Anime } from '../types';
import { getAnimeRatingStats } from './ratingManager';

// 1 week (7 days) in milliseconds for selecting a new set of 15 animes
export const ROTATION_PERIOD_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// 24 hours (1 day) in milliseconds for changing positions daily
export const ROTATION_PERIOD_DAY_MS = 24 * 60 * 60 * 1000;
// Keep backwards-compatible export alias if needed
export const ROTATION_PERIOD_48H_MS = ROTATION_PERIOD_DAY_MS;
export const RECOMMENDED_COUNT = 3;

/**
 * Returns the current 7-day (1 week) cycle index.
 */
export function getWeeklyCycleIndex(): number {
  return Math.floor(Date.now() / ROTATION_PERIOD_WEEK_MS);
}

/**
 * Returns the current 24-hour (1 day) cycle index for daily position changes.
 */
export function getDailyCycleIndex(): number {
  return Math.floor(Date.now() / ROTATION_PERIOD_DAY_MS);
}

/**
 * Backwards-compatible alias.
 */
export function get48HourCycleIndex(): number {
  return getDailyCycleIndex();
}

/**
 * Generates a stable positive numeric hash from a string.
 */
function hashString(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

/**
 * Deterministically reorders animes every day (24h)
 */
function reorderAnimesForDay(
  weeklyAnimes: Anime[],
  userKey: string,
  weeklyCycleIndex: number,
  dailyCycleIndex: number
): Anime[] {
  if (weeklyAnimes.length <= 1) return weeklyAnimes;

  const dayOffsetInWeek = ((dailyCycleIndex % 7) + 7) % 7;
  const list = [...weeklyAnimes];
  const n = list.length;

  let seed = hashString(`${userKey}_w_${weeklyCycleIndex}_d_${dailyCycleIndex}`) || 1;
  const nextRand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const shift = (dayOffsetInWeek * 2 + 1) % n;
  const shifted = list.map((_, idx) => list[(idx + shift) % n]);

  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(nextRand() * (i + 1));
    const temp = shifted[i];
    shifted[i] = shifted[j];
    shifted[j] = temp;
  }

  return shifted;
}

/**
 * Computes 3 recommended animes personalized to each user's tastes, changing every 24 hours.
 */
export function getRecommendedAnimes(
  animes: Anime[],
  myListIds: string[] = [],
  watchedIds: string[] = [],
  userId?: string | null
): Anime[] {
  const watchedSet = new Set(watchedIds || []);
  const visibleAnimes = animes.filter((a) => {
    if (a.hidden || watchedSet.has(a.id)) return false;
    const st = (a.status || '').trim().toLowerCase();
    if (st === 'próximamente' || st === 'proximamente' || st.includes('próximamente') || st.includes('proximamente')) {
      return false;
    }
    return true;
  });
  if (visibleAnimes.length === 0) return [];

  const userKey = userId ? `user_${userId}` : 'guest';
  const dailyCycleIndex = getDailyCycleIndex();
  const tasteSignature = `${[...(myListIds || [])].sort().join(',')}|${[...(watchedIds || [])].sort().join(',')}`;
  const storageKey = `kh_rec_daily_v4_${userKey}`;

  if (visibleAnimes.length <= RECOMMENDED_COUNT) {
    return reorderAnimesForDay(visibleAnimes, userKey, 0, dailyCycleIndex);
  }

  const visibleMap = new Map<string, Anime>();
  visibleAnimes.forEach((a) => visibleMap.set(a.id, a));

  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.dailyCycleIndex === dailyCycleIndex && parsed.tasteSignature === tasteSignature && Array.isArray(parsed.ids)) {
          const lockedAnimes = parsed.ids
            .map((id: string) => visibleMap.get(id))
            .filter((a: Anime | undefined): a is Anime => Boolean(a));
          if (lockedAnimes.length === RECOMMENDED_COUNT) {
            return lockedAnimes;
          }
        }
      }
    } catch {}
  }

  // 1. Analyze user favorite genres and studios
  const myListSet = new Set(myListIds);
  const genreFrequency: Record<string, number> = {};
  const studioFrequency: Record<string, number> = {};

  animes.forEach((a) => {
    const isSaved = myListSet.has(a.id);
    const isWatched = watchedSet.has(a.id);
    if (!isSaved && !isWatched) return;

    const weight = isSaved ? 5 : 3;
    (a.genreIds || []).forEach((gid) => {
      genreFrequency[gid] = (genreFrequency[gid] || 0) + weight;
    });

    const sIds = (a.studioIds && a.studioIds.length > 0)
      ? a.studioIds
      : (a.studioId ? [a.studioId] : []);
    sIds.forEach((sid) => {
      studioFrequency[sid] = (studioFrequency[sid] || 0) + weight;
    });
  });

  const hasSpecificTastes =
    Object.keys(genreFrequency).length > 0 || Object.keys(studioFrequency).length > 0;

  // 2. Score candidates
  const scoredAnimes = visibleAnimes.map((a) => {
    let genreScore = 0;
    (a.genreIds || []).forEach((gid) => {
      genreScore += genreFrequency[gid] || 0;
    });

    let studioScore = 0;
    const sIds = (a.studioIds && a.studioIds.length > 0)
      ? a.studioIds
      : (a.studioId ? [a.studioId] : []);
    sIds.forEach((sid) => {
      studioScore += studioFrequency[sid] || 0;
    });

    const ratingStats = getAnimeRatingStats(a.id);
    const ratingScore = ratingStats.average > 0 ? ratingStats.average * 10 : 25;
    const downloadNorm = Math.log10(Math.max(1, a.downloads || 0)) * 12;
    const epScore = (a.episodes || []).length > 0 ? 15 : 0;
    const tasteBonus = hasSpecificTastes ? (genreScore * 30 + studioScore * 15) : 0;

    const totalScore = tasteBonus + ratingScore + downloadNorm + epScore;

    return {
      anime: a,
      totalScore,
    };
  });

  scoredAnimes.sort((a, b) => {
    if (Math.abs(b.totalScore - a.totalScore) > 0.001) {
      return b.totalScore - a.totalScore;
    }
    return String(a.anime.id).localeCompare(String(b.anime.id));
  });
  const candidates = scoredAnimes.map((s) => s.anime);

  const userSalt = hashString(userKey);
  const topPoolLimit = Math.min(candidates.length, RECOMMENDED_COUNT * 20);
  const topPool = candidates.slice(0, topPoolLimit);
  const numSlices = Math.max(1, Math.floor(topPool.length / RECOMMENDED_COUNT));
  const sliceIndex = (dailyCycleIndex + userSalt) % numSlices;

  // Distribución intercalada dentro del top personalizado para que cada día tenga 3 animes distintos de alta afinidad
  const dailySelection: Anime[] = [];
  for (let k = 0; k < RECOMMENDED_COUNT; k++) {
    const candidateIdx = sliceIndex + k * numSlices;
    if (topPool[candidateIdx]) {
      dailySelection.push(topPool[candidateIdx]);
    }
  }

  if (dailySelection.length < RECOMMENDED_COUNT) {
    for (const c of candidates) {
      if (dailySelection.length >= RECOMMENDED_COUNT) break;
      if (!dailySelection.some((d) => d.id === c.id)) {
        dailySelection.push(c);
      }
    }
  }

  const finalSelection = reorderAnimesForDay(dailySelection, userKey, 0, dailyCycleIndex);

  if (typeof window !== 'undefined' && finalSelection.length === RECOMMENDED_COUNT) {
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          dailyCycleIndex,
          tasteSignature,
          ids: finalSelection.map((a) => a.id),
        })
      );
    } catch {}
  }

  return finalSelection;
}
