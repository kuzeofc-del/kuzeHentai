import React, { useState, useEffect, useRef } from 'react';
import { Anime } from '../types';
import { saveCoverToIDB, getAllCoversFromIDB } from '../lib/idbStorage';

// In-memory lookup map for active session
export const globalCoverDataMap = new Map<string, string>();

// Inline SVG generator for front-end fallback (100% fail-proof encoding)
export function getFallbackSvg(title?: string, studioName?: string): string {
  const cleanTitle = (title || 'Anime').replace(/["'<>]/g, '');
  const cleanStudio = (studioName || 'Estudio').replace(/["'<>]/g, '');
  
  const colors = [
    { start: '#120808', end: '#2a0a0a', accent: '#ff3333' },
    { start: '#080c14', end: '#101828', accent: '#4d79ff' },
    { start: '#121212', end: '#222222', accent: '#e0e0e0' },
    { start: '#140f08', end: '#2d1d05', accent: '#ffaa00' },
  ];
  const color = colors[Math.abs(cleanTitle.length) % colors.length];

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 600" width="100%" height="100%">
    <defs>
      <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${color.start}"/>
        <stop offset="100%" stop-color="${color.end}"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <rect x="15" y="15" width="370" height="570" fill="none" stroke="#2a2a2a" stroke-width="2"/>
    <rect x="25" y="25" width="350" height="550" fill="none" stroke="${color.accent}" stroke-opacity="0.35" stroke-width="1" stroke-dasharray="8 4"/>
    
    <line x1="50" y1="120" x2="350" y2="120" stroke="#333" stroke-width="1" />
    <line x1="50" y1="480" x2="350" y2="480" stroke="#333" stroke-width="1" />
    
    <circle cx="200" cy="200" r="60" fill="none" stroke="${color.accent}" stroke-opacity="0.8" stroke-width="1.5"/>
    <circle cx="200" cy="200" r="45" fill="none" stroke="#333" stroke-width="1"/>
    <line x1="200" y1="120" x2="200" y2="280" stroke="${color.accent}" stroke-opacity="0.5" stroke-width="1"/>
    
    <text x="200" y="60" font-family="-apple-system, BlinkMacSystemFont, 'Inter', sans-serif" font-size="10" font-weight="600" fill="#888" letter-spacing="4" text-anchor="middle">H KUZE ARCHIVE</text>
    
    <text x="200" y="380" font-family="-apple-system, BlinkMacSystemFont, 'Inter', sans-serif" font-weight="800" font-size="20" fill="#ffffff" letter-spacing="-0.5" text-anchor="middle">${cleanTitle}</text>
    
    <text x="200" y="420" font-family="-apple-system, BlinkMacSystemFont, 'Inter', sans-serif" font-size="13" font-weight="500" fill="${color.accent}" letter-spacing="2" text-anchor="middle">${cleanStudio.toUpperCase()}</text>
    
    <text x="200" y="540" font-family="-apple-system, BlinkMacSystemFont, 'Inter', sans-serif" font-size="9" fill="#666" letter-spacing="1" text-anchor="middle">SPEC. ARTWORK // FALLBACK</text>
  </svg>`;
  
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// Generate dominant placeholder gradient for zero-layout-shift and blur-up
export function getDominantPlaceholderGradient(title?: string, id?: string): string {
  const str = (id || title || 'default');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const gradients = [
    'from-[#190a2a] via-[#10061e] to-[#0a0414]',
    'from-[#240a1d] via-[#150512] to-[#0a0208]',
    'from-[#0c1329] via-[#080d1e] to-[#040610]',
    'from-[#1a1208] via-[#100b05] to-[#080502]',
    'from-[#180a18] via-[#0f060f] to-[#070307]',
  ];
  return gradients[Math.abs(hash) % gradients.length];
}

export function persistCoverLocally(animeId?: string, src?: string) {
  if (!animeId || !src) return;
  if (src.startsWith('data:image/')) {
    globalCoverDataMap.set(animeId, src);
    globalLoadedAnimeIds.add(animeId);
  }
}

export function optimizeCloudinaryUrl(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';
  if (
    /^https?:\/\/res\.cloudinary\.com\//i.test(trimmed) &&
    trimmed.includes('/image/upload/') &&
    !/\/image\/upload\/[^/]*(?:f_|q_|w_|h_|c_)/.test(trimmed)
  ) {
    return trimmed.replace('/image/upload/', '/image/upload/f_auto,q_auto/');
  }
  return trimmed;
}

export function processImageSrc(anime: Partial<Anime>, studioName: string = 'Estudio'): string {
  try {
    // 1. Explicit external HTTP/HTTPS cover URL (e.g. Cloudinary) always takes top priority for instant CDN loading
    const externalUrl =
      (anime.image && /^https?:\/\//i.test(anime.image.trim()) ? anime.image.trim() : '') ||
      (anime.coverUrl && /^https?:\/\//i.test(anime.coverUrl.trim()) ? anime.coverUrl.trim() : '');
    if (externalUrl) {
      if (anime.id && globalCoverDataMap.has(anime.id)) {
        globalCoverDataMap.delete(anime.id);
      }
      return optimizeCloudinaryUrl(externalUrl);
    }

    // 2. Base64 coverData from current anime object
    if (anime.coverData && anime.coverData.startsWith('data:image/')) {
      if (anime.id && globalCoverDataMap.get(anime.id) !== anime.coverData) {
        globalCoverDataMap.set(anime.id, anime.coverData);
      }
      return anime.coverData;
    }
    if (anime.image && anime.image.startsWith('data:image/')) {
      if (anime.id && globalCoverDataMap.get(anime.id) !== anime.image) {
        globalCoverDataMap.set(anime.id, anime.image);
      }
      return anime.image;
    }

    // 3. Memory Cache fallback when only lightweight anime reference is passed
    if (anime.id && globalCoverDataMap.has(anime.id)) {
      return globalCoverDataMap.get(anime.id)!;
    }

    // 4. Local server cover URL as secondary path (with cache-busting if updatedAt is present)
    if (anime.image && (anime.image.startsWith('/covers/') || anime.image.startsWith('/api/covers/'))) {
      const base = anime.image.trim();
      if (anime.updatedAt && !base.includes('?')) {
        return `${base}?v=${encodeURIComponent(anime.updatedAt)}`;
      }
      return base;
    }
    if (anime.id) {
      return anime.updatedAt
        ? `/covers/${anime.id}.webp?v=${encodeURIComponent(anime.updatedAt)}`
        : `/covers/${anime.id}.webp`;
    }
  } catch (e) {
    console.error("Failed processing image src", e);
  }
  return getFallbackSvg(anime.name, studioName);
}

export const globalImageCache = new Set<string>();
export const globalLoadedAnimeIds = new Set<string>();
export const globalPreloadedImages = new Map<string, HTMLImageElement>();

export function markAnimeCoverLoaded(animeId?: string, src?: string) {
  if (animeId && !globalLoadedAnimeIds.has(animeId)) {
    globalLoadedAnimeIds.add(animeId);
  }
  if (src && !globalImageCache.has(src)) {
    globalImageCache.add(src);
  }
  if (animeId && src) {
    persistCoverLocally(animeId, src);
  }
}

// Background cache in persistent Cache Storage API if available
export async function cacheInCacheStorage(src: string) {
  if (typeof window === 'undefined' || !window.caches || !src || !src.startsWith('/')) return;
  try {
    const cache = await window.caches.open('kh-anime-covers-v1');
    const match = await cache.match(src);
    if (!match) {
      const res = await fetch(src, { cache: 'force-cache' });
      if (res.ok) {
        await cache.put(src, res);
      }
    }
  } catch {}
}

/**
 * Preloads a single anime cover and pins it in browser memory
 */
export function preloadAnimeCover(
  anime: Partial<Anime>, 
  studiosOrStudioName: { id: string; name: string }[] | string = 'Estudio',
  highPriority: boolean = false
): Promise<string> {
  let studioName = 'Estudio';
  if (typeof studiosOrStudioName === 'string') {
    studioName = studiosOrStudioName;
  } else if (Array.isArray(studiosOrStudioName)) {
    const sIds = (anime.studioIds && anime.studioIds.length > 0)
      ? anime.studioIds
      : (anime.studioId ? [anime.studioId] : []);
    studioName = studiosOrStudioName.find(s => sIds.includes(s.id))?.name || 'Estudio';
  }

  const src = processImageSrc(anime, studioName);
  if (!src) return Promise.resolve('');

  if (globalImageCache.has(src) || src.startsWith('data:') || (anime.id && globalLoadedAnimeIds.has(anime.id))) {
    markAnimeCoverLoaded(anime.id, src);
    return Promise.resolve(src);
  }

  if (globalPreloadedImages.has(src)) {
    return Promise.resolve(src);
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    // @ts-ignore
    if (highPriority && 'fetchPriority' in img) img.fetchPriority = 'high';

    img.onload = () => {
      markAnimeCoverLoaded(anime.id, src);
      cacheInCacheStorage(src);
      resolve(src);
    };
    img.onerror = () => {
      if (anime.id && !src.includes(`/covers/${anime.id}.webp`)) {
        const fallbackSrc = `/covers/${anime.id}.webp`;
        const fbImg = new Image();
        fbImg.onload = () => {
          markAnimeCoverLoaded(anime.id, fallbackSrc);
          cacheInCacheStorage(fallbackSrc);
          resolve(fallbackSrc);
        };
        fbImg.onerror = () => resolve(src);
        fbImg.src = fallbackSrc;
        globalPreloadedImages.set(fallbackSrc, fbImg);
        return;
      }
      resolve(src);
    };
    img.src = src;
    globalPreloadedImages.set(src, img);
  });
}

/**
 * Intelligent Hover & Proximity Prefetching:
 * Called on mouseEnter, pointerEnter, or touchStart to preload full images,
 * episodes thumbnails, and metadata in 0ms before the user even clicks!
 */
const prefetchedAnimeIds = new Set<string>();
export function prefetchAnime(
  anime: Partial<Anime>,
  studios: { id: string; name: string }[] = []
) {
  if (!anime || !anime.id || prefetchedAnimeIds.has(anime.id)) return;
  prefetchedAnimeIds.add(anime.id);

  // Preload only the anime main cover (portada del anime) on hover/focus
  preloadAnimeCover(anime, studios, true);
}

/**
 * Bulk preloading disabled so content loads on-demand as user scrolls/navigates
 */
export function preloadAllAnimes(_items: Partial<Anime>[], _studios: { id: string; name: string }[] = []) {
  return;
}

/**
 * Catalog page preloading disabled so content loads on-demand when visible
 */
export function prefetchCatalogPage(
  _items: Partial<Anime>[],
  _pageNumber: number,
  _itemsPerPage: number = 30,
  _studios: { id: string; name: string }[] = []
) {
  return;
}

/**
 * On-demand initial screen loading:
 * Preloads ONLY the above-the-fold hero banner items (first 3-4 items visible on screen).
 * All lower sections and cards load lazily as the user scrolls into view.
 */
export function startPrioritizedAppLoading(
  animes: Partial<Anime>[],
  studios: { id: string; name: string }[] = []
) {
  if (!animes || animes.length === 0) return;

  // Preload only the top visible hero carousel items (first 4)
  const heroItems = animes.slice(0, 4);
  heroItems.forEach(anime => {
    preloadAnimeCover(anime, studios, true);
  });
}

interface SmartAnimeCoverProps {
  anime: Partial<Anime>;
  studioName?: string;
  className?: string;
  alt?: string;
  loading?: 'eager' | 'lazy';
  priority?: boolean;
}

export function SmartAnimeCover({ 
  anime, 
  studioName = 'Estudio', 
  className = 'w-full h-full object-cover', 
  alt = '',
  loading = 'lazy',
  priority = false
}: SmartAnimeCoverProps) {
  const initialSrc = processImageSrc(anime, studioName);
  const [imageSrc, setImageSrc] = useState<string>(initialSrc);
  const [retryCount, setRetryCount] = useState<number>(0);
  const [hasFailed, setHasFailed] = useState<boolean>(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  
  // Instant resolution if already in memory cache, localStorage loaded IDs, IndexedDB map, or preloaded
  const isInstant = Boolean(
    initialSrc.startsWith('data:') || 
    (anime.id && globalCoverDataMap.has(anime.id)) ||
    globalImageCache.has(initialSrc) || 
    (anime.id && globalLoadedAnimeIds.has(anime.id))
  );
  const [isLoaded, setIsLoaded] = useState<boolean>(isInstant);

  // Dominant color placeholder gradient
  const placeholderGradient = getDominantPlaceholderGradient(anime.name, anime.id);

  const propSourceKey = `${anime.id || ''}|${anime.image || ''}|${anime.coverUrl || ''}|${anime.coverData || ''}|${anime.updatedAt || ''}|${studioName || ''}`;
  const prevPropSourceKeyRef = useRef<string>(propSourceKey);

  useEffect(() => {
    // If image is already complete and valid in browser cache, mark instantly
    if (imgRef.current && imgRef.current.complete && imgRef.current.naturalWidth > 0) {
      markAnimeCoverLoaded(anime.id, imageSrc);
      setIsLoaded(prev => (prev ? prev : true));
    }
  }, [imageSrc, anime.id]);

  useEffect(() => {
    if (prevPropSourceKeyRef.current !== propSourceKey) {
      prevPropSourceKeyRef.current = propSourceKey;
      const src = processImageSrc(anime, studioName);
      setImageSrc(src);
      setRetryCount(0);
      setHasFailed(false);
      const instant = src.startsWith('data:') || globalImageCache.has(src) || (anime.id ? globalLoadedAnimeIds.has(anime.id) : false);
      setIsLoaded(Boolean(instant));
    }
  }, [propSourceKey, anime, studioName]);

  const handleLoad = () => {
    markAnimeCoverLoaded(anime.id, imageSrc);
    setIsLoaded(prev => (prev ? prev : true));
    setHasFailed(prev => (prev ? false : prev));
  };

  const handleError = () => {
    if (retryCount === 0 && anime.id) {
      const nextSrc = `/covers/${anime.id}.webp`;
      if (imageSrc !== nextSrc) {
        setRetryCount(1);
        setImageSrc(nextSrc);
        if (globalImageCache.has(nextSrc) || globalLoadedAnimeIds.has(anime.id)) {
          setIsLoaded(prev => (prev ? prev : true));
        }
        return;
      }
    }
    if (retryCount <= 1 && anime.coverData && anime.coverData.startsWith('data:image/')) {
      if (imageSrc !== anime.coverData) {
        setRetryCount(2);
        setImageSrc(anime.coverData);
        setIsLoaded(prev => (prev ? prev : true));
        return;
      }
    }
    if (retryCount <= 2 && anime.id) {
      const nextSrc = `/api/covers/${anime.id}.webp`;
      if (imageSrc !== nextSrc) {
        setRetryCount(3);
        setImageSrc(nextSrc);
        return;
      }
    }
    const svgFallback = getFallbackSvg(anime.name, studioName);
    if (imageSrc !== svgFallback) {
      setImageSrc(svgFallback);
    }
    setIsLoaded(prev => (prev ? prev : true));
    setHasFailed(prev => (prev ? prev : true));
  };

  return (
    <div className={`w-full h-full relative overflow-hidden select-none bg-gradient-to-b ${placeholderGradient}`}>
      {/* Calm, stable dark backdrop without flashing pulse animation */}
      {!isLoaded && !hasFailed && (
        <div className="absolute inset-0 bg-[#0c0517] pointer-events-none flex items-center justify-center">
          <div className="w-full h-full bg-gradient-to-tr from-purple-950/30 via-[#10061f] to-transparent" />
        </div>
      )}

      <img
        ref={imgRef}
        src={imageSrc}
        alt={alt || anime.name || 'Cover'}
        loading={priority ? 'eager' : loading}
        fetchPriority={priority ? 'high' : 'auto'}
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={handleLoad}
        onError={handleError}
        className={`${className} ${
          isInstant 
            ? 'opacity-100' 
            : `transition-opacity duration-200 ease-out ${isLoaded ? 'opacity-100' : 'opacity-0'}`
        }`}
      />
    </div>
  );
}
