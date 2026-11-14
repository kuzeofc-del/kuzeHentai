import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Play, Plus, Check, ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import { Anime, Studio, Genre } from '../types';
import { SmartAnimeCover } from '../utils/imageFallback';
import { auth } from '../lib/firebase';

interface PopularHeroCarouselProps {
  animes: Anime[];
  studios: Studio[];
  genres: Genre[];
  onSelectAnime: (animeId: string) => void;
  savedAnimeIds?: string[];
  onToggleMyList?: (animeId: string) => void;
  loading?: boolean;
}

export default function PopularHeroCarousel({
  animes,
  studios,
  genres,
  onSelectAnime,
  savedAnimeIds = [],
  onToggleMyList,
  loading = false,
}: PopularHeroCarouselProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  // Swipe / Drag and Tap detection
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const touchStartTime = useRef<number>(0);
  const touchMoved = useRef(false);
  const pointerStartX = useRef<number | null>(null);
  const pointerStartY = useRef<number | null>(null);
  const hasMoved = useRef(false);
  const lastActionTime = useRef<number>(0);

  const total = animes.length;

  const handleNext = useCallback(() => {
    if (total <= 1) return;
    setCurrentIndex((prev) => (prev + 1) % total);
  }, [total]);

  const handlePrev = useCallback(() => {
    if (total <= 1) return;
    setCurrentIndex((prev) => (prev - 1 + total) % total);
  }, [total]);

  // Reset index if out of bounds
  useEffect(() => {
    if (currentIndex >= total && total > 0) {
      setCurrentIndex(0);
    }
  }, [currentIndex, total]);

  const currentAnime = useMemo(() => {
    return animes[currentIndex] || animes[0] || null;
  }, [animes, currentIndex]);

  const studioNames = useMemo(() => {
    if (!currentAnime) return ['ESTUDIO INDEPENDIENTE'];
    const sIds = (currentAnime.studioIds && currentAnime.studioIds.length > 0)
      ? currentAnime.studioIds
      : (currentAnime.studioId ? [currentAnime.studioId] : []);
    const matched = studios.filter((s) => sIds.includes(s.id)).map((s) => s.name);
    return matched.length > 0 ? matched : ['ESTUDIO INDEPENDIENTE'];
  }, [currentAnime, studios]);

  const studioName = studioNames[0] || 'Estudio';

  // Show at most 3 genres with concise names
  const genreNames = useMemo(() => {
    if (!currentAnime || !currentAnime.genreIds) return [];
    return currentAnime.genreIds
      .map((id) => genres.find((g) => g.id === id)?.name)
      .filter((n): n is string => Boolean(n))
      .slice(0, 3);
  }, [currentAnime, genres]);

  const isSaved = currentAnime ? savedAnimeIds.includes(currentAnime.id) : false;

  // Touch Swipe & Single-Tap handlers for mobile
  const handleTouchStart = (e: React.TouchEvent) => {
    setIsPaused(true);
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
    touchStartTime.current = Date.now();
    touchMoved.current = false;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const currentX = e.touches[0].clientX;
    const currentY = e.touches[0].clientY;
    const deltaX = currentX - touchStartX.current;
    const deltaY = currentY - touchStartY.current;

    // Movement greater than 10px is considered swipe/drag, not a tap
    if (Math.hypot(deltaX, deltaY) > 10) {
      touchMoved.current = true;
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current !== null && touchStartY.current !== null) {
      const endX = e.changedTouches[0]?.clientX ?? touchStartX.current;
      const endY = e.changedTouches[0]?.clientY ?? touchStartY.current;
      const deltaX = endX - touchStartX.current;
      const deltaY = endY - touchStartY.current;
      const distance = Math.hypot(deltaX, deltaY);
      const duration = Date.now() - touchStartTime.current;

      if (touchMoved.current && Math.abs(deltaX) > 35 && Math.abs(deltaX) > Math.abs(deltaY)) {
        // Horizontal swipe to navigate carousel
        if (deltaX < -35) {
          handleNext();
        } else if (deltaX > 35) {
          handlePrev();
        }
      } else if (!touchMoved.current && distance <= 12 && duration < 500) {
        // Direct intentional single-tap on mobile
        const target = e.target as HTMLElement | null;
        const isInteractive = target?.closest('button') !== null;
        if (!isInteractive && currentAnime) {
          lastActionTime.current = Date.now();
          onSelectAnime(currentAnime.id);
        }
      }
    }

    touchStartX.current = null;
    touchStartY.current = null;
    touchMoved.current = false;
    setIsPaused(false);
  };

  const handleTouchCancel = () => {
    touchStartX.current = null;
    touchStartY.current = null;
    touchMoved.current = false;
    setIsPaused(false);
  };

  // Mouse Drag & Click handlers for desktop
  const handleMouseDown = (e: React.MouseEvent) => {
    pointerStartX.current = e.clientX;
    pointerStartY.current = e.clientY;
    hasMoved.current = false;
    setIsPaused(true);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (pointerStartX.current === null || pointerStartY.current === null) return;
    const deltaX = e.clientX - pointerStartX.current;
    const deltaY = e.clientY - pointerStartY.current;
    if (Math.hypot(deltaX, deltaY) > 8) {
      hasMoved.current = true;
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (pointerStartX.current !== null && hasMoved.current) {
      const deltaX = e.clientX - pointerStartX.current;
      if (deltaX < -40) {
        handleNext();
      } else if (deltaX > 40) {
        handlePrev();
      }
    }
    pointerStartX.current = null;
    pointerStartY.current = null;
    setIsPaused(false);
  };

  // Unified single click on card
  const handleCardClick = (e: React.MouseEvent) => {
    // Avoid double triggering if touchEnd handled it
    if (Date.now() - lastActionTime.current < 450) {
      return;
    }
    // If dragging on desktop, do not trigger navigation
    if (hasMoved.current) {
      hasMoved.current = false;
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target?.closest('button')) {
      return;
    }
    if (currentAnime) {
      lastActionTime.current = Date.now();
      onSelectAnime(currentAnime.id);
    }
  };

  if (loading) {
    return (
      <div className="w-full relative rounded-t-none rounded-b-2xl sm:rounded-b-3xl overflow-hidden bg-[#0a0515] border-t-0 border-x border-b border-[#2b1747]/60 aspect-[4/5.9] xs:aspect-[3/4.8] sm:aspect-[16/12.8] md:aspect-[16/11.2] lg:aspect-[16/9.8] min-h-[575px] sm:min-h-[645px] md:min-h-[680px] max-h-[820px] no-swipe">
        <div className="absolute inset-0 bg-gradient-to-t from-[#090514] via-[#090514]/30 to-transparent" />
        <div className="absolute bottom-5 left-5 right-5 space-y-2">
          <div className="h-6 w-52 bg-white/10 rounded-lg" />
          <div className="h-3.5 w-24 bg-purple-700/30 rounded-full" />
          <div className="h-3 w-64 bg-white/10 rounded" />
          <div className="flex gap-2 pt-1">
            <div className="h-8 w-28 bg-purple-600/40 rounded-lg" />
            <div className="h-8 w-8 bg-white/10 rounded-lg" />
          </div>
        </div>
      </div>
    );
  }

  if (!currentAnime || total === 0) {
    return null;
  }

  return (
    <div
      className="relative w-full select-none group no-swipe"
      onMouseLeave={() => {
        setIsPaused(false);
        pointerStartX.current = null;
        hasMoved.current = false;
      }}
    >
      {/* Crunchyroll-Style Hero Banner Card */}
      <div
        className="relative w-full rounded-t-none rounded-b-2xl sm:rounded-b-3xl overflow-hidden bg-[#090514] border-t-0 border-x border-b border-[#2b1747] shadow-xl shadow-black/70 aspect-[4/5.9] xs:aspect-[3/4.8] sm:aspect-[16/12.8] md:aspect-[16/11.2] lg:aspect-[16/9.8] min-h-[575px] sm:min-h-[645px] md:min-h-[680px] max-h-[820px] flex flex-col justify-end touch-pan-y cursor-pointer no-swipe"
        onClick={handleCardClick}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        {/* Animated Background Poster with lightweight GPU opacity cross-fade */}
        <AnimatePresence initial={false}>
          <motion.div
            key={currentAnime.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="absolute inset-0 w-full h-full pointer-events-none will-change-[opacity]"
          >
            <SmartAnimeCover
              anime={currentAnime}
              studioName={studioName}
              alt={currentAnime.name}
              priority={true}
              loading="eager"
              className="w-full h-full object-cover object-[center_top] sm:object-[center_12%]"
            />
          </motion.div>
        </AnimatePresence>

        {/* Hero Content Overlay: stronger uniform fade covering buttons, synopsis, genres, title, and reaching strongly over the studio with a smooth feather */}
        <div className="relative z-10 w-full px-3.5 sm:px-5 md:px-6 pb-2.5 sm:pb-3.5 md:pb-4 pt-4 sm:pt-5 pointer-events-auto">
          <div className="absolute inset-x-0 bottom-0 -top-14 sm:-top-16 bg-[linear-gradient(to_top,rgba(9,5,20,0.9)_0%,rgba(9,5,20,0.84)_50%,rgba(9,5,20,0.72)_66%,rgba(9,5,20,0.46)_78%,rgba(9,5,20,0.22)_88%,rgba(9,5,20,0.07)_95%,transparent_100%)] pointer-events-none -z-10" />

          <div className="flex flex-col justify-end space-y-1 sm:space-y-1.5 max-w-2xl">
            {/* Studio / Studios above Title */}
            <div className="mb-0.5 flex flex-wrap items-center gap-1.5 w-fit">
              {studioNames.map((stName, idx) => (
                <React.Fragment key={`${stName}-${idx}`}>
                  <span className="inline-flex items-center w-fit font-mono text-[10.5px] sm:text-xs font-semibold text-[#c084fc] uppercase tracking-wider leading-tight">
                    {stName}
                  </span>
                  {idx < studioNames.length - 1 && (
                    <span className="text-neutral-300 font-mono text-[10.5px] sm:text-xs">/</span>
                  )}
                </React.Fragment>
              ))}
            </div>

            {/* Anime Title: instant, smooth rendering without mode="wait" stutter */}
            <h1
              className="text-base sm:text-xl md:text-2xl font-display font-bold text-white tracking-tight leading-snug hover:text-purple-300 truncate max-w-full"
              title={currentAnime.name}
            >
              {currentAnime.name}
            </h1>

            {/* Small Genre Tags (3 genres, small size) - Below title */}
            {genreNames.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {genreNames.map((gName, idx) => (
                  <span
                    key={idx}
                    className="px-2 py-0.5 rounded-lg bg-[#1a0f30]/90 border border-purple-400/30 text-[9px] font-mono text-purple-200 uppercase tracking-wider"
                  >
                    {gName}
                  </span>
                ))}
              </div>
            )}

            {/* Synopsis: short single-line snippet */}
            {currentAnime.description && (
              <p className="text-[11px] sm:text-xs text-neutral-300/95 font-sans leading-relaxed line-clamp-1 max-w-lg">
                {currentAnime.description}
              </p>
            )}

            {/* Action Buttons: Violet styled ("VER" + "Mi Lista" + Vistas) */}
            <div className="flex items-center gap-2 pt-1">
              {/* Primary Violet "VER" Button (matches recuadro violeta) */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectAnime(currentAnime.id);
                }}
                className="inline-flex items-center justify-center gap-1.5 px-3.5 sm:px-4 py-1.5 sm:py-2 rounded-xl bg-gradient-to-r from-purple-700 to-purple-600 hover:from-purple-600 hover:to-purple-500 text-white font-mono font-bold text-[10px] sm:text-[11px] tracking-wider uppercase shadow-md border border-purple-400/40 active:scale-95 transition-transform duration-150 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5 fill-white text-white shrink-0" />
                <span>VER</span>
              </button>

              {/* Bookmark / Mi Lista Button */}
              {onToggleMyList && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!auth?.currentUser) {
                      window.dispatchEvent(new CustomEvent('kh_open_auth_modal', { detail: { mode: 'register' } }));
                      return;
                    }
                    onToggleMyList(currentAnime.id);
                  }}
                  className={`inline-flex items-center justify-center gap-1 px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-xl border text-[10px] sm:text-[11px] font-mono font-semibold active:scale-95 transition-transform duration-150 cursor-pointer ${
                    isSaved
                      ? 'bg-purple-900/70 border-purple-400/60 text-purple-200 shadow-sm'
                      : 'bg-[#120b1f]/90 border-[#2b1747] hover:border-purple-500/40 text-neutral-300 hover:text-white'
                  }`}
                  title={isSaved ? 'Quitar de Mi Lista' : 'Añadir a Mi Lista'}
                  aria-label={isSaved ? 'Quitar de Mi Lista' : 'Añadir a Mi Lista'}
                >
                  {isSaved ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-purple-300 stroke-[2.5]" />
                      <span className="hidden sm:inline">GUARDADO</span>
                    </>
                  ) : (
                    <>
                      <Plus className="w-3.5 h-3.5 text-neutral-300 stroke-[2.5]" />
                      <span className="hidden sm:inline">MI LISTA</span>
                    </>
                  )}
                </button>
              )}

              {/* Views counter */}
              {(currentAnime.downloads || 0) > 0 && (
                <div className="hidden xs:flex items-center gap-1 text-[10px] font-mono text-neutral-400 pl-1">
                  <Sparkles className="w-3 h-3 text-purple-400 shrink-0" />
                  <span>{currentAnime.downloads?.toLocaleString()} vistas</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Previous / Next Chevron Buttons */}
        {total > 1 && (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handlePrev();
              }}
              className="absolute left-2 top-1/2 -translate-y-1/2 z-20 w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-black/75 hover:bg-[#1a0f30] text-white/80 hover:text-purple-300 border border-purple-500/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200 shadow-lg active:scale-90 cursor-pointer"
              aria-label="Anterior anime popular"
            >
              <ChevronLeft className="w-4 h-4 sm:w-5 sm:h-5" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleNext();
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 z-20 w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-black/75 hover:bg-[#1a0f30] text-white/80 hover:text-purple-300 border border-purple-500/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200 shadow-lg active:scale-90 cursor-pointer"
              aria-label="Siguiente anime popular"
            >
              <ChevronRight className="w-4 h-4 sm:w-5 sm:h-5" />
            </button>
          </>
        )}

        {/* Bottom Progress Bar Indicator (Single compact bar that fills in 3.30s and advances) */}
        {total > 1 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleNext();
            }}
            className="absolute bottom-2.5 right-3.5 sm:bottom-3.5 sm:right-5 z-20 flex items-center p-[3px] rounded-md bg-[#090514]/90 border border-[#2b1747] cursor-pointer"
            aria-label="Siguiente anime popular"
          >
            <div className="w-8 h-1 rounded-sm bg-white/25 overflow-hidden">
              <div
                key={currentIndex}
                onAnimationEnd={handleNext}
                className={`h-full rounded-sm bg-gradient-to-r from-purple-700 to-purple-500 shadow-sm border border-purple-400/50 hero-bar-fill ${
                  isPaused ? 'hero-bar-fill-paused' : ''
                }`}
              />
            </div>
          </button>
        )}
      </div>
    </div>
  );
}
