import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Anime } from '../types';
import {
  resolveAnimeCoverBase64,
  getSyncCachedPortada,
  isExternalHttpCover,
} from '../lib/coverCache';

export type PortadaSize =
  | 'original'
  | 'tarjeta23'
  | 'nuevos'
  | 'horizontal'
  | 'episodio'
  | 'estudio'
  | 'fondo'
  | 'admin'
  | 'mini';

const CLOUDINARY_TRANSFORM_STRING: Record<Exclude<PortadaSize, 'original'>, string> = {
  tarjeta23: 'ar_2:3,c_lfill,g_center,w_360,q_70,f_auto',
  nuevos: 'ar_16:9,c_lfill,g_north,w_900,q_auto:good,f_auto',
  horizontal: 'ar_16:9,c_lfill,g_north,w_780,q_auto:good,f_auto',
  episodio: 'ar_16:9,c_lfill,g_center,w_500,q_auto:good,f_auto',
  estudio: 'ar_1:1,c_lfill,g_center,w_270,q_auto:good,f_auto',
  fondo: 'w_400,q_auto:eco,f_auto',
  admin: 'w_600,q_auto:good,f_auto',
  mini: 'w_150,q_auto:good,f_auto',
};

const PORTADA_DIMENSIONS: Record<PortadaSize, { width: number; height: number }> = {
  original: { width: 800, height: 1200 },
  tarjeta23: { width: 360, height: 540 },
  nuevos: { width: 900, height: 506 },
  horizontal: { width: 780, height: 439 },
  episodio: { width: 500, height: 281 },
  estudio: { width: 270, height: 270 },
  fondo: { width: 400, height: 600 },
  admin: { width: 600, height: 900 },
  mini: { width: 150, height: 225 },
};

/**
 * Inserts Cloudinary transformations right after /upload/.
 * Only transforms res.cloudinary.com URLs containing /upload/ that don't
 * already have transformations. For 'original', returns the URL completely unchanged.
 */
