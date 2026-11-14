/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { 
  db, 
  auth, 
  collection, 
  doc, 
  setDoc, 
  deleteDoc, 
  onSnapshot, 
  getDocs,
  onAuthStateChanged,
  serverTimestamp 
} from '../lib/firebase';

export interface VoteData {
  v5: number;
  v4: number;
  v3: number;
  v2: number;
  v1: number;
}

export interface RatingStats {
  v5: number;
  v4: number;
  v3: number;
  v2: number;
  v1: number;
  totalVotes: number;
  average: number; // e.g. 4.8 out of 5.0
  userVote: number | null; // 1 to 5 or null
}

const ALL_USER_VOTES_STORAGE_KEY = 'kh_all_anime_user_votes_v2';
const ALL_USER_VOTE_TS_STORAGE_KEY = 'kh_all_anime_user_vote_ts_v1';
const PENDING_USER_VOTES_STORAGE_KEY = 'kh_pending_user_votes_v2';

interface PendingVoteOp {
  userId: string;
  animeId: string;
  vote: number | null; // null means removed vote
  ts: number;
}

// In-memory cache for aggregate ratings and per-user votes
const ratingsCache: Record<string, VoteData> = {};
const userVotesCache: Record<string, number> = {};
// Map of animeId -> { [userId]: vote (1..5) } from user_anime_votes collection
const animeUserVotesMap: Record<string, Record<string, number>> = {};
// Map of animeId -> { [userId]: timestampMs } for 24-hour rating calculations
const animeUserVoteTimestampsMap: Record<string, Record<string, number>> = {};

function extractTimestampMs(val: any): number {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  if (typeof val.toMillis === 'function') {
    try {
      return val.toMillis();
    } catch {}
  }
  if (typeof val.seconds === 'number') {
    return val.seconds * 1000;
  }
  if (typeof val === 'string') {
    const parsed = new Date(val).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function loadPersistedUserVotesMap(): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = localStorage.getItem(ALL_USER_VOTES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        Object.entries(parsed).forEach(([animeId, usersObj]: [string, any]) => {
          if (usersObj && typeof usersObj === 'object') {
            animeUserVotesMap[animeId] = {};
            Object.entries(usersObj).forEach(([uid, v]: [string, any]) => {
              const num = Number(v);
              if (num >= 1 && num <= 5) {
                animeUserVotesMap[animeId][uid] = num;
                userVotesCache[`${uid}_${animeId}`] = num;
              }
            });
          }
        });
      }
    }
  } catch {}

  try {
    const rawTs = localStorage.getItem(ALL_USER_VOTE_TS_STORAGE_KEY);
    if (rawTs) {
      const parsedTs = JSON.parse(rawTs);
      if (parsedTs && typeof parsedTs === 'object') {
        Object.entries(parsedTs).forEach(([animeId, usersTsObj]: [string, any]) => {
          if (usersTsObj && typeof usersTsObj === 'object') {
            animeUserVoteTimestampsMap[animeId] = {};
            Object.entries(usersTsObj).forEach(([uid, ts]: [string, any]) => {
              const num = Number(ts);
              if (num > 0) {
                animeUserVoteTimestampsMap[animeId][uid] = num;
              }
            });
          }
        });
      }
    }
  } catch {}
}

function savePersistedUserVotesMap(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(ALL_USER_VOTES_STORAGE_KEY, JSON.stringify(animeUserVotesMap));
    localStorage.setItem(ALL_USER_VOTE_TS_STORAGE_KEY, JSON.stringify(animeUserVoteTimestampsMap));
  } catch {}
}

