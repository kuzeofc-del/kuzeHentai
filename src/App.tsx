/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo, useDeferredValue, useCallback } from 'react';
import { Studio, Genre, Anime, normalizeAnimeYear } from './types';
import { 
  requestPersistentStorage, 
  saveMyListToIDB, 
  getMyListFromIDB, 
  saveMyListAnimesToIDB,
  recordAdminCatalogMutation,
  applyRecentAdminMutations
} from './lib/idbStorage';
import { getStableDeviceId } from './lib/deviceFingerprint';
import { 
  cacheAnimesInMemory, 
  cacheStudiosInMemory, 
  cacheGenresInMemory, 
  getAllAnimesFromMemory, 
  getAnimeFromMemory, 
  removeAnimeFromMemory,
  setFullCatalogInMemoryLoaded,
  isFullCatalogInMemory
} from './lib/memoryCache';
import { auth, onAuthStateChanged, configureAuthPersistence, db, doc, getDoc, onSnapshot, isFirebaseConfigured } from './lib/firebase';
import { subscribeToRealtimeCatalog, mapFirestoreAnimeDoc } from './lib/realtimeCatalog';
import { User } from 'firebase/auth';
import { 
  addAnimeToUserList, 
  removeAnimeFromUserList, 
  subscribeToUserList, 
  syncLocalItemsToUserList,
  updateUserLastLogin,
  applyPendingUserListOps,
  cleanupInactiveUsers
} from './lib/userListService';
import {
  addAnimeToWatched,
  removeAnimeFromWatched,
  subscribeToUserWatched,
  syncLocalWatchedToUser,
  applyPendingUserWatchedOps
} from './lib/userWatchedService';
import GalleryCard from './components/GalleryCard';
import GalleryFilter, { GalleryDisplayMode } from './components/GalleryFilter';
import AnimeDetail from './components/AnimeDetail';
import FilterModal from './components/FilterModal';
import StudioDetailModal from './components/StudioDetailModal';
import GenreDetailModal from './components/GenreDetailModal';
import AuthModal from './components/AuthModal';
import UserProfileModal from './components/UserProfileModal';
import ReportIssueModal from './components/ReportIssueModal';
import WelcomeOnboardingModal from './components/WelcomeOnboardingModal';
import AnnouncementPostModal from './components/AnnouncementPostModal';
import PopularHeroCarousel from './components/PopularHeroCarousel';
import HorizontalSectionRow from './components/HorizontalSectionRow';
import DailyGenreSection from './components/DailyGenreSection';
import DailyStudiosSection from './components/DailyStudiosSection';
import { getRecommendedAnimes } from './utils/recommendationManager';

const AdminPanel = React.lazy(() => import('./components/AdminPanel'));
import { SmartAnimeCover, portadaUrl, processImageSrc, globalImageCache, preloadAllAnimes, preloadAnimeCover, getFallbackSvg, startPrioritizedAppLoading, prefetchAnime, prefetchCatalogPage } from './utils/imageFallback';
import { startCatalogIdlePreload } from './lib/coverCache';
import { normalizeEpisodesList } from './utils/episodeUtils';
import { enforceEpisodesRotation } from './utils/episodeRotation';
import { getAnimeRatingStats } from './utils/ratingManager';
import { computeHeroFeaturedAnimes, recordHeroAnimeView, computeDailyTop10Animes } from './utils/heroCycleManager';

const fingerprintMediaString = (str?: string): string => {
  if (!str) return '0';
  const len = str.length;
  if (len <= 120) return str;
  const mid = Math.floor(len / 2);
  return `${len}:${str.slice(0, 40)}:${str.slice(mid - 20, mid + 20)}:${str.slice(len - 40)}`;
};

const computeCatalogSignature = (list: Anime[]): string => {
  return [...list]
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((a) => {
      const epsSig = (a.episodes || [])
        .map((e) => `${e.number}:${Boolean(e.isNew)}:${e.addedToRecentAt || ''}:${e.mp4Url || ''}:${fingerprintMediaString(e.thumbnail || e.coverImage)}`)
        .join(',');
      return `${a.id}|${a.name}|${a.status || ''}|${a.releaseMonth || ''}|${a.year || ''}|${Boolean(a.hidden)}|${a.downloads || 0}|${a.updatedAt || ''}|${a.portadaVersion ?? ''}|${a.continuationType || ''}|${(a.continuationAnimeIds || []).join(',')}|${fingerprintMediaString(a.coverData)}|${fingerprintMediaString(a.image)}|${(a.genreIds || []).join(',')}|${(a.studioIds || []).join(',')}|${epsSig}`;
    })
    .join(';;');
};
import { 
  Search, Film, Info, Plus, ChevronDown, Check, Send, AlertCircle, 
  MapPin, Heart, ExternalLink, ShieldCheck, Shield, Zap, Lock, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
  SlidersHorizontal, X, RotateCcw, Menu, UserCheck, LogIn, Palette, Moon, Sparkles, Eye, Bookmark,
  Calendar, LayoutGrid, Trophy
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppTheme } from './lib/theme';

// Path to generated hero background
const heroBg = '/src/assets/images/hero_background_1784586062430.jpg';

// Items per page: 10 rows of 3 items in base view (30 items per page)
const ITEMS_PER_PAGE = 30;

// Custom SignIcon matching user image
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

import { 
  NormalizedAnimeData, 
  normalizeSearchText, 
  calculateRelevanceScore, 
  matchesFuzzySearch, 
  buildNormalizedAnimeData 
} from './utils/searchUtils';

export type PageType = 'home' | 'detail' | 'admin' | 'my-list' | 'watched' | 'studio' | 'genre';

export const isUpcomingStatus = (status?: string) => Boolean(
  status && (
    status === 'Próximamente' ||
    status.toLowerCase() === 'próximamente' ||
    status.toLowerCase() === 'proximamente'
  )
);

const isEmisionStatus = (status?: string) => Boolean(
  status && (
    status.toLowerCase().includes('emisi') ||
    status.toLowerCase().includes('emisión')
  ) && !isUpcomingStatus(status)
);

const ADMIN_EMAILS_LIST = ['kuzeofc@gmail.com', 'kuzehentai@gmail.com', 'metzelderkz@gmail.com'];
export const isAuthorizedAdminEmail = (email?: string | null): boolean =>
  Boolean(email && ADMIN_EMAILS_LIST.includes(email.toLowerCase().trim()));

// Limpieza de llaves obsoletas; cuando no hay base de datos Firebase conectada se purga todo rastro de caché previa
if (typeof window !== 'undefined') {
  try {
    const keysToCleanOnRestart = [
      'hk_guest_my_list',
      'hk_guest_my_list_ts',
      'kh_guest_watched_list',
      'kh_catalog_page',
      'kh_display_mode',
      'kh_studios_expanded',
      'hk_cached_animes',
      'hk_cached_studios',
      'hk_cached_genres',
      'hk_user_animes',
      'hk_user_studios',
      'hk_user_genres',
      'hk_deleted_studio_ids',
      'hk_deleted_genre_ids',
      'kh_report_chat_messages',
      'kh_recommendations_48h_v1'
    ];
    keysToCleanOnRestart.forEach((k) => {
      localStorage.removeItem(k);
      sessionStorage.removeItem(k);
    });

    if (!isFirebaseConfigured) {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (
          k !== 'kh_theme' &&
          (k.startsWith('kh_') || k.startsWith('hk_') || k.startsWith('firebase:') || k === 'cacheVersion')
        ) {
          localStorage.removeItem(k);
        }
      }
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const k = sessionStorage.key(i);
        if (!k) continue;
        if (k.startsWith('kh_') || k.startsWith('hk_') || k.startsWith('firebase:')) {
          sessionStorage.removeItem(k);
        }
      }
      if (typeof indexedDB !== 'undefined') {
        try { indexedDB.deleteDatabase('KuzeHentaiAppDB'); } catch {}
        try { indexedDB.deleteDatabase('firebaseLocalStorageDb'); } catch {}
      }
    }
  } catch (e) {}
}

interface CatalogSearchInputProps {
  query: string;
  onChangeQuery: (val: string) => void;
  onClear: () => void;
  isOpen: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

const CatalogSearchInput = React.memo(function CatalogSearchInput({
  query,
  onChangeQuery,
  onClear,
  isOpen,
  inputRef,
}: CatalogSearchInputProps) {
  const [localVal, setLocalVal] = useState(query);
  const debounceTimerRef = useRef<any>(null);

  useEffect(() => {
    setLocalVal(query);
  }, [query]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setLocalVal(val);
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      React.startTransition(() => {
        onChangeQuery(val);
      });
    }, 110);
  };

