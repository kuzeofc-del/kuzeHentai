/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { User } from 'firebase/auth';
import { db, auth, doc, setDoc, deleteDoc, collection, getDocs, deleteField, isFirebaseConfigured } from '../lib/firebase';
import { Studio, Genre, Anime, DatabaseSchema, getNormalizedKey, normalizeAnimeYear, resolveContinuationGroup, sortAnimesByYearAsc, formatContinuationTitle } from '../types';
import { SmartAnimeCover, getFallbackSvg, globalCoverDataMap, portadaUrl } from '../utils/imageFallback';
import { fetchPortadaFromFirestore, upsertPortadaMemoryCache, deletePortadaMemoryCache } from '../lib/coverCache';
import { 
  Lock, User as UserIcon, LogOut, Plus, Trash2, Edit2, Save, EyeOff, Eye, Upload, Folder,
  Settings, Database, RefreshCw, Layers, Film, Tag, ArrowLeft, Download, Check, AlertCircle, Search, Building2, Sparkles,
  HardDrive, Globe, Image as ImageIcon, Info, X, Link as LinkIcon, Activity, Cpu, Cloud, BarChart3, PieChart, ShieldCheck,
  ChevronLeft, ChevronRight, Users, Star, MessageSquare, Flame
} from 'lucide-react';
import {
  NormalizedAnimeData,
  normalizeSearchText,
  calculateRelevanceScore,
  matchesFuzzySearch,
  buildNormalizedAnimeData
} from '../utils/searchUtils';
import AdminEpisodeManager from './AdminEpisodeManager';
import AdminAnnouncementManager from './AdminAnnouncementManager';
import { getAnimeRatingStats } from '../utils/ratingManager';
import { enforceEpisodesRotationInFirestore, sanitizeEpisodeForFirestore } from '../utils/episodeRotation';
import { normalizeEpisodesList, getEpisodeUrl, cleanEpisodeForStorage } from '../utils/episodeUtils';
import { useAppTheme } from '../lib/theme';

interface AdminPanelProps {
  studios: Studio[];
  genres: Genre[];
  animes: Anime[];
  onRefresh: (updatedAnime?: Anime | Anime[], deletedId?: string) => void;
  onBackToHome: () => void;
  currentUser?: User | null;
}

// No image optimization/compression - keeps images 100% original
const compressImage = (base64Str: string): Promise<string> => {
  return Promise.resolve(base64Str);
};

// Sin optimización de portadas de estudios ni géneros - se conservan las imágenes 100% originales
const optimizeStudioImage = (base64Str: string): Promise<string> => {
  return Promise.resolve(base64Str);
};

