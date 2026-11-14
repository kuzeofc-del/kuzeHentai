/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import { Studio, Anime } from '../types';
import HorizontalSectionRow from './HorizontalSectionRow';
import { Building2 } from 'lucide-react';
import { getFallbackSvg, prefetchAnime } from '../utils/imageFallback';
import { getAnimeRatingStats } from '../utils/ratingManager';

interface DailyStudiosSectionProps {
  studios: Studio[];
  animes: Anime[];
  onSelectStudio: (studio: Studio) => void;
}

export default function DailyStudiosSection({
  studios,
  animes,
  onSelectStudio,
}: DailyStudiosSectionProps) {
  // Pre-calculate studio covers and filter valid studios sorted by popularity
  const studioItems = useMemo(() => {
    if (!studios || studios.length === 0) return [];

    // Map each studio with its animes to extract cover and popularity score
    return studios
      .filter((s) => Boolean(s && s.id && s.name))
      .map((studio) => {
        const studioAnimes = animes.filter((a) => {
          if (a.hidden) return false;
          const st = (a.status || '').trim().toLowerCase();
          if (st === 'próximamente' || st === 'proximamente' || st.includes('próximamente') || st.includes('proximamente')) {
            return false;
          }
          const sIds = a.studioIds && a.studioIds.length > 0
            ? a.studioIds
            : (a.studioId ? [a.studioId] : []);
          return sIds.includes(studio.id);
        });

        const cover = studio.image || studioAnimes[0]?.coverData || studioAnimes[0]?.image;

        let totalDownloads = 0;
        let totalVotes = 0;
        for (let i = 0; i < studioAnimes.length; i++) {
          const a = studioAnimes[i];
          totalDownloads += (a.downloads || 0);
          const r = getAnimeRatingStats(a.id);
          totalVotes += (r?.totalVotes || 0);
        }
        const popularityScore = totalDownloads + (totalVotes * 5) + (studioAnimes.length * 10);

        return {
          studio,
          cover,
          firstAnime: studioAnimes[0] || null,
          animeCount: studioAnimes.length,
          popularityScore,
        };
      })
      .sort((a, b) => {
        // Sort by popularity (higher activity / downloads / votes / count first)
        if (b.popularityScore !== a.popularityScore) {
          return b.popularityScore - a.popularityScore;
        }
        if (b.animeCount !== a.animeCount) {
          return b.animeCount - a.animeCount;
        }
        return a.studio.name.localeCompare(b.studio.name, 'es', { sensitivity: 'base' });
      });
  }, [studios, animes]);

  if (studioItems.length === 0) {
    return null;
  }

  return (
    <HorizontalSectionRow
      title="Studios"
      icon={<Building2 className="w-4 h-4 text-purple-400" />}
    >
      {studioItems.map(({ studio, cover, firstAnime }) => (
        <div
          key={`studio-circle-${studio.id}`}
          className="flex flex-col items-center shrink-0 cursor-pointer group select-none active:scale-95 transition-all w-[89px] xs:w-[99px] sm:w-[109px]"
          onClick={() => onSelectStudio(studio)}
          onMouseEnter={() => {
            if (firstAnime) prefetchAnime(firstAnime, studios);
          }}
          title={studio.name}
        >
          {/* Portada circular del estudio, limpia sin líneas de color alrededor */}
          <div className="w-[88px] h-[88px] xs:w-[98px] xs:h-[98px] sm:w-[108px] sm:h-[108px] rounded-full overflow-hidden shadow-lg shadow-black/70 shrink-0 flex items-center justify-center relative bg-purple-950/30 transition-all duration-300">
            {cover ? (
              <img
                src={cover}
                alt={studio.name}
                loading="lazy"
                decoding="async"
                className="w-full h-full object-cover rounded-full drop-shadow-[0_4px_12px_rgba(0,0,0,0.6)] transition-transform duration-300 group-hover:scale-110"
                onError={(e) => {
                  e.currentTarget.src = getFallbackSvg(studio.name);
                }}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center rounded-full bg-purple-950/40 text-purple-300">
                <Building2 className="w-7 h-7 sm:w-8 sm:h-8 opacity-70" />
              </div>
            )}
          </div>

          {/* Únicamente el nombre del estudio debajo, sin información redundante */}
          <p className="font-display font-medium text-xs sm:text-[13px] text-neutral-200 group-hover:text-purple-300 transition-colors text-center truncate w-full mt-2 px-1">
            {studio.name}
          </p>
        </div>
      ))}
    </HorizontalSectionRow>
  );
}