  const handleClear = () => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    setLocalVal('');
    onChangeQuery('');
    onClear();
  };

  return (
    <div className="relative flex-1">
      <div className="relative bg-[#090514] border border-[#2b1747] hover:border-purple-600/50 focus-within:border-purple-500 rounded-2xl p-1.5 flex items-center transition-colors duration-150 shadow-xl">
        <Search className="h-5 w-5 text-purple-400 ml-2.5 sm:ml-3 shrink-0" />
        <input
          ref={inputRef}
          type="text"
          tabIndex={isOpen ? 0 : -1}
          value={localVal}
          onChange={handleChange}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder="Buscar en el catálogo..."
          className="w-full bg-transparent px-2.5 sm:px-3 py-2 text-xs sm:text-sm text-white placeholder-white/70 outline-none font-sans"
        />
        {localVal && (
          <button
            type="button"
            onClick={handleClear}
            className="p-1.5 mr-1 text-white/70 hover:text-white transition-colors cursor-pointer shrink-0"
            title="Limpiar búsqueda"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
});

export default function App() {
  // Page routing state
  const [currentPage, setCurrentPage] = useState<PageType>('home');
  const [previousPage, setPreviousPage] = useState<PageType>('home');
  const [selectedStudio, setSelectedStudio] = useState<Studio | null>(null);
  const [selectedGenre, setSelectedGenre] = useState<Genre | null>(null);
  const [selectedAnimeId, setSelectedAnimeId] = useState<string>('');
  const [selectedEpisodeNum, setSelectedEpisodeNum] = useState<number | undefined>(undefined);
  const [navDirection, setNavDirection] = useState<number>(1);
  const [isDetailAnimating, setIsDetailAnimating] = useState<boolean>(false);

  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    if (!isFirebaseConfigured) return null;
    try {
      const cached = localStorage.getItem('kh_cached_user');
      if (cached) {
        return JSON.parse(cached);
      }
    } catch {}
    return null;
  });
  const [authLoading, setAuthLoading] = useState<boolean>(() => {
    if (!isFirebaseConfigured) return false;
    try {
      return !localStorage.getItem('kh_cached_user');
    } catch {
      return true;
    }
  });
  const [isCatalogSearchOpen, setIsCatalogSearchOpen] = useState<boolean>(false);
  const [catalogSearchQuery, setCatalogSearchQuery] = useState<string>('');
  const deferredCatalogSearchQuery = React.useDeferredValue(catalogSearchQuery);
  const [catalogSearchVisibleCount, setCatalogSearchVisibleCount] = useState<number>(18);
  const catalogSearchInputRef = useRef<HTMLInputElement>(null);
  const catalogSectionWrapperRef = useRef<HTMLDivElement>(null);

  const handleOpenCatalogSearch = useCallback(() => {
    setIsCatalogSearchOpen(true);
    setCatalogSearchVisibleCount(24);

    const scrollToCatalog = () => {
      const el = catalogSectionWrapperRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const currentY = window.pageYOffset || document.documentElement.scrollTop || 0;
        // Offset below sticky header so the search bar and the top results are immediately visible above mobile keyboard
        const targetY = Math.max(0, currentY + rect.top - 68);
        window.scrollTo({
          top: targetY,
          behavior: 'smooth'
        });
      }
    };

    scrollToCatalog();

    setTimeout(() => {
      catalogSearchInputRef.current?.focus({ preventScroll: true });
      scrollToCatalog();
    }, 70);

    setTimeout(scrollToCatalog, 250);
    setTimeout(scrollToCatalog, 480);
  }, []);

  const handleCloseCatalogSearch = useCallback(() => {
    catalogSearchInputRef.current?.blur();
    setIsCatalogSearchOpen(false);
    setCatalogSearchQuery('');
  }, []);

  const handleClearCatalogSearch = useCallback(() => {
    setCatalogSearchQuery('');
    catalogSearchInputRef.current?.focus({ preventScroll: true });
  }, []);

  // In-session "Mi Lista" state (hydrated synchronously on frame 0 so recommendations never swap after load)
  const [myListIds, setMyListIds] = useState<string[]>(() => {
    try {
      const cachedUserRaw = localStorage.getItem('kh_cached_user');
      if (cachedUserRaw) {
        const parsedUser = JSON.parse(cachedUserRaw);
        if (parsedUser?.uid) {
          const userCache = localStorage.getItem(`hk_user_my_list_${parsedUser.uid}`);
          const base = userCache ? JSON.parse(userCache) : [];
          return applyPendingUserListOps(parsedUser.uid, Array.isArray(base) ? base : []);
        }
      }
    } catch {}
    return [];
  });

  // In-session "Vistos" state (hydrated synchronously on frame 0 so recommendations never swap after load)
  const [watchedIds, setWatchedIds] = useState<string[]>(() => {
    try {
      const cachedUserRaw = localStorage.getItem('kh_cached_user');
      if (cachedUserRaw) {
        const parsedUser = JSON.parse(cachedUserRaw);
        if (parsedUser?.uid) {
          const userWatchedCache = localStorage.getItem(`kh_user_watched_${parsedUser.uid}`);
          const base = userWatchedCache ? JSON.parse(userWatchedCache) : [];
          return applyPendingUserWatchedOps(parsedUser.uid, Array.isArray(base) ? base : []);
        }
      }
    } catch {}
    return [];
  });

  // 1. Firebase Auth listener & Firestore User List Auto-Sync (100% Isolated per User)
  useEffect(() => {
    if (!auth || !isFirebaseConfigured) {
      setCurrentUser(null);
      setAuthLoading(false);
      setMyListIds([]);
      setWatchedIds([]);
      return;
    }

    let isMounted = true;

    // Safely configure auth persistence
    configureAuthPersistence().catch(() => {});

    let unsubscribeList: (() => void) | null = null;
    let unsubscribeWatched: (() => void) | null = null;

    const unsubscribeAuth = onAuthStateChanged(auth, async (user) => {
      if (!isMounted) return;
      setCurrentUser(user);
      setAuthLoading(false);
      try {
        if (user) {
          localStorage.setItem('kh_cached_user', JSON.stringify({
            uid: user.uid,
            email: user.email,
            displayName: user.displayName,
            photoURL: user.photoURL
          }));
        } else {
          localStorage.removeItem('kh_cached_user');
        }
      } catch {}

      if (unsubscribeList) {
        unsubscribeList();
        unsubscribeList = null;
      }
      if (unsubscribeWatched) {
        unsubscribeWatched();
        unsubscribeWatched = null;
      }

      if (user) {
        if (!isAuthorizedAdminEmail(user.email)) {
          try {
            localStorage.removeItem('hk_admin_token');
          } catch (e) {}
        }

        // Load user theme preference
        try {
          const userSavedTheme = localStorage.getItem(`kh_theme_${user.uid}`);
          if (userSavedTheme === 'default' || userSavedTheme === 'black') {
            setAppTheme(userSavedTheme as any, user.uid);
          } else if (db) {
            getDoc(doc(db, 'users', user.uid)).then(snap => {
              if (snap.exists()) {
                const uTheme = snap.data()?.theme;
                if (uTheme === 'default' || uTheme === 'black') {
                  setAppTheme(uTheme, user.uid);
                }
              }
            }).catch(() => {});
          }
        } catch (e) {}

        // Show welcome onboarding walkthrough if this account just registered
        try {
          if (localStorage.getItem(`kh_show_welcome_${user.uid}`) === 'true' && localStorage.getItem(`kh_onboarding_done_${user.uid}`) !== 'true') {
            setIsWelcomeModalOpen(true);
          }
        } catch (e) {}

        // Immediately load user-specific cached list for fast render (including any pending ops)
        try {
          const userCache = localStorage.getItem(`hk_user_my_list_${user.uid}`);
          const parsed = userCache ? JSON.parse(userCache) : [];
          setMyListIds(applyPendingUserListOps(user.uid, Array.isArray(parsed) ? parsed : []));
        } catch (e) {
          setMyListIds(applyPendingUserListOps(user.uid, []));
        }

        // Immediately load user-specific cached watched list (including any pending ops)
        try {
          const userWatchedCache = localStorage.getItem(`kh_user_watched_${user.uid}`);
          const parsed = userWatchedCache ? JSON.parse(userWatchedCache) : [];
          setWatchedIds(applyPendingUserWatchedOps(user.uid, Array.isArray(parsed) ? parsed : []));
        } catch (e) {
          setWatchedIds(applyPendingUserWatchedOps(user.uid, []));
        }

        // Update last login timestamp safely in background
        updateUserLastLogin(user.uid, user.email, user.displayName).catch(() => {});

        // Sync ONLY guest items if the user created items while logged out in guest mode
        try {
          const savedGuest = localStorage.getItem('hk_guest_my_list');
          if (savedGuest) {
            const guestIds: string[] = JSON.parse(savedGuest);
            if (guestIds.length > 0) {
              await syncLocalItemsToUserList(user.uid, guestIds);
            }
            localStorage.removeItem('hk_guest_my_list');
          }
          // Remove old legacy shared key so it can't contaminate any account
          localStorage.removeItem('hk_my_list');
        } catch (e) {}

        // Sync guest watched items if any
        try {
          const savedGuestWatched = localStorage.getItem('kh_guest_watched_list');
          if (savedGuestWatched) {
            const guestWatchedIds: string[] = JSON.parse(savedGuestWatched);
            if (guestWatchedIds.length > 0) {
              await syncLocalWatchedToUser(user.uid, guestWatchedIds);
            }
            localStorage.removeItem('kh_guest_watched_list');
          }
        } catch (e) {}

        // Priority 1: Subscribe to Firebase account list with real-time sync
        unsubscribeList = subscribeToUserList(user.uid, (validAnimeIds) => {
          if (!isMounted) return;
          setMyListIds(prev => {
            if (prev.length === validAnimeIds.length && prev.every((id, idx) => id === validAnimeIds[idx])) {
              return prev;
            }
            return validAnimeIds;
          });
          try {
            localStorage.setItem(`hk_user_my_list_${user.uid}`, JSON.stringify(validAnimeIds));
          } catch (e) {}
          saveMyListToIDB(validAnimeIds, user.uid);
        });

        // Priority 2: Subscribe to Firebase watched list with real-time sync across devices
        unsubscribeWatched = subscribeToUserWatched(user.uid, (animeIds) => {
          if (!isMounted) return;
          setWatchedIds(prev => {
            if (prev.length === animeIds.length && prev.every((id, idx) => id === animeIds[idx])) {
              return prev;
            }
            return animeIds;
          });
          try {
            localStorage.setItem(`kh_user_watched_${user.uid}`, JSON.stringify(animeIds));
          } catch (e) {}
        });
      } else {
        // User logged out: clear state and guest cache so no account leakage happens
        localStorage.removeItem('hk_guest_my_list');
        localStorage.removeItem('hk_my_list');
        localStorage.removeItem('kh_guest_watched_list');
        localStorage.removeItem('hk_admin_token');
        setMyListIds([]);
        setWatchedIds([]);
      }
    });

    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    requestPersistentStorage();

    return () => {
      isMounted = false;
      unsubscribeAuth();
      if (unsubscribeList) {
        unsubscribeList();
      }
      if (unsubscribeWatched) {
        unsubscribeWatched();
      }
    };
  }, []);

  const handleToggleWatched = (animeId: string) => {
    const uid = auth?.currentUser?.uid || currentUser?.uid;
    if (!uid) {
      window.dispatchEvent(new CustomEvent('kh_open_auth_modal', { detail: { mode: 'register' } }));
      return;
    }
    setWatchedIds(prev => {
      const exists = prev.includes(animeId);
      const updated = exists ? prev.filter(id => id !== animeId) : [...prev, animeId];

      try {
        localStorage.setItem(`kh_user_watched_${uid}`, JSON.stringify(updated));
      } catch (e) {}

      if (exists) {
        removeAnimeFromWatched(uid, animeId).catch(() => {});
      } else {
        addAnimeToWatched(uid, animeId).catch(() => {});
      }

      return updated;
    });
  };

  const handleToggleMyList = (animeId: string) => {
    const uid = auth?.currentUser?.uid || currentUser?.uid;
    if (!uid) {
      window.dispatchEvent(new CustomEvent('kh_open_auth_modal', { detail: { mode: 'register' } }));
      return;
    }
    setMyListIds(prev => {
      const exists = prev.includes(animeId);
      const updated = exists ? prev.filter(id => id !== animeId) : [...prev, animeId];

      try {
        localStorage.setItem(`hk_user_my_list_${uid}`, JSON.stringify(updated));
      } catch (e) {}

      if (exists) {
        removeAnimeFromUserList(uid, animeId);
      } else {
        addAnimeToUserList(uid, animeId);
      }
      saveMyListToIDB(updated, uid);
      const myListAnimes = animes.filter(a => updated.includes(a.id));
      saveMyListAnimesToIDB(myListAnimes, uid);

      return updated;
    });
  };

  // Database lists state
  const [studios, setStudios] = useState<Studio[]>([]);
  const [genres, setGenres] = useState<Genre[]>([]);
  const [animes, setAnimes] = useState<Anime[]>([]);
  const [directLoadedAnime, setDirectLoadedAnime] = useState<Anime | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // Search & Filters state
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const studioPageRef = useRef<number>(1);
  const studioScrollRef = useRef<number>(0);
  const studioSortRef = useRef<string>('date-desc');
  const studiosRef = useRef<Studio[]>(studios);
  studiosRef.current = studios;
  const selectedStudioRef = useRef<Studio | null>(selectedStudio);
  selectedStudioRef.current = selectedStudio;
  const genrePageRef = useRef<number>(1);
  const genreScrollRef = useRef<number>(0);
  const genreSortRef = useRef<string>('date-desc');
  const genresRef = useRef<Genre[]>(genres);
  genresRef.current = genres;
  const selectedGenreRef = useRef<Genre | null>(selectedGenre);
  selectedGenreRef.current = selectedGenre;
  const animesRef = useRef<Anime[]>(animes);
  animesRef.current = animes;
  const hasInAppHistoryRef = useRef<boolean>(false);
  const [selectedStudioId, setSelectedStudioId] = useState('');
  const [selectedGenreIds, setSelectedGenreIds] = useState<string[]>([]);
  const [selectedYear, setSelectedYear] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [selectedRating, setSelectedRating] = useState('');
  const [sortBy, setSortBy] = useState<string>('random');
  const [displayMode, setDisplayMode] = useState<GalleryDisplayMode>('sections');
  const [page, setPage] = useState<number>(1);

  const handleToggleDisplayMode = (mode: GalleryDisplayMode) => {
    setDisplayMode(mode);
    try {
      localStorage.setItem('kh_display_mode', mode);
    } catch {}
    if (mode === 'catalog') {
      try {
        const savedPage = localStorage.getItem('kh_catalog_page');
        const parsed = parseInt(savedPage || '1', 10);
        if (!isNaN(parsed) && parsed >= 1) {
          setPage(parsed);
        }
      } catch {}
    }
  };
  const [isFilterModalOpen, setIsFilterModalOpen] = useState(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState<'login' | 'register'>('register');
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [isReportModalOpen, setIsReportModalOpen] = useState(false);
  const [isWelcomeModalOpen, setIsWelcomeModalOpen] = useState(false);
  const [myListTab, setMyListTab] = useState<'saved' | 'watched'>('saved');
  const [appTheme, setAppTheme] = useAppTheme();

  const handleUserUpdated = () => {
    if (auth?.currentUser) {
      setCurrentUser(Object.assign(Object.create(Object.getPrototypeOf(auth.currentUser)), auth.currentUser));
    }
  };

  const handleLogout = async () => {
    setMyListIds([]);
    setWatchedIds([]);
    try {
      localStorage.removeItem('hk_guest_my_list');
      localStorage.removeItem('hk_my_list');
      localStorage.removeItem('kh_guest_watched_list');
      localStorage.removeItem('kh_cached_user');
      localStorage.removeItem('hk_admin_token');
    } catch (e) {}
    setCurrentUser(null);
    if (auth) {
      await auth.signOut().catch(() => {});
    }
  };
  const [pageDirection, setPageDirection] = useState<number>(1);
  const [genreUsageMap, setGenreUsageMap] = useState<Record<string, number>>({});

  // Persistent studio filter expansion across route navigation & reloads
  const [isStudiosExpanded, setIsStudiosExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem('kh_studios_expanded') === 'true';
    } catch {
      return false;
    }
  });

  const handleToggleStudiosExpanded = useCallback(() => {
    setIsStudiosExpanded(prev => {
      const next = !prev;
      try {
        localStorage.setItem('kh_studios_expanded', String(next));
      } catch {}
      return next;
    });
  }, []);

  // Listen for custom event to open auth modal when guest tries to perform user actions
  useEffect(() => {
    const handleOpenAuth = (e: Event) => {
      const customEvent = e as CustomEvent<{ mode?: 'login' | 'register' }>;
      const mode = customEvent?.detail?.mode || 'register';
      setAuthModalMode(mode);
      setIsAuthModalOpen(true);
    };
    window.addEventListener('kh_open_auth_modal', handleOpenAuth);
    return () => window.removeEventListener('kh_open_auth_modal', handleOpenAuth);
  }, []);

  // Listen for custom event when a user registers for the first time to open the Welcome Onboarding Modal
  useEffect(() => {
    const handleTriggerWelcome = () => {
      setIsWelcomeModalOpen(true);
    };
    window.addEventListener('kh_trigger_welcome_onboarding', handleTriggerWelcome);
    return () => window.removeEventListener('kh_trigger_welcome_onboarding', handleTriggerWelcome);
  }, []);

  const [ratingVersion, setRatingVersion] = useState(0);
  useEffect(() => {
    let timeout: any = null;
    const handleRatingUpdate = () => {
      if (timeout) return;
      timeout = setTimeout(() => {
        timeout = null;
        setRatingVersion(v => v + 1);
      }, 100);
    };
    window.addEventListener('kh_rating_updated', handleRatingUpdate);
    window.addEventListener('kh_ratings_updated', handleRatingUpdate);
    return () => {
      window.removeEventListener('kh_rating_updated', handleRatingUpdate);
      window.removeEventListener('kh_ratings_updated', handleRatingUpdate);
      if (timeout) clearTimeout(timeout);
    };
  }, []);

  const [heroCycleVersion, setHeroCycleVersion] = useState(0);
  useEffect(() => {
    const handleHeroUpdate = () => setHeroCycleVersion(v => v + 1);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        setHeroCycleVersion(v => v + 1);
      }
    };
    window.addEventListener('kh_hero_cycle_updated', handleHeroUpdate);
    window.addEventListener('focus', handleHeroUpdate);
    document.addEventListener('visibilitychange', handleVisibility);
    const interval = setInterval(() => {
      setHeroCycleVersion(v => v + 1);
    }, 60000);
    return () => {
      window.removeEventListener('kh_hero_cycle_updated', handleHeroUpdate);
      window.removeEventListener('focus', handleHeroUpdate);
      document.removeEventListener('visibilitychange', handleVisibility);
      clearInterval(interval);
    };
  }, []);


  // Reset page to 1 only when search or filters change, NOT when toggling displayMode or navigating
  useEffect(() => {
    setPageDirection(1);
    setPage(1);
    try {
      localStorage.setItem('kh_catalog_page', '1');
    } catch {}
  }, [searchQuery, selectedStudioId, selectedGenreIds, selectedYear, selectedStatus, selectedRating, sortBy]);

  // Optimistic local state update helper when AdminPanel mutates an anime (onSnapshot syncs server automatically)
  const applyOptimisticCatalogUpdate = useCallback((updatedAnime?: Anime | Anime[], deletedId?: string) => {
    if (deletedId) {
      removeAnimeFromMemory(deletedId);
      setAnimes(prev => prev.filter(a => a.id !== deletedId));
    }
    if (updatedAnime) {
      cacheAnimesInMemory(updatedAnime);
      setAnimes(prev => {
        const list = Array.isArray(updatedAnime) ? updatedAnime : [updatedAnime];
        const map = new Map<string, Anime>();
        const prevMap = new Map<string, Anime>(prev.map(a => [a.id, a]));
        const promotedIds = new Set<string>();

        list.forEach(item => {
          if (item && item.id) {
            const oldAnime = prevMap.get(item.id);
            if (oldAnime && isUpcomingStatus(oldAnime.status) && !isUpcomingStatus(item.status)) {
              promotedIds.add(item.id);
            }
          }
        });

        prev.forEach(a => {
          if (!promotedIds.has(a.id)) {
            map.set(a.id, a);
          }
        });

        list.forEach(item => {
          if (item && item.id) {
            if (promotedIds.has(item.id)) {
              map.delete(item.id);
            }
            map.set(item.id, {
              ...item,
              episodes: normalizeEpisodesList(item.episodes)
            });
          }
        });
        return Array.from(map.values());
      });
    }
  }, []);

  // Real-time Firestore catalog subscription (shows locally cached data first, even offline, then syncs server updates)
  useEffect(() => {
    let isCancelled = false;
    let hasPreloadedHero = false;

    const unsubCatalog = subscribeToRealtimeCatalog({
      onAnimesUpdate: (nextAnimes) => {
        if (isCancelled) return;
        const normalizedAnimes = applyRecentAdminMutations(nextAnimes);
        const isUnchanged =
          animesRef.current.length > 0 &&
          computeCatalogSignature(animesRef.current) === computeCatalogSignature(normalizedAnimes);

        if (!isUnchanged) {
          cacheAnimesInMemory(normalizedAnimes);
          setAnimes(normalizedAnimes);
          if (!hasPreloadedHero && normalizedAnimes.length > 0) {
            hasPreloadedHero = true;
            startPrioritizedAppLoading(normalizedAnimes, studiosRef.current);
          }
        }
        setLoading(false);
      },
      onStudiosUpdate: (nextStudios) => {
        if (isCancelled) return;
        cacheStudiosInMemory(nextStudios);
        const prevSig = studiosRef.current.map(s => `${s.id}:${s.name}:${(s.image || '').length}`).join('|');
        const nextSig = nextStudios.map(s => `${s.id}:${s.name}:${(s.image || '').length}`).join('|');
        if (prevSig !== nextSig || studiosRef.current.length === 0) {
          setStudios(nextStudios);
        }
      },
      onGenresUpdate: (nextGenres) => {
        if (isCancelled) return;
        cacheGenresInMemory(nextGenres);
        const prevSig = genresRef.current.map(g => `${g.id}:${g.name}:${(g.image || '').length}`).join('|');
        const nextSig = nextGenres.map(g => `${g.id}:${g.name}:${(g.image || '').length}`).join('|');
        if (prevSig !== nextSig || genresRef.current.length === 0) {
          setGenres(nextGenres);
        }
      },
      onInitialReady: () => {
        if (!isCancelled) {
          setLoading(false);
        }
      }
    });

    // Safety timeout: fast if offline with empty cache, generous if online first-time sync is still downloading
    const isDeviceOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const offlineSafetyTimer = setTimeout(() => {
      if (!isCancelled) {
        setLoading(false);
      }
    }, isDeviceOffline ? 2500 : 120000);

    // Recover scroll/animation cleanly when returning to the browser tab
    const handleAppResume = () => {
      if (document.visibilityState === 'hidden') return;
      document.body.style.overflow = '';
      setIsDetailAnimating(false);
    };
    window.addEventListener('pageshow', handleAppResume);
    document.addEventListener('visibilitychange', handleAppResume);

    const resolveStudioFromPath = (path: string, state?: any): Studio | null => {
      let id = '';
      if (path.startsWith('/estudio/')) {
        id = path.split('/')[2];
      } else if (state?.studioId) {
        id = state.studioId;
      }
      if (!id) return null;

      if (selectedStudioRef.current && (selectedStudioRef.current.id === id || selectedStudioRef.current.name === decodeURIComponent(id))) {
        return selectedStudioRef.current;
      }

      const found = studiosRef.current.find(s => s.id === id || s.name === decodeURIComponent(id));
      if (found) return found;

      try {
        const raw = sessionStorage.getItem('kh_last_studio');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && (parsed.id === id || parsed.name === decodeURIComponent(id))) {
            return parsed;
          }
        }
      } catch {}

      return { id, name: decodeURIComponent(id) };
    };

    const resolveGenreFromPath = (path: string, state?: any): Genre | null => {
      let id = '';
      if (path.startsWith('/genero/')) {
        id = path.split('/')[2];
      } else if (state?.genreId) {
        id = state.genreId;
      }
      if (!id) return null;

      if (selectedGenreRef.current && (selectedGenreRef.current.id === id || selectedGenreRef.current.name === decodeURIComponent(id))) {
        return selectedGenreRef.current;
      }

      const found = genresRef.current.find(g => g.id === id || g.name === decodeURIComponent(id));
      if (found) return found;

      try {
        const raw = sessionStorage.getItem('kh_last_genre');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && (parsed.id === id || parsed.name === decodeURIComponent(id))) {
            return parsed;
          }
        }
      } catch {}

      return { id, name: decodeURIComponent(id) };
    };

    const handleInitialPath = () => {
      const path = window.location.pathname;
      if (path.startsWith('/anime/')) {
        const rawId = path.replace(/^\/anime\//, '').split('/')[0];
        const id = rawId ? decodeURIComponent(rawId).trim() : '';
        if (id) {
          setSelectedAnimeId(id);
          setCurrentPage('detail');
        } else {
          setCurrentPage('home');
        }
      } else if (path === '/admin') {
        setCurrentPage('admin');
      } else if (path === '/mi-lista') {
        setMyListTab('saved');
        setCurrentPage('my-list');
      } else if (path === '/vistos') {
        setMyListTab('watched');
        setCurrentPage('my-list');
      } else if (path.startsWith('/estudio/')) {
        const st = resolveStudioFromPath(path);
        if (st) {
          setSelectedStudio(st);
          setCurrentPage('studio');
        } else {
          setCurrentPage('home');
        }
      } else if (path.startsWith('/genero/')) {
        const gn = resolveGenreFromPath(path);
        if (gn) {
          setSelectedGenre(gn);
          setCurrentPage('genre');
        } else {
          setCurrentPage('home');
        }
      } else {
        setCurrentPage('home');
      }
    };

    handleInitialPath();

    const handlePopState = (e: PopStateEvent) => {
      const state = e.state;
      const path = window.location.pathname;

      if (path.startsWith('/estudio/') || (state && state.page === 'studio')) {
        const st = resolveStudioFromPath(path, state);
        const stId = st?.id || path.split('/')[2] || '';

        let restoredPage = 1;
        try {
          const storedP = sessionStorage.getItem('kh_studio_page_' + stId);
          if (storedP) restoredPage = parseInt(storedP, 10) || 1;
        } catch {}
        if (state?.studioPage && !sessionStorage.getItem('kh_studio_page_' + stId)) {
          restoredPage = state.studioPage;
        }
        studioPageRef.current = restoredPage;

        let restoredSort = 'date-desc';
        try {
          const storedS = sessionStorage.getItem('kh_studio_sort_' + stId);
          if (storedS) restoredSort = storedS;
        } catch {}
        if (state?.studioSort && !sessionStorage.getItem('kh_studio_sort_' + stId)) {
          restoredSort = state.studioSort;
        }
        studioSortRef.current = restoredSort;

        let restoredScroll = 0;
        try {
          const storedY = sessionStorage.getItem('kh_studio_scroll_' + stId);
          if (storedY) restoredScroll = parseInt(storedY, 10) || 0;
        } catch {}
        if (state?.studioScrollY !== undefined && !sessionStorage.getItem('kh_studio_scroll_' + stId)) {
          restoredScroll = state.studioScrollY;
        }
        studioScrollRef.current = restoredScroll;

        if (st) {
          setSelectedStudio(st);
          setNavDirection(-1);
          setCurrentPage('studio');
          return;
        }
      }

      if (path.startsWith('/genero/') || (state && state.page === 'genre')) {
        const gn = resolveGenreFromPath(path, state);
        const gnId = gn?.id || path.split('/')[2] || '';

        let restoredPage = 1;
        try {
          const storedP = sessionStorage.getItem('kh_genre_page_' + gnId);
          if (storedP) restoredPage = parseInt(storedP, 10) || 1;
        } catch {}
        if (state?.genrePage && !sessionStorage.getItem('kh_genre_page_' + gnId)) {
          restoredPage = state.genrePage;
        }
        genrePageRef.current = restoredPage;

        let restoredSort = 'date-desc';
        try {
          const storedS = sessionStorage.getItem('kh_genre_sort_' + gnId);
          if (storedS) restoredSort = storedS;
        } catch {}
        if (state?.genreSort && !sessionStorage.getItem('kh_genre_sort_' + gnId)) {
          restoredSort = state.genreSort;
        }
        genreSortRef.current = restoredSort;

        let restoredScroll = 0;
        try {
          const storedY = sessionStorage.getItem('kh_genre_scroll_' + gnId);
          if (storedY) restoredScroll = parseInt(storedY, 10) || 0;
        } catch {}
        if (state?.genreScrollY !== undefined && !sessionStorage.getItem('kh_genre_scroll_' + gnId)) {
          restoredScroll = state.genreScrollY;
        }
        genreScrollRef.current = restoredScroll;

        if (gn) {
          setSelectedGenre(gn);
          setNavDirection(-1);
          setCurrentPage('genre');
          return;
        }
      }

      handleInitialPath();
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      isCancelled = true;
      unsubCatalog();
      clearTimeout(offlineSafetyTimer);
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('pageshow', handleAppResume);
      document.removeEventListener('visibilitychange', handleAppResume);
    };
  }, []);

  // Real-time per-anime document subscription (cache-first + server sync for /anime/<id>)
  useEffect(() => {
    if (currentPage !== 'detail' || !selectedAnimeId || !db || !isFirebaseConfigured) {
      if (currentPage !== 'detail') {
        setDirectLoadedAnime(null);
      }
      return;
    }

    const animeDocRef = doc(db, 'animes', selectedAnimeId);
    const unsubscribeAnimeDoc = onSnapshot(
      animeDocRef,
      { includeMetadataChanges: false },
      (snap) => {
        const fromCache = snap.metadata.fromCache;
        if (snap.exists()) {
          setDirectLoadedAnime(mapFirestoreAnimeDoc(snap));
        } else if (!fromCache) {
          setDirectLoadedAnime(null);
        }
      },
      (err) => {
        console.warn('[AnimeDetail Realtime Sync]:', err?.message || err);
      }
    );

    return () => unsubscribeAnimeDoc();
  }, [currentPage, selectedAnimeId]);



  // Protection for /admin route: Only authenticated users with admin email can access
  useEffect(() => {
    if (currentPage === 'admin' && !authLoading) {
      const isAuthorizedAdmin = isAuthorizedAdminEmail(currentUser?.email);
      if (!isAuthorizedAdmin) {
        setCurrentPage('home');
        window.history.replaceState(null, '', '/');
      }
    }
  }, [currentPage, currentUser, authLoading]);

  // Dynamic SEO Document Title update based on current page / selected anime
  useEffect(() => {
    if (currentPage === 'detail' && selectedAnimeId) {
      const anime = animes.find(a => a.id === selectedAnimeId);
      if (anime) {
        document.title = `${anime.name} - KuzeHentai | Anime Hentai Subtitulado en Español`;
      } else {
        document.title = `Anime Hentai - KuzeHentai`;
      }
    } else if (currentPage === 'admin') {
      document.title = `Panel Administrador - KuzeHentai`;
    } else if (currentPage === 'my-list') {
      document.title = `Mi Lista - KuzeHentai`;
    } else if (currentPage === 'watched') {
      document.title = `Animes Vistos - KuzeHentai`;
    } else if (currentPage === 'studio' && selectedStudio) {
      document.title = `${selectedStudio.name} - KuzeHentai | Catálogo del Estudio`;
    } else if (currentPage === 'genre' && selectedGenre) {
      document.title = `${selectedGenre.name} - KuzeHentai | Catálogo por Género`;
    } else {
      document.title = `KuzeHentai - Catálogo Hentai Subtitulado en Español | Anime Hentai`;
    }
  }, [currentPage, selectedAnimeId, selectedStudio, selectedGenre, animes]);

  // Scroll position & cover reference tracking for fluid gallery restoration
  const savedScrollPos = useRef<number>(0);
  const lastViewedAnimeId = useRef<string>('');

  // Lightweight, ultra-smooth and fast requestAnimationFrame scroll helper
  const smoothScrollTo = (targetY: number, duration = 220) => {
    const startY = window.scrollY || document.documentElement.scrollTop;
    const difference = targetY - startY;
    if (Math.abs(difference) < 4) {
      window.scrollTo(0, targetY);
      return;
    }

    const startTime = performance.now();
    // Ease-out expo curve for instant responsive movement and rapid arrival
    const easeOutExpo = (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));

    const step = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const easedProgress = easeOutExpo(progress);

      window.scrollTo(0, startY + difference * easedProgress);

      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        window.scrollTo(0, targetY);
      }
    };

    requestAnimationFrame(step);
  };

  // Custom router navigation function with smooth position restoration
  const navigateTo = (
    nextPage: PageType,
    animeId = '',
    episodeNum?: number,
    studio?: Studio | null,
    originPage?: PageType,
    explicitDirection?: 1 | -1,
    genre?: Genre | null
  ) => {
    const prev = originPage !== undefined ? originPage : currentPage;
    setPreviousPage(prev);

    if (nextPage === 'admin') {
      const isAuthorizedAdmin = isAuthorizedAdminEmail(currentUser?.email);
      if (!isAuthorizedAdmin) {
        setCurrentPage('home');
        window.history.replaceState(null, '', '/');
        return;
      }
    }

    let dir: 1 | -1 = 1;
    if (explicitDirection !== undefined) {
      dir = explicitDirection;
    } else if (nextPage === 'home') {
      dir = -1;
    } else if (prev === 'detail' && (nextPage === 'studio' || nextPage === 'genre' || nextPage === 'my-list' || nextPage === 'watched')) {
      dir = -1;
    } else if (nextPage === 'detail' || nextPage === 'my-list' || nextPage === 'watched' || nextPage === 'admin' || nextPage === 'studio' || nextPage === 'genre') {
      dir = 1;
    }
    setNavDirection(dir);

    if (studio !== undefined) {
      if (studio && studio.id !== selectedStudio?.id) {
        studioPageRef.current = 1;
        studioScrollRef.current = 0;
        studioSortRef.current = 'date-desc';
        try {
          sessionStorage.removeItem('kh_studio_scroll_' + studio.id);
          sessionStorage.removeItem('kh_studio_page_' + studio.id);
          sessionStorage.removeItem('kh_studio_sort_' + studio.id);
        } catch {}
      }
      setSelectedStudio(studio);
      if (studio) {
        try {
          sessionStorage.setItem('kh_last_studio', JSON.stringify(studio));
        } catch {}
      }
    } else if (nextPage === 'home' || nextPage === 'my-list' || nextPage === 'watched' || nextPage === 'genre') {
      setSelectedStudio(null);
    }

    if (genre !== undefined) {
      if (genre && genre.id !== selectedGenre?.id) {
        genrePageRef.current = 1;
        genreScrollRef.current = 0;
        genreSortRef.current = 'date-desc';
        try {
          sessionStorage.removeItem('kh_genre_scroll_' + genre.id);
          sessionStorage.removeItem('kh_genre_page_' + genre.id);
          sessionStorage.removeItem('kh_genre_sort_' + genre.id);
        } catch {}
      }
      setSelectedGenre(genre);
      if (genre) {
        try {
          sessionStorage.setItem('kh_last_genre', JSON.stringify(genre));
        } catch {}
      }
    } else if (nextPage === 'home' || nextPage === 'my-list' || nextPage === 'watched' || nextPage === 'studio') {
      setSelectedGenre(null);
    }

    // Save current scroll Y and anime ID when entering detail view
    if (nextPage === 'detail') {
      setIsDetailAnimating(true);
      if (prev !== 'detail') {
        savedScrollPos.current = window.scrollY || document.documentElement.scrollTop;
      }
      if (animeId) {
        lastViewedAnimeId.current = animeId;
      }
    } else if (nextPage === 'my-list') {
      setTimeout(() => {
        const savedAnimes = animes.filter(a => myListIds.includes(a.id));
        preloadAllAnimes(savedAnimes, studios);
      }, 300);
    } else if (nextPage === 'watched') {
      setTimeout(() => {
        const watchedAnimes = animes.filter(a => watchedIds.includes(a.id));
        preloadAllAnimes(watchedAnimes, studios);
      }, 300);
    } else if (prev === 'detail') {
      setIsDetailAnimating(true);
    }

    if (nextPage === 'watched') {
      setMyListTab('watched');
      setCurrentPage('my-list');
    } else if (nextPage === 'my-list') {
      if (prev !== 'my-list') {
        setMyListTab('saved');
      }
      setCurrentPage('my-list');
    } else {
      setCurrentPage(nextPage);
    }
    setSelectedAnimeId(animeId);
    setSelectedEpisodeNum(episodeNum);
    
    if (nextPage === 'detail' && animeId) {
      setTimeout(() => {
        recordHeroAnimeView(animeId);
      }, 500);
    }
    
    let path = '/';
    let histState: any = { page: nextPage };

    if (nextPage === 'detail') {
      path = `/anime/${animeId}`;
      histState = {
        page: 'detail',
        animeId,
        originPage: prev,
        studioId: studio?.id || selectedStudio?.id || '',
        studioPage: studioPageRef.current,
        studioSort: studioSortRef.current,
        studioScrollY: studioScrollRef.current,
        genreId: genre?.id || selectedGenre?.id || '',
        genrePage: genrePageRef.current,
        genreSort: genreSortRef.current,
        genreScrollY: genreScrollRef.current
      };
    } else if (nextPage === 'admin') {
      path = '/admin';
      histState = { page: 'admin' };
    } else if (nextPage === 'my-list') {
      path = '/mi-lista';
      histState = { page: 'my-list' };
    } else if (nextPage === 'watched') {
      path = '/vistos';
      histState = { page: 'watched' };
    } else if (nextPage === 'studio') {
      const targetStudio = studio || selectedStudio;
      path = `/estudio/${targetStudio?.id || ''}`;
      if (targetStudio) {
        try {
          sessionStorage.setItem('kh_last_studio', JSON.stringify(targetStudio));
        } catch {}
      }
      histState = {
        page: 'studio',
        studioId: targetStudio?.id || '',
        studioPage: studioPageRef.current,
        studioSort: studioSortRef.current,
        studioScrollY: studioScrollRef.current
      };
    } else if (nextPage === 'genre') {
      const targetGenre = genre || selectedGenre;
      path = `/genero/${targetGenre?.id || ''}`;
      if (targetGenre) {
        try {
          sessionStorage.setItem('kh_last_genre', JSON.stringify(targetGenre));
        } catch {}
      }
      histState = {
        page: 'genre',
        genreId: targetGenre?.id || '',
        genrePage: genrePageRef.current,
        genreSort: genreSortRef.current,
        genreScrollY: genreScrollRef.current
      };
    }
    hasInAppHistoryRef.current = true;
    window.history.pushState(histState, '', path);
    
    if (nextPage === 'watched') {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    } else if (nextPage === 'home') {
      try {
        const savedMode = localStorage.getItem('kh_display_mode');
        if (savedMode === 'sections' || savedMode === 'episodes' || savedMode === 'catalog') {
          setDisplayMode(savedMode as GalleryDisplayMode);
          if (savedMode === 'catalog') {
            const savedPage = localStorage.getItem('kh_catalog_page');
            const parsed = parseInt(savedPage || '1', 10);
            if (!isNaN(parsed) && parsed >= 1) {
              setPage(parsed);
            }
          }
        }
      } catch {}

      if (prev !== 'detail') {
        window.scrollTo(0, 0);
      }
    } else if (nextPage === 'my-list') {
      window.scrollTo(0, 0);
    }
  };

  // Clear and toggle filter handlers
  const handleResetAllFilters = () => {
    setSearchQuery('');
    setCatalogSearchQuery('');
    setSelectedStudioId('');
    setSelectedGenreIds([]);
    setSelectedYear('');
    setSelectedStatus('');
    setSelectedRating('');
    setSortBy('random');
  };

  const handleToggleGenre = (genreId: string) => {
    setGenreUsageMap(prev => ({
      ...prev,
      [genreId]: (prev[genreId] || 0) + 1
    }));
    if (selectedGenreIds.includes(genreId)) {
      setSelectedGenreIds(selectedGenreIds.filter(id => id !== genreId));
    } else {
      setSelectedGenreIds([...selectedGenreIds, genreId]);
    }
  };

  const handleSelectGenreFromSection = (genreId: string) => {
    const targetGenre = genres.find(g => g.id === genreId);
    if (targetGenre) {
      navigateTo('genre', undefined, undefined, null, 'home', 1, targetGenre);
    } else {
      setSelectedStudioId('');
      setSelectedGenreIds([genreId]);
      setIsCatalogSearchOpen(true);
      setTimeout(() => {
        const el = document.getElementById('seccion-catalogo-search-container');
        if (el) {
          el.scrollIntoView({ behavior: 'smooth' });
        }
      }, 60);
    }
  };

  // Map for original array positions to ensure strict order-of-addition sorting
  const originalAnimeIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    animes.forEach((a, idx) => map.set(a.id, idx));
    return map;
  }, [animes]);

  // Fast Lookup Maps for memoized filtering & sorting
  const studioNameMap = useMemo(() => {
    const map = new Map<string, string>();
    studios.forEach(s => map.set(s.id, s.name));
    return map;
  }, [studios]);

  const genreNameMap = useMemo(() => {
    const map = new Map<string, string>();
    genres.forEach(g => map.set(g.id, g.name));
    return map;
  }, [genres]);

  // Pre-normalize text & tokens for all animes once so typing/deleting in search is 100% instant with 0ms lag
  const normalizedAnimeCache = useMemo<NormalizedAnimeData[]>(() => {
    return animes.map(anime => buildNormalizedAnimeData(anime, studioNameMap, genreNameMap));
  }, [animes, studioNameMap, genreNameMap]);

  // Deferred search query to keep typing in search input 100% smooth without thread locks
  const deferredSearchQuery = useDeferredValue(searchQuery);

  // --- Optimized Filtering Logic ---
  const filteredAnimes = useMemo(() => {
    const trimmedQuery = deferredSearchQuery.trim();
    const normQuery = normalizeSearchText(trimmedQuery);
    const normQueryNoSpaces = normQuery.replace(/\s+/g, '');
    const queryTokens = normQuery.split(' ').filter(Boolean);

    return normalizedAnimeCache
      .filter(data => {
        const anime = data.anime;
        const sIds = (anime.studioIds && anime.studioIds.length > 0)
          ? anime.studioIds
          : (anime.studioId ? [anime.studioId] : []);
        // Los animes en 'Próximamente' no van a salir en el catálogo ni agregarse a listas públicas
        // hasta que el admin les cambie de etiqueta a Emisión o Finalizado
        if (isUpcomingStatus(anime.status)) {
          return false;
        }

        const matchesStudio = selectedStudioId === '' || sIds.includes(selectedStudioId);
        const matchesGenre = selectedGenreIds.length === 0 || 
          selectedGenreIds.every(gid => anime.genreIds?.includes(gid));
        const matchesYear = selectedYear === '' || (normalizeAnimeYear(anime.year) === selectedYear.trim());
        const matchesStatus = selectedStatus === '' || (() => {
          const s = (anime.status || 'Finalizado').toLowerCase();
          if (selectedStatus === 'Próximamente') {
            return isUpcomingStatus(anime.status);
          }
          if (selectedStatus === 'Emisión') {
            return isEmisionStatus(anime.status);
          }
          if (selectedStatus === 'Finalizado') {
            return s.includes('finaliz');
          }
          return s === selectedStatus.toLowerCase();
        })();

        const matchesRating = selectedRating === '' || (() => {
          const stats = getAnimeRatingStats(anime.id);
          if (selectedRating === '0') return stats.totalVotes === 0;
          if (selectedRating === '5') return Math.round(stats.average) === 5 || stats.average >= 4.5;
          if (selectedRating === '4') return Math.round(stats.average) === 4 || (stats.average >= 3.5 && stats.average < 4.5);
          if (selectedRating === '3') return Math.round(stats.average) === 3 || (stats.average >= 2.5 && stats.average < 3.5);
          if (selectedRating === '2') return Math.round(stats.average) === 2 || (stats.average >= 1.5 && stats.average < 2.5);
          if (selectedRating === '1') return Math.round(stats.average) === 1 || (stats.average >= 0.5 && stats.average < 1.5);
          return true;
        })();

        const matchesDisplayMode = true;

        if (!matchesStudio || !matchesGenre || !matchesYear || !matchesStatus || !matchesDisplayMode || !matchesRating) {
          return false;
        }

        if (!normQuery) return true;

        return matchesFuzzySearch(normQuery, normQueryNoSpaces, queryTokens, data);
      })
      .map(data => data.anime);
  }, [normalizedAnimeCache, deferredSearchQuery, selectedStudioId, selectedGenreIds, selectedYear, selectedStatus, selectedRating, displayMode]);

  // Semilla diaria que cambia automáticamente cada 24 horas (a medianoche) para rotar el orden aleatorio del catálogo
  const dailyCatalogSeed = useMemo(() => {
    const now = new Date();
    return now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
  }, [heroCycleVersion]);

  const getDailyRandomWeight = useCallback((animeId: string, seed: number): number => {
    let hash = 2166136261;
    const str = `cat_rnd_${animeId}_${seed}`;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    let t = (hash ^ (hash >>> 16)) >>> 0;
    t = Math.imul(t, 2246822507);
    t ^= t >>> 13;
    t = Math.imul(t, 3266489909);
    t ^= t >>> 16;
    return t >>> 0;
  }, []);

  // --- Reusable Sorting Logic for all Anime Lists (Catalog, Search, and Filtered Views) ---
  const applyAnimeSorting = useCallback((list: Anime[], sortType: string) => {
    if (sortType === 'random') {
      const weights = new Map<string, number>();
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        weights.set(a.id, getDailyRandomWeight(a.id, dailyCatalogSeed));
      }
      return [...list].sort((a, b) => {
        const wA = weights.get(a.id) ?? 0;
        const wB = weights.get(b.id) ?? 0;
        if (wA !== wB) return wA - wB;
        return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
      });
    }

    return [...list].sort((a, b) => {
      if (sortType === 'rating-desc') {
        const statsA = getAnimeRatingStats(a.id);
        const statsB = getAnimeRatingStats(b.id);
        if (statsB.average !== statsA.average) return statsB.average - statsA.average;
        if (statsB.totalVotes !== statsA.totalVotes) return statsB.totalVotes - statsA.totalVotes;
        return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
      }
      if (sortType === 'rating-asc') {
        const statsA = getAnimeRatingStats(a.id);
        const statsB = getAnimeRatingStats(b.id);
        if (statsA.average !== statsB.average) return statsA.average - statsB.average;
        return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
      }
      if (sortType === 'name-asc') {
        return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
      }
      if (sortType === 'name-desc') {
        return b.name.localeCompare(a.name, 'es', { sensitivity: 'base' });
      }
      if (sortType === 'year-desc') {
        const yearA = parseInt(normalizeAnimeYear(a.year) || '0', 10) || 0;
        const yearB = parseInt(normalizeAnimeYear(b.year) || '0', 10) || 0;
        if (yearA !== yearB) return yearB - yearA;
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        if (timeA > 0 && timeB > 0 && timeA !== timeB) return timeB - timeA;
        const idxA = originalAnimeIndexMap.get(a.id) ?? 0;
        const idxB = originalAnimeIndexMap.get(b.id) ?? 0;
        return idxB - idxA;
      }
      if (sortType === 'year-asc') {
        const yearA = parseInt(normalizeAnimeYear(a.year) || '0', 10) || 0;
        const yearB = parseInt(normalizeAnimeYear(b.year) || '0', 10) || 0;
        if (yearA !== yearB) return yearA - yearB;
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        if (timeA > 0 && timeB > 0 && timeA !== timeB) return timeA - timeB;
        const idxA = originalAnimeIndexMap.get(a.id) ?? 0;
        const idxB = originalAnimeIndexMap.get(b.id) ?? 0;
        return idxA - idxB;
      }

      // 'recientes': Según su año de lanzamiento más reciente (ej. 2026 antes que 2024),
      // y a igualdad de año, los más recientemente agregados (createdAt más nuevo primero)
      const yearA = parseInt(normalizeAnimeYear(a.year) || '0', 10) || 0;
      const yearB = parseInt(normalizeAnimeYear(b.year) || '0', 10) || 0;
      if (yearA !== yearB) {
        return yearB - yearA;
      }

      const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (timeA > 0 && timeB > 0 && timeA !== timeB) {
        return timeB - timeA;
      }
      if (timeA > 0 && timeB === 0) return -1;
      if (timeB > 0 && timeA === 0) return 1;

      const idxA = originalAnimeIndexMap.get(a.id) ?? 0;
      const idxB = originalAnimeIndexMap.get(b.id) ?? 0;
      return idxB - idxA;
    });
  }, [originalAnimeIndexMap, dailyCatalogSeed, getDailyRandomWeight]);

  // --- Optimized Sorting Logic ---
  const sortedAnimes = useMemo(() => {
    const trimmedQuery = deferredSearchQuery.trim();
    const normQuery = normalizeSearchText(trimmedQuery);

    if (normQuery) {
      const normQueryNoSpaces = normQuery.replace(/\s+/g, '');
      const queryTokens = normQuery.split(' ').filter(Boolean);
      const filteredAnimeSet = new Set(filteredAnimes);

      const filteredDataSet = normalizedAnimeCache.filter(data => filteredAnimeSet.has(data.anime));

      const scored = filteredDataSet.map(data => {
        const score = calculateRelevanceScore(normQuery, normQueryNoSpaces, queryTokens, data);
        return { anime: data.anime, score };
      });

      scored.sort((a, b) => {
        if (a.score !== b.score) {
          return b.score - a.score;
        }
        return a.anime.name.localeCompare(b.anime.name, 'es', { sensitivity: 'base' });
      });

      return scored.map(s => s.anime);
    }

    if (displayMode === 'episodes') {
      const result = [...filteredAnimes];
      return result.sort((a, b) => {
        const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
        const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
        if (timeA !== timeB) return timeB - timeA;

        const epsA = a.episodes?.length || 0;
        const epsB = b.episodes?.length || 0;
        if (epsB !== epsA) return epsB - epsA;

        const idxA = originalAnimeIndexMap.get(a.id) ?? 0;
        const idxB = originalAnimeIndexMap.get(b.id) ?? 0;
        return idxB - idxA;
      });
    }

    return applyAnimeSorting(filteredAnimes, sortBy);
  }, [filteredAnimes, normalizedAnimeCache, deferredSearchQuery, sortBy, displayMode, originalAnimeIndexMap, applyAnimeSorting]);

  // --- Individual Episodes for "Nuevos episodios" (solo animes/episodios activados desde el panel de administración) ---
  const recentEpisodes = useMemo(() => {
    const items: {
      id: string;
      anime: Anime;
      episodeNumber: number;
      episodeTitle?: string;
      coverImage?: string;
      timestamp: number;
    }[] = [];

    // Recorre animes y filtra ÚNICAMENTE episodios activados explícitamente con isNew === true
    animes.forEach(anime => {
      if (anime.hidden) return;

      const eps = anime.episodes && anime.episodes.length > 0
        ? anime.episodes
        : [];

      // Filter episodes explicitly chosen with the toggle switch (isNew === true)
      const targetEps = eps.filter(ep => Boolean(ep.isNew));

      const baseTime = anime.createdAt
        ? new Date(anime.createdAt).getTime()
        : 0;

      targetEps.forEach(ep => {
        const epNum = Number(ep.number) || 1;
        // El timestamp toma addedToRecentAt si existe para respetar el orden exacto de agregación
        const epTimestamp = ep.addedToRecentAt
          ? new Date(ep.addedToRecentAt).getTime()
          : (baseTime + epNum * 1000);
        const ownThumb = ep.thumbnail || ep.coverImage;
        items.push({
          id: `${anime.id}-ep-${epNum}`,
          anime,
          episodeNumber: epNum,
          episodeTitle: ep.title || ep.name,
          coverImage: ownThumb || undefined,
          timestamp: epTimestamp,
        });
      });
    });

    // Orden de agregación: el episodio agregado/activado más recientemente va de primero
    items.sort((a, b) => {
      if (b.timestamp !== a.timestamp) {
        return b.timestamp - a.timestamp;
      }
      return (b.episodeNumber || 0) - (a.episodeNumber || 0);
    });

    return items.slice(0, 30);
  }, [animes]);

  // --- Enforcement automático en segundo plano del límite de 30 episodios nuevos y limpieza de cuentas inactivas (>90 días) ---
  const isEnforcingEpisodesRef = useRef(false);
  useEffect(() => {
    if (!animes || animes.length === 0 || isEnforcingEpisodesRef.current) return;
    let totalActiveNew = 0;
    for (let i = 0; i < animes.length; i++) {
      const eps = animes[i].episodes;
      if (Array.isArray(eps)) {
        for (let j = 0; j < eps.length; j++) {
          if (eps[j]?.isNew) totalActiveNew++;
        }
      }
    }
    if (totalActiveNew > 30) {
      isEnforcingEpisodesRef.current = true;
      enforceEpisodesRotation(animes, 30)
        .then((res) => {
          if (res.updatedAnimes && res.updatedAnimes.length > 0) {
            applyOptimisticCatalogUpdate(res.updatedAnimes);
          }
        })
        .catch(() => {})
        .finally(() => {
          isEnforcingEpisodesRef.current = false;
        });
    }
  }, [animes]);

  useEffect(() => {
    const CLEANUP_KEY = 'kh_last_inactive_users_cleanup_ts';
    const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
    const runPeriodicMaintenance = () => {
      try {
        const lastTs = parseInt(localStorage.getItem(CLEANUP_KEY) || '0', 10) || 0;
        const now = Date.now();
        if (now - lastTs >= TWELVE_HOURS_MS) {
          localStorage.setItem(CLEANUP_KEY, String(now));
          cleanupInactiveUsers().catch(() => {});
        }
      } catch {}
    };
    const timer = setTimeout(runPeriodicMaintenance, 8000);
    const interval = setInterval(runPeriodicMaintenance, TWELVE_HOURS_MS);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, []);

  // --- Recomendaciones (personalizadas según los gustos de cada usuario, 15 animes por semana que cambian de lugar a diario) ---
  const recommendedAnimes = useMemo(() => {
    const userIdentifier = currentUser?.uid || getStableDeviceId();
    return getRecommendedAnimes(animes, myListIds, watchedIds, userIdentifier);
  }, [animes, myListIds, watchedIds, currentUser?.uid, heroCycleVersion, ratingVersion]);

  // --- Últimos Hentai: ordenados estrictamente por fecha (año y fecha de adición) tal como en el catálogo principal (últimos 30) ---
  const latestCatalogAnimes = useMemo(() => {
    const visible = animes.filter(a => !a.hidden && !isUpcomingStatus(a.status));
    const sorted = [...visible].sort((a, b) => {
      // Orden estrictamente por año descendente
      const yearA = parseInt(normalizeAnimeYear(a.year) || '0', 10) || 0;
      const yearB = parseInt(normalizeAnimeYear(b.year) || '0', 10) || 0;
      if (yearA !== yearB) {
        return yearB - yearA;
      }
      // Luego por fecha de creación/adición
      const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (timeA > 0 && timeB > 0 && timeA !== timeB) {
        return timeB - timeA;
      }
      const epsA = (a.episodes || []).length;
      const epsB = (b.episodes || []).length;
      if (epsB !== epsA) return epsB - epsA;
      return (originalAnimeIndexMap.get(b.id) ?? 0) - (originalAnimeIndexMap.get(a.id) ?? 0);
    });
    return sorted.slice(0, 30);
  }, [animes, originalAnimeIndexMap]);

  // --- Top 10: Estilo Netflix (actualización diaria cada 24h combinando tendencia del día + puntaje híbrido inteligente) ---
  const top10Animes = useMemo(() => {
    return computeDailyTop10Animes(animes);
  }, [animes, ratingVersion, heroCycleVersion]);

  // --- Próximamente: animes etiquetados como 'Próximamente' ordenados por el mes de estreno más cercano ---
  const upcomingSectionAnimes = useMemo(() => {
    const visible = animes.filter(a => !a.hidden && isUpcomingStatus(a.status));
    const currentMonthIdx = new Date().getMonth(); // 0 (Enero) - 11 (Diciembre)

    const parseReleaseMonthDistance = (monthStr?: string): { distance: number; day: number } => {
      if (!monthStr || !monthStr.trim()) {
        return { distance: 999, day: 999 };
      }
      const clean = monthStr
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');

      const monthMap: { keys: string[]; idx: number }[] = [
        { keys: ['enero', 'ene', 'january', 'jan'], idx: 0 },
        { keys: ['febrero', 'feb', 'february'], idx: 1 },
        { keys: ['marzo', 'mar', 'march'], idx: 2 },
        { keys: ['abril', 'abr', 'april', 'apr'], idx: 3 },
        { keys: ['mayo', 'may'], idx: 4 },
        { keys: ['junio', 'jun', 'june'], idx: 5 },
        { keys: ['julio', 'jul', 'july'], idx: 6 },
        { keys: ['agosto', 'ago', 'august', 'aug'], idx: 7 },
        { keys: ['septiembre', 'setiembre', 'sep', 'sept', 'september'], idx: 8 },
        { keys: ['octubre', 'oct', 'october'], idx: 9 },
        { keys: ['noviembre', 'nov', 'november'], idx: 10 },
        { keys: ['diciembre', 'dic', 'december', 'dec'], idx: 11 },
      ];

      let matchedMonthIdx = -1;
      for (const m of monthMap) {
        if (m.keys.some(k => new RegExp(`\\b${k}\\b`, 'i').test(clean) || clean.includes(k))) {
          matchedMonthIdx = m.idx;
          break;
        }
      }

      if (matchedMonthIdx === -1) {
        return { distance: 999, day: 999 };
      }

      // Distancia cíclica hacia adelante desde el mes actual (0 = este mes, 1 = próximo mes, etc.)
      const distance = (matchedMonthIdx - currentMonthIdx + 12) % 12;

      // Extraer día si el admin escribió p.ej. "15 de Noviembre"
      const dayMatch = clean.match(/\b([1-2]?\d|3[01])\b/);
      const day = dayMatch ? parseInt(dayMatch[1], 10) : 99;

      return { distance, day };
    };

    const sorted = [...visible].sort((a, b) => {
      const mA = parseReleaseMonthDistance(a.releaseMonth);
      const mB = parseReleaseMonthDistance(b.releaseMonth);
      if (mA.distance !== mB.distance) {
        return mA.distance - mB.distance;
      }
      if (mA.day !== mB.day) {
        return mA.day - mB.day;
      }
      const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (timeA > 0 && timeB > 0 && timeA !== timeB) return timeB - timeA;
      return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
    });
    return sorted;
  }, [animes, dailyCatalogSeed]);

  // --- Mi Lista: animes guardados por el usuario (solo si el usuario tiene animes agregados) ---
  const myListSectionAnimes = useMemo(() => {
    if (myListIds.length === 0) return [];
    const idSet = new Set(myListIds);
    const visible = animes.filter(a => idSet.has(a.id) && !a.hidden);
    const idOrder = new Map<string, number>();
    myListIds.forEach((id, index) => idOrder.set(id, index));
    return [...visible].sort((a, b) => {
      const idxA = idOrder.get(a.id) ?? 9999;
      const idxB = idOrder.get(b.id) ?? 9999;
      return idxA - idxB;
    });
  }, [animes, myListIds]);

  // --- Catálogo para sección horizontal (aplica filtros activos y ordenación seleccionada) ---
  const catalogSectionAnimes = useMemo(() => {
    const visible = animes.filter(anime => {
      if (anime.hidden) return false;
      if (isUpcomingStatus(anime.status)) {
        return false;
      }

      const sIds = (anime.studioIds && anime.studioIds.length > 0)
        ? anime.studioIds
        : (anime.studioId ? [anime.studioId] : []);
      if (selectedStudioId && !sIds.includes(selectedStudioId)) return false;
      if (selectedGenreIds.length > 0 && !selectedGenreIds.every(gid => anime.genreIds?.includes(gid))) return false;
      if (selectedYear && normalizeAnimeYear(anime.year) !== selectedYear.trim()) return false;
      if (selectedStatus) {
        const s = (anime.status || 'Finalizado').toLowerCase();
        if (selectedStatus === 'Emisión' && !isEmisionStatus(anime.status)) return false;
        if (selectedStatus === 'Finalizado' && !s.includes('finaliz')) return false;
      }
      if (selectedRating) {
        const stats = getAnimeRatingStats(anime.id);
        if (selectedRating === '0' && stats.totalVotes !== 0) return false;
        if (selectedRating === '5' && !(Math.round(stats.average) === 5 || stats.average >= 4.5)) return false;
        if (selectedRating === '4' && !(Math.round(stats.average) === 4 || (stats.average >= 3.5 && stats.average < 4.5))) return false;
        if (selectedRating === '3' && !(Math.round(stats.average) === 3 || (stats.average >= 2.5 && stats.average < 3.5))) return false;
        if (selectedRating === '2' && !(Math.round(stats.average) === 2 || (stats.average >= 1.5 && stats.average < 2.5))) return false;
        if (selectedRating === '1' && !(Math.round(stats.average) === 1 || (stats.average >= 0.5 && stats.average < 1.5))) return false;
      }
      return true;
    });

    return applyAnimeSorting(visible, sortBy);
  }, [
    animes,
    selectedStudioId,
    selectedGenreIds,
    selectedYear,
    selectedStatus,
    selectedRating,
    sortBy,
    applyAnimeSorting
  ]);

  // --- Animes para la barra de búsqueda en la sección Catálogo de Inicio (mostrados en vertical con score de relevancia en tiempo real y ordenación) ---
  const catalogSearchSectionAnimes = useMemo(() => {
    const trimmed = deferredCatalogSearchQuery.trim();
    const normQuery = normalizeSearchText(trimmed);
    if (!normQuery) {
      return catalogSectionAnimes;
    }

    const normQueryNoSpaces = normQuery.replace(/\s+/g, '');
    const queryTokens = normQuery.split(' ').filter(Boolean);

    const visibleCache = normalizedAnimeCache.filter(data => {
      const anime = data.anime;
      if (anime.hidden) return false;
      if (isUpcomingStatus(anime.status)) {
        return false;
      }

      const sIds = (anime.studioIds && anime.studioIds.length > 0)
        ? anime.studioIds
        : (anime.studioId ? [anime.studioId] : []);
      if (selectedStudioId && !sIds.includes(selectedStudioId)) return false;
      if (selectedGenreIds.length > 0 && !selectedGenreIds.every(gid => anime.genreIds?.includes(gid))) return false;
      if (selectedYear && normalizeAnimeYear(anime.year) !== selectedYear.trim()) return false;
      if (selectedStatus) {
        const s = (anime.status || 'Finalizado').toLowerCase();
        if (selectedStatus === 'Emisión' && !isEmisionStatus(anime.status)) return false;
        if (selectedStatus === 'Finalizado' && !s.includes('finaliz')) return false;
      }
      if (selectedRating) {
        const stats = getAnimeRatingStats(anime.id);
        if (selectedRating === '0' && stats.totalVotes !== 0) return false;
        if (selectedRating === '5' && !(Math.round(stats.average) === 5 || stats.average >= 4.5)) return false;
        if (selectedRating === '4' && !(Math.round(stats.average) === 4 || (stats.average >= 3.5 && stats.average < 4.5))) return false;
        if (selectedRating === '3' && !(Math.round(stats.average) === 3 || (stats.average >= 2.5 && stats.average < 3.5))) return false;
        if (selectedRating === '2' && !(Math.round(stats.average) === 2 || (stats.average >= 1.5 && stats.average < 2.5))) return false;
        if (selectedRating === '1' && !(Math.round(stats.average) === 1 || (stats.average >= 0.5 && stats.average < 1.5))) return false;
      }
      return matchesFuzzySearch(normQuery, normQueryNoSpaces, queryTokens, data);
    });

    const scored = visibleCache.map((data, idx) => ({
      anime: data.anime,
      score: calculateRelevanceScore(normQuery, normQueryNoSpaces, queryTokens, data),
      idx
    }));

    scored.sort((a, b) => {
      if (a.score !== b.score) {
        return b.score - a.score;
      }
      return a.idx - b.idx;
    });

    return scored.map(s => s.anime);
  }, [
    catalogSectionAnimes,
    normalizedAnimeCache,
    deferredCatalogSearchQuery,
    selectedStudioId,
    selectedGenreIds,
    selectedYear,
    selectedStatus,
    selectedRating
  ]);

  const displayedCatalogSearchAnimes = useMemo(() => {
    return catalogSearchSectionAnimes.slice(0, catalogSearchVisibleCount);
  }, [catalogSearchSectionAnimes, catalogSearchVisibleCount]);

  useEffect(() => {
    if (isCatalogSearchOpen) {
      setCatalogSearchVisibleCount(24);
    }
  }, [deferredCatalogSearchQuery, selectedStudioId, selectedGenreIds, selectedYear, selectedStatus, selectedRating, sortBy]);

  const catalogPreloadCandidates = useMemo(() => {
    if (isCatalogSearchOpen) {
      return catalogSearchSectionAnimes.slice(0, catalogSearchVisibleCount + 24);
    }
    const seen = new Set<string>();
    const combined: Anime[] = [];
    const addList = (list: Anime[]) => {
      for (const a of list) {
        if (a?.id && !seen.has(a.id)) {
          seen.add(a.id);
          combined.push(a);
        }
      }
    };
    addList(recommendedAnimes);
    addList(latestCatalogAnimes);
    addList(top10Animes);
    addList(upcomingSectionAnimes);
    addList(myListSectionAnimes);
    addList(catalogSectionAnimes.slice(0, 60));
    return combined;
  }, [
    isCatalogSearchOpen,
    catalogSearchSectionAnimes,
    catalogSearchVisibleCount,
    recommendedAnimes,
    latestCatalogAnimes,
    top10Animes,
    upcomingSectionAnimes,
    myListSectionAnimes,
    catalogSectionAnimes,
  ]);

  // Precarga en segundo plano cuando el navegador esté libre; cancela al salir del catálogo
  useEffect(() => {
    if (loading || currentPage !== 'home' || catalogPreloadCandidates.length === 0) {
      return;
    }
    const controller = new AbortController();
    startCatalogIdlePreload(catalogPreloadCandidates, controller.signal).catch(() => {});
    return () => {
      controller.abort();
    };
  }, [loading, currentPage, catalogPreloadCandidates]);

  const totalCatalogPages = useMemo(() => {
    return Math.max(1, Math.ceil(sortedAnimes.length / ITEMS_PER_PAGE));
  }, [sortedAnimes.length]);

  const handlePageChange = useCallback((newPage: number, isSwipe = false) => {
    if (newPage < 1 || newPage > totalCatalogPages || newPage === page) return;
    setPageDirection(newPage > page ? 1 : -1);
    setPage(newPage);
    try {
      localStorage.setItem('kh_catalog_page', String(newPage));
    } catch {}
    
    // Only adjust scroll if user has scrolled significantly past the grid top, and avoid jarring jumps during swipe
    if (!isSwipe) {
      const gridElem = document.getElementById('portadas-grid-top');
      if (gridElem) {
        const rect = gridElem.getBoundingClientRect();
        if (rect.top < -100) {
          const currentY = window.scrollY || document.documentElement.scrollTop;
          const targetY = Math.max(0, currentY + rect.top - 80);
          window.scrollTo({ top: targetY, left: 0, behavior: 'instant' as ScrollBehavior });
        }
      }
    }
  }, [page, totalCatalogPages]);

  // Gestos de deslizamiento ultra-fluidos para Mi Lista / Vistos
  useEffect(() => {
    if ((currentPage !== 'my-list' && currentPage !== 'watched') || isFilterModalOpen || isAuthModalOpen || isProfileModalOpen) {
      return;
    }

    let startX = 0;
    let startY = 0;
    let startTime = 0;

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.closest('input') ||
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

      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      const isHorizontal = absX > absY * 0.7;
      const isFastFlick = absX >= 18 && duration < 320;
      const isStandardSwipe = absX >= 24 && duration < 750;

      if (isHorizontal && (isFastFlick || isStandardSwipe)) {
        if (deltaX < 0) {
          // Swipe Left -> switch from Mi Lista to Vistos
          if (myListTab === 'saved') {
            try {
              if (navigator.vibrate) navigator.vibrate(12);
            } catch {}
            setMyListTab('watched');
            window.history.replaceState(null, '', '/vistos');
          }
        } else if (deltaX > 0) {
          // Swipe Right -> switch from Vistos to Mi Lista, or from Mi Lista to Galería
          if (myListTab === 'watched') {
            try {
              if (navigator.vibrate) navigator.vibrate(12);
            } catch {}
            setMyListTab('saved');
            window.history.replaceState(null, '', '/mi-lista');
          } else {
            try {
              if (navigator.vibrate) navigator.vibrate(12);
            } catch {}
            navigateTo('home');
          }
        }
      }
    };

    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchend', handleTouchEnd);
    };
  }, [
    currentPage,
    myListTab,
    isFilterModalOpen,
    isAuthModalOpen,
    isProfileModalOpen
  ]);

  // Instantly restore exact scroll position when returning to catalog view
  useEffect(() => {
    if (currentPage === 'home' || currentPage === 'my-list') {
      const targetPos = savedScrollPos.current;
      if (targetPos > 0) {
        window.scrollTo({ top: targetPos, left: 0, behavior: 'instant' as ScrollBehavior });
        savedScrollPos.current = 0;
      }
    }
  }, [currentPage]);

  // Ensure scroll is at 0,0 when entering admin view
  useEffect(() => {
    if (currentPage === 'admin') {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    }
  }, [currentPage]);

  // Selected anime lookup memoized for maximum fluidity (prefers live per-ID onSnapshot doc)
  const currentAnime = useMemo(() => {
    if (!selectedAnimeId) return undefined;
    const normId = String(selectedAnimeId).trim();
    if (directLoadedAnime && String(directLoadedAnime.id).trim() === normId) {
      return directLoadedAnime;
    }
    const found = animes.find(a => String(a.id).trim() === normId);
    if (found) return found;
    return undefined;
  }, [animes, selectedAnimeId, directLoadedAnime]);

  // Ensure sub-routes never get stuck on an empty/missing anime, studio, or genre after catalog loads
  useEffect(() => {
    if (!loading && currentPage === 'detail' && !currentAnime) {
      setIsDetailAnimating(false);
      setSelectedAnimeId('');
      setCurrentPage('home');
      try {
        window.history.replaceState({ page: 'home' }, '', '/');
      } catch {}
    }
  }, [loading, currentPage, currentAnime]);

  useEffect(() => {
    if (studios.length > 0 && currentPage === 'studio' && selectedStudio) {
      const matched = studios.find(
        s => String(s.id) === String(selectedStudio.id) || s.name.toLowerCase() === selectedStudio.name.toLowerCase()
      );
      if (matched && (matched.name !== selectedStudio.name || matched.image !== selectedStudio.image)) {
        setSelectedStudio(matched);
      } else if (!matched && !loading) {
        setSelectedStudio(null);
        setCurrentPage('home');
        try {
          window.history.replaceState({ page: 'home' }, '', '/');
        } catch {}
      }
    }
  }, [studios, currentPage, selectedStudio, loading]);

  useEffect(() => {
    if (genres.length > 0 && currentPage === 'genre' && selectedGenre) {
      const matched = genres.find(
        g => String(g.id) === String(selectedGenre.id) || g.name.toLowerCase() === selectedGenre.name.toLowerCase()
      );
      if (matched && (matched.name !== selectedGenre.name || matched.image !== selectedGenre.image)) {
        setSelectedGenre(matched);
      } else if (!matched && !loading) {
        setSelectedGenre(null);
        setCurrentPage('home');
        try {
          window.history.replaceState({ page: 'home' }, '', '/');
        } catch {}
      }
    }
  }, [genres, currentPage, selectedGenre, loading]);

  // --- Popularity Calculations for Studios, Genres and Top 3 Portadas ---
  const handleDownload = React.useCallback(async (animeId: string) => {
    if (!animeId) return;
    recordHeroAnimeView(animeId);
    // Optimistically update download count in local state for immediate UI sorting
    setAnimes(prev => prev.map(a => a.id === animeId ? { ...a, downloads: (a.downloads || 0) + 1 } : a));
    try {
      await fetch(`/api/animes/${animeId}/download`, { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true
      });
    } catch (err) {
      console.warn('Network sync for download count deferred:', err);
    }
  }, []);

  const sortedStudiosByPopularity = React.useMemo(() => {
    const visible = animes.filter(a => !a.hidden);
    const studioStats = new Map<string, { downloads: number; count: number }>();
    for (let i = 0; i < visible.length; i++) {
      const anime = visible[i];
      const sIds = (anime.studioIds && anime.studioIds.length > 0)
        ? anime.studioIds
        : (anime.studioId ? [anime.studioId] : []);
      for (let j = 0; j < sIds.length; j++) {
        const sid = sIds[j];
        if (!sid) continue;
        const current = studioStats.get(sid) || { downloads: 0, count: 0 };
        current.downloads += (anime.downloads || 0);
        current.count += 1;
        studioStats.set(sid, current);
      }
    }

    return [...studios].sort((a, b) => {
      const statsA = studioStats.get(a.id) || { downloads: 0, count: 0 };
      const statsB = studioStats.get(b.id) || { downloads: 0, count: 0 };
      if (statsB.downloads !== statsA.downloads) return statsB.downloads - statsA.downloads;
      if (statsB.count !== statsA.count) return statsB.count - statsA.count;
      return a.name.localeCompare(b.name);
    });
  }, [studios, animes]);

  const sortedGenresByPopularity = React.useMemo(() => {
    const visible = animes.filter(a => !a.hidden);
    const genreStats = new Map<string, { downloads: number; count: number }>();
    for (let i = 0; i < visible.length; i++) {
      const anime = visible[i];
      if (!anime.genreIds) continue;
      for (let j = 0; j < anime.genreIds.length; j++) {
        const gid = anime.genreIds[j];
        const current = genreStats.get(gid) || { downloads: 0, count: 0 };
        current.downloads += (anime.downloads || 0);
        current.count += 1;
        genreStats.set(gid, current);
      }
    }

    return [...genres].sort((a, b) => {
      const statsA = genreStats.get(a.id) || { downloads: 0, count: 0 };
      const statsB = genreStats.get(b.id) || { downloads: 0, count: 0 };
      const dlA = statsA.downloads + (genreUsageMap[a.id] || 0) * 10;
      const dlB = statsB.downloads + (genreUsageMap[b.id] || 0) * 10;
      if (dlB !== dlA) return dlB - dlA;
      if (statsB.count !== statsA.count) return statsB.count - statsA.count;
      return a.name.localeCompare(b.name);
    });
  }, [genres, animes, genreUsageMap]);

  // --- Carrusel Hero estilo Crunchyroll (1º Último de T-Rex + 3 Populares en Tendencia con Rotación Diaria + 1 Mejor Calificado con Rotación Diaria + hasta 2 Nuevos Episodios) ---
  const heroFeaturedAnimes = React.useMemo(() => {
    return computeHeroFeaturedAnimes(animes, studios);
  }, [animes, studios, ratingVersion, heroCycleVersion]);

  // Render Section Selector helper
  const scrollToExplore = () => {
    const target = document.getElementById('explorar');
    if (target) {
      target.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const hasActiveFilters = Boolean(
    selectedGenreIds.length > 0 ||
    selectedYear ||
    selectedStatus ||
    selectedRating ||
    selectedStudioId ||
    sortBy !== 'random'
  );

  const isSearchOrFilterActive = Boolean(
    deferredSearchQuery.trim() ||
    hasActiveFilters
  );

  const isOverlayOpen =
    (currentPage === 'detail' && (Boolean(currentAnime) || loading)) ||
    (currentPage === 'studio' && Boolean(selectedStudio)) ||
    (currentPage === 'genre' && Boolean(selectedGenre)) ||
    currentPage === 'admin';
  const shouldHideNav = isOverlayOpen || currentPage === 'watched' || currentPage === 'my-list';

  // --- PUBLIC HOME VIEW & TOP LEVEL PAGES ---
  return (
    <div className="relative min-h-screen bg-dark-bg text-white font-sans selection:bg-brand-red selection:text-white flex flex-col overflow-x-hidden border-0 outline-none">
      {/* 1. Home & Catálogo Shell: siempre montado en el DOM para velocidad inmediata (0ms lag) y cero parpadeo violeta */}
      <div
        className={`w-full min-h-screen flex flex-col overflow-x-hidden ${isOverlayOpen ? 'pointer-events-none select-none' : ''}`}
        aria-hidden={isOverlayOpen}
        style={
          isOverlayOpen && !isDetailAnimating
            ? { display: 'none' }
            : isOverlayOpen
              ? { contain: 'paint', pointerEvents: 'none' }
              : undefined
        }
      >
        {/* 1. Global Navigation Bar - Clean transparent overlay on Home, hidden in watched/my-list/overlays */}
            <nav className={`${shouldHideNav ? 'hidden' : 'block'} z-50 py-3 sm:py-4 px-3.5 sm:px-6 lg:px-8 border-none outline-none ${
              currentPage === 'home'
                ? 'absolute top-0 left-0 right-0 bg-transparent pointer-events-none'
                : 'fixed top-0 left-0 right-0 bg-[#0e091b]/95 backdrop-blur-md shadow-lg shadow-black/60 border-b border-[#2b1747]/40'
            }`}>
              <div className="max-w-[1500px] 2xl:max-w-[1800px] 3xl:max-w-[2100px] mx-auto flex items-center justify-end">
                {/* Right Top Auth / User Button */}
                <div className="flex items-center gap-2 sm:gap-2.5 pointer-events-auto">
                  {currentUser ? (
                    <div className="flex items-center gap-2 sm:gap-2.5">
                      {isAuthorizedAdminEmail(currentUser?.email) && (
                        <button
                          type="button"
                          onClick={() => navigateTo('admin')}
                          className="flex h-9 w-9 sm:h-10 sm:w-10 items-center justify-center rounded-full bg-[#1b102e]/85 hover:bg-[#2b1747] border border-purple-400/40 hover:border-purple-300 text-white shadow-lg backdrop-blur-md transition-all duration-300 active:scale-95 group cursor-pointer"
                          title="Panel de Administración"
                          aria-label="Panel de Administración"
                        >
                          <div className="flex flex-col gap-[3px] items-center justify-center w-4 pointer-events-none">
                            <div className="h-[2px] w-full bg-purple-200 rounded-xs group-hover:bg-white transition-colors shadow-xs" />
                            <div className="h-[2px] w-full bg-purple-200 rounded-xs group-hover:bg-white transition-colors shadow-xs" />
                            <div className="h-[2px] w-full bg-purple-200 rounded-xs group-hover:bg-white transition-colors shadow-xs" />
                          </div>
                        </button>
                      )}

                      {/* Google Profile Picture & Name (Clickable to open user window with custom name, Mi Lista & logout) */}
                      <button 
                        type="button"
                        onClick={() => setIsProfileModalOpen(true)}
                        className="flex items-center gap-2 rounded-full p-0.5 bg-black/40 hover:bg-black/60 border border-white/10 hover:border-purple-400/40 backdrop-blur-md transition-all duration-300 cursor-pointer active:scale-95 group focus:outline-none shadow-lg"
                        title="Toca para ver tu perfil, cambiar nombre, ver Mi Lista o cerrar sesión"
                      >
                        {currentUser.photoURL ? (
                          <img
                            src={currentUser.photoURL}
                            alt={currentUser.displayName || 'Foto de perfil'}
                            referrerPolicy="no-referrer"
                            className="w-9 h-9 sm:w-10 sm:h-10 rounded-full object-cover shadow-sm shrink-0 ring-1 ring-white/20 group-hover:scale-105 transition-transform"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none';
                              const fallback = e.currentTarget.parentElement?.querySelector('.kh-avatar-fallback') as HTMLElement | null;
                              if (fallback) fallback.style.display = 'flex';
                            }}
                          />
                        ) : null}
                        <div 
                          className={`kh-avatar-fallback w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-gradient-to-tr from-purple-800 to-brand-red text-white font-bold text-sm shrink-0 items-center justify-center ring-1 ring-white/20 group-hover:scale-105 transition-transform ${currentUser.photoURL ? 'hidden' : 'flex'}`}
                        >
                          {(currentUser.displayName || currentUser.email || 'U')[0].toUpperCase()}
                        </div>
                        <span className="hidden sm:inline-block font-mono text-xs text-neutral-200 truncate max-w-[130px] font-medium group-hover:text-white transition-colors drop-shadow px-1">
                          {currentUser.displayName || currentUser.email?.split('@')[0] || 'Usuario'}
                        </span>
                      </button>
                    </div>
                  ) : authLoading ? (
                    <div className="w-24 h-8 rounded-full bg-white/5 animate-pulse" />
                  ) : (
                    <button 
                      type="button"
                      onClick={() => {
                        setAuthModalMode('login');
                        setIsAuthModalOpen(true);
                      }}
                      className="px-3.5 py-1.5 bg-gradient-to-r from-purple-600 to-brand-red hover:from-purple-500 hover:to-brand-red/90 text-white rounded-full text-xs font-medium tracking-wide shadow-lg hover:shadow-purple-500/25 transition-all duration-300 flex items-center gap-1.5 cursor-pointer border border-white/20 backdrop-blur-md"
                      title="Iniciar sesión"
                    >
                      <LogIn className="h-3.5 w-3.5" />
                      <span>Iniciar Sesión</span>
                    </button>
                  )}
                </div>
              </div>
            </nav>

            {/* 3. Main Search & Explore Gallery Area */}
            <main id="explorar" className={`relative z-10 max-w-[1500px] 2xl:max-w-[1800px] 3xl:max-w-[2100px] mx-auto w-full px-1.5 sm:px-5 lg:px-7 ${
              currentPage === 'home'
                ? 'pt-0'
                : (currentPage === 'watched' || currentPage === 'my-list' ? 'pt-3 sm:pt-5' : 'pt-[62px] sm:pt-[68px]')
            } pb-3 sm:pb-4 space-y-4 flex-grow`}>
              <AnimatePresence mode="popLayout" custom={navDirection} initial={false}>
                {currentPage === 'my-list' || currentPage === 'watched' ? (
                  <motion.div
                    key="my-list-view"
                    custom={navDirection}
                    initial={(dir: number) => ({
                      opacity: 0,
                      x: dir >= 0 ? 50 : -50
                    })}
                    animate={{
                      opacity: 1,
                      x: 0
                    }}
                    exit={(dir: number) => ({
                      opacity: 0,
                      x: dir >= 0 ? -50 : 50
                    })}
                    transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
                    className="space-y-5"
                  >
                    {/* Top Row: Back to Galería Button & Two-tab Selector (Mi Lista / Vistos) */}
                    <div className="flex items-center justify-between gap-3">
                      <button
                        onClick={() => navigateTo('home')}
                        className="group inline-flex items-center gap-2 font-mono text-[10px] text-neutral-400 hover:text-white uppercase tracking-widest transition-colors duration-300 cursor-pointer select-none"
                      >
                        <ChevronLeft className="h-4 w-4 transition-transform duration-300 group-hover:-translate-x-1" />
                        Galería
                      </button>

                      {/* Recuadro de Mi Lista y Vistos - con el MISMO diseño y tamaño que el de episodios y catálogo */}
                      <div className="inline-flex items-center gap-0.5 p-[2.5px] bg-[#090514] border border-[#2b1747] rounded-lg shadow-sm">
                        <button
                          type="button"
                          onClick={() => {
                            setMyListTab('saved');
                            window.history.replaceState(null, '', '/mi-lista');
                          }}
                          className={`px-2.5 py-1 rounded-[6px] font-mono text-[9px] font-bold tracking-wider uppercase transition-all duration-200 cursor-pointer select-none ${
                            myListTab === 'saved'
                              ? 'bg-gradient-to-r from-purple-700 to-purple-600 text-white shadow-sm border border-purple-400/40'
                              : 'text-neutral-400 hover:text-white hover:bg-white/5'
                          }`}
                          title="Mostrar animes guardados en Mi Lista"
                        >
                          <span>Mi Lista</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setMyListTab('watched');
                            window.history.replaceState(null, '', '/vistos');
                          }}
                          className={`px-2.5 py-1 rounded-[6px] font-mono text-[9px] font-bold tracking-wider uppercase transition-all duration-200 cursor-pointer select-none ${
                            myListTab === 'watched'
                              ? 'bg-gradient-to-r from-purple-700 to-purple-600 text-white shadow-sm border border-purple-400/40'
                              : 'text-neutral-400 hover:text-white hover:bg-white/5'
                          }`}
                          title="Mostrar animes marcados como vistos"
                        >
                          <span>Vistos</span>
                        </button>
                      </div>
                    </div>

                    {/* LADO 1: MI LISTA */}
                    {myListTab === 'saved' ? (
                      <div className="space-y-4">
                        {/* Header Title & Subtitle */}
                        <div className="space-y-1.5 pb-2">
                          <h1 className="font-display font-bold text-2xl sm:text-3xl text-white tracking-tight flex items-center gap-2">
                            <SignIcon className="h-6 w-6 text-brand-red shrink-0" />
                            <span>MI LISTA</span>
                            {myListIds.length > 0 && (
                              <span className="text-xs font-mono px-2.5 py-0.5 bg-brand-red/20 text-brand-red rounded-full border border-brand-red/30">
                                {myListIds.length}
                              </span>
                            )}
                          </h1>
                          <p className="font-mono text-xs text-neutral-400 max-w-2xl leading-relaxed">
                            Los elementos guardados se conservan durante 90 días.
                          </p>
                        </div>

                        {/* Grid of Saved Animes */}
                        {(() => {
                          const savedAnimes = animes.filter(a => myListIds.includes(a.id));
                          
                          if (savedAnimes.length === 0) {
                            return (
                              <div className="text-center py-16 px-4 bg-dark-card border border-dark-border rounded-2xl max-w-xl mx-auto my-8 space-y-3">
                                <div className="flex justify-center pb-1"><SignIcon className="h-10 w-10 text-brand-red/70" /></div>
                                <p className="font-sans text-neutral-300 text-sm leading-relaxed whitespace-pre-line">
                                  No has agregado ningún anime.{"\n\n"}
                                  Abre un anime y pulsa '<span className="text-brand-red font-semibold">Agregar a mi lista</span>' para guardarlo.
                                </p>
                                <div className="pt-2">
                                  <button
                                    onClick={() => navigateTo('home')}
                                    className="px-4 py-2 bg-brand-red hover:bg-[#ff3b75] text-white rounded-xl text-xs font-mono font-medium transition-colors cursor-pointer"
                                  >
                                    Explorar catálogo
                                  </button>
                                </div>
                              </div>
                            );
                          }

                          return (
                            <div className="grid grid-cols-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-[1.5px] sm:gap-[2px]">
                              {savedAnimes.map(anime => (
                                <GalleryCard
                                  key={anime.id}
                                  anime={anime}
                                  studios={studios}
                                  onClick={() => navigateTo('detail', anime.id)}
                                />
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                    ) : (
                      /* LADO 2: VISTOS */
                      <div className="space-y-4">
                        {/* Header Title & Subtitle */}
                        <div className="space-y-1.5 pb-2">
                          <h1 className="font-display font-bold text-2xl sm:text-3xl text-white tracking-tight flex items-center gap-2">
                            <Eye className="h-6 w-6 text-emerald-400 shrink-0" />
                            <span>ANIMES VISTOS</span>
                            {watchedIds.length > 0 && (
                              <span className="text-xs font-mono px-2.5 py-0.5 bg-emerald-500/20 text-emerald-300 rounded-full border border-emerald-500/30">
                                {watchedIds.length}
                              </span>
                            )}
                          </h1>
                          <p className="font-mono text-xs text-neutral-400 max-w-2xl leading-relaxed">
                            Historial de animes que has marcado como vistos.
                          </p>
                        </div>

                        {/* Grid of Watched Animes */}
                        {(() => {
                          const watchedAnimes = animes.filter(a => watchedIds.includes(a.id));
                          
                          if (watchedAnimes.length === 0) {
                            return (
                              <div className="text-center py-16 px-4 bg-dark-card border border-dark-border rounded-2xl max-w-xl mx-auto my-8 space-y-3">
                                <div className="flex justify-center pb-1"><Eye className="h-10 w-10 text-emerald-400/70" /></div>
                                <p className="font-sans text-neutral-300 text-sm leading-relaxed whitespace-pre-line">
                                  No has marcado ningún anime como visto aún.{"\n\n"}
                                  Abre cualquier anime y pulsa '<span className="text-emerald-400 font-semibold">Visto</span>' para añadirlo a tu historial.
                                </p>
                                <div className="pt-2">
                                  <button
                                    onClick={() => navigateTo('home')}
                                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-mono font-medium transition-colors cursor-pointer"
                                  >
                                    Explorar catálogo
                                  </button>
                                </div>
                              </div>
                            );
                          }

                          return (
                            <div className="grid grid-cols-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-[1.5px] sm:gap-[2px]">
                              {watchedAnimes.map(anime => (
                                <GalleryCard
                                  key={anime.id}
                                  anime={anime}
                                  studios={studios}
                                  onClick={() => navigateTo('detail', anime.id)}
                                />
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </motion.div>
                ) : (
                  <motion.div
                    key="gallery-home-view"
                    custom={navDirection}
                    initial={(dir: number) => ({
                      opacity: 0,
                      x: dir >= 0 ? 50 : -50
                    })}
                    animate={{
                      opacity: 1,
                      x: 0
                    }}
                    exit={(dir: number) => ({
                      opacity: 0,
                      x: dir >= 0 ? -50 : 50
                    })}
                    transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
                    className="space-y-5"
                  >
        {/* Crunchyroll-Style Hero Banner Carousel for Más Populares - Extending to the top of the page */}
        {(loading || animes.length > 0) && (
          <section aria-label="Animes Más Populares" className="no-swipe -mx-1.5 sm:-mx-5 lg:-mx-7 w-[calc(100%+0.75rem)] sm:w-[calc(100%+2.5rem)] lg:w-[calc(100%+3.5rem)]">
            <PopularHeroCarousel
              animes={heroFeaturedAnimes}
              studios={studios}
              genres={genres}
              onSelectAnime={(animeId) => navigateTo('detail', animeId)}
              savedAnimeIds={myListIds}
              onToggleMyList={handleToggleMyList}
              loading={loading}
            />
          </section>
        )}

        {/* Sections Stream (Crunchyroll-style horizontal rows) */}
        {loading ? (
          <div className="space-y-6">
            {[...Array(3)].map((_, sIdx) => (
              <div key={sIdx} className="space-y-3">
                <div className="h-6 w-44 bg-purple-900/30 rounded-lg animate-pulse" />
                <div className="flex gap-2 overflow-hidden">
                  {[...Array(6)].map((_, i) => (
                    <div key={i} className="aspect-[2/3] w-32 shrink-0 bg-[#10091d] border border-purple-900/30 rounded-xl animate-pulse" />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : animes.length === 0 && studios.length === 0 && genres.length === 0 ? (
          <div className="min-h-[60vh] flex flex-col items-center justify-center px-4 py-16 text-center">
            <div className="max-w-md w-full bg-[#10091c]/90 border border-purple-900/40 rounded-2xl p-8 shadow-xl space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-purple-950/70 border border-purple-500/30 flex items-center justify-center mx-auto">
                <Film className="w-6 h-6 text-purple-400/80" />
              </div>
              <h2 className="font-display font-bold text-lg text-white">
                Catálogo vacío
              </h2>
              <p className="font-sans text-xs sm:text-sm text-neutral-400 leading-relaxed">
                No hay base de datos conectada en este momento. La página está limpia y lista para conectar la nueva base de datos de Firebase.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-5 sm:space-y-6 pt-1">
            {/* SECCIÓN 1: SELECCIONADOS PARA TI (3 animes personalizados que cambian a diario, en cuadrícula de 3 columnas bien pegadas como estudios) */}
            <div className="w-full space-y-1.5 sm:space-y-2">
              <div className="flex items-center justify-between px-0.5 sm:px-1 gap-2">
                <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                  <span className="text-purple-400 shrink-0"><Sparkles className="w-4 h-4 text-purple-400" /></span>
                  <h2 className="font-display font-bold text-sm sm:text-base md:text-lg text-white tracking-tight leading-snug truncate">
                    Seleccionados para ti
                  </h2>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-[1.5px] xs:gap-[2px] sm:gap-[2.5px] w-full overflow-hidden rounded-xl">
                {recommendedAnimes.map((anime, idx) => (
                  <div key={`rec-${anime.id}`} className="w-full">
                    <GalleryCard
                      anime={anime}
                      studios={studios}
                      index={idx}
                      onClick={() => navigateTo('detail', anime.id)}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* SECCIÓN 2: ÚLTIMOS EPISODIOS (solo animes/episodios activados desde el panel de administración) */}
            <HorizontalSectionRow
              title="Últimos episodios"
              icon={<Film className="w-4 h-4 text-purple-400" />}
            >
              {recentEpisodes.length === 0 ? (
                <div className="py-4 px-3.5 text-xs font-mono text-neutral-400 w-full bg-[#120a1f]/60 rounded-xl border border-purple-900/30 flex items-center gap-2">
                  <Film className="w-4 h-4 text-purple-400/50 shrink-0" />
                  <span>No hay episodios activados. Actívalos desde el panel de administración.</span>
                </div>
              ) : (
                recentEpisodes.slice(0, 30).map((item, epIdx) => (
                  <div key={item.id} className="w-[170px] xs:w-[195px] sm:w-[220px] md:w-[240px] shrink-0">
                    <div
                      onClick={() => navigateTo('detail', item.anime.id, item.episodeNumber)}
                      onMouseEnter={() => prefetchAnime(item.anime, studios)}
                      className="group relative aspect-video w-full rounded-xl overflow-hidden cursor-pointer transition-all duration-200 shadow-md select-none active:scale-[0.98] hover:opacity-95 outline-none border border-purple-900/40"
                    >
                      {item.coverImage ? (
                        <img
                          src={item.coverImage}
                          alt={`${item.anime.name} - Ep ${item.episodeNumber}`}
                          loading="lazy"
                          width={500}
                          height={281}
                          decoding="async"
                          className="w-full h-full object-cover"
                          referrerPolicy="no-referrer"
                          onError={(e) => {
                            e.currentTarget.src = getFallbackSvg(item.anime.name);
                          }}
                        />
                      ) : (
                        <SmartAnimeCover
                          anime={item.anime}
                          alt={`${item.anime.name} - Ep ${item.episodeNumber}`}
                          tamaño="episodio"
                          loading="lazy"
                          width={500}
                          height={281}
                          className="w-full h-full object-cover"
                        />
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/20 pointer-events-none" />
                      <div className="absolute top-1.5 left-1.5 h-4.5 min-w-[34px] px-1.5 rounded-full bg-black/80 backdrop-blur-md flex items-center justify-center border border-white/10 shadow-sm z-10">
                        <span className="font-mono text-[8.5px] sm:text-[9px] font-bold text-white tracking-tight uppercase leading-none">
                          EP {item.episodeNumber}
                        </span>
                      </div>
                      <div className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/90 via-black/40 to-transparent p-1.5 sm:p-2 pt-4 pointer-events-none">
                        <p className="font-display text-xs sm:text-[13px] text-white font-medium truncate group-hover:text-purple-300 transition-colors leading-tight">
                          {item.anime.name}
                        </p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </HorizontalSectionRow>

            {/* SECCIÓN 3: NUEVOS HENTAI (pantalla grande estilo más populares, la mitad de grande, solo título) */}
            <HorizontalSectionRow
              title="Nuevos Hentai"
              icon={<Zap className="w-4 h-4 text-purple-400" />}
            >
              {latestCatalogAnimes.map((anime, nhIdx) => {
                const sIds = (anime.studioIds && anime.studioIds.length > 0)
                  ? anime.studioIds
                  : (anime.studioId ? [anime.studioId] : []);
                const studioName = studios.find(s => sIds.includes(s.id))?.name || 'Estudio';

                return (
                  <div
                    key={`uh-${anime.id}`}
                    className="w-[305px] xs:w-[335px] sm:w-[395px] md:w-[440px] aspect-[16/9] shrink-0 relative rounded-2xl overflow-hidden bg-[#0a0515] border border-[#2b1747] hover:border-purple-500/70 shadow-lg shadow-black/70 group cursor-pointer active:scale-[0.98] transition-all select-none"
                    onClick={() => navigateTo('detail', anime.id)}
                    onMouseEnter={() => prefetchAnime(anime, studios)}
                  >
                    <SmartAnimeCover
                      anime={anime}
                      studioName={studioName}
                      alt={anime.name}
                      tamaño="nuevos"
                      loading="lazy"
                      priority={false}
                      width={900}
                      height={506}
                      className="w-full h-full object-cover object-top"
                    />
                    {/* Solo difuminado suave abajo en el título */}
                    <div className="absolute inset-x-0 bottom-0 h-16 sm:h-20 bg-gradient-to-t from-[#090514]/95 via-[#090514]/70 to-transparent pointer-events-none" />

                    {/* Solo el título */}
                    <div className="absolute inset-x-0 bottom-0 p-3 sm:p-4 z-10 pointer-events-none">
                      <p className="font-display font-bold text-sm sm:text-base md:text-[17px] text-white tracking-tight leading-snug drop-shadow truncate group-hover:text-purple-300 transition-colors">
                        {anime.name}
                      </p>
                    </div>
                  </div>
                );
              })}
            </HorizontalSectionRow>

            {/* SECCIÓN: TOP 10 (Puntaje Híbrido Inteligente: Popularidad + Calificación + Votos) */}
            {top10Animes.length > 0 && (
              <HorizontalSectionRow
                title="Top 10"
                icon={<Trophy className="w-4 h-4 text-purple-400" />}
              >
                {top10Animes.map((anime, idx) => (
                  <div key={`top10-${anime.id}`} className="w-[115px] xs:w-[130px] sm:w-[145px] md:w-[160px] shrink-0">
                    <GalleryCard
                      anime={anime}
                      studios={studios}
                      index={idx}
                      onClick={() => navigateTo('detail', anime.id)}
                    />
                  </div>
                ))}
              </HorizontalSectionRow>
            )}

            {/* SECCIÓN: GÉNEROS (Un anime aleatorio cada 24 horas por cada género) */}
            <DailyGenreSection
              genres={genres}
              animes={animes}
              studios={studios}
              onSelectAnime={(animeId) => navigateTo('detail', animeId)}
              onSelectGenre={handleSelectGenreFromSection}
            />

            {/* SECCIÓN: STUDIOS (Portadas circulares y nombre del estudio debajo) */}
            <DailyStudiosSection
              studios={studios}
              animes={animes}
              onSelectStudio={(studio) => navigateTo('studio', undefined, undefined, studio)}
            />

            {/* SECCIÓN 5: PRÓXIMAMENTE (recuadro grande como Últimos Hentai, solo el nombre sin texto encima) */}
            {upcomingSectionAnimes.length > 0 && (
              <HorizontalSectionRow
                title="Próximamente"
                icon={<Calendar className="w-4 h-4 text-purple-400" />}
              >
                {upcomingSectionAnimes.map((anime, upIdx) => {
                  const sIds = (anime.studioIds && anime.studioIds.length > 0)
                    ? anime.studioIds
                    : (anime.studioId ? [anime.studioId] : []);
                  const studioName = studios.find(s => sIds.includes(s.id))?.name || 'Estudio';
                  const isUpFirst = upIdx < 2;

                  return (
                    <div
                      key={`up-${anime.id}`}
                      className="w-[260px] xs:w-[290px] sm:w-[340px] md:w-[380px] aspect-[16/9] shrink-0 relative rounded-2xl overflow-hidden bg-[#0a0515] border border-[#2b1747] hover:border-purple-500/70 shadow-lg shadow-black/70 group cursor-pointer active:scale-[0.98] transition-all select-none"
                      onClick={() => navigateTo('detail', anime.id)}
                      onMouseEnter={() => prefetchAnime(anime, studios)}
                    >
                      <SmartAnimeCover
                        anime={anime}
                        studioName={studioName}
                        alt={anime.name}
                        tamaño="horizontal"
                        loading="lazy"
                        priority={false}
                        width={780}
                        height={439}
                        className="w-full h-full object-cover object-top"
                      />
                      {/* Difuminado suave abajo en el título */}
                      <div className="absolute inset-x-0 bottom-0 h-16 sm:h-20 bg-gradient-to-t from-[#090514]/95 via-[#090514]/70 to-transparent pointer-events-none" />

                      {/* Mes de estreno en el recuadro de la portada */}
                      {anime.releaseMonth && anime.releaseMonth.trim() !== '' && (
                        <div className="absolute top-2 left-2 sm:top-2.5 sm:left-2.5 z-10 px-2 py-0.5 rounded-md bg-black/80 backdrop-blur-md border border-purple-500/40 shadow-md pointer-events-none flex items-center justify-center">
                          <span className="font-mono text-[9px] sm:text-[10px] font-bold text-white uppercase tracking-wider leading-none">
                            {anime.releaseMonth.trim()}
                          </span>
                        </div>
                      )}

                      {/* Nombre del anime */}
                      <div className="absolute inset-x-0 bottom-0 p-3 sm:p-4 z-10 pointer-events-none">
                        <p className="font-display font-bold text-sm sm:text-base md:text-[17px] text-white tracking-tight leading-snug drop-shadow truncate group-hover:text-purple-300 transition-colors">
                          {anime.name}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </HorizontalSectionRow>
            )}

            {/* SECCIÓN 6: MI LISTA (debajo de Próximamente; solo se muestra si hay animes guardados; si no hay, no se muestra ni el título ni nada) */}
            {myListSectionAnimes.length > 0 && (
              <HorizontalSectionRow
                title="Mi Lista"
                icon={<Bookmark className="w-4 h-4 text-purple-400" />}

              >
                {myListSectionAnimes.map((anime, idx) => (
                  <div key={`my-list-home-${anime.id}`} className="w-[115px] xs:w-[130px] sm:w-[145px] md:w-[160px] shrink-0">
                    <GalleryCard
                      anime={anime}
                      studios={studios}
                      index={idx}
                      onClick={() => navigateTo('detail', anime.id)}
                    />
                  </div>
                ))}
              </HorizontalSectionRow>
            )}

            {/* SECCIÓN 7: CATÁLOGO (al tocar la lupita se quita el título y se muestra la barra encima de los animes en vertical con filtrado dinámico) */}
            <div
              id="seccion-catalogo-search-container"
              ref={catalogSectionWrapperRef}
              className={isCatalogSearchOpen ? 'space-y-3.5 pt-1' : ''}
            >
              {/* Barra de búsqueda pre-montada en el DOM para foco instantáneo en 0ms sin congelamientos ni saltos de teclado */}
              <div
                aria-hidden={!isCatalogSearchOpen}
                className={
                  isCatalogSearchOpen
                    ? 'flex items-center gap-2 sm:gap-3'
                    : 'h-0 overflow-hidden opacity-0 pointer-events-none select-none'
                }
              >
                <CatalogSearchInput
                  query={catalogSearchQuery}
                  onChangeQuery={setCatalogSearchQuery}
                  onClear={handleClearCatalogSearch}
                  isOpen={isCatalogSearchOpen}
                  inputRef={catalogSearchInputRef}
                />

                {/* Botón Filtros */}
                <button
                  type="button"
                  tabIndex={isCatalogSearchOpen ? 0 : -1}
                  onClick={() => setIsFilterModalOpen(true)}
                  className="relative flex items-center justify-center gap-2 px-3.5 sm:px-5 py-3 bg-[#090514] hover:bg-[#120822] border border-[#2b1747] hover:border-purple-600/50 text-white rounded-2xl text-xs sm:text-sm font-medium shrink-0 transition-colors duration-150 shadow-xl cursor-pointer"
                  title="Abrir panel de filtros"
                >
                  <SlidersHorizontal className="h-4 w-4 text-purple-400" />
                  <span className="hidden xs:inline">Filtros</span>
                  {hasActiveFilters && (
                    <span className="w-2 h-2 rounded-full bg-brand-red animate-pulse" />
                  )}
                </button>

                {/* Botón para cerrar la búsqueda y restaurar el título del catálogo */}
                <button
                  type="button"
                  tabIndex={isCatalogSearchOpen ? 0 : -1}
                  onClick={handleCloseCatalogSearch}
                  className="p-3 bg-[#090514] hover:bg-[#120822] border border-[#2b1747] hover:border-purple-600/50 text-neutral-400 hover:text-white rounded-2xl text-xs font-medium shrink-0 transition-colors duration-150 shadow-xl cursor-pointer"
                  title="Cerrar búsqueda y restaurar catálogo"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {!isCatalogSearchOpen ? (
                <HorizontalSectionRow
                  title="Catálogo"
                  icon={<LayoutGrid className="w-4 h-4 text-purple-400" />}
                  rightAction={
                    <button
                      type="button"
                      onClick={handleOpenCatalogSearch}
                      className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-xl border bg-[#150a26] border-[#2b1747] text-purple-300 hover:text-white hover:border-purple-500/60 text-xs font-mono transition-colors duration-150 cursor-pointer active:scale-95"
                      title="Buscar en el catálogo"
                    >
                      <Search className="w-3.5 h-3.5" />
                      <span className="text-[11px] font-medium hidden xs:inline">Buscar</span>
                    </button>
                  }
                >
                  {catalogSectionAnimes.slice(0, 36).map((anime, idx) => (
                    <div key={`cat-${anime.id}`} className="w-[115px] xs:w-[130px] sm:w-[145px] md:w-[160px] shrink-0">
                      <GalleryCard
                        anime={anime}
                        studios={studios}
                        index={idx}
                        onClick={() => navigateTo('detail', anime.id)}
                      />
                    </div>
                  ))}
                </HorizontalSectionRow>
              ) : (
                <>
                  {/* Badges de filtros activos si están aplicados */}
                  {hasActiveFilters && (
                    <div className="flex flex-wrap items-center gap-2 pt-0.5">
                      <span className="text-[10px] font-mono text-neutral-500 uppercase tracking-widest mr-1">Filtros:</span>
                      {sortBy !== 'random' && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-purple-500/20 border border-purple-500/50 rounded-full text-[11px] text-purple-300 font-mono">
                          {sortBy === 'recientes' ? 'Más Recientes' :
                           sortBy === 'rating-desc' ? 'Mejor Calificados' :
                           sortBy === 'rating-asc' ? 'Menos Calificados' :
                           sortBy === 'name-asc' ? 'Nombre (A - Z)' :
                           sortBy === 'name-desc' ? 'Nombre (Z - A)' :
                           sortBy === 'year-desc' ? 'Año reciente' :
                           sortBy === 'year-asc' ? 'Año antiguo' : sortBy}
                          <button onClick={() => setSortBy('random')}><X className="h-3 w-3" /></button>
                        </span>
                      )}
                      {selectedRating && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-[#ff5588]/15 border border-[#ff5588]/40 rounded-full text-[11px] text-[#ff5588] font-mono">
                          {selectedRating === '0' ? 'Sin votos' : `${selectedRating}★`}
                          <button onClick={() => setSelectedRating('')}><X className="h-3 w-3" /></button>
                        </span>
                      )}
                      {selectedYear && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-[#ff5588]/15 border border-[#ff5588]/40 rounded-full text-[11px] text-[#ff5588] font-mono">
                          {selectedYear}
                          <button onClick={() => setSelectedYear('')}><X className="h-3 w-3" /></button>
                        </span>
                      )}
                      {selectedStatus && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-[#ff5588]/15 border border-[#ff5588]/40 rounded-full text-[11px] text-[#ff5588] font-mono">
                          {selectedStatus}
                          <button onClick={() => setSelectedStatus('')}><X className="h-3 w-3" /></button>
                        </span>
                      )}
                      {selectedStudioId && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-purple-500/20 border border-purple-500/50 rounded-full text-[11px] text-purple-300 font-mono">
                          {studios.find(s => s.id === selectedStudioId)?.name || 'Estudio'}
                          <button onClick={() => setSelectedStudioId('')}><X className="h-3 w-3" /></button>
                        </span>
                      )}
                    </div>
                  )}

                  {/* Los animes del catálogo mostrados con el mismo estilo en vertical (grid vertical de pósters) */}
                  {catalogSearchSectionAnimes.length === 0 ? (
                    <div className="py-12 text-center border border-dashed border-purple-900/40 rounded-2xl bg-[#120a1f]/60 max-w-md mx-auto p-6 space-y-2">
                      <AlertCircle className="h-7 w-7 text-purple-400/60 mx-auto" />
                      <p className="font-display font-medium text-sm text-white">No se encontraron animes en el catálogo</p>
                      <p className="font-sans text-xs text-neutral-400">Intenta con otro término de búsqueda o limpia los filtros.</p>
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-[1.5px] sm:gap-[2px]">
                        {displayedCatalogSearchAnimes.map((anime, idx) => (
                          <GalleryCard
                            key={`cat-search-${anime.id}`}
                            anime={anime}
                            studios={studios}
                            index={idx}
                            isNewEpisodesMode={false}
                            onClick={() => navigateTo('detail', anime.id)}
                          />
                        ))}
                      </div>
                      {catalogSearchSectionAnimes.length > catalogSearchVisibleCount && (
                        <div className="pt-4 pb-2 text-center">
                          <button
                            type="button"
                            onClick={() => setCatalogSearchVisibleCount(prev => prev + 30)}
                            className="px-6 py-2.5 rounded-xl border border-purple-500/40 bg-[#160a28] hover:bg-[#230f3f] text-purple-300 hover:text-white text-xs font-mono transition-colors duration-150 shadow-lg cursor-pointer active:scale-95"
                          >
                            Cargar más animes ({catalogSearchSectionAnimes.length - catalogSearchVisibleCount} restantes)
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}
                  </motion.div>
                )}
              </AnimatePresence>
            </main>
      </div>

      {/* 2. Capa oscura fija detrás de los overlays para evitar al 100% que cualquier portada de la página principal se asome por debajo durante el deslizamiento */}
      {isOverlayOpen && (
        <div className="fixed inset-0 z-50 bg-[#08080a] pointer-events-none" />
      )}

      {/* 3. Top-Level Overlays: Admin, Studio, Genre, Detail con deslizamiento ultra fluido (60fps, sin parpadeos ni congelamientos al reabrir) */}
      <AnimatePresence initial={false}>
        {currentPage === 'admin' && (
          <motion.div
            key="admin-overlay"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-0 z-[60] overflow-y-auto bg-[#0b0c10] shadow-[-25px_0_50px_rgba(0,0,0,0.9)]"
          >
            {authLoading ? (
              <div className="min-h-screen bg-[#12091c] flex flex-col items-center justify-center font-sans text-neutral-400 gap-3">
                <div className="w-8 h-8 border-2 border-purple-500/30 border-t-purple-500 rounded-full animate-spin" />
                <span className="text-xs font-mono tracking-widest text-neutral-400">Verificando credenciales de administrador...</span>
              </div>
            ) : isAuthorizedAdminEmail(currentUser?.email) ? (
              <React.Suspense fallback={
                <div className="min-h-screen bg-[#12091c] flex items-center justify-center font-sans text-neutral-400 text-sm">
                  Cargando panel de administración...
                </div>
              }>
                <AdminPanel
                  studios={sortedStudiosByPopularity}
                  genres={sortedGenresByPopularity}
                  animes={animes}
                  onRefresh={(updatedAnime, deletedId) => applyOptimisticCatalogUpdate(updatedAnime, deletedId)}
                  onBackToHome={() => navigateTo('home', undefined, undefined, null, undefined, -1)}
                  currentUser={currentUser}
                />
              </React.Suspense>
            ) : null}
          </motion.div>
        )}

        {currentPage === 'studio' && selectedStudio && (
          <motion.div
            key={`studio-${selectedStudio.id}`}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-0 z-[60] overflow-hidden bg-[#0c0517] shadow-[-20px_0_40px_rgba(0,0,0,0.9)]"
          >
            <StudioDetailModal
              key={selectedStudio.id}
              studio={selectedStudio}
              initialPage={studioPageRef.current}
              initialSortBy={studioSortRef.current as any}
              initialScrollY={studioScrollRef.current}
              onPageChange={(p) => {
                studioPageRef.current = p;
              }}
              onSortChange={(s) => {
                studioSortRef.current = s as any;
              }}
              onClose={() => {
                const currentStId = selectedStudio.id;
                studioPageRef.current = 1;
                studioScrollRef.current = 0;
                studioSortRef.current = 'date-desc';
                try {
                  sessionStorage.removeItem('kh_studio_scroll_' + currentStId);
                  sessionStorage.removeItem('kh_studio_page_' + currentStId);
                  sessionStorage.removeItem('kh_studio_sort_' + currentStId);
                  sessionStorage.removeItem('kh_last_studio');
                } catch {}

                setSelectedStudio(null);
                if (previousPage === 'detail' && selectedAnimeId) {
                  navigateTo('detail', selectedAnimeId, undefined, null, 'home', -1);
                } else {
                  navigateTo('home', undefined, undefined, null, undefined, -1);
                }
              }}
              animes={animes}
              studios={studios}
              onSelectAnime={(animeId, page, scrollY, sort) => {
                studioPageRef.current = page || 1;
                studioScrollRef.current = scrollY || 0;
                studioSortRef.current = (sort as any) || 'date-desc';
                navigateTo('detail', animeId, undefined, selectedStudio, 'studio', 1);
              }}
            />
          </motion.div>
        )}

        {currentPage === 'genre' && selectedGenre && (
          <motion.div
            key={`genre-${selectedGenre.id}`}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-0 z-[60] overflow-hidden bg-[#0c0517] shadow-[-20px_0_40px_rgba(0,0,0,0.9)]"
          >
            <GenreDetailModal
              key={selectedGenre.id}
              genre={selectedGenre}
              initialPage={genrePageRef.current}
              initialSortBy={genreSortRef.current as any}
              initialScrollY={genreScrollRef.current}
              onPageChange={(p) => {
                genrePageRef.current = p;
              }}
              onSortChange={(s) => {
                genreSortRef.current = s as any;
              }}
              onClose={() => {
                const currentGnId = selectedGenre.id;
                genrePageRef.current = 1;
                genreScrollRef.current = 0;
                genreSortRef.current = 'date-desc';
                try {
                  sessionStorage.removeItem('kh_genre_scroll_' + currentGnId);
                  sessionStorage.removeItem('kh_genre_page_' + currentGnId);
                  sessionStorage.removeItem('kh_genre_sort_' + currentGnId);
                  sessionStorage.removeItem('kh_last_genre');
                } catch {}

                setSelectedGenre(null);
                if (previousPage === 'detail' && selectedAnimeId) {
                  navigateTo('detail', selectedAnimeId, undefined, null, 'home', -1);
                } else {
                  navigateTo('home', undefined, undefined, null, undefined, -1);
                }
              }}
              animes={animes}
              studios={studios}
              onSelectAnime={(animeId, page, scrollY, sort) => {
                genrePageRef.current = page || 1;
                genreScrollRef.current = scrollY || 0;
                genreSortRef.current = (sort as any) || 'date-desc';
                navigateTo('detail', animeId, undefined, null, 'genre', 1, selectedGenre);
              }}
            />
          </motion.div>
        )}

        {currentPage === 'detail' && (currentAnime || loading) && (
          <motion.div
            key={`detail-${selectedAnimeId}`}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            onAnimationComplete={() => setIsDetailAnimating(false)}
            style={{ willChange: isDetailAnimating ? 'transform' : 'auto' }}
            className="fixed inset-0 z-[70] overflow-y-auto bg-[#08080a] shadow-2xl shadow-black border-l border-white/5"
          >
            {currentAnime ? (
              <AnimeDetail
                anime={currentAnime}
                initialEpisodeNum={selectedEpisodeNum}
                navDirection={navDirection}
                studios={studios}
                genres={genres}
                animes={animes}
                onBack={() => {
                  if (hasInAppHistoryRef.current && window.history.length > 1 && window.location.pathname.startsWith('/anime/')) {
                    window.history.back();
                  } else if (previousPage === 'studio' && selectedStudio) {
                    navigateTo('studio', undefined, undefined, selectedStudio, undefined, -1);
                  } else if (previousPage === 'genre' && selectedGenre) {
                    navigateTo('genre', undefined, undefined, null, undefined, -1, selectedGenre);
                  } else if (previousPage === 'my-list') {
                    navigateTo('my-list', undefined, undefined, null, undefined, -1);
                  } else if (previousPage === 'watched') {
                    navigateTo('watched', undefined, undefined, null, undefined, -1);
                  } else {
                    navigateTo('home', undefined, undefined, null, undefined, -1);
                  }
                }}
                onDownload={handleDownload}
                isSaved={myListIds.includes(currentAnime.id)}
                onToggleMyList={handleToggleMyList}
                isWatched={watchedIds.includes(currentAnime.id)}
                onToggleWatched={handleToggleWatched}
                onSelectAnime={(animeId) => navigateTo('detail', animeId, undefined, null, undefined, 1)}
                onSelectStudio={(studioId) => {
                  const st = studios.find(s => s.id === studioId);
                  if (st) {
                    navigateTo('studio', undefined, undefined, st, 'detail', 1);
                  } else {
                    setSelectedStudioId(studioId);
                    setSelectedGenreIds([]);
                    navigateTo('home', undefined, undefined, null, undefined, -1);
                    setTimeout(() => {
                      document.getElementById('explorar')?.scrollIntoView({ behavior: 'smooth' });
                    }, 100);
                  }
                }}
                onSelectGenre={(genreId) => {
                  const gn = genres.find(g => g.id === genreId);
                  if (gn) {
                    navigateTo('genre', undefined, undefined, null, 'detail', 1, gn);
                  } else {
                    setSelectedStudioId('');
                    setSelectedGenreIds([genreId]);
                    navigateTo('home', undefined, undefined, null, undefined, -1);
                    setTimeout(() => {
                      document.getElementById('explorar')?.scrollIntoView({ behavior: 'smooth' });
                    }, 100);
                  }
                }}
              />
            ) : (
              <div className="min-h-screen bg-[#0c0517] flex flex-col items-center justify-center p-6 text-white relative">
                <button
                  type="button"
                  onClick={() => navigateTo('home', undefined, undefined, null, undefined, -1)}
                  className="absolute top-4 left-4 inline-flex items-center gap-2 px-3.5 py-2 rounded-full bg-black/60 hover:bg-black/85 border border-white/15 text-xs font-mono text-neutral-300 hover:text-white transition-all cursor-pointer active:scale-95"
                >
                  <ChevronLeft className="h-4 w-4" />
                  <span>Volver al inicio</span>
                </button>
                <div className="w-9 h-9 border-2 border-purple-500/30 border-t-purple-500 rounded-full animate-spin mb-3" />
                <p className="font-mono text-xs text-neutral-400 tracking-wider">Cargando anime...</p>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Filter Modal Sheet */}
      <FilterModal
        isOpen={isFilterModalOpen}
        onClose={() => setIsFilterModalOpen(false)}
        studios={sortedStudiosByPopularity}
        genres={sortedGenresByPopularity}
        animes={animes}
        selectedStudioId={selectedStudioId}
        selectedGenreIds={selectedGenreIds}
        selectedYear={selectedYear}
        selectedStatus={selectedStatus}
        selectedRating={selectedRating}
        sortBy={sortBy}
        onSelectStudio={setSelectedStudioId}
        onSelectGenreIds={setSelectedGenreIds}
        onSelectYear={setSelectedYear}
        onSelectStatus={setSelectedStatus}
        onSelectRating={setSelectedRating}
        onSelectSortBy={setSortBy}
        onResetFilters={handleResetAllFilters}
        onOpenStudio={(st) => {
          setIsFilterModalOpen(false);
          navigateTo('studio', undefined, undefined, st);
        }}
      />

      {/* Auth Modal */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        initialMode={authModalMode}
      />

      {/* User Profile Window / Modal */}
      <AnimatePresence>
        {isProfileModalOpen && (
          <UserProfileModal
            isOpen={isProfileModalOpen}
            onClose={() => setIsProfileModalOpen(false)}
            currentUser={currentUser}
            myListCount={myListIds.length}
            watchedCount={watchedIds.length}
            onOpenMyList={() => navigateTo('my-list')}
            onOpenWatched={() => navigateTo('watched')}
            onOpenReportModal={() => setIsReportModalOpen(true)}
            onLogout={handleLogout}
            onUserUpdated={handleUserUpdated}
          />
        )}
      </AnimatePresence>

      {/* Report Issue Chat Modal */}
      <ReportIssueModal
        isOpen={isReportModalOpen}
        onClose={() => setIsReportModalOpen(false)}
        currentUser={currentUser}
      />

      {/* First-Time Registration Welcome & Onboarding Walkthrough Modal */}
      <WelcomeOnboardingModal
        isOpen={isWelcomeModalOpen}
        onClose={() => setIsWelcomeModalOpen(false)}
        currentUser={currentUser}
        onOpenReportModal={() => setIsReportModalOpen(true)}
        onOpenProfileModal={() => setIsProfileModalOpen(true)}
      />

      {/* X/Twitter-style Official Announcement & Feedback Post for Registered Users */}
      <AnnouncementPostModal
        currentUser={currentUser}
        isWelcomeOpen={isWelcomeModalOpen}
      />
    </div>
  );
}
