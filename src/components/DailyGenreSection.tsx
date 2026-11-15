/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Studio, Genre, Anime } from '../types';
import HorizontalSectionRow from './HorizontalSectionRow';
import { SmartAnimeCover, prefetchAnime } from '../utils/imageFallback';
import { Layers } from 'lucide-react';
import { getAnimeRatingStats } from '../utils/ratingManager';

interface DailyGenreSectionProps {
  genres: Genre[];
  animes: Anime[];
  studios: Studio[];
  onSelectAnime: (animeId: string) => void;
  onSelectGenre: (genreId: string) => void;
}

/**
 * Generates a stable day seed based on the user's local calendar day (changes every 24 hours).
 */
function getDailySeed(): number {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  return year * 10000 + month * 100 + day;
}

/**
 * Deterministically picks a random anime for a genre that remains stable for 24 hours.
 * If a genre has few animes, it smoothly picks one and repeats when needed.
 */
function getDailyAnimeForGenre(genreId: string, genreAnimes: Anime[], daySeed: number): Anime | null {
  if (!genreAnimes || genreAnimes.length === 0) return null;
  if (genreAnimes.length === 1) return genreAnimes[0];

  let hash = 2166136261;
  const str = `${genreId}_seed_${daySeed}`;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  let t = (hash ^ (hash >>> 16)) >>> 0;
  t = Math.imul(t, 2246822507);
  t ^= t >>> 13;
  t = Math.imul(t, 3266489909);
  t ^= t >>> 16;
  const positiveNum = t >>> 0;

  return genreAnimes[positiveNum % genreAnimes.length];
}

export default function DailyGenreSection({
  genres,
  animes,
  studios,
  onSelectAnime,
  onSelectGenre,
}: DailyGenreSectionProps) {
  const [daySeed, setDaySeed] = useState<number>(() => getDailySeed());

  useEffect(() => {
    const interval = setInterval(() => {
      const nextSeed = getDailySeed();
      setDaySeed((prev) => (prev !== nextSeed ? nextSeed : prev));
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  // Compute 1 daily random anime for each genre sorted by popularity
  const dailyGenreItems = useMemo(() => {
    const visibleAnimes = animes.filter(a => {
      if (a.hidden) return false;
      const st = (a.status || '').trim().toLowerCase();
      if (st === 'próximamente' || st === 'proximamente' || st.includes('próximamente') || st.includes('proximamente')) {
        return false;
      }
      return true;
    });
    if (visibleAnimes.length === 0 || genres.length === 0) return [];

    const items: {
      genre: Genre;
      anime: Anime;
      popularityScore: number;
    }[] = [];

    // Map each genre with its animes and calculate its popularity score
    const genreEntries = genres.map((g) => {
      const matchingAnimes = visibleAnimes
        .filter(a => a.genreIds && a.genreIds.includes(g.id))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));

      let totalDownloads = 0;
      let totalVotes = 0;
      for (let i = 0; i < matchingAnimes.length; i++) {
        const a = matchingAnimes[i];
        totalDownloads += (a.downloads || 0);
        const r = getAnimeRatingStats(a.id);
        totalVotes += (r?.totalVotes || 0);
      }
      const popularityScore = totalDownloads + (totalVotes * 5) + (matchingAnimes.length * 10);

      return {
        genre: g,
        matchingAnimes,
        popularityScore,
        animeCount: matchingAnimes.length,
      };
    });

    // Sort genres by popularity (descending)
    genreEntries.sort((a, b) => {
      if (b.popularityScore !== a.popularityScore) {
        return b.popularityScore - a.popularityScore;
      }
      if (b.animeCount !== a.animeCount) {
        return b.animeCount - a.animeCount;
      }
      return a.genre.name.localeCompare(b.genre.name, 'es', { sensitivity: 'base' });
    });

    for (const entry of genreEntries) {
      if (entry.matchingAnimes.length > 0) {
        const picked = getDailyAnimeForGenre(entry.genre.id, entry.matchingAnimes, daySeed);
        if (picked) {
          items.push({
            genre: entry.genre,
            anime: picked,
            popularityScore: entry.popularityScore,
          });
        }
      }
    }

    return items;
  }, [genres, animes, daySeed]);

  if (dailyGenreItems.length === 0) {
    return null;
  }

  return (
    <HorizontalSectionRow
      title="Géneros"
      icon={<Layers className="w-4 h-4 text-purple-400" />}
    >
      {dailyGenreItems.map(({ genre, anime }, index) => {
        const sIds = (anime.studioIds && anime.studioIds.length > 0)
          ? anime.studioIds
          : (anime.studioId ? [anime.studioId] : []);
        const studioName = studios.find(s => sIds.includes(s.id))?.name || 'Estudio';
        const isFirstFew = index < 2;

        return (
          <div
            key={`genre-daily-${genre.id}`}
            className="w-[260px] xs:w-[290px] sm:w-[340px] md:w-[380px] aspect-[16/9] shrink-0 relative rounded-2xl overflow-hidden bg-[#0a0515] border border-[#2b1747] hover:border-purple-500/70 shadow-lg shadow-black/70 group cursor-pointer active:scale-[0.98] transition-all select-none"
            onClick={() => onSelectAnime(anime.id)}
            onMouseEnter={() => prefetchAnime(anime, studios)}
          >
            {/* Imagen de portada idéntica a Próximamente */}
            <SmartAnimeCover
              anime={anime}
              studioName={studioName}
              alt={`${genre.name} - ${anime.name}`}
              tamaño="horizontal"
              loading="lazy"
              priority={false}
              width={600}
              height={338}
              className="w-full h-full object-cover object-[center_25%]"
            />

            {/* Difuminado suave abajo en el título */}
            <div className="absolute inset-x-0 bottom-0 h-16 sm:h-20 bg-gradient-to-t from-[#090514]/95 via-[#090514]/70 to-transparent pointer-events-none" />

            {/* Solo la etiqueta del género */}
            <div className="absolute top-3 left-3 z-10">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectGenre(genre.id);
                }}
                className="px-2.5 py-1 rounded-lg bg-[#0d071a]/85 hover:bg-purple-950/95 backdrop-blur-md border border-purple-500/40 hover:border-purple-400 text-purple-200 hover:text-white text-[11px] sm:text-xs font-semibold tracking-wide shadow-md transition-all cursor-pointer active:scale-95"
                title={`Ver animes de ${genre.name}`}
              >
                {genre.name}
              </button>
            </div>

            {/* Solo el nombre del anime */}
            <div className="absolute inset-x-0 bottom-0 p-3 sm:p-4 z-10 pointer-events-none">
              <p className="font-display font-bold text-sm sm:text-base md:text-[17px] text-white tracking-tight leading-snug drop-shadow truncate group-hover:text-purple-300 transition-colors">
                {anime.name}
              </p>
            </div>
          </div>
        );
      })}
    </HorizontalSectionRow>
  );
}
