/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Studio {
  id: string;
  name: string;
  image?: string;
  order?: number;
  orderIndex?: number;
  storageLocation?: string;
}

export interface Genre {
  id: string;
  name: string;
  image?: string;
  order?: number;
  orderIndex?: number;
  storageLocation?: string;
}

export interface Episode {
  number: number;
  mp4Url: string;
  title?: string;
  name?: string;
  isNew?: boolean;
  coverImage?: string; // Portada del episodio para Nuevos Episodios (presentación en la página principal)
  thumbnail?: string; // Miniatura del episodio (permanente, se muestra al entrar al anime)
  addedToRecentAt?: string; // Timestamp de adición a la sección de episodios recientes
  orderIndex?: number;
}

export interface Anime {
  id: string;
  name: string;
  image: string; // Base64 or URL
  coverData?: string; // Permanent base64 WebP image fallback
  coverUrl?: string; // External URL for cover image (Cloudinary, etc.)
  studioId?: string;
  studioIds?: string[];
  genreIds: string[];
  status: 'Emisión' | 'Finalizado' | 'Próximamente' | string;
  year?: string;
  releaseMonth?: string;
  description: string;
  telegramUrl: string;
  episodes?: Episode[];
  isSingleEpisode?: boolean;
  continuationType?: 'Spin-off' | 'Secuelas' | 'Secuela' | 'Cronología' | string;
  continuationAnimeIds?: string[];
  hidden: boolean;
  downloads?: number;
  order?: number;
  orderIndex?: number;
  createdAt?: string;
  updatedAt?: string;
  storageLocation?: string;
  savedInFirestore?: boolean;
  firestoreError?: string;
}

export interface DatabaseSchema {
  studios: Studio[];
  genres: Genre[];
  animes: Anime[];
  userLists?: Record<string, string[]>;
  continuations?: any[];
  animeRatings?: Record<string, any>;
  userAnimeVotes?: Record<string, any>;
  comments?: any[];
  trash?: string[];
}

export interface UserListResponse {
  deviceId: string;
  animeIds: string[];
}

export interface AuthResponse {
  success: boolean;
  token?: string;
  message?: string;
}

export function getNormalizedKey(name: string): string {
  if (!name) return '';
  let str = name.trim().toLowerCase();
  // Strip diacritics / accents
  str = str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Normalize extra whitespace
  str = str.replace(/\s+/g, ' ');

  // Spanish plural reduction rules
  if (str.endsWith('es') && str.length > 4) {
    const base = str.slice(0, -2);
    if (/[r|l|n|d|z]$/.test(base)) {
      return base;
    }
    return str.slice(0, -1);
  } else if (str.endsWith('s') && str.length > 3 && !str.endsWith('ss')) {
    return str.slice(0, -1);
  }

  return str;
}

export function normalizeAnimeYear(year: string | number | undefined | null): string {
  if (year === undefined || year === null) return '';
  const yStr = String(year).trim();
  if (!yStr) return '';
  // 4 digits: keep as is
  if (/^\d{4}$/.test(yStr)) {
    return yStr;
  }
  // 1 digit: pad to 200X (e.g. 6 -> 2006, 1 -> 2001)
  if (/^\d{1}$/.test(yStr)) {
    return `200${yStr}`;
  }
  // 2 digits: pad to 20XX (e.g. 26 -> 2026, 12 -> 2012)
  if (/^\d{2}$/.test(yStr)) {
    return `20${yStr}`;
  }
  return yStr;
}

export function sortAnimesByYearAsc(list: Anime[]): Anime[] {
  return [...list].sort((a, b) => {
    const normA = normalizeAnimeYear(a.year);
    const normB = normalizeAnimeYear(b.year);
    const yA = normA && /^\d+$/.test(normA) ? parseInt(normA, 10) : 999999;
    const yB = normB && /^\d+$/.test(normB) ? parseInt(normB, 10) : 999999;
    if (yA !== yB) return yA - yB;
    const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (timeA !== timeB && !isNaN(timeA) && !isNaN(timeB)) return timeA - timeB;
    return (a.name || '').localeCompare(b.name || '');
  });
}

export function formatContinuationTitle(type: string | undefined | null, count: number): string {
  const clean = String(type || '').trim().toLowerCase();
  if (clean === 'spin-off' || clean === 'spinoff' || clean === 'spin off') {
    return 'Spin-off';
  }
  return count === 1 ? 'Secuela' : 'Secuelas';
}

export function resolveContinuationGroup(
  currentAnime: Anime | undefined | null,
  allAnimes: Anime[]
): { type: string; linkedAnimes: Anime[]; allGroupIds: string[] } {
  if (!currentAnime) return { type: '', linkedAnimes: [], allGroupIds: [] };
  const map = new Map<string, Anime>();
  for (const a of allAnimes) {
    if (a && a.id) map.set(a.id, a);
  }
  if (currentAnime.id) {
    map.set(currentAnime.id, currentAnime);
  }

  const visited = new Set<string>();
  const queue: string[] = [];
  if (currentAnime.id) {
    visited.add(currentAnime.id);
    queue.push(currentAnime.id);
  }
  if (Array.isArray(currentAnime.continuationAnimeIds)) {
    for (const id of currentAnime.continuationAnimeIds) {
      if (id && !visited.has(id)) {
        visited.add(id);
        queue.push(id);
      }
    }
  }

  let groupType = currentAnime.continuationType || '';

  while (queue.length > 0) {
    const currId = queue.shift()!;
    const currObj = map.get(currId);
    if (currObj) {
      if (!groupType && currObj.continuationType) {
        groupType = currObj.continuationType;
      }
      if (Array.isArray(currObj.continuationAnimeIds)) {
        for (const nextId of currObj.continuationAnimeIds) {
          if (nextId && !visited.has(nextId)) {
            visited.add(nextId);
            queue.push(nextId);
          }
        }
      }
    }
    // Also check inverse links from any anime in allAnimes referencing currId
    for (const other of allAnimes) {
      if (
        other &&
        other.id &&
        !visited.has(other.id) &&
        Array.isArray(other.continuationAnimeIds) &&
        other.continuationAnimeIds.includes(currId)
      ) {
        visited.add(other.id);
        queue.push(other.id);
        if (!groupType && other.continuationType) {
          groupType = other.continuationType;
        }
      }
    }
  }

  const allGroupIds = Array.from(visited);
  if (allGroupIds.length <= 1 && (!currentAnime.continuationAnimeIds || currentAnime.continuationAnimeIds.length === 0)) {
    return { type: '', linkedAnimes: [], allGroupIds: [] };
  }

  const linkedAnimes = sortAnimesByYearAsc(
    allGroupIds
      .filter(id => id !== currentAnime.id)
      .map(id => map.get(id))
      .filter((a): a is Anime => Boolean(a))
  );

  return {
    type: formatContinuationTitle(groupType, linkedAnimes.length),
    linkedAnimes,
    allGroupIds
  };
}