function readPendingVoteOps(): Record<string, PendingVoteOp> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(PENDING_USER_VOTES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writePendingVoteOps(ops: Record<string, PendingVoteOp>): void {
  if (typeof window === 'undefined') return;
  try {
    if (Object.keys(ops).length === 0) {
      localStorage.removeItem(PENDING_USER_VOTES_STORAGE_KEY);
    } else {
      localStorage.setItem(PENDING_USER_VOTES_STORAGE_KEY, JSON.stringify(ops));
    }
  } catch {}
}

function computeVoteDataFromUserMap(animeId: string): VoteData | null {
  const usersForAnime = animeUserVotesMap[animeId];
  if (!usersForAnime) return null;
  let v5 = 0, v4 = 0, v3 = 0, v2 = 0, v1 = 0;
  Object.values(usersForAnime).forEach((v) => {
    if (v === 5) v5++;
    else if (v === 4) v4++;
    else if (v === 3) v3++;
    else if (v === 2) v2++;
    else if (v === 1) v1++;
  });
  return { v5, v4, v3, v2, v1 };
}

function syncAggregateFromUserVotes(animeId: string): VoteData {
  const computed = computeVoteDataFromUserMap(animeId) || getInitialVotes();
  ratingsCache[animeId] = computed;
  try {
    localStorage.setItem(`kh_anime_votes_${animeId}`, JSON.stringify(computed));
  } catch {}
  return computed;
}

export function clearAllRatingsCache() {
  Object.keys(ratingsCache).forEach((k) => delete ratingsCache[k]);
  Object.keys(userVotesCache).forEach((k) => delete userVotesCache[k]);
  Object.keys(animeUserVotesMap).forEach((k) => delete animeUserVotesMap[k]);
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (
        key &&
        (key.startsWith('kh_anime_votes_') ||
          key.startsWith('kh_user_vote_') ||
          key === ALL_USER_VOTES_STORAGE_KEY ||
          key === PENDING_USER_VOTES_STORAGE_KEY)
      ) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));
  } catch (e) {}
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('kh_rating_updated', { detail: {} }));
  }
}

if (typeof window !== 'undefined') {
  loadPersistedUserVotesMap();
  window.addEventListener('kh_clear_ratings_cache', () => {
    clearAllRatingsCache();
  });
}

function getInitialVotes(): VoteData {
  return { v5: 0, v4: 0, v3: 0, v2: 0, v1: 0 };
}