export function portadaUrl(url: string | undefined | null, tamaño: PortadaSize = 'original'): string {
  if (!url || typeof url !== 'string') return url || '';
  if (tamaño === 'original') return url;

  const trimmed = url.trim();
  if (!trimmed) return '';

  // Only transform res.cloudinary.com URLs containing /upload/
  if (!/^https?:\/\/res\.cloudinary\.com\//i.test(trimmed)) {
    return url;
  }
  const uploadMarker = '/upload/';
  const uploadIdx = trimmed.indexOf(uploadMarker);
  if (uploadIdx === -1) {
    return url;
  }

  const afterUpload = trimmed.slice(uploadIdx + uploadMarker.length);
  if (!afterUpload) return url;

  const firstSlash = afterUpload.indexOf('/');
  const firstSegment = firstSlash === -1 ? afterUpload : afterUpload.slice(0, firstSlash);

  // If the first segment right after /upload/ is not a version (v123456) and looks like
  // existing Cloudinary transformations (no image extension + contains transform tokens), leave untouched
  const isVersionSegment = /^v\d+$/i.test(firstSegment);
  const hasImageExtension = /\.(?:webp|jpe?g|png|gif|avif|svg|bmp|tiff?)(?:[?#].*)?$/i.test(firstSegment);
  const looksLikeCloudinaryTransform =
    !isVersionSegment &&
    !hasImageExtension &&
    /(?:^|,)(?:w|h|c|q|f|g|e|t|l|u|o|r|b|x|y|z|a|d|ar|bo|co|cs|dl|dn|du|eo|fl|fn|if|ki|pg|so|sp|vs|dpr)_/i.test(firstSegment);

  if (looksLikeCloudinaryTransform) {
    return url;
  }

  const transform = CLOUDINARY_TRANSFORM_STRING[tamaño];
  if (!transform) return url;

  return trimmed.slice(0, uploadIdx + uploadMarker.length) + `${transform}/` + afterUpload;
}

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

// Generate dominant placeholder gradient for zero-layout-shift
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

export function processImageSrc(
  anime: Partial<Anime>,
  studioName: string = 'Estudio',
  tamaño: PortadaSize = 'original'
): string {
  try {
    // 1. Explicit external HTTP/HTTPS cover URL (e.g. Cloudinary) always takes top priority
    const externalUrl =
      (anime.image && /^https?:\/\//i.test(anime.image.trim()) ? anime.image.trim() : '') ||
      (anime.coverUrl && /^https?:\/\//i.test(anime.coverUrl.trim()) ? anime.coverUrl.trim() : '');
    if (externalUrl) {
      if (anime.id && globalCoverDataMap.has(anime.id)) {
        globalCoverDataMap.delete(anime.id);
      }
      return portadaUrl(externalUrl, tamaño);
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

export function preloadAnimeCover(
  _anime: Partial<Anime>,
  _studiosOrStudioName: { id: string; name: string }[] | string = 'Estudio',
  _highPriority: boolean = false,
  _tamaño: PortadaSize = 'original'
): Promise<string> {
  // Visibility-first loading: avoid downloading off-screen or un-opened full covers
  return Promise.resolve('');
}

/**
 * Visibility-first loading: covers are fetched only when near/in viewport.
 */
export function prefetchAnime(
  _anime: Partial<Anime>,
  _studios: { id: string; name: string }[] = []
) {
  return;
}

export function preloadAllAnimes(_items: Partial<Anime>[], _studios: { id: string; name: string }[] = []) {
  return;
}

export function prefetchCatalogPage(
  _items: Partial<Anime>[],
  _pageNumber: number,
  _itemsPerPage: number = 30,
  _studios: { id: string; name: string }[] = []
) {
  return;
}

export function startPrioritizedAppLoading(
  _animes: Partial<Anime>[],
  _studios: { id: string; name: string }[] = []
) {
  return;
}

/**
 * Shared IntersectionObserver hook (2000px margin) for visibility-based image loading.
 */
export function useInView2000(priority: boolean = false) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [isInView, setIsInView] = useState<boolean>(() => {
    if (priority) return true;
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return true;
    return false;
  });

  useEffect(() => {
    if (priority || isInView) return;
    if (typeof IntersectionObserver === 'undefined') {
      setIsInView(true);
      return;
    }
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setIsInView(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: '2000px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [priority, isInView]);

  return { ref, isInView };
}

interface SmartAnimeCoverProps {
  anime: Partial<Anime>;
  studioName?: string;
  className?: string;
  alt?: string;
  loading?: 'eager' | 'lazy';
  priority?: boolean;
  tamaño?: PortadaSize;
  width?: number;
  height?: number;
  naturalSize?: boolean;
}

export function SmartAnimeCover({ 
  anime, 
  studioName = 'Estudio', 
  className = 'w-full h-full object-cover', 
  alt = '',
  loading = 'lazy',
  priority = false,
  tamaño = 'original',
  width,
  height,
  naturalSize = false
}: SmartAnimeCoverProps) {
  const externalHttpUrl = useMemo(() => {
    if (!isExternalHttpCover(anime)) return '';
    const raw =
      (anime.image && /^https?:\/\//i.test(anime.image.trim()) ? anime.image.trim() : '') ||
      (anime.coverUrl && /^https?:\/\//i.test(anime.coverUrl.trim()) ? anime.coverUrl.trim() : '');
    return raw ? portadaUrl(raw, tamaño) : '';
  }, [anime.image, anime.coverUrl, tamaño]);

  const isBase64Flow = !externalHttpUrl;
  const expectedVersion = typeof anime.portadaVersion === 'number' ? anime.portadaVersion : undefined;

  const getSyncMemoryHit = (): string => {
    if (externalHttpUrl) {
      return globalImageCache.has(externalHttpUrl) ? externalHttpUrl : '';
    }
    const memHit = getSyncCachedPortada(anime.id, expectedVersion);
    if (memHit) return memHit;
    if (anime.coverData && anime.coverData.startsWith('data:image/')) return anime.coverData;
    if (anime.image && anime.image.startsWith('data:image/')) return anime.image;
    return '';
  };

  const initialMemHit = getSyncMemoryHit();
  const [shouldSkipFade, setShouldSkipFade] = useState<boolean>(() => Boolean(initialMemHit));
  const [imageSrc, setImageSrc] = useState<string>(() => initialMemHit);
  const [retryCount, setRetryCount] = useState<number>(0);
  const [hasFailed, setHasFailed] = useState<boolean>(false);
  const [isLoaded, setIsLoaded] = useState<boolean>(() => Boolean(initialMemHit));
  const [placeholderDone, setPlaceholderDone] = useState<boolean>(() => Boolean(initialMemHit));

  const { ref: observerRef, isInView } = useInView2000(priority || shouldSkipFade);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const decodedSrcRef = useRef<string>('');
  const mountedRef = useRef<boolean>(true);
  const currentImageSrcRef = useRef<string>(imageSrc);
  currentImageSrcRef.current = imageSrc;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const propSourceKey = `${anime.id || ''}|${anime.image || ''}|${anime.coverUrl || ''}|${anime.portadaVersion ?? ''}|${anime.updatedAt || ''}|${studioName || ''}|${tamaño}`;
  const prevKeyRef = useRef<string>(propSourceKey);

  // Reset state if anime / version changes; skip placeholder & fade if already in session memory
  useEffect(() => {
    if (prevKeyRef.current !== propSourceKey) {
      prevKeyRef.current = propSourceKey;
      decodedSrcRef.current = '';
      setRetryCount(0);
      setHasFailed(false);
      const nextSync = getSyncMemoryHit();
      const hasHit = Boolean(nextSync);
      setShouldSkipFade(hasHit);
      setImageSrc(nextSync);
      setIsLoaded(hasHit);
      setPlaceholderDone(hasHit);
    }
  }, [propSourceKey]);

  // Resolve cover when within 2000px of viewport (or priority)
  useEffect(() => {
    if (!isInView) return;

    if (externalHttpUrl) {
      setImageSrc((prev) => (prev === externalHttpUrl ? prev : externalHttpUrl));
      if (globalImageCache.has(externalHttpUrl)) {
        setIsLoaded(true);
        setPlaceholderDone(true);
      }
      return;
    }

    let cancelled = false;
    const syncHit = getSyncCachedPortada(anime.id, expectedVersion);
    if (syncHit) {
      setImageSrc((prev) => (prev === syncHit ? prev : syncHit));
      setIsLoaded(true);
      setPlaceholderDone(true);
      return;
    }

    resolveAnimeCoverBase64(anime)
      .then((resolvedDataUrl) => {
        if (cancelled) return;
        if (resolvedDataUrl) {
          setImageSrc(resolvedDataUrl);
          setHasFailed(false);
          return;
        }
        // Fallback when no base64 in portadas/{id} or anime doc
        const fallbackPath = processImageSrc(anime, studioName, tamaño);
        setImageSrc(fallbackPath);
      })
      .catch(() => {
        if (cancelled) return;
        const fallbackPath = processImageSrc(anime, studioName, tamaño);
        setImageSrc(fallbackPath);
      });

    return () => {
      cancelled = true;
    };
  }, [isInView, externalHttpUrl, propSourceKey, anime, studioName, tamaño, expectedVersion]);

  const revealImageAfterDecode = async (targetSrc: string) => {
    if (!targetSrc || decodedSrcRef.current === targetSrc) return;
    decodedSrcRef.current = targetSrc;

    const imgEl = imgRef.current;
    if (imgEl && typeof imgEl.decode === 'function') {
      try {
        await imgEl.decode();
      } catch {
        // Ignore decode failure (e.g., SVG fallback or already decoded)
      }
    }

    if (!mountedRef.current || currentImageSrcRef.current !== targetSrc) return;

    if (!isBase64Flow) {
      globalImageCache.add(targetSrc);
    }
    setHasFailed((prev) => (prev ? false : prev));

    requestAnimationFrame(() => {
      if (!mountedRef.current || currentImageSrcRef.current !== targetSrc) return;
      setIsLoaded(true);
    });
  };

  // Trigger decode + 200ms fade-in if image completed synchronously in DOM
  useEffect(() => {
    if (shouldSkipFade || !imageSrc) return;
    if (imgRef.current && imgRef.current.complete && imgRef.current.naturalWidth > 0) {
      revealImageAfterDecode(imageSrc);
    }
  }, [imageSrc, shouldSkipFade]);

  // Remove loading placeholder cleanly after 200ms fade completes
  useEffect(() => {
    if (!isLoaded || placeholderDone) return;
    const timer = setTimeout(() => setPlaceholderDone(true), 220);
    return () => clearTimeout(timer);
  }, [isLoaded, placeholderDone]);

  const handleLoad = () => {
    if (shouldSkipFade) {
      if (imageSrc && !isBase64Flow) {
        globalImageCache.add(imageSrc);
      }
      setIsLoaded(true);
      setPlaceholderDone(true);
      return;
    }
    revealImageAfterDecode(imageSrc);
  };

  const handleError = () => {
    if (retryCount === 0 && anime.id) {
      const nextSrc = `/covers/${anime.id}.webp`;
      if (imageSrc !== nextSrc) {
        setRetryCount(1);
        setImageSrc(nextSrc);
        if (globalImageCache.has(nextSrc)) {
          setIsLoaded(true);
          setPlaceholderDone(true);
        }
        return;
      }
    }
    if (retryCount <= 1 && anime.coverData && anime.coverData.startsWith('data:image/')) {
      if (imageSrc !== anime.coverData) {
        setRetryCount(2);
        setImageSrc(anime.coverData);
        setIsLoaded(true);
        setPlaceholderDone(true);
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
    setIsLoaded(true);
    setPlaceholderDone(true);
    setHasFailed(true);
  };

  const defaultDims = PORTADA_DIMENSIONS[tamaño];
  const resolvedWidth = width ?? (!priority ? defaultDims.width : undefined);
  const resolvedHeight = height ?? (!priority ? defaultDims.height : undefined);

  const showPlaceholder = !shouldSkipFade && !placeholderDone && !hasFailed;

  const wrapperClass = naturalSize
    ? `w-full relative overflow-hidden select-auto pointer-events-auto ${showPlaceholder ? 'bg-dark-bg min-h-[260px] sm:min-h-[340px]' : ''}`
    : `w-full h-full relative overflow-hidden select-none ${showPlaceholder ? 'bg-dark-bg' : ''}`;

  return (
    <div
      ref={observerRef}
      className={wrapperClass}
      style={naturalSize ? { WebkitTouchCallout: 'default', WebkitUserSelect: 'auto', userSelect: 'auto' } : undefined}
    >
      {/* Dark violet pulsing placeholder while waiting for visibility, fetch, decode, and fade-in */}
      {showPlaceholder && (
        <div className="absolute inset-0 bg-[#a855f7]/15 animate-pulse pointer-events-none" />
      )}

      {imageSrc && (
        <img
          ref={imgRef}
          src={imageSrc}
          alt={alt || anime.name || 'Cover'}
          loading={priority ? 'eager' : loading}
          fetchPriority={priority ? 'high' : 'auto'}
          width={resolvedWidth}
          height={resolvedHeight}
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={handleLoad}
          onError={handleError}
          style={naturalSize ? { WebkitTouchCallout: 'default', WebkitUserSelect: 'auto', userSelect: 'auto' } : undefined}
          className={
            shouldSkipFade
              ? className
              : `${className} transition-opacity duration-200 ease-out ${
                  isLoaded ? 'opacity-100' : 'opacity-0'
                }`
          }
        />
      )}
    </div>
  );
}

