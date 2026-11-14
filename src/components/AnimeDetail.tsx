/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { Anime, Studio, Genre, normalizeAnimeYear, resolveContinuationGroup, formatContinuationTitle } from '../types';
import { ArrowLeft, Download, Plus, Check, Play, Pause, Volume2, VolumeX, X, Film, ExternalLink, Tv, Video, Maximize2, Minimize2, RotateCcw, RotateCw, FastForward, Maximize, Loader2, Sparkles, Eye, EyeOff, Star, Info } from 'lucide-react';
import { getFallbackSvg, processImageSrc, globalImageCache, globalLoadedAnimeIds, SmartAnimeCover, preloadAnimeCover, prefetchAnime } from '../utils/imageFallback';
import GlobalComments from './GlobalComments';
import AnimeRatingModal from './AnimeRatingModal';
import { getAnimeRatingStats, submitAnimeVote, RatingStats } from '../utils/ratingManager';
import { auth } from '../lib/firebase';
import { useAppTheme } from '../lib/theme';

interface AnimeDetailProps {
  anime: Anime;
  studios: Studio[];
  genres: Genre[];
  animes?: Anime[];
  allAnimes?: Anime[];
  initialEpisodeNum?: number;
  onBack: () => void;
  onDownload?: (animeId: string) => void;
  onSelectGenre?: (genreId: string) => void;
  onSelectStudio?: (studioId: string) => void;
  onSelectAnime?: (animeId: string) => void;
  isSaved?: boolean;
  onToggleMyList?: (animeId: string) => void;
  isWatched?: boolean;
  onToggleWatched?: (animeId: string) => void;
  navDirection?: number;
}

// Custom SignIcon matching image
const SignIcon = ({ className = "h-3.5 w-3.5" }: { className?: string }) => (
  <svg 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="2.2" 
    strokeLinecap="round" 
    strokeLinejoin="round" 
    className={className}
  >
    <path d="M4 2v20" />
    <path d="M4 4h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4" />
    <path d="M4 11h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4" />
  </svg>
);