async function flushPendingVoteOps(): Promise<void> {
  if (!db) return;
  const pending = readPendingVoteOps();
  const keys = Object.keys(pending);
  if (keys.length === 0) return;

  for (const key of keys) {
    const op = pending[key];
    if (!op || !op.userId || !op.animeId) {
      delete pending[key];
      continue;
    }
    try {
      const userVoteRef = doc(db, 'user_anime_votes', `${op.userId}_${op.animeId}`);
      if (op.vote === null) {
        await deleteDoc(userVoteRef);
      } else {
        await setDoc(
          userVoteRef,
          {
            userId: op.userId,
            animeId: op.animeId,
            vote: op.vote,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      }
      const agg = syncAggregateFromUserVotes(op.animeId);
      const ratingRef = doc(db, 'anime_ratings', op.animeId);
      await setDoc(ratingRef, { ...agg, updatedAt: serverTimestamp() }, { merge: true });
      delete pending[key];
      writePendingVoteOps(pending);
    } catch {
      // Keep in pending queue for next retry
    }
  }
}

// Global real-time listeners for all ratings & per-user votes in Firestore
let isListenerInitialized = false;

function initRealtimeRatingsListener() {
  if (isListenerInitialized || !db) return;
  isListenerInitialized = true;

  let debounceTimer: any = null;
  const notifyUpdated = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('kh_rating_updated', { detail: {} }));
      }
    }, 60);
  };

  // Flush any pending votes from before a page reload
  flushPendingVoteOps().catch(() => {});

  // 1. Listen to user_anime_votes (authoritative source of per-user ratings across accounts)
  try {
    const userVotesColl = collection(db, 'user_anime_votes');

    const applyUserVotesDocs = (docs: any[]) => {
      const pending = readPendingVoteOps();
      const nextMap: Record<string, Record<string, number>> = {};
      const nextTsMap: Record<string, Record<string, number>> = {};

      docs.forEach((docSnap) => {
        const data = typeof docSnap.data === 'function' ? docSnap.data() : docSnap;
        if (!data || !data.animeId || !data.userId) return;
        const vote = Number(data.vote);
        if (vote >= 1 && vote <= 5) {
          if (!nextMap[data.animeId]) nextMap[data.animeId] = {};
          nextMap[data.animeId][data.userId] = vote;
          const tsMs = extractTimestampMs(data.updatedAt);
          if (tsMs > 0) {
            if (!nextTsMap[data.animeId]) nextTsMap[data.animeId] = {};
            nextTsMap[data.animeId][data.userId] = tsMs;
          }
        }
      });

      // Overlay any locally pending operations so reloads never revert an in-flight vote
      Object.values(pending).forEach((op) => {
        if (!op || !op.animeId || !op.userId) return;
        if (op.vote === null) {
          if (nextMap[op.animeId]) {
            delete nextMap[op.animeId][op.userId];
          }
          if (nextTsMap[op.animeId]) {
            delete nextTsMap[op.animeId][op.userId];
          }
          delete userVotesCache[`${op.userId}_${op.animeId}`];
          try {
            localStorage.removeItem(`kh_user_vote_${op.userId}_${op.animeId}`);
          } catch {}
        } else if (op.vote >= 1 && op.vote <= 5) {
          if (!nextMap[op.animeId]) nextMap[op.animeId] = {};
          nextMap[op.animeId][op.userId] = op.vote;
          if (!nextTsMap[op.animeId]) nextTsMap[op.animeId] = {};
          nextTsMap[op.animeId][op.userId] = op.ts || Date.now();
          userVotesCache[`${op.userId}_${op.animeId}`] = op.vote;
          try {
            localStorage.setItem(`kh_user_vote_${op.userId}_${op.animeId}`, String(op.vote));
          } catch {}
        }
      });

      // Update in-memory maps and local caches
      const affectedAnimeIds = new Set<string>([
        ...Object.keys(animeUserVotesMap),
        ...Object.keys(nextMap),
      ]);
      Object.keys(animeUserVotesMap).forEach((k) => delete animeUserVotesMap[k]);
      Object.keys(animeUserVoteTimestampsMap).forEach((k) => delete animeUserVoteTimestampsMap[k]);
      Object.keys(userVotesCache).forEach((k) => delete userVotesCache[k]);

      Object.entries(nextMap).forEach(([animeId, usersObj]) => {
        animeUserVotesMap[animeId] = usersObj;
        Object.entries(usersObj).forEach(([uid, vote]) => {
          userVotesCache[`${uid}_${animeId}`] = vote;
          try {
            localStorage.setItem(`kh_user_vote_${uid}_${animeId}`, String(vote));
          } catch {}
        });
      });

      Object.entries(nextTsMap).forEach(([animeId, usersTsObj]) => {
        animeUserVoteTimestampsMap[animeId] = usersTsObj;
      });

      affectedAnimeIds.forEach((animeId) => {
        syncAggregateFromUserVotes(animeId);
      });

      savePersistedUserVotesMap();
      notifyUpdated();
    };

    getDocs(userVotesColl)
      .then((snap) => {
        applyUserVotesDocs(snap.docs);
      })
      .catch(() => {});

    onSnapshot(
      userVotesColl,
      (snapshot) => {
        applyUserVotesDocs(snapshot.docs);
      },
      (err: any) => {
        console.warn('[RatingManager] user_anime_votes snapshot warning:', err?.message || err);
      }
    );
  } catch (err) {
    console.warn('[RatingManager] Failed to attach user_anime_votes listener:', err);
  }

  // 2. Also listen to anime_ratings collection for aggregate fallback
  try {
    const ratingsColl = collection(db, 'anime_ratings');
    let unsub: (() => void) | null = null;

    unsub = onSnapshot(
      ratingsColl,
      (snapshot) => {
        let hasChanges = false;
        snapshot.docChanges().forEach((change) => {
          const animeId = change.doc.id;
          if (change.type === 'removed') {
            if (!animeUserVotesMap[animeId] || Object.keys(animeUserVotesMap[animeId]).length === 0) {
              delete ratingsCache[animeId];
              try {
                localStorage.removeItem(`kh_anime_votes_${animeId}`);
              } catch {}
              hasChanges = true;
            }
            return;
          }

          // If we already have authoritative per-user votes for this anime, let per-user votes drive the count
          if (animeUserVotesMap[animeId] && Object.keys(animeUserVotesMap[animeId]).length > 0) {
            syncAggregateFromUserVotes(animeId);
            hasChanges = true;
            return;
          }

          const data = change.doc.data();
          if (data) {
            const voteData: VoteData = {
              v5: Math.max(0, Number(data.v5) || 0),
              v4: Math.max(0, Number(data.v4) || 0),
              v3: Math.max(0, Number(data.v3) || 0),
              v2: Math.max(0, Number(data.v2) || 0),
              v1: Math.max(0, Number(data.v1) || 0),
            };
            ratingsCache[animeId] = voteData;
            try {
              localStorage.setItem(`kh_anime_votes_${animeId}`, JSON.stringify(voteData));
            } catch {}
            hasChanges = true;
          }
        });

        if (hasChanges) {
          notifyUpdated();
        }
      },
      (err: any) => {
        const errMsg = String(err?.message || err);
        if (err?.code === 'not-found' || errMsg.includes('NOT_FOUND') || err?.code === 'permission-denied') {
          if (unsub) {
            try {
              unsub();
            } catch {}
            unsub = null;
          }
        } else {
          console.warn('[RatingManager] Ratings snapshot error:', err);
        }
      }
    );
  } catch (err) {
    console.warn('[RatingManager] Failed to attach ratings listener:', err);
  }
}

