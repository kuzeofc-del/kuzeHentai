/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Anime, Genre, Studio, normalizeAnimeYear } from '../types';
import { 
  ArrowLeft, 
  Film, 
  Star, 
  MessageSquare, 
  Layers, 
  ChevronRight, 
  ChevronLeft,
  ArrowUpDown 
} from 'lucide-react';
import { getAnimeRatingStats } from '../utils/ratingManager';
import { getFallbackSvg, preloadAllAnimes, portadaUrl } from '../utils/imageFallback';
import GalleryCard from './GalleryCard';

export type GenreSortType = 'name-asc' | 'name-desc' | 'rating-desc' | 'rating-asc' | 'date-desc' | 'date-asc';

interface GenreDetailModalProps {
  key?: React.Key;
  genre: Genre;
  onClose: () => void;
  animes: Anime[];
  studios: Studio[];
  initialPage?: number;
  initialSortBy?: GenreSortType;
  initialScrollY?: number;
  onSelectAnime: (animeId: string, page: number, scrollY: number, sortBy: string) => void;
  onPageChange?: (page: number) => void;
  onSortChange?: (sort: GenreSortType) => void;
}

const ANIMES_PER_PAGE = 30;

export default function GenreDetailModal({
  genre,
  onClose,
  animes,
  studios,
  initialPage = 1,
  initialSortBy = 'name-asc',
  initialScrollY = 0,
  onSelectAnime,
  onPageChange,
  onSortChange,
}: GenreDetailModalProps) {
  const [sortBy, setSortBy] = useState<GenreSortType>(() => {
    if (initialSortBy) return initialSortBy;
    try {
      const stored = sessionStorage.getItem('kh_genre_sort_' + genre.id);
      if (stored) return stored as GenreSortType;
    } catch {}
    return 'name-asc';
  });

  const [currentPage, setCurrentPage] = useState<number>(() => {
    if (initialPage && initialPage >= 1) return initialPage;
    try {
      const stored = sessionStorage.getItem('kh_genre_page_' + genre.id);
      if (stored) {
        const p = parseInt(stored, 10);
        if (!isNaN(p) && p >= 1) return p;
      }
    } catch {}
    return 1;
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const catalogTopRef = useRef<HTMLDivElement>(null);

  // Sync initialPage when passed from props
  useEffect(() => {
    if (initialPage && initialPage >= 1 && initialPage !== currentPage) {
      setCurrentPage(initialPage);
    }
  }, [initialPage]);

  // Sync initialSortBy when passed from props
  useEffect(() => {
    if (initialSortBy && initialSortBy !== sortBy) {
      setSortBy(initialSortBy);
    }
  }, [initialSortBy]);

  // Filter all animes associated with this genre (excluding Próximamente until they pass to Emisión)
  const genreAnimes = useMemo(() => {
    return animes.filter((a) => {
      if (a.hidden) return false;
      const st = (a.status || '').trim().toLowerCase();
      if (st === 'próximamente' || st === 'proximamente' || st.includes('próximamente') || st.includes('proximamente')) {
        return false;
      }
      return a.genreIds && a.genreIds.includes(genre.id);
    });
  }, [genre, animes]);

  // Cache ratings and votes for genre animes in a single efficient pass
  const { totalVotes, ratingsCache, overallAverage } = useMemo(() => {
    const map = new Map<string, { average: number; totalVotes: number }>();
    let votesSum = 0;
    let weightedSum = 0;
    for (let i = 0; i < genreAnimes.length; i++) {
      const a = genreAnimes[i];
      const stats = getAnimeRatingStats(a.id);
      const avg = stats?.average || 0;
      const cnt = stats?.totalVotes || 0;
      map.set(a.id, { average: avg, totalVotes: cnt });
      votesSum += cnt;
      weightedSum += (avg * cnt);
    }
    return {
      totalVotes: votesSum,
      ratingsCache: map,
      overallAverage: votesSum > 0 ? (weightedSum / votesSum) : 0
    };
  }, [genreAnimes]);

  // Genre cover image: genre.image or first anime cover fallback
  const genreCover = genre.image || genreAnimes[0]?.coverData || genreAnimes[0]?.image;

  // Sort genre animes based on user selection
  const sortedGenreAnimes = useMemo(() => {
    const list = [...genreAnimes];
    return list.sort((a, b) => {
      if (sortBy === 'date-desc') {
        const yearA = parseInt(normalizeAnimeYear(a.year) || '0', 10) || 0;
        const yearB = parseInt(normalizeAnimeYear(b.year) || '0', 10) || 0;
        if (yearA !== yearB) return yearB - yearA;
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        if (timeA !== timeB) return timeB - timeA;
        return (b.id || '').localeCompare(a.id || '');
      }
      if (sortBy === 'date-asc') {
        const yearA = parseInt(normalizeAnimeYear(a.year) || '0', 10) || 0;
        const yearB = parseInt(normalizeAnimeYear(b.year) || '0', 10) || 0;
        if (yearA !== yearB) return yearA - yearB;
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        if (timeA !== timeB) return timeA - timeB;
        return (a.id || '').localeCompare(b.id || '');
      }
      if (sortBy === 'name-asc') {
        return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
      }
      if (sortBy === 'name-desc') {
        return b.name.localeCompare(a.name, 'es', { sensitivity: 'base' });
      }
      if (sortBy === 'rating-desc') {
        const rA = ratingsCache.get(a.id) || { average: 0, totalVotes: 0 };
        const rB = ratingsCache.get(b.id) || { average: 0, totalVotes: 0 };
        if (rB.average !== rA.average) return rB.average - rA.average;
        return rB.totalVotes - rA.totalVotes;
      }
      if (sortBy === 'rating-asc') {
        const rA = ratingsCache.get(a.id) || { average: 0, totalVotes: 0 };
        const rB = ratingsCache.get(b.id) || { average: 0, totalVotes: 0 };
        if (rA.average !== rB.average) return rA.average - rB.average;
        return rA.totalVotes - rB.totalVotes;
      }
      return 0;
    });
  }, [genreAnimes, sortBy, ratingsCache]);

  // Total pages calculation (30 animes per page)
  const totalPages = Math.ceil(sortedGenreAnimes.length / ANIMES_PER_PAGE) || 1;
  const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages);

  // Paginated subset of animes
  const paginatedAnimes = useMemo(() => {
    const startIndex = (safeCurrentPage - 1) * ANIMES_PER_PAGE;
    return sortedGenreAnimes.slice(startIndex, startIndex + ANIMES_PER_PAGE);
  }, [sortedGenreAnimes, safeCurrentPage]);

  // Scroll position restoration: immediate and staged
  useEffect(() => {
    const targetY = initialScrollY || 0;
    if (targetY > 0 && containerRef.current) {
      containerRef.current.scrollTop = targetY;
      const raf = requestAnimationFrame(() => {
        if (containerRef.current) {
          containerRef.current.scrollTop = targetY;
        }
      });
      const timer1 = setTimeout(() => {
        if (containerRef.current && Math.abs(containerRef.current.scrollTop - targetY) > 5) {
          containerRef.current.scrollTop = targetY;
        }
      }, 50);
      const timer2 = setTimeout(() => {
        if (containerRef.current && Math.abs(containerRef.current.scrollTop - targetY) > 5) {
          containerRef.current.scrollTop = targetY;
        }
      }, 150);

      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(timer1);
        clearTimeout(timer2);
      };
    }
  }, [initialScrollY, genre.id]);

  // Prioritize preloading genre anime covers gently after render
  useEffect(() => {
    if (paginatedAnimes.length > 0) {
      const timer = setTimeout(() => {
        preloadAllAnimes(paginatedAnimes, studios);
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [paginatedAnimes, studios]);

  // Gesto de deslizamiento (swipe hacia la derecha) para volver suavemente
  useEffect(() => {
    let startX = 0;
    let startY = 0;
    let startTime = 0;

    const handleTouchStart = (e: TouchEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'SELECT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'BUTTON' ||
          target.closest('button') ||
          target.closest('a') ||
          target.closest('[role="button"]') ||
          target.closest('input') ||
          target.closest('select') ||
          target.closest('textarea') ||
          target.closest('.no-swipe') ||
          target.closest('[id^="anime-card-"]'))
      ) {
        return;
      }
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startTime = Date.now();
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (!startTime) return;
      const endX = e.changedTouches[0].clientX;
      const endY = e.changedTouches[0].clientY;
      const diffX = endX - startX;
      const diffY = Math.abs(endY - startY);
      const duration = Date.now() - startTime;

      // Deslizamiento claro hacia la derecha (swipe back)
      if (startX < 70 && diffX > 80 && diffY < 60 && duration < 350) {
        onClose();
      }
      startTime = 0;
    };

    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchend', handleTouchEnd);
    };
  }, [onClose]);

  const handlePageChange = (newPage: number) => {
    if (newPage < 1 || newPage > totalPages || newPage === safeCurrentPage) return;
    setCurrentPage(newPage);
    try {
      sessionStorage.setItem('kh_genre_page_' + genre.id, String(newPage));
      if (window.history.state) {
        window.history.replaceState({ ...window.history.state, genrePage: newPage }, '');
      }
    } catch {}

    if (onPageChange) onPageChange(newPage);

    if (catalogTopRef.current && containerRef.current) {
      const targetY = Math.max(0, catalogTopRef.current.offsetTop - 30);
      containerRef.current.scrollTo({
        top: targetY,
        behavior: 'smooth'
      });
    }
  };

  const handleSortChange = (newSort: GenreSortType) => {
    setSortBy(newSort);
    setCurrentPage(1);
    try {
      sessionStorage.setItem('kh_genre_sort_' + genre.id, newSort);
      sessionStorage.setItem('kh_genre_page_' + genre.id, '1');
      if (window.history.state) {
        window.history.replaceState({ ...window.history.state, genreSort: newSort, genrePage: 1 }, '');
      }
    } catch {}
    if (onSortChange) onSortChange(newSort);
    if (onPageChange) onPageChange(1);
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  };

  return (
    <div ref={containerRef} className="w-full h-full overflow-y-auto flex flex-col text-white bg-[#0c0517]">
      {/* Botón para volver */}
      <div className="px-4 sm:px-5 lg:px-7 pt-4 sm:pt-6 pb-2 max-w-[1500px] 2xl:max-w-[1800px] 3xl:max-w-[2100px] mx-auto w-full flex items-center">
        <button
          type="button"
          onClick={onClose}
          aria-label="Volver"
          title="Volver"
          className="group inline-flex items-center justify-center text-neutral-300 hover:text-white transition-all duration-200 cursor-pointer touch-manipulation active:scale-95 bg-black/60 hover:bg-black/80 backdrop-blur-md w-10 h-10 sm:w-11 sm:h-11 rounded-full border border-white/10 hover:border-brand-red/50 shadow-lg"
        >
          <ArrowLeft className="h-5 w-5 transition-transform duration-200 group-hover:-translate-x-0.5 shrink-0 text-brand-red" />
        </button>
      </div>

      {/* Main Genre View Content */}
      <main className="flex-1 max-w-[1500px] 2xl:max-w-[1800px] 3xl:max-w-[2100px] mx-auto w-full px-1.5 sm:px-5 lg:px-7 pt-0 pb-4 sm:pb-6 space-y-6">
        {/* Cabecera del Género: Portada REDONDA a la izquierda, información con puntuación / 5 y número de animes */}
        <div className="flex flex-row items-center sm:items-start gap-4 sm:gap-7 relative z-10 pt-2 px-2.5 sm:px-0">
          {/* Portada del género REDONDA */}
          <div className="w-28 h-28 xs:w-32 xs:h-32 sm:w-44 sm:h-44 md:w-52 md:h-52 rounded-full overflow-hidden shadow-2xl shrink-0 flex items-center justify-center relative select-none bg-purple-950/20">
            {genreCover ? (
              <img
                src={portadaUrl(genreCover, 'estudio')}
                alt={genre.name}
                loading="lazy"
                decoding="async"
                width={270}
                height={270}
                className="w-full h-full object-cover rounded-full drop-shadow-[0_10px_25px_rgba(0,0,0,0.6)] transition-transform duration-300 hover:scale-105"
                onError={(e) => {
                  e.currentTarget.src = getFallbackSvg(genre.name);
                }}
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center text-center p-3 rounded-full bg-purple-950/20">
                <Layers className="h-12 w-12 sm:h-16 sm:w-16 text-purple-400 mb-1" />
                <span className="font-mono text-[10px] uppercase font-bold text-purple-300 truncate max-w-full px-2">
                  {genre.name}
                </span>
              </div>
            )}
          </div>

          {/* Información a la derecha: nombre limpio y métricas */}
          <div className="flex-1 text-left space-y-2.5 min-w-0">
            <h1 className="text-base sm:text-lg md:text-xl font-display font-semibold text-white tracking-wide truncate">
              {genre.name}
            </h1>

            {/* Puntuación, Calificaciones y Cantidad de Animes */}
            <div className="flex flex-col sm:flex-row flex-wrap gap-2 pt-0.5">
              {/* Puntuación general */}
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#180c2e] text-[11px] font-mono shadow-sm">
                <Star className="h-3 w-3 fill-amber-400 text-amber-400 shrink-0" />
                <span className="text-[10px] text-purple-300/80">Puntuación:</span>
                <span className="font-bold text-amber-300">
                  {overallAverage > 0 ? overallAverage.toFixed(1) : 'S/C'}
                </span>
                <span className="text-[9px] text-neutral-400">/ 5</span>
              </div>

              {/* Total de calificaciones */}
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#180c2e] text-[11px] font-mono shadow-sm">
                <MessageSquare className="h-3 w-3 text-pink-400 shrink-0" />
                <span className="text-[10px] text-purple-300/80">Calificaciones:</span>
                <span className="font-bold text-white">
                  {totalVotes.toLocaleString()}
                </span>
              </div>

              {/* Cantidad total de animes del género */}
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#180c2e] text-[11px] font-mono shadow-sm">
                <Film className="h-3 w-3 text-purple-400 shrink-0" />
                <span className="text-[10px] text-purple-300/80">Animes:</span>
                <span className="font-bold text-purple-200">
                  {genreAnimes.length}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Genre Anime Catalog Section */}
        <div className="space-y-4 pt-2">
          {/* Toolbar: Selector para organizar */}
          <div 
            ref={catalogTopRef} 
            className="flex items-center justify-between gap-3 pb-1 px-2 sm:px-0"
          >
            {/* Lado izquierdo: Selector para organizar */}
            <div className="flex items-center">
              <div className="relative inline-flex items-center">
                <div className="h-6 sm:h-7 px-3 inline-flex items-center gap-1.5 rounded-full bg-[#180c2e] hover:bg-[#22103d] text-purple-200 font-mono text-[11px] sm:text-xs font-bold pointer-events-none select-none transition-colors">
                  <ArrowUpDown className="h-3 w-3 text-purple-400 shrink-0" />
                  <span>
                    {sortBy === 'name-asc'
                      ? 'A - Z'
                      : sortBy === 'name-desc'
                      ? 'Z - A'
                      : sortBy === 'rating-desc'
                      ? 'Puntos'
                      : sortBy === 'rating-asc'
                      ? 'Menor'
                      : sortBy === 'date-desc'
                      ? 'Nuevos'
                      : 'Antiguos'}
                  </span>
                  <ChevronRight className="h-3 w-3 rotate-90 text-purple-400 shrink-0" />
                </div>
                <select
                  value={sortBy}
                  onChange={(e) => handleSortChange(e.target.value as GenreSortType)}
                  aria-label="Organizar animes"
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                >
                  <option value="name-asc">Nombre (A a Z)</option>
                  <option value="name-desc">Nombre (Z a A)</option>
                  <option value="rating-desc">Mayor Puntuación</option>
                  <option value="rating-asc">Menor Puntuación</option>
                  <option value="date-desc">Fecha (Más recientes)</option>
                  <option value="date-asc">Fecha (Más antiguos)</option>
                </select>
              </div>
            </div>
          </div>

          {/* Grid de animes del género: SEPARACIÓN ULTRA REDUCIDA EXACTA A ESTUDIOS */}
          {paginatedAnimes.length === 0 ? (
            <div className="text-center py-12 p-6 rounded-2xl text-neutral-400 space-y-2">
              <Film className="h-8 w-8 text-neutral-600 mx-auto" />
              <p className="font-mono text-xs">
                No hay animes registrados actualmente para este género.
              </p>
            </div>
          ) : (
            <div className="relative w-full overflow-hidden rounded-xl">
              <div className="grid grid-cols-3 gap-[1.5px] xs:gap-[2px] sm:gap-[2.5px] w-full">
                {paginatedAnimes.map((anime, index) => (
                  <GalleryCard
                    key={anime.id}
                    anime={anime}
                    studios={studios}
                    index={index}
                    onClick={() => {
                      const currentScroll = containerRef.current?.scrollTop || 0;
                      try {
                        sessionStorage.setItem('kh_genre_scroll_' + genre.id, String(currentScroll));
                        sessionStorage.setItem('kh_genre_page_' + genre.id, String(safeCurrentPage));
                        sessionStorage.setItem('kh_genre_sort_' + genre.id, sortBy);
                        sessionStorage.setItem('kh_last_genre', JSON.stringify(genre));
                        if (window.history.state) {
                          window.history.replaceState({
                            ...window.history.state,
                            genrePage: safeCurrentPage,
                            genreScrollY: currentScroll,
                            genreSort: sortBy
                          }, '');
                        }
                      } catch {}
                      onSelectAnime(anime.id, safeCurrentPage, currentScroll, sortBy);
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Paginación idéntica a la sección de estudio */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-4 sm:gap-5 pt-5 pb-12 select-none flex-wrap">
              {/* Flecha izquierda */}
              <button
                type="button"
                onClick={() => handlePageChange(safeCurrentPage - 1)}
                disabled={safeCurrentPage <= 1}
                aria-label="Página anterior"
                className={`p-1.5 transition-colors cursor-pointer active:scale-90 flex items-center justify-center ${
                  safeCurrentPage <= 1
                    ? 'text-[#2a1e3d] pointer-events-none'
                    : 'text-neutral-400 hover:text-white'
                }`}
              >
                <ChevronLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4" strokeWidth={2.5} />
              </button>

              {/* Números de página compactos */}
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => {
                const isActive = p === safeCurrentPage;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => handlePageChange(p)}
                    className={`min-w-[26px] h-7 sm:min-w-[30px] sm:h-8 flex items-center justify-center text-sm sm:text-base font-bold font-sans transition-colors select-none active:scale-90 cursor-pointer ${
                      isActive
                        ? 'text-[#ff2a70] cursor-default'
                        : 'text-white hover:text-neutral-300'
                    }`}
                  >
                    {p}
                  </button>
                );
              })}

              {/* Flecha derecha */}
              <button
                type="button"
                onClick={() => handlePageChange(safeCurrentPage + 1)}
                disabled={safeCurrentPage >= totalPages}
                aria-label="Página siguiente"
                className={`p-1.5 transition-colors cursor-pointer active:scale-90 flex items-center justify-center ${
                  safeCurrentPage >= totalPages
                    ? 'text-[#2a1e3d] pointer-events-none'
                    : 'text-neutral-300 hover:text-white'
                }`}
              >
                <ChevronRight className="w-3.5 h-3.5 sm:w-4 sm:h-4" strokeWidth={2.5} />
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