export default function AnimeDetail({ anime, studios, genres, animes, allAnimes, initialEpisodeNum, onBack, onDownload, onSelectGenre, onSelectStudio, onSelectAnime, isSaved, onToggleMyList, isWatched: isWatchedProp, onToggleWatched, navDirection = 1 }: AnimeDetailProps) {
  const [appTheme] = useAppTheme();
  const sIds = (anime.studioIds && anime.studioIds.length > 0)
    ? anime.studioIds
    : (anime.studioId ? [anime.studioId] : []);
  const animeStudios = sIds
    .map(id => studios.find(s => s.id === id))
    .filter((s): s is Studio => Boolean(s));
  const studio = animeStudios[0] || (anime.studioId ? studios.find(s => s.id === anime.studioId) : undefined);
  const animeGenres = (anime.genreIds || [])
    .map(id => genres.find(g => g.id === id))
    .filter((g): g is (typeof genres)[0] => Boolean(g));

  // Fallback animes state if animes prop not passed
  const [fetchedAnimes, setFetchedAnimes] = useState<Anime[]>([]);

  useEffect(() => {
    if ((!animes || animes.length === 0) && (!allAnimes || allAnimes.length === 0)) {
      fetch('/api/animes')
        .then(res => res.json())
        .then(data => {
          if (Array.isArray(data)) setFetchedAnimes(data);
        })
        .catch(() => {});
    }
  }, [animes, allAnimes]);

  const availableAnimes = useMemo(() => {
    if (animes && animes.length > 0) return animes;
    if (allAnimes && allAnimes.length > 0) return allAnimes;
    return fetchedAnimes;
  }, [animes, allAnimes, fetchedAnimes]);

  // Defer heavy below-the-fold content until entrance animation completes cleanly
  const [showDeferredSections, setShowDeferredSections] = useState(false);

  useEffect(() => {
    setShowDeferredSections(false);
    const timer = setTimeout(() => {
      setShowDeferredSections(true);
    }, 120);
    return () => clearTimeout(timer);
  }, [anime.id]);

  // Deterministic seed per anime.id (zero extra re-renders on mount)
  const visitSeed = useMemo(() => {
    let hash = 0;
    for (let i = 0; i < anime.id.length; i++) {
      hash = ((hash << 5) - hash) + anime.id.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash) / 2147483647;
  }, [anime.id]);

  // Resolve Cronología / Secuela group bidirectionally and sort from lowest year (left) to highest year (right)
  const continuationGroup = useMemo(() => {
    if (!showDeferredSections) return { type: 'none' as const, linkedAnimes: [] };
    return resolveContinuationGroup(anime, availableAnimes);
  }, [anime, availableAnimes, showDeferredSections]);

  // Calculate 3 recommended animes based on affinity (genres, studio, episodes, ratings)
  // Evaluated smoothly when deferred sections wake up
  const recommendedAnimes = useMemo(() => {
    if (!showDeferredSections) return [];
    const list = availableAnimes.filter(a => a.id !== anime.id);
    if (list.length === 0) return [];

    const currentGenreSet = new Set(anime.genreIds || []);
    const currentEpCount = anime.episodes?.length || 1;
    const curSIds = (anime.studioIds && anime.studioIds.length > 0)
      ? anime.studioIds
      : (anime.studioId ? [anime.studioId] : []);

    const scored: { anime: Anime; score: number }[] = [];

    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      let score = 0;

      // 1. Coincidencia de Géneros (mayor peso)
      const itemGenres = item.genreIds || [];
      let genreMatches = 0;
      for (let g = 0; g < itemGenres.length; g++) {
        if (currentGenreSet.has(itemGenres[g])) genreMatches++;
      }
      score += genreMatches * 20;

      // 2. Coincidencia de Estudio
      const itemSIds = (item.studioIds && item.studioIds.length > 0)
        ? item.studioIds
        : (item.studioId ? [item.studioId] : []);
      if (curSIds.some(id => itemSIds.includes(id))) {
        score += 12;
      }

      // 3. Similitud en número de episodios
      const itemEpCount = item.episodes?.length || 1;
      const epDiff = Math.abs(currentEpCount - itemEpCount);
      if (epDiff === 0) {
        score += 6;
      } else if (epDiff <= 2) {
        score += 4;
      } else if (epDiff <= 5) {
        score += 2;
      }

      // 4. Coincidencia de Reseñas y popularidad
      if (item.downloads) {
        score += Math.min(10, Math.floor(item.downloads / 50));
      }

      if (score > 0) {
        scored.push({ anime: item, score });
      }
    }

    // Ordenar candidatos por puntuación base de afinidad
    scored.sort((a, b) => b.score - a.score);

    // Si existen candidatos con afinidad, usar hasta los mejores 24 para mezclar
    const candidatePool = scored.length >= 3 
      ? scored.slice(0, 24).map(s => s.anime)
      : list.slice(0, 12);

    // Función pseudo-aleatoria determinista según el visitSeed
    const seededRandom = (index: number) => {
      const x = Math.sin(visitSeed * 9999 + index * 777) * 10000;
      return x - Math.floor(x);
    };

    // Mezclar el grupo de candidatos
    const shuffled = [...candidatePool];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(seededRandom(i) * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Tomar 3 animes distintos
    return shuffled.slice(0, 3);
  }, [anime.id, availableAnimes, visitSeed, showDeferredSections]);

  // Warm content smoothly after entrance animation finishes
  useEffect(() => {
    // 1. Preload anime poster & backdrop
    preloadAnimeCover(anime, studio?.name);

    const timer = setTimeout(() => {
      // 2. Preload recommended animes
      if (recommendedAnimes.length > 0) {
        recommendedAnimes.forEach(rec => {
          const sIds = (rec.studioIds && rec.studioIds.length > 0) ? rec.studioIds : (rec.studioId ? [rec.studioId] : []);
          const recStudio = studios.find(s => sIds.includes(s.id))?.name || 'Estudio';
          preloadAnimeCover(rec, recStudio);
        });
      }

      // 3. Preload episode thumbnails
      if (anime.episodes && anime.episodes.length > 0) {
        anime.episodes.slice(0, 10).forEach(ep => {
          const epCover = ep.thumbnail || ep.coverImage;
          if (epCover && !epCover.startsWith('data:')) {
            const img = new Image();
            img.decoding = 'async';
            img.src = epCover;
          }
        });
      }
    }, 280);

    return () => clearTimeout(timer);
  }, [anime.id, anime.episodes, studio?.name, recommendedAnimes, studios]);

  // Video Player Modal State
  const [activeEpisodeNum, setActiveEpisodeNum] = useState<number | null>(initialEpisodeNum || null);
  const [isPlayerOpen, setIsPlayerOpen] = useState<boolean>(Boolean(initialEpisodeNum));

  useEffect(() => {
    if (initialEpisodeNum !== undefined && initialEpisodeNum !== null) {
      setActiveEpisodeNum(initialEpisodeNum);
      setIsPlayerOpen(true);
      if (onDownload) {
        onDownload(anime.id);
      }
    }
  }, [initialEpisodeNum, anime.id, onDownload]);

  // Listener para cerrar con tecla Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isPlayerOpen) {
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        } else {
          setIsPlayerOpen(false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlayerOpen]);

  // Gestos de deslizamiento (Swipe de izquierda a derecha):
  // 1. Si el reproductor de video está abierto: deslizar de izquierda a derecha cierra el reproductor y vuelve a los detalles del anime.
  // 2. Si el reproductor está cerrado: deslizar de izquierda a derecha sale de los detalles y vuelve al apartado de donde vino (estudio o catálogo).
  useEffect(() => {
    let startX = 0;
    let startY = 0;
    let startTime = 0;

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'SELECT' ||
          target.tagName === 'TEXTAREA' ||
          target.closest('input') ||
          target.closest('select') ||
          target.closest('textarea') ||
          target.closest('.no-swipe'))
      ) {
        return;
      }
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startTime = Date.now();
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (!startTime) return;
      const touch = e.changedTouches[0];
      if (!touch) return;
      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;
      const duration = Date.now() - startTime;
      startTime = 0;

      // Deslizamiento de izquierda a derecha (swipe right):
      // deltaX > 40, horizontal predominante (Math.abs(deltaX) > Math.abs(deltaY) * 1.1), duración natural menor a 900ms
      if (deltaX > 40 && Math.abs(deltaX) > Math.abs(deltaY) * 1.1 && duration < 900) {
        try {
          if (navigator.vibrate) navigator.vibrate(20);
        } catch {}

        if (isPlayerOpen) {
          if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
          }
          setIsPlayerOpen(false);
        } else {
          onBack();
        }
      }
    };

    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchend', handleTouchEnd);
    };
  }, [isPlayerOpen, onBack]);

  // Compute episodes list and active episode with robust fallbacks
  const isUpcoming = Boolean(
    anime.status && (
      anime.status === 'Próximamente' ||
      anime.status.toLowerCase().includes('proximamente') ||
      anime.status.toLowerCase().includes('próximamente')
    )
  );
  const isEmision = Boolean(
    !isUpcoming &&
    anime.status &&
    anime.status.toLowerCase().includes('emisi')
  );
  const statusLabel = isUpcoming ? 'Próximamente' : isEmision ? 'Emisión' : 'Finalizado';

  const displayEpisodes = useMemo(() => {
    if (anime.episodes && anime.episodes.length > 0) {
      const parsed = anime.episodes
        .map(ep => {
          const videoLink = String(ep.telegramUrl || ep.url || ep.videoUrl || ep.mp4Url || ep.link || '').trim();
          return {
            ...ep,
            number: Number(ep.number) || 1,
            telegramUrl: videoLink || anime.telegramUrl || '',
            url: videoLink || anime.telegramUrl || '',
            videoUrl: videoLink || anime.telegramUrl || '',
            mp4Url: videoLink || anime.telegramUrl || '',
            link: videoLink || anime.telegramUrl || ''
          };
        })
        .filter(ep => Boolean(ep.telegramUrl));
      if (parsed.length > 0) return parsed;
    }
    return anime.telegramUrl
      ? [{ number: 1, telegramUrl: anime.telegramUrl, url: anime.telegramUrl, videoUrl: anime.telegramUrl, mp4Url: anime.telegramUrl, link: anime.telegramUrl }]
      : [];
  }, [anime.episodes, anime.telegramUrl]);

  const currentEpisode = useMemo(() => {
    if (activeEpisodeNum !== null && activeEpisodeNum !== undefined) {
      const match = displayEpisodes.find(ep => Number(ep.number) === Number(activeEpisodeNum));
      if (match) return match;
    }
    return displayEpisodes[0] || {
      number: activeEpisodeNum || 1,
      telegramUrl: anime.telegramUrl || '',
      url: anime.telegramUrl || '',
      mp4Url: anime.telegramUrl || '',
      link: anime.telegramUrl || ''
    };
  }, [displayEpisodes, activeEpisodeNum, anime.telegramUrl]);

  // Expanded modal state
  const [isPlayerExpanded, setIsPlayerExpanded] = useState<boolean>(false);
  const [videoPlaybackError, setVideoPlaybackError] = useState<boolean>(false);
  const [isVideoPaused, setIsVideoPaused] = useState<boolean>(true);

  // Computed video URL for current episode
  const rawVideoUrl = useMemo(() => {
    if (!currentEpisode) return (anime.telegramUrl || '').trim();
    return (currentEpisode.telegramUrl || currentEpisode.url || currentEpisode.videoUrl || currentEpisode.mp4Url || currentEpisode.link || anime.telegramUrl || '').trim();
  }, [currentEpisode, anime.telegramUrl]);

  const isTelegramUrl = useMemo(() => {
    return rawVideoUrl.toLowerCase().includes('t.me/');
  }, [rawVideoUrl]);

  const directVideoUrl = useMemo(() => {
    if (!rawVideoUrl) return '';
    let url = rawVideoUrl;
    if (url.includes('archive.org')) {
      if (url.includes('archive.org/details/')) {
        url = url.replace('archive.org/details/', 'archive.org/download/');
      } else if (url.includes('archive.org/embed/')) {
        url = url.replace('archive.org/embed/', 'archive.org/download/');
      }
      url = url.replace(/[?&]autoplay=1/g, '');
    }
    // Encode spaces safely so HTML5 video element never fails on unencoded file paths
    if (url.includes(' ')) {
      url = url.replace(/ /g, '%20');
    }
    return url;
  }, [rawVideoUrl]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const playerWrapperRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const savedTimeRef = useRef<number>(0);

  // Monitor browser fullscreen state change
  useEffect(() => {
    const handleFSChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFSChange);
    document.addEventListener('webkitfullscreenchange', handleFSChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFSChange);
      document.removeEventListener('webkitfullscreenchange', handleFSChange);
    };
  }, []);

  const toggleFullscreen = () => {
    if (!playerWrapperRef.current) return;
    if (!document.fullscreenElement) {
      const elem = playerWrapperRef.current as any;
      if (elem.requestFullscreen) {
        elem.requestFullscreen().catch(() => {});
      } else if (elem.webkitRequestFullscreen) {
        elem.webkitRequestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if ((document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen();
      }
    }
  };

  // Quick skip helper (+10s / -10s)
  const handleSkip10 = (seconds: number) => {
    if (videoRef.current) {
      try {
        const total = videoRef.current.duration || 0;
        const target = Math.max(0, Math.min(total, videoRef.current.currentTime + seconds));
        savedTimeRef.current = target;
        videoRef.current.currentTime = target;
      } catch (err) {
        console.warn("Skip error:", err);
      }
    }
  };

  // Reset saved time and trigger autoplay on URL or episode change
  useEffect(() => {
    savedTimeRef.current = 0;
    if (isPlayerOpen) {
      const attemptPlay = () => {
        if (videoRef.current) {
          const playPromise = videoRef.current.play();
          if (playPromise !== undefined) {
            playPromise.catch(() => {
              if (videoRef.current) {
                videoRef.current.muted = true;
                videoRef.current.play().catch(() => {});
              }
            });
          }
        }
      };
      const timer = setTimeout(attemptPlay, 120);
      return () => clearTimeout(timer);
    }
  }, [directVideoUrl, currentEpisode?.number, isPlayerOpen]);

  // Lock body scroll when player modal is open so it renders perfectly centered
  useEffect(() => {
    if (isPlayerOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isPlayerOpen]);

  // Robust image fallback state matching GalleryCard
  const initialSrc = processImageSrc(anime, studio?.name);
  const [imageSrc, setImageSrc] = useState<string>(initialSrc);
  const [retryCount, setRetryCount] = useState<number>(0);
  const initialInstant = Boolean(
    initialSrc.startsWith('data:') || 
    globalImageCache.has(initialSrc) || 
    (anime.id && globalLoadedAnimeIds.has(anime.id))
  );
  const [isLoaded, setIsLoaded] = useState<boolean>(initialInstant);
  const posterImgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const src = processImageSrc(anime, studio?.name);
    setImageSrc(prev => {
      if (src !== prev) {
        setRetryCount(0);
        const instant = src.startsWith('data:') || globalImageCache.has(src) || (anime.id && globalLoadedAnimeIds.has(anime.id));
        setIsLoaded(Boolean(instant));
        return src;
      }
      return prev;
    });
  }, [anime.image, anime.coverData, anime.id, studio?.name]);

  // Instantly verify if image is complete in browser cache or when player closes
  useEffect(() => {
    if (posterImgRef.current && posterImgRef.current.complete && posterImgRef.current.naturalWidth > 0) {
      setIsLoaded(true);
    }
  }, [imageSrc, isPlayerOpen]);

  const handleLoad = () => {
    if (imageSrc) globalImageCache.add(imageSrc);
    setIsLoaded(true);
  };

  const handleError = () => {
    if (retryCount === 0) {
      setRetryCount(1);
      if (anime.coverData && anime.coverData.startsWith('data:image/') && imageSrc !== anime.coverData) {
        setImageSrc(anime.coverData);
        setIsLoaded(true);
        return;
      }
      if (anime.id) {
        const nextSrc = `/covers/${anime.id}.webp`;
        setImageSrc(nextSrc);
        if (globalImageCache.has(nextSrc)) setIsLoaded(true);
        return;
      }
    }

    if (retryCount === 1) {
      setRetryCount(2);
      if (anime.id) {
        setImageSrc(`/api/covers/${anime.id}.webp`);
        return;
      }
    }

    // Fallback final: Póster generado en SVG (garantiza que nunca quede roto)
    const svgFallback = getFallbackSvg(anime.name, studio?.name);
    setImageSrc(svgFallback);
    setIsLoaded(true);
  };

  // Watched state
  const [isWatched, setIsWatched] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem('kh_watched_list');
      const list: string[] = raw ? JSON.parse(raw) : [];
      return list.includes(anime.id);
    } catch {
      return false;
    }
  });

  const handleToggleWatched = () => {
    if (!auth?.currentUser) {
      window.dispatchEvent(new CustomEvent('kh_open_auth_modal', { detail: { mode: 'register' } }));
      return;
    }
    setIsWatched(prev => {
      const next = !prev;
      try {
        const raw = localStorage.getItem('kh_watched_list');
        const list: string[] = raw ? JSON.parse(raw) : [];
        const updated = next
          ? Array.from(new Set([...list, anime.id]))
          : list.filter(id => id !== anime.id);
        localStorage.setItem('kh_watched_list', JSON.stringify(updated));
        window.dispatchEvent(new CustomEvent('kh_watched_updated', { detail: { animeId: anime.id, isWatched: next } }));
      } catch (e) {}
      return next;
    });
  };

  // Rating stats and popover state
  const [ratingStats, setRatingStats] = useState<RatingStats>(() => getAnimeRatingStats(anime.id));
  const [isRatingOpen, setIsRatingOpen] = useState<boolean>(false);
  const [isInfoOpen, setIsInfoOpen] = useState<boolean>(false);
  const ratingPopRef = useRef<HTMLDivElement>(null);
  const genresMeasureRef = useRef<HTMLDivElement>(null);
  const synopsisFullMeasureRef = useRef<HTMLParagraphElement>(null);
  const synopsisClampMeasureRef = useRef<HTMLParagraphElement>(null);
  const [visibleGenreCount, setVisibleGenreCount] = useState<number>(animeGenres.length);
  const [isSynopsisOverflowing, setIsSynopsisOverflowing] = useState<boolean>(false);

  useEffect(() => {
    setVisibleGenreCount(animeGenres.length);
  }, [anime.id, animeGenres.length]);

  useEffect(() => {
    const fullEl = synopsisFullMeasureRef.current;
    const clampEl = synopsisClampMeasureRef.current;
    if (!fullEl || !clampEl || !anime.description) {
      setIsSynopsisOverflowing(false);
      return;
    }

    const checkSynopsisOverflow = () => {
      if (!synopsisFullMeasureRef.current || !synopsisClampMeasureRef.current) return;
      const fullHeight = synopsisFullMeasureRef.current.scrollHeight;
      const clampedHeight = synopsisClampMeasureRef.current.clientHeight;
      setIsSynopsisOverflowing(fullHeight > clampedHeight + 2);
    };

    checkSynopsisOverflow();
    const observer = new ResizeObserver(() => {
      checkSynopsisOverflow();
    });
    observer.observe(fullEl);
    observer.observe(clampEl);
    window.addEventListener('resize', checkSynopsisOverflow);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', checkSynopsisOverflow);
    };
  }, [anime.id, anime.description]);

  useEffect(() => {
    const el = genresMeasureRef.current;
    if (!el || animeGenres.length === 0) {
      setVisibleGenreCount(animeGenres.length);
      return;
    }

    const computeVisibleGenres = () => {
      const containerWidth = el.clientWidth;
      if (!containerWidth) return;
      const children = Array.from(el.children) as HTMLElement[];
      let count = 0;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.offsetLeft + child.offsetWidth <= containerWidth + 1) {
          count++;
        } else {
          break;
        }
      }
      setVisibleGenreCount(Math.max(1, count));
    };

    computeVisibleGenres();
    const observer = new ResizeObserver(() => {
      computeVisibleGenres();
    });
    observer.observe(el);
    window.addEventListener('resize', computeVisibleGenres);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', computeVisibleGenres);
    };
  }, [anime.id, animeGenres]);

  const visibleCoverGenres = animeGenres.slice(0, visibleGenreCount);
  const hiddenCoverGenres = animeGenres.slice(visibleGenreCount);

  useEffect(() => {
    setIsInfoOpen(false);
    setRatingStats(getAnimeRatingStats(anime.id));
    const handleRatingUpdate = (e: Event) => {
      const customEv = e as CustomEvent;
      if (!customEv.detail?.animeId || customEv.detail.animeId === anime.id) {
        setRatingStats(getAnimeRatingStats(anime.id));
      }
    };
    window.addEventListener('kh_rating_updated', handleRatingUpdate);
    return () => window.removeEventListener('kh_rating_updated', handleRatingUpdate);
  }, [anime.id]);

  useEffect(() => {
    if (!isRatingOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ratingPopRef.current && !ratingPopRef.current.contains(e.target as Node)) {
        setIsRatingOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isRatingOpen]);

  const handleVoteRating = (score: number) => {
    if (!auth?.currentUser) {
      window.dispatchEvent(new CustomEvent('kh_open_auth_modal', { detail: { mode: 'register' } }));
      return;
    }
    const { stats, error } = submitAnimeVote(anime.id, score);
    if (!error && stats) {
      setRatingStats(stats);
    }
  };

  return (
    <div className="relative min-h-screen text-white overflow-x-hidden pb-12">
      {/* Immersive Cover Photo: Solo en tema violeta oscuro (en tema negro no sale la imagen de fondo) */}
      {appTheme !== 'black' && (
        <div className="absolute inset-0 w-full h-full pointer-events-none z-0 overflow-hidden select-none">
          {imageSrc && (
            <img
              src={imageSrc}
              alt={anime.name}
              loading="eager"
              decoding="async"
              referrerPolicy="no-referrer"
              className={`w-full h-full object-cover object-center transition-opacity duration-700 ${
                isLoaded ? 'opacity-100' : 'opacity-0'
              }`}
            />
          )}
          {/* Cinematic gradient & dark overlay to guarantee 100% legibility of text, buttons and cards */}
          <div className="absolute inset-0 bg-black/60" />
          <div className="absolute inset-0 bg-gradient-to-t from-[#09060f] via-[#09060f]/75 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-b from-black/80 via-transparent to-[#09060f]/90" />
        </div>
      )}

      {/* Hero Cover Banner: same size as Más Populares */}
      <div className="max-w-[1500px] 2xl:max-w-[1800px] 3xl:max-w-[2100px] mx-auto w-full z-10">
        <div className="relative w-full rounded-t-none rounded-b-2xl sm:rounded-b-3xl overflow-hidden bg-[#090514] border-t-0 border-x border-b border-[#2b1747] shadow-xl shadow-black/70 aspect-[4/5.9] xs:aspect-[3/4.8] sm:aspect-[16/12.8] md:aspect-[16/11.2] lg:aspect-[16/9.8] min-h-[575px] sm:min-h-[645px] md:min-h-[680px] max-h-[820px] flex flex-col justify-end">
          {/* Smaller Floating Back Button on top-left of the big cover */}
          <button
            type="button"
            onClick={onBack}
            aria-label="Volver a la galería"
            title="Volver"
            className="group absolute top-3 left-3 sm:top-4 sm:left-4 z-20 inline-flex items-center justify-center text-neutral-300 hover:text-white transition-all duration-200 cursor-pointer touch-manipulation active:scale-95 bg-black/60 hover:bg-black/85 backdrop-blur-md w-8 h-8 sm:w-9 sm:h-9 rounded-full border border-white/15 hover:border-purple-500/60 shadow-lg select-none"
          >
            <ArrowLeft className="h-4 w-4 sm:h-4.5 sm:w-4.5 transition-transform duration-200 group-hover:-translate-x-0.5 shrink-0 text-white" />
          </button>

          {/* Full Anime Cover Artwork inside the frame */}
          <div className="absolute inset-0 w-full h-full pointer-events-none overflow-hidden select-none">
            <SmartAnimeCover
              anime={anime}
              studioName={studio?.name || 'Estudio'}
              alt={anime.name}
              priority={true}
              loading="eager"
              className="w-full h-full object-cover object-[center_top] sm:object-[center_12%]"
            />
          </div>

          {/* Hero Content Overlay: stronger uniform fade covering buttons, synopsis, genres, title, and reaching strongly over the studio with a smooth feather */}
          <div className="relative z-10 w-full px-3.5 sm:px-5 md:px-6 pb-2 sm:pb-2.5 md:pb-3 pt-4 sm:pt-5 pointer-events-auto">
            <div className="absolute inset-x-0 bottom-0 -top-14 sm:-top-16 bg-[linear-gradient(to_top,rgba(9,5,20,0.9)_0%,rgba(9,5,20,0.84)_50%,rgba(9,5,20,0.72)_66%,rgba(9,5,20,0.46)_78%,rgba(9,5,20,0.22)_88%,rgba(9,5,20,0.07)_95%,transparent_100%)] pointer-events-none -z-10" />

            <div className="flex flex-col justify-end space-y-1 sm:space-y-1.5 w-full max-w-2xl">
              {/* 1. Studio / Studios above Title: no individual pill fade, positioned slightly closer above the title */}
              <div className="mb-0.5 select-none">
                {animeStudios.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5 w-fit">
                    {animeStudios.map((st, idx) => (
                      <React.Fragment key={st.id}>
                        <button
                          type="button"
                          onClick={() => {
                            if (onSelectStudio) {
                              onSelectStudio(st.id);
                            }
                          }}
                          className="inline-flex items-center w-fit font-mono text-[10.5px] sm:text-xs font-semibold text-[#c084fc] uppercase tracking-wider leading-tight hover:underline hover:text-purple-300 transition-colors cursor-pointer text-left drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]"
                          title={`Ver todas las portadas de ${st.name}`}
                        >
                          {st.name}
                        </button>
                        {idx < animeStudios.length - 1 && (
                          <span className="text-neutral-300 font-mono text-[10.5px] sm:text-xs drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">/</span>
                        )}
                      </React.Fragment>
                    ))}
                  </div>
                ) : studio ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (onSelectStudio) {
                        onSelectStudio(studio.id);
                      }
                    }}
                    className="inline-flex items-center w-fit font-mono text-[10.5px] sm:text-xs font-semibold text-[#c084fc] uppercase tracking-wider leading-tight hover:underline hover:text-purple-300 transition-colors cursor-pointer text-left drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]"
                    title={`Ver todas las portadas de ${studio.name}`}
                  >
                    {studio.name}
                  </button>
                ) : (
                  <span className="inline-flex items-center w-fit font-mono text-[10.5px] sm:text-xs font-semibold text-[#c084fc] uppercase tracking-wider leading-tight drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">
                    ESTUDIO INDEPENDIENTE
                  </span>
                )}
              </div>

              {/* 2. Anime Title inside photo: strictly 1 single line, native text selection enabled for mobile long-press and PC drag */}
              <h1
                style={{ WebkitUserSelect: 'text', userSelect: 'text' }}
                className="text-base sm:text-xl md:text-2xl font-display font-bold text-white tracking-tight leading-snug drop-shadow truncate max-w-full select-text cursor-text"
                title={anime.name}
              >
                {anime.name}
              </h1>

              {/* 3. Genres inside photo: Single line showing all genres that fit cleanly at a glance */}
              {animeGenres.length > 0 && (
                <div className="relative w-full select-none">
                  {/* Hidden measurement row to calculate how many genres fit in 1 single line without clipping */}
                  <div
                    ref={genresMeasureRef}
                    aria-hidden="true"
                    className="invisible pointer-events-none h-0 overflow-hidden flex items-center gap-1 flex-nowrap whitespace-nowrap w-full"
                  >
                    {animeGenres.map((genre) => (
                      <span
                        key={`measure-${genre.id}`}
                        className="px-1.5 py-0.5 rounded-md border text-[8px] sm:text-[9px] font-mono uppercase tracking-wider shrink-0"
                      >
                        {genre.name}
                      </span>
                    ))}
                  </div>

                  {/* Visible genres at a glance on 1 line */}
                  <div className="flex items-center gap-1 flex-nowrap overflow-hidden whitespace-nowrap max-w-full py-0.5">
                    {visibleCoverGenres.map((genre) => (
                      <button
                        key={genre.id}
                        type="button"
                        onClick={() => {
                          if (onSelectGenre) {
                            onSelectGenre(genre.id);
                          }
                        }}
                        className="px-1.5 py-0.5 rounded-md bg-[#1a0f30]/85 hover:bg-purple-900/90 backdrop-blur-sm border border-purple-400/30 hover:border-purple-400/70 text-[8px] sm:text-[9px] font-mono text-purple-200 hover:text-white uppercase tracking-wider transition-colors cursor-pointer shrink-0"
                      >
                        {genre.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 4. Synopsis: 2 lines preview; only shows "... ver más" when the synopsis overflows the 2-line preview */}
              {anime.description && (
                <div
                  onClick={() => {
                    if (isSynopsisOverflowing) {
                      setIsInfoOpen(true);
                    }
                  }}
                  className={`relative max-w-lg select-none ${
                    isSynopsisOverflowing ? 'cursor-pointer group/syn' : ''
                  }`}
                  title={isSynopsisOverflowing ? 'Toca para ver la sinopsis completa' : undefined}
                >
                  {/* Hidden elements to accurately measure whether synopsis exceeds 2 lines */}
                  <p
                    ref={synopsisFullMeasureRef}
                    aria-hidden="true"
                    className="invisible pointer-events-none absolute inset-x-0 top-0 -z-20 text-[11px] sm:text-xs font-sans leading-snug"
                  >
                    {anime.description}
                  </p>
                  <p
                    ref={synopsisClampMeasureRef}
                    aria-hidden="true"
                    className="invisible pointer-events-none absolute inset-x-0 top-0 -z-20 text-[11px] sm:text-xs font-sans leading-snug line-clamp-2"
                  >
                    {anime.description}
                  </p>

                  <p
                    className={`text-[11px] sm:text-xs text-neutral-300/95 font-sans leading-snug line-clamp-2 drop-shadow ${
                      isSynopsisOverflowing ? 'pr-14' : ''
                    }`}
                  >
                    {anime.description}
                  </p>
                  {isSynopsisOverflowing && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsInfoOpen(true);
                      }}
                      className="absolute bottom-0 right-0 pl-4 bg-gradient-to-l from-[#090514]/90 via-[#090514]/80 to-transparent text-[11px] sm:text-xs font-sans font-bold text-purple-300 group-hover/syn:text-white transition-colors cursor-pointer leading-snug"
                    >
                      ... <span className="underline">ver más</span>
                    </button>
                  )}
                </div>
              )}

              {/* 5. Last Row: Year, Status, Rating, + (Mi Lista), Eye (Visto), and Download icon-only button positioned closer to the bottom edge */}
              <div className="flex items-center gap-1.5 sm:gap-2 pt-0.5 flex-nowrap overflow-x-auto scrollbar-none whitespace-nowrap select-none max-w-full">
                {/* Year */}
                {anime.year && (
                  <div className="flex items-center justify-center shrink-0 pr-0.5">
                    <span className="font-sans text-[11px] sm:text-xs font-extrabold text-white tracking-tight leading-none drop-shadow">
                      {normalizeAnimeYear(anime.year)}
                    </span>
                  </div>
                )}

                {/* Status Badge */}
                <div className="shrink-0 flex items-center">
                  <span className={`h-6 sm:h-7 px-1.5 sm:px-2 rounded-lg text-[9px] sm:text-[10px] font-sans font-bold tracking-tight border inline-flex items-center justify-center leading-none shadow-sm ${
                    isEmision 
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 shadow-emerald-500/10' 
                      : 'bg-neutral-800/80 text-neutral-200 border-neutral-700/60 shadow-sm'
                  }`}>
                    {statusLabel}
                  </span>
                </div>

                {/* Rating Box Button */}
                <div className="shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      if (!auth?.currentUser) {
                        window.dispatchEvent(new CustomEvent('kh_open_auth_modal', { detail: { mode: 'register' } }));
                        return;
                      }
                      setIsRatingOpen(true);
                    }}
                    title="Calificar anime"
                    className="h-7 sm:h-8 px-2 sm:px-2.5 rounded-xl bg-[#161226]/90 hover:bg-[#201938] border border-[#2e214d] hover:border-purple-500/60 backdrop-blur-md shadow-sm inline-flex items-center gap-1 cursor-pointer active:scale-95 transition-all duration-200 group shrink-0"
                  >
                    <Star 
                      className={`h-3 w-3 sm:h-3.5 sm:w-3.5 transition-colors shrink-0 ${
                        ratingStats.userVote ? 'text-amber-400 fill-amber-400' : 'text-neutral-300 group-hover:text-white'
                      }`} 
                      strokeWidth={1.8} 
                    />
                    <span className="font-mono text-[9.5px] sm:text-[10.5px] font-bold text-white leading-none">
                      {ratingStats.average > 0 ? ratingStats.average.toFixed(1) : '0.0'}
                    </span>
                  </button>
                </div>

                {/* Mi Lista Button: ONLY "+" / Check Icon */}
                {onToggleMyList && (
                  <div className="shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        if (!auth?.currentUser) {
                          window.dispatchEvent(new CustomEvent('kh_open_auth_modal', { detail: { mode: 'register' } }));
                          return;
                        }
                        onToggleMyList(anime.id);
                      }}
                      title={isSaved ? "Quitar de mi lista" : "Agregar a mi lista"}
                      aria-label={isSaved ? "Quitar de mi lista" : "Agregar a mi lista"}
                      className={`h-7 w-7 sm:h-8 sm:w-8 inline-flex items-center justify-center rounded-xl backdrop-blur-md transition-all duration-200 cursor-pointer shadow-sm active:scale-95 shrink-0 ${
                        isSaved
                          ? 'bg-[#1b152e]/90 text-white border border-[#442e6d] shadow-[0_0_10px_rgba(168,85,247,0.2)]'
                          : 'bg-[#161226]/90 hover:bg-[#201938] text-white border border-[#2e214d] hover:border-purple-500/50'
                      }`}
                    >
                      {isSaved ? (
                        <Check className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-emerald-400 stroke-[3] shrink-0" />
                      ) : (
                        <Plus className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-white stroke-[2.5] shrink-0" />
                      )}
                    </button>
                  </div>
                )}

                {/* Visto Button: ONLY Eye Icon */}
                <div className="shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      if (!auth?.currentUser) {
                        window.dispatchEvent(new CustomEvent('kh_open_auth_modal', { detail: { mode: 'register' } }));
                        return;
                      }
                      if (onToggleWatched) {
                        onToggleWatched(anime.id);
                      } else {
                        handleToggleWatched();
                      }
                    }}
                    title={(isWatchedProp !== undefined ? isWatchedProp : isWatched) ? "Marcar como no visto" : "Marcar como visto"}
                    aria-label={(isWatchedProp !== undefined ? isWatchedProp : isWatched) ? "Marcar como no visto" : "Marcar como visto"}
                    className={`h-7 w-7 sm:h-8 sm:w-8 inline-flex items-center justify-center rounded-xl backdrop-blur-md transition-all duration-200 cursor-pointer shadow-sm active:scale-95 shrink-0 ${
                      (isWatchedProp !== undefined ? isWatchedProp : isWatched)
                        ? 'bg-[#1e1537]/90 text-purple-200 border border-purple-500/60 shadow-[0_0_10px_rgba(168,85,247,0.25)]'
                        : 'bg-[#161226]/90 hover:bg-[#201938] text-white border border-[#2e214d] hover:border-purple-500/50'
                    }`}
                  >
                    {(isWatchedProp !== undefined ? isWatchedProp : isWatched) ? (
                      <Eye className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-purple-400 stroke-[2] shrink-0" />
                    ) : (
                      <EyeOff className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-neutral-300 stroke-[2] shrink-0" />
                    )}
                  </button>
                </div>

                {/* Download Button: Direct Download by default */}
                {!isUpcoming && (
                  <div className="shrink-0">
                    <a
                      href={
                        anime.telegramUrl || 
                        currentEpisode?.telegramUrl || 
                        currentEpisode?.videoUrl || 
                        currentEpisode?.mp4Url || 
                        currentEpisode?.url || 
                        '#'
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Abrir enlace de Telegram / Video"
                      aria-label="Abrir enlace de Telegram / Video"
                      onClick={() => {
                        if (onDownload) {
                          onDownload(anime.id);
                        }
                      }}
                      className="h-7 w-7 sm:h-8 sm:w-8 inline-flex items-center justify-center rounded-xl bg-[#ff3366] hover:bg-[#ff1f57] text-white transition-all duration-200 shadow-md shadow-[#ff3366]/35 active:scale-95 cursor-pointer shrink-0"
                    >
                      <Download className="h-3.5 w-3.5 sm:h-4 sm:w-4 stroke-[2.5] shrink-0" />
                    </a>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Content Container below the cover */}
      <div className="relative max-w-5xl lg:max-w-6xl xl:max-w-7xl 2xl:max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 pt-4 sm:pt-5 z-10">
        <div className="space-y-4">
            {/* Crunchyroll-style Anime Rating Modal Window */}
            <AnimeRatingModal
              isOpen={isRatingOpen}
              onClose={() => setIsRatingOpen(false)}
              anime={anime}
              studioName={studio?.name}
            />

            {/* Ventana Flotante de la Sinopsis Completa (al tocar "ver más") */}
            {typeof document !== 'undefined' &&
              createPortal(
                <AnimatePresence>
                  {isInfoOpen && (
                    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-3 sm:p-4 overflow-y-auto no-swipe">
                      {/* Backdrop */}
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={() => setIsInfoOpen(false)}
                        className="fixed inset-0 bg-black/85 backdrop-blur-md cursor-pointer"
                      />

                      {/* Synopsis Modal Content */}
                      <motion.div
                        initial={{ opacity: 0, scale: 0.94, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.94, y: 10 }}
                        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                        className="relative z-10 w-full max-w-md bg-[#0c0817] border border-[#2b1847] rounded-3xl p-5 sm:p-6 shadow-2xl space-y-4 my-auto text-white"
                      >
                        {/* Modal Header with Full Anime Title */}
                        <div className="flex items-start justify-between gap-3 border-b border-white/10 pb-3">
                          <div className="space-y-1.5 min-w-0">
                            <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-purple-500/15 border border-purple-500/35 text-purple-300 text-[10px] font-mono font-bold uppercase tracking-wider">
                              <Info className="w-3 h-3 text-purple-400" />
                              <span>Sinopsis</span>
                            </div>
                            <h2
                              style={{ WebkitUserSelect: 'text', userSelect: 'text' }}
                              className="font-display font-bold text-base sm:text-lg text-white leading-snug whitespace-normal break-words select-text cursor-text"
                            >
                              {anime.name}
                            </h2>
                          </div>
                          <button
                            type="button"
                            onClick={() => setIsInfoOpen(false)}
                            className="p-1.5 text-neutral-400 hover:text-white rounded-full hover:bg-white/10 transition-colors cursor-pointer shrink-0"
                            title="Cerrar"
                          >
                            <X className="h-5 w-5" />
                          </button>
                        </div>

                        {/* Hidden/Overflow Genres: ONLY shown if there are genres that do not appear at a glance on the cover */}
                        {hiddenCoverGenres.length > 0 && (
                          <div className="space-y-1.5">
                            <span className="block font-mono text-[10px] text-neutral-400 uppercase tracking-widest">
                              Más géneros
                            </span>
                            <div className="flex flex-wrap items-center gap-1.5">
                              {hiddenCoverGenres.map((genre) => (
                                <button
                                  key={genre.id}
                                  type="button"
                                  onClick={() => {
                                    setIsInfoOpen(false);
                                    if (onSelectGenre) {
                                      onSelectGenre(genre.id);
                                    }
                                  }}
                                  className="px-2 py-1 rounded-lg bg-[#1a0f30]/90 hover:bg-purple-900/90 border border-purple-400/35 hover:border-purple-400/80 text-[10px] font-mono text-purple-200 hover:text-white uppercase tracking-wider transition-colors cursor-pointer"
                                >
                                  {genre.name}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Full Sinopsis Text */}
                        <div className="max-h-72 overflow-y-auto bg-[#140d24] border border-white/10 rounded-2xl p-4 text-xs sm:text-sm text-neutral-200 font-sans leading-relaxed scrollbar-thin scrollbar-thumb-purple-900/60 shadow-inner whitespace-pre-line">
                          {anime.description || 'No hay descripción disponible para esta obra en el archivo.'}
                        </div>
                      </motion.div>
                    </div>
                  )}
                </AnimatePresence>,
                document.body
              )}

            {/* Sección de Episodios / Coming soon */}
            <div className="space-y-2 pt-1">
              <div className="flex items-center">
                <h3 className="font-mono text-[10px] text-neutral-400 uppercase tracking-widest">
                  {isUpcoming ? 'Coming soon' : `${displayEpisodes.length} ${displayEpisodes.length === 1 ? 'Episodio' : 'Episodios'}`}
                </h3>
              </div>

              {displayEpisodes.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1 sm:gap-1.5 max-w-2xl">
                  {displayEpisodes.map((ep) => {
                    const epCover = ep.thumbnail || ep.coverImage || anime.coverData || anime.image;

                    return (
                      <div
                        key={ep.number}
                        onClick={() => {
                          setActiveEpisodeNum(ep.number);
                          setIsPlayerOpen(true);
                          if (onDownload) {
                            onDownload(anime.id);
                          }
                        }}
                        className="group relative aspect-video w-full rounded-xl overflow-hidden cursor-pointer transition-all duration-200 shadow-md select-none active:scale-[0.98] hover:opacity-95 outline-none border border-purple-900/40"
                      >
                        {/* Episode Thumbnail */}
                        {epCover ? (
                          <img
                            src={epCover}
                            alt={`Episodio ${ep.number}`}
                            loading="eager"
                            decoding="async"
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            onError={(e) => {
                              e.currentTarget.src = getFallbackSvg(anime.name);
                            }}
                          />
                        ) : (
                          <div className="w-full h-full bg-[#150a24] flex items-center justify-center">
                            <Film className="h-6 w-6 text-purple-400/40" />
                          </div>
                        )}

                        {/* Subtle dark gradient overlay */}
                        <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-black/20 pointer-events-none" />

                        {/* Compact, rounded and uniform EP badge */}
                        <div className="absolute top-1.5 left-1.5 h-4.5 min-w-[34px] px-1.5 rounded-full bg-black/80 backdrop-blur-md flex items-center justify-center border border-white/10 shadow-sm">
                          <span className="font-mono text-[8.5px] sm:text-[9px] font-bold text-white tracking-tight uppercase leading-none">
                            EP {ep.number}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="p-4 bg-black/20 border border-dark-border/40 rounded-2xl font-mono text-xs text-neutral-500 text-center">
                  {isUpcoming ? 'Coming soon' : 'Próximamente episodios'}
                </div>
              )}

                  {/* Sección de Spin-off / Secuela / Secuelas (debajo de Episodios, ordenados de menor año a la izquierda a mayor año a la derecha) */}
                  {continuationGroup.linkedAnimes.length > 0 && (
                    <div className="space-y-2 pt-2 mt-2">
                      <div className="flex items-center justify-between">
                        <h3 className="font-mono text-[10px] text-neutral-400 uppercase tracking-widest">
                          {formatContinuationTitle(continuationGroup.type, continuationGroup.linkedAnimes.length)}
                        </h3>
                      </div>

                      <div
                        className={`grid gap-[1.5px] sm:gap-[2px] w-full pt-1 ${
                          continuationGroup.linkedAnimes.length <= 3
                            ? 'grid-cols-3'
                            : 'grid-flow-col auto-cols-fr'
                        }`}
                      >
                        {continuationGroup.linkedAnimes.map((relAnime) => {
                          const relSIds = (relAnime.studioIds && relAnime.studioIds.length > 0)
                            ? relAnime.studioIds
                            : (relAnime.studioId ? [relAnime.studioId] : []);
                          const relStudio = studios.find(s => relSIds.includes(s.id))?.name || 'Estudio';
                          const relYear = normalizeAnimeYear(relAnime.year);
                          const isMany = continuationGroup.linkedAnimes.length > 3;

                          return (
                            <button
                              key={relAnime.id}
                              type="button"
                              onClick={() => {
                                if (onSelectAnime) {
                                  onSelectAnime(relAnime.id);
                                } else {
                                  window.location.href = `/?anime=${relAnime.id}`;
                                }
                              }}
                              onMouseEnter={() => prefetchAnime(relAnime, studios)}
                              onPointerEnter={() => prefetchAnime(relAnime, studios)}
                              onTouchStart={() => prefetchAnime(relAnime, studios)}
                              title={relAnime.name}
                              className="group min-w-0 w-full flex flex-col gap-1 cursor-pointer p-0 text-left"
                            >
                              <div className="relative w-full aspect-[2/3] bg-neutral-900 rounded-xl overflow-hidden border border-[#272236] group-hover:border-purple-500/70 transition-all duration-300 group-hover:scale-[1.03] shadow-md group-hover:shadow-lg group-hover:shadow-purple-500/10">
                                <SmartAnimeCover
                                  anime={relAnime}
                                  studioName={relStudio}
                                  alt={relAnime.name}
                                  loading="eager"
                                  priority={true}
                                  className="w-full h-full object-cover"
                                />
                                {/* Pequeña parte del nombre abajo en la portada */}
                                <div className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent ${isMany ? 'p-1 sm:p-1.5 pt-3' : 'p-1.5 sm:p-2 pt-4'} pointer-events-none`}>
                                  <p className={`font-display ${isMany ? 'text-[10px] sm:text-xs' : 'text-xs sm:text-[13px]'} text-white font-medium truncate group-hover:text-purple-300 transition-colors leading-tight`}>
                                    {relAnime.name}
                                  </p>
                                </div>
                              </div>

                              {/* Año en el que salió debajo de la portada */}
                              {relYear && (
                                <span className={`font-mono ${isMany ? 'text-[9px] sm:text-[10px]' : 'text-[10px] sm:text-[11px]'} text-neutral-400 group-hover:text-purple-300 transition-colors text-center w-full truncate leading-none pt-0.5`}>
                                  {relYear}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Sección de Títulos similares */}
                  {recommendedAnimes.length > 0 && (
                    <div className="space-y-2 pt-2 mt-3">
                      <div className="flex items-center justify-between">
                        <h3 className="font-mono text-[10px] text-neutral-400 uppercase tracking-widest">
                          Títulos similares
                        </h3>
                      </div>

                      <div className="grid grid-cols-3 gap-[1.5px] sm:gap-[2px] w-full pt-1">
                        {recommendedAnimes.map((rec) => {
                          const sIds = (rec.studioIds && rec.studioIds.length > 0)
                            ? rec.studioIds
                            : (rec.studioId ? [rec.studioId] : []);
                          const recStudio = studios.find(s => sIds.includes(s.id))?.name || 'Estudio';

                          return (
                            <button
                              key={rec.id}
                              type="button"
                              onClick={() => {
                                if (onSelectAnime) {
                                  onSelectAnime(rec.id);
                                } else {
                                  window.location.href = `/?anime=${rec.id}`;
                                }
                              }}
                              onMouseEnter={() => prefetchAnime(rec, studios)}
                              onPointerEnter={() => prefetchAnime(rec, studios)}
                              onTouchStart={() => prefetchAnime(rec, studios)}
                              title={rec.name}
                              className="group relative aspect-[2/3] bg-neutral-900 rounded-xl overflow-hidden border border-[#272236] hover:border-brand-red/70 transition-all duration-300 hover:scale-[1.03] shadow-md hover:shadow-lg hover:shadow-brand-red/10 cursor-pointer block p-0 text-left"
                            >
                              <SmartAnimeCover
                                anime={rec}
                                studioName={recStudio}
                                alt={rec.name}
                                loading="eager"
                                priority={true}
                                className="w-full h-full object-cover"
                              />
                              {/* Subtle title overlay at bottom */}
                              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent p-1.5 sm:p-2 pt-4 pointer-events-none">
                                <p className="font-display text-xs sm:text-[13px] text-white font-medium truncate group-hover:text-brand-red transition-colors leading-tight">
                                  {rec.name}
                                </p>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Capa Flotante del Reproductor Interno de Video (Modal Portal en centro de pantalla) */}
                  {createPortal(
                    <AnimatePresence>
                      {isPlayerOpen && currentEpisode && (
                        <motion.div
                          key="video-player-backdrop"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.14, ease: "easeOut" }}
                          className="fixed inset-0 z-[99999] flex items-center justify-center p-2.5 sm:p-4 bg-black/90 touch-pan-y"
                        >
                          {/* Control de Cierre al tocar el fondo */}
                          <div 
                            className="absolute inset-0 z-0" 
                            onClick={() => setIsPlayerOpen(false)} 
                          />

                          <motion.div
                            key="video-player-card"
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            transition={{ duration: 0.16, ease: "easeOut" }}
                            style={{ willChange: 'transform, opacity' }}
                            className={`relative z-10 w-full ${isPlayerExpanded ? 'max-w-[96vw]' : 'max-w-5xl lg:max-w-6xl xl:max-w-7xl 2xl:max-w-[1500px]'} bg-neutral-950 border-0 rounded-2xl p-2.5 sm:p-4 shadow-2xl flex flex-col gap-2.5 max-h-[95vh] overflow-y-auto my-auto touch-pan-y outline-none`}
                          >
                        
                        {/* Encabezado Limpio del Reproductor: Título y Controles del Pantalla Completa */}
                        <div className="flex items-center justify-between pb-2 border-b border-white/10 px-1">
                          <div className="min-w-0 flex items-center gap-2">
                            <h2 className="font-display text-sm sm:text-base font-semibold text-white truncate leading-tight">
                              {anime.name}
                            </h2>
                            <span className="shrink-0 px-2 py-0.5 rounded-md bg-purple-950/80 border border-purple-800/60 font-mono text-[10px] font-bold text-purple-300">
                              EP #{currentEpisode?.number || 1}
                            </span>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            {/* Botón Pantalla Completa Limpia */}
                            <button
                              type="button"
                              onClick={toggleFullscreen}
                              className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors cursor-pointer"
                              title={isFullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
                            >
                              {isFullscreen ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
                            </button>

                            {/* Botón de Cierre */}
                            <button
                              type="button"
                              onClick={() => {
                                if (document.fullscreenElement) {
                                  document.exitFullscreen().catch(() => {});
                                }
                                setIsPlayerOpen(false);
                              }}
                              className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors cursor-pointer"
                              title="Cerrar reproductor"
                            >
                              <X className="h-5 w-5" />
                            </button>
                          </div>
                        </div>

                        {/* Contenedor del Reproductor con Barras Negras Tipo Cine / Más Cuadrado y Limpio */}
                        <div 
                          ref={playerWrapperRef}
                          className={`relative w-full ${
                            isFullscreen
                              ? 'fixed inset-0 z-[100000] w-screen h-screen rounded-none border-0 p-0 m-0 bg-black'
                              : isPlayerExpanded 
                                ? 'max-h-[85vh] aspect-[4/3] sm:aspect-[16/10] lg:aspect-[16/10] mx-auto rounded-2xl border-0 shadow-2xl' 
                                : 'aspect-[4/3] sm:aspect-[16/10] lg:aspect-[16/10] rounded-2xl border-0 shadow-2xl'
                          } bg-black overflow-hidden flex flex-col items-center justify-center select-none group border-0 outline-none`}
                        >
                          {/* Botón Flotante para Salir de Pantalla Completa en overlay */}
                          {isFullscreen && (
                            <div className="absolute top-4 right-4 z-50 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center gap-2 bg-black/80 backdrop-blur-md px-3 py-1.5 rounded-xl border border-neutral-800">
                              <span className="text-xs text-white font-medium">{anime.name} - Ep {currentEpisode?.number || 1}</span>
                              <button
                                type="button"
                                onClick={toggleFullscreen}
                                className="p-1 rounded-lg text-neutral-300 hover:text-white hover:bg-neutral-800 transition-colors cursor-pointer"
                                title="Salir de pantalla completa"
                              >
                                <Minimize2 className="h-4 w-4" />
                              </button>
                            </div>
                          )}

                          <div className="w-full h-full flex flex-col justify-center items-center bg-black relative overflow-hidden p-0 m-0 border-0 outline-none">
                            {isTelegramUrl ? (
                              <div className="w-full h-full flex flex-col items-center justify-center p-6 bg-[#0a0712] text-center space-y-4">
                                <div className="w-16 h-16 rounded-2xl bg-[#0088cc]/20 border border-[#0088cc]/40 flex items-center justify-center text-[#0088cc] shadow-lg shadow-[#0088cc]/10">
                                  <Tv className="h-8 w-8" />
                                </div>
                                <div className="space-y-1.5 max-w-md">
                                  <h3 className="font-display font-bold text-white text-base sm:text-lg">
                                    Episodio #{currentEpisode?.number || 1} en Telegram
                                  </h3>
                                  <p className="text-xs text-neutral-400 font-sans leading-relaxed">
                                    Este episodio está alojado directamente en el canal oficial de Telegram para reproducción en streaming o descarga a máxima calidad.
                                  </p>
                                </div>
                                <a
                                  href={rawVideoUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#0088cc] to-[#0099e6] hover:from-[#0099e6] hover:to-[#00aaff] text-white font-mono text-xs font-bold uppercase tracking-wider shadow-lg shadow-[#0088cc]/30 transition-all flex items-center gap-2 cursor-pointer active:scale-95"
                                >
                                  <ExternalLink className="h-4 w-4" />
                                  <span>Abrir en Telegram</span>
                                </a>
                              </div>
                            ) : !rawVideoUrl ? (
                              <div className="w-full h-full flex flex-col items-center justify-center p-6 bg-[#0a0712] text-center space-y-3">
                                <Film className="h-10 w-10 text-neutral-600" />
                                <p className="text-xs text-neutral-400 font-mono">
                                  No hay enlace de video disponible para el Episodio #{currentEpisode?.number || 1}.
                                </p>
                              </div>
                            ) : (
                              <div className="relative w-full h-full flex items-center justify-center bg-black group">
                                <video
                                  ref={videoRef}
                                  key={directVideoUrl + (currentEpisode?.number || 1)}
                                  src={directVideoUrl}
                                  controls
                                  autoPlay
                                  playsInline
                                  preload="auto"
                                  controlsList="noplaybackrate"
                                  onPlay={() => {
                                    setIsVideoPaused(false);
                                    setVideoPlaybackError(false);
                                  }}
                                  onPause={() => setIsVideoPaused(true)}
                                  onError={() => setVideoPlaybackError(true)}
                                  onLoadedMetadata={() => {
                                    if (videoRef.current) {
                                      videoRef.current.play().catch(() => {});
                                    }
                                  }}
                                  style={{ WebkitTouchCallout: 'none', userSelect: 'none' }}
                                  className="w-full aspect-video max-h-full object-contain bg-black select-none pointer-events-auto block m-0 p-0"
                                />

                                {/* Fallback error overlay */}
                                {videoPlaybackError && (
                                  <div className="absolute inset-0 bg-black/90 flex flex-col items-center justify-center p-4 text-center space-y-3 z-30">
                                    <div className="w-12 h-12 rounded-xl bg-red-950/80 border border-red-800/60 flex items-center justify-center text-red-400">
                                      <Film className="h-6 w-6" />
                                    </div>
                                    <p className="text-xs text-neutral-300 font-mono max-w-sm">
                                      No se pudo reproducir automáticamente el video del Episodio #{currentEpisode?.number || 1}.
                                    </p>
                                    <div className="flex items-center gap-2 pt-1">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setVideoPlaybackError(false);
                                          if (videoRef.current) {
                                            videoRef.current.load();
                                            videoRef.current.play().catch(() => {});
                                          }
                                        }}
                                        className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-mono font-bold cursor-pointer transition-all active:scale-95 shadow-md"
                                      >
                                        Reintentar
                                      </button>
                                      <a
                                        href={directVideoUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-mono cursor-pointer transition-all"
                                      >
                                        Abrir enlace directo
                                      </a>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Lista de Episodios en Cuadrícula de 2 Columnas */}
                        <div className="space-y-2 pt-1">
                          <div className="flex items-center justify-between">
                            <span className="font-mono text-[9.5px] text-neutral-400 uppercase tracking-widest">
                              {isUpcoming ? 'Coming soon' : `EPISODIOS (${displayEpisodes.length})`}
                            </span>
                          </div>

                          {/* Cuadrícula de 2 Columnas */}
                          <div className="grid grid-cols-2 gap-1 sm:gap-1.5 max-h-56 overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-purple-900/60 scrollbar-track-transparent">
                            {displayEpisodes.map((ep) => {
                              const isActive = ep.number === (currentEpisode?.number || 1);
                              const epCover = ep.thumbnail || ep.coverImage || anime.coverData || anime.image;

                              return (
                                <div
                                  key={ep.number}
                                  onClick={() => setActiveEpisodeNum(ep.number)}
                                  className="group relative aspect-video w-full rounded-xl overflow-hidden cursor-pointer transition-all duration-200 shadow-md select-none active:scale-[0.98] hover:opacity-95 border-0 outline-none"
                                >
                                  {epCover ? (
                                    <img
                                      src={epCover}
                                      alt={`Episodio ${ep.number}`}
                                      className="w-full h-full object-cover"
                                      onError={(e) => {
                                        e.currentTarget.src = getFallbackSvg(anime.name);
                                      }}
                                    />
                                  ) : (
                                    <div className="w-full h-full bg-[#150a24] flex items-center justify-center">
                                      <Film className="h-6 w-6 text-purple-400/40" />
                                    </div>
                                  )}

                                  <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-black/20 pointer-events-none" />

                                  <div className="absolute top-1.5 left-1.5 h-4.5 min-w-[34px] px-1.5 rounded-full bg-black/80 backdrop-blur-md flex items-center justify-center border border-white/10 shadow-sm">
                                    <span className="font-mono text-[8.5px] sm:text-[9px] font-bold text-white tracking-tight uppercase leading-none">
                                      EP {ep.number}
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>

                          </motion.div>
                        </motion.div>
                      )}
                    </AnimatePresence>,
                    document.body
                  )}
                </div>
              </div>

          {/* Global Comments Section for this Anime (deferred for 60fps entrance) */}
          <div className="mt-8">
            {showDeferredSections ? (
              <GlobalComments 
                animeId={anime.id} 
                animeTitle={anime.name} 
                className="bg-black/60 backdrop-blur-md border border-white/10 rounded-2xl p-4 sm:p-6 shadow-xl" 
              />
            ) : (
              <div className="p-6 bg-black/40 border border-white/5 rounded-2xl flex items-center justify-center">
                <span className="font-mono text-xs text-neutral-500">Cargando comentarios...</span>
              </div>
            )}
          </div>
        </div>
      </div>
  );
}