// Track user's auth state transitions and flush any pending votes
if (auth) {
  onAuthStateChanged(auth, async (user) => {
    if (user && db) {
      await flushPendingVoteOps().catch(() => {});
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kh_rating_updated', { detail: { userId: user?.uid || null } }));
    }
  });
}

// Defer listener initialization to second stage in background so main catalog & cards load instantly
if (typeof window !== 'undefined') {
  setTimeout(() => {
    initRealtimeRatingsListener();
  }, 2800);
}

function getAuthenticatedUid(): string | null {
  if (auth?.currentUser?.uid) {
    return auth.currentUser.uid;
  }
  if (typeof window !== 'undefined') {
    try {
      const cached = localStorage.getItem('kh_cached_user');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && typeof parsed.uid === 'string' && parsed.uid.trim()) {
          return parsed.uid.trim();
        }
      }
    } catch {}
  }
  return null;
}

function getVoterId(): string {
  const authUid = getAuthenticatedUid();
  if (authUid) return authUid;
  try {
    let id = localStorage.getItem('kh_guest_voter_id');
    if (!id) {
      id = 'guest_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now();
      localStorage.setItem('kh_guest_voter_id', id);
    }
    return id;
  } catch {
    return 'guest_anon';
  }
}

export function getAnimeRatingStats(animeId: string): RatingStats {
  if (!animeId) {
    return { v5: 0, v4: 0, v3: 0, v2: 0, v1: 0, totalVotes: 0, average: 0, userVote: null };
  }

  // 1. Determine aggregate vote counts (preferring per-user vote map when populated)
  let voteData: VoteData;
  const computedFromUsers = computeVoteDataFromUserMap(animeId);
  const computedTotal = computedFromUsers
    ? computedFromUsers.v5 + computedFromUsers.v4 + computedFromUsers.v3 + computedFromUsers.v2 + computedFromUsers.v1
    : 0;

  if (computedFromUsers && computedTotal > 0) {
    voteData = computedFromUsers;
    ratingsCache[animeId] = voteData;
  } else if (ratingsCache[animeId]) {
    voteData = ratingsCache[animeId];
  } else {
    const storedVotesRaw = typeof window !== 'undefined' ? localStorage.getItem(`kh_anime_votes_${animeId}`) : null;
    if (storedVotesRaw) {
      try {
        const parsed = JSON.parse(storedVotesRaw);
        voteData = {
          v5: Number(parsed.v5) || 0,
          v4: Number(parsed.v4) || 0,
          v3: Number(parsed.v3) || 0,
          v2: Number(parsed.v2) || 0,
          v1: Number(parsed.v1) || 0,
        };
        ratingsCache[animeId] = voteData;
      } catch {
        voteData = getInitialVotes();
        ratingsCache[animeId] = voteData;
      }
    } else {
      voteData = getInitialVotes();
      ratingsCache[animeId] = voteData;
    }
  }

  // 2. Check current user's vote (isolated per authenticated user UID)
  let userVote: number | null = null;
  const authUid = getAuthenticatedUid();

  if (authUid) {
    const cacheKey = `${authUid}_${animeId}`;
    if (animeUserVotesMap[animeId] && animeUserVotesMap[animeId][authUid] !== undefined) {
      userVote = animeUserVotesMap[animeId][authUid];
      userVotesCache[cacheKey] = userVote;
    } else if (userVotesCache[cacheKey] !== undefined) {
      userVote = userVotesCache[cacheKey];
    } else if (typeof window !== 'undefined') {
      const storedUserVote = localStorage.getItem(`kh_user_vote_${authUid}_${animeId}`);
      if (storedUserVote) {
        const parsed = parseInt(storedUserVote, 10);
        if (parsed >= 1 && parsed <= 5) {
          userVote = parsed;
          userVotesCache[cacheKey] = parsed;
        }
      }
    }
  }

  const totalVotes = voteData.v5 + voteData.v4 + voteData.v3 + voteData.v2 + voteData.v1;
  const totalScore =
    voteData.v5 * 5 + voteData.v4 * 4 + voteData.v3 * 3 + voteData.v2 * 2 + voteData.v1 * 1;
  const average = totalVotes > 0 ? parseFloat((totalScore / totalVotes).toFixed(1)) : 0;

  return {
    v5: voteData.v5,
    v4: voteData.v4,
    v3: voteData.v3,
    v2: voteData.v2,
    v1: voteData.v1,
    totalVotes,
    average,
    userVote,
  };
}

