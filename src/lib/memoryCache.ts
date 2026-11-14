/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Anime, Studio, Genre } from '../types';

// Strict in-memory RAM maps (purged automatically on page refresh F5)
const animeRAMCache = new Map<string, Anime>();
const studioRAMCache = new Map<string, Studio>();
const genreRAMCache = new Map<string, Genre>();
const ratingsRAMCache = new Map<string, any>();

// Flags to track if full collections were loaded in current browser session
let isFullCatalogLoadedInMemory = false;
let isFullStudiosLoadedInMemory = false;
let isFullGenresLoadedInMemory = false;

/**
 * Stores animes in RAM cache and updates existing references
 */
export function cacheAnimesInMemory(animes: Anime | Anime[]): void {
  const list = Array.isArray(animes) ? animes : [animes];
  list.forEach(item => {
    if (item && item.id) {
      const existing = animeRAMCache.get(item.id);
      animeRAMCache.set(item.id, { ...existing, ...item });
    }
  });
}

/**
 * Gets a single anime from RAM cache if present
 */
export function getAnimeFromMemory(id: string): Anime | undefined {
  return animeRAMCache.get(id);
}

/**
 * Gets multiple animes from RAM cache
 */
export function getAnimesFromMemory(ids: string[]): { found: Anime[]; missingIds: string[] } {
  const found: Anime[] = [];
  const missingIds: string[] = [];

  ids.forEach(id => {
    const item = animeRAMCache.get(id);
    if (item) {
      found.push(item);
    } else {
      missingIds.push(id);
    }
  });

  return { found, missingIds };
}

/**
 * Gets all animes currently cached in RAM
 */
export function getAllAnimesFromMemory(): Anime[] {
  return Array.from(animeRAMCache.values());
}

/**
 * Removes an anime from RAM cache (e.g. when deleted by admin)
 */
export function removeAnimeFromMemory(id: string): void {
  animeRAMCache.delete(id);
}

/**
 * Stores studios in RAM
 */
export function cacheStudiosInMemory(studios: Studio[]): void {
  studios.forEach(s => {
    if (s && s.id) {
      studioRAMCache.set(s.id, s);
    }
  });
}

export function getAllStudiosFromMemory(): Studio[] {
  return Array.from(studioRAMCache.values());
}

/**
 * Stores genres in RAM
 */
export function cacheGenresInMemory(genres: Genre[]): void {
  genres.forEach(g => {
    if (g && g.id) {
      genreRAMCache.set(g.id, g);
    }
  });
}

export function getAllGenresFromMemory(): Genre[] {
  return Array.from(genreRAMCache.values());
}

/**
 * Stores rating stats in RAM
 */
export function cacheRatingStatsInMemory(animeId: string, stats: any): void {
  if (animeId && stats) {
    ratingsRAMCache.set(animeId, stats);
  }
}

export function getRatingStatsFromMemory(animeId: string): any | undefined {
  return ratingsRAMCache.get(animeId);
}

// Flags management
export function setFullCatalogInMemoryLoaded(val: boolean = true) {
  isFullCatalogLoadedInMemory = val;
}

export function isFullCatalogInMemory(): boolean {
  return isFullCatalogLoadedInMemory;
}

export function setFullStudiosInMemoryLoaded(val: boolean = true) {
  isFullStudiosLoadedInMemory = val;
}

export function isFullStudiosInMemory(): boolean {
  return isFullStudiosLoadedInMemory;
}

export function setFullGenresInMemoryLoaded(val: boolean = true) {
  isFullGenresLoadedInMemory = val;
}

export function isFullGenresInMemory(): boolean {
  return isFullGenresLoadedInMemory;
}