// Protege el límite estricto de 1 MiB por documento de Firebase Firestore en despliegues estáticos (Vercel).
// Si la imagen es menor a ~750 KB en base64, se conserva 100% idéntica sin tocar un solo byte.
const ensureFirestoreSafeImage = (dataUrl: string, maxBase64Length = 750000): Promise<string> => {
  if (!dataUrl || !dataUrl.startsWith('data:image/') || dataUrl.length <= maxBase64Length) {
    return Promise.resolve(dataUrl);
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        const maxDim = 1200;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(dataUrl);
        ctx.drawImage(img, 0, 0, width, height);
        let quality = 0.85;
        let result = canvas.toDataURL('image/webp', quality);
        while (result.length > maxBase64Length && quality > 0.4) {
          quality -= 0.15;
          result = canvas.toDataURL('image/webp', quality);
        }
        resolve(result);
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
};

const coverSizeMemoryCache = new Map<string, { sizeText: string; format: string; bytes: number }>();

function formatBytesToSizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `~${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `~${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function detectImageFormat(src: string, mimeType?: string): string {
  const target = `${mimeType || ''} ${src || ''}`.toLowerCase();
  if (target.includes('webp')) return 'WebP';
  if (target.includes('png')) return 'PNG';
  if (target.includes('gif')) return 'GIF';
  if (target.includes('avif')) return 'AVIF';
  if (target.includes('svg')) return 'SVG';
  return 'JPG';
}

function getSyncCoverSizeInfo(src?: string | null): { sizeText: string; format: string; bytes: number } | null {
  if (!src || typeof src !== 'string') return null;
  const trimmed = src.trim();
  if (!trimmed) return null;

  if (coverSizeMemoryCache.has(trimmed)) {
    return coverSizeMemoryCache.get(trimmed)!;
  }

  if (trimmed.startsWith('data:image/')) {
    const commaIdx = trimmed.indexOf(',');
    const header = commaIdx !== -1 ? trimmed.slice(0, commaIdx) : '';
    const base64Data = commaIdx !== -1 ? trimmed.slice(commaIdx + 1) : trimmed;
    const bytes = Math.round((base64Data.length * 3) / 4);
    const info = {
      bytes,
      sizeText: formatBytesToSizeText(bytes),
      format: detectImageFormat(header)
    };
    coverSizeMemoryCache.set(trimmed, info);
    return info;
  }

  return null;
}

function useCoverSizeInfo(src?: string | null) {
  const [info, setInfo] = useState<{ sizeText: string; format: string; bytes: number } | null>(() => getSyncCoverSizeInfo(src));

  useEffect(() => {
    if (!src || typeof src !== 'string' || !src.trim()) {
      setInfo(null);
      return;
    }
    const trimmed = src.trim();
    const syncInfo = getSyncCoverSizeInfo(trimmed);
    if (syncInfo) {
      setInfo(syncInfo);
      return;
    }

    let cancelled = false;
    fetch(trimmed, { mode: 'cors' })
      .then(async (res) => {
        if (!res.ok) return null;
        const blob = await res.blob();
        const headerBytes = Number(res.headers.get('content-length')) || 0;
        const bytes = blob.size || headerBytes;
        if (!bytes) return null;
        const format = detectImageFormat(trimmed, blob.type);
        const result = {
          bytes,
          sizeText: formatBytesToSizeText(bytes),
          format
        };
        coverSizeMemoryCache.set(trimmed, result);
        return result;
      })
      .then((result) => {
        if (!cancelled && result) {
          setInfo(result);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [src]);

  return info;
}

function CoverPreviewSizeBadge({ src, showSourceType = false }: { src?: string | null; showSourceType?: boolean }) {
  const info = useCoverSizeInfo(src);
  const trimmed = (src || '').trim();
  const isExternalUrl = /^https?:\/\//i.test(trimmed);
  const sourceTypeLabel = showSourceType && trimmed ? (isExternalUrl ? 'URL' : 'Imagen') : null;

  if (!info && !sourceTypeLabel) return null;
  return (
    <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5 pointer-events-none">
      {info && (
        <div className="px-1.5 py-0.5 rounded bg-black/75 backdrop-blur-xs border border-purple-500/40 text-[8.5px] font-mono text-purple-300 font-bold tracking-tight flex items-center gap-1 shadow-sm">
          <span>{info.sizeText}</span>
          <span className="opacity-75">· {info.format}</span>
        </div>
      )}
      {sourceTypeLabel && (
        <div
          className={`px-1.5 py-0.5 rounded bg-black/80 backdrop-blur-xs border text-[8.5px] font-mono font-bold tracking-wider uppercase shadow-sm ${
            isExternalUrl
              ? 'border-cyan-400/50 text-cyan-300'
              : 'border-emerald-400/50 text-emerald-300'
          }`}
        >
          {sourceTypeLabel}
        </div>
      )}
    </div>
  );
}

// Smart URL parser to extract Anime title candidate & episode number from links (e.g. Internet Archive)
export function parseAnimeLinkInfo(rawUrl: string, animesList: Anime[]) {
  if (!rawUrl || !rawUrl.trim()) {
    return { detectedTitle: '', detectedEp: 1, matchedAnime: null };
  }

  let url = rawUrl.trim();
  try {
    url = decodeURIComponent(url);
  } catch (e) {
    // fallback
  }

  url = url.split('?')[0].split('#')[0];

  // Strip protocol & domain if present
  let urlClean = url.replace(/^(?:https?|ftp):\/\/[^\/]+/i, '');
  urlClean = urlClean.replace(/^\/+/, '');

  // Extract path segments and filter out non-anime route noise
  const rawSegments = urlClean.split('/').filter(Boolean);
  const segments = rawSegments.filter(s => {
    const lower = s.toLowerCase();
    return !['load', 'download', 'downloads', 'video', 'stream', 'files', 'storage', 'watch', 'v', 'f', 'embed', 'api', 'upload', 'archive.org', 'details'].includes(lower);
  });

  let textToParse = segments.length > 0 ? segments[segments.length - 1] : urlClean;
  let parentSegment = segments.length > 1 ? segments[segments.length - 2] : '';

  // Clean video extensions & quality tags
  textToParse = textToParse.replace(/\.(mp4|mkv|avi|webm|flv|mov|m4v|3gp|ts)$/i, '');
  textToParse = textToParse.replace(/\b(1080p|720p|480p|x264|x265|aac|bluray|web-dl|hdrip)\b/gi, '');

  if (parentSegment) {
    parentSegment = parentSegment.replace(/\.(mp4|mkv|avi|webm|flv|mov|m4v|3gp|ts)$/i, '');
    parentSegment = parentSegment.replace(/\b(1080p|720p|480p|x264|x265|aac|bluray|web-dl|hdrip)\b/gi, '');
  }

  let epNum = 1;
  let titleCandidate = '';

  // If last segment is JUST a number (e.g. /01.mp4 or /1)
  if (/^\d{1,4}$/.test(textToParse.trim())) {
    epNum = parseInt(textToParse.trim(), 10) || 1;
    titleCandidate = parentSegment.replace(/[._\-]+/g, ' ').trim();
  } else {
    // Try to extract episode number from the text
    const epPatterns = [
      /(?:^|[._\-\s]+)(?:ep|episodio|cap|capitulo|e|c)?\s*0*(\d{1,4})\s*$/i,
      /(?:^|[._\-\s]+)(?:ep|episodio|cap|capitulo|e|c)\s*0*(\d{1,4})\b/i,
      /\b(?:s\d+)?e0*(\d{1,4})\b/i
    ];

    let foundEp = false;
    let cleanedText = textToParse.replace(/[._\-]+/g, ' ').trim();

    for (const pattern of epPatterns) {
      const match = cleanedText.match(pattern);
      if (match) {
        epNum = parseInt(match[1], 10) || 1;
        const cutIdx = match.index;
        if (cutIdx !== undefined && cutIdx > 0) {
          titleCandidate = cleanedText.substring(0, cutIdx).trim();
        } else {
          titleCandidate = cleanedText.replace(pattern, '').trim();
        }
        foundEp = true;
        break;
      }
    }

    if (!foundEp || !titleCandidate) {
      titleCandidate = cleanedText;
    }
  }

  // Format title candidate with Capital Words
  if (titleCandidate) {
    titleCandidate = titleCandidate.replace(/\b\w/g, c => c.toUpperCase());
  }

  const normCandidate = getNormalizedKey(titleCandidate);
  const normFullText = getNormalizedKey(textToParse);

  let bestMatch: Anime | null = null;
  let highestScore = 0;

  for (const anime of animesList) {
    const normAnime = getNormalizedKey(anime.name);
    if (!normAnime) continue;

    // 1. Exact match
    if (normAnime === normCandidate || normAnime === normFullText) {
      bestMatch = anime;
      highestScore = 100;
      break;
    }

    // 2. Substring / Prefix match
    if (normCandidate && normCandidate.length >= 3) {
      if (normAnime.startsWith(normCandidate) || normCandidate.startsWith(normAnime)) {
        const score = 90;
        if (score > highestScore) {
          highestScore = score;
          bestMatch = anime;
        }
      } else if (normAnime.includes(normCandidate) || normCandidate.includes(normAnime)) {
        const minLen = Math.min(normAnime.length, normCandidate.length);
        const maxLen = Math.max(normAnime.length, normCandidate.length);
        const score = (minLen / maxLen) * 85;
        if (score > highestScore && score > 30) {
          highestScore = score;
          bestMatch = anime;
        }
      }
    }

    // 3. Token overlap match
    const candidateTokens = (normCandidate || normFullText).split(/\s+/).filter(t => t.length > 1);
    const animeTokens = normAnime.split(/\s+/).filter(t => t.length > 1);
    if (candidateTokens.length > 0 && animeTokens.length > 0) {
      const candidateSet = new Set(candidateTokens);
      const matchCount = animeTokens.filter(t => candidateSet.has(t)).length;
      const ratio = matchCount / Math.min(animeTokens.length, candidateTokens.length);
      if (ratio >= 0.5) {
        const score = ratio * 80;
        if (score > highestScore && score > 35) {
          highestScore = score;
          bestMatch = anime;
        }
      }
    }
  }

  return {
    detectedTitle: titleCandidate || textToParse,
    detectedEp: epNum,
    matchedAnime: bestMatch
  };
}

export default function AdminPanel({ studios, genres, animes, onRefresh, onBackToHome, currentUser }: AdminPanelProps) {
  // Authentication states
  const [token, setToken] = useState<string>(() => localStorage.getItem('hk_admin_token') || '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Nav states
  const [activeTab, setActiveTab] = useState<'animes' | 'episodes' | 'studios' | 'genres' | 'announcements' | 'firebase-stats'>('animes');
  const [tabDirection, setTabDirection] = useState<number>(1);
  const tabsContainerRef = useRef<HTMLDivElement | null>(null);
  const isDraggingTabsRef = useRef<boolean>(false);
  const tabTouchStartXRef = useRef<number>(0);
  const tabTouchStartYRef = useRef<number>(0);
  const tabDragThresholdPassedRef = useRef<boolean>(false);

  const handleTabChange = (newTab: 'animes' | 'episodes' | 'studios' | 'genres' | 'announcements' | 'firebase-stats') => {
    const tabs: ('animes' | 'episodes' | 'studios' | 'genres' | 'announcements' | 'firebase-stats')[] = [
      'animes', 'episodes', 'studios', 'genres', 'announcements', 'firebase-stats'
    ];
    const currentIdx = tabs.indexOf(activeTab);
    const newIdx = tabs.indexOf(newTab);
    setTabDirection(newIdx >= currentIdx ? 1 : -1);
    setActiveTab(newTab);
  };

  const handleTabsTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 1) return;
    tabTouchStartXRef.current = e.touches[0].clientX;
    tabTouchStartYRef.current = e.touches[0].clientY;
    tabDragThresholdPassedRef.current = false;
  };

  const handleTabsTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!e.touches[0]) return;
    const deltaX = Math.abs(e.touches[0].clientX - tabTouchStartXRef.current);
    const deltaY = Math.abs(e.touches[0].clientY - tabTouchStartYRef.current);
    if (deltaX > 8 || deltaY > 8) {
      tabDragThresholdPassedRef.current = true;
      isDraggingTabsRef.current = true;
    }
  };

  const handleTabsTouchEnd = () => {
    if (tabDragThresholdPassedRef.current) {
      isDraggingTabsRef.current = true;
      setTimeout(() => {
        isDraggingTabsRef.current = false;
        tabDragThresholdPassedRef.current = false;
      }, 250);
    } else {
      isDraggingTabsRef.current = false;
    }
  };

  const onSafeTabClick = (newTab: 'animes' | 'episodes' | 'studios' | 'genres' | 'announcements' | 'firebase-stats') => {
    if (isDraggingTabsRef.current) return;
    handleTabChange(newTab);
  };

  // Form states - Studios
  const [editingStudio, setEditingStudio] = useState<Studio | null>(null);
  const [studioName, setStudioName] = useState('');
  const [studioImage, setStudioImage] = useState('');
  const [studioError, setStudioError] = useState('');

  // Form states - Genres
  const [editingGenre, setEditingGenre] = useState<Genre | null>(null);
  const [genreName, setGenreName] = useState('');
  const [genreImage, setGenreImage] = useState('');
  const [genreError, setGenreError] = useState('');

  // Form states - Anime
  const [isAnimeFormOpen, setIsAnimeFormOpen] = useState(false);
  const [editingAnime, setEditingAnime] = useState<Anime | null>(null);
  const [animeName, setAnimeName] = useState('');
  const [animeImage, setAnimeImage] = useState('');
  const [animeCoverUrlInput, setAnimeCoverUrlInput] = useState('');
  const [isImageOptimized, setIsImageOptimized] = useState(false);
  const [isLoadingEditCover, setIsLoadingEditCover] = useState(false);
  const initialEditCoverRef = useRef<string>('');
  const editingAnimeIdRef = useRef<string | null>(null);
  const [animeStudioId, setAnimeStudioId] = useState('');
  const [animeStudioSearch, setAnimeStudioSearch] = useState('');
  const [showStudioPicker, setShowStudioPicker] = useState(false);
  const [isDeduplicating, setIsDeduplicating] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [animeGenreIds, setAnimeGenreIds] = useState<string[]>([]);
  const [animeGenresInput, setAnimeGenresInput] = useState('');
  const [animeStatus, setAnimeStatus] = useState('Finalizado');

  // Papelera de animes eliminados (guarda exclusivamente los nombres de los animes eliminados)
  const [showTrashModal, setShowTrashModal] = useState(false);
  const [trashNames, setTrashNames] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('deleted_animes_trash');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [isClearingTrash, setIsClearingTrash] = useState(false);

  const fetchTrash = async () => {
    try {
      const res = await fetch('/api/admin/trash', { headers: apiHeaders });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.trash)) {
          setTrashNames(data.trash);
          localStorage.setItem('deleted_animes_trash', JSON.stringify(data.trash));
        }
      }
    } catch (e) {}
  };

  const recordDeletedAnime = (name: string) => {
    if (!name) return;
    setTrashNames(prev => {
      const next = prev.includes(name) ? prev : [name, ...prev];
      localStorage.setItem('deleted_animes_trash', JSON.stringify(next));
      return next;
    });
  };

  const handleEmptyTrash = async () => {
    setIsClearingTrash(true);
    try {
      await fetch('/api/admin/trash', { method: 'DELETE', headers: apiHeaders }).catch(() => null);
      setTrashNames([]);
      localStorage.removeItem('deleted_animes_trash');
      showNotification('Papelera vaciada correctamente', 'success');
    } catch (err: any) {
      showNotification('Error al vaciar papelera', 'error');
    } finally {
      setIsClearingTrash(false);
    }
  };

  useEffect(() => {
    fetchTrash();
  }, []);

  const [lastUsedStudio, setLastUsedStudio] = useState<{ id: string; search: string }>(() => {
    try {
      const saved = localStorage.getItem('kh_admin_last_used_studio');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed.search === 'string') {
          return parsed;
        }
      }
    } catch (e) {}
    return { id: '', search: '' };
  });

  const updateLastUsedStudio = (studioSearch: string, studioId: string = '') => {
    const updated = { id: studioId, search: studioSearch };
    setLastUsedStudio(updated);
    try {
      if (studioSearch.trim()) {
        localStorage.setItem('kh_admin_last_used_studio', JSON.stringify(updated));
      } else {
        localStorage.removeItem('kh_admin_last_used_studio');
      }
    } catch (e) {}
  };
  const [animeYear, setAnimeYear] = useState('');
  const [animeReleaseMonth, setAnimeReleaseMonth] = useState('');
  const [animeDescription, setAnimeDescription] = useState('');
  const [animeTelegramUrl, setAnimeTelegramUrl] = useState('');
  const [singleEpIsNew, setSingleEpIsNew] = useState<boolean>(false);
  const [animeEpisodes, setAnimeEpisodes] = useState<{
    number: number;
    mp4Url: string;
    isNew?: boolean;
    addedToRecentAt?: string;
    coverImage?: string;
    thumbnail?: string;
    title?: string;
  }[]>([]);
  const episodeInputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [swipedEpisodeIdx, setSwipedEpisodeIdx] = useState<number | null>(null);
  const [swipedEpisodeOffset, setSwipedEpisodeOffset] = useState<number>(0);
  const epSwipeTouchRef = useRef<{
    idx: number;
    startX: number;
    startY: number;
    baseOffset: number;
    lockedAxis: 'x' | 'y' | null;
  } | null>(null);

  const [animeHidden, setAnimeHidden] = useState(false);
  const [animeContinuationType, setAnimeContinuationType] = useState<string>('');
  const [animeContinuationIds, setAnimeContinuationIds] = useState<string[]>([]);
  const [initialContinuationIds, setInitialContinuationIds] = useState<string[]>([]);
  const [showContinuationOptions, setShowContinuationOptions] = useState(false);
  const [isContinuationModalOpen, setIsContinuationModalOpen] = useState(false);
  const [continuationSearchQuery, setContinuationSearchQuery] = useState('');
  const [tempContinuationIds, setTempContinuationIds] = useState<string[]>([]);

  const [animeFormError, setAnimeFormError] = useState('');
  const [imageUploadLoading, setImageUploadLoading] = useState(false);
  const [animeAdminSearch, setAnimeAdminSearch] = useState('');
  const deferredAdminSearch = React.useDeferredValue(animeAdminSearch);
  const [isDeduplicatingAnimes, setIsDeduplicatingAnimes] = useState(false);
  const [showDuplicatesModal, setShowDuplicatesModal] = useState(false);

  // Quick Add Episode by Link states
  const [showQuickAddEpModal, setShowQuickAddEpModal] = useState(false);
  const [quickEpItems, setQuickEpItems] = useState<{ number: number; url: string; isNew?: boolean; coverImage?: string; thumbnail?: string }[]>([
    { number: 1, url: '', isNew: true }
  ]);
  const quickEpInputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [swipedQuickEpIdx, setSwipedQuickEpIdx] = useState<number | null>(null);
  const [swipedQuickEpOffset, setSwipedQuickEpOffset] = useState<number>(0);
  const quickEpSwipeTouchRef = useRef<{
    idx: number;
    startX: number;
    startY: number;
    baseOffset: number;
    lockedAxis: 'x' | 'y' | null;
  } | null>(null);

  // Tab Navigation without gesture hijacking, allowing smooth horizontal scrolling of all tabs
  const [quickEpTargetAnimeId, setQuickEpTargetAnimeId] = useState('');
  const [quickEpDetectedTitle, setQuickEpDetectedTitle] = useState('');
  const [quickEpAutoMatched, setQuickEpAutoMatched] = useState(false);
  const [isSavingQuickEp, setIsSavingQuickEp] = useState(false);

  const nextQuickEpNumber = quickEpItems.length > 0
    ? Math.max(...quickEpItems.map(item => Number(item.number) || 0)) + 1
    : 1;

  const handleAddQuickEpField = () => {
    setQuickEpItems(prev => [...prev, { number: nextQuickEpNumber, url: '', isNew: true }]);
  };

  const handleRemoveQuickEpField = (index: number) => {
    setSwipedQuickEpIdx(null);
    setSwipedQuickEpOffset(0);
    if (quickEpItems.length > 1) {
      setQuickEpItems(prev => prev.filter((_, i) => i !== index));
    } else {
      setQuickEpItems([{ number: 1, url: '', isNew: true }]);
    }
  };

  const handleToggleQuickEpNew = (index: number) => {
    setQuickEpItems(prev => {
      const updated = [...prev];
      const currentIsNew = updated[index].isNew !== false;
      updated[index] = { ...updated[index], isNew: !currentIsNew };
      return updated;
    });
  };

  const handleUpdateQuickEpNumber = (index: number, numVal: any) => {
    setQuickEpItems(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], number: Number(numVal) || 1 };
      return updated;
    });
  };

  const handleQuickItemUrlChange = (index: number, val: string) => {
    let detectedTitle = '';
    let targetAnimeId = '';
    let autoMatched = false;
    let shouldUpdateMeta = false;

    setQuickEpItems(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], url: val };

      const urlClean = val.trim();
      if (urlClean) {
        const parsed = parseAnimeLinkInfo(urlClean, animes);
        if (parsed.detectedTitle) {
          detectedTitle = parsed.detectedTitle;
          shouldUpdateMeta = true;
        }
        if (parsed.matchedAnime) {
          targetAnimeId = parsed.matchedAnime.id;
          autoMatched = true;
          shouldUpdateMeta = true;
        } else if (!quickEpTargetAnimeId || quickEpTargetAnimeId === 'NEW_ANIME') {
          targetAnimeId = 'NEW_ANIME';
          autoMatched = false;
          shouldUpdateMeta = true;
        }

        if (parsed.detectedEp) {
          const baseEp = parsed.detectedEp;
          updated[index] = { ...updated[index], number: baseEp };
          for (let j = index + 1; j < updated.length; j++) {
            updated[j] = { ...updated[j], number: baseEp + (j - index) };
          }
        }
      }

      // Smart focus/blur logic when paste or URL entry occurs
      if (urlClean.length > 8 || urlClean.startsWith('http') || urlClean.includes('archive.org')) {
        const nextEmptyIdx = updated.findIndex((item, i) => i > index && (!item.url || item.url.trim() === ''));
        
        if (nextEmptyIdx !== -1) {
          // More empty chapter fields remain! Focus next empty field so keyboard stays open for next paste
          setTimeout(() => {
            quickEpInputRefs.current[nextEmptyIdx]?.focus();
          }, 60);
        } else {
          const anyEmptyIdx = updated.findIndex((item, i) => i !== index && (!item.url || item.url.trim() === ''));
          if (anyEmptyIdx !== -1) {
            setTimeout(() => {
              quickEpInputRefs.current[anyEmptyIdx]?.focus();
            }, 60);
          } else {
            // NO MORE EMPTY FIELDS! All chapter inputs in the modal now have a link.
            // Dismiss/lower the keyboard automatically
            setTimeout(() => {
              (document.activeElement as HTMLElement)?.blur();
              if (quickEpInputRefs.current[index]) {
                quickEpInputRefs.current[index]?.blur();
              }
            }, 60);
          }
        }
      }

      return updated;
    });

    if (shouldUpdateMeta) {
      if (detectedTitle) setQuickEpDetectedTitle(detectedTitle);
      if (targetAnimeId) setQuickEpTargetAnimeId(targetAnimeId);
      setQuickEpAutoMatched(autoMatched);
    }
  };

  const handleOpenQuickAddEpModal = (initialAnimeId?: string | unknown) => {
    setQuickEpItems([{ number: 1, url: '', isNew: true }]);
    setSwipedQuickEpIdx(null);
    setSwipedQuickEpOffset(0);
    const animeIdStr = typeof initialAnimeId === 'string' ? initialAnimeId : '';
    const initialAnime = animeIdStr ? animes.find(a => a.id === animeIdStr) : null;
    setQuickEpDetectedTitle(initialAnime ? initialAnime.name : '');
    setQuickEpTargetAnimeId(animeIdStr || '');
    setQuickEpAutoMatched(!!animeIdStr);
    setShowQuickAddEpModal(true);
  };

  const handleSaveQuickEpisode = async () => {
    const validItems = quickEpItems.filter(item => item.url.trim() !== '');
    if (validItems.length === 0) {
      showNotification('Debes ingresar al menos un enlace válido.', 'error');
      return;
    }

    setIsSavingQuickEp(true);
    setLiveProgress({
      title: 'Guardando Episodios',
      detail: `Preparando ${validItems.length} episodio(s) y miniaturas...`,
      percent: 25,
      current: 1,
      total: 3,
      unit: 'etapas'
    });
    try {
      let targetAnime: Anime | null = null;
      let isNewAnime = false;

      if (quickEpTargetAnimeId === 'NEW_ANIME' || !quickEpTargetAnimeId) {
        isNewAnime = true;
      } else {
        targetAnime = animes.find(a => a.id === quickEpTargetAnimeId) || null;
      }

      if (isNewAnime) {
        const animeTitle = quickEpDetectedTitle.trim() || 'Nuevo Anime';
        const defaultStudioId = studios.length > 0 ? studios[0].id : '';

        const episodesPayload = validItems.map((item, idx) => {
          const isNewEp = item.isNew !== false;
          const epObj: Record<string, any> = {
            number: Number(item.number) || 1,
            mp4Url: item.url.trim(),
            isNew: isNewEp,
            ...(isNewEp ? { addedToRecentAt: new Date(Date.now() + idx * 1000).toISOString() } : {}),
          };
          if (item.coverImage !== undefined) epObj.coverImage = item.coverImage;
          if (item.thumbnail !== undefined) epObj.thumbnail = item.thumbnail;
          return epObj;
        }).sort((a, b) => a.number - b.number);

        const firstUrl = episodesPayload[0]?.mp4Url || '';

        const payload = {
          name: animeTitle,
          image: '',
          coverData: '',
          studioId: defaultStudioId,
          genreIds: [],
          status: 'Finalizado',
          year: new Date().getFullYear().toString(),
          description: '',
          telegramUrl: firstUrl,
          episodes: episodesPayload,
          hidden: false,
          order: 10,
        };

        setLiveProgress({
          title: 'Creando Anime y Episodios',
          detail: `Sincronizando "${animeTitle}" (${validItems.length} ep.) con Firebase Firestore...`,
          percent: 68,
          current: 2,
          total: 3,
          unit: 'etapas'
        });

        const res = await fetch('/api/animes', {
          method: 'POST',
          headers: apiHeaders,
          body: JSON.stringify(payload)
        }).catch(() => null);

        const contentType = res?.headers?.get('content-type') || '';
        if (res && res.ok && contentType.includes('application/json')) {
          const savedData = await res.json().catch(() => null);
          setLiveProgress({
            title: '¡Episodios Guardados!',
            detail: `"${animeTitle}" creado al 100%`,
            percent: 100,
            current: 3,
            total: 3,
            unit: 'etapas'
          });
          await new Promise(r => setTimeout(r, 260));
          onRefresh(savedData || undefined);
          showNotification(`¡Anime "${animeTitle}" con ${validItems.length} episodio(s) creado exitosamente!`, 'success');
          setShowQuickAddEpModal(false);
          setQuickEpItems([{ number: 1, url: '' }]);
        } else {
          if (!db) {
            throw new Error('No hay base de datos Firebase conectada.');
          }
          const targetId = animeTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || ('anime-' + Date.now());
          const nowIso = new Date().toISOString();
          const fsData = {
            ...payload,
            id: targetId,
            createdAt: nowIso,
            updatedAt: nowIso,
            storageLocation: 'Firebase Firestore',
            savedInFirestore: true
          };
          await setDoc(doc(db, 'animes', targetId), fsData, { merge: true });
          setLiveProgress({
            title: '¡Episodios Guardados!',
            detail: `"${animeTitle}" sincronizado al 100% en Firebase Firestore`,
            percent: 100,
            current: 3,
            total: 3,
            unit: 'etapas'
          });
          await new Promise(r => setTimeout(r, 260));
          onRefresh(fsData as unknown as Anime);
          showNotification(`¡Anime "${animeTitle}" con ${validItems.length} episodio(s) creado exitosamente!`, 'success');
          setShowQuickAddEpModal(false);
          setQuickEpItems([{ number: 1, url: '' }]);
        }
      } else if (targetAnime) {
        const existingEps = targetAnime.episodes ? [...targetAnime.episodes] : [];

        validItems.forEach((item, idx) => {
          const epNum = Number(item.number) || 1;
          const epUrlClean = item.url.trim();
          const isNewEp = item.isNew !== false;
          const existingIndex = existingEps.findIndex(e => e.number === epNum);

          if (existingIndex >= 0) {
            const updatedEp = sanitizeEpisodeForFirestore({
              ...existingEps[existingIndex],
              number: epNum,
              mp4Url: epUrlClean,
              isNew: isNewEp,
              addedToRecentAt: isNewEp ? new Date(Date.now() + idx * 1000).toISOString() : undefined,
              ...(item.coverImage !== undefined ? { coverImage: item.coverImage } : {}),
              ...(item.thumbnail !== undefined ? { thumbnail: item.thumbnail } : {}),
            });
            existingEps[existingIndex] = updatedEp;
          } else {
            const newEp = sanitizeEpisodeForFirestore({
              number: epNum,
              mp4Url: epUrlClean,
              isNew: isNewEp,
              ...(isNewEp ? { addedToRecentAt: new Date(Date.now() + idx * 1000).toISOString() } : {}),
              ...(item.coverImage !== undefined ? { coverImage: item.coverImage } : {}),
              ...(item.thumbnail !== undefined ? { thumbnail: item.thumbnail } : {}),
            });
            existingEps.push(newEp);
          }
        });

        existingEps.forEach((ep, i) => {
          existingEps[i] = sanitizeEpisodeForFirestore(ep);
        });
        existingEps.sort((a, b) => a.number - b.number);

        const payload = {
          ...targetAnime,
          episodes: existingEps
        };

        setLiveProgress({
          title: 'Actualizando Episodios',
          detail: `Sincronizando ${validItems.length} episodio(s) en "${targetAnime.name}"...`,
          percent: 70,
          current: 2,
          total: 3,
          unit: 'etapas'
        });

        const res = await fetch(`/api/animes/${targetAnime.id}`, {
          method: 'PUT',
          headers: apiHeaders,
          body: JSON.stringify(payload)
        }).catch(() => null);

        const contentType = res?.headers?.get('content-type') || '';
        if (res && res.ok && contentType.includes('application/json')) {
          const savedData = await res.json().catch(() => null);
          setLiveProgress({
            title: '¡Episodios Actualizados!',
            detail: `"${targetAnime.name}" actualizado al 100%`,
            percent: 100,
            current: 3,
            total: 3,
            unit: 'etapas'
          });
          await new Promise(r => setTimeout(r, 260));
          onRefresh(savedData || payload as Anime);
          showNotification(`¡${validItems.length} episodio(s) agregado(s) a "${targetAnime.name}" exitosamente!`, 'success');
          setShowQuickAddEpModal(false);
          setQuickEpItems([{ number: 1, url: '' }]);
        } else {
          if (!db) {
            throw new Error('No hay base de datos Firebase conectada.');
          }
          await setDoc(doc(db, 'animes', targetAnime.id), {
            episodes: existingEps,
            updatedAt: new Date().toISOString()
          }, { merge: true });
          setLiveProgress({
            title: '¡Episodios Actualizados!',
            detail: `"${targetAnime.name}" actualizado al 100% en Firebase Firestore`,
            percent: 100,
            current: 3,
            total: 3,
            unit: 'etapas'
          });
          await new Promise(r => setTimeout(r, 260));
          onRefresh(payload as Anime);
          showNotification(`¡${validItems.length} episodio(s) agregado(s) a "${targetAnime.name}" exitosamente!`, 'success');
          setShowQuickAddEpModal(false);
          setQuickEpItems([{ number: 1, url: '' }]);
        }
      }
    } catch (err) {
      showNotification('Error al guardar episodios.', 'error');
    } finally {
      setIsSavingQuickEp(false);
      setLiveProgress(null);
    }
  };

  // Fast memoized admin ordered and filtered animes list
  const studioMapForAdmin = React.useMemo(() => {
    const map = new Map<string, string>();
    studios.forEach(s => map.set(s.id, s.name));
    return map;
  }, [studios]);

  const genreMapForAdmin = React.useMemo(() => {
    const map = new Map<string, string>();
    genres.forEach(g => map.set(g.id, g.name));
    return map;
  }, [genres]);

  const adminOrderedAnimes = React.useMemo(() => {
    return [...animes]
      .map((anime, originalIndex) => ({ anime, originalIndex }))
      .sort((a, b) => {
        if (a.anime.createdAt && b.anime.createdAt) {
          return new Date(b.anime.createdAt).getTime() - new Date(a.anime.createdAt).getTime();
        }
        return b.originalIndex - a.originalIndex;
      });
  }, [animes]);

  const normalizedAdminAnimes = React.useMemo(() => {
    return animes.map(anime => buildNormalizedAnimeData(anime, studioMapForAdmin, genreMapForAdmin));
  }, [animes, studioMapForAdmin, genreMapForAdmin]);

  const adminFilteredAnimes = React.useMemo(() => {
    const rawQuery = deferredAdminSearch.trim();
    if (!rawQuery) return adminOrderedAnimes;

    const normQuery = normalizeSearchText(rawQuery);
    const normQueryNoSpaces = normQuery.replace(/\s+/g, '');
    const queryTokens = normQuery.split(' ').filter(Boolean);

    const isUpcomingState = (st?: string) => {
      if (!st) return false;
      const lower = st.trim().toLowerCase();
      return lower === 'próximamente' || lower === 'proximamente' || lower.includes('próximamente') || lower.includes('proximamente');
    };

    const isEmisionState = (st?: string) => {
      if (!st || isUpcomingState(st)) return false;
      const lower = st.trim().toLowerCase();
      return lower.includes('emisi') || lower.includes('emisión');
    };

    // Detectar si el usuario busca un estado o borrador (incluso escribiendo parte de la palabra, plural o sin acento)
    let filterDraft = false;
    let filterEmision = false;
    let filterUpcoming = false;
    let filterFinalizado = false;
    const remainingTokens: string[] = [];

    for (let i = 0; i < queryTokens.length; i++) {
      const tok = queryTokens[i];
      if (
        tok === 'borrador' ||
        tok === 'borradores' ||
        tok === 'oculto' ||
        tok === 'ocultos' ||
        (tok.length >= 4 && ('borradores'.startsWith(tok) || 'ocultos'.startsWith(tok)))
      ) {
        filterDraft = true;
      } else if (
        tok === 'emision' ||
        tok === 'emicion' ||
        (tok.length >= 4 && ('emision'.startsWith(tok) || 'emicion'.startsWith(tok)))
      ) {
        filterEmision = true;
      } else if (
        tok === 'proximamente' ||
        tok === 'proximo' ||
        tok === 'proximos' ||
        (tok.length >= 4 && ('proximamente'.startsWith(tok) || 'proximos'.startsWith(tok)))
      ) {
        filterUpcoming = true;
      } else if (
        tok === 'finalizado' ||
        tok === 'finalizados' ||
        (tok.length >= 4 && 'finalizados'.startsWith(tok))
      ) {
        filterFinalizado = true;
      } else if (tok === 'en' && queryTokens.some(t => t.startsWith('emisi') || t.startsWith('emici'))) {
        // Ignorar la preposición "en" cuando escribe "en emisión"
      } else {
        remainingTokens.push(tok);
      }
    }

    const hasStateFilter = filterDraft || filterEmision || filterUpcoming || filterFinalizado;

    if (hasStateFilter && remainingTokens.length === 0) {
      return adminOrderedAnimes.filter(({ anime }) => {
        if (filterDraft && !anime.hidden) return false;
        if (filterEmision && !isEmisionState(anime.status)) return false;
        if (filterUpcoming && !isUpcomingState(anime.status)) return false;
        if (filterFinalizado && (isEmisionState(anime.status) || isUpcomingState(anime.status))) return false;
        return true;
      });
    }

    const remQuery = remainingTokens.join(' ');
    const remQueryNoSpaces = remQuery.replace(/\s+/g, '');

    const matching: { anime: Anime; originalIndex: number; score: number }[] = [];

    for (let i = 0; i < normalizedAdminAnimes.length; i++) {
      const item = normalizedAdminAnimes[i];
      const anime = item.anime;

      if (hasStateFilter) {
        if (filterDraft && !anime.hidden) continue;
        if (filterEmision && !isEmisionState(anime.status)) continue;
        if (filterUpcoming && !isUpcomingState(anime.status)) continue;
        if (filterFinalizado && (isEmisionState(anime.status) || isUpcomingState(anime.status))) continue;
      }

      const activeQuery = hasStateFilter ? remQuery : normQuery;
      const activeNoSpaces = hasStateFilter ? remQueryNoSpaces : normQueryNoSpaces;
      const activeTokens = hasStateFilter ? remainingTokens : queryTokens;

      if (matchesFuzzySearch(activeQuery, activeNoSpaces, activeTokens, item)) {
        const score = calculateRelevanceScore(activeQuery, activeNoSpaces, activeTokens, item);
        matching.push({
          anime,
          originalIndex: i,
          score
        });
      }
    }

    matching.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.originalIndex - a.originalIndex;
    });

    return matching.map(m => ({ anime: m.anime, originalIndex: m.originalIndex }));
  }, [adminOrderedAnimes, deferredAdminSearch, normalizedAdminAnimes]);

  // Admin Anime Table Pagination State (20 per page as requested)
  const [adminAnimePage, setAdminAnimePage] = useState(1);
  const adminItemsPerPage = 20;

  useEffect(() => {
    setAdminAnimePage(1);
  }, [deferredAdminSearch, activeTab, animes.length]);

  const totalAdminAnimePages = Math.ceil(adminFilteredAnimes.length / adminItemsPerPage) || 1;
  const paginatedAdminAnimes = React.useMemo(() => {
    const start = (adminAnimePage - 1) * adminItemsPerPage;
    return adminFilteredAnimes.slice(start, start + adminItemsPerPage);
  }, [adminFilteredAnimes, adminAnimePage]);

  // Precomputed studio & genre counts for O(1) instantaneous render in tabs
  const studioAnimeCounts = React.useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < animes.length; i++) {
      const sIds = (animes[i].studioIds && animes[i].studioIds.length > 0)
        ? animes[i].studioIds!
        : (animes[i].studioId ? [animes[i].studioId] : []);
      for (let j = 0; j < sIds.length; j++) {
        const sId = sIds[j];
        if (sId) map.set(sId, (map.get(sId) || 0) + 1);
      }
    }
    return map;
  }, [animes]);

  const genreAnimeCounts = React.useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < animes.length; i++) {
      const gIds = animes[i].genreIds;
      if (gIds && Array.isArray(gIds)) {
        for (let j = 0; j < gIds.length; j++) {
          map.set(gIds[j], (map.get(gIds[j]) || 0) + 1);
        }
      }
    }
    return map;
  }, [animes]);

  // Real-time calculation of duplicates across all data (only computed when modal is open for max performance)
  const duplicateDiagnostics = React.useMemo(() => {
    if (!showDuplicatesModal) {
      return {
        titleDupes: [],
        telegramDupes: [],
        coverDupes: [],
        episodeLinkDupes: [],
        studioDupes: [],
        genreDupes: [],
        totalDuplicates: 0
      };
    }

    const titles = new Map<string, Anime[]>();
    const telegrams = new Map<string, Anime[]>();
    const covers = new Map<string, Anime[]>();
    const episodeUrls = new Map<string, { anime: Anime; epNumber: number }[]>();
    const studioNames = new Map<string, Studio[]>();
    const genreNames = new Map<string, Genre[]>();

    animes.forEach(a => {
      // Title
      const normTitle = getNormalizedKey(a.name);
      if (normTitle) {
        if (!titles.has(normTitle)) titles.set(normTitle, []);
        titles.get(normTitle)!.push(a);
      }

      // Main Telegram
      const normTg = (a.telegramUrl || '').trim().toLowerCase();
      if (normTg && normTg.length > 5) {
        if (!telegrams.has(normTg)) telegrams.set(normTg, []);
        telegrams.get(normTg)!.push(a);
      }

      // Cover image
      const normImg = (a.image || '').trim();
      if (normImg && normImg.length > 20 && !normImg.startsWith('data:image/svg')) {
        const normImgKey = normImg.length > 200 ? `${normImg.length}-${normImg.slice(0, 100)}-${normImg.slice(-50)}` : normImg;
        if (!covers.has(normImgKey)) covers.set(normImgKey, []);
        covers.get(normImgKey)!.push(a);
      }

      // Episode video URLs
      if (a.episodes && Array.isArray(a.episodes)) {
        a.episodes.forEach(ep => {
          const normEpUrl = getEpisodeUrl(ep).toLowerCase();
          if (normEpUrl && normEpUrl.length > 5) {
            if (!episodeUrls.has(normEpUrl)) episodeUrls.set(normEpUrl, []);
            episodeUrls.get(normEpUrl)!.push({ anime: a, epNumber: ep.number });
          }
        });
      }
    });

    // Studios
    studios.forEach(s => {
      const norm = getNormalizedKey(s.name);
      if (norm) {
        if (!studioNames.has(norm)) studioNames.set(norm, []);
        studioNames.get(norm)!.push(s);
      }
    });

    // Genres
    genres.forEach(g => {
      const norm = getNormalizedKey(g.name);
      if (norm) {
        if (!genreNames.has(norm)) genreNames.set(norm, []);
        genreNames.get(norm)!.push(g);
      }
    });

    const titleDupes = Array.from(titles.values()).filter(g => g.length > 1);
    const telegramDupes = Array.from(telegrams.values()).filter(g => g.length > 1);
    const coverDupes = Array.from(covers.values()).filter(g => g.length > 1);
    const episodeLinkDupes = Array.from(episodeUrls.values()).filter(g => g.length > 1);
    const studioDupes = Array.from(studioNames.values()).filter(g => g.length > 1);
    const genreDupes = Array.from(genreNames.values()).filter(g => g.length > 1);

    const totalDuplicateAnimesCount = new Set([
      ...titleDupes.flatMap(g => g.slice(1).map(x => x.id)),
      ...telegramDupes.flatMap(g => g.slice(1).map(x => x.id)),
      ...coverDupes.flatMap(g => g.slice(1).map(x => x.id)),
      ...episodeLinkDupes.flatMap(g => g.slice(1).map(x => x.anime.id))
    ]).size;

    const totalOtherDuplicates = studioDupes.length + genreDupes.length;

    return {
      titleDupes,
      telegramDupes,
      coverDupes,
      episodeLinkDupes,
      studioDupes,
      genreDupes,
      totalDuplicates: totalDuplicateAnimesCount + totalOtherDuplicates
    };
  }, [animes, studios, genres]);

  // Backup & Real-Time Operation Progress state
  const [backupStatus, setBackupStatus] = useState('');
  const [backupProgress, setBackupProgress] = useState<{ current: number; total: number; percent: number } | null>(null);
  const [exportProgress, setExportProgress] = useState<{ current: number; total: number; percent: number } | null>(null);
  const [importJson, setImportJson] = useState('');
  const [parsedBackupData, setParsedBackupData] = useState<any | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [showExportOptionsModal, setShowExportOptionsModal] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isOptimizingCovers, setIsOptimizingCovers] = useState(false);
  const [isSavingAnime, setIsSavingAnime] = useState(false);
  const [isSavingStudio, setIsSavingStudio] = useState(false);
  const [isSavingGenre, setIsSavingGenre] = useState(false);
  const [liveProgress, setLiveProgress] = useState<{
    title: string;
    detail: string;
    percent: number;
    current?: number;
    total?: number;
    unit?: string;
  } | null>(null);

  // Custom Confirmation Modal & UI Notifications
  const [deleteConfirm, setDeleteConfirm] = useState<{
    type: 'anime' | 'studio' | 'genre' | 'backup';
    id: string;
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  const [notification, setNotification] = useState<{
    message: string;
    type: 'success' | 'error';
  } | null>(null);

  const [selectedAnimeDetails, setSelectedAnimeDetails] = useState<Anime | null>(null);

  // Firebase Live Connection Status state - starts in active live verification
  const [firebaseStatus, setFirebaseStatus] = useState<{
    loading: boolean;
    connected: boolean;
    projectId?: string;
    message?: string;
    lastChecked?: Date;
  }>({
    loading: true,
    connected: false,
    projectId: ''
  });

  // Firebase Quotas & Storage State
  const [quotaStats, setQuotaStats] = useState<{
    loading: boolean;
    data: any | null;
    error: string | null;
    lastUpdated?: Date;
  }>({
    loading: false,
    data: null,
    error: null
  });

  const fetchFirebaseQuotaStats = async () => {
    setQuotaStats(prev => ({ ...prev, loading: true, error: null }));
    try {
      const res = await fetch('/api/firebase/quota', { headers: apiHeaders }).catch(() => null);
      if (res && res.ok) {
        const text = await res.text();
        try {
          const json = JSON.parse(text);
          if (json && json.storage) {
            setQuotaStats({
              loading: false,
              data: json,
              error: null,
              lastUpdated: new Date()
            });
            return;
          }
        } catch (e) {}
      }
    } catch (err: any) {}

    // Fallback: Real-time calculation using available app data (animes, studios, genres)
    try {
      const animesList = animes || [];
      const studiosList = studios || [];
      const genresList = genres || [];

      let totalEpisodesCount = 0;
      let estimatedSizeBytes = 0;

      for (const a of animesList) {
        totalEpisodesCount += (a.episodes || []).length;
        estimatedSizeBytes += new Blob([JSON.stringify(a)]).size;
      }
      for (const s of studiosList) {
        estimatedSizeBytes += new Blob([JSON.stringify(s)]).size;
      }
      for (const g of genresList) {
        estimatedSizeBytes += new Blob([JSON.stringify(g)]).size;
      }

      // Spark Plan (Free Tier) Official Firestore Limits: 1 GiB = 1,073,741,824 bytes
      const SPARK_STORAGE_LIMIT_BYTES = 1 * 1024 * 1024 * 1024;
      const usedStorageBytes = estimatedSizeBytes;
      const remainingStorageBytes = Math.max(0, SPARK_STORAGE_LIMIT_BYTES - usedStorageBytes);
      const usedStorageMB = +(usedStorageBytes / (1024 * 1024)).toFixed(2);
      const remainingStorageMB = +(remainingStorageBytes / (1024 * 1024)).toFixed(2);
      const storagePercentUsed = +((usedStorageBytes / SPARK_STORAGE_LIMIT_BYTES) * 100).toFixed(3);

      const computedStats = {
        planName: 'Spark Plan (Gratuito)',
        projectId: '',
        databaseId: '(default)',
        storage: {
          limitBytes: SPARK_STORAGE_LIMIT_BYTES,
          limitFormatted: '1.00 GB (1,024 MB)',
          usedBytes: usedStorageBytes,
          usedMB: usedStorageMB,
          usedFormatted: `${usedStorageMB} MB`,
          remainingBytes: remainingStorageBytes,
          remainingMB: remainingStorageMB,
          remainingFormatted: `${remainingStorageMB} MB (${(remainingStorageMB / 1024).toFixed(2)} GB)`,
          percentUsed: storagePercentUsed,
          percentRemaining: +(100 - storagePercentUsed).toFixed(3),
          totalCoversDiskMB: +(usedStorageMB * 0.75).toFixed(2),
          totalCoversCount: animesList.filter(a => !!(a.image || a.coverData)).length
        },
        counts: {
          totalDocuments: animesList.length + studiosList.length + genresList.length,
          animes: animesList.length,
          episodes: totalEpisodesCount,
          studios: studiosList.length,
          genres: genresList.length,
          userLists: 0
        }
      };

      setQuotaStats({
        loading: false,
        data: computedStats,
        error: null,
        lastUpdated: new Date()
      });
    } catch (fallbackErr: any) {
      setQuotaStats(prev => ({
        ...prev,
        loading: false,
        error: 'No se pudieron calcular las estadísticas de Firebase.'
      }));
    }
  };

  useEffect(() => {
    if (activeTab === 'firebase-stats') {
      if (!quotaStats.data) {
        fetchFirebaseQuotaStats();
      }
    }
  }, [activeTab, token]);

  const checkFirebaseConnection = async () => {
    setFirebaseStatus(prev => ({ ...prev, loading: true }));
    try {
      // 1. Direct Firebase Firestore client check with 6s timeout (only when configured)
      if (db && isFirebaseConfigured) {
        const directCheckPromise = (async () => {
          const snap = await getDocs(collection(db, 'genres'));
          return snap;
        })();

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Tiempo de espera agotado al conectar con Firestore (timeout)')), 6000)
        );

        try {
          const snap = await Promise.race([directCheckPromise, timeoutPromise]) as any;
          if (snap) {
            setFirebaseStatus({
              loading: false,
              connected: true,
              projectId: db?.app?.options?.projectId || '',
              message: 'Conectado exitosamente en tiempo real a Firebase Firestore',
              lastChecked: new Date()
            });
            return;
          }
        } catch (fbErr: any) {
          console.warn('[Direct Firestore Check Warning]:', fbErr?.message || fbErr);
        }
      }

      // 2. Fallback check via Express API if running on a full server
      const res = await fetch('/api/sync/status').catch(() => null);
      if (res && res.ok) {
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const data = await res.json();
          const isConnected = data.status === 'connected' || data.connected === true;
          setFirebaseStatus({
            loading: false,
            connected: isConnected,
            projectId: data.projectId || '',
            message: isConnected ? 'Conectado exitosamente a Firebase Firestore' : (data.message || 'Sin base de datos Firebase conectada'),
            lastChecked: new Date()
          });
          return;
        }
      }

      // 3. If neither worked:
      setFirebaseStatus({
        loading: false,
        connected: false,
        projectId: '',
        message: 'Sin base de datos Firebase conectada',
        lastChecked: new Date()
      });
    } catch (err: any) {
      setFirebaseStatus({
        loading: false,
        connected: false,
        projectId: '',
        message: 'Error al verificar Firebase: ' + (err?.message || 'Error de conexión'),
        lastChecked: new Date()
      });
    }
  };

  const getAuthHeaders = () => {
    const currentToken = token || (typeof window !== 'undefined' ? localStorage.getItem('hk_admin_token') : '') || '';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-admin-email': currentUser?.email || 'kuzeofc@gmail.com'
    };
    if (currentToken) {
      headers['Authorization'] = `Bearer ${currentToken}`;
    }
    return headers;
  };

  const showNotification = (message: string, type: 'success' | 'error' = 'success') => {
    setNotification({ message, type });
    setTimeout(() => {
      setNotification(null);
    }, 4000);
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const studioFileInputRef = useRef<HTMLInputElement>(null);
  const genreFileInputRef = useRef<HTMLInputElement>(null);

  const handleStudioFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const raw = ev.target?.result as string;
        if (raw) {
          setStudioImage(raw);
        }
      };
      reader.readAsDataURL(file);
    } catch (err) {
      console.error(err);
    }
  };

  const handleGenreFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const raw = ev.target?.result as string;
        if (raw) {
          setGenreImage(raw);
        }
      };
      reader.readAsDataURL(file);
    } catch (err) {
      console.error(err);
    }
  };

  const ADMIN_EMAILS = ['kuzeofc@gmail.com', 'kuzehentai@gmail.com', 'metzelderkz@gmail.com'];
  const isAuthorizedAdmin = (email?: string | null) => {
    if (!email) return false;
    return ADMIN_EMAILS.includes(email.toLowerCase().trim());
  };

  const isAdminEmail = isAuthorizedAdmin(currentUser?.email);

  const onBackToHomeRef = useRef(onBackToHome);
  onBackToHomeRef.current = onBackToHome;

  // Strict route protection: redirect to home immediately if not authorized admin
  useEffect(() => {
    if (!currentUser || !isAuthorizedAdmin(currentUser.email)) {
      onBackToHomeRef.current();
      if (window.location.pathname === '/admin') {
        window.history.replaceState(null, '', '/');
      }
    }
  }, [currentUser?.email]);

  // Check auth validity on load and ensure page is scrolled to top upon entering
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    requestAnimationFrame(() => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    });
  }, []);

  // Check Firebase connection immediately upon entering admin panel and load trash
  useEffect(() => {
    checkFirebaseConnection();
    fetchTrash();
  }, []);

  useEffect(() => {
    const userUid = currentUser?.uid || 'kuzeofc';
    const userEmail = currentUser?.email;
    const fallbackToken = 'fb_admin_' + userUid;

    if (isAdminEmail && !token) {
      // Auto-authenticate kuzeofc@gmail.com without asking for a password
      fetch('/api/auth/admin-auto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: userEmail })
      })
        .then(res => res.json())
        .then(data => {
          if (data.success && data.token) {
            localStorage.setItem('hk_admin_token', data.token);
            setToken(prev => (prev === data.token ? prev : data.token));
          } else {
            localStorage.setItem('hk_admin_token', fallbackToken);
            setToken(prev => (prev === fallbackToken ? prev : fallbackToken));
          }
        })
        .catch(() => {
          // Static hosting fallback (e.g. Vercel)
          localStorage.setItem('hk_admin_token', fallbackToken);
          setToken(prev => (prev === fallbackToken ? prev : fallbackToken));
        });
    } else if (token && !token.startsWith('fb_admin_')) {
      fetch('/api/auth/verify', {
        headers: { 'Authorization': `Bearer ${token}` }
      })
        .then(res => res.json())
        .then(data => {
          if (!data.valid) {
            if (isAdminEmail) {
              localStorage.setItem('hk_admin_token', fallbackToken);
              setToken(prev => (prev === fallbackToken ? prev : fallbackToken));
            } else {
              handleLogout();
            }
          }
        })
        .catch(() => {
          if (isAdminEmail) {
            setToken(prev => (prev === fallbackToken ? prev : fallbackToken));
          } else {
            handleLogout();
          }
        });
    }
  }, [token, currentUser?.uid, currentUser?.email, isAdminEmail]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setIsSubmitting(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (res.ok && data.success && data.token) {
        localStorage.setItem('hk_admin_token', data.token);
        setToken(data.token);
        setUsername('');
        setPassword('');
        onRefresh();
      } else {
        setAuthError(data.error || 'Credenciales inválidas');
      }
    } catch (err) {
      setAuthError('Fallo de conexión con el servidor.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } catch (e) {}
    localStorage.removeItem('hk_admin_token');
    setToken('');
  };

  const [appTheme] = useAppTheme();

  const apiHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token || (typeof window !== 'undefined' ? localStorage.getItem('hk_admin_token') : '') || ''}`,
    'x-admin-email': currentUser?.email || 'kuzehentai@gmail.com'
  };

  // --- STUDIO ACTIONS ---
  const handleSaveStudio = async (e: React.FormEvent) => {
    e.preventDefault();
    setStudioError('');
    if (!studioName.trim()) return setStudioError('El nombre es requerido');

    const slug = studioName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const targetId = editingStudio ? editingStudio.id : (slug ? `st-${slug}` : ('st-' + Math.random().toString(36).substring(2, 9)));
    const finalImage = studioImage || '';
    const opLabel = editingStudio ? 'Actualizando Estudio' : 'Creando Estudio';

    setIsSavingStudio(true);
    setLiveProgress({
      title: opLabel,
      detail: `Validando datos y portada de "${studioName.trim()}"...`,
      percent: 25,
      current: 1,
      total: 3,
      unit: 'etapas'
    });

    try {
      setLiveProgress({
        title: opLabel,
        detail: `Sincronizando estudio "${studioName.trim()}" con la base de datos...`,
        percent: 62,
        current: 2,
        total: 3,
        unit: 'etapas'
      });

      const url = editingStudio ? `/api/studios/${editingStudio.id}` : '/api/studios';
      const method = editingStudio ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: apiHeaders,
        body: JSON.stringify({ name: studioName.trim(), image: finalImage })
      }).catch(() => null);

      if (res && res.ok) {
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const savedStudio = await res.json().catch(() => null);
          if (savedStudio && savedStudio.id) {
            setLiveProgress({
              title: editingStudio ? '¡Estudio Actualizado!' : '¡Estudio Creado!',
              detail: `"${studioName.trim()}" guardado al 100%`,
              percent: 100,
              current: 3,
              total: 3,
              unit: 'etapas'
            });
            await new Promise(r => setTimeout(r, 260));
            setStudioName('');
            setStudioImage('');
            setEditingStudio(null);
            onRefresh();
            const loc = savedStudio?.storageLocation || 'Firebase Firestore';
            showNotification(
              editingStudio ? `Estudio actualizado con éxito en ${loc}` : `Estudio creado con éxito en ${loc}`,
              'success'
            );
            return;
          }
        }
      }

      if (res && res.status === 401) {
        handleLogout();
        return setStudioError('Tu sesión ha expirado. Por favor vuelve a ingresar.');
      }

      // Direct Firebase Firestore Fallback (e.g. Vercel deployment where Express /api/ is not running)
      if (!db) {
        throw new Error('No hay base de datos Firebase conectada.');
      }
      setLiveProgress({
        title: opLabel,
        detail: `Optimizando portada y guardando en Firebase Firestore...`,
        percent: 82,
        current: 2,
        total: 3,
        unit: 'etapas'
      });
      const safeImage = await ensureFirestoreSafeImage(finalImage);
      const payload = {
        id: targetId,
        name: studioName.trim(),
        image: safeImage,
        storageLocation: 'Firebase Firestore',
        updatedAt: new Date().toISOString()
      };
      await setDoc(doc(db, 'studios', targetId), payload, { merge: true });

      setLiveProgress({
        title: editingStudio ? '¡Estudio Actualizado!' : '¡Estudio Creado!',
        detail: `"${studioName.trim()}" sincronizado al 100% en Firebase Firestore`,
        percent: 100,
        current: 3,
        total: 3,
        unit: 'etapas'
      });
      await new Promise(r => setTimeout(r, 260));

      setStudioName('');
      setStudioImage('');
      setEditingStudio(null);
      onRefresh();
      showNotification(
        editingStudio ? `Estudio actualizado con éxito en Firebase Firestore` : `Estudio creado con éxito en Firebase Firestore`,
        'success'
      );
    } catch (err: any) {
      try {
        if (!db) {
          throw new Error('No hay base de datos Firebase conectada.');
        }
        const safeImage = await ensureFirestoreSafeImage(finalImage);
        const payload = {
          id: targetId,
          name: studioName.trim(),
          image: safeImage,
          storageLocation: 'Firebase Firestore',
          updatedAt: new Date().toISOString()
        };
        await setDoc(doc(db, 'studios', targetId), payload, { merge: true });
        setLiveProgress({
          title: editingStudio ? '¡Estudio Actualizado!' : '¡Estudio Creado!',
          detail: `"${studioName.trim()}" guardado al 100%`,
          percent: 100,
          current: 3,
          total: 3,
          unit: 'etapas'
        });
        await new Promise(r => setTimeout(r, 240));
        setStudioName('');
        setStudioImage('');
        setEditingStudio(null);
        onRefresh();
        showNotification('Estudio guardado con éxito en Firebase Firestore', 'success');
      } catch (fbErr: any) {
        setStudioError('Error al guardar el estudio: ' + (fbErr?.message || 'Error de red'));
      }
    } finally {
      setIsSavingStudio(false);
      setLiveProgress(null);
    }
  };

  const executeDeleteStudio = async (id: string) => {
    try {
      // 1. Server endpoint call
      await fetch(`/api/studios/${id}`, { method: 'DELETE', headers: apiHeaders }).catch(() => null);

      // 2. Direct Firebase Firestore deletion fallback
      if (db) {
        await deleteDoc(doc(db, 'studios', id)).catch(() => null);
      }

      onRefresh();
      showNotification('Estudio eliminado con éxito', 'success');
    } catch (err) {
      showNotification('Error al eliminar estudio.', 'error');
    }
  };

  const handleDeleteStudio = (id: string) => {
    const studio = studios.find(s => s.id === id);
    setDeleteConfirm({
      type: 'studio',
      id,
      title: 'Eliminar Estudio',
      message: `¿Seguro que deseas eliminar el estudio "${studio?.name || 'este estudio'}"? Se perderá la relación con los animes.`,
      onConfirm: () => executeDeleteStudio(id)
    });
  };

  // --- GENRE ACTIONS ---
  const handleSaveGenre = async (e: React.FormEvent) => {
    e.preventDefault();
    setGenreError('');
    if (!genreName.trim()) return setGenreError('El nombre es requerido');

    const slug = genreName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const targetId = editingGenre ? editingGenre.id : (slug ? `gn-${slug}` : ('gn-' + Math.random().toString(36).substring(2, 9)));
    const finalImage = genreImage || '';
    const opLabel = editingGenre ? 'Actualizando Género' : 'Creando Género';

    setIsSavingGenre(true);
    setLiveProgress({
      title: opLabel,
      detail: `Validando datos y portada de "${genreName.trim()}"...`,
      percent: 25,
      current: 1,
      total: 3,
      unit: 'etapas'
    });

    try {
      setLiveProgress({
        title: opLabel,
        detail: `Sincronizando género "${genreName.trim()}" con la base de datos...`,
        percent: 62,
        current: 2,
        total: 3,
        unit: 'etapas'
      });

      const url = editingGenre ? `/api/genres/${editingGenre.id}` : '/api/genres';
      const method = editingGenre ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: apiHeaders,
        body: JSON.stringify({ name: genreName.trim(), image: finalImage })
      }).catch(() => null);

      if (res && res.ok) {
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const savedGenre = await res.json().catch(() => null);
          if (savedGenre && savedGenre.id) {
            setLiveProgress({
              title: editingGenre ? '¡Género Actualizado!' : '¡Género Creado!',
              detail: `"${genreName.trim()}" guardado al 100%`,
              percent: 100,
              current: 3,
              total: 3,
              unit: 'etapas'
            });
            await new Promise(r => setTimeout(r, 260));
            setGenreName('');
            setGenreImage('');
            setEditingGenre(null);
            onRefresh();
            const loc = savedGenre?.storageLocation || 'Firebase Firestore';
            showNotification(
              editingGenre ? `Género actualizado con éxito en ${loc}` : `Género creado con éxito en ${loc}`,
              'success'
            );
            return;
          }
        }
      }

      if (res && res.status === 401) {
        handleLogout();
        return setGenreError('Tu sesión ha expirado. Por favor vuelve a ingresar.');
      }

      // Direct Firebase Firestore Fallback (e.g. Vercel deployment)
      if (!db) {
        throw new Error('No hay base de datos Firebase conectada.');
      }
      setLiveProgress({
        title: opLabel,
        detail: `Optimizando portada y guardando en Firebase Firestore...`,
        percent: 82,
        current: 2,
        total: 3,
        unit: 'etapas'
      });
      const safeImage = await ensureFirestoreSafeImage(finalImage);
      const payload = {
        id: targetId,
        name: genreName.trim(),
        image: safeImage,
        storageLocation: 'Firebase Firestore',
        updatedAt: new Date().toISOString()
      };
      await setDoc(doc(db, 'genres', targetId), payload, { merge: true });

      setLiveProgress({
        title: editingGenre ? '¡Género Actualizado!' : '¡Género Creado!',
        detail: `"${genreName.trim()}" sincronizado al 100% en Firebase Firestore`,
        percent: 100,
        current: 3,
        total: 3,
        unit: 'etapas'
      });
      await new Promise(r => setTimeout(r, 260));

      setGenreName('');
      setGenreImage('');
      setEditingGenre(null);
      onRefresh();
      showNotification(
        editingGenre ? `Género actualizado con éxito en Firebase Firestore` : `Género creado con éxito en Firebase Firestore`,
        'success'
      );
    } catch (err: any) {
      try {
        if (!db) {
          throw new Error('No hay base de datos Firebase conectada.');
        }
        const safeImage = await ensureFirestoreSafeImage(finalImage);
        const payload = {
          id: targetId,
          name: genreName.trim(),
          image: safeImage,
          storageLocation: 'Firebase Firestore',
          updatedAt: new Date().toISOString()
        };
        await setDoc(doc(db, 'genres', targetId), payload, { merge: true });
        setLiveProgress({
          title: editingGenre ? '¡Género Actualizado!' : '¡Género Creado!',
          detail: `"${genreName.trim()}" guardado al 100%`,
          percent: 100,
          current: 3,
          total: 3,
          unit: 'etapas'
        });
        await new Promise(r => setTimeout(r, 240));
        setGenreName('');
        setGenreImage('');
        setEditingGenre(null);
        onRefresh();
        showNotification('Género guardado con éxito en Firebase Firestore', 'success');
      } catch (fbErr: any) {
        setGenreError('Error al guardar el género: ' + (fbErr?.message || 'Error de red'));
      }
    } finally {
      setIsSavingGenre(false);
      setLiveProgress(null);
    }
  };

  const executeDeleteGenre = async (id: string) => {
    try {
      await fetch(`/api/genres/${id}`, { method: 'DELETE', headers: apiHeaders }).catch(() => null);
      if (db) {
        await deleteDoc(doc(db, 'genres', id)).catch(() => null);
      }

      onRefresh();
      showNotification('Género eliminado con éxito', 'success');
    } catch (err) {
      showNotification('Error al eliminar género.', 'error');
    }
  };

  const handleDeleteGenre = (id: string) => {
    const genre = genres.find(g => g.id === id);
    setDeleteConfirm({
      type: 'genre',
      id,
      title: 'Eliminar Género',
      message: `¿Seguro que deseas eliminar el género "${genre?.name || 'este género'}"?`,
      onConfirm: () => executeDeleteGenre(id)
    });
  };

  // --- ANIME ACTIONS ---
  const openNewAnimeForm = () => {
    editingAnimeIdRef.current = null;
    initialEditCoverRef.current = '';
    setIsLoadingEditCover(false);
    setEditingAnime(null);
    setAnimeName('');
    setAnimeImage('');
    setAnimeCoverUrlInput('');
    setAnimeStudioId(lastUsedStudio.id);
    setAnimeStudioSearch(lastUsedStudio.search);
    setAnimeGenreIds([]);
    setAnimeGenresInput('');
    setAnimeStatus('Finalizado');
    setAnimeYear('');
    setAnimeReleaseMonth('');
    setAnimeDescription('');
    setAnimeTelegramUrl('');
    setSingleEpIsNew(false);
    setAnimeEpisodes([]);
    setAnimeHidden(false);
    setAnimeContinuationType('');
    setAnimeContinuationIds([]);
    setInitialContinuationIds([]);
    setShowContinuationOptions(false);
    setIsContinuationModalOpen(false);
    setContinuationSearchQuery('');
    setTempContinuationIds([]);
    setIsImageOptimized(false);
    setAnimeFormError('');
    setIsAnimeFormOpen(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const openEditAnimeForm = (anime: Anime) => {
    editingAnimeIdRef.current = anime.id;
    setEditingAnime(anime);
    setAnimeName(anime.name);
    const hasExternalUrl = Boolean(anime.image && /^https?:\/\//i.test(anime.image.trim()));
    const inlineBase64 =
      (anime.coverData && anime.coverData.startsWith('data:image/'))
        ? anime.coverData
        : (anime.image && anime.image.startsWith('data:image/') ? anime.image : '');
    const initialCover = hasExternalUrl ? anime.image.trim() : inlineBase64;
    initialEditCoverRef.current = initialCover;
    setAnimeImage(initialCover);
    setAnimeCoverUrlInput(hasExternalUrl ? anime.image.trim() : '');
    setIsImageOptimized(false);

    if (!hasExternalUrl && !inlineBase64 && anime.id) {
      setIsLoadingEditCover(true);
      const targetEditId = anime.id;
      const expectedVer = typeof anime.portadaVersion === 'number' ? anime.portadaVersion : 1;
      (async () => {
        try {
          const remote = await fetchPortadaFromFirestore(targetEditId, expectedVer);
          if (remote?.imagen && editingAnimeIdRef.current === targetEditId) {
            initialEditCoverRef.current = remote.imagen;
            setAnimeImage(remote.imagen);
          }
        } catch {
          // Ignore load error
        } finally {
          if (editingAnimeIdRef.current === targetEditId) {
            setIsLoadingEditCover(false);
          }
        }
      })();
    } else {
      setIsLoadingEditCover(false);
    }
    
    const sIds = (anime.studioIds && anime.studioIds.length > 0)
      ? anime.studioIds
      : (anime.studioId ? [anime.studioId] : []);
    setAnimeStudioId(anime.studioId || (sIds[0] || ''));
    
    const currentStudioNames = sIds
      .map(id => studios.find(s => s.id === id)?.name || '')
      .filter(Boolean)
      .join(', ');
    setAnimeStudioSearch(currentStudioNames);

    setAnimeGenreIds(anime.genreIds || []);
    
    // Pre-populate input field with existing genre names separated by comma
    const initialGenreNames = (anime.genreIds || [])
      .map(id => {
        const g = genres.find(x => x.id === id);
        return g ? g.name : '';
      })
      .filter(Boolean)
      .join(', ');
    setAnimeGenresInput(initialGenreNames);

    const rawStatus = anime.status || 'Finalizado';
    let cleanStatus = 'Finalizado';
    if (rawStatus === 'Próximamente' || rawStatus.toLowerCase() === 'próximamente' || rawStatus.toLowerCase() === 'proximamente') {
      cleanStatus = 'Próximamente';
    } else if (rawStatus.toLowerCase().includes('emisi')) {
      cleanStatus = 'Emisión';
    }
    setAnimeStatus(cleanStatus);
    setAnimeYear(anime.year || '');
    setAnimeReleaseMonth(anime.releaseMonth || '');
    setAnimeDescription(anime.description || '');
    setAnimeTelegramUrl(anime.telegramUrl || '');
    
    const firstEpIsNew = anime.episodes && anime.episodes.length > 0
      ? Boolean(anime.episodes[0]?.isNew)
      : false;
    setSingleEpIsNew(firstEpIsNew);

    if (anime.episodes && anime.episodes.length > 0) {
      setAnimeEpisodes(anime.episodes.map(ep => ({
        number: Number(ep.number) || 1,
        mp4Url: getEpisodeUrl(ep),
        isNew: Boolean(ep.isNew),
        addedToRecentAt: ep.addedToRecentAt,
        coverImage: ep.coverImage,
        thumbnail: ep.thumbnail,
        title: ep.title
      })));
    } else {
      setAnimeEpisodes([]);
    }

    const resolvedCont = resolveContinuationGroup(anime, animes);
    const existingContIds = resolvedCont.linkedAnimes.map(a => a.id);
    setAnimeContinuationType(resolvedCont.type || anime.continuationType || '');
    setAnimeContinuationIds(existingContIds);
    setInitialContinuationIds(existingContIds);
    setShowContinuationOptions(false);
    setIsContinuationModalOpen(false);
    setContinuationSearchQuery('');
    setTempContinuationIds(existingContIds);

    setAnimeHidden(anime.hidden);
    setAnimeFormError('');
    setIsAnimeFormOpen(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleToggleEpisodeNew = (index: number) => {
    setAnimeEpisodes(prev => {
      const updated = [...prev];
      const nextIsNew = !updated[index].isNew;
      updated[index] = { 
        ...updated[index], 
        isNew: nextIsNew,
        addedToRecentAt: nextIsNew 
          ? new Date().toISOString()
          : undefined
      };
      return updated;
    });
  };

  const handleEpisodeCoverUpload = (index: number, file: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      if (result) {
        // Sin optimización: se conserva la imagen original sin comprimir ni redimensionar
        setAnimeEpisodes(prev => {
          const updated = [...prev];
          updated[index] = { ...updated[index], coverImage: result };
          return updated;
        });
        showNotification(`Portada lista para el Episodio ${animeEpisodes[index]?.number || (index + 1)}`, 'success');
      }
    };
    reader.readAsDataURL(file);
  };

  const handleEpisodeThumbnailUpload = (index: number, file: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      if (result) {
        // Sin optimización: se conserva la imagen original sin comprimir ni redimensionar
        setAnimeEpisodes(prev => {
          const updated = [...prev];
          updated[index] = { ...updated[index], thumbnail: result };
          return updated;
        });
        showNotification(`Miniatura lista para el Episodio ${animeEpisodes[index]?.number || (index + 1)}`, 'success');
      }
    };
    reader.readAsDataURL(file);
  };

  const handleAddEpisode = () => {
    const nextNum = animeEpisodes.length > 0
      ? Math.max(...animeEpisodes.map(ep => Number(ep.number) || 0)) + 1
      : 1;
    setAnimeEpisodes(prev => [...prev, { number: nextNum, mp4Url: '', isNew: false }]);
  };

  const handleAddMultipleEpisodes = (count: number) => {
    const toAdd = Math.max(0, count);
    if (toAdd <= 0) return;

    setAnimeEpisodes(prev => {
      const nextNum = prev.length > 0
        ? Math.max(...prev.map(ep => Number(ep.number) || 0)) + 1
        : 1;
      const newEps = [];
      for (let i = 0; i < toAdd; i++) {
        newEps.push({ number: nextNum + i, mp4Url: '', isNew: false });
      }
      return [...prev, ...newEps];
    });

    showNotification(`Se agregaron ${toAdd} campo(s) de episodio.`, 'success');
  };

  const handleUpdateEpisodeNumber = (index: number, numVal: any) => {
    setAnimeEpisodes(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], number: Number(numVal) || 1 };
      return updated;
    });
  };

  const handleEpisodeUrlChange = (index: number, value: string) => {
    const urlVal = value.trim();
    setAnimeEpisodes(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], mp4Url: value };

      // Ensure the input element shows the tail end of the link
      setTimeout(() => {
        const inputEl = episodeInputRefs.current[index];
        if (inputEl) {
          inputEl.scrollLeft = inputEl.scrollWidth;
        }
      }, 0);

      // If a link/URL is pasted or entered
      if (urlVal.length > 8 || urlVal.startsWith('http') || urlVal.includes('archive.org')) {
        // Look for subsequent empty chapter fields after index
        const nextEmptyIdx = updated.findIndex((ep, i) => i > index && (!ep.mp4Url || ep.mp4Url.trim() === ''));
        
        if (nextEmptyIdx !== -1) {
          // There are still empty chapter fields AFTER this index!
          // Immediately focus the next empty input field so the user can paste continuously without losing keyboard
          setTimeout(() => {
            const nextEl = episodeInputRefs.current[nextEmptyIdx];
            if (nextEl) {
              nextEl.focus();
              nextEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          }, 30);
        } else {
          // Check if there are ANY other empty chapter fields anywhere in the list
          const anyEmptyIdx = updated.findIndex((ep, i) => i !== index && (!ep.mp4Url || ep.mp4Url.trim() === ''));
          if (anyEmptyIdx !== -1) {
            setTimeout(() => {
              const anyEl = episodeInputRefs.current[anyEmptyIdx];
              if (anyEl) {
                anyEl.focus();
                anyEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              }
            }, 30);
          }
        }
      }

      return updated;
    });
  };

  const handleRemoveEpisode = (index: number) => {
    setSwipedEpisodeIdx(null);
    setSwipedEpisodeOffset(0);
    setAnimeEpisodes(prev => prev.filter((_, i) => i !== index));
  };

  const handleToggleGenreInput = (genreName: string) => {
    const current = animeGenresInput
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    
    const targetKey = getNormalizedKey(genreName);
    const index = current.findIndex(s => getNormalizedKey(s) === targetKey);
    if (index >= 0) {
      current.splice(index, 1);
    } else {
      current.push(genreName);
    }
    setAnimeGenresInput(current.join(', '));
  };

  const handleToggleStudioInput = (sName: string) => {
    const current = animeStudioSearch
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    
    const targetKey = getNormalizedKey(sName);
    const index = current.findIndex(s => getNormalizedKey(s) === targetKey);
    if (index >= 0) {
      current.splice(index, 1);
    } else {
      current.push(sName);
    }
    const newStudioSearch = current.join(', ');
    setAnimeStudioSearch(newStudioSearch);
    if (newStudioSearch.trim()) {
      updateLastUsedStudio(newStudioSearch);
    }
  };

  const handleDeduplicate = async () => {
    setIsDeduplicating(true);
    try {
      const res = await fetch('/api/admin/deduplicate', {
        method: 'POST',
        headers: apiHeaders
      });
      if (res.ok) {
        const data = await res.json();
        onRefresh();
        showNotification(`Unificación completada: ${data.studiosMerged || 0} estudios y ${data.genresMerged || 0} géneros unificados.`, 'success');
      } else {
        showNotification('Error al unificar la base de datos.', 'error');
      }
    } catch (err) {
      showNotification('Error de conexión al unificar.', 'error');
    } finally {
      setIsDeduplicating(false);
    }
  };

  const handleGenreCheckboxChange = (genreId: string) => {
    if (animeGenreIds.includes(genreId)) {
      setAnimeGenreIds(animeGenreIds.filter(id => id !== genreId));
    } else {
      setAnimeGenreIds([...animeGenreIds, genreId]);
    }
  };

  const processImageFile = async (file: File) => {
    setImageUploadLoading(true);
    setAnimeFormError('');

    const isImage = file.type.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif|bmp|heic|svg)$/i.test(file.name);
    if (!isImage) {
      setAnimeFormError('El archivo seleccionado no es una imagen válida (.jpg, .png, .webp)');
      setImageUploadLoading(false);
      return;
    }

    try {
      const reader = new FileReader();
      reader.onload = async (event) => {
        const rawBase64 = event.target?.result as string;
        if (rawBase64) {
          // Sin optimización: se conserva la imagen 100% original
          setAnimeImage(rawBase64);
          setAnimeCoverUrlInput('');
          setIsImageOptimized(false);
        }
        setImageUploadLoading(false);
      };
      reader.onerror = () => {
        setAnimeFormError('Error al leer el archivo de imagen.');
        setImageUploadLoading(false);
      };
      reader.readAsDataURL(file);
    } catch (err) {
      setAnimeFormError('Error de carga de imagen.');
      setImageUploadLoading(false);
    }
  };

  const handleImageFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await processImageFile(file);
    }
  };

  const handleImageDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      await processImageFile(file);
    }
  };

  const handleSaveAnime = async (e: React.FormEvent) => {
    e.preventDefault();
    setAnimeFormError('');

    const trimmedName = animeName.trim();
    if (!trimmedName) return setAnimeFormError('El nombre es requerido');
    
    const isUpcomingForm = animeStatus === 'Próximamente';
    const trimmedStudioSearch = animeStudioSearch.trim();

    // Parse and dynamically create/find multiple studios (optional)!
    const targetStudioIds: string[] = [];
    const typedStudios = animeStudioSearch
      .split(',')
      .map(name => name.trim())
      .filter(Boolean);

    const opTitle = editingAnime ? 'Actualizando Anime' : 'Guardando Nuevo Anime';
    setIsSavingAnime(true);
    setLiveProgress({
      title: opTitle,
      detail: `Validando datos de "${trimmedName}"...`,
      percent: 12,
      current: 1,
      total: 5,
      unit: 'etapas'
    });

    try {
      for (let sIdx = 0; sIdx < typedStudios.length; sIdx++) {
        const sName = typedStudios[sIdx];
        setLiveProgress({
          title: opTitle,
          detail: `Procesando estudio ${sIdx + 1} de ${typedStudios.length}: "${sName}"...`,
          percent: 15 + Math.round(((sIdx + 1) / Math.max(1, typedStudios.length)) * 20),
          current: 2,
          total: 5,
          unit: 'etapas'
        });

        const reqStudioKey = getNormalizedKey(sName);
        const existingStudio = studios.find(
          s => getNormalizedKey(s.name) === reqStudioKey
        );

        if (existingStudio) {
          if (!targetStudioIds.includes(existingStudio.id)) {
            targetStudioIds.push(existingStudio.id);
          }
        } else {
          // Dynamic on-the-fly studio creation (with direct Firebase Firestore fallback for Vercel)!
          const slug = sName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const fallbackStudioId = slug ? `st-${slug}` : ('st-' + Math.random().toString(36).substring(2, 9));
          let createdStudioId = '';

          try {
            const res = await fetch('/api/studios', {
              method: 'POST',
              headers: apiHeaders,
              body: JSON.stringify({ name: sName, order: 10 })
            }).catch(() => null);

            const contentType = res?.headers?.get('content-type') || '';
            if (res && res.ok && contentType.includes('application/json')) {
              const newStudio = await res.json().catch(() => null);
              if (newStudio && newStudio.id) {
                createdStudioId = newStudio.id;
              }
            }
          } catch (err) {
            // Proceed to Firestore fallback
          }

          if (!createdStudioId) {
            if (!db) {
              return setAnimeFormError(`No hay base de datos Firebase conectada para crear "${sName}".`);
            }
            try {
              const studioPayload = {
                id: fallbackStudioId,
                name: sName.trim(),
                image: '',
                order: 10,
                storageLocation: 'Firebase Firestore',
                updatedAt: new Date().toISOString()
              };
              await setDoc(doc(db, 'studios', fallbackStudioId), studioPayload, { merge: true });
              createdStudioId = fallbackStudioId;
            } catch (fbErr: any) {
              return setAnimeFormError(`Error al crear el nuevo estudio automático "${sName}": ${fbErr?.message || 'Error de conexión'}`);
            }
          }

          if (createdStudioId && !targetStudioIds.includes(createdStudioId)) {
            targetStudioIds.push(createdStudioId);
          }
        }
      }

      const primaryStudioId = targetStudioIds[0] || '';

      // Parse and dynamically create/find genres (skip if status is Próximamente)
      const targetGenreIds: string[] = [];
      const typedGenres = isUpcomingForm
        ? []
        : animeGenresInput
            .split(',')
            .map(name => name.trim())
            .filter(Boolean);

      for (let gIdx = 0; gIdx < typedGenres.length; gIdx++) {
        const gName = typedGenres[gIdx];
        setLiveProgress({
          title: opTitle,
          detail: `Procesando género ${gIdx + 1} de ${typedGenres.length}: "${gName}"...`,
          percent: 38 + Math.round(((gIdx + 1) / Math.max(1, typedGenres.length)) * 20),
          current: 3,
          total: 5,
          unit: 'etapas'
        });

        const reqGenreKey = getNormalizedKey(gName);
        const existingG = genres.find(
          g => getNormalizedKey(g.name) === reqGenreKey
        );
        if (existingG) {
          if (!targetGenreIds.includes(existingG.id)) {
            targetGenreIds.push(existingG.id);
          }
        } else {
          // Create the genre on-the-fly (with direct Firebase Firestore fallback for Vercel)!
          const slug = gName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const fallbackGenreId = slug ? `gn-${slug}` : ('gn-' + Math.random().toString(36).substring(2, 9));
          let createdGenreId = '';

          try {
            const res = await fetch('/api/genres', {
              method: 'POST',
              headers: apiHeaders,
              body: JSON.stringify({ name: gName, order: 10 })
            }).catch(() => null);

            const contentType = res?.headers?.get('content-type') || '';
            if (res && res.ok && contentType.includes('application/json')) {
              const newGenre = await res.json().catch(() => null);
              if (newGenre && newGenre.id) {
                createdGenreId = newGenre.id;
              }
            }
          } catch (err) {
            // Proceed to Firestore fallback
          }

          if (!createdGenreId) {
            if (!db) {
              return setAnimeFormError(`No hay base de datos Firebase conectada para crear "${gName}".`);
            }
            try {
              const genrePayload = {
                id: fallbackGenreId,
                name: gName.trim(),
                image: '',
                order: 10,
                storageLocation: 'Firebase Firestore',
                updatedAt: new Date().toISOString()
              };
              await setDoc(doc(db, 'genres', fallbackGenreId), genrePayload, { merge: true });
              createdGenreId = fallbackGenreId;
            } catch (fbErr: any) {
              return setAnimeFormError(`Error al crear el género automático "${gName}": ${fbErr?.message || 'Error de conexión'}`);
            }
          }

          if (createdGenreId && !targetGenreIds.includes(createdGenreId)) {
            targetGenreIds.push(createdGenreId);
          }
        }
      }

      setLiveProgress({
        title: opTitle,
        detail: `Organizando episodios y preparando portada de "${trimmedName}"...`,
        percent: 65,
        current: 4,
        total: 5,
        unit: 'etapas'
      });

      let cleanEpisodes = animeEpisodes
        .map((ep, idx) => {
          const link = String(ep.mp4Url || '').trim();
          const epNum = Number(ep.number) || 1;
          const origEp = editingAnime?.episodes?.find((e: any) => Number(e.number) === epNum);
          const isNew = Boolean(ep.isNew);
          const wasCurrentlyInRecents = Boolean(origEp?.isNew && origEp?.addedToRecentAt);
          const preservedTimestamp = wasCurrentlyInRecents ? (ep.addedToRecentAt || origEp?.addedToRecentAt) : undefined;
          const preservedCover = ep.coverImage !== undefined ? ep.coverImage : origEp?.coverImage;
          const preservedThumbnail = ep.thumbnail !== undefined ? ep.thumbnail : origEp?.thumbnail;
          const preservedTitle = ep.title || origEp?.title;

          const epRecord: Record<string, any> = {
            number: epNum,
            mp4Url: link,
            isNew,
          };
          if (isNew) {
            epRecord.addedToRecentAt = preservedTimestamp || new Date(Date.now() + idx).toISOString();
          }
          if (preservedCover !== undefined) epRecord.coverImage = preservedCover;
          if (preservedThumbnail !== undefined) epRecord.thumbnail = preservedThumbnail;
          if (preservedTitle !== undefined) epRecord.title = preservedTitle;
          return epRecord;
        })
        .filter(ep => ep.mp4Url !== '');

      const primaryTelegramUrl = isUpcomingForm ? '' : animeTelegramUrl.trim();

      if (cleanEpisodes.length === 0 && singleEpIsNew && primaryTelegramUrl) {
        const singleEp: Record<string, any> = {
          number: 1,
          mp4Url: primaryTelegramUrl,
          isNew: true,
          addedToRecentAt: editingAnime?.episodes?.[0]?.addedToRecentAt || new Date().toISOString(),
        };
        if (editingAnime?.episodes?.[0]?.coverImage !== undefined) {
          singleEp.coverImage = editingAnime.episodes[0].coverImage;
        }
        cleanEpisodes = [singleEp];
      }

      const finalStatus = animeStatus || 'Finalizado';

      const isUpcomingStr = (st?: string) => {
        if (!st) return false;
        const lower = st.trim().toLowerCase();
        return lower === 'próximamente' || lower === 'proximamente' || lower.includes('próximamente') || lower.includes('proximamente');
      };

      const wasUpcoming = editingAnime ? isUpcomingStr(editingAnime.status) : false;
      const isNowInCatalog = !isUpcomingStr(finalStatus);
      const isPromotedFromUpcoming = Boolean(editingAnime && wasUpcoming && isNowInCatalog);

      let maxTime = Date.now();
      for (const a of animes) {
        if (a.id !== editingAnime?.id && a.createdAt) {
          const t = new Date(a.createdAt).getTime();
          if (!isNaN(t) && t >= maxTime) {
            maxTime = t + 1000;
          }
        }
      }
      const latestCatalogTimestamp = new Date(maxTime).toISOString();

      const effectiveCreatedAt = editingAnime
        ? (isPromotedFromUpcoming ? latestCatalogTimestamp : (editingAnime.createdAt || new Date().toISOString()))
        : (isNowInCatalog ? latestCatalogTimestamp : new Date().toISOString());

      const resolvedReleaseMonth = isUpcomingForm ? animeReleaseMonth.trim() : '';

      const cleanContinuationIds: string[] = Array.from(
        new Set<string>(animeContinuationIds.filter((id): id is string => Boolean(id && id !== editingAnime?.id)))
      );
      const effectiveContinuationType =
        cleanContinuationIds.length > 0
          ? formatContinuationTitle(animeContinuationType, cleanContinuationIds.length)
          : '';

      const trimmedCoverInput = animeCoverUrlInput.trim();
      const finalCover = (/^https?:\/\//i.test(trimmedCoverInput) ? trimmedCoverInput : animeImage).trim();
      const isExternalCoverUrl = /^https?:\/\//i.test(finalCover);
      const isBase64Input = finalCover.startsWith('data:image/');

      const payload = {
        name: trimmedName,
        image: finalCover,
        coverData: isExternalCoverUrl ? '' : (isBase64Input ? finalCover : ''),
        removeImage: !finalCover,
        studioId: primaryStudioId,
        studioIds: targetStudioIds,
        genreIds: targetGenreIds,
        status: finalStatus,
        year: normalizeAnimeYear(animeYear),
        releaseMonth: resolvedReleaseMonth,
        description: animeDescription,
        telegramUrl: primaryTelegramUrl,
        episodes: cleanEpisodes as any,
        continuationType: effectiveContinuationType,
        continuationAnimeIds: cleanContinuationIds,
        hidden: animeHidden,
        createdAt: effectiveCreatedAt,
      };

      const syncContinuationPeers = async (primaryAnime: Anime): Promise<Anime[]> => {
        const primaryId = String(primaryAnime.id);
        const finalGroupIds: string[] = Array.from(
          new Set<string>(
            cleanContinuationIds.length > 0
              ? [primaryId, ...cleanContinuationIds.filter(id => id !== primaryId).map(String)]
              : []
          )
        );
        const removedIds = initialContinuationIds.filter(
          oldId => oldId !== primaryId && !finalGroupIds.includes(oldId)
        );
        const updatedPeers: Anime[] = [];
        const nowIso = new Date().toISOString();

        // 1. Update all members of the active continuation group so every anime has the full group
        for (const memberId of finalGroupIds) {
          if (memberId === primaryId) continue;
          const peer = animes.find(a => a.id === memberId);
          if (!peer) continue;
          const peerOtherIds = finalGroupIds.filter(id => id !== memberId);
          const peerType = formatContinuationTitle(effectiveContinuationType, peerOtherIds.length);
          const updatedPeer: Anime = {
            ...peer,
            continuationType: peerType,
            continuationAnimeIds: peerOtherIds,
            updatedAt: nowIso
          };
          updatedPeers.push(updatedPeer);
          if (db) {
            await setDoc(
              doc(db, 'animes', memberId),
              {
                continuationType: peerType,
                continuationAnimeIds: peerOtherIds,
                updatedAt: nowIso
              },
              { merge: true }
            ).catch(() => null);
          }
          fetch(`/api/animes/${memberId}`, {
            method: 'PUT',
            headers: apiHeaders,
            body: JSON.stringify(updatedPeer)
          }).catch(() => null);
        }

        // 2. Clean up any anime that was removed from this continuation group
        for (const remId of removedIds) {
          const remPeer = animes.find(a => a.id === remId);
          if (!remPeer) continue;
          const remainingIds = (remPeer.continuationAnimeIds || []).filter(
            id => id !== primaryId && !finalGroupIds.includes(id)
          );
          const nextRemType =
            remainingIds.length > 0
              ? formatContinuationTitle(remPeer.continuationType, remainingIds.length)
              : '';
          const updatedRem: Anime = {
            ...remPeer,
            continuationType: nextRemType,
            continuationAnimeIds: remainingIds,
            updatedAt: nowIso
          };
          updatedPeers.push(updatedRem);
          if (db) {
            await setDoc(
              doc(db, 'animes', remId),
              {
                continuationType: remainingIds.length > 0 ? nextRemType : deleteField(),
                continuationAnimeIds: remainingIds.length > 0 ? remainingIds : deleteField(),
                updatedAt: nowIso
              },
              { merge: true }
            ).catch(() => null);
          }
          fetch(`/api/animes/${remId}`, {
            method: 'PUT',
            headers: apiHeaders,
            body: JSON.stringify(updatedRem)
          }).catch(() => null);
        }

        return updatedPeers;
      };

      const saveAnimeDirectlyToFirestore = async () => {
        setLiveProgress({
          title: opTitle,
          detail: `Optimizando portada y guardando "${trimmedName}" en Firebase Firestore...`,
          percent: 84,
          current: 4,
          total: 5,
          unit: 'etapas'
        });
        const targetId = editingAnime
          ? editingAnime.id
          : (payload.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || ('anime-' + Date.now()));
        const rawCover = finalCover;
        const safeCover = await ensureFirestoreSafeImage(rawCover);
        const isBase64Cover = safeCover.startsWith('data:image/');
        const nowIso = new Date().toISOString();

        // En Firestore: si es portada URL externa (Cloudinary) eliminamos cualquier coverData Base64 previo
        // y mantenemos el documento organizado sin campos redundantes ni vacíos (conservando telegramUrl).
        if (!db) {
          throw new Error('No hay base de datos Firebase conectada.');
        }
        if (isExternalCoverUrl || !isBase64Cover) {
          globalCoverDataMap.delete(targetId);
        }

        let nextPortadaVersion: number | undefined = undefined;
        if (isBase64Cover) {
          const prevVer = typeof editingAnime?.portadaVersion === 'number' ? editingAnime.portadaVersion : 0;
          const coverChanged = !editingAnime || safeCover !== initialEditCoverRef.current || prevVer === 0;
          nextPortadaVersion = coverChanged ? prevVer + 1 : prevVer;
          if (coverChanged) {
            await setDoc(doc(db, 'portadas', targetId), {
              imagen: safeCover,
              portadaVersion: nextPortadaVersion
            });
            upsertPortadaMemoryCache(targetId, safeCover, nextPortadaVersion);
          }
        } else if (isExternalCoverUrl || !safeCover) {
          await deleteDoc(doc(db, 'portadas', targetId)).catch(() => null);
          deletePortadaMemoryCache(targetId);
        }

        const fsWriteData: Record<string, any> = {
          id: targetId,
          name: trimmedName,
          image: isBase64Cover ? deleteField() : safeCover,
          coverData: deleteField(),
          coverUrl: deleteField(),
          portadaVersion: isBase64Cover && nextPortadaVersion ? nextPortadaVersion : deleteField(),
          studioId: deleteField(),
          studioIds: targetStudioIds,
          genreIds: targetGenreIds,
          status: finalStatus,
          year: normalizeAnimeYear(animeYear),
          releaseMonth: resolvedReleaseMonth ? resolvedReleaseMonth : deleteField(),
          description: animeDescription,
          telegramUrl: primaryTelegramUrl,
          episodes: cleanEpisodes,
          continuationType: effectiveContinuationType ? effectiveContinuationType : deleteField(),
          continuationAnimeIds: cleanContinuationIds.length > 0 ? cleanContinuationIds : deleteField(),
          hidden: animeHidden,
          downloads: editingAnime?.downloads || 0,
          createdAt: effectiveCreatedAt,
          updatedAt: nowIso,
          storageLocation: deleteField(),
          savedInFirestore: deleteField()
        };
        await setDoc(doc(db, 'animes', targetId), fsWriteData, { merge: true });
        setLiveProgress({
          title: opTitle,
          detail: `Verificando rotación de episodios...`,
          percent: 94,
          current: 5,
          total: 5,
          unit: 'etapas'
        });
        const savedAnimeObj: Anime = {
          id: targetId,
          name: trimmedName,
          image: isBase64Cover ? '' : safeCover,
          coverData: undefined,
          portadaVersion: isBase64Cover ? nextPortadaVersion : undefined,
          studioId: primaryStudioId,
          studioIds: targetStudioIds,
          genreIds: targetGenreIds,
          status: finalStatus,
          year: normalizeAnimeYear(animeYear),
          releaseMonth: resolvedReleaseMonth,
          description: animeDescription,
          telegramUrl: primaryTelegramUrl,
          episodes: cleanEpisodes as any,
          continuationType: effectiveContinuationType || undefined,
          continuationAnimeIds: cleanContinuationIds.length > 0 ? cleanContinuationIds : undefined,
          hidden: animeHidden,
          downloads: editingAnime?.downloads || 0,
          createdAt: effectiveCreatedAt,
          updatedAt: nowIso,
          storageLocation: 'Firebase Firestore',
          savedInFirestore: true
        };
        const updatedPeers = await syncContinuationPeers(savedAnimeObj).catch(() => [] as Anime[]);
        const mergedList = editingAnime
          ? animes.map(a => (a.id === savedAnimeObj.id ? savedAnimeObj : a))
          : [...animes, savedAnimeObj];
        const rot = await enforceEpisodesRotationInFirestore(mergedList, 30).catch(() => null);

        setLiveProgress({
          title: editingAnime ? '¡Anime Actualizado!' : '¡Anime Creado!',
          detail: `"${trimmedName}" guardado al 100% en Firebase Firestore`,
          percent: 100,
          current: 5,
          total: 5,
          unit: 'etapas'
        });
        await new Promise(r => setTimeout(r, 260));

        updateLastUsedStudio(trimmedStudioSearch, primaryStudioId);
        setIsAnimeFormOpen(false);
        setEditingAnime(null);
        const allUpdated = [
          savedAnimeObj,
          ...updatedPeers,
          ...(rot && rot.updatedAnimes.length > 0 ? rot.updatedAnimes : [])
        ];
        onRefresh(allUpdated);
        showNotification(
          editingAnime
            ? `✅ ¡Anime actualizado directamente en Firebase Firestore!`
            : `✅ ¡Anime creado directamente en Firebase Firestore!`,
          'success'
        );
      };

      setLiveProgress({
        title: opTitle,
        detail: `Sincronizando "${trimmedName}" con el servidor y Firebase Firestore...`,
        percent: 78,
        current: 4,
        total: 5,
        unit: 'etapas'
      });

      const url = editingAnime ? `/api/animes/${editingAnime.id}` : '/api/animes';
      const method = editingAnime ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: apiHeaders,
        body: JSON.stringify(payload)
      }).catch(() => null);

      const contentType = res?.headers?.get('content-type') || '';
      if (res && res.ok && contentType.includes('application/json')) {
        const savedAnime = await res.json().catch(() => null);
        if (savedAnime && savedAnime.id) {
          if (isExternalCoverUrl || !savedAnime.coverData) {
            globalCoverDataMap.delete(String(savedAnime.id));
          }
          const resolvedAnime: Anime = {
            ...savedAnime,
            coverData: isExternalCoverUrl ? undefined : savedAnime.coverData,
            continuationType: effectiveContinuationType,
            continuationAnimeIds: cleanContinuationIds,
            releaseMonth: savedAnime.releaseMonth !== undefined ? savedAnime.releaseMonth : resolvedReleaseMonth
          };
          const updatedPeers = await syncContinuationPeers(resolvedAnime).catch(() => [] as Anime[]);

          setLiveProgress({
            title: editingAnime ? '¡Anime Actualizado!' : '¡Anime Creado!',
            detail: `"${trimmedName}" sincronizado al 100%`,
            percent: 100,
            current: 5,
            total: 5,
            unit: 'etapas'
          });
          await new Promise(r => setTimeout(r, 260));

          updateLastUsedStudio(trimmedStudioSearch, primaryStudioId);
          setIsAnimeFormOpen(false);
          setEditingAnime(null);
          onRefresh([resolvedAnime, ...updatedPeers]);

          if (savedAnime?.savedInFirestore === false) {
            showNotification(
              `⚠️ Guardado en servidor local. Error en Firebase: ${savedAnime.firestoreError || 'Sin conexión activa'}`,
              'error'
            );
          } else {
            showNotification(
              editingAnime
                ? `✅ ¡Anime y Portada actualizados correctamente en Firebase Firestore!`
                : `✅ ¡Anime y Portada creados correctamente en Firebase Firestore!`,
              'success'
            );
          }
          return;
        }
      }

      if (res && res.status === 401) {
        handleLogout();
        return setAnimeFormError('Tu sesión ha expirado. Por favor vuelve a ingresar.');
      }

      // Direct Firebase Firestore Fallback (e.g. Vercel deployment where Express /api/ does not exist)
      try {
        await saveAnimeDirectlyToFirestore();
        return;
      } catch (fbErr: any) {
        const errData = res ? await res.json().catch(() => ({})) : {};
        setAnimeFormError(errData.error || fbErr?.message || 'Error al guardar anime');
      }
    } catch (err: any) {
      // Direct Firebase Firestore Fallback on Network Error / static hosting
      try {
        // Re-run fallback if needed
        const targetId = editingAnime
          ? editingAnime.id
          : (trimmedName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || ('anime-' + Date.now()));
        const trimmedFallbackInput = animeCoverUrlInput.trim();
        const rawCover = (/^https?:\/\//i.test(trimmedFallbackInput) ? trimmedFallbackInput : animeImage).trim();
        const safeCover = await ensureFirestoreSafeImage(rawCover);
        const isBase64Cover = safeCover.startsWith('data:image/');
        const fallbackContinuationIds: string[] = Array.from(
          new Set<string>(animeContinuationIds.filter((id): id is string => Boolean(id && id !== targetId)))
        );
        const fallbackContinuationType =
          fallbackContinuationIds.length > 0
            ? formatContinuationTitle(animeContinuationType, fallbackContinuationIds.length)
            : '';
        if (!db) {
          throw new Error('No hay base de datos Firebase conectada.');
        }
        if (!isBase64Cover) {
          globalCoverDataMap.delete(targetId);
        }
        const nowIso = new Date().toISOString();
        const fallbackReleaseMonth = isUpcomingForm ? animeReleaseMonth.trim() : '';
        const fallbackTelegram = isUpcomingForm ? '' : animeTelegramUrl.trim();
        const fallbackEpisodes = animeEpisodes
          .map((ep, idx) => sanitizeEpisodeForFirestore({ ...ep, number: Number(ep.number) || (idx + 1) }))
          .filter(ep => ep.mp4Url !== '');

        let nextPortadaVersion: number | undefined = undefined;
        if (isBase64Cover) {
          const prevVer = typeof editingAnime?.portadaVersion === 'number' ? editingAnime.portadaVersion : 0;
          const coverChanged = !editingAnime || safeCover !== initialEditCoverRef.current || prevVer === 0;
          nextPortadaVersion = coverChanged ? prevVer + 1 : prevVer;
          if (coverChanged) {
            await setDoc(doc(db, 'portadas', targetId), {
              imagen: safeCover,
              portadaVersion: nextPortadaVersion
            });
            upsertPortadaMemoryCache(targetId, safeCover, nextPortadaVersion);
          }
        } else {
          await deleteDoc(doc(db, 'portadas', targetId)).catch(() => null);
          deletePortadaMemoryCache(targetId);
        }

        const fsWriteData: Record<string, any> = {
          name: trimmedName,
          id: targetId,
          image: isBase64Cover ? deleteField() : safeCover,
          coverData: deleteField(),
          coverUrl: deleteField(),
          portadaVersion: isBase64Cover && nextPortadaVersion ? nextPortadaVersion : deleteField(),
          studioId: deleteField(),
          studioIds: targetStudioIds,
          genreIds: animeGenreIds,
          status: animeStatus || 'Finalizado',
          year: normalizeAnimeYear(animeYear),
          releaseMonth: fallbackReleaseMonth ? fallbackReleaseMonth : deleteField(),
          description: animeDescription,
          telegramUrl: fallbackTelegram,
          episodes: fallbackEpisodes,
          continuationType: fallbackContinuationType ? fallbackContinuationType : deleteField(),
          continuationAnimeIds: fallbackContinuationIds.length > 0 ? fallbackContinuationIds : deleteField(),
          hidden: animeHidden,
          createdAt: editingAnime?.createdAt || nowIso,
          updatedAt: nowIso,
          downloads: editingAnime?.downloads || 0,
          storageLocation: deleteField(),
          savedInFirestore: deleteField()
        };
        await setDoc(doc(db, 'animes', targetId), fsWriteData, { merge: true });
        const savedFallbackAnime: Anime = {
          name: trimmedName,
          id: targetId,
          image: isBase64Cover ? '' : safeCover,
          coverData: undefined,
          portadaVersion: isBase64Cover ? nextPortadaVersion : undefined,
          studioId: targetStudioIds[0] || '',
          studioIds: targetStudioIds,
          genreIds: animeGenreIds,
          status: animeStatus || 'Finalizado',
          year: normalizeAnimeYear(animeYear),
          releaseMonth: fallbackReleaseMonth,
          description: animeDescription,
          telegramUrl: fallbackTelegram,
          episodes: fallbackEpisodes as any,
          continuationType: fallbackContinuationType || undefined,
          continuationAnimeIds: fallbackContinuationIds.length > 0 ? fallbackContinuationIds : undefined,
          hidden: animeHidden,
          createdAt: editingAnime?.createdAt || nowIso,
          updatedAt: nowIso,
          downloads: editingAnime?.downloads || 0,
          storageLocation: 'Firebase Firestore',
          savedInFirestore: true
        };
        setIsAnimeFormOpen(false);
        setEditingAnime(null);
        onRefresh(savedFallbackAnime);
        showNotification('✅ ¡Anime guardado directamente en Firebase Firestore!', 'success');
      } catch (fbErr: any) {
        setAnimeFormError('Error al guardar anime: ' + (fbErr?.message || 'Error de red'));
      }
    } finally {
      setIsSavingAnime(false);
      setLiveProgress(null);
    }
  };

  const executeDeleteAnime = async (id: string) => {
    const targetAnime = animes.find(a => a.id === id);
    if (targetAnime?.name) {
      recordDeletedAnime(targetAnime.name);
    }
    try {
      const res = await fetch(`/api/animes/${id}`, { method: 'DELETE', headers: apiHeaders }).catch(() => null);
      if (res && res.ok) {
        if (db) await deleteDoc(doc(db, 'portadas', id)).catch(() => null);
        deletePortadaMemoryCache(id);
        onRefresh(undefined, id);
        showNotification('Anime eliminado y movido a la papelera', 'success');
        return;
      }
      // Direct Firestore fallback for Vercel/Static hosting
      if (!db) throw new Error('No hay base de datos Firebase conectada.');
      await deleteDoc(doc(db, 'animes', id));
      await deleteDoc(doc(db, 'portadas', id)).catch(() => null);
      deletePortadaMemoryCache(id);
      onRefresh(undefined, id);
      showNotification('Anime eliminado y movido a la papelera', 'success');
    } catch (err: any) {
      try {
        if (!db) throw new Error('No hay base de datos Firebase conectada.');
        await deleteDoc(doc(db, 'animes', id));
        await deleteDoc(doc(db, 'portadas', id)).catch(() => null);
        deletePortadaMemoryCache(id);
        onRefresh(undefined, id);
        showNotification('Anime eliminado y movido a la papelera', 'success');
      } catch (fbErr: any) {
        showNotification('Error al eliminar: ' + (fbErr?.message || 'Error de red'), 'error');
      }
    }
  };

  const handleDeleteAnime = (id: string) => {
    const anime = animes.find(a => a.id === id);
    setDeleteConfirm({
      type: 'anime',
      id,
      title: 'Eliminar Anime',
      message: `¿Seguro que deseas eliminar el anime "${anime?.name || 'este anime'}" de forma permanente? Esta acción no se puede deshacer.`,
      onConfirm: () => executeDeleteAnime(id)
    });
  };

  const handleToggleAnimeHidden = async (anime: Anime) => {
    const nextHidden = !anime.hidden;
    try {
      const res = await fetch(`/api/animes/${anime.id}`, {
        method: 'PUT',
        headers: apiHeaders,
        body: JSON.stringify({ hidden: nextHidden })
      }).catch(() => null);
      const contentType = res?.headers?.get('content-type') || '';
      if (res && res.ok && contentType.includes('application/json')) {
        onRefresh({ ...anime, hidden: nextHidden });
        showNotification(`Anime ${nextHidden ? 'ocultado' : 'visible'} correctamente`, 'success');
        return;
      }
      if (!db) throw new Error('Sin conexión');
      await setDoc(doc(db, 'animes', anime.id), { hidden: nextHidden, updatedAt: new Date().toISOString() }, { merge: true });
      onRefresh({ ...anime, hidden: nextHidden });
      showNotification(`Anime ${nextHidden ? 'ocultado' : 'visible'} correctamente`, 'success');
    } catch (err) {
      try {
        if (!db) throw new Error('Sin conexión');
        await setDoc(doc(db, 'animes', anime.id), { hidden: nextHidden, updatedAt: new Date().toISOString() }, { merge: true });
        onRefresh({ ...anime, hidden: nextHidden });
        showNotification(`Anime ${nextHidden ? 'ocultado' : 'visible'} correctamente`, 'success');
      } catch {
        showNotification('Error de conexión.', 'error');
      }
    }
  };

  const handleDeduplicateAnimes = async () => {
    setIsDeduplicatingAnimes(true);
    try {
      const res = await fetch('/api/admin/deduplicate-animes', {
        method: 'POST',
        headers: apiHeaders,
      });
      const data = await res.json();
      if (res.ok && data.success) {
        onRefresh();
        showNotification(
          `Unificación completada: ${data.animesMerged} animes unificados (${data.titlesUnified} por título, ${data.telegramLinksUnified || 0} por enlace principal, ${data.episodeLinksUnified || 0} por enlace de episodios, ${data.coversUnified || 0} por imagen, ${data.studiosMerged || 0} estudios y ${data.genresMerged || 0} géneros).`,
          'success'
        );
        setShowDuplicatesModal(false);
      } else {
        showNotification(data.error || 'Error al unificar duplicados', 'error');
      }
    } catch (err) {
      showNotification('Error de red al unificar duplicados.', 'error');
    } finally {
      setIsDeduplicatingAnimes(false);
    }
  };

  // --- BACKUP ACTIONS ---
  const resolveImageToBase64 = async (src?: string): Promise<string> => {
    if (!src || typeof src !== 'string') return '';
    const trimmed = src.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('data:image/')) return trimmed;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(trimmed, { signal: controller.signal }).catch(() => null);
      clearTimeout(timeoutId);
      if (!res || !res.ok) return trimmed;
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('text/html')) return trimmed;
      const blob = await res.blob();
      if (!blob || blob.size === 0) return trimmed;
      return await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = typeof reader.result === 'string' ? reader.result : trimmed;
          resolve(result);
        };
        reader.onerror = () => resolve(trimmed);
        reader.readAsDataURL(blob);
      });
    } catch {
      return trimmed;
    }
  };

  const handleExportBackup = async (
    exportOption: 'with_comments_and_ratings' | 'only_ratings' | 'without_both' = 'with_comments_and_ratings'
  ) => {
    setShowExportOptionsModal(false);
    const includeRatings = exportOption === 'with_comments_and_ratings' || exportOption === 'only_ratings';
    const includeComments = exportOption === 'with_comments_and_ratings';

    setIsExporting(true);
    setExportProgress({ current: 0, total: Math.max(1, animes.length), percent: 5 });
    setLiveProgress({
      title: 'Exportando Copia de Seguridad',
      detail: 'Conectando con Firebase Firestore y recopilando colecciones...',
      percent: 5,
      current: 0,
      total: Math.max(1, animes.length),
      unit: 'animes'
    });
    setBackupStatus('Recopilando todos los animes, portadas, miniaturas de episodios, estudios, géneros y acomodo...');
    try {
      let serverSchema: any = null;
      try {
        const res = await fetch('/api/backup/export', { headers: apiHeaders }).catch(() => null);
        const contentType = res?.headers?.get('content-type') || '';
        if (res && res.ok && contentType.includes('application/json')) {
          serverSchema = await res.json().catch(() => null);
        }
      } catch {}

      // Fetch live Firestore collections to ensure 100% completeness (especially on Vercel or hybrid setups)
      const fsAnimesMap = new Map<string, any>();
      const fsStudiosMap = new Map<string, any>();
      const fsGenresMap = new Map<string, any>();
      const animeRatings: Record<string, any> = includeRatings ? { ...(serverSchema?.animeRatings || {}) } : {};
      const userAnimeVotes: Record<string, any> = includeRatings ? { ...(serverSchema?.userAnimeVotes || {}) } : {};
      const commentsMap = new Map<string, any>();
      const userListsCloud: Record<string, any> = { ...(serverSchema?.userListsCloud || {}) };

      if (includeComments && Array.isArray(serverSchema?.comments)) {
        for (const c of serverSchema.comments) {
          if (c && c.id) commentsMap.set(String(c.id), c);
        }
      }

      try {
        const [animesSnap, studiosSnap, genresSnap, ratingsSnap, votesSnap, commentsSnap, userListsSnap] = db
          ? await Promise.all([
              getDocs(collection(db, 'animes')).catch(() => null),
              getDocs(collection(db, 'studios')).catch(() => null),
              getDocs(collection(db, 'genres')).catch(() => null),
              includeRatings ? getDocs(collection(db, 'anime_ratings')).catch(() => null) : Promise.resolve(null),
              includeRatings ? getDocs(collection(db, 'user_anime_votes')).catch(() => null) : Promise.resolve(null),
              includeComments ? getDocs(collection(db, 'comentariosGlobales')).catch(() => null) : Promise.resolve(null),
              getDocs(collection(db, 'userLists')).catch(() => null)
            ])
          : [null, null, null, null, null, null, null];

        if (animesSnap) {
          animesSnap.forEach(d => {
            const data = d.data();
            fsAnimesMap.set(String(data.id || d.id), { ...data, id: String(data.id || d.id) });
          });
        }
        if (studiosSnap) {
          studiosSnap.forEach(d => {
            const data = d.data();
            fsStudiosMap.set(String(data.id || d.id), { ...data, id: String(data.id || d.id) });
          });
        }
        if (genresSnap) {
          genresSnap.forEach(d => {
            const data = d.data();
            fsGenresMap.set(String(data.id || d.id), { ...data, id: String(data.id || d.id) });
          });
        }
        if (includeRatings && ratingsSnap) {
          ratingsSnap.forEach(d => { animeRatings[d.id] = d.data(); });
        }
        if (includeRatings && votesSnap) {
          votesSnap.forEach(d => { userAnimeVotes[d.id] = d.data(); });
        }
        if (includeComments && commentsSnap) {
          commentsSnap.forEach(d => { commentsMap.set(d.id, { id: d.id, ...d.data() }); });
        }
        if (userListsSnap) {
          userListsSnap.forEach(d => { userListsCloud[d.id] = d.data(); });
        }
      } catch {}

      // Also include local cached ratings/votes/comments as fallback if selected
      if (includeRatings) {
        try {
          const rawVotesMap = localStorage.getItem('kh_all_anime_user_votes_v2');
          if (rawVotesMap) {
            const parsedVotesMap = JSON.parse(rawVotesMap);
            if (parsedVotesMap && typeof parsedVotesMap === 'object') {
              for (const [aId, uMap] of Object.entries(parsedVotesMap)) {
                if (uMap && typeof uMap === 'object') {
                  for (const [uId, voteVal] of Object.entries(uMap as Record<string, number>)) {
                    const docKey = `${uId}_${aId}`;
                    if (!userAnimeVotes[docKey] && typeof voteVal === 'number' && voteVal >= 1 && voteVal <= 5) {
                      userAnimeVotes[docKey] = {
                        userId: uId,
                        animeId: aId,
                        vote: voteVal,
                        updatedAt: Date.now()
                      };
                    }
                  }
                }
              }
            }
          }
          for (const a of animes) {
            if (!a?.id || animeRatings[a.id]) continue;
            const rawLocalRating = localStorage.getItem(`kh_anime_votes_${a.id}`);
            if (rawLocalRating) {
              const parsedR = JSON.parse(rawLocalRating);
              if (parsedR && typeof parsedR === 'object') {
                const total = (Number(parsedR[5]) || 0) + (Number(parsedR[4]) || 0) + (Number(parsedR[3]) || 0) + (Number(parsedR[2]) || 0) + (Number(parsedR[1]) || 0);
                if (total > 0) {
                  animeRatings[a.id] = {
                    v5: Number(parsedR[5]) || 0,
                    v4: Number(parsedR[4]) || 0,
                    v3: Number(parsedR[3]) || 0,
                    v2: Number(parsedR[2]) || 0,
                    v1: Number(parsedR[1]) || 0,
                    updatedAt: Date.now()
                  };
                }
              }
            }
          }
        } catch {}
      }

      if (includeComments) {
        try {
          const rawCachedComments = localStorage.getItem('kh_global_comments_cache_v2');
          if (rawCachedComments) {
            const parsedComments = JSON.parse(rawCachedComments);
            if (Array.isArray(parsedComments)) {
              for (const c of parsedComments) {
                if (c && c.id && !commentsMap.has(String(c.id))) {
                  commentsMap.set(String(c.id), c);
                }
              }
            }
          }
        } catch {}
      }

      // 1. Merge Studios (preserving exact order & studio covers)
      const baseStudios: any[] = (Array.isArray(serverSchema?.studios) && serverSchema.studios.length >= studios.length)
        ? serverSchema.studios
        : studios;
      const mergedStudiosMap = new Map<string, any>();
      baseStudios.forEach((s, idx) => {
        if (!s || !s.id) return;
        const clientS = studios.find(cs => cs.id === s.id);
        const fsS = fsStudiosMap.get(s.id);
        mergedStudiosMap.set(s.id, {
          id: s.id,
          name: s.name || clientS?.name || fsS?.name || 'Estudio',
          image: s.image || clientS?.image || fsS?.image || undefined,
          order: typeof s.order === 'number' ? s.order : (typeof fsS?.order === 'number' ? fsS.order : 10),
          orderIndex: typeof s.orderIndex === 'number' ? s.orderIndex : idx
        });
      });
      for (const s of studios) {
        if (s && s.id && !mergedStudiosMap.has(s.id)) {
          const fsS = fsStudiosMap.get(s.id);
          mergedStudiosMap.set(s.id, {
            id: s.id,
            name: s.name,
            image: s.image || fsS?.image || undefined,
            order: typeof s.order === 'number' ? s.order : 10,
            orderIndex: mergedStudiosMap.size
          });
        }
      }
      setLiveProgress({
        title: 'Exportando Copia de Seguridad',
        detail: `Empaquetando ${mergedStudiosMap.size} estudios y sus portadas...`,
        percent: 12,
        current: 0,
        total: mergedStudiosMap.size,
        unit: 'estudios'
      });
      const exportedStudios: any[] = [];
      let stIdx = 0;
      for (const st of mergedStudiosMap.values()) {
        stIdx++;
        const resolvedImg = st.image ? await resolveImageToBase64(st.image) : undefined;
        exportedStudios.push({
          ...st,
          ...(resolvedImg ? { image: resolvedImg } : {})
        });
      }

      // 2. Merge Genres (preserving exact order & genre covers)
      const baseGenres: any[] = (Array.isArray(serverSchema?.genres) && serverSchema.genres.length >= genres.length)
        ? serverSchema.genres
        : genres;
      const mergedGenresMap = new Map<string, any>();
      baseGenres.forEach((g, idx) => {
        if (!g || !g.id) return;
        const clientG = genres.find(cg => cg.id === g.id);
        const fsG = fsGenresMap.get(g.id);
        mergedGenresMap.set(g.id, {
          id: g.id,
          name: g.name || clientG?.name || fsG?.name || 'Género',
          image: g.image || clientG?.image || fsG?.image || undefined,
          order: typeof g.order === 'number' ? g.order : (typeof fsG?.order === 'number' ? fsG.order : 10),
          orderIndex: typeof g.orderIndex === 'number' ? g.orderIndex : idx
        });
      });
      for (const g of genres) {
        if (g && g.id && !mergedGenresMap.has(g.id)) {
          const fsG = fsGenresMap.get(g.id);
          mergedGenresMap.set(g.id, {
            id: g.id,
            name: g.name,
            image: g.image || fsG?.image || undefined,
            order: typeof g.order === 'number' ? g.order : 10,
            orderIndex: mergedGenresMap.size
          });
        }
      }
      setLiveProgress({
        title: 'Exportando Copia de Seguridad',
        detail: `Empaquetando ${mergedGenresMap.size} géneros y sus portadas...`,
        percent: 20,
        current: 0,
        total: mergedGenresMap.size,
        unit: 'géneros'
      });
      const exportedGenres: any[] = [];
      for (const gn of mergedGenresMap.values()) {
        const resolvedImg = gn.image ? await resolveImageToBase64(gn.image) : undefined;
        exportedGenres.push({
          ...gn,
          ...(resolvedImg ? { image: resolvedImg } : {})
        });
      }

      const studioLookup = new Map<string, string>();
      exportedStudios.forEach(s => studioLookup.set(s.id, s.name));
      const genreLookup = new Map<string, string>();
      exportedGenres.forEach(g => genreLookup.set(g.id, g.name));

      // 3. Merge Animes (preserving exact arrangement, covers, episode thumbnails, episode covers, links, and metadata)
      const serverAnimesMap = new Map<string, any>();
      if (Array.isArray(serverSchema?.animes)) {
        serverSchema.animes.forEach((sa: any) => {
          if (sa && sa.id) serverAnimesMap.set(String(sa.id), sa);
        });
      }

      // Use client `animes` order as primary arrangement, adding any extra animes from server or Firestore
      const combinedAnimesList: any[] = [];
      const seenAnimeIds = new Set<string>();

      for (const clientA of animes) {
        if (!clientA || !clientA.id) continue;
        seenAnimeIds.add(clientA.id);
        const srvA = serverAnimesMap.get(clientA.id);
        const fsA = fsAnimesMap.get(clientA.id);
        const mergedContIds = (Array.isArray(clientA.continuationAnimeIds) && clientA.continuationAnimeIds.length > 0)
          ? clientA.continuationAnimeIds
          : (Array.isArray(fsA?.continuationAnimeIds) && fsA.continuationAnimeIds.length > 0)
          ? fsA.continuationAnimeIds
          : (Array.isArray(srvA?.continuationAnimeIds) && srvA.continuationAnimeIds.length > 0)
          ? srvA.continuationAnimeIds
          : undefined;
        const mergedContType = clientA.continuationType || fsA?.continuationType || srvA?.continuationType || undefined;

        combinedAnimesList.push({
          ...(fsA || {}),
          ...(srvA || {}),
          ...clientA,
          continuationType: mergedContType,
          continuationAnimeIds: mergedContIds,
          coverData: (srvA?.coverData && srvA.coverData.startsWith('data:image/'))
            ? srvA.coverData
            : (clientA.coverData && clientA.coverData.startsWith('data:image/'))
            ? clientA.coverData
            : (fsA?.coverData && fsA.coverData.startsWith('data:image/'))
            ? fsA.coverData
            : (srvA?.image && srvA.image.startsWith('data:image/'))
            ? srvA.image
            : (clientA.image && clientA.image.startsWith('data:image/'))
            ? clientA.image
            : (fsA?.image && fsA.image.startsWith('data:image/'))
            ? fsA.image
            : (clientA.coverData || srvA?.coverData || fsA?.coverData || ''),
          image: clientA.image || srvA?.image || fsA?.image || '',
          episodes: (clientA.episodes && clientA.episodes.length > 0)
            ? clientA.episodes
            : (srvA?.episodes && srvA.episodes.length > 0)
            ? srvA.episodes
            : normalizeEpisodesList(fsA?.episodes)
        });
      }

      if (Array.isArray(serverSchema?.animes)) {
        for (const srvA of serverSchema.animes) {
          if (srvA && srvA.id && !seenAnimeIds.has(srvA.id)) {
            seenAnimeIds.add(srvA.id);
            combinedAnimesList.push(srvA);
          }
        }
      }

      for (const [fsId, fsA] of fsAnimesMap.entries()) {
        if (!seenAnimeIds.has(fsId)) {
          seenAnimeIds.add(fsId);
          combinedAnimesList.push({
            ...fsA,
            episodes: normalizeEpisodesList(fsA.episodes)
          });
        }
      }

      let totalEpisodesCount = 0;
      let totalEpisodeThumbnailsCount = 0;
      const exportedAnimes: any[] = [];
      const totalExportCount = Math.max(1, combinedAnimesList.length);

      for (let idx = 0; idx < combinedAnimesList.length; idx++) {
        const a = combinedAnimesList[idx];
        const currentNum = idx + 1;
        const pct = Math.min(95, 22 + Math.round((currentNum / totalExportCount) * 73));
        setExportProgress({ current: currentNum, total: combinedAnimesList.length, percent: pct });
        setLiveProgress({
          title: 'Exportando Copia de Seguridad',
          detail: `Empaquetando anime ${currentNum} de ${combinedAnimesList.length}: "${a.name}" (portada y episodios)...`,
          percent: pct,
          current: currentNum,
          total: combinedAnimesList.length,
          unit: 'animes'
        });
        setBackupStatus(`Empaquetando anime ${currentNum} de ${combinedAnimesList.length} (${pct}%): "${a.name}" (portada y episodios)...`);

        const cachedIdbCover = globalCoverDataMap.get(a.id);
        let rawCoverCandidate = (a.coverData && a.coverData.startsWith('data:image/'))
          ? a.coverData
          : (a.image && a.image.startsWith('data:image/'))
          ? a.image
          : (a.image && /^https?:\/\//i.test(a.image.trim()))
          ? a.image.trim()
          : (cachedIdbCover && cachedIdbCover.startsWith('data:image/'))
          ? cachedIdbCover
          : '';

        if (!rawCoverCandidate && a.id) {
          const fsPortada = await fetchPortadaFromFirestore(a.id, a.portadaVersion).catch(() => null);
          if (fsPortada?.imagen) {
            rawCoverCandidate = fsPortada.imagen;
          }
        }
        if (!rawCoverCandidate) {
          rawCoverCandidate = a.coverData || a.image || `/api/covers/${a.id}.webp`;
        }

        const resolvedCover = await resolveImageToBase64(rawCoverCandidate);
        const finalBase64Cover = resolvedCover.startsWith('data:image/') ? resolvedCover : (a.coverData || cachedIdbCover || '');

        const rawEps = normalizeEpisodesList(a.episodes || []);
        const cleanEpisodes: any[] = [];

        for (let epIdx = 0; epIdx < rawEps.length; epIdx++) {
          const ep = rawEps[epIdx];
          const link = getEpisodeUrl(ep);
          const resolvedThumb = ep.thumbnail ? await resolveImageToBase64(ep.thumbnail) : undefined;
          const resolvedEpCover = ep.coverImage ? await resolveImageToBase64(ep.coverImage) : undefined;
          if (resolvedThumb || resolvedEpCover) {
            totalEpisodeThumbnailsCount++;
          }
          const epRecord: Record<string, any> = {
            number: Number(ep.number) || (epIdx + 1),
            orderIndex: epIdx,
            mp4Url: link,
            isNew: Boolean(ep.isNew),
          };
          if (ep.title) epRecord.title = String(ep.title);
          if (ep.name) epRecord.name = String(ep.name);
          if (ep.addedToRecentAt) epRecord.addedToRecentAt = String(ep.addedToRecentAt);
          if (resolvedThumb) epRecord.thumbnail = resolvedThumb;
          if (resolvedEpCover) epRecord.coverImage = resolvedEpCover;
          cleanEpisodes.push(epRecord);
        }

        totalEpisodesCount += cleanEpisodes.length;

        const sIds = (Array.isArray(a.studioIds) && a.studioIds.length > 0)
          ? a.studioIds.map(String)
          : (a.studioId ? [String(a.studioId)] : []);
        const studioNames = sIds.map((id: string) => studioLookup.get(id)).filter(Boolean);

        const gIds = Array.isArray(a.genreIds) ? a.genreIds.map(String) : [];
        const genreNames = gIds.map((id: string) => genreLookup.get(id)).filter(Boolean);

        // Resolve Spin-off / Secuela / Secuelas continuation group and chronological organization
        const resolvedContinuation = resolveContinuationGroup(a as Anime, combinedAnimesList as Anime[]);
        const hasResolvedLinks = resolvedContinuation.linkedAnimes.length > 0;
        const finalContinuationIds = hasResolvedLinks
          ? resolvedContinuation.linkedAnimes.map(la => la.id)
          : (Array.isArray(a.continuationAnimeIds) && a.continuationAnimeIds.length > 0
              ? a.continuationAnimeIds.map(String)
              : undefined);
        const finalContinuationType = hasResolvedLinks
          ? resolvedContinuation.type
          : (finalContinuationIds && finalContinuationIds.length > 0
              ? formatContinuationTitle(a.continuationType, finalContinuationIds.length)
              : undefined);
        const finalContinuationNames = hasResolvedLinks
          ? resolvedContinuation.linkedAnimes.map(la => la.name)
          : undefined;
        const finalContinuationOrder = hasResolvedLinks
          ? resolvedContinuation.linkedAnimes.map((la, orderPos) => ({
              id: la.id,
              name: la.name,
              year: la.year ? normalizeAnimeYear(la.year) : '',
              position: orderPos + 1
            }))
          : undefined;

        exportedAnimes.push({
          id: a.id,
          name: a.name,
          title: a.name,
          image: finalBase64Cover || a.image,
          coverData: finalBase64Cover || undefined,
          studioId: a.studioId || sIds[0] || '',
          studioIds: sIds,
          studioNames: studioNames.length > 0 ? studioNames : (a.studioNames || undefined),
          genreIds: gIds,
          genreNames: genreNames.length > 0 ? genreNames : (a.genreNames || undefined),
          status: a.status || 'Finalizado',
          year: a.year ? normalizeAnimeYear(a.year) : '',
          releaseMonth: a.releaseMonth || undefined,
          description: a.description || '',
          synopsis: a.description || '',
          telegramUrl: a.telegramUrl || '',
          episodes: cleanEpisodes,
          totalEpisodes: cleanEpisodes.length,
          isSingleEpisode: Boolean(a.isSingleEpisode),
          continuationType: finalContinuationType,
          continuationAnimeIds: finalContinuationIds,
          continuationAnimeNames: finalContinuationNames,
          continuationOrder: finalContinuationOrder,
          hidden: Boolean(a.hidden),
          downloads: typeof a.downloads === 'number' ? a.downloads : 0,
          orderIndex: idx,
          createdAt: a.createdAt || new Date().toISOString(),
          updatedAt: a.updatedAt || new Date().toISOString()
        });
      }

      // Build clean continuation groups summary (Spin-off / Secuela / Secuelas) ordered by year
      const continuationGroupsMap = new Map<string, any>();
      for (const a of combinedAnimesList) {
        if (!a || !a.id) continue;
        const grp = resolveContinuationGroup(a as Anime, combinedAnimesList as Anime[]);
        if (grp.allGroupIds.length > 1) {
          const groupKey = [...grp.allGroupIds].sort().join('|');
          if (!continuationGroupsMap.has(groupKey)) {
            const orderedMembers = sortAnimesByYearAsc(
              grp.allGroupIds
                .map(id => combinedAnimesList.find(item => item.id === id))
                .filter((item): item is Anime => Boolean(item))
            );
            continuationGroupsMap.set(groupKey, {
              type: grp.type,
              animeIds: orderedMembers.map(m => m.id),
              animeNames: orderedMembers.map(m => m.name),
              orderedAnimes: orderedMembers.map((m, pos) => ({
                id: m.id,
                name: m.name,
                year: m.year ? normalizeAnimeYear(m.year) : '',
                position: pos + 1
              }))
            });
          }
        }
      }
      const exportedContinuations = Array.from(continuationGroupsMap.values());

      // Collect local trash & admin settings
      let localTrash: string[] = [];
      try {
        const rawTrash = localStorage.getItem('kh_deleted_animes_trash');
        if (rawTrash) {
          const parsed = JSON.parse(rawTrash);
          if (Array.isArray(parsed)) localTrash = parsed;
        }
      } catch {}
      const combinedTrash = Array.from(new Set([...(serverSchema?.trash || []), ...trashNames, ...localTrash]));

      setExportProgress({ current: combinedAnimesList.length, total: combinedAnimesList.length, percent: 98 });
      setLiveProgress({
        title: 'Generando Archivo .JSON',
        detail: 'Compilando copia de seguridad completa...',
        percent: 98,
        current: combinedAnimesList.length,
        total: combinedAnimesList.length,
        unit: 'animes'
      });

      const finalBackupSchema: Record<string, any> = {
        version: 3,
        exportedAt: new Date().toISOString(),
        appName: 'KuzeHentai',
        backupOption: exportOption,
        stats: {
          totalAnimes: exportedAnimes.length,
          totalEpisodes: totalEpisodesCount,
          totalEpisodeThumbnails: totalEpisodeThumbnailsCount,
          totalStudios: exportedStudios.length,
          totalGenres: exportedGenres.length,
          totalContinuations: exportedContinuations.length,
          totalComments: includeComments ? commentsMap.size : 0,
          totalRatings: includeRatings ? Object.keys(animeRatings).length : 0
        },
        studios: exportedStudios,
        genres: exportedGenres,
        continuations: exportedContinuations,
        userLists: serverSchema?.userLists || {},
        userListsCloud,
        ...(includeRatings ? { animeRatings, userAnimeVotes } : {}),
        ...(includeComments ? { comments: Array.from(commentsMap.values()) } : {}),
        trash: combinedTrash,
        adminSettings: {
          lastUsedStudio
        },
        animes: exportedAnimes
      };

      const dateSuffix = new Date().toISOString().split('T')[0];
      const fileSuffix =
        exportOption === 'with_comments_and_ratings'
          ? `completo_${dateSuffix}`
          : exportOption === 'only_ratings'
          ? `con_calificaciones_${dateSuffix}`
          : `sin_comentarios_ni_calificaciones_${dateSuffix}`;

      const jsonStr = JSON.stringify(finalBackupSchema, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
      const downloadUrl = URL.createObjectURL(blob);
      const dlAnchor = document.createElement('a');
      dlAnchor.href = downloadUrl;
      dlAnchor.download = `kuzehentai_backup_${fileSuffix}.json`;
      document.body.appendChild(dlAnchor);
      dlAnchor.click();
      dlAnchor.remove();
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);

      setExportProgress({ current: combinedAnimesList.length, total: combinedAnimesList.length, percent: 100 });
      setLiveProgress({
        title: '¡Copia de Seguridad Lista!',
        detail: `${exportedAnimes.length} animes, ${totalEpisodesCount} episodios y todas las portadas descargadas al 100%`,
        percent: 100,
        current: combinedAnimesList.length,
        total: combinedAnimesList.length,
        unit: 'animes'
      });
      await new Promise(r => setTimeout(r, 350));

      const modeDescription =
        exportOption === 'with_comments_and_ratings'
          ? 'con comentarios y calificaciones incluidos'
          : exportOption === 'only_ratings'
          ? 'con calificaciones incluidas (sin comentarios)'
          : 'sin comentarios ni calificaciones (solo catálogo)';

      const statusMsg = `Copia de seguridad descargada con éxito ${modeDescription} (${exportedAnimes.length} animes, ${totalEpisodesCount} episodios, ${totalEpisodeThumbnailsCount} miniaturas de episodios, ${exportedStudios.length} estudios, ${exportedGenres.length} géneros, Spin-off/secuelas, portadas y orden exacto integrados).`;
      setBackupStatus(statusMsg);
      showNotification(`Copia de seguridad descargada (${modeDescription})`, 'success');
    } catch (err) {
      setBackupStatus('Fallo al generar el respaldo completo.');
      showNotification('Error al exportar la copia de seguridad.', 'error');
    } finally {
      setIsExporting(false);
      setExportProgress(null);
      setLiveProgress(null);
    }
  };

  const handleResetPopularityOnly = async () => {
    setDeleteConfirm({
      type: 'backup',
      id: 'reset-popularity',
      title: 'REINICIAR MÁS POPULARES A CERO',
      message: '¿Estás seguro de que deseas reiniciar a cero el contador de vistas y popularidad de la sección "Más Populares"? Las calificaciones de estrellas y comentarios permanecerán intactos.',
      onConfirm: async () => {
        try {
          const res = await fetch('/api/admin/reset-popularity', {
            method: 'POST',
            headers: apiHeaders
          });
          if (res.ok) {
            onRefresh();
            showNotification('Contador de Más Populares reiniciado a cero.', 'success');
          } else {
            showNotification('Error al reiniciar popularidad.', 'error');
          }
        } catch (err) {
          showNotification('Error de red al reiniciar popularidad.', 'error');
        } finally {
          setDeleteConfirm(null);
        }
      }
    });
  };

  const handleResetRatingsOnly = async () => {
    setDeleteConfirm({
      type: 'backup',
      id: 'reset-ratings',
      title: 'REINICIAR CALIFICACIONES A CERO',
      message: '¿Estás seguro de que deseas reiniciar a cero todas las calificaciones de estrellas de todos los animes? El contador de más populares y los comentarios permanecerán intactos.',
      onConfirm: async () => {
        try {
          const res = await fetch('/api/admin/reset-ratings', {
            method: 'POST',
            headers: apiHeaders
          });
          if (res.ok) {
            try {
              window.dispatchEvent(new CustomEvent('kh_clear_ratings_cache'));
            } catch (e) {}
            onRefresh();
            showNotification('Calificaciones de estrellas reiniciadas a cero.', 'success');
          } else {
            showNotification('Error al reiniciar calificaciones.', 'error');
          }
        } catch (err) {
          showNotification('Error de red al reiniciar calificaciones.', 'error');
        } finally {
          setDeleteConfirm(null);
        }
      }
    });
  };

  const handleResetCommentsOnly = async () => {
    setDeleteConfirm({
      type: 'backup',
      id: 'reset-comments',
      title: 'ELIMINAR TODOS LOS COMENTARIOS',
      message: '¿Estás seguro de que deseas eliminar permanentemente todos los comentarios de la comunidad? Esta acción no se puede deshacer.',
      onConfirm: async () => {
        try {
          const res = await fetch('/api/admin/reset-comments', {
            method: 'POST',
            headers: apiHeaders
          });
          if (res.ok) {
            onRefresh();
            showNotification('Todos los comentarios han sido eliminados correctamente.', 'success');
          } else {
            showNotification('Error al eliminar comentarios.', 'error');
          }
        } catch (err) {
          showNotification('Error de red al eliminar comentarios.', 'error');
        } finally {
          setDeleteConfirm(null);
        }
      }
    });
  };

  const handleResetPopularityAndRatings = async () => {
    setDeleteConfirm({
      type: 'backup',
      id: 'reset-stats',
      title: 'REINICIAR POPULARIDAD Y CALIFICACIONES A CERO',
      message: '¿Estás seguro de que deseas reiniciar a cero los contadores de más populares y todas las calificaciones de estrellas de los animes? Tus animes, enlaces y episodios permanecerán intactos.',
      onConfirm: async () => {
        try {
          const res = await fetch('/api/admin/reset-stats', {
            method: 'POST',
            headers: apiHeaders
          });
          if (res.ok) {
            try {
              window.dispatchEvent(new CustomEvent('kh_clear_ratings_cache'));
            } catch (e) {}
            onRefresh();
            showNotification('Popularidad y calificaciones de estrellas reiniciadas a cero.', 'success');
          } else {
            showNotification('Error al reiniciar estadísticas.', 'error');
          }
        } catch (err) {
          showNotification('Error de red al reiniciar estadísticas.', 'error');
        } finally {
          setDeleteConfirm(null);
        }
      }
    });
  };

  const handleOptimizeCovers = async () => {
    setIsOptimizingCovers(true);
    showNotification('Iniciando optimización de portadas (> 200 KB)...', 'success');
    try {
      const res = await fetch('/api/admin/optimize-covers', {
        method: 'POST',
        headers: apiHeaders
      });
      const data = await res.json();
      if (res.ok && data.success) {
        onRefresh();
        showNotification(data.message || 'Optimización de portadas completada con éxito.', 'success');
      } else {
        showNotification(data.error || 'Error al optimizar portadas.', 'error');
      }
    } catch (err) {
      showNotification('Error de conexión al optimizar portadas.', 'error');
    } finally {
      setIsOptimizingCovers(false);
    }
  };

  const executeImportBackup = async () => {
    setIsImporting(true);
    setBackupStatus('Preparando importación completa...');
    setBackupProgress(null);
    setLiveProgress({
      title: 'Restaurando Copia de Seguridad',
      detail: 'Analizando archivo de respaldo y preparando datos...',
      percent: 5,
      current: 0,
      total: 1,
      unit: 'animes'
    });
    try {
      let payload = parsedBackupData;
      if (!payload && importJson.trim()) {
        try {
          payload = JSON.parse(importJson);
        } catch (e) {
          setBackupStatus('El texto ingresado no es un JSON válido.');
          showNotification('JSON inválido en el campo de texto.', 'error');
          setIsImporting(false);
          setBackupProgress(null);
          setLiveProgress(null);
          return;
        }
      }

      if (!payload) {
        setBackupStatus('No se encontró información para importar.');
        showNotification('No hay datos para importar.', 'error');
        setIsImporting(false);
        setBackupProgress(null);
        setLiveProgress(null);
        return;
      }

      // Unwrap nested wrapper objects if present
      let schema: any = payload;
      if (schema.data && typeof schema.data === 'object') schema = schema.data;
      else if (schema.backup && typeof schema.backup === 'object') schema = schema.backup;
      else if (schema.db && typeof schema.db === 'object') schema = schema.db;

      if (Array.isArray(schema)) {
        schema = { animes: schema };
      } else if (typeof schema === 'object' && !schema.animes && !schema.studios && !schema.genres) {
        const values = Object.values(schema);
        if (values.length > 0 && typeof values[0] === 'object' && ((values[0] as any)?.name || (values[0] as any)?.title)) {
          schema = { animes: values };
        }
      }

      let rawAnimes: any[] = [];
      if (Array.isArray(schema.animes)) {
        rawAnimes = schema.animes;
      } else if (schema.animes && typeof schema.animes === 'object') {
        rawAnimes = Object.values(schema.animes);
      }

      // Preserve exact arrangement orderIndex if present in backup
      const hasOrderIndex = rawAnimes.some(a => typeof a?.orderIndex === 'number');
      if (hasOrderIndex) {
        rawAnimes = [...rawAnimes].sort((a, b) => {
          const idxA = typeof a?.orderIndex === 'number' ? a.orderIndex : 999999;
          const idxB = typeof b?.orderIndex === 'number' ? b.orderIndex : 999999;
          return idxA - idxB;
        });
      }

      const rawStudios: any[] = Array.isArray(schema.studios)
        ? schema.studios
        : (schema.studios && typeof schema.studios === 'object' ? Object.values(schema.studios) : []);
      const rawGenres: any[] = Array.isArray(schema.genres)
        ? schema.genres
        : (schema.genres && typeof schema.genres === 'object' ? Object.values(schema.genres) : []);
      const userLists = schema.userLists || undefined;
      const userListsCloud = schema.userListsCloud || undefined;
      const rawAnimeRatings = schema.animeRatings || schema.ratings || schema.calificaciones || undefined;
      const rawUserAnimeVotes = schema.userAnimeVotes || schema.userVotes || schema.votes || undefined;

      // Also harvest ratings embedded inside individual anime items (e.g. anime.ratingStats, anime.votes, anime.calificaciones)
      const combinedAnimeRatings: Record<string, any> = {};
      if (rawAnimeRatings && typeof rawAnimeRatings === 'object') {
        if (Array.isArray(rawAnimeRatings)) {
          rawAnimeRatings.forEach((r: any) => {
            const rId = r?.id || r?.animeId;
            if (rId) combinedAnimeRatings[rId] = r;
          });
        } else {
          Object.assign(combinedAnimeRatings, rawAnimeRatings);
        }
      }
      for (const a of rawAnimes) {
        if (!a || !a.id) continue;
        if (a.ratingStats && typeof a.ratingStats === 'object') {
          if (!combinedAnimeRatings[a.id]) combinedAnimeRatings[a.id] = a.ratingStats;
        } else if (a.votes && typeof a.votes === 'object') {
          if (!combinedAnimeRatings[a.id]) combinedAnimeRatings[a.id] = a.votes;
        } else if (a.calificaciones && typeof a.calificaciones === 'object') {
          if (!combinedAnimeRatings[a.id]) combinedAnimeRatings[a.id] = a.calificaciones;
        }
      }
      const animeRatings = Object.keys(combinedAnimeRatings).length > 0 ? combinedAnimeRatings : rawAnimeRatings;
      const userAnimeVotes = rawUserAnimeVotes;
      const comments = schema.comments || undefined;
      const backupTrash = Array.isArray(schema.trash) ? schema.trash : undefined;

      if (backupTrash) {
        try {
          localStorage.setItem('kh_deleted_animes_trash', JSON.stringify(backupTrash));
          setTrashNames(backupTrash);
        } catch {}
      }

      if (schema.adminSettings?.lastUsedStudio?.search) {
        updateLastUsedStudio(schema.adminSettings.lastUsedStudio.search, schema.adminSettings.lastUsedStudio.id || '');
      }

      // Sync restored ratings and comments into local browser caches immediately so UI reflects them right away
      try {
        if (animeRatings && typeof animeRatings === 'object') {
          const entries = Array.isArray(animeRatings)
            ? animeRatings.map((r: any) => [r.id || r.animeId, r])
            : Object.entries(animeRatings);
          for (const [docId, val] of entries) {
            if (docId && val && typeof val === 'object') {
              const voteData = {
                5: Number((val as any).v5 ?? (val as any)[5]) || 0,
                4: Number((val as any).v4 ?? (val as any)[4]) || 0,
                3: Number((val as any).v3 ?? (val as any)[3]) || 0,
                2: Number((val as any).v2 ?? (val as any)[2]) || 0,
                1: Number((val as any).v1 ?? (val as any)[1]) || 0
              };
              localStorage.setItem(`kh_anime_votes_${docId}`, JSON.stringify(voteData));
            }
          }
        }
        if (userAnimeVotes && typeof userAnimeVotes === 'object') {
          const entries = Array.isArray(userAnimeVotes)
            ? userAnimeVotes.map((v: any) => [v.id || `${v.userId}_${v.animeId}`, v])
            : Object.entries(userAnimeVotes);
          const localVotesMap: Record<string, Record<string, number>> = {};
          try {
            const existingRaw = localStorage.getItem('kh_all_anime_user_votes_v2');
            if (existingRaw) Object.assign(localVotesMap, JSON.parse(existingRaw));
          } catch {}
          for (const [, val] of entries) {
            if (val && typeof val === 'object' && (val as any).animeId && (val as any).userId && typeof (val as any).vote === 'number') {
              const aId = String((val as any).animeId);
              const uId = String((val as any).userId);
              if (!localVotesMap[aId]) localVotesMap[aId] = {};
              localVotesMap[aId][uId] = Number((val as any).vote);
            }
          }
          localStorage.setItem('kh_all_anime_user_votes_v2', JSON.stringify(localVotesMap));
        }
        if (animeRatings || userAnimeVotes) {
          window.dispatchEvent(new CustomEvent('kh_rating_updated', { detail: {} }));
          window.dispatchEvent(new CustomEvent('kh_ratings_updated'));
        }
        if (Array.isArray(comments) && comments.length > 0) {
          localStorage.setItem('kh_global_comments_cache_v2', JSON.stringify(comments.slice(0, 500)));
        }
      } catch {}

      // Direct Firestore Restore Helper (used automatically on Vercel or to guarantee 100% Firestore sync)
      const restoreDirectlyToFirestore = async () => {
        if (!db) {
          throw new Error('No hay base de datos Firebase conectada.');
        }
        const nowIso = new Date().toISOString();
        const studioNameToId = new Map<string, string>();
        const genreNameToId = new Map<string, string>();

        // 1. Restore Studios with images and orderIndex
        setBackupStatus('Restaurando estudios y sus portadas en Firebase Firestore...');
        for (let idx = 0; idx < rawStudios.length; idx++) {
          const s = rawStudios[idx];
          if (!s) continue;
          const sName = String(s.name || s.title || 'Estudio').trim();
          const stPct = 6 + Math.round(((idx + 1) / Math.max(1, rawStudios.length)) * 8);
          setLiveProgress({
            title: 'Restaurando Copia de Seguridad',
            detail: `Restaurando estudio ${idx + 1} de ${rawStudios.length}: "${sName}"...`,
            percent: stPct,
            current: idx + 1,
            total: rawStudios.length,
            unit: 'estudios'
          });
          const slug = sName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const sId = String(s.id || (slug ? `st-${slug}` : `st-${idx}`));
          const safeStudioImg = s.image ? await ensureFirestoreSafeImage(s.image) : '';
          const studioDoc: Record<string, any> = {
            id: sId,
            name: sName,
            order: typeof s.order === 'number' ? s.order : 10,
            orderIndex: typeof s.orderIndex === 'number' ? s.orderIndex : idx,
            storageLocation: 'Firebase Firestore',
            updatedAt: nowIso
          };
          if (safeStudioImg) studioDoc.image = safeStudioImg;
          await setDoc(doc(db, 'studios', sId), studioDoc, { merge: true });
          studioNameToId.set(getNormalizedKey(sName), sId);
        }

        // 2. Restore Genres with images and orderIndex
        setBackupStatus('Restaurando géneros y sus portadas en Firebase Firestore...');
        for (let idx = 0; idx < rawGenres.length; idx++) {
          const g = rawGenres[idx];
          if (!g) continue;
          const gName = String(g.name || g.title || 'Género').trim();
          const gnPct = 14 + Math.round(((idx + 1) / Math.max(1, rawGenres.length)) * 8);
          setLiveProgress({
            title: 'Restaurando Copia de Seguridad',
            detail: `Restaurando género ${idx + 1} de ${rawGenres.length}: "${gName}"...`,
            percent: gnPct,
            current: idx + 1,
            total: rawGenres.length,
            unit: 'géneros'
          });
          const slug = gName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const gId = String(g.id || (slug ? `gn-${slug}` : `gn-${idx}`));
          const safeGenreImg = g.image ? await ensureFirestoreSafeImage(g.image) : '';
          const genreDoc: Record<string, any> = {
            id: gId,
            name: gName,
            order: typeof g.order === 'number' ? g.order : 10,
            orderIndex: typeof g.orderIndex === 'number' ? g.orderIndex : idx,
            storageLocation: 'Firebase Firestore',
            updatedAt: nowIso
          };
          if (safeGenreImg) genreDoc.image = safeGenreImg;
          await setDoc(doc(db, 'genres', gId), genreDoc, { merge: true });
          genreNameToId.set(getNormalizedKey(gName), gId);
        }

        // 3. Restore Animes with covers, episode thumbnails, episode covers, Spin-off/secuelas, and exact orderIndex
        const totalAnimes = rawAnimes.length;
        const animeNameToId = new Map<string, string>();
        for (let i = 0; i < totalAnimes; i++) {
          const r = rawAnimes[i];
          if (!r || (!r.name && !r.title)) continue;
          const rName = String(r.name || r.title || 'Anime').trim();
          const rSlug = rName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const rId = String(r.id || rSlug || `anime-${Date.now()}-${i}`).trim();
          animeNameToId.set(getNormalizedKey(rName), rId);
        }

        // Also map top-level continuations if present in backup
        const topLevelContMap = new Map<string, { type: string; ids: string[] }>();
        if (Array.isArray(schema.continuations)) {
          for (const grp of schema.continuations) {
            if (!grp) continue;
            const grpIds: string[] = [];
            if (Array.isArray(grp.animeIds)) {
              for (const id of grp.animeIds) {
                if (id) grpIds.push(String(id));
              }
            }
            if (grpIds.length === 0 && Array.isArray(grp.animeNames)) {
              for (const nm of grp.animeNames) {
                const found = animeNameToId.get(getNormalizedKey(String(nm)));
                if (found && !grpIds.includes(found)) grpIds.push(found);
              }
            }
            if (grpIds.length > 1) {
              for (const memberId of grpIds) {
                const others = grpIds.filter(id => id !== memberId);
                topLevelContMap.set(memberId, {
                  type: formatContinuationTitle(grp.type, others.length),
                  ids: others
                });
              }
            }
          }
        }

        for (let i = 0; i < totalAnimes; i++) {
          const rawAnime = rawAnimes[i];
          if (!rawAnime || (!rawAnime.name && !rawAnime.title)) continue;

          const percent = Math.min(94, 22 + Math.round(((i + 1) / Math.max(1, totalAnimes)) * 72));
          setBackupProgress({ current: i + 1, total: totalAnimes, percent });
          setLiveProgress({
            title: 'Restaurando Copia de Seguridad',
            detail: `Restaurando anime ${i + 1} de ${totalAnimes}: "${rawAnime.name || rawAnime.title}"...`,
            percent,
            current: i + 1,
            total: totalAnimes,
            unit: 'animes'
          });
          setBackupStatus(`Restaurando en Firebase (${i + 1} / ${totalAnimes} - ${percent}%): "${rawAnime.name || rawAnime.title}"...`);

          const animeName = String(rawAnime.name || rawAnime.title || 'Anime').trim();
          const slug = animeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const animeId = String(rawAnime.id || slug || `anime-${Date.now()}-${i}`).trim();

          let sIds: string[] = [];
          if (Array.isArray(rawAnime.studioIds) && rawAnime.studioIds.length > 0) {
            sIds = rawAnime.studioIds.map(String);
          } else if (rawAnime.studioId) {
            sIds = [String(rawAnime.studioId)];
          } else if (Array.isArray(rawAnime.studioNames)) {
            for (const sName of rawAnime.studioNames) {
              const foundId = studioNameToId.get(getNormalizedKey(sName));
              if (foundId && !sIds.includes(foundId)) sIds.push(foundId);
            }
          }

          let gIds: string[] = [];
          if (Array.isArray(rawAnime.genreIds) && rawAnime.genreIds.length > 0) {
            gIds = rawAnime.genreIds.map(String);
          } else if (Array.isArray(rawAnime.genreNames)) {
            for (const gName of rawAnime.genreNames) {
              const foundId = genreNameToId.get(getNormalizedKey(gName));
              if (foundId && !gIds.includes(foundId)) gIds.push(foundId);
            }
          }

          const rawCover = rawAnime.coverData || rawAnime.cover_data || rawAnime.image || rawAnime.cover || '';
          const safeCover = rawCover ? await ensureFirestoreSafeImage(rawCover) : '';
          const isBase64Cover = safeCover.startsWith('data:image/');

          const normEps = normalizeEpisodesList(rawAnime.episodes || []);
          const cleanEpisodes: any[] = [];
          for (let epIdx = 0; epIdx < normEps.length; epIdx++) {
            const ep = normEps[epIdx];
            const link = getEpisodeUrl(ep);
            const epObj: Record<string, any> = {
              number: Number(ep.number) || (epIdx + 1),
              mp4Url: link,
              isNew: Boolean(ep.isNew)
            };
            if (ep.title) epObj.title = String(ep.title);
            if (ep.name) epObj.name = String(ep.name);
            if (ep.addedToRecentAt) epObj.addedToRecentAt = String(ep.addedToRecentAt);
            if (ep.thumbnail) epObj.thumbnail = ep.thumbnail;
            if (ep.coverImage) epObj.coverImage = ep.coverImage;
            cleanEpisodes.push(epObj);
          }

          // Resolve continuationAnimeIds & continuationType (from IDs, names, continuationOrder, or top-level continuations)
          let contIds: string[] = [];
          if (Array.isArray(rawAnime.continuationAnimeIds) && rawAnime.continuationAnimeIds.length > 0) {
            contIds = rawAnime.continuationAnimeIds.map(String).filter((id: string) => id && id !== animeId);
          } else if (Array.isArray(rawAnime.continuation_anime_ids) && rawAnime.continuation_anime_ids.length > 0) {
            contIds = rawAnime.continuation_anime_ids.map(String).filter((id: string) => id && id !== animeId);
          } else if (Array.isArray(rawAnime.continuationOrder) && rawAnime.continuationOrder.length > 0) {
            for (const item of rawAnime.continuationOrder) {
              const cId = item?.id ? String(item.id) : (item?.name ? animeNameToId.get(getNormalizedKey(String(item.name))) : '');
              if (cId && cId !== animeId && !contIds.includes(cId)) contIds.push(cId);
            }
          } else if (Array.isArray(rawAnime.continuationAnimeNames) && rawAnime.continuationAnimeNames.length > 0) {
            for (const cName of rawAnime.continuationAnimeNames) {
              const foundId = animeNameToId.get(getNormalizedKey(String(cName)));
              if (foundId && foundId !== animeId && !contIds.includes(foundId)) contIds.push(foundId);
            }
          } else if (topLevelContMap.has(animeId)) {
            contIds = topLevelContMap.get(animeId)!.ids;
          }

          const rawContType = rawAnime.continuationType || rawAnime.continuation_type || topLevelContMap.get(animeId)?.type || '';
          const finalContType = contIds.length > 0 ? formatContinuationTitle(rawContType, contIds.length) : '';

          const orderIdx = typeof rawAnime.orderIndex === 'number' ? rawAnime.orderIndex : i;
          const createdAt = rawAnime.createdAt || rawAnime.created_at || new Date(Date.now() - 10000000 + orderIdx * 1000).toISOString();
          const updatedAt = rawAnime.updatedAt || rawAnime.updated_at || createdAt || nowIso;

          const isExternalUrlCover = /^https?:\/\//i.test(safeCover);
          const resolvedReleaseMonth = rawAnime.releaseMonth ? String(rawAnime.releaseMonth).trim() : '';
          const importedPortadaVersion = Number(rawAnime.portadaVersion) || 1;

          const fsAnimeDoc: Record<string, any> = {
            id: animeId,
            name: animeName,
            image: isExternalUrlCover ? safeCover : '',
            studioIds: sIds,
            genreIds: gIds,
            status: String(rawAnime.status || 'Finalizado').trim(),
            year: normalizeAnimeYear(rawAnime.year),
            description: String(rawAnime.description || rawAnime.synopsis || '').trim(),
            telegramUrl: String(rawAnime.telegramUrl || rawAnime.telegram_url || '').trim(),
            episodes: cleanEpisodes,
            hidden: Boolean(rawAnime.hidden),
            downloads: Number(rawAnime.downloads) || 0,
            orderIndex: orderIdx,
            createdAt,
            updatedAt
          };

          if (!isExternalUrlCover && isBase64Cover && safeCover) {
            await setDoc(doc(db, 'portadas', animeId), {
              imagen: safeCover,
              portadaVersion: importedPortadaVersion
            }).catch(() => null);
            upsertPortadaMemoryCache(animeId, safeCover, importedPortadaVersion);
            fsAnimeDoc.portadaVersion = importedPortadaVersion;
            delete fsAnimeDoc.image;
          }
          if (resolvedReleaseMonth) {
            fsAnimeDoc.releaseMonth = resolvedReleaseMonth;
          }
          if (contIds.length > 0) {
            fsAnimeDoc.continuationAnimeIds = contIds;
            if (finalContType) {
              fsAnimeDoc.continuationType = finalContType;
            }
          }

          try {
            await setDoc(doc(db, 'animes', animeId), fsAnimeDoc);
          } catch (docErr) {
            // If document exceeded Firestore 1MB limit due to embedded episode thumbnails, save sanitized version
            const leanEpisodes = cleanEpisodes.map((ep: any) => ({
              ...ep,
              thumbnail: (ep.thumbnail && ep.thumbnail.length > 50000) ? undefined : ep.thumbnail,
              coverImage: (ep.coverImage && ep.coverImage.length > 50000) ? undefined : ep.coverImage
            }));
            const leanDoc: Record<string, any> = { ...fsAnimeDoc, episodes: leanEpisodes };
            await setDoc(doc(db, 'animes', animeId), leanDoc).catch(() => null);
          }
        }

        // 4. Restore Ratings, Votes, Comments, and User Lists if present
        setLiveProgress({
          title: 'Restaurando Copia de Seguridad',
          detail: 'Restaurando calificaciones, comentarios y listas de comunidad...',
          percent: 96,
          current: totalAnimes,
          total: totalAnimes,
          unit: 'animes'
        });

        if (animeRatings && typeof animeRatings === 'object') {
          setBackupStatus('Restaurando calificaciones en Firebase Firestore...');
          const entries = Array.isArray(animeRatings)
            ? animeRatings.map((r: any) => [r.id || r.animeId, r])
            : Object.entries(animeRatings);
          for (const [docId, val] of entries) {
            if (docId && val && typeof val === 'object') {
              await setDoc(doc(db, 'anime_ratings', String(docId)), val, { merge: true }).catch(() => null);
            }
          }
        }

        if (userAnimeVotes && typeof userAnimeVotes === 'object') {
          const entries = Array.isArray(userAnimeVotes)
            ? userAnimeVotes.map((v: any) => [v.id || `${v.userId}_${v.animeId}`, v])
            : Object.entries(userAnimeVotes);
          for (const [docId, val] of entries) {
            if (docId && val && typeof val === 'object') {
              await setDoc(doc(db, 'user_anime_votes', String(docId)), val, { merge: true }).catch(() => null);
            }
          }
        }

        if (Array.isArray(comments)) {
          setBackupStatus('Restaurando comentarios en Firebase Firestore...');
          for (const c of comments) {
            if (c && typeof c === 'object') {
              const cId = String(c.id || `comment_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
              const { id: _ignore, ...commentData } = c;
              await setDoc(doc(db, 'comentariosGlobales', cId), commentData, { merge: true }).catch(() => null);
            }
          }
        }

        if (userListsCloud && typeof userListsCloud === 'object') {
          for (const [uid, data] of Object.entries(userListsCloud)) {
            if (uid && data && typeof data === 'object') {
              await setDoc(doc(db, 'userLists', String(uid)), data as any, { merge: true }).catch(() => null);
            }
          }
        }
      };

      // If no animes, just import studios/genres directly
      if (rawAnimes.length === 0) {
        setBackupStatus('Importando estudios y géneros...');
        const res = await fetch('/api/backup/import', {
          method: 'POST',
          headers: apiHeaders,
          body: JSON.stringify(schema)
        }).catch(() => null);

        const ct = res?.headers?.get('content-type') || '';
        if (res && res.ok && ct.includes('application/json')) {
          const data = await res.json();
          if (db && isFirebaseConfigured) {
            await restoreDirectlyToFirestore().catch(() => null);
          }
          setLiveProgress({
            title: '¡Restauración Completada!',
            detail: 'Estudios y géneros restaurados al 100%',
            percent: 100
          });
          await new Promise(r => setTimeout(r, 300));
          setBackupStatus(data.message || 'Importación completada con éxito.');
          setImportJson('');
          setParsedBackupData(null);
          setBackupProgress(null);
          onRefresh();
          showNotification('Base de datos restaurada correctamente', 'success');
        } else {
          await restoreDirectlyToFirestore();
          setLiveProgress({
            title: '¡Restauración Completada!',
            detail: 'Estudios y géneros restaurados al 100% en Firebase Firestore',
            percent: 100
          });
          await new Promise(r => setTimeout(r, 300));
          setBackupStatus('Estudios y géneros restaurados directamente en Firebase Firestore.');
          setImportJson('');
          setParsedBackupData(null);
          setBackupProgress(null);
          onRefresh();
          showNotification('Base de datos restaurada correctamente', 'success');
        }
        return;
      }

      // Chunked import: sends batches of 8 animes to avoid Cloud Run / proxy 32MB payload limit (Error 413)
      setBackupStatus(`Iniciando importación (${rawAnimes.length} animes detectados)...`);
      setBackupProgress({ current: 0, total: rawAnimes.length, percent: 5 });
      setLiveProgress({
        title: 'Restaurando Copia de Seguridad',
        detail: `Inicializando restauración de ${rawAnimes.length} animes...`,
        percent: 5,
        current: 0,
        total: rawAnimes.length,
        unit: 'animes'
      });

      // Step 1: Initialize session on backend (with automatic direct Firestore fallback for Vercel)
      const initRes = await fetch('/api/backup/import-init', {
        method: 'POST',
        headers: apiHeaders,
        body: JSON.stringify({
          studios: rawStudios,
          genres: rawGenres,
          continuations: schema.continuations,
          userLists,
          userListsCloud,
          animeRatings,
          userAnimeVotes,
          comments,
          trash: backupTrash,
          totalAnimes: rawAnimes.length
        })
      }).catch(() => null);

      const initContentType = initRes?.headers?.get('content-type') || '';
      if (!initRes || !initRes.ok || !initContentType.includes('application/json')) {
        // Fallback for Vercel / static hosting where Express backend routes do not exist
        await restoreDirectlyToFirestore();
        setBackupProgress({ current: rawAnimes.length, total: rawAnimes.length, percent: 100 });
        setLiveProgress({
          title: '¡Restauración Completada!',
          detail: `${rawAnimes.length} animes, ${rawStudios.length} estudios y ${rawGenres.length} géneros restaurados al 100%`,
          percent: 100,
          current: rawAnimes.length,
          total: rawAnimes.length,
          unit: 'animes'
        });
        await new Promise(r => setTimeout(r, 350));
        setBackupProgress(null);
        setBackupStatus(`¡Base de datos restaurada exitosamente en Firebase Firestore! (${rawAnimes.length} animes, ${rawStudios.length} estudios y ${rawGenres.length} géneros con todas sus portadas y miniaturas).`);
        setImportJson('');
        setParsedBackupData(null);
        onRefresh(rawAnimes);
        showNotification('¡Base de datos restaurada correctamente!', 'success');
        return;
      }

      const initData = await initRes.json();
      const sessionId = initData.sessionId;

      // Step 2: Upload animes in robust batches with automatic retry
      const BATCH_SIZE = 12;
      const totalAnimes = rawAnimes.length;
      const totalChunks = Math.ceil(totalAnimes / BATCH_SIZE);

      for (let i = 0; i < totalAnimes; i += BATCH_SIZE) {
        const batch = rawAnimes.slice(i, i + BATCH_SIZE);
        const chunkIndex = Math.floor(i / BATCH_SIZE) + 1;
        const currentProcessed = Math.min(totalAnimes, i + batch.length);
        const percent = Math.min(95, Math.round((currentProcessed / totalAnimes) * 95));

        setBackupProgress({ current: currentProcessed, total: totalAnimes, percent });
        setLiveProgress({
          title: 'Restaurando Copia de Seguridad',
          detail: `Restaurando lote ${chunkIndex} de ${totalChunks} (${currentProcessed} de ${totalAnimes} animes)...`,
          percent,
          current: currentProcessed,
          total: totalAnimes,
          unit: 'animes'
        });
        setBackupStatus(`Restaurando lote ${chunkIndex} de ${totalChunks} (${currentProcessed} / ${totalAnimes} animes - ${percent}%)...`);

        let chunkSuccess = false;
        let lastChunkErr = '';
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const chunkRes = await fetch('/api/backup/import-chunk', {
              method: 'POST',
              headers: apiHeaders,
              body: JSON.stringify({
                sessionId,
                animes: batch
              })
            });

            if (chunkRes.ok) {
              chunkSuccess = true;
              break;
            } else {
              const errData = await chunkRes.json().catch(() => ({}));
              lastChunkErr = errData.error || `Error ${chunkRes.status} al procesar lote ${chunkIndex}/${totalChunks}.`;
            }
          } catch (e: any) {
            lastChunkErr = e?.message || 'Error de red en lote';
          }
          if (attempt < 3) await new Promise(r => setTimeout(r, 600));
        }

        if (!chunkSuccess) {
          throw new Error(lastChunkErr || `Error al procesar lote ${chunkIndex}/${totalChunks}.`);
        }
      }

      // Step 3: Finalize session and save all data
      setBackupProgress({ current: totalAnimes, total: totalAnimes, percent: 98 });
      setLiveProgress({
        title: 'Sincronizando Base de Datos',
        detail: 'Finalizando guardado y sincronizando con Firebase Firestore...',
        percent: 98,
        current: totalAnimes,
        total: totalAnimes,
        unit: 'animes'
      });
      setBackupStatus('Finalizando guardado y sincronizando base de datos...');

      const finishRes = await fetch('/api/backup/import-finish', {
        method: 'POST',
        headers: apiHeaders,
        body: JSON.stringify({ sessionId })
      });

      if (!finishRes.ok) {
        const errData = await finishRes.json().catch(() => ({}));
        throw new Error(errData.error || `Error ${finishRes.status} al finalizar importación.`);
      }

      const finishData = await finishRes.json();
      if (db && isFirebaseConfigured) {
        setBackupStatus('Sincronizando respaldo completo directamente en Firebase Firestore...');
        await restoreDirectlyToFirestore().catch((fsErr) => {
          console.warn('[Firestore Client Backup Sync Warning]:', fsErr);
        });
      }
      setBackupProgress({ current: totalAnimes, total: totalAnimes, percent: 100 });
      setLiveProgress({
        title: '¡Restauración Completada!',
        detail: `${totalAnimes} animes restaurados al 100%`,
        percent: 100,
        current: totalAnimes,
        total: totalAnimes,
        unit: 'animes'
      });
      await new Promise(r => setTimeout(r, 350));

      setBackupProgress(null);
      setBackupStatus(finishData.message || `¡Base de datos importada exitosamente! ${totalAnimes} animes restaurados.`);
      setImportJson('');
      setParsedBackupData(null);
      onRefresh(rawAnimes);
      showNotification('¡Base de datos restaurada correctamente sin errores!', 'success');
    } catch (err: any) {
      const msg = err?.message || 'Error de red o procesamiento al restaurar.';
      setBackupStatus(`Error al restaurar: ${msg}`);
      setBackupProgress(null);
      showNotification(msg, 'error');
    } finally {
      setIsImporting(false);
      setLiveProgress(null);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const content = event.target?.result as string;
        if (!content) throw new Error('El archivo está vacío');
        const parsed = JSON.parse(content);
        setParsedBackupData(parsed);

        let count = 0;
        if (Array.isArray(parsed)) count = parsed.length;
        else if (Array.isArray(parsed.animes)) count = parsed.animes.length;
        else if (parsed.animes && typeof parsed.animes === 'object') count = Object.keys(parsed.animes).length;
        else if (parsed.data?.animes && Array.isArray(parsed.data.animes)) count = parsed.data.animes.length;
        else if (parsed.backup?.animes && Array.isArray(parsed.backup.animes)) count = parsed.backup.animes.length;
        else if (parsed.db?.animes && Array.isArray(parsed.db.animes)) count = parsed.db.animes.length;
        else if (parsed.catalog && Array.isArray(parsed.catalog)) count = parsed.catalog.length;
        else if (typeof parsed === 'object' && parsed !== null) {
          const vals = Object.values(parsed);
          if (vals.length > 0 && typeof vals[0] === 'object' && ((vals[0] as any)?.name || (vals[0] as any)?.title)) {
            count = vals.length;
          }
        }

        // If large file, avoid pasting tens of megabytes into textarea to prevent browser tab freezing
        if (content.length > 30000) {
          setImportJson(`/* Respaldo cargado: "${file.name}" (${(file.size / (1024 * 1024)).toFixed(2)} MB - ${count > 0 ? count + ' animes detectados' : 'Estructura lista'}) */`);
        } else {
          setImportJson(content);
        }

        setBackupStatus(`Archivo "${file.name}" cargado (${count > 0 ? count + ' animes detectados' : 'Estructura válida'}). Haz clic en "Aplicar e Importar Respaldo".`);
        showNotification(`Archivo "${file.name}" cargado correctamente.`, 'success');
      } catch (err: any) {
        setParsedBackupData(null);
        setBackupStatus(`El archivo seleccionado no contiene un JSON válido: ${err?.message || ''}`);
        showNotification('El archivo no contiene un formato JSON válido.', 'error');
      }
    };
    reader.onerror = () => {
      setBackupStatus('Error al leer el archivo desde el dispositivo.');
      showNotification('Error al leer el archivo seleccionado.', 'error');
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleImportBackup = async () => {
    if (!parsedBackupData && !importJson.trim()) {
      return setBackupStatus('Selecciona un archivo JSON o pega el código de respaldo.');
    }
    setDeleteConfirm({
      type: 'backup',
      id: 'import',
      title: 'Confirmar Importación',
      message: '¡Atención! Esta acción actualizará los datos de la base de datos (Animes, Estudios y Géneros) y los sincronizará a Firestore. ¿Deseas proceder?',
      onConfirm: () => executeImportBackup()
    });
  };

  const [isClearingSupport, setIsClearingSupport] = useState(false);

  const executeClearSupportMessages = async () => {
    setDeleteConfirm(null);
    setIsClearingSupport(true);
    const nowMs = Date.now();
    const TELEGRAM_BOT_TOKEN = '8870602337:AAHM2VP4BPE1EHxgJFzjHyFu6fxyu71Cyd4';

    setLiveProgress({
      title: 'Limpiando Mensajes y Respuestas',
      detail: 'Eliminando reportes en Firestore...',
      percent: 25
    });

    try {
      // 1. Delete all documents in Firestore support_reports and record reset state
      try {
        if (db) {
          const snap = await getDocs(collection(db, 'support_reports'));
          const totalDocs = snap.docs.length;
          for (let i = 0; i < totalDocs; i++) {
            await deleteDoc(snap.docs[i].ref).catch(() => {});
          }
          await setDoc(doc(db, 'support_config', 'reset_state'), {
            clearedAtMs: nowMs,
            clearedAt: new Date(nowMs).toISOString()
          }, { merge: true }).catch(() => {});
        }
      } catch (e) {}

      setLiveProgress({
        title: 'Limpiando Mensajes y Respuestas',
        detail: 'Limpiando cola de respuestas de Telegram...',
        percent: 65
      });

      // 2. Flush Telegram Bot getUpdates queue directly so old replies never reappear
      try {
        const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?limit=100`);
        if (tgRes.ok) {
          const tgData = await tgRes.json();
          let maxUpdateId = 0;
          if (tgData?.ok && Array.isArray(tgData.result)) {
            for (const u of tgData.result) {
              if (u.update_id && u.update_id > maxUpdateId) {
                maxUpdateId = u.update_id;
              }
            }
          }
          if (maxUpdateId > 0) {
            await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${maxUpdateId + 1}&limit=1`);
          }
        }
      } catch (e) {}

      setLiveProgress({
        title: 'Limpiando Mensajes y Respuestas',
        detail: 'Sincronizando limpieza en el servidor...',
        percent: 90
      });

      // 3. Call backend endpoint if available
      await fetch('/api/admin/reset-support-messages', {
        method: 'POST',
        headers: apiHeaders
      }).catch(() => null);

      // 4. Clear local storage keys and notify active ReportIssueModal
      try {
        localStorage.setItem('kh_support_cleared_at', String(nowMs));
        localStorage.removeItem('kh_report_chat_messages');
        localStorage.removeItem('kh_report_chat_started_at');
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && (k.startsWith('kh_report_chat_messages_') || k.startsWith('kh_report_chat_started_at_'))) {
            keysToRemove.push(k);
          }
        }
        keysToRemove.forEach(k => localStorage.removeItem(k));
        window.dispatchEvent(new CustomEvent('kh_support_chat_cleared', { detail: { clearedAtMs: nowMs } }));
      } catch (e) {}

      setLiveProgress({
        title: '¡Limpieza Completada!',
        detail: 'Todos los mensajes y respuestas eliminados al 100%',
        percent: 100
      });
      await new Promise(r => setTimeout(r, 280));
      showNotification('Todos los mensajes enviados y todas las respuestas han sido eliminados correctamente.', 'success');
      fetchFirebaseQuotaStats();
    } catch (err) {
      showNotification('Error al borrar los mensajes y respuestas.', 'error');
    } finally {
      setIsClearingSupport(false);
      setLiveProgress(null);
    }
  };

  const handleClearSupportMessages = () => {
    setDeleteConfirm({
      type: 'backup',
      id: 'clear-support-messages',
      title: 'Borrar Mensajes y Respuestas',
      message: '¿Estás seguro de que deseas borrar todos los mensajes enviados por los usuarios y todas las respuestas del chat de soporte y sugerencias? Esta acción limpiará el historial por completo.',
      onConfirm: () => executeClearSupportMessages()
    });
  };


  // --- LOGIN SCREEN / AUTO AUTH ---
  if (!token) {
    if (isAdminEmail) {
      return (
        <div className="relative min-h-screen flex items-center justify-center bg-[#030303] text-white px-4">
          <div className="text-center space-y-4">
            <div className="w-12 h-12 border-4 border-brand-red/30 border-t-brand-red rounded-full animate-spin mx-auto" />
            <p className="font-mono text-sm text-neutral-300">Iniciando Panel de Control de Administrador...</p>
          </div>
        </div>
      );
    }

    return (
      <div className="relative min-h-screen flex items-center justify-center bg-[#030303] text-white px-4">
        <div className="relative w-full max-w-md z-10 bg-dark-card border border-dark-border rounded-xl p-8 shadow-2xl text-center space-y-6">
          <div className="w-14 h-14 bg-brand-red/10 border border-brand-red/30 rounded-full flex items-center justify-center mx-auto text-brand-red">
            <Lock className="h-7 w-7" />
          </div>
          <div className="space-y-2">
            <h2 className="font-display font-bold text-lg uppercase tracking-wider text-white">
              Acceso Reservado
            </h2>
            <p className="font-sans text-xs text-neutral-400 leading-relaxed">
              El panel de administración está reservado únicamente para la cuenta de administrador (<span className="text-purple-300 font-mono">kuzeofc@gmail.com</span>).
            </p>
          </div>
          <button
            type="button"
            onClick={onBackToHome}
            className="w-full py-2.5 bg-brand-red hover:bg-[#ff3b75] text-white rounded-lg font-mono text-xs font-semibold uppercase tracking-wider transition-colors cursor-pointer"
          >
            Volver al Catálogo
          </button>
        </div>
      </div>
    );
  }

  // --- ADMIN DECK SCREEN ---
  return (
    <div className="min-h-screen bg-dark-bg text-white font-sans flex flex-col">
      {/* Admin Top Header */}
      <header className="border-b border-dark-border bg-dark-card py-3 px-4 sm:px-6 lg:px-8 space-y-3">
        {/* Top Row: Navigation, Firebase Real-Time Status */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Left: Circular back button + Compact Firebase Live Status Badge with visible project */}
          <div className="flex items-center gap-2 flex-nowrap shrink-0">
            <button
              onClick={onBackToHome}
              title="Volver al Catálogo"
              className="w-9 h-9 rounded-full bg-[#0a0a0a] border border-dark-border hover:border-brand-red flex items-center justify-center text-neutral-300 hover:text-white transition-all shadow-md cursor-pointer shrink-0"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>

            {/* Compact Real-time Firebase Status Indicator right next to back button */}
            <div 
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-mono transition-all duration-300 shrink-0 select-none ${
                firebaseStatus.loading
                  ? 'bg-neutral-900 border-neutral-700 text-neutral-400'
                  : firebaseStatus.connected
                  ? 'bg-emerald-950/70 border-emerald-500/50 text-emerald-300 shadow-sm'
                  : 'bg-rose-950/70 border-rose-500/50 text-rose-300 shadow-sm'
              }`}
              title={firebaseStatus.message || (firebaseStatus.connected ? `Conectado a Firebase Firestore${firebaseStatus.projectId ? ` (${firebaseStatus.projectId})` : ''}` : 'Sin base de datos Firebase conectada')}
            >
              <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${
                firebaseStatus.loading 
                  ? 'bg-neutral-400 animate-pulse' 
                  : firebaseStatus.connected 
                  ? 'bg-emerald-400' 
                  : 'bg-rose-500'
              }`} />
              
              <span className="text-neutral-400 text-[10px] uppercase font-bold tracking-wider shrink-0">
                Firebase:
              </span>
              
              <span className="font-semibold text-white text-[11px] truncate max-w-[120px] sm:max-w-none">
                {firebaseStatus.loading 
                  ? '...' 
                  : firebaseStatus.connected 
                  ? (firebaseStatus.projectId || 'Conectado') 
                  : 'Off'}
              </span>

              <button
                type="button"
                onClick={checkFirebaseConnection}
                disabled={firebaseStatus.loading}
                className="p-0.5 hover:bg-white/10 rounded-full transition-colors text-current opacity-70 hover:opacity-100 cursor-pointer shrink-0 ml-0.5"
                title="Comprobar conexión con Firebase"
              >
                <RefreshCw className={`h-3 w-3 ${firebaseStatus.loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>
        </div>

        {/* Tab Navigation Bubbles - Protected against accidental clicks during touch scroll */}
        <div
          ref={tabsContainerRef}
          onTouchStart={handleTabsTouchStart}
          onTouchMove={handleTabsTouchMove}
          onTouchEnd={handleTabsTouchEnd}
          className="w-full flex items-center gap-2 overflow-x-auto scrollbar-none py-1 touch-pan-x"
        >
          <button
            type="button"
            onClick={() => onSafeTabClick('animes')}
            className={`px-4 py-2 rounded-full font-mono text-xs uppercase tracking-wider flex items-center gap-2 shrink-0 transition-all duration-200 border cursor-pointer ${
              activeTab === 'animes'
                ? 'bg-brand-red border-brand-red text-white font-bold shadow-lg shadow-brand-red/30'
                : 'bg-[#0e0e12] border-dark-border text-neutral-400 hover:text-white hover:border-neutral-600 hover:bg-[#16161d]'
            }`}
          >
            <Film className="h-3.5 w-3.5" />
            <span>Animes</span>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold ${
              activeTab === 'animes' ? 'bg-white/20 text-white' : 'bg-white/5 text-neutral-400'
            }`}>{animes.length}</span>
          </button>

          <button
            type="button"
            onClick={() => onSafeTabClick('episodes')}
            className={`px-4 py-2 rounded-full font-mono text-xs uppercase tracking-wider flex items-center gap-2 shrink-0 transition-all duration-200 border cursor-pointer ${
              activeTab === 'episodes'
                ? 'bg-purple-600 border-purple-500 text-white font-bold shadow-lg shadow-purple-600/30'
                : 'bg-[#0e0e12] border-dark-border text-neutral-400 hover:text-white hover:border-neutral-600 hover:bg-[#16161d]'
            }`}
          >
            <Film className="h-3.5 w-3.5" />
            <span>Episodios</span>
          </button>

          <button
            type="button"
            onClick={() => onSafeTabClick('studios')}
            className={`px-4 py-2 rounded-full font-mono text-xs uppercase tracking-wider flex items-center gap-2 shrink-0 transition-all duration-200 border cursor-pointer ${
              activeTab === 'studios'
                ? 'bg-brand-red border-brand-red text-white font-bold shadow-lg shadow-brand-red/30'
                : 'bg-[#0e0e12] border-dark-border text-neutral-400 hover:text-white hover:border-neutral-600 hover:bg-[#16161d]'
            }`}
          >
            <Layers className="h-3.5 w-3.5" />
            <span>Estudios</span>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold ${
              activeTab === 'studios' ? 'bg-white/20 text-white' : 'bg-white/5 text-neutral-400'
            }`}>{studios.length}</span>
          </button>

          <button
            type="button"
            onClick={() => onSafeTabClick('genres')}
            className={`px-4 py-2 rounded-full font-mono text-xs uppercase tracking-wider flex items-center gap-2 shrink-0 transition-all duration-200 border cursor-pointer ${
              activeTab === 'genres'
                ? 'bg-brand-red border-brand-red text-white font-bold shadow-lg shadow-brand-red/30'
                : 'bg-[#0e0e12] border-dark-border text-neutral-400 hover:text-white hover:border-neutral-600 hover:bg-[#16161d]'
            }`}
          >
            <Tag className="h-3.5 w-3.5" />
            <span>Géneros</span>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold ${
              activeTab === 'genres' ? 'bg-white/20 text-white' : 'bg-white/5 text-neutral-400'
            }`}>{genres.length}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              if (isDraggingTabsRef.current) return;
              setShowDuplicatesModal(true);
            }}
            className="px-4 py-2 rounded-full font-mono text-xs uppercase tracking-wider flex items-center gap-2 shrink-0 transition-all duration-200 border border-dark-border bg-[#0e0e12] text-neutral-400 hover:text-white hover:border-neutral-600 hover:bg-[#16161d] relative cursor-pointer"
            title="Detectar e inspeccionar elementos o enlaces duplicados"
          >
            <Search className="h-3.5 w-3.5 text-brand-red" />
            <span>Duplicados</span>
            {duplicateDiagnostics.totalDuplicates > 0 && (
              <span className="px-2 py-0.5 bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-full text-[10px] font-bold animate-pulse">
                {duplicateDiagnostics.totalDuplicates}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => onSafeTabClick('announcements')}
            className={`px-4 py-2 rounded-full font-mono text-xs uppercase tracking-wider flex items-center gap-2 shrink-0 transition-all duration-200 border cursor-pointer ${
              activeTab === 'announcements'
                ? 'bg-purple-600 border-purple-500 text-white font-bold shadow-lg shadow-purple-600/30'
                : 'bg-[#0e0e12] border-dark-border text-neutral-400 hover:text-white hover:border-neutral-600 hover:bg-[#16161d]'
            }`}
            title="Crear o administrar post para los usuarios registrados"
          >
            <MessageSquare className={`h-3.5 w-3.5 ${activeTab === 'announcements' ? 'text-white' : 'text-purple-400'}`} />
            <span>Post</span>
          </button>

          <button
            type="button"
            onClick={() => onSafeTabClick('firebase-stats')}
            className={`px-4 py-2 rounded-full font-mono text-xs uppercase tracking-wider flex items-center gap-2 shrink-0 transition-all duration-200 border cursor-pointer ${
              activeTab === 'firebase-stats'
                ? 'bg-amber-500 border-amber-500 text-black font-bold shadow-md shadow-amber-500/20'
                : 'bg-[#0e0e12] border-dark-border text-neutral-400 hover:text-white hover:border-neutral-600 hover:bg-[#16161d]'
            }`}
            title="Consumo de Espacio, Desglose de Datos y Copia de Seguridad"
          >
            <Cloud className={`h-3.5 w-3.5 ${activeTab === 'firebase-stats' ? 'text-black' : 'text-amber-400'}`} />
            <span>Espacio</span>
          </button>
        </div>
      </header>

      {/* Main Admin Content Grid */}
      <main className="flex-grow p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto w-full overflow-hidden">
        <AnimatePresence mode="wait" custom={tabDirection}>
          <motion.div
            key={activeTab}
            custom={tabDirection}
            initial={(dir: number) => ({ opacity: 0, x: dir >= 0 ? 50 : -50 })}
            animate={{ opacity: 1, x: 0 }}
            exit={(dir: number) => ({ opacity: 0, x: dir >= 0 ? -50 : 50 })}
            transition={{ duration: 0.28, ease: [0.25, 1, 0.5, 1] }}
          >
        {/* --- ANIMES TAB --- */}
        {activeTab === 'animes' && (
          <div className="space-y-5">
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Film className="h-4 w-4 text-brand-red" />
                  <h2 className="font-display font-bold text-sm uppercase tracking-wider text-white">
                    Catálogo de Animes
                  </h2>
                  <button
                    type="button"
                    onClick={() => {
                      fetchTrash();
                      setShowTrashModal(true);
                    }}
                    className="p-1.5 rounded-lg text-neutral-400 hover:text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/30 transition-all cursor-pointer relative"
                    title="Papelera de animes eliminados"
                  >
                    <Trash2 className="h-4 w-4" />
                    {trashNames.length > 0 && (
                      <span className="absolute -top-1 -right-1 px-1 min-w-[15px] h-[15px] rounded-full bg-red-600 text-[8.5px] font-mono font-bold text-white flex items-center justify-center shadow-xs leading-none">
                        {trashNames.length}
                      </span>
                    )}
                  </button>
                </div>
              </div>

              {!isAnimeFormOpen && (
                <div className="w-full space-y-2.5">
                  <button
                    type="button"
                    onClick={openNewAnimeForm}
                    className="w-full py-2.5 sm:py-3 bg-brand-red hover:bg-brand-red-hover text-white rounded-xl font-display font-semibold text-xs sm:text-sm tracking-wider uppercase flex items-center justify-center gap-2 transition-all duration-200 cursor-pointer shadow-md shadow-brand-red/20 active:scale-[0.99]"
                    title="Agregar un nuevo Hentai al catálogo"
                  >
                    <Plus className="h-4 w-4" />
                    <span>Agregar Hentai</span>
                  </button>
                </div>
              )}
            </div>

            {/* Anime Creation/Editing Form */}
            {isAnimeFormOpen && (
              <form onSubmit={handleSaveAnime} className="bg-dark-card border border-dark-border rounded-lg p-6 space-y-6">
                <div className="flex items-center justify-between border-b border-dark-border pb-4">
                  <h3 className="font-display font-bold text-sm tracking-widest text-brand-red uppercase">
                    {editingAnime ? 'EDITAR ANIME' : 'NUEVO ANIME'}
                  </h3>
                  <button
                    type="button"
                    onClick={() => setIsAnimeFormOpen(false)}
                    className="font-mono text-[9px] text-neutral-500 hover:text-white uppercase tracking-widest transition-colors duration-300"
                  >
                    Cancelar
                  </button>
                </div>

                {animeFormError && (
                  <div className="p-3 bg-brand-red/10 border border-brand-red/30 rounded text-xs text-brand-red font-mono">
                    {animeFormError}
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
                  {/* Left block: Portada & Upload */}
                  <div className="md:col-span-4 space-y-4">
                    <span className="font-mono text-[9px] text-neutral-400 uppercase tracking-widest block">
                      Portada del Anime
                    </span>
                    <div 
                      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                      onDragLeave={() => setIsDragging(false)}
                      onDrop={handleImageDrop}
                      onClick={() => fileInputRef.current?.click()}
                      className={`aspect-[2/3] w-full rounded border cursor-pointer group bg-black/40 flex flex-col items-center justify-center p-4 overflow-hidden relative transition-all duration-300 ${
                        isDragging ? 'border-brand-red bg-brand-red/5' : 'border-dark-border hover:border-brand-red/30'
                      }`}
                    >
                      {animeImage ? (
                        <>
                          <img src={portadaUrl(animeImage, 'admin')} alt="Vista previa" width={600} height={900} className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
                          <CoverPreviewSizeBadge src={animeImage} showSourceType />
                          <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col items-center justify-center gap-2">
                            <Upload className="h-6 w-6 text-white animate-bounce" />
                            <span className="font-mono text-[9px] text-white uppercase tracking-wider">Subir otra imagen</span>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation(); // Avoid triggering file input click
                              setAnimeImage('');
                              setAnimeCoverUrlInput('');
                              setIsImageOptimized(false);
                            }}
                            className="absolute bottom-2 right-2 p-1 px-2 bg-black/80 hover:bg-brand-red text-white text-[9px] font-mono rounded z-10"
                          >
                            Eliminar
                          </button>
                        </>
                      ) : isLoadingEditCover ? (
                        <div className="text-center space-y-2 pointer-events-none">
                          <div className="w-6 h-6 border-2 border-purple-500/30 border-t-purple-400 rounded-full animate-spin mx-auto" />
                          <p className="font-mono text-[10px] text-purple-300">Cargando portada...</p>
                        </div>
                      ) : (
                        <div className="text-center space-y-2 pointer-events-none">
                          <Upload className="h-8 w-8 text-neutral-700 mx-auto transition-transform duration-300 group-hover:-translate-y-1 group-hover:text-neutral-500" />
                          <p className="font-sans text-[11px] text-neutral-500 group-hover:text-neutral-400 transition-colors duration-300">
                            Arrastra una imagen aquí o haz clic para subir
                          </p>
                          <span className="font-mono text-[8px] text-neutral-600 block uppercase">PNG, JPG o WEBP</span>
                        </div>
                      )}
                    </div>
                    
                    <div className="space-y-2.5">
                      <input
                        type="file"
                        accept="image/*"
                        ref={fileInputRef}
                        onChange={handleImageFileChange}
                        className="hidden"
                      />

                      <button
                        type="button"
                        disabled={imageUploadLoading}
                        onClick={() => fileInputRef.current?.click()}
                        className="w-full py-2 bg-dark-border hover:bg-neutral-800 disabled:opacity-50 text-neutral-300 hover:text-white rounded font-mono text-[10px] uppercase tracking-wider transition-colors duration-300 flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <Upload className="h-3.5 w-3.5" />
                        {imageUploadLoading ? 'Cargando imagen...' : 'Subir archivo de imagen'}
                      </button>

                      <div className="space-y-1">
                        <label className="font-mono text-[9px] text-neutral-400 uppercase tracking-widest flex items-center justify-between">
                          <span>URL de Portada (Cloudinary)</span>
                          {animeCoverUrlInput && (
                            <button
                              type="button"
                              onClick={() => {
                                setAnimeCoverUrlInput('');
                                if (/^https?:\/\//i.test(animeImage.trim())) {
                                  setAnimeImage('');
                                }
                              }}
                              className="text-[8.5px] text-neutral-500 hover:text-red-400 uppercase tracking-wider cursor-pointer"
                            >
                              Limpiar URL
                            </button>
                          )}
                        </label>
                        <div className="relative">
                          <LinkIcon className="h-3.5 w-3.5 text-neutral-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                          <input
                            type="url"
                            value={animeCoverUrlInput}
                            onChange={(e) => {
                              const raw = e.target.value;
                              setAnimeCoverUrlInput(raw);
                              const trimmed = raw.trim();
                              if (/^https?:\/\//i.test(trimmed)) {
                                setAnimeImage(trimmed);
                                setIsImageOptimized(false);
                              } else if (!trimmed && /^https?:\/\//i.test(animeImage.trim())) {
                                setAnimeImage('');
                              }
                            }}
                            placeholder="https://res.cloudinary.com/..."
                            className="w-full bg-[#050505] border border-dark-border focus:border-cyan-500/60 rounded py-2 pl-8 pr-2.5 text-xs font-mono text-white placeholder-neutral-700 outline-none transition-colors duration-300"
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Right block: Information fields */}
                  <div className="md:col-span-8 space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {/* Name */}
                      <div className="space-y-1">
                        <label className="font-mono text-[9px] text-neutral-400 uppercase tracking-widest block">
                          Nombre del Anime *
                        </label>
                        <input
                          type="text"
                          required
                          value={animeName}
                          onChange={(e) => setAnimeName(e.target.value)}
                          className="w-full bg-[#050505] border border-dark-border focus:border-brand-red/50 rounded p-2 text-sm text-white placeholder-neutral-800 outline-none transition-colors duration-300"
                        />
                      </div>

                      {/* Studio Autocomplete & Interactive Selector */}
                      <div className="space-y-1.5 relative">
                        <div className="flex justify-between items-center">
                          <label className="font-mono text-[9px] text-neutral-400 uppercase tracking-widest block">
                            Estudio(s)
                          </label>
                          <div className="flex items-center gap-2">
                            {animeStudioSearch && (
                              <button
                                type="button"
                                onClick={() => {
                                  setAnimeStudioSearch('');
                                  setAnimeStudioId('');
                                  updateLastUsedStudio('');
                                }}
                                className="font-mono text-[8.5px] uppercase tracking-wider text-neutral-500 hover:text-red-400 transition-colors cursor-pointer"
                                title="Borrar estudio seleccionado"
                              >
                                Limpiar
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setShowStudioPicker(!showStudioPicker)}
                              className="font-mono text-[8.5px] uppercase tracking-wider text-brand-red hover:text-white transition-colors flex items-center gap-1 cursor-pointer"
                            >
                              <Building2 className="h-3 w-3" />
                              {showStudioPicker ? 'Ocultar Lista' : `Ver Estudios (${studios.length})`}
                            </button>
                          </div>
                        </div>
                        <input
                          type="text"
                          list="studios-datalist"
                          value={animeStudioSearch}
                          onChange={(e) => {
                            const val = e.target.value;
                            setAnimeStudioSearch(val);
                            if (val.trim()) {
                              updateLastUsedStudio(val);
                            }
                          }}
                          className="w-full bg-[#050505] border border-dark-border focus:border-brand-red/50 rounded p-2.5 text-sm text-white placeholder-neutral-700 outline-none transition-colors duration-300"
                        />
                        <datalist id="studios-datalist">
                          {studios.map(s => (
                            <option key={s.id} value={s.name} />
                          ))}
                        </datalist>

                        {/* Interactive Studio Chips / Quick Picker */}
                        <div className="pt-1">
                          <span className="font-mono text-[8px] text-neutral-500 uppercase tracking-widest block mb-1">
                            Estudios Disponibles:
                          </span>
                          {studios.length === 0 ? (
                            <p className="font-mono text-[8px] text-neutral-600 uppercase">Aún no hay estudios creados.</p>
                          ) : (
                            <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto bg-black/20 p-2 rounded border border-dark-border/40">
                              {studios.map(studio => {
                                const isSelected = animeStudioSearch
                                  .split(',')
                                  .map(s => getNormalizedKey(s.trim()))
                                  .includes(getNormalizedKey(studio.name));
                                return (
                                  <button
                                    type="button"
                                    key={studio.id}
                                    onClick={() => handleToggleStudioInput(studio.name)}
                                    className={`px-2.5 py-1 rounded text-[10px] font-sans font-medium transition-all duration-300 flex items-center gap-1 cursor-pointer ${
                                      isSelected
                                        ? 'bg-brand-red text-white border border-transparent shadow-[0_2px_8px_rgba(255,51,51,0.2)] font-semibold'
                                        : 'bg-[#0f0f0f] text-neutral-400 hover:text-white border border-dark-border hover:border-neutral-700'
                                    }`}
                                  >
                                    {isSelected ? '✓' : '+'} {studio.name}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>

                    {/* Enlace de Telegram (oculto cuando se selecciona Próximamente) */}
                    {animeStatus !== 'Próximamente' && (
                      <div className="space-y-1">
                        <label className="font-mono text-[9px] text-neutral-400 uppercase tracking-widest block">
                          Enlace de Telegram
                        </label>
                        <input
                          type="text"
                          value={animeTelegramUrl}
                          onChange={(e) => setAnimeTelegramUrl(e.target.value)}
                          className="w-full bg-[#050505] border border-dark-border focus:border-brand-red/50 rounded p-2 text-sm text-white placeholder-neutral-800 outline-none transition-colors duration-300"
                        />
                      </div>
                    )}

                    {/* Sinopsis */}
                    <div className="space-y-1">
                      <label className="font-mono text-[9px] text-neutral-400 uppercase tracking-widest block">
                        Sinopsis
                      </label>
                      <textarea
                        rows={4}
                        value={animeDescription}
                        onChange={(e) => setAnimeDescription(e.target.value)}
                        className="w-full bg-[#050505] border border-dark-border focus:border-brand-red/50 rounded p-2 text-sm text-white placeholder-neutral-800 outline-none transition-colors duration-300"
                      />
                    </div>

                    {/* Year */}
                    <div className="space-y-1">
                      <label className="font-mono text-[9px] text-neutral-400 uppercase tracking-widest block">
                        Año
                      </label>
                      <input
                        type="text"
                        value={animeYear}
                        onChange={(e) => setAnimeYear(e.target.value)}
                        onBlur={() => setAnimeYear(prev => normalizeAnimeYear(prev))}
                        className="w-full bg-[#050505] border border-dark-border focus:border-brand-red/50 rounded p-2 text-sm text-white placeholder-neutral-800 outline-none transition-colors duration-300"
                      />
                    </div>

                    {/* Estado */}
                    <div className="space-y-1.5">
                      <label className="font-mono text-[9px] text-neutral-400 uppercase tracking-widest block">
                        Estado
                      </label>
                      <div className="grid grid-cols-3 gap-1.5 p-1 bg-[#050505] border border-dark-border rounded-xl">
                        {[
                          { id: 'Finalizado', label: 'Finalizado' },
                          { id: 'Emisión', label: 'Emisión' },
                          { id: 'Próximamente', label: 'Próximamente' }
                        ].map((st) => {
                          const isActive = animeStatus === st.id;
                          return (
                            <button
                              key={st.id}
                              type="button"
                              onClick={() => setAnimeStatus(st.id)}
                              className={`py-2 px-1 text-xs rounded-lg font-medium transition-all cursor-pointer text-center select-none ${
                                isActive
                                  ? st.id === 'Próximamente'
                                    ? 'bg-amber-500/20 border border-amber-500 text-amber-300 font-bold shadow-sm'
                                    : st.id === 'Emisión'
                                    ? 'bg-emerald-500/20 border border-emerald-500 text-emerald-300 font-bold shadow-sm'
                                    : 'bg-purple-600/30 border border-purple-500 text-white font-bold shadow-sm'
                                  : 'text-neutral-400 hover:text-white hover:bg-white/5 border border-transparent'
                              }`}
                            >
                              {st.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Si está en Próximamente: muestra la sección para escribir o elegir el Mes de Estreno. Si no: muestra Géneros */}
                  {animeStatus === 'Próximamente' ? (
                    <div className="space-y-2.5 p-3.5 bg-amber-500/5 border border-amber-500/30 rounded-xl">
                      <label className="font-mono text-[9.5px] text-amber-300 uppercase tracking-widest font-bold block">
                        Mes de Estreno (Próximamente)
                      </label>
                      <input
                        type="text"
                        value={animeReleaseMonth}
                        onChange={(e) => setAnimeReleaseMonth(e.target.value)}
                        className="w-full bg-[#050505] border border-amber-500/40 focus:border-amber-400 rounded-lg p-2.5 text-sm text-white placeholder-neutral-600 outline-none transition-colors duration-300"
                      />
                      <div className="space-y-1.5 pt-0.5">
                        <span className="font-mono text-[8px] text-neutral-400 uppercase tracking-widest block">
                          Selección rápida de mes:
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          {[
                            'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
                            'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
                          ].map((mes) => {
                            const isSelectedMonth = animeReleaseMonth.trim().toLowerCase() === mes.toLowerCase();
                            return (
                              <button
                                key={mes}
                                type="button"
                                onClick={() => setAnimeReleaseMonth(isSelectedMonth ? '' : mes)}
                                className={`px-2.5 py-1 rounded-lg text-[10px] font-sans font-medium transition-all duration-200 cursor-pointer ${
                                  isSelectedMonth
                                    ? 'bg-amber-500 text-black font-bold border border-amber-400 shadow-sm'
                                    : 'bg-[#0f0f0f] text-neutral-300 hover:text-white border border-dark-border hover:border-amber-500/50'
                                }`}
                              >
                                {mes}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <label className="font-mono text-[9px] text-neutral-400 uppercase tracking-widest block">
                        Géneros
                      </label>
                      
                      <input
                        type="text"
                        value={animeGenresInput}
                        onChange={(e) => setAnimeGenresInput(e.target.value)}
                        className="w-full bg-[#050505] border border-dark-border focus:border-brand-red/50 rounded p-2.5 text-sm text-white placeholder-neutral-700 outline-none transition-colors duration-300"
                      />

                      {/* Interactive suggestion pills */}
                      <div className="space-y-1.5 pt-1">
                        <span className="font-mono text-[8px] text-neutral-500 uppercase tracking-widest block">
                          Géneros Existentes:
                        </span>
                        {genres.length === 0 ? (
                          <p className="font-mono text-[8px] text-neutral-600 uppercase">Aún no hay géneros guardados. ¡Empieza a escribir arriba para crear los primeros!</p>
                        ) : (
                          <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto bg-black/20 p-2 rounded border border-dark-border/40">
                            {genres.map(g => {
                              const gKey = getNormalizedKey(g.name);
                              const isSelected = animeGenresInput
                                .split(',')
                                .map(s => getNormalizedKey(s))
                                .includes(gKey);
                              
                              return (
                                <button
                                  type="button"
                                  key={g.id}
                                  onClick={() => handleToggleGenreInput(g.name)}
                                  className={`px-2.5 py-1 rounded text-[10px] font-sans font-medium transition-all duration-300 flex items-center gap-1 cursor-pointer ${
                                    isSelected 
                                      ? 'bg-brand-red text-white border border-transparent shadow-[0_2px_8px_rgba(255,51,51,0.2)]' 
                                      : 'bg-[#0f0f0f] text-neutral-400 hover:text-white border border-dark-border hover:border-neutral-700'
                                  }`}
                                >
                                  {isSelected ? '✓' : '+'} {g.name}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                    {/* Apartado para agregar episodios (Al final, después de géneros) */}
                    {animeEpisodes.length === 0 ? (
                      <div className="pt-1 flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          onClick={handleAddEpisode}
                          className="px-3.5 py-2 bg-brand-red hover:bg-brand-red-hover border border-brand-red/60 text-white rounded-lg font-mono text-xs font-semibold tracking-wider transition-all duration-300 flex items-center justify-center gap-2 cursor-pointer shadow-md"
                        >
                          ➕ Agregar Episodio
                        </button>

                        <div className="flex items-center gap-2 bg-[#0a0a0a] border border-dark-border/80 px-2.5 py-1.5 rounded-lg">
                          <span className="font-mono text-[10px] text-neutral-400 uppercase tracking-wider">
                            ¿Mostrar en Episodios?
                          </span>
                          <button
                            type="button"
                            onClick={() => setSingleEpIsNew(prev => !prev)}
                            className={`h-[26px] px-2.5 rounded-md flex items-center gap-1.5 font-mono text-[10px] font-bold transition-all cursor-pointer select-none border ${
                              singleEpIsNew
                                ? 'bg-emerald-600 text-white border-emerald-500 shadow-sm shadow-emerald-600/30'
                                : 'bg-transparent text-neutral-500 border-neutral-800 hover:text-neutral-300'
                            }`}
                            title={singleEpIsNew ? "Marcado para mostrarse en la sección Episodios" : "Oculto en la sección Episodios"}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${singleEpIsNew ? 'bg-white animate-pulse' : 'bg-neutral-600'}`} />
                            <span>{singleEpIsNew ? 'Mostrar' : 'Oculto'}</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-1.5 p-2 sm:p-2.5 bg-[#080808] border border-dark-border/80 rounded-lg">
                        <div className="flex items-center justify-between pb-1">
                          <label className="font-mono text-[9.5px] text-neutral-300 uppercase tracking-widest font-bold flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-brand-red inline-block"></span>
                            Episodios ({animeEpisodes.length})
                          </label>

                          <button
                            type="button"
                            onClick={handleAddEpisode}
                            className="px-2.5 py-1 bg-brand-red hover:bg-brand-red-hover border border-brand-red/50 text-white rounded font-mono text-[10px] font-semibold uppercase tracking-wider transition-all duration-200 flex items-center gap-1 cursor-pointer shadow-sm shrink-0"
                          >
                            ➕ Agregar
                          </button>
                        </div>

                        {/* Cabecera ultra compacta: Nº mini + Enlace ancho completo + Miniatura */}
                        <div className="flex items-center gap-1.5 px-1 text-[8.5px] font-mono text-neutral-400 uppercase tracking-wider select-none">
                          <span className="w-6 text-center" title="Número de episodio">#</span>
                          <span className="flex-1">Enlace de video (.mp4)</span>
                          <span className="w-7 text-center" title="Miniatura">Min</span>
                        </div>

                        <div className="space-y-1.5 max-h-72 overflow-y-auto pr-0.5">
                          {animeEpisodes.map((ep, idx) => {
                            const isSwipedOpen = swipedEpisodeIdx === idx;
                            const activeDragOffset =
                              epSwipeTouchRef.current?.idx === idx ? swipedEpisodeOffset : (isSwipedOpen ? -84 : 0);

                            return (
                              <div
                                key={idx}
                                className="relative overflow-hidden rounded-md border border-dark-border/60 bg-[#050505] select-none"
                              >
                                {/* Menú lateral oculto a la derecha (se descubre al deslizar de derecha a izquierda) */}
                                <div className="absolute inset-y-0 right-0 w-[84px] flex items-center justify-end gap-1 px-1.5 bg-[#0d0718] border-l border-purple-500/25 z-0">
                                  {/* Botón: ON en verde cuando está activo, OFF cuando no está activo */}
                                  <button
                                    type="button"
                                    onClick={() => handleToggleEpisodeNew(idx)}
                                    className={`h-7 px-2 rounded flex-1 flex items-center justify-center gap-1 font-mono text-[10px] font-bold transition-all cursor-pointer select-none border ${
                                      ep.isNew
                                        ? 'bg-emerald-600 text-white border-emerald-400 shadow-sm shadow-emerald-600/30'
                                        : 'bg-[#140d24] text-neutral-400 border-neutral-800 hover:text-white hover:border-neutral-700'
                                    }`}
                                    title={ep.isNew ? 'ON: Activo en Episodios Nuevos (Toca para desactivar)' : 'OFF: Oculto en Episodios Nuevos (Toca para activar)'}
                                  >
                                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ep.isNew ? 'bg-white animate-pulse' : 'bg-neutral-600'}`} />
                                    <span>{ep.isNew ? 'ON' : 'OFF'}</span>
                                  </button>

                                  {/* Botón: Eliminar episodio */}
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveEpisode(idx)}
                                    className="h-7 w-7 shrink-0 flex items-center justify-center bg-red-950/60 hover:bg-brand-red text-red-300 hover:text-white border border-red-500/30 rounded transition-colors cursor-pointer"
                                    title="Eliminar este episodio"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>

                                {/* Fila frontal deslizable (de derecha a izquierda) */}
                                <div
                                  style={{
                                    transform: `translateX(${activeDragOffset}px)`,
                                    transition: epSwipeTouchRef.current?.idx === idx ? 'none' : 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)'
                                  }}
                                  onTouchStart={(e) => {
                                    const t = e.touches[0];
                                    if (!t) return;
                                    const base = swipedEpisodeIdx === idx ? -84 : 0;
                                    if (swipedEpisodeIdx !== null && swipedEpisodeIdx !== idx) {
                                      setSwipedEpisodeIdx(null);
                                    }
                                    epSwipeTouchRef.current = {
                                      idx,
                                      startX: t.clientX,
                                      startY: t.clientY,
                                      baseOffset: base,
                                      lockedAxis: null
                                    };
                                    setSwipedEpisodeOffset(base);
                                  }}
                                  onTouchMove={(e) => {
                                    const state = epSwipeTouchRef.current;
                                    if (!state || state.idx !== idx) return;
                                    const t = e.touches[0];
                                    if (!t) return;
                                    const dx = t.clientX - state.startX;
                                    const dy = t.clientY - state.startY;

                                    if (!state.lockedAxis) {
                                      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
                                      state.lockedAxis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
                                    }
                                    if (state.lockedAxis !== 'x') return;

                                    const nextOffset = Math.max(-84, Math.min(0, state.baseOffset + dx));
                                    setSwipedEpisodeOffset(nextOffset);
                                  }}
                                  onTouchEnd={() => {
                                    const state = epSwipeTouchRef.current;
                                    if (!state || state.idx !== idx) return;
                                    epSwipeTouchRef.current = null;
                                    if (swipedEpisodeOffset < -32) {
                                      setSwipedEpisodeIdx(idx);
                                      setSwipedEpisodeOffset(-84);
                                    } else {
                                      setSwipedEpisodeIdx(null);
                                      setSwipedEpisodeOffset(0);
                                    }
                                  }}
                                  className="relative z-10 flex items-center gap-1.5 bg-[#020202] p-1 transition-colors hover:bg-[#060606]"
                                >
                                  {/* Nº de Episodio ultra compacto (sin flechas spinner, ancho mínimo) con indicador verde si está en Nuevos */}
                                  <div className="relative w-6 shrink-0">
                                    <input
                                      type="number"
                                      min="1"
                                      max="9999"
                                      required
                                      value={ep.number}
                                      onChange={(e) => handleUpdateEpisodeNumber(idx, e.target.value)}
                                      className="w-full h-7 bg-[#100a1e] border border-purple-500/35 focus:border-emerald-500 rounded px-0 text-center text-[11px] text-purple-200 font-mono font-bold outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                      title={`Episodio #${ep.number}${ep.isNew ? ' (ON)' : ' (OFF)'}`}
                                    />
                                    {ep.isNew && (
                                      <span
                                        className="pointer-events-none absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-[#020202]"
                                        title="ON"
                                      />
                                    )}
                                  </div>

                                  {/* Input de enlace (.mp4): Máximo espacio horizontal posible */}
                                  <div className="flex-1 min-w-0">
                                    <input
                                      ref={(el) => { episodeInputRefs.current[idx] = el; }}
                                      type="url"
                                      required
                                      value={ep.mp4Url}
                                      onChange={(e) => handleEpisodeUrlChange(idx, e.target.value)}
                                      onFocus={() => {
                                        if (isSwipedOpen) {
                                          setSwipedEpisodeIdx(null);
                                          setSwipedEpisodeOffset(0);
                                        }
                                      }}
                                      onPaste={(e) => {
                                        const pasted = e.clipboardData.getData('text');
                                        if (pasted) {
                                          handleEpisodeUrlChange(idx, pasted);
                                        }
                                      }}
                                      style={{ direction: ep.mp4Url ? 'rtl' : 'ltr', textAlign: ep.mp4Url ? 'right' : 'left' }}
                                      className="w-full h-7 bg-[#0a0a0a] border border-dark-border focus:border-emerald-500 rounded px-2 text-xs text-white placeholder-neutral-700 outline-none truncate font-mono"
                                    />
                                  </div>

                                  {/* Cuadrito compacto de Miniatura al lado del enlace */}
                                  <label
                                    className={`h-7 w-7 shrink-0 flex items-center justify-center rounded cursor-pointer transition-all border group select-none ${
                                      (ep.thumbnail || ep.coverImage)
                                        ? 'bg-purple-950/50 border-purple-500/70 text-purple-300 hover:bg-purple-900/50 shadow-sm'
                                        : 'bg-[#0a0a0a] border-dark-border hover:border-purple-500/60 text-neutral-400 hover:text-white'
                                    }`}
                                    title={(ep.thumbnail || ep.coverImage) ? 'Miniatura lista (clic para cambiar, clic derecho para quitar)' : 'Agregar miniatura del episodio'}
                                    onContextMenu={(e) => {
                                      if (ep.thumbnail || ep.coverImage) {
                                        e.preventDefault();
                                        setAnimeEpisodes(prev => {
                                          const updated = [...prev];
                                          updated[idx] = { ...updated[idx], thumbnail: undefined, coverImage: undefined };
                                          return updated;
                                        });
                                        showNotification(`Miniatura removida del Episodio ${ep.number}`, 'success');
                                      }
                                    }}
                                  >
                                    <input
                                      type="file"
                                      accept="image/*"
                                      className="hidden"
                                      onChange={(e) => {
                                        const file = e.target.files?.[0];
                                        if (file) {
                                          handleEpisodeThumbnailUpload(idx, file);
                                          e.target.value = '';
                                        }
                                      }}
                                    />
                                    {(ep.thumbnail || ep.coverImage) ? (
                                      <img
                                        src={ep.thumbnail || ep.coverImage}
                                        alt="Miniatura"
                                        className="w-full h-full object-cover rounded"
                                      />
                                    ) : (
                                      <Plus className="h-3.5 w-3.5 text-neutral-400 group-hover:text-purple-300 transition-colors" />
                                    )}
                                  </label>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Continuación (Spin-off / Secuela / Secuelas) debajo de los episodios */}
                    <div className="space-y-3 pt-2 border-t border-[#2b1747]/60">
                      {/* Si ya hay animes agregados en Continuación, mostrar el título (Spin-off, Secuela o Secuelas) y debajo los animes pequeños con solo la portada y una pequeñita parte del nombre */}
                      {animeContinuationIds.length > 0 && (
                        <div className="space-y-2 bg-[#0d0718] border border-purple-500/30 rounded-2xl p-3">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-[10px] font-bold text-purple-300 uppercase tracking-widest">
                              {formatContinuationTitle(animeContinuationType, animeContinuationIds.length)}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setTempContinuationIds([...animeContinuationIds]);
                                setContinuationSearchQuery('');
                                setIsContinuationModalOpen(true);
                              }}
                              className="text-[10px] font-mono text-purple-400 hover:text-purple-200 underline cursor-pointer"
                            >
                              Editar lista
                            </button>
                          </div>

                          <div className="flex items-start gap-2 overflow-x-auto pb-1 scrollbar-none">
                            {sortAnimesByYearAsc(
                              animeContinuationIds
                                .map(id => animes.find(a => a.id === id))
                                .filter((a): a is Anime => Boolean(a))
                            ).map(linked => {
                              const sIds = (linked.studioIds && linked.studioIds.length > 0)
                                ? linked.studioIds
                                : (linked.studioId ? [linked.studioId] : []);
                              const stName = studios.find(s => sIds.includes(s.id))?.name || 'Estudio';
                              const linkedYear = normalizeAnimeYear(linked.year);

                              return (
                                <div
                                  key={linked.id}
                                  className="relative group w-[72px] sm:w-[80px] shrink-0 flex flex-col gap-1"
                                  title={`${linked.name}${linkedYear ? ` (${linkedYear})` : ''}`}
                                >
                                  <div className="relative aspect-[2/3] w-full rounded-xl overflow-hidden bg-[#120921] border border-purple-500/35 shadow-md">
                                    <SmartAnimeCover
                                      anime={linked}
                                      studioName={stName}
                                      alt={linked.name}
                                      tamaño="mini"
                                      loading="lazy"
                                      width={150}
                                      height={225}
                                      className="w-full h-full object-cover"
                                    />
                                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/45 to-transparent p-1 pt-3 pointer-events-none">
                                      <p className="font-display text-[9px] sm:text-[10px] text-white font-medium truncate leading-tight">
                                        {linked.name}
                                      </p>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setAnimeContinuationIds(prev => {
                                          const next = prev.filter(id => id !== linked.id);
                                          if (next.length === 0) setAnimeContinuationType('');
                                          return next;
                                        });
                                      }}
                                      className="absolute top-1 right-1 w-4 h-4 rounded-full bg-black/80 hover:bg-brand-red text-white flex items-center justify-center transition-colors cursor-pointer z-10"
                                      title="Quitar"
                                    >
                                      <X className="w-2.5 h-2.5" />
                                    </button>
                                  </div>
                                  {linkedYear && (
                                    <span className="font-mono text-[9px] sm:text-[9.5px] text-neutral-400 text-center w-full leading-none">
                                      {linkedYear}
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Botón Continuación y selector de Spin-off / Secuelas */}
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setShowContinuationOptions(prev => !prev)}
                          className="px-3.5 py-2 rounded-xl bg-[#190d2c] hover:bg-[#251342] border border-purple-500/45 text-purple-200 hover:text-white font-mono text-[11px] font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer active:scale-95 shadow-sm"
                        >
                          <Layers className="w-3.5 h-3.5 text-purple-400" />
                          <span>Continuación</span>
                        </button>

                        {showContinuationOptions && (
                          <div className="inline-flex items-center gap-1.5 animate-in fade-in duration-150">
                            <button
                              type="button"
                              onClick={() => {
                                setAnimeContinuationType('Spin-off');
                                setTempContinuationIds([...animeContinuationIds]);
                                setContinuationSearchQuery('');
                                setShowContinuationOptions(false);
                                setIsContinuationModalOpen(true);
                              }}
                              className={`px-3 py-1.5 rounded-xl font-mono text-[10px] font-bold uppercase tracking-wider border transition-all cursor-pointer active:scale-95 ${
                                animeContinuationType === 'Spin-off'
                                  ? 'bg-brand-red text-white border-brand-red shadow-md shadow-brand-red/25'
                                  : 'bg-[#120822] hover:bg-purple-900/50 text-purple-200 border-purple-500/40'
                              }`}
                            >
                              Spin-off
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setAnimeContinuationType('Secuelas');
                                setTempContinuationIds([...animeContinuationIds]);
                                setContinuationSearchQuery('');
                                setShowContinuationOptions(false);
                                setIsContinuationModalOpen(true);
                              }}
                              className={`px-3 py-1.5 rounded-xl font-mono text-[10px] font-bold uppercase tracking-wider border transition-all cursor-pointer active:scale-95 ${
                                animeContinuationType !== '' && animeContinuationType !== 'Spin-off'
                                  ? 'bg-purple-600 text-white border-purple-400 shadow-md shadow-purple-600/25'
                                  : 'bg-[#120822] hover:bg-purple-900/50 text-purple-200 border-purple-500/40'
                              }`}
                            >
                              Secuelas
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Modal Flotante para buscar y agregar animes a Spin-off / Secuela(s) */}
                    <AnimatePresence>
                      {isContinuationModalOpen && (
                        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
                          <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            onClick={() => setIsContinuationModalOpen(false)}
                            className="fixed inset-0 bg-black/85 backdrop-blur-md cursor-pointer"
                          />

                          <motion.div
                            initial={{ opacity: 0, scale: 0.95, y: 10 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 10 }}
                            transition={{ duration: 0.18 }}
                            className="relative z-10 w-full max-w-md bg-[#0e071a] border border-purple-500/40 rounded-3xl p-4 sm:p-5 shadow-2xl flex flex-col gap-3.5 max-h-[86vh] text-white"
                          >
                            {/* Encabezado del Modal */}
                            <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2.5">
                              <div className="flex items-center gap-2">
                                <Layers className="w-4 h-4 text-purple-400 shrink-0" />
                                <h4 className="font-display font-bold text-sm sm:text-base text-white">
                                  Elegir animes ({formatContinuationTitle(animeContinuationType, tempContinuationIds.length)})
                                </h4>
                              </div>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setAnimeContinuationType(prev =>
                                      prev === 'Spin-off' ? 'Secuelas' : 'Spin-off'
                                    )
                                  }
                                  className="px-2 py-1 rounded-lg bg-purple-900/40 hover:bg-purple-800/60 border border-purple-500/35 text-[9px] font-mono text-purple-200 uppercase tracking-wider cursor-pointer"
                                  title="Cambiar entre Spin-off y Secuelas"
                                >
                                  {animeContinuationType === 'Spin-off' ? 'Cambiar a Secuelas' : 'Cambiar a Spin-off'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setIsContinuationModalOpen(false)}
                                  className="p-1 text-neutral-400 hover:text-white rounded-full hover:bg-white/10 transition-colors cursor-pointer"
                                >
                                  <X className="w-4 h-4" />
                                </button>
                              </div>
                            </div>

                            {/* Barra de búsqueda flexible (idéntica a la de la página principal) */}
                            <div className="relative bg-[#090412] border border-[#2b1747] focus-within:border-purple-500 rounded-2xl px-3 py-2 flex items-center gap-2 shadow-inner">
                              <Search className="w-4 h-4 text-purple-400 shrink-0" />
                              <input
                                type="text"
                                value={continuationSearchQuery}
                                onChange={(e) => setContinuationSearchQuery(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') e.preventDefault();
                                }}
                                placeholder="Buscar anime por nombre, estudio o año..."
                                className="w-full bg-transparent text-xs sm:text-sm text-white placeholder-neutral-500 outline-none font-sans"
                              />
                              {continuationSearchQuery && (
                                <button
                                  type="button"
                                  onClick={() => setContinuationSearchQuery('')}
                                  className="text-neutral-400 hover:text-white cursor-pointer"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>

                            {/* Lista de animes (nombres parecidos por defecto o resultados de búsqueda flexible) */}
                            {(() => {
                              const currentEditId = editingAnime?.id || '';
                              const candidates = animes.filter(a => a.id !== currentEditId);
                              const stMap = new Map<string, string>(studios.map(s => [s.id, s.name]));
                              const gnMap = new Map<string, string>(genres.map(g => [g.id, g.name]));
                              const normMap = new Map(
                                candidates.map(item => [
                                  item.id,
                                  buildNormalizedAnimeData(item, stMap, gnMap)
                                ])
                              );

                              const rawSearch = continuationSearchQuery.trim();
                              const searchNorm = normalizeSearchText(rawSearch);
                              const searchNormNoSpaces = searchNorm.replace(/\s+/g, '');
                              const searchWords = searchNorm ? searchNorm.split(' ').filter(Boolean) : [];

                              const baseTitleNorm = normalizeSearchText(animeName.trim());
                              const baseTitleNormNoSpaces = baseTitleNorm.replace(/\s+/g, '');
                              const stopWords = new Set(['no', 'the', 'ni', 'wa', 'to', 'de', 'in', 'of', 'on', 'ova', 'animation']);
                              const baseTokens = baseTitleNorm
                                ? baseTitleNorm.split(' ').filter(w => w.length >= 2 && !stopWords.has(w))
                                : [];

                              let displayedList: Anime[] = [];
                              let isShowingSimilarLabel = false;

                              if (searchWords.length > 0) {
                                const matched = candidates
                                  .filter(item => {
                                    const nd = normMap.get(item.id);
                                    return nd ? matchesFuzzySearch(searchNorm, searchNormNoSpaces, searchWords, nd) : false;
                                  })
                                  .map(item => {
                                    const nd = normMap.get(item.id)!;
                                    return {
                                      anime: item,
                                      score: calculateRelevanceScore(searchNorm, searchNormNoSpaces, searchWords, nd)
                                    };
                                  })
                                  .sort((a, b) => b.score - a.score);
                                displayedList = matched.map(m => m.anime);
                              } else {
                                // Nombres parecidos al anime actual + seleccionados arriba
                                const scoredSimilar: { anime: Anime; score: number }[] = [];
                                const others: Anime[] = [];

                                for (const item of candidates) {
                                  const nd = normMap.get(item.id);
                                  const itemNorm = nd?.normTitle || normalizeSearchText(item.name);
                                  let simScore = 0;

                                  if (baseTitleNorm && itemNorm) {
                                    if (itemNorm.includes(baseTitleNorm) || baseTitleNorm.includes(itemNorm)) {
                                      simScore += 600;
                                    }
                                    if (baseTokens.length > 0 && itemNorm.startsWith(baseTokens[0])) {
                                      simScore += 450;
                                    }
                                    let sharedCount = 0;
                                    for (const tk of baseTokens) {
                                      if (tk.length >= 3 && itemNorm.includes(tk)) {
                                        sharedCount++;
                                        simScore += 180;
                                      }
                                    }
                                    if (nd && sharedCount > 0) {
                                      simScore += calculateRelevanceScore(baseTitleNorm, baseTitleNormNoSpaces, baseTokens, nd) * 0.25;
                                    }
                                  }

                                  if (tempContinuationIds.includes(item.id)) {
                                    simScore += 2000;
                                  }

                                  if (simScore > 0) {
                                    scoredSimilar.push({ anime: item, score: simScore });
                                  } else {
                                    others.push(item);
                                  }
                                }

                                scoredSimilar.sort((a, b) => b.score - a.score);
                                isShowingSimilarLabel = scoredSimilar.length > 0 && Boolean(baseTitleNorm);
                                displayedList = [
                                  ...scoredSimilar.map(s => s.anime),
                                  ...others.slice(0, 25)
                                ];
                              }

                              return (
                                <div className="flex-1 overflow-y-auto space-y-2 pr-1 max-h-[48vh] scrollbar-thin scrollbar-thumb-purple-900/60">
                                  <div className="flex items-center justify-between px-1">
                                    <span className="font-mono text-[10px] text-neutral-400 uppercase tracking-widest">
                                      {searchWords.length > 0
                                        ? `Resultados (${displayedList.length})`
                                        : isShowingSimilarLabel
                                        ? 'Animes con nombres parecidos'
                                        : 'Sugerencias del catálogo'}
                                    </span>
                                    {tempContinuationIds.length > 0 && (
                                      <span className="font-mono text-[10px] text-purple-300 font-bold">
                                        {tempContinuationIds.length} seleccionado{tempContinuationIds.length === 1 ? '' : 's'}
                                      </span>
                                    )}
                                  </div>

                                  {displayedList.length === 0 ? (
                                    <div className="py-8 text-center text-xs font-mono text-neutral-500">
                                      No se encontraron animes con ese nombre.
                                    </div>
                                  ) : (
                                    displayedList.slice(0, 40).map((item) => {
                                      const isAdded = tempContinuationIds.includes(item.id);
                                      const sIds = (item.studioIds && item.studioIds.length > 0)
                                        ? item.studioIds
                                        : (item.studioId ? [item.studioId] : []);
                                      const stName = studios.find(s => sIds.includes(s.id))?.name || 'Estudio';
                                      const yr = normalizeAnimeYear(item.year);

                                      return (
                                        <div
                                          key={item.id}
                                          className={`flex items-center justify-between gap-2.5 p-2 rounded-2xl border transition-all ${
                                            isAdded
                                              ? 'bg-purple-950/45 border-purple-500/60'
                                              : 'bg-[#140b24]/90 border-white/10 hover:border-purple-500/40'
                                          }`}
                                        >
                                          {/* Vista previa pequeña de la portada + nombre y año */}
                                          <div className="flex items-center gap-2.5 min-w-0 flex-1">
                                            <div className="w-11 aspect-[2/3] rounded-lg overflow-hidden bg-neutral-900 border border-white/10 shrink-0 shadow-sm">
                                              <SmartAnimeCover
                                                anime={item}
                                                studioName={stName}
                                                alt={item.name}
                                                tamaño="mini"
                                                loading="lazy"
                                                width={150}
                                                height={225}
                                                className="w-full h-full object-cover"
                                              />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                              <p className="font-display font-bold text-xs sm:text-sm text-white truncate">
                                                {item.name}
                                              </p>
                                              <div className="flex items-center gap-1.5 text-[10px] font-mono text-neutral-400 mt-0.5">
                                                <span className="text-purple-300 truncate max-w-[120px]">{stName}</span>
                                                {yr && (
                                                  <>
                                                    <span>•</span>
                                                    <span>{yr}</span>
                                                  </>
                                                )}
                                              </div>
                                            </div>
                                          </div>

                                          {/* Botón Agregar / Quitar al lado */}
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setTempContinuationIds(prev =>
                                                prev.includes(item.id)
                                                  ? prev.filter(id => id !== item.id)
                                                  : [...prev, item.id]
                                              );
                                            }}
                                            className={`px-3 py-1.5 rounded-xl font-mono text-[10px] font-bold uppercase tracking-wider shrink-0 transition-all cursor-pointer active:scale-95 flex items-center gap-1 ${
                                              isAdded
                                                ? 'bg-emerald-600/90 hover:bg-red-600 text-white border border-emerald-400/50'
                                                : 'bg-purple-600 hover:bg-purple-500 text-white border border-purple-400/40 shadow-sm'
                                            }`}
                                          >
                                            {isAdded ? (
                                              <>
                                                <Check className="w-3 h-3" />
                                                <span>Agregado</span>
                                              </>
                                            ) : (
                                              <>
                                                <Plus className="w-3 h-3" />
                                                <span>Agregar</span>
                                              </>
                                            )}
                                          </button>
                                        </div>
                                      );
                                    })
                                  )}
                                </div>
                              );
                            })()}

                            {/* Pie del Modal con botón Aceptar */}
                            <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/10">
                              <button
                                type="button"
                                onClick={() => setIsContinuationModalOpen(false)}
                                className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-neutral-300 font-mono text-[11px] uppercase tracking-wider cursor-pointer"
                              >
                                Cancelar
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setAnimeContinuationIds(tempContinuationIds);
                                  if (tempContinuationIds.length > 0 && !animeContinuationType) {
                                    setAnimeContinuationType('Secuelas');
                                  }
                                  setIsContinuationModalOpen(false);
                                }}
                                className="px-5 py-2 rounded-xl bg-gradient-to-r from-purple-600 to-brand-red hover:from-purple-500 hover:to-brand-red text-white font-mono text-[11px] font-bold uppercase tracking-wider shadow-lg cursor-pointer active:scale-95"
                              >
                                Aceptar
                              </button>
                            </div>
                          </motion.div>
                        </div>
                      )}
                    </AnimatePresence>

                    {/* Hide toggle */}
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="chk_hidden"
                        checked={animeHidden}
                        onChange={(e) => setAnimeHidden(e.target.checked)}
                        className="rounded border-dark-border bg-black text-brand-red focus:ring-brand-red"
                      />
                      <label htmlFor="chk_hidden" className="font-mono text-[10px] text-neutral-400 uppercase tracking-widest cursor-pointer select-none">
                        Ocultar temporalmente (borrador)
                      </label>
                    </div>

                    {/* Submit and Cancel buttons */}
                    <div className="pt-4 flex flex-wrap items-center justify-between gap-3 border-t border-dark-border/40">
                      <div className="flex items-center gap-3">
                        <button
                          type="submit"
                          disabled={imageUploadLoading || isSavingAnime}
                          className="px-6 py-2 bg-brand-red hover:bg-brand-red-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded font-display font-medium text-xs tracking-widest uppercase transition-all duration-300 flex items-center gap-1.5 cursor-pointer"
                        >
                          {(imageUploadLoading || isSavingAnime) ? (
                            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          ) : (
                            <Save className="h-4 w-4" />
                          )}
                          {(imageUploadLoading || isSavingAnime)
                            ? `Guardando (${liveProgress?.percent ?? 50}%)...`
                            : (editingAnime ? 'Actualizar Anime' : 'Guardar Anime')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setIsAnimeFormOpen(false)}
                          className="px-6 py-2 bg-[#111] hover:bg-neutral-800 text-neutral-400 hover:text-white rounded font-mono text-xs uppercase tracking-wider transition-colors duration-300"
                        >
                          Cancelar
                        </button>
                      </div>

                      {editingAnime && (
                        <button
                          type="button"
                          onClick={() => {
                            handleDeleteAnime(editingAnime.id);
                            setIsAnimeFormOpen(false);
                          }}
                          className="px-4 py-2 border border-brand-red/30 hover:border-brand-red bg-brand-red/5 hover:bg-brand-red/10 text-brand-red hover:text-white rounded font-mono text-xs uppercase tracking-wider transition-all duration-300 flex items-center gap-1.5"
                          title="Eliminar este anime permanentemente"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Eliminar Anime
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </form>
            )}

            {/* Search Bar for Admin Animes List - Clean rounded input without outer bubble */}
            {animes.length > 0 && (
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 px-1 py-0.5">
                <div className="relative flex-1 max-w-lg">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400 pointer-events-none" />
                  <input
                    type="text"
                    value={animeAdminSearch}
                    onChange={(e) => setAnimeAdminSearch(e.target.value)}
                    placeholder="Buscar portada por nombre, estudio, género, año..."
                    className="w-full bg-[#08080a] border border-dark-border/80 focus:border-brand-red/60 rounded-full py-2.5 sm:py-3 pl-11 pr-10 text-xs sm:text-sm text-white placeholder-neutral-500 outline-none transition-all duration-300 shadow-inner"
                  />
                  {animeAdminSearch && (
                    <button
                      onClick={() => setAnimeAdminSearch('')}
                      className="absolute right-4 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white text-xs font-mono cursor-pointer"
                      title="Limpiar búsqueda"
                    >
                      ✕
                    </button>
                  )}
                </div>
                <div className="font-mono text-[11px] text-neutral-400 uppercase tracking-widest text-right pr-2">
                  <span className="text-white font-bold">
                    {adminFilteredAnimes.length}
                  </span>{' '}
                  de {animes.length}
                </div>
              </div>
            )}

            {/* Anime List Grid Table */}
            <div id="admin-animes-table-container" className="bg-dark-card border border-dark-border rounded-xl overflow-hidden">
              {animes.length === 0 ? (
                <div className="p-8 text-center text-neutral-500 font-mono text-xs">
                  No hay animes registrados en el archivo. ¡Crea el primero!
                </div>
              ) : (() => {
                // Latest added anime ID (last element in the original list)
                const latestAnimeId = animes.length > 0 ? animes[animes.length - 1].id : null;
                const filteredAnimes = adminFilteredAnimes;

                if (filteredAnimes.length === 0) {
                  return (
                    <div className="p-8 text-center space-y-2">
                      <p className="text-neutral-400 font-mono text-xs">
                        No se encontraron portadas que coincidan con "<span className="text-white">{animeAdminSearch}</span>"
                      </p>
                      <button
                        onClick={() => setAnimeAdminSearch('')}
                        className="text-brand-red hover:underline font-mono text-[10px] uppercase tracking-wider"
                      >
                        Limpiar búsqueda
                      </button>
                    </div>
                  );
                }

                return (
                  <>
                    {/* Anime List - Exact layout and colors matching Screenshot 1 */}
                    <div className="divide-y divide-[#1b0d30] border border-[#1b0d30] rounded-xl overflow-hidden bg-[#0a0414]">
                      {paginatedAdminAnimes.map(({ anime }) => {
                        const sIds = (anime.studioIds && anime.studioIds.length > 0)
                          ? anime.studioIds
                          : (anime.studioId ? [anime.studioId] : []);
                        const sNames = sIds.map(id => studioMapForAdmin.get(id)).filter(Boolean);
                        const sName = sNames.length > 0 ? sNames.join(', ') : 'Sin estudio';
                        const isEmision = anime.status === 'Próximamente' || anime.status?.toLowerCase().includes('emisión') || anime.status?.toLowerCase().includes('emision');

                        return (
                          <div 
                            key={anime.id} 
                            className="p-2.5 sm:p-3 hover:bg-[#120722] transition-colors flex items-center justify-between gap-2.5 sm:gap-3 bg-[#0a0414]"
                          >
                            {/* 1. Left Thumbnail: Touching photo opens edit mode */}
                            <button
                              type="button"
                              onClick={() => openEditAnimeForm(anime)}
                              className="relative shrink-0 w-11 h-15 sm:w-12 sm:h-16 rounded-md overflow-hidden border border-[#2b174d] hover:border-purple-500 shadow-md group cursor-pointer active:scale-95 transition-all text-left"
                              title="Tocar foto para editar anime"
                            >
                              <SmartAnimeCover anime={anime} studioName={sName} tamaño="mini" loading="lazy" width={150} height={225} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                              <div className="absolute inset-0 bg-black/0 group-hover:bg-purple-900/40 flex items-center justify-center transition-colors">
                                <Edit2 className="h-3.5 w-3.5 text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow" />
                              </div>
                            </button>

                            {/* 2. Center: Anime Info */}
                            <div className="flex-1 min-w-0 pr-1">
                                {/* Title */}
                                <h4 className="font-semibold text-white text-xs sm:text-sm truncate leading-tight">
                                  {anime.name}
                                </h4>

                                {/* Year */}
                                {anime.year && (
                                  <div className="flex items-center gap-1.5 mt-0.5">
                                    <span className="text-[11px] sm:text-xs text-neutral-400 font-mono">
                                      ({anime.year})
                                    </span>
                                  </div>
                                )}

                                {/* Studio Name in Violet */}
                                <div className="font-mono text-xs font-bold text-[#c084fc] uppercase tracking-wider mt-0.5 truncate">
                                  {sName}
                                </div>

                                {/* Telegram URL */}
                                {anime.telegramUrl && (
                                  <div className="text-[10px] sm:text-[11px] font-mono text-purple-300/40 truncate mt-0.5">
                                    {anime.telegramUrl}
                                  </div>
                                )}
                              </div>

                            {/* 3. Right: Action Buttons in single horizontal row */}
                            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                              {/* Info Button (i) */}
                              <button
                                type="button"
                                onClick={() => setSelectedAnimeDetails(anime)}
                                className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-[#180d2c] hover:bg-[#251342] border border-[#2e1550] text-purple-300 hover:text-white flex items-center justify-center cursor-pointer transition-colors active:scale-95"
                                title="Ver información"
                              >
                                <Info className="h-3.5 w-3.5" />
                              </button>

                              {/* + EP Button */}
                              <button
                                type="button"
                                onClick={() => handleOpenQuickAddEpModal(anime.id)}
                                className="h-7 sm:h-8 px-2 sm:px-2.5 rounded-lg bg-[#4c1d95] hover:bg-[#581c87] border border-purple-500/50 text-white font-mono text-[10px] sm:text-[11px] font-bold uppercase tracking-wider flex items-center gap-1 cursor-pointer transition-colors active:scale-95 shadow-sm"
                                title="Agregar episodio"
                              >
                                <span>+ EP</span>
                              </button>

                              {/* Delete Button */}
                              <button
                                type="button"
                                onClick={() => handleDeleteAnime(anime.id)}
                                className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-[#180d2c] hover:bg-red-950/60 border border-[#2e1550] hover:border-red-500/50 text-purple-300 hover:text-red-400 flex items-center justify-center cursor-pointer transition-colors active:scale-95"
                                title="Eliminar anime"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                  {totalAdminAnimePages > 1 && (() => {
                    const getSmartAdminPages = (current: number, total: number) => {
                      if (total <= 5) {
                        return Array.from({ length: total }, (_, i) => i + 1);
                      }
                      const pages = new Set<number>();
                      let minNearby = current - 2;
                      let maxNearby = current + 2;
                      if (current <= 2) {
                        minNearby = 1;
                        maxNearby = Math.min(total, 4);
                      } else if (current >= total - 1) {
                        minNearby = Math.max(1, total - 3);
                        maxNearby = total;
                      }
                      for (let i = Math.max(1, minNearby); i <= Math.min(total, maxNearby); i++) {
                        pages.add(i);
                      }
                      const lowestNearby = Math.min(...Array.from(pages));
                      const highestNearby = Math.max(...Array.from(pages));
                      if (lowestNearby > 1) {
                        let jumpBack = current - 6;
                        if (jumpBack < 1 || lowestNearby - jumpBack <= 2) {
                          jumpBack = 1;
                        }
                        pages.add(jumpBack);
                      }
                      if (highestNearby < total) {
                        let jumpForward = current + 6;
                        if (jumpForward > total || jumpForward - highestNearby <= 2) {
                          jumpForward = total;
                        }
                        pages.add(jumpForward);
                      }
                      return Array.from(pages).sort((a, b) => a - b);
                    };

                    const handleAdminPageChange = (newPage: number) => {
                      if (newPage < 1 || newPage > totalAdminAnimePages || newPage === adminAnimePage) return;
                      setAdminAnimePage(newPage);
                      const container = document.getElementById('admin-animes-table-container');
                      if (container) {
                        container.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }
                    };

                    const pageNumbers = getSmartAdminPages(adminAnimePage, totalAdminAnimePages);

                    return (
                      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-4 border-t border-dark-border/80 bg-black/40 font-mono text-xs text-neutral-400">
                        <div className="text-[11px] text-neutral-400">
                          Mostrando <span className="text-white font-semibold">{(adminAnimePage - 1) * adminItemsPerPage + 1}</span> - <span className="text-white font-semibold">{Math.min(adminAnimePage * adminItemsPerPage, adminFilteredAnimes.length)}</span> de <span className="text-white font-semibold">{adminFilteredAnimes.length}</span>
                        </div>
                        <div className="flex items-center gap-1 sm:gap-2 overflow-x-auto scrollbar-none py-1 max-w-full justify-center">
                          {/* Previous Page */}
                          <button
                            type="button"
                            onClick={() => handleAdminPageChange(adminAnimePage - 1)}
                            disabled={adminAnimePage === 1}
                            aria-label="Página anterior"
                            className="p-2 shrink-0 text-white hover:text-[#ff5588] active:scale-95 disabled:opacity-20 disabled:hover:text-white disabled:cursor-not-allowed transition-colors cursor-pointer select-none"
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </button>

                          {/* Page Numbers */}
                          {pageNumbers.map((pNum) => {
                            const isActive = pNum === adminAnimePage;
                            return (
                              <button
                                key={pNum}
                                type="button"
                                onClick={() => handleAdminPageChange(pNum)}
                                className={`px-2.5 sm:px-3 py-1 shrink-0 font-mono text-xs sm:text-sm tracking-wider transition-all duration-150 cursor-pointer select-none rounded ${
                                  isActive
                                    ? 'text-[#ff5588] font-extrabold scale-110'
                                    : 'text-white font-bold hover:text-[#ff5588] active:scale-95'
                                }`}
                              >
                                {pNum}
                              </button>
                            );
                          })}

                          {/* Next Page */}
                          <button
                            type="button"
                            onClick={() => handleAdminPageChange(adminAnimePage + 1)}
                            disabled={adminAnimePage >= totalAdminAnimePages}
                            aria-label="Página siguiente"
                            className="p-2 shrink-0 text-white hover:text-[#ff5588] active:scale-95 disabled:opacity-20 disabled:hover:text-white disabled:cursor-not-allowed transition-colors cursor-pointer select-none"
                          >
                            <ChevronRight className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })()}
                </>
              );
              })()}
            </div>
          </div>
        )}

        {/* --- EPISODES TAB (Gestión avanzada de episodios y portadas) --- */}
        {activeTab === 'episodes' && (
          <AdminEpisodeManager
            animes={animes}
            studios={studios}
            onRefresh={onRefresh}
            showNotification={showNotification}
          />
        )}

        {/* --- STUDIOS TAB --- */}
        {activeTab === 'studios' && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {/* Left Studio Creator Form */}
            <div className="bg-dark-card border border-dark-border rounded-lg p-6 h-fit space-y-4">
              <h2 className="font-display font-semibold text-base tracking-widest text-brand-red uppercase">
                {editingStudio ? 'EDITAR ESTUDIO' : 'CREAR ESTUDIO'}
              </h2>
              
              <form onSubmit={handleSaveStudio} className="space-y-4">
                {studioError && (
                  <div className="p-2 bg-brand-red/10 border border-brand-red/30 rounded text-xs text-brand-red font-mono">
                    {studioError}
                  </div>
                )}

                {/* Portada del Estudio */}
                <div className="space-y-1">
                  <label className="font-mono text-[9px] text-neutral-400 uppercase tracking-widest block">
                    Portada / Logo del Estudio
                  </label>
                  <div
                    onClick={() => studioFileInputRef.current?.click()}
                    className="aspect-video w-full rounded border border-dark-border hover:border-brand-red/40 bg-black/40 cursor-pointer group flex flex-col items-center justify-center p-2 overflow-hidden relative transition-all"
                  >
                    {studioImage ? (
                      <>
                        <img src={studioImage} alt="Portada del Estudio" className="absolute inset-0 w-full h-full object-cover" />
                        <CoverPreviewSizeBadge src={studioImage} />
                        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-1">
                          <Upload className="h-5 w-5 text-white" />
                          <span className="font-mono text-[9px] text-white uppercase">Cambiar portada</span>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setStudioImage('');
                          }}
                          className="absolute bottom-1.5 right-1.5 px-2 py-0.5 bg-black/80 hover:bg-brand-red text-white text-[9px] font-mono rounded z-10"
                        >
                          Eliminar
                        </button>
                      </>
                    ) : (
                      <div className="text-center space-y-1">
                        <Upload className="h-6 w-6 text-neutral-600 mx-auto group-hover:text-neutral-400 transition-colors" />
                        <p className="font-sans text-[10px] text-neutral-400">Toca para subir portada del estudio</p>
                        <span className="font-mono text-[8px] text-neutral-600 block uppercase">PNG, JPG o WEBP</span>
                      </div>
                    )}
                  </div>
                  <input
                    type="file"
                    accept="image/*"
                    ref={studioFileInputRef}
                    onChange={handleStudioFileChange}
                    className="hidden"
                  />
                </div>
                
                <div className="space-y-1">
                  <label className="font-mono text-[9px] text-neutral-400 uppercase tracking-widest block">
                    Nombre del Estudio *
                  </label>
                  <input
                    type="text"
                    required
                    value={studioName}
                    onChange={(e) => setStudioName(e.target.value)}
                    className="w-full bg-[#050505] border border-dark-border focus:border-brand-red/50 rounded p-2 text-sm text-white placeholder-neutral-800 outline-none transition-colors duration-300"
                  />
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    type="submit"
                    disabled={isSavingStudio}
                    className="flex-grow py-2 bg-brand-red hover:bg-brand-red-hover disabled:opacity-50 text-white rounded font-display font-medium text-xs tracking-widest uppercase transition-all duration-300 flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    {isSavingStudio ? (
                      <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                    {isSavingStudio
                      ? `${editingStudio ? 'Actualizando' : 'Creando'} (${liveProgress?.percent ?? 50}%)...`
                      : (editingStudio ? 'Actualizar' : 'Crear')}
                  </button>
                  {editingStudio && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingStudio(null);
                        setStudioName('');
                        setStudioImage('');
                      }}
                      className="px-3 py-2 bg-neutral-800 text-neutral-400 hover:text-white rounded text-xs transition-colors duration-300 cursor-pointer"
                    >
                      Cancelar
                    </button>
                  )}
                </div>
              </form>
            </div>

            {/* Right Studios Table List */}
            <div className="md:col-span-2 bg-dark-card border border-dark-border rounded-lg p-6">
              <div className="flex items-center justify-between mb-4 gap-2">
                <h2 className="font-display font-semibold text-base tracking-wide">Estudios Existentes ({studios.length})</h2>
                <button
                  onClick={handleDeduplicate}
                  disabled={isDeduplicating}
                  className="px-3 py-1.5 bg-brand-red/10 border border-brand-red/30 hover:border-brand-red text-brand-red hover:text-white rounded text-xs font-mono transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  title="Unifica automáticamente estudios repetidos o con variaciones de nombre"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  {isDeduplicating ? 'Unificando...' : 'Unificar Duplicados'}
                </button>
              </div>
              
              {studios.length === 0 ? (
                <p className="font-mono text-xs text-neutral-500">No hay estudios creados.</p>
              ) : (
                <div className="space-y-2">
                  {studios.map(studio => {
                    const count = studioAnimeCounts.get(studio.id) || 0;
                    const fallbackAnime = animes.find(a => (a.studioIds?.includes(studio.id) || a.studioId === studio.id));

                    return (
                      <div
                        key={studio.id}
                        className="flex items-center justify-between p-3 bg-black/40 border border-dark-border/60 hover:border-dark-border rounded-lg transition-all duration-300 gap-3"
                      >
                        {/* Foto de la portada a la izquierda y la información a la derecha */}
                        <div className="flex items-center gap-3.5 min-w-0">
                          {/* Portada a la izquierda */}
                          <button
                            type="button"
                            onClick={() => {
                              setEditingStudio(studio);
                              setStudioName(studio.name);
                              setStudioImage(studio.image || '');
                              window.scrollTo({ top: 0, behavior: 'smooth' });
                            }}
                            title="Tocar foto para editar estudio"
                            className="w-14 h-14 sm:w-16 sm:h-16 rounded-lg bg-black/60 overflow-hidden shrink-0 flex items-center justify-center relative shadow-sm group cursor-pointer active:scale-95 transition-all"
                          >
                            {studio.image ? (
                              <img
                                src={portadaUrl(studio.image, 'mini')}
                                alt={studio.name}
                                loading="lazy"
                                decoding="async"
                                width={150}
                                height={150}
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                              />
                            ) : fallbackAnime ? (
                              <SmartAnimeCover
                                anime={fallbackAnime}
                                studioName={studio.name}
                                alt={studio.name}
                                tamaño="mini"
                                loading="lazy"
                                width={150}
                                height={150}
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                              />
                            ) : (
                              <div className="w-full h-full flex flex-col items-center justify-center p-1 text-center bg-purple-950/30">
                                <Building2 className="h-5 w-5 text-purple-400" />
                                <span className="text-[7.5px] font-mono text-purple-300 font-bold truncate max-w-full">{studio.name.slice(0, 4)}</span>
                              </div>
                            )}
                          </button>

                          {/* Información a la derecha */}
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-display text-sm font-semibold text-white truncate">{studio.name}</span>
                              <span className="px-2 py-0.5 bg-brand-red/10 border border-brand-red/20 text-brand-red text-[10px] font-mono rounded-full shrink-0">
                                {count} {count === 1 ? 'portada' : 'portadas'}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                              <span className="font-mono text-[9px] text-neutral-500">ID: {studio.id}</span>
                              <span className="text-neutral-700 text-[9px]">•</span>
                              <span className="font-mono text-[9px] text-emerald-400 flex items-center gap-1">
                                <Globe className="h-2.5 w-2.5" />
                                {studio.storageLocation || 'Firebase Firestore'}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => {
                              setEditingStudio(studio);
                              setStudioName(studio.name);
                              setStudioImage(studio.image || '');
                              window.scrollTo({ top: 0, behavior: 'smooth' });
                            }}
                            className="p-1.5 text-neutral-400 hover:text-white hover:bg-white/10 rounded transition-colors duration-200 cursor-pointer"
                            title="Editar Estudio"
                          >
                            <Edit2 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => handleDeleteStudio(studio.id)}
                            className="p-1.5 rounded border border-brand-red/20 hover:border-brand-red/60 bg-brand-red/5 text-brand-red hover:bg-brand-red hover:text-white transition-all duration-200 cursor-pointer"
                            title="Eliminar Estudio"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}


        {/* --- GENRES TAB --- */}
        {activeTab === 'genres' && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {/* Left Genre Creator Form */}
            <div className="bg-dark-card border border-dark-border rounded-lg p-6 h-fit space-y-4">
              <h2 className="font-display font-semibold text-base tracking-widest text-brand-red uppercase">
                {editingGenre ? 'EDITAR GÉNERO' : 'CREAR GÉNERO'}
              </h2>
              
              <form onSubmit={handleSaveGenre} className="space-y-4">
                {genreError && (
                  <div className="p-2 bg-brand-red/10 border border-brand-red/30 rounded text-xs text-brand-red font-mono">
                    {genreError}
                  </div>
                )}

                {/* Portada del Género */}
                <div className="space-y-1">
                  <label className="font-mono text-[9px] text-neutral-400 uppercase tracking-widest block">
                    Portada / Logo del Género
                  </label>
                  <div
                    onClick={() => genreFileInputRef.current?.click()}
                    className="aspect-video w-full rounded border border-dark-border hover:border-brand-red/40 bg-black/40 cursor-pointer group flex flex-col items-center justify-center p-2 overflow-hidden relative transition-all"
                  >
                    {genreImage ? (
                      <>
                        <img src={genreImage} alt="Portada del Género" className="absolute inset-0 w-full h-full object-cover" />
                        <CoverPreviewSizeBadge src={genreImage} />
                        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-1">
                          <Upload className="h-5 w-5 text-white" />
                          <span className="font-mono text-[9px] text-white uppercase">Cambiar portada</span>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setGenreImage('');
                          }}
                          className="absolute bottom-1.5 right-1.5 px-2 py-0.5 bg-black/80 hover:bg-brand-red text-white text-[9px] font-mono rounded z-10"
                        >
                          Eliminar
                        </button>
                      </>
                    ) : (
                      <div className="text-center space-y-1">
                        <Upload className="h-6 w-6 text-neutral-600 mx-auto group-hover:text-neutral-400 transition-colors" />
                        <p className="font-sans text-[10px] text-neutral-400">Toca para subir portada del género</p>
                        <span className="font-mono text-[8px] text-neutral-600 block uppercase">PNG, JPG o WEBP</span>
                      </div>
                    )}
                  </div>
                  <input
                    type="file"
                    accept="image/*"
                    ref={genreFileInputRef}
                    onChange={handleGenreFileChange}
                    className="hidden"
                  />
                </div>
                
                <div className="space-y-1">
                  <label className="font-mono text-[9px] text-neutral-400 uppercase tracking-widest block">
                    Nombre del Género *
                  </label>
                  <input
                    type="text"
                    required
                    value={genreName}
                    onChange={(e) => setGenreName(e.target.value)}
                    className="w-full bg-[#050505] border border-dark-border focus:border-brand-red/50 rounded p-2 text-sm text-white placeholder-neutral-800 outline-none transition-colors duration-300"
                  />
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    type="submit"
                    disabled={isSavingGenre}
                    className="flex-grow py-2 bg-brand-red hover:bg-brand-red-hover disabled:opacity-50 text-white rounded font-display font-medium text-xs tracking-widest uppercase transition-all duration-300 flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    {isSavingGenre ? (
                      <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                    {isSavingGenre
                      ? `${editingGenre ? 'Actualizando' : 'Creando'} (${liveProgress?.percent ?? 50}%)...`
                      : (editingGenre ? 'Actualizar' : 'Crear')}
                  </button>
                  {editingGenre && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingGenre(null);
                        setGenreName('');
                        setGenreImage('');
                      }}
                      className="px-3 py-2 bg-neutral-800 text-neutral-400 hover:text-white rounded text-xs transition-colors duration-300 cursor-pointer"
                    >
                      Cancelar
                    </button>
                  )}
                </div>
              </form>
            </div>

            {/* Right Genres Table List */}
            <div className="md:col-span-2 bg-dark-card border border-dark-border rounded-lg p-6">
              <div className="flex items-center justify-between mb-4 gap-2">
                <h2 className="font-display font-semibold text-base tracking-wide">Géneros Existentes ({genres.length})</h2>
                <button
                  onClick={handleDeduplicate}
                  disabled={isDeduplicating}
                  className="px-3 py-1.5 bg-brand-red/10 border border-brand-red/30 hover:border-brand-red text-brand-red hover:text-white rounded text-xs font-mono transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  title="Unifica automáticamente géneros repetidos o plurales (ej: Escolar y Escolares)"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  {isDeduplicating ? 'Unificando...' : 'Unificar Duplicados'}
                </button>
              </div>
              
              {genres.length === 0 ? (
                <p className="font-mono text-xs text-neutral-500">No hay géneros creados.</p>
              ) : (
                <div className="space-y-2">
                  {genres.map(genre => {
                    const count = genreAnimeCounts.get(genre.id) || 0;
                    const fallbackAnime = animes.find(a => a.genreIds?.includes(genre.id));

                    return (
                      <div
                        key={genre.id}
                        className="flex items-center justify-between p-3 bg-black/40 border border-dark-border/60 hover:border-dark-border rounded-lg transition-all duration-300 gap-3"
                      >
                        {/* Foto de la portada a la izquierda y la información a la derecha */}
                        <div className="flex items-center gap-3.5 min-w-0">
                          {/* Portada a la izquierda */}
                          <button
                            type="button"
                            onClick={() => {
                              setEditingGenre(genre);
                              setGenreName(genre.name);
                              setGenreImage(genre.image || '');
                              window.scrollTo({ top: 0, behavior: 'smooth' });
                            }}
                            title="Tocar foto para editar género"
                            className="w-14 h-14 sm:w-16 sm:h-16 rounded-lg bg-black/60 overflow-hidden shrink-0 flex items-center justify-center relative shadow-sm group cursor-pointer active:scale-95 transition-all"
                          >
                            {genre.image ? (
                              <img
                                src={portadaUrl(genre.image, 'mini')}
                                alt={genre.name}
                                loading="lazy"
                                decoding="async"
                                width={150}
                                height={150}
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                              />
                            ) : fallbackAnime ? (
                              <SmartAnimeCover
                                anime={fallbackAnime}
                                alt={genre.name}
                                tamaño="mini"
                                loading="lazy"
                                width={150}
                                height={150}
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                              />
                            ) : (
                              <div className="w-full h-full flex flex-col items-center justify-center p-1 text-center bg-purple-950/30">
                                <Layers className="h-5 w-5 text-purple-400" />
                                <span className="text-[7.5px] font-mono text-purple-300 font-bold truncate max-w-full">{genre.name.slice(0, 4)}</span>
                              </div>
                            )}
                          </button>

                          {/* Información a la derecha */}
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-display text-sm font-semibold text-white truncate">{genre.name}</span>
                              <span className="px-2 py-0.5 bg-[#ff5588]/10 border border-[#ff5588]/20 text-[#ff5588] text-[10px] font-mono rounded-full shrink-0">
                                {count} {count === 1 ? 'portada' : 'portadas'}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                              <span className="font-mono text-[9px] text-neutral-500">ID: {genre.id}</span>
                              <span className="text-neutral-700 text-[9px]">•</span>
                              <span className="font-mono text-[9px] text-emerald-400 flex items-center gap-1">
                                <Globe className="h-2.5 w-2.5" />
                                {genre.storageLocation || 'Firebase Firestore'}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => {
                              setEditingGenre(genre);
                              setGenreName(genre.name);
                              setGenreImage(genre.image || '');
                              window.scrollTo({ top: 0, behavior: 'smooth' });
                            }}
                            className="p-1.5 text-neutral-400 hover:text-white hover:bg-white/10 rounded transition-colors duration-200 cursor-pointer"
                            title="Editar Género"
                          >
                            <Edit2 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => handleDeleteGenre(genre.id)}
                            className="p-1.5 rounded border border-brand-red/20 hover:border-brand-red/60 bg-brand-red/5 text-brand-red hover:bg-brand-red hover:text-white transition-all duration-200 cursor-pointer"
                            title="Eliminar Género"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}


        {/* --- FIREBASE STATS, QUOTAS & BACKUP TAB --- */}
        {activeTab === 'firebase-stats' && (
          <div className="space-y-6 max-w-4xl">
            {/* Header with Project Status & Refresh Button */}
            <div className="bg-dark-card border border-dark-border rounded-lg p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2.5">
                  <div className="p-2 bg-amber-500/10 border border-amber-500/30 text-amber-400 rounded-lg">
                    <Cloud className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="font-display font-bold text-base tracking-widest text-white uppercase">
                        ESPACIO
                      </h2>
                    </div>
                    <p className="font-sans text-neutral-400 text-xs mt-0.5">
                      Monitoreo en tiempo real del almacenamiento disponible, desglose de datos en Firestore y respaldo completo.
                    </p>
                  </div>
                </div>
              </div>

              <button
                onClick={fetchFirebaseQuotaStats}
                disabled={quotaStats.loading}
                className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-dark-border text-white text-xs font-mono rounded flex items-center gap-2 transition-all duration-200 cursor-pointer disabled:opacity-50 shrink-0"
              >
                <RefreshCw className={`h-3.5 w-3.5 text-amber-400 ${quotaStats.loading ? 'animate-spin' : ''}`} />
                <span>{quotaStats.loading ? 'Actualizando...' : 'Actualizar Estado'}</span>
              </button>
            </div>

            {quotaStats.loading && !quotaStats.data && (
              <div className="bg-dark-card border border-dark-border rounded-lg p-12 text-center space-y-3">
                <div className="w-8 h-8 border-2 border-amber-500/30 border-t-amber-400 rounded-full animate-spin mx-auto" />
                <p className="font-mono text-xs text-neutral-400">Analizando espacio en Firestore y límites de cuota...</p>
              </div>
            )}

            {quotaStats.error && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-400 text-xs font-mono flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4" />
                  <span>{quotaStats.error}</span>
                </div>
                <button
                  onClick={fetchFirebaseQuotaStats}
                  className="underline hover:text-white"
                >
                  Reintentar
                </button>
              </div>
            )}

            {quotaStats.data && (
              <>
                {/* 1. Storage Bar & Space Remaining Overview */}
                <div className="bg-dark-card border border-dark-border rounded-lg p-6 space-y-5">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      <HardDrive className="h-4 w-4 text-amber-400" />
                      <h3 className="font-display font-semibold text-sm tracking-wider uppercase text-white">
                        Espacio de Almacenamiento (Base de Datos Firestore)
                      </h3>
                    </div>
                    <span className="font-mono text-xs text-neutral-400">
                      Límite Gratuito: <strong className="text-white">{quotaStats.data.storage.limitFormatted}</strong>
                    </span>
                  </div>

                  {/* Progress Bar */}
                  <div className="space-y-2">
                    <div className="w-full bg-black/60 h-4 rounded-full overflow-hidden p-0.5 border border-dark-border flex">
                      <div
                        className="bg-gradient-to-r from-emerald-500 to-amber-500 h-full rounded-full transition-all duration-700 min-w-[6px]"
                        style={{ width: `${Math.max(1, Math.min(100, quotaStats.data.storage.percentUsed))}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-xs font-mono">
                      <span className="text-emerald-400 font-bold">
                        En Uso: {quotaStats.data.storage.usedFormatted} ({quotaStats.data.storage.percentUsed}%)
                      </span>
                      <span className="text-white font-bold bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded">
                        Disponible: {quotaStats.data.storage.remainingFormatted} ({quotaStats.data.storage.percentRemaining}%)
                      </span>
                    </div>
                  </div>

                  {/* 3 Metrics Cards (Espacio Usado, Espacio Libre, Total Documentos) */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                    <div className="bg-black/40 border border-dark-border rounded-lg p-4 space-y-1">
                      <span className="font-mono text-[11px] text-neutral-400 uppercase tracking-wider">Espacio Disponible</span>
                      <div className="text-xl font-display font-bold text-emerald-400">
                        {quotaStats.data.storage.remainingMB} MB
                      </div>
                      <p className="font-mono text-[10px] text-neutral-500">
                        {(quotaStats.data.storage.remainingMB / 1024).toFixed(2)} GB libres para miles de animes más
                      </p>
                    </div>

                    <div className="bg-black/40 border border-dark-border rounded-lg p-4 space-y-1">
                      <span className="font-mono text-[11px] text-neutral-400 uppercase tracking-wider">Espacio Ocupado</span>
                      <div className="text-xl font-display font-bold text-amber-400">
                        {quotaStats.data.storage.usedFormatted}
                      </div>
                      <p className="font-mono text-[10px] text-neutral-500">
                        {quotaStats.data.counts.totalDocuments} documentos registrados
                      </p>
                    </div>

                    <div className="bg-black/40 border border-dark-border rounded-lg p-4 space-y-1">
                      <span className="font-mono text-[11px] text-neutral-400 uppercase tracking-wider">Portadas en Servidor</span>
                      <div className="text-xl font-display font-bold text-white">
                        {quotaStats.data.storage.totalCoversDiskMB} MB
                      </div>
                      <p className="font-mono text-[10px] text-neutral-500">
                        {quotaStats.data.storage.totalCoversCount} portadas almacenadas
                      </p>
                    </div>
                  </div>
                </div>

                {/* 2. Detailed Document Inventory */}
                <div className="bg-dark-card border border-dark-border rounded-lg p-6 space-y-4">
                  <div className="flex items-center gap-2">
                    <BarChart3 className="h-4 w-4 text-brand-red" />
                    <h3 className="font-display font-semibold text-sm tracking-wider uppercase text-white">
                      Desglose de Datos en tu Proyecto ({quotaStats.data.projectId})
                    </h3>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="p-3 bg-black/40 border border-dark-border rounded text-center">
                      <span className="font-mono text-[10px] text-neutral-400 block uppercase">Animes</span>
                      <span className="text-lg font-display font-bold text-white">{quotaStats.data.counts.animes}</span>
                    </div>

                    <div className="p-3 bg-black/40 border border-dark-border rounded text-center">
                      <span className="font-mono text-[10px] text-neutral-400 block uppercase">Capítulos</span>
                      <span className="text-lg font-display font-bold text-white">{quotaStats.data.counts.episodes}</span>
                    </div>

                    <div className="p-3 bg-black/40 border border-dark-border rounded text-center">
                      <span className="font-mono text-[10px] text-neutral-400 block uppercase">Estudios</span>
                      <span className="text-lg font-display font-bold text-white">{quotaStats.data.counts.studios}</span>
                    </div>

                    <div className="p-3 bg-black/40 border border-dark-border rounded text-center">
                      <span className="font-mono text-[10px] text-neutral-400 block uppercase">Géneros</span>
                      <span className="text-lg font-display font-bold text-white">{quotaStats.data.counts.genres}</span>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* 3. RESPALDO TOTAL DEL ARCHIVO (BACKUP) */}
            <div className="bg-dark-card border border-dark-border rounded-lg p-6 space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h2 className="font-display font-bold text-base tracking-widest text-brand-red uppercase flex items-center gap-2">
                  <Database className="h-4 w-4" />
                  RESPALDO TOTAL DEL ARCHIVO
                </h2>
                <span className="px-2.5 py-1 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[10px] font-mono rounded tracking-wider">
                  100% COMPLETO Y AUTOCONTENIDO
                </span>
              </div>

              <p className="font-sans text-neutral-300 text-sm leading-relaxed">
                Descarga una copia de seguridad íntegra de toda la plataforma en un único archivo <span className="text-white font-mono font-bold">.JSON</span>. Se incluye absolutamente toda la información, imágenes y acomodo exacto para que nunca pierdas ningún dato:
              </p>

              {/* Data Inclusions Checklist */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 py-2">
                <div className="flex items-center gap-2 p-2.5 bg-black/40 border border-dark-border rounded text-xs text-neutral-300">
                  <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                  <span><strong>Todas las Portadas:</strong> Animes, estudios y géneros (Base64)</span>
                </div>
                <div className="flex items-center gap-2 p-2.5 bg-black/40 border border-dark-border rounded text-xs text-neutral-300">
                  <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                  <span><strong>Miniaturas de Episodios:</strong> Capturas y portadas de capítulos</span>
                </div>
                <div className="flex items-center gap-2 p-2.5 bg-black/40 border border-dark-border rounded text-xs text-neutral-300">
                  <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                  <span><strong>Acomodo Exacto:</strong> Orden de animes, Spin-off, secuelas y capítulos</span>
                </div>
                <div className="flex items-center gap-2 p-2.5 bg-black/40 border border-dark-border rounded text-xs text-neutral-300">
                  <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                  <span><strong>Datos de Animes:</strong> Sinopsis, año, mes, estado y detalles</span>
                </div>
                <div className="flex items-center gap-2 p-2.5 bg-black/40 border border-dark-border rounded text-xs text-neutral-300">
                  <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                  <span><strong>Capítulos y Enlaces:</strong> MP4, servidores y links de Telegram</span>
                </div>
                <div className="flex items-center gap-2 p-2.5 bg-black/40 border border-dark-border rounded text-xs text-neutral-300">
                  <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                  <span><strong>Comunidad y Papelera:</strong> Vistas, estrellas, comentarios y listas</span>
                </div>
              </div>

              {backupStatus && !isExporting && !isImporting && (
                <div className="p-3 bg-white/5 border border-dark-border text-brand-red text-xs font-mono rounded">
                  {backupStatus}
                </div>
              )}

              <div className="pt-2 flex flex-col sm:flex-row gap-3">
                <button
                  onClick={() => setShowExportOptionsModal(true)}
                  disabled={isExporting}
                  className="px-6 py-3 bg-brand-red hover:bg-brand-red-hover disabled:opacity-60 text-white rounded font-display font-medium text-xs tracking-widest uppercase flex items-center justify-center gap-2 transition-all duration-300 cursor-pointer shadow-lg shadow-brand-red/20"
                >
                  <Download className="h-4 w-4" />
                  <span>Descargar Respaldo Completo (.JSON)</span>
                </button>
              </div>
            </div>

            {/* 4. RESTAURAR RESPALDO */}
            <div className="bg-dark-card border border-dark-border rounded-lg p-6 space-y-4">
              <h2 className="font-display font-bold text-base tracking-widest text-white uppercase flex items-center gap-2">
                <RefreshCw className="h-4 w-4" />
                RESTAURAR RESPALDO
              </h2>
              <p className="font-sans text-neutral-400 text-sm">
                Selecciona tu archivo JSON de copia de seguridad o pega el código JSON de un respaldo exportado previamente para restaurar la base de datos completa con todas las portadas, miniaturas, capítulos y orden exacto.
              </p>

              {/* Directly upload file option */}
              <div className="p-4 bg-black/50 border border-dashed border-dark-border hover:border-brand-red/60 rounded-lg transition-all duration-300 flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 bg-brand-red/10 rounded-lg text-brand-red">
                    <Upload className="h-5 w-5" />
                  </div>
                  <div>
                    <h4 className="font-display font-semibold text-xs text-white uppercase tracking-wider">Subir Archivo (.json)</h4>
                    <p className="font-mono text-[10px] text-neutral-400">Selecciona el archivo descargado desde tu celular o PC</p>
                  </div>
                </div>
                <label className="px-4 py-2.5 bg-brand-red hover:bg-brand-red-hover text-white rounded font-display font-semibold text-xs tracking-wider uppercase cursor-pointer transition-all duration-300 flex items-center gap-2 shrink-0">
                  <Upload className="h-3.5 w-3.5" />
                  Seleccionar Archivo
                  <input
                    type="file"
                    accept="*/*"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                </label>
              </div>

              <div className="relative flex items-center justify-center my-3">
                <div className="border-t border-dark-border w-full" />
                <span className="bg-dark-card px-3 font-mono text-[10px] text-neutral-500 uppercase tracking-widest absolute">o pega el código JSON</span>
              </div>

              <textarea
                rows={6}
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
                placeholder='{ "studios": [...], "genres": [...], "animes": [...] }'
                className="w-full bg-[#050505] border border-dark-border focus:border-brand-red/50 rounded p-3 text-xs font-mono text-neutral-300 placeholder-neutral-800 outline-none transition-all duration-300"
              />

              {backupStatus && !isImporting && !isExporting && (
                <div className="p-3 bg-black/60 border border-dark-border text-neutral-200 text-xs font-mono rounded flex items-start gap-2">
                  <span className="text-brand-red font-bold shrink-0">›</span>
                  <span className="break-all">{backupStatus}</span>
                </div>
              )}

              <button
                onClick={handleImportBackup}
                disabled={(!importJson.trim() && !parsedBackupData) || isImporting}
                className="w-full sm:w-auto px-6 py-3 bg-white hover:bg-neutral-200 disabled:opacity-40 disabled:hover:bg-white text-black font-display font-semibold text-xs tracking-widest uppercase flex items-center justify-center gap-2 transition-all duration-300 cursor-pointer"
              >
                <Check className="h-4 w-4" />
                <span>Aplicar e Importar Respaldo</span>
              </button>
            </div>

            {/* 5. BORRAR MENSAJES ENVIADOS Y RESPUESTAS DE SOPORTE */}
            <div className="bg-dark-card border border-dark-border rounded-lg p-6 space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h2 className="font-display font-bold text-base tracking-widest text-brand-red uppercase flex items-center gap-2">
                  <MessageSquare className="h-4 w-4" />
                  MENSAJES Y RESPUESTAS DE SOPORTE
                </h2>
              </div>
              <p className="font-sans text-neutral-400 text-sm">
                Elimina permanentemente todos los reportes de problemas, sugerencias enviadas por los usuarios y todas las respuestas del administrador en el chat de soporte.
              </p>
              <div className="pt-1">
                <button
                  type="button"
                  onClick={handleClearSupportMessages}
                  disabled={isClearingSupport}
                  className="w-full sm:w-auto px-6 py-3 bg-red-950/50 hover:bg-brand-red border border-brand-red/40 hover:border-brand-red disabled:opacity-50 text-white rounded font-display font-semibold text-xs tracking-widest uppercase flex items-center justify-center gap-2 transition-all duration-300 cursor-pointer shadow-lg shadow-brand-red/10"
                >
                  <Trash2 className="h-4 w-4" />
                  <span>
                    {isClearingSupport
                      ? 'Borrando mensajes y respuestas...'
                      : 'Borrar todos los mensajes enviados y todas las respuestas'}
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* --- ANNOUNCEMENTS TAB (POST ESTILO X) --- */}
        {activeTab === 'announcements' && (
          <AdminAnnouncementManager
            onShowNotification={showNotification}
            onSetProgress={(p) =>
              setLiveProgress(
                p
                  ? {
                      title: 'Guardando Anuncio',
                      detail: 'Sincronizando post con Firebase...',
                      percent: p.percent,
                      current: 1,
                      total: 1,
                      unit: 'post'
                    }
                  : null
              )
            }
          />
        )}
          </motion.div>
        </AnimatePresence>

        {/* Modal de Inspección y Unificación de Portadas Duplicadas */}
        {showDuplicatesModal && (
          <div className="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 z-[9999] animate-fade-in">
            <div className="bg-[#0c0c0c] border border-dark-border rounded-xl p-6 max-w-2xl w-full max-h-[85vh] overflow-y-auto space-y-5 shadow-[0_25px_60px_rgba(0,0,0,0.9)]">
              <div className="flex items-center justify-between border-b border-dark-border pb-4">
                <div className="flex items-center gap-2.5 text-brand-red">
                  <Sparkles className="h-5 w-5" />
                  <div>
                    <h3 className="font-display font-bold text-xs tracking-widest uppercase text-white">
                      Análisis de Repetidos (Episodios, Telegram, Portadas, Nombres, Estudios y Géneros)
                    </h3>
                    <p className="font-mono text-[10px] text-neutral-400">
                      Unifica elementos repetidos en todo el sistema combinando historial de descargas, episodios y categorías.
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setShowDuplicatesModal(false)}
                  className="text-neutral-500 hover:text-white font-mono text-xs uppercase"
                >
                  ✕
                </button>
              </div>

              {duplicateDiagnostics.totalDuplicates === 0 ? (
                <div className="space-y-4">
                  <div className="text-center py-10 bg-black/40 border border-dark-border rounded-lg space-y-2">
                    <Check className="h-8 w-8 text-emerald-400 mx-auto" />
                    <h4 className="font-display font-semibold text-xs text-white uppercase">¡No se detectaron duplicados!</h4>
                    <p className="font-mono text-[10px] text-neutral-400">
                      Todos los enlaces de episodios, enlaces principales, nombres, imágenes, estudios y géneros son únicos en la base de datos.
                    </p>
                  </div>

                  <button
                    type="button"
                    disabled={isDeduplicating}
                    onClick={handleDeduplicate}
                    className="w-full py-2.5 bg-brand-red/10 hover:bg-brand-red text-brand-red hover:text-white border border-brand-red/30 rounded font-display font-semibold text-xs tracking-wider uppercase flex items-center justify-center gap-2 transition-all cursor-pointer disabled:opacity-50"
                    title="Deduplica y unifica automáticamente estudios y géneros repetidos"
                  >
                    <Sparkles className="h-4 w-4" />
                    <span>{isDeduplicating ? 'Unificando estudios y géneros...' : 'Unificar Estudios y Géneros Repetidos'}</span>
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Summary Badges */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                    <div className="p-2.5 bg-dark-card border border-dark-border rounded-lg text-center space-y-0.5">
                      <span className="font-mono text-[8.5px] text-neutral-400 uppercase tracking-wider block">Enlaces Episodios</span>
                      <span className="font-display font-bold text-sm text-brand-red">{duplicateDiagnostics.episodeLinkDupes.length} Grupos</span>
                    </div>
                    <div className="p-2.5 bg-dark-card border border-dark-border rounded-lg text-center space-y-0.5">
                      <span className="font-mono text-[8.5px] text-neutral-400 uppercase tracking-wider block">Enlaces Telegram</span>
                      <span className="font-display font-bold text-sm text-brand-red">{duplicateDiagnostics.telegramDupes.length} Grupos</span>
                    </div>
                    <div className="p-2.5 bg-dark-card border border-dark-border rounded-lg text-center space-y-0.5">
                      <span className="font-mono text-[8.5px] text-neutral-400 uppercase tracking-wider block">Nombres Repetidos</span>
                      <span className="font-display font-bold text-sm text-brand-red">{duplicateDiagnostics.titleDupes.length} Grupos</span>
                    </div>
                    <div className="p-2.5 bg-dark-card border border-dark-border rounded-lg text-center space-y-0.5">
                      <span className="font-mono text-[8.5px] text-neutral-400 uppercase tracking-wider block">Imágenes Repetidas</span>
                      <span className="font-display font-bold text-sm text-brand-red">{duplicateDiagnostics.coverDupes.length} Grupos</span>
                    </div>
                    <div className="p-2.5 bg-dark-card border border-dark-border rounded-lg text-center space-y-0.5">
                      <span className="font-mono text-[8.5px] text-neutral-400 uppercase tracking-wider block">Estudios Repetidos</span>
                      <span className="font-display font-bold text-sm text-purple-400">{duplicateDiagnostics.studioDupes.length} Grupos</span>
                    </div>
                    <div className="p-2.5 bg-dark-card border border-dark-border rounded-lg text-center space-y-0.5">
                      <span className="font-mono text-[8.5px] text-neutral-400 uppercase tracking-wider block">Géneros Repetidos</span>
                      <span className="font-display font-bold text-sm text-purple-400">{duplicateDiagnostics.genreDupes.length} Grupos</span>
                    </div>
                  </div>

                  {/* List of Duplicate Groups Preview */}
                  <div className="space-y-3 max-h-[320px] overflow-y-auto pr-1">
                    {/* Episode Link Dupes */}
                    {duplicateDiagnostics.episodeLinkDupes.map((group, idx) => (
                      <div key={`ep-${idx}`} className="p-3 bg-black/60 border border-dark-border/80 rounded-lg space-y-2">
                        <div className="flex items-center justify-between text-[10px] font-mono text-purple-400">
                          <span>Enlace de Episodio Duplicado</span>
                          <span>{group.length} coincidencias</span>
                        </div>
                        <p className="font-mono text-[10px] text-neutral-400 truncate bg-black/40 p-1.5 rounded border border-white/5">
                          {getEpisodeUrl(group[0].anime.episodes?.find(e => e.number === group[0].epNumber)) || 'Enlace'}
                        </p>
                        <div className="flex flex-wrap gap-2 pt-1">
                          {group.map(({ anime: a, epNumber }, i) => (
                            <div key={`${a.id}-${epNumber}-${i}`} className="flex items-center gap-2 bg-dark-card px-2 py-1 rounded border border-dark-border text-[10px]">
                              <span className="font-mono text-purple-400 font-bold">Ep. {epNumber}</span>
                              <span className="font-medium text-white truncate max-w-[140px]">{a.name}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}

                    {/* Telegram Dupes */}
                    {duplicateDiagnostics.telegramDupes.map((group, idx) => (
                      <div key={`tg-${idx}`} className="p-3 bg-black/60 border border-dark-border/80 rounded-lg space-y-2">
                        <div className="flex items-center justify-between text-[10px] font-mono text-amber-400">
                          <span>Enlace Telegram Principal Duplicado</span>
                          <span>{group.length} coincidencias</span>
                        </div>
                        <p className="font-mono text-[10px] text-neutral-400 truncate bg-black/40 p-1.5 rounded border border-white/5">
                          {group[0].telegramUrl}
                        </p>
                        <div className="flex flex-wrap gap-2 pt-1">
                          {group.map(a => (
                            <div key={a.id} className="flex items-center gap-2 bg-dark-card px-2 py-1 rounded border border-dark-border text-[10px]">
                              <div className="w-5 h-7 bg-neutral-900 rounded overflow-hidden shrink-0">
                                <SmartAnimeCover anime={a} tamaño="mini" loading="lazy" width={150} height={225} className="w-full h-full object-cover" />
                              </div>
                              <span className="font-medium text-white truncate max-w-[150px]">{a.name}</span>
                              <span className="text-neutral-500 font-mono text-[9px]">({a.downloads || 0} descargas)</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}

                    {/* Title Dupes */}
                    {duplicateDiagnostics.titleDupes.map((group, idx) => (
                      <div key={`title-${idx}`} className="p-3 bg-black/60 border border-dark-border/80 rounded-lg space-y-2">
                        <div className="flex items-center justify-between text-[10px] font-mono text-amber-400">
                          <span>Nombre de Anime Duplicado</span>
                          <span>{group.length} coincidencias</span>
                        </div>
                        <p className="font-sans font-bold text-xs text-white">
                          "{group[0].name}"
                        </p>
                        <div className="flex flex-wrap gap-2 pt-1">
                          {group.map(a => (
                            <div key={a.id} className="flex items-center gap-2 bg-dark-card px-2 py-1 rounded border border-dark-border text-[10px]">
                              <div className="w-5 h-7 bg-neutral-900 rounded overflow-hidden shrink-0">
                                <SmartAnimeCover anime={a} tamaño="mini" loading="lazy" width={150} height={225} className="w-full h-full object-cover" />
                              </div>
                              <span className="text-neutral-300 font-mono text-[9px] truncate max-w-[180px]">{a.telegramUrl}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}

                    {/* Studio Dupes */}
                    {duplicateDiagnostics.studioDupes.map((group, idx) => (
                      <div key={`st-${idx}`} className="p-3 bg-black/60 border border-dark-border/80 rounded-lg space-y-1">
                        <div className="flex items-center justify-between text-[10px] font-mono text-purple-400">
                          <span>Estudio Repetido</span>
                          <span>{group.length} coincidencias</span>
                        </div>
                        <p className="font-sans font-bold text-xs text-white">"{group[0].name}"</p>
                      </div>
                    ))}

                    {/* Genre Dupes */}
                    {duplicateDiagnostics.genreDupes.map((group, idx) => (
                      <div key={`gn-${idx}`} className="p-3 bg-black/60 border border-dark-border/80 rounded-lg space-y-1">
                        <div className="flex items-center justify-between text-[10px] font-mono text-purple-400">
                          <span>Género Repetido</span>
                          <span>{group.length} coincidencias</span>
                        </div>
                        <p className="font-sans font-bold text-xs text-white">"{group[0].name}"</p>
                      </div>
                    ))}
                  </div>

                  {/* Action Buttons */}
                  <div className="pt-2 space-y-2">
                    <button
                      type="button"
                      disabled={isDeduplicatingAnimes}
                      onClick={handleDeduplicateAnimes}
                      className="w-full py-3 bg-brand-red hover:bg-brand-red-hover disabled:opacity-50 text-white rounded font-display font-semibold text-xs tracking-widest uppercase flex items-center justify-center gap-2 transition-all duration-300 cursor-pointer shadow-lg shadow-brand-red/20"
                    >
                      <Sparkles className="h-4 w-4" />
                      {isDeduplicatingAnimes ? 'Unificando y limpiando duplicados...' : 'Unificar Todo Automáticamente'}
                    </button>

                    <button
                      type="button"
                      disabled={isDeduplicating}
                      onClick={handleDeduplicate}
                      className="w-full py-2.5 bg-white/5 hover:bg-white/10 text-neutral-300 hover:text-white border border-dark-border rounded font-display font-semibold text-xs tracking-wider uppercase flex items-center justify-center gap-2 transition-all cursor-pointer disabled:opacity-50"
                      title="Deduplica y unifica automáticamente estudios y géneros repetidos"
                    >
                      <Sparkles className="h-3.5 w-3.5 text-brand-red" />
                      <span>{isDeduplicating ? 'Unificando estudios y géneros...' : 'Unificar Estudios y Géneros'}</span>
                    </button>
                  </div>
                </div>
              )}

              <div className="flex justify-end pt-2 border-t border-dark-border">
                <button
                  type="button"
                  onClick={() => setShowDuplicatesModal(false)}
                  className="px-4 py-2 bg-[#181818] hover:bg-[#222] text-neutral-300 rounded font-mono text-[10px] uppercase tracking-wider transition-colors cursor-pointer"
                >
                  Cerrar
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal de Opciones al Descargar Copia de Seguridad (3 Opciones) */}
        {showExportOptionsModal && (
          <div className="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 z-[9999] animate-fade-in">
            <div className="bg-[#0e0718] border border-purple-500/35 rounded-2xl p-5 sm:p-6 max-w-md w-full space-y-4 shadow-[0_25px_60px_rgba(0,0,0,0.9)]">
              <div className="flex items-start justify-between gap-3 border-b border-white/10 pb-3.5">
                <div className="flex items-center gap-2.5 text-brand-red">
                  <div className="p-2 rounded-xl bg-brand-red/15 border border-brand-red/30 text-brand-red shrink-0">
                    <Download className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="font-display font-bold text-xs sm:text-sm tracking-wider uppercase text-white">
                      Descargar Copia de Seguridad
                    </h3>
                    <p className="font-mono text-[10px] text-neutral-400">
                      Elige qué datos deseas incluir en tu archivo .JSON
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowExportOptionsModal(false)}
                  className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                  title="Cerrar"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="space-y-2.5">
                {/* Opción 1: Con comentarios y calificaciones */}
                <button
                  type="button"
                  onClick={() => handleExportBackup('with_comments_and_ratings')}
                  className="w-full text-left p-3.5 rounded-xl bg-[#160b28] hover:bg-[#21103b] border border-purple-500/40 hover:border-purple-400 transition-all duration-200 group cursor-pointer flex items-start gap-3 shadow-md"
                >
                  <div className="p-2 rounded-lg bg-purple-500/20 border border-purple-400/30 text-purple-300 group-hover:bg-purple-500 group-hover:text-white transition-colors shrink-0 mt-0.5">
                    <MessageSquare className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-display font-bold text-xs sm:text-sm text-white group-hover:text-purple-200 transition-colors">
                        Con comentarios y calificaciones
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-mono text-[9px] font-bold uppercase shrink-0">
                        Completo
                      </span>
                    </div>
                    <p className="font-sans text-[11px] text-neutral-400 leading-relaxed">
                      Descarga todo el catálogo (animes, portadas, capítulos, Spin-off/secuelas) junto con todas las calificaciones y comentarios.
                    </p>
                  </div>
                </button>

                {/* Opción 2: Solo con calificaciones */}
                <button
                  type="button"
                  onClick={() => handleExportBackup('only_ratings')}
                  className="w-full text-left p-3.5 rounded-xl bg-[#120920] hover:bg-[#1c0e32] border border-amber-500/30 hover:border-amber-400/70 transition-all duration-200 group cursor-pointer flex items-start gap-3 shadow-md"
                >
                  <div className="p-2 rounded-lg bg-amber-500/15 border border-amber-400/30 text-amber-300 group-hover:bg-amber-500 group-hover:text-black transition-colors shrink-0 mt-0.5">
                    <Star className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-display font-bold text-xs sm:text-sm text-white group-hover:text-amber-200 transition-colors">
                        Solo con calificaciones
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 font-mono text-[9px] font-bold uppercase shrink-0">
                        Sin comentarios
                      </span>
                    </div>
                    <p className="font-sans text-[11px] text-neutral-400 leading-relaxed">
                      Descarga todo el catálogo y las calificaciones de estrellas de los animes, excluyendo los comentarios.
                    </p>
                  </div>
                </button>

                {/* Opción 3: Sin ninguno de los 2 */}
                <button
                  type="button"
                  onClick={() => handleExportBackup('without_both')}
                  className="w-full text-left p-3.5 rounded-xl bg-[#100a19] hover:bg-[#191027] border border-white/15 hover:border-white/35 transition-all duration-200 group cursor-pointer flex items-start gap-3 shadow-md"
                >
                  <div className="p-2 rounded-lg bg-white/10 border border-white/15 text-neutral-300 group-hover:bg-white group-hover:text-black transition-colors shrink-0 mt-0.5">
                    <Database className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-display font-bold text-xs sm:text-sm text-white">
                        Sin ninguno de los 2
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-white/10 border border-white/20 text-neutral-300 font-mono text-[9px] font-bold uppercase shrink-0">
                        Solo catálogo
                      </span>
                    </div>
                    <p className="font-sans text-[11px] text-neutral-400 leading-relaxed">
                      Descarga únicamente el catálogo (animes, portadas, miniaturas, episodios, estudios, géneros y Spin-off/secuelas), sin calificaciones ni comentarios.
                    </p>
                  </div>
                </button>
              </div>

              <div className="pt-2 border-t border-white/10 flex justify-end">
                <button
                  type="button"
                  onClick={() => setShowExportOptionsModal(false)}
                  className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 text-neutral-300 hover:text-white rounded-xl font-mono text-[11px] uppercase tracking-wider transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Custom Confirmation Modal */}
        {deleteConfirm && (
          <div className="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 z-[9999] animate-fade-in">
            <div className="bg-[#0b0b0b] border border-dark-border rounded-lg p-6 max-w-sm w-full space-y-4 shadow-[0_20px_50px_rgba(0,0,0,0.8)]">
              <div className="flex items-center gap-2.5 text-brand-red">
                <AlertCircle className="h-5 w-5 animate-pulse" />
                <h3 className="font-display font-bold text-xs tracking-widest uppercase">{deleteConfirm.title}</h3>
              </div>
              <p className="font-sans text-[11px] text-neutral-400 leading-relaxed">
                {deleteConfirm.message}
              </p>
              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={() => {
                    deleteConfirm.onConfirm();
                    setDeleteConfirm(null);
                  }}
                  className="flex-1 py-2 bg-brand-red hover:bg-brand-red-hover text-white rounded font-display font-semibold text-[10px] tracking-widest uppercase transition-all duration-300 cursor-pointer"
                >
                  Confirmar
                </button>
                <button
                  onClick={() => setDeleteConfirm(null)}
                  className="flex-1 py-2 bg-[#141414] hover:bg-[#202020] border border-dark-border text-neutral-400 hover:text-white rounded font-mono text-[10px] uppercase tracking-wider transition-colors duration-300 cursor-pointer"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal de Ficha de Anime - Exact replica of Screenshot 2 */}
        {selectedAnimeDetails && (() => {
          const sIds = (selectedAnimeDetails.studioIds && selectedAnimeDetails.studioIds.length > 0)
            ? selectedAnimeDetails.studioIds
            : (selectedAnimeDetails.studioId ? [selectedAnimeDetails.studioId] : []);
          const sNames = sIds.map(id => studioMapForAdmin.get(id) || studios.find(s => s.id === id)?.name).filter(Boolean);
          const sName = sNames.length > 0 ? sNames.join(', ') : 'Sin estudio';

          const gNames = (selectedAnimeDetails.genreIds || [])
            .map(id => genres.find(g => g.id === id)?.name)
            .filter(Boolean);
          const genreText = gNames.length > 0 ? gNames.join(', ') : 'Sin géneros';

          const rStats = getAnimeRatingStats(selectedAnimeDetails.id);
          const ratingText = rStats.totalVotes === 0 
            ? 'Sin calificación' 
            : `★ ${rStats.average.toFixed(1)} (${rStats.totalVotes} voto${rStats.totalVotes === 1 ? '' : 's'})`;

          const epCount = selectedAnimeDetails.episodes?.length || 0;
          const epText = `${epCount} episodio${epCount === 1 ? '' : 's'}`;

          return (
            <div className="fixed inset-0 bg-black/85 backdrop-blur-md flex items-center justify-center p-4 z-[9999] animate-fade-in">
              <div className="bg-[#0e061a] border border-[#2b144d] rounded-2xl p-4 sm:p-5 max-w-sm sm:max-w-md w-full shadow-2xl space-y-4">
                {/* Header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-14 h-20 bg-neutral-900 border border-purple-500/30 rounded-lg overflow-hidden shrink-0 shadow">
                      <SmartAnimeCover anime={selectedAnimeDetails} studioName={sName} tamaño="mini" loading="lazy" width={150} height={225} className="w-full h-full object-cover" />
                    </div>
                    <div className="min-w-0 space-y-0.5">
                      <h3 className="font-sans font-bold text-sm sm:text-base text-white leading-snug line-clamp-2">
                        {selectedAnimeDetails.name} {selectedAnimeDetails.year ? `(${selectedAnimeDetails.year})` : ''}
                      </h3>
                      <p className="font-mono text-xs text-neutral-400">
                        Ficha de Anime
                      </p>
                      <div className="pt-0.5">
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-emerald-950/70 border border-emerald-500/40 text-emerald-400 text-[10px] sm:text-[11px] font-mono">
                          <Globe className="h-3 w-3 text-emerald-400 shrink-0" />
                          <span className="truncate max-w-[180px] sm:max-w-xs">{selectedAnimeDetails.storageLocation || 'Firebase Firestore (kuzeh-01)'}</span>
                        </span>
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={() => setSelectedAnimeDetails(null)}
                    className="p-1.5 rounded-lg bg-[#1a0f2e] border border-[#311756] text-neutral-400 hover:text-white transition-colors cursor-pointer shrink-0"
                    title="Cerrar"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {/* Content Box: DETALLES DEL CONTENIDO */}
                <div className="bg-[#130722] border border-[#29124a] rounded-xl p-3.5 sm:p-4 space-y-2.5 font-mono text-xs sm:text-[13px]">
                  <div className="flex items-center gap-2 text-[#ec4899] font-bold text-xs uppercase tracking-wider mb-1">
                    <Film className="h-4 w-4 text-[#ec4899] shrink-0" />
                    <span>DETALLES DEL CONTENIDO</span>
                  </div>

                  <div className="space-y-1.5 text-neutral-300">
                    <div className="flex items-baseline gap-2">
                      <span className="text-neutral-400 font-semibold shrink-0">Estudios:</span>
                      <span className="text-neutral-100 font-medium truncate">{sName}</span>
                    </div>

                    <div className="flex items-baseline gap-2">
                      <span className="text-neutral-400 font-semibold shrink-0">Géneros:</span>
                      <span className="text-neutral-200 line-clamp-2">{genreText}</span>
                    </div>

                    <div className="flex items-baseline gap-2">
                      <span className="text-neutral-400 font-semibold shrink-0">Estado:</span>
                      <span className={`font-bold ${
                        selectedAnimeDetails.status === 'Próximamente' || selectedAnimeDetails.status?.toLowerCase() === 'próximamente'
                          ? 'text-amber-400'
                          : selectedAnimeDetails.status?.toLowerCase().includes('emisi')
                          ? 'text-emerald-400'
                          : 'text-neutral-300'
                      }`}>
                        {selectedAnimeDetails.status === 'Próximamente' || selectedAnimeDetails.status?.toLowerCase() === 'próximamente'
                          ? 'Próximamente'
                          : selectedAnimeDetails.status?.toLowerCase().includes('emisi')
                          ? 'Emisión'
                          : 'Finalizado'}
                      </span>
                    </div>

                    <div className="flex items-baseline gap-2">
                      <span className="text-neutral-400 font-semibold shrink-0">Descargas:</span>
                      <span className="text-white font-bold">{selectedAnimeDetails.downloads || 0}</span>
                    </div>

                    <div className="flex items-baseline gap-2">
                      <span className="text-neutral-400 font-semibold shrink-0">Calificación:</span>
                      <span className="text-amber-400 font-bold">{ratingText}</span>
                    </div>

                    <div className="flex items-baseline gap-2">
                      <span className="text-neutral-400 font-semibold shrink-0">Episodios:</span>
                      <span className="text-white font-bold">{epText}</span>
                    </div>

                    {selectedAnimeDetails.description && (
                      <div className="border-t border-[#261144] pt-2 mt-2">
                        <span className="text-neutral-400 font-semibold block mb-1">Sinopsis:</span>
                        <p className="text-neutral-300 font-sans text-xs leading-relaxed line-clamp-4">
                          {selectedAnimeDetails.description}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Bottom Action: Purple CERRAR Button */}
                <div className="flex justify-end pt-1">
                  <button
                    onClick={() => setSelectedAnimeDetails(null)}
                    className="px-6 py-2 bg-[#9d4edd] hover:bg-[#8b3fd0] text-white font-sans font-bold text-xs uppercase tracking-wider rounded-lg shadow-md transition-all active:scale-95 cursor-pointer ml-auto block"
                  >
                    CERRAR
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Quick Add Episode Modal */}
        {showQuickAddEpModal && (
          <div className="fixed inset-0 z-[9990] bg-black/85 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-dark-card border border-dark-border rounded-xl p-6 max-w-lg w-full space-y-5 shadow-2xl relative">
              <div className="flex items-center justify-between border-b border-dark-border pb-3">
                <div className="flex items-center gap-2">
                  <LinkIcon className="h-5 w-5 text-purple-400" />
                  <h3 className="font-display font-bold text-sm tracking-widest text-white uppercase">
                    Agregar Episodio por Enlace
                  </h3>
                </div>
                <button
                  onClick={() => setShowQuickAddEpModal(false)}
                  className="text-neutral-500 hover:text-white p-1 text-xs font-mono"
                >
                  ✕
                </button>
              </div>

              <div className="space-y-4">
                {/* Chapter Inputs List */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="font-mono text-[9.5px] text-purple-300 uppercase tracking-widest block font-semibold">
                      Episodios a Agregar ({quickEpItems.length})
                    </label>
                  </div>

                  <div className="space-y-1.5 max-h-64 overflow-y-auto pr-0.5">
                    {quickEpItems.map((item, idx) => {
                      const isQuickSwipedOpen = swipedQuickEpIdx === idx;
                      const activeQuickDragOffset =
                        quickEpSwipeTouchRef.current?.idx === idx ? swipedQuickEpOffset : (isQuickSwipedOpen ? -84 : 0);
                      const isItemNew = item.isNew !== false;

                      return (
                        <div
                          key={idx}
                          className="relative overflow-hidden rounded-md border border-dark-border/70 bg-[#050505] select-none"
                        >
                          {/* Menú deslizable oculto a la derecha */}
                          <div className="absolute inset-y-0 right-0 w-[84px] flex items-center justify-end gap-1 px-1.5 bg-[#0d0718] border-l border-purple-500/25 z-0">
                            <button
                              type="button"
                              onClick={() => handleToggleQuickEpNew(idx)}
                              className={`h-7 px-2 rounded flex-1 flex items-center justify-center gap-1 font-mono text-[10px] font-bold transition-all cursor-pointer select-none border ${
                                isItemNew
                                  ? 'bg-emerald-600 text-white border-emerald-400 shadow-sm shadow-emerald-600/30'
                                  : 'bg-[#140d24] text-neutral-400 border-neutral-800 hover:text-white hover:border-neutral-700'
                              }`}
                              title={isItemNew ? 'ON: Activo en Episodios Nuevos (Toca para desactivar)' : 'OFF: Oculto en Episodios Nuevos (Toca para activar)'}
                            >
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isItemNew ? 'bg-white animate-pulse' : 'bg-neutral-600'}`} />
                              <span>{isItemNew ? 'ON' : 'OFF'}</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => handleRemoveQuickEpField(idx)}
                              className="h-7 w-7 shrink-0 flex items-center justify-center bg-red-950/60 hover:bg-brand-red text-red-300 hover:text-white border border-red-500/30 rounded transition-colors cursor-pointer"
                              title="Eliminar este episodio"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>

                          {/* Fila frontal deslizable */}
                          <div
                            style={{
                              transform: `translateX(${activeQuickDragOffset}px)`,
                              transition: quickEpSwipeTouchRef.current?.idx === idx ? 'none' : 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)'
                            }}
                            onTouchStart={(e) => {
                              const t = e.touches[0];
                              if (!t) return;
                              const base = swipedQuickEpIdx === idx ? -84 : 0;
                              if (swipedQuickEpIdx !== null && swipedQuickEpIdx !== idx) {
                                setSwipedQuickEpIdx(null);
                              }
                              quickEpSwipeTouchRef.current = {
                                idx,
                                startX: t.clientX,
                                startY: t.clientY,
                                baseOffset: base,
                                lockedAxis: null
                              };
                              setSwipedQuickEpOffset(base);
                            }}
                            onTouchMove={(e) => {
                              const state = quickEpSwipeTouchRef.current;
                              if (!state || state.idx !== idx) return;
                              const t = e.touches[0];
                              if (!t) return;
                              const dx = t.clientX - state.startX;
                              const dy = t.clientY - state.startY;

                              if (!state.lockedAxis) {
                                if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
                                state.lockedAxis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
                              }
                              if (state.lockedAxis !== 'x') return;

                              const nextOffset = Math.max(-84, Math.min(0, state.baseOffset + dx));
                              setSwipedQuickEpOffset(nextOffset);
                            }}
                            onTouchEnd={() => {
                              const state = quickEpSwipeTouchRef.current;
                              if (!state || state.idx !== idx) return;
                              quickEpSwipeTouchRef.current = null;
                              if (swipedQuickEpOffset < -32) {
                                setSwipedQuickEpIdx(idx);
                                setSwipedQuickEpOffset(-84);
                              } else {
                                setSwipedQuickEpIdx(null);
                                setSwipedQuickEpOffset(0);
                              }
                            }}
                            className="relative z-10 flex items-center gap-1.5 bg-[#050505] p-1.5"
                          >
                            {/* Nº de Episodio ultra compacto */}
                            <div className="relative w-6 shrink-0">
                              <input
                                type="number"
                                min="1"
                                max="9999"
                                value={item.number}
                                onChange={(e) => handleUpdateQuickEpNumber(idx, e.target.value)}
                                className="w-full h-8 bg-[#100a1e] border border-purple-500/35 focus:border-purple-400 rounded px-0 text-center text-[11px] text-purple-200 font-mono font-bold outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                title={`Episodio #${item.number}`}
                              />
                              {isItemNew && (
                                <span
                                  className="pointer-events-none absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-[#050505]"
                                  title="ON"
                                />
                              )}
                            </div>

                            {/* Enlace del episodio ocupando todo el ancho */}
                            <input
                              ref={(el) => { quickEpInputRefs.current[idx] = el; }}
                              type="text"
                              value={item.url}
                              onChange={(e) => handleQuickItemUrlChange(idx, e.target.value)}
                              onFocus={() => {
                                if (isQuickSwipedOpen) {
                                  setSwipedQuickEpIdx(null);
                                  setSwipedQuickEpOffset(0);
                                }
                              }}
                              onPaste={(e) => {
                                const pasted = e.clipboardData.getData('text');
                                if (pasted) {
                                  handleQuickItemUrlChange(idx, pasted);
                                }
                              }}
                              placeholder={`Pegar enlace del ep. ${item.number} (.mp4)`}
                              className="flex-1 min-w-0 h-8 bg-[#0a0a0a] border border-dark-border focus:border-purple-500 rounded px-2 text-xs text-white placeholder-neutral-600 outline-none transition-colors font-mono"
                            />

                            {/* Botón miniatura compacto */}
                            <label
                              className={`h-8 w-8 shrink-0 flex items-center justify-center rounded cursor-pointer transition-all border group select-none ${
                                item.coverImage
                                  ? 'bg-emerald-950/40 border-emerald-500/60 text-emerald-400 hover:bg-emerald-900/50 shadow-sm'
                                  : 'bg-[#0a0a0a] border-dark-border hover:border-purple-500/60 text-neutral-400 hover:text-white'
                              }`}
                              title={item.coverImage ? 'Miniatura lista (clic para cambiar, clic derecho para quitar)' : 'Agregar miniatura al episodio'}
                              onContextMenu={(e) => {
                                if (item.coverImage) {
                                  e.preventDefault();
                                  setQuickEpItems(prev => {
                                    const updated = [...prev];
                                    updated[idx] = { ...updated[idx], coverImage: undefined };
                                    return updated;
                                  });
                                  showNotification(`Miniatura removida del Episodio ${item.number}`, 'success');
                                }
                              }}
                            >
                              <input
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  if (file) {
                                    const reader = new FileReader();
                                    reader.onload = (ev) => {
                                      const res = ev.target?.result as string;
                                      if (res) {
                                        setQuickEpItems(prev => {
                                          const updated = [...prev];
                                          updated[idx] = { ...updated[idx], coverImage: res };
                                          return updated;
                                        });
                                        showNotification(`Miniatura lista para el Episodio ${item.number}`, 'success');
                                      }
                                    };
                                    reader.readAsDataURL(file);
                                    e.target.value = '';
                                  }
                                }}
                              />
                              {item.coverImage ? (
                                <img src={item.coverImage} alt="Miniatura" className="w-full h-full object-cover rounded" />
                              ) : (
                                <Plus className="h-3.5 w-3.5 text-neutral-400 group-hover:text-purple-300 transition-colors" />
                              )}
                            </label>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Botón dinámico sin límite de 12 episodios */}
                  <button
                    type="button"
                    onClick={handleAddQuickEpField}
                    className="w-full py-2 bg-[#121212] hover:bg-[#1a1a1a] border border-purple-500/30 hover:border-purple-500/60 text-purple-300 hover:text-white rounded-lg font-mono text-xs font-semibold uppercase tracking-wider transition-all duration-200 flex items-center justify-center gap-1.5 cursor-pointer shadow-sm"
                  >
                    <Plus className="h-3.5 w-3.5 text-purple-400" />
                    <span>➕ Episodio {nextQuickEpNumber}</span>
                  </button>
                </div>

                {/* Target Anime Selector */}
                <div className="space-y-1.5">
                  <label className="font-mono text-[9.5px] text-neutral-300 uppercase tracking-widest block font-semibold">
                    Anime Destino *
                  </label>
                  <select
                    value={quickEpTargetAnimeId}
                    onChange={(e) => setQuickEpTargetAnimeId(e.target.value)}
                    className="w-full bg-[#050505] border border-dark-border focus:border-purple-500 rounded p-2.5 text-xs text-white outline-none transition-colors"
                  >
                    <option value="">-- Selecciona un anime --</option>
                    <option value="NEW_ANIME" className="text-purple-300 font-bold">
                      ✨ + Crear nuevo anime con este título: "{quickEpDetectedTitle || 'Sin Nombre'}"
                    </option>
                    <optgroup label="Animes Existentes en la Galería">
                      {animes.map(a => (
                        <option key={a.id} value={a.id}>
                          {a.name} ({a.episodes?.length || 0} episodios)
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </div>
              </div>

              {/* Modal Actions */}
              <div className="pt-3 flex items-center justify-end gap-3 border-t border-dark-border">
                <button
                  type="button"
                  onClick={() => setShowQuickAddEpModal(false)}
                  className="px-4 py-2 bg-[#111] hover:bg-neutral-800 text-neutral-400 hover:text-white rounded font-mono text-xs uppercase tracking-wider transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={isSavingQuickEp || !quickEpItems.some(it => it.url.trim() !== '')}
                  onClick={handleSaveQuickEpisode}
                  className="px-5 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded font-display font-medium text-xs tracking-wider uppercase transition-all duration-200 flex items-center gap-1.5 shadow-lg shadow-purple-600/30 cursor-pointer"
                >
                  <Save className="h-4 w-4" />
                  {isSavingQuickEp ? 'Guardando...' : `Guardar ${quickEpItems.filter(it => it.url.trim() !== '').length || 1} Episodio(s)`}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Floating Trash Bin Modal - Always centered in the middle of screen */}
        {showTrashModal && (
          <div className="fixed inset-0 z-[99999] bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
            <div 
              className="absolute inset-0" 
              onClick={() => setShowTrashModal(false)} 
            />
            <div className="relative z-10 bg-[#0e0818] border border-purple-900/60 rounded-2xl p-5 sm:p-6 max-w-md w-full shadow-[0_25px_60px_rgba(0,0,0,0.9)] space-y-4 animate-in fade-in zoom-in-95 duration-200">
              <div className="flex items-center justify-between border-b border-purple-950/80 pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-xl bg-red-950/50 border border-red-500/30 text-red-400">
                    <Trash2 className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="font-display font-bold text-sm sm:text-base text-white tracking-wide">
                      Papelera de Eliminados
                    </h3>
                    <p className="font-mono text-[10px] text-neutral-400">
                      {trashNames.length} {trashNames.length === 1 ? 'anime registrado' : 'animes registrados'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowTrashModal(false)}
                  className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors cursor-pointer"
                  title="Cerrar"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* List of names only */}
              <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-purple-900/60 scrollbar-track-transparent">
                {trashNames.length > 0 ? (
                  trashNames.map((name, idx) => (
                    <div
                      key={idx}
                      className="px-3 py-2 rounded-lg bg-[#140b24] border border-[#23153c] text-xs font-medium text-neutral-200 flex items-center gap-2 truncate"
                    >
                      <span className="font-mono text-[9px] text-purple-400 font-bold shrink-0">#{idx + 1}</span>
                      <span className="truncate">{name}</span>
                    </div>
                  ))
                ) : (
                  <div className="py-8 text-center space-y-2">
                    <Trash2 className="h-8 w-8 text-neutral-700 mx-auto" />
                    <p className="font-mono text-xs text-neutral-500">La papelera está vacía.</p>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="pt-2 border-t border-purple-950/80 flex items-center justify-between gap-3">
                <button
                  type="button"
                  disabled={trashNames.length === 0 || isClearingTrash}
                  onClick={handleEmptyTrash}
                  className="px-4 py-2 bg-red-600/90 hover:bg-red-600 disabled:opacity-40 disabled:hover:bg-red-600/90 text-white rounded-xl font-mono text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5 transition-all cursor-pointer shadow-md shadow-red-950/50 active:scale-95"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>{isClearingTrash ? 'Vaciando...' : 'Vaciar papelera'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => setShowTrashModal(false)}
                  className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 hover:text-white rounded-xl font-mono text-xs transition-colors cursor-pointer"
                >
                  Cerrar
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Global Real-Time Circular Progress Overlay (Circle + Percentage Only) */}
        {liveProgress && (
          <div className="fixed inset-0 z-[99999] bg-black/65 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
            <div
              className={`relative w-28 h-28 rounded-full flex items-center justify-center ${
                appTheme === 'black'
                  ? 'bg-black border border-neutral-800 shadow-[0_0_40px_rgba(0,0,0,0.95)]'
                  : 'bg-[#150d26] border border-purple-500/40 shadow-[0_0_40px_rgba(168,85,247,0.4)]'
              }`}
            >
              <div
                className={`absolute inset-1 rounded-full border-2 animate-spin ${
                  appTheme === 'black'
                    ? 'border-neutral-800 border-t-neutral-300'
                    : 'border-purple-500/20 border-t-purple-400'
                }`}
              />
              <svg className="w-24 h-24 -rotate-90 transform" viewBox="0 0 96 96">
                <circle
                  cx="48"
                  cy="48"
                  r="38"
                  fill="none"
                  stroke={appTheme === 'black' ? 'rgba(255,255,255,0.12)' : 'rgba(168,85,247,0.2)'}
                  strokeWidth="6"
                />
                <circle
                  cx="48"
                  cy="48"
                  r="38"
                  fill="none"
                  stroke={appTheme === 'black' ? '#ffffff' : '#a855f7'}
                  strokeWidth="6"
                  strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 38}
                  strokeDashoffset={2 * Math.PI * 38 * (1 - Math.max(0, Math.min(100, liveProgress.percent)) / 100)}
                  className="transition-all duration-200 ease-out"
                />
              </svg>
              <span className="absolute font-mono font-extrabold text-lg text-white select-none">
                {Math.round(liveProgress.percent)}%
              </span>
            </div>
          </div>
        )}

        {/* Custom Toast Notification */}
        {notification && (
          <div className="fixed bottom-6 right-6 bg-[#0c0c0c] border border-dark-border/80 rounded-lg p-4 shadow-[0_12px_40px_rgba(0,0,0,0.85)] z-[9999] flex items-center gap-3 animate-slide-up border-l-4 border-l-brand-red">
            <div className={`h-2.5 w-2.5 rounded-full shrink-0 ${notification.type === 'success' ? 'bg-emerald-500' : 'bg-brand-red'}`} />
            <p className="font-display text-xs text-white font-semibold tracking-wide">{notification.message}</p>
          </div>
        )}
      </main>
    </div>
  );
}