export function submitAnimeVote(animeId: string, starRating: number): { stats: RatingStats; error?: string } {
  const userId = getAuthenticatedUid();
  if (!userId) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kh_open_auth_modal', { detail: { mode: 'register' } }));
    }
    return { stats: getAnimeRatingStats(animeId), error: 'Debes registrarte o iniciar sesión para calificar.' };
  }

  if (starRating < 1 || starRating > 5) {
    return { stats: getAnimeRatingStats(animeId) };
  }

  const currentStats = getAnimeRatingStats(animeId);
  const { userVote } = currentStats;

  if (!animeUserVotesMap[animeId]) {
    animeUserVotesMap[animeId] = {};
  }
  if (!animeUserVoteTimestampsMap[animeId]) {
    animeUserVoteTimestampsMap[animeId] = {};
  }

  let newRatingValue: number | null = starRating;
  const nowTs = Date.now();

  // If user clicked the same star rating, toggle their vote off
  if (userVote === starRating) {
    newRatingValue = null;
    delete animeUserVotesMap[animeId][userId];
    delete animeUserVoteTimestampsMap[animeId][userId];
    delete userVotesCache[`${userId}_${animeId}`];
    try {
      localStorage.removeItem(`kh_user_vote_${userId}_${animeId}`);
    } catch {}
  } else {
    animeUserVotesMap[animeId][userId] = starRating;
    animeUserVoteTimestampsMap[animeId][userId] = nowTs;
    userVotesCache[`${userId}_${animeId}`] = starRating;
    try {
      localStorage.setItem(`kh_user_vote_${userId}_${animeId}`, starRating.toString());
    } catch {}
  }

  savePersistedUserVotesMap();

  // Recompute aggregate votes across all users for this anime
  const newVotes = syncAggregateFromUserVotes(animeId);

  // Record in pending queue BEFORE network call so an immediate F5 reload never loses the vote
  const pendingKey = `${userId}_${animeId}`;
  const pending = readPendingVoteOps();
  pending[pendingKey] = {
    userId,
    animeId,
    vote: newRatingValue,
    ts: nowTs,
  };
  writePendingVoteOps(pending);

  // Persist to Firebase Firestore
  if (db) {
    const userVoteRef = doc(db, 'user_anime_votes', `${userId}_${animeId}`);
    const ratingRef = doc(db, 'anime_ratings', animeId);

    const votePromise =
      newRatingValue === null
        ? deleteDoc(userVoteRef)
        : setDoc(
            userVoteRef,
            {
              userId,
              animeId,
              vote: newRatingValue,
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );

    const aggPromise = setDoc(
      ratingRef,
      { ...newVotes, updatedAt: serverTimestamp() },
      { merge: true }
    );

    Promise.all([votePromise, aggPromise])
      .then(() => {
        const currentPending = readPendingVoteOps();
        if (currentPending[pendingKey] && currentPending[pendingKey].ts === pending[pendingKey].ts) {
          delete currentPending[pendingKey];
          writePendingVoteOps(currentPending);
        }
      })
      .catch((err) => {
        console.error('[RatingManager] Error saving vote to Firestore:', err);
      });
  }

  // Trigger local custom event so all components re-render immediately
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('kh_rating_updated', { detail: { animeId } }));
  }

  return { stats: getAnimeRatingStats(animeId) };
}

/**
 * Returns rating stats specifically for votes cast/updated within the last 24 hours.
 */
export function getAnimeRecent24hRatingStats(animeId: string): {
  recentVotesCount: number;
  recentAverage: number;
  latestTimestamp: number;
} {
  if (!animeId) {
    return { recentVotesCount: 0, recentAverage: 0, latestTimestamp: 0 };
  }
  const usersVotes = animeUserVotesMap[animeId];
  const usersTs = animeUserVoteTimestampsMap[animeId];
  if (!usersVotes || !usersTs) {
    return { recentVotesCount: 0, recentAverage: 0, latestTimestamp: 0 };
  }

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let count = 0;
  let sum = 0;
  let latestTimestamp = 0;

  for (const [uid, vote] of Object.entries(usersVotes)) {
    const ts = usersTs[uid] || 0;
    if (ts >= cutoff && vote >= 1 && vote <= 5) {
      count++;
      sum += vote;
      if (ts > latestTimestamp) {
        latestTimestamp = ts;
      }
    }
  }

  return {
    recentVotesCount: count,
    recentAverage: count > 0 ? parseFloat((sum / count).toFixed(2)) : 0,
    latestTimestamp,
  };
}

