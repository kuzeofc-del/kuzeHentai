import { db } from './firebase';
import { 
  collection, 
  doc, 
  setDoc, 
  deleteDoc, 
  getDocs, 
  onSnapshot, 
  serverTimestamp 
} from 'firebase/firestore';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000; // 90 days in milliseconds

/**
 * Update user's lastLogin timestamp in Firestore upon authentication
 */
export async function updateUserLastLogin(uid: string, email?: string | null, displayName?: string | null): Promise<void> {
  if (!uid || !db) return;
  try {
    const userRef = doc(db, "users", uid);
    await setDoc(userRef, {
      uid,
      email: email || '',
      displayName: displayName || (email ? email.split('@')[0] : 'Usuario'),
      lastLogin: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
    console.log(`[Firestore User] Registered lastLogin timestamp for user ${uid}`);
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg.includes("permission") || err?.code === "permission-denied") {
      console.warn("[Firestore User] Nota: Se requieren permisos en Firestore para actualizar 'users'.", msg);
    } else {
      console.warn("[Firestore User] No se pudo actualizar lastLogin:", msg);
    }
  }
}

/**
 * Cleanup inactive user accounts (> 3 months / 90 days inactive) permanently from Firestore
 */
export async function cleanupInactiveUsers(): Promise<number> {
  if (!db) return 0;
  try {
    const usersRef = collection(db, "users");
    const snapshot = await getDocs(usersRef);
    const now = Date.now();
    let deletedCount = 0;

    const parseTimeMs = (val: any): number => {
      if (!val) return 0;
      if (typeof val.toMillis === 'function') return val.toMillis();
      if (typeof val.seconds === 'number') return val.seconds * 1000;
      if (typeof val === 'number') return val;
      if (typeof val === 'string') {
        const parsed = new Date(val).getTime();
        return isNaN(parsed) ? 0 : parsed;
      }
      return 0;
    };

    for (const userDoc of snapshot.docs) {
      const data = userDoc.data();
      const uid = userDoc.id;
      const lastLoginMs =
        parseTimeMs(data.lastLogin) ||
        parseTimeMs(data.updatedAt) ||
        parseTimeMs(data.createdAt);

      const ageMs = now - lastLoginMs;
      // If user has lastLogin record and age exceeds 90 days (3 months)
      if (lastLoginMs > 0 && ageMs > NINETY_DAYS_MS) {
        // 1. Release username reservation if present
        const nameKey =
          data.displayNameLower ||
          (data.displayName ? String(data.displayName).trim().toLowerCase() : '');
        if (nameKey) {
          try {
            await deleteDoc(doc(db, "usernames", nameKey));
          } catch {}
        }

        // 2. Delete userLists subcollection & parent doc
        try {
          const userItemsRef = collection(db, "userLists", uid, "items");
          const itemsSnap = await getDocs(userItemsRef);
          const delPromises = itemsSnap.docs.map(itemDoc => deleteDoc(doc(db, "userLists", uid, "items", itemDoc.id)));
          await Promise.all(delPromises);
          await deleteDoc(doc(db, "userLists", uid));
        } catch (e) {
          console.warn(`Error clearing userList for inactive user ${uid}:`, e);
        }

        // 3. Delete userWatched subcollection & parent doc
        try {
          const watchedItemsRef = collection(db, "userWatched", uid, "items");
          const watchedSnap = await getDocs(watchedItemsRef);
          const delWatchedPromises = watchedSnap.docs.map(itemDoc => deleteDoc(doc(db, "userWatched", uid, "items", itemDoc.id)));
          await Promise.all(delWatchedPromises);
          await deleteDoc(doc(db, "userWatched", uid));
        } catch {}

        // 4. Delete user document
        await deleteDoc(doc(db, "users", uid));
        deletedCount++;
        console.log(`[Firestore Inactivity Cleanup] Permanently deleted inactive user ${uid} (${data.email || 'no-email'}) - last active ${Math.round(ageMs / (1000 * 60 * 60 * 24))} days ago (> 3 months).`);
      }
    }

    return deletedCount;
  } catch (err: any) {
    console.warn("[Firestore User Cleanup] Omitiendo limpieza de inactivos en cliente:", err?.message || err);
    return 0;
  }
}

const MYLIST_COUNTS_CACHE_KEY = 'kh_anime_mylist_counts_v1';
const USER_SAVES_MAP_KEY = 'kh_user_mylist_map_v1';

let inMemoryMyListCounts: Record<string, number> | null = null;
let myListStatsListenerInitialized = false;

function readUserSavesMap(): Record<string, string[]> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(USER_SAVES_MAP_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeUserSavesMap(map: Record<string, string[]>): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(USER_SAVES_MAP_KEY, JSON.stringify(map));
  } catch {}
}

function recomputeCountsFromUserMap(userMap: Record<string, string[]>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const list of Object.values(userMap)) {
    if (!Array.isArray(list)) continue;
    const uniqueIds = new Set(list);
    uniqueIds.forEach((animeId) => {
      if (animeId) {
        counts[animeId] = (counts[animeId] || 0) + 1;
      }
    });
  }
  inMemoryMyListCounts = counts;
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(MYLIST_COUNTS_CACHE_KEY, JSON.stringify(counts));
    } catch {}
  }
  return counts;
}

function updateLocalUserMyListSnapshot(uid: string, animeIds: string[]): void {
  if (!uid || typeof window === 'undefined') return;
  const userMap = readUserSavesMap();
  userMap[uid] = Array.from(new Set(animeIds.filter(Boolean)));
  writeUserSavesMap(userMap);
  recomputeCountsFromUserMap(userMap);
  window.dispatchEvent(new CustomEvent('kh_hero_cycle_updated'));
}

export function initGlobalMyListStatsListener(): void {
  if (myListStatsListenerInitialized || typeof window === 'undefined' || !db) return;
  myListStatsListenerInitialized = true;

  // Defer community saves query to background so initial cards & latest episodes render instantly
  setTimeout(() => {
    try {
      const savesRef = collection(db, 'anime_mylist_saves');

      const applySavesDocs = (docs: any[]) => {
        const nextUserMap: Record<string, string[]> = {};
        const remoteUserMap: Record<string, Set<string>> = {};

        docs.forEach((docSnap) => {
          const data = typeof docSnap.data === 'function' ? docSnap.data() : docSnap;
          const uid = String(data?.userId || '');
          const animeId = String(data?.animeId || '');
          if (uid && animeId) {
            if (!remoteUserMap[uid]) remoteUserMap[uid] = new Set();
            remoteUserMap[uid].add(animeId);
          }
        });

        for (const [uid, setIds] of Object.entries(remoteUserMap)) {
          nextUserMap[uid] = applyPendingUserListOps(uid, Array.from(setIds));
        }

        writeUserSavesMap(nextUserMap);
        recomputeCountsFromUserMap(nextUserMap);
        window.dispatchEvent(new CustomEvent('kh_hero_cycle_updated'));
      };

      getDocs(savesRef)
        .then((snap) => {
          applySavesDocs(snap.docs);
        })
        .catch(() => {});

    onSnapshot(
      savesRef,
      (snapshot) => {
        applySavesDocs(snapshot.docs);
      },
      () => {
        // Fallback silently to local user map counts if collection is empty or offline
      }
    );
    } catch {}
  }, 3200);
}

/**
 * Returns the number of users who have saved a given anime in "Mi Lista" / Favoritos.
 */
export function getAnimeMyListSaveCount(animeId: string): number {
  if (!animeId) return 0;
  initGlobalMyListStatsListener();

  if (!inMemoryMyListCounts && typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(MYLIST_COUNTS_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          inMemoryMyListCounts = parsed;
        }
      }
    } catch {}
    if (!inMemoryMyListCounts) {
      inMemoryMyListCounts = recomputeCountsFromUserMap(readUserSavesMap());
    }
  }

  return (inMemoryMyListCounts && inMemoryMyListCounts[animeId]) || 0;
}

/**
 * Pending operations journal per user so an immediate reload (F5) never loses or reverts an added/removed anime
 */
const getPendingMyListKey = (uid: string) => `kh_pending_mylist_ops_${uid}`;

function readPendingMyListOps(uid: string): Record<string, { action: 'add' | 'remove'; ts: number }> {
  if (!uid || typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(getPendingMyListKey(uid));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writePendingMyListOps(uid: string, ops: Record<string, { action: 'add' | 'remove'; ts: number }>): void {
  if (!uid || typeof window === 'undefined') return;
  try {
    if (Object.keys(ops).length === 0) {
      localStorage.removeItem(getPendingMyListKey(uid));
    } else {
      localStorage.setItem(getPendingMyListKey(uid), JSON.stringify(ops));
    }
  } catch {}
}

export function applyPendingUserListOps(uid: string, baseIds: string[]): string[] {
  if (!uid) return baseIds;
  const ops = readPendingMyListOps(uid);
  const keys = Object.keys(ops);
  if (keys.length === 0) return baseIds;

  const set = new Set(baseIds);
  keys.forEach((animeId) => {
    const op = ops[animeId];
    if (!op) return;
    if (op.action === 'add') set.add(animeId);
    else if (op.action === 'remove') set.delete(animeId);
  });
  return Array.from(set);
}

async function flushPendingMyListOps(uid: string): Promise<void> {
  if (!uid || !db) return;
  const ops = readPendingMyListOps(uid);
  const entries = Object.entries(ops);
  if (entries.length === 0) return;

  for (const [animeId, op] of entries) {
    try {
      const itemRef = doc(db, "userLists", uid, "items", animeId);
      const globalSaveRef = doc(db, "anime_mylist_saves", `${uid}_${animeId}`);
      if (op.action === 'add') {
        await setDoc(itemRef, {
          animeId,
          userId: uid,
          createdAt: serverTimestamp()
        }, { merge: true });
        await setDoc(globalSaveRef, {
          animeId,
          userId: uid,
          updatedAt: serverTimestamp()
        }, { merge: true }).catch(() => {});
      } else {
        await deleteDoc(itemRef);
        await deleteDoc(globalSaveRef).catch(() => {});
      }
      const latest = readPendingMyListOps(uid);
      if (latest[animeId] && latest[animeId].ts === op.ts) {
        delete latest[animeId];
        writePendingMyListOps(uid, latest);
      }
    } catch {
      // Keep in pending queue for next retry
    }
  }
}

/**
 * Add an anime to user list in Firestore with exact timestamp createdAt
 */
export async function addAnimeToUserList(uid: string, animeId: string): Promise<void> {
  if (!uid || !animeId) return;
  const opTs = Date.now();
  const pending = readPendingMyListOps(uid);
  pending[animeId] = { action: 'add', ts: opTs };
  writePendingMyListOps(uid, pending);

  // Immediately update local save count map
  const userMap = readUserSavesMap();
  const currentList = new Set(userMap[uid] || []);
  currentList.add(animeId);
  updateLocalUserMyListSnapshot(uid, Array.from(currentList));

  if (!db) return;
  try {
    const itemRef = doc(db, "userLists", uid, "items", animeId);
    const globalSaveRef = doc(db, "anime_mylist_saves", `${uid}_${animeId}`);
    await setDoc(itemRef, {
      animeId,
      userId: uid,
      createdAt: serverTimestamp()
    }, { merge: true });
    await setDoc(globalSaveRef, {
      animeId,
      userId: uid,
      updatedAt: serverTimestamp()
    }, { merge: true }).catch(() => {});
    const latest = readPendingMyListOps(uid);
    if (latest[animeId] && latest[animeId].ts === opTs) {
      delete latest[animeId];
      writePendingMyListOps(uid, latest);
    }
  } catch (err: any) {
    console.warn("Could not add anime to Firestore list:", err?.message || err);
  }
}

/**
 * Remove an anime from user list in Firestore
 */
export async function removeAnimeFromUserList(uid: string, animeId: string): Promise<void> {
  if (!uid || !animeId) return;
  const opTs = Date.now();
  const pending = readPendingMyListOps(uid);
  pending[animeId] = { action: 'remove', ts: opTs };
  writePendingMyListOps(uid, pending);

  // Immediately update local save count map
  const userMap = readUserSavesMap();
  const currentList = new Set(userMap[uid] || []);
  currentList.delete(animeId);
  updateLocalUserMyListSnapshot(uid, Array.from(currentList));

  if (!db) return;
  try {
    const itemRef = doc(db, "userLists", uid, "items", animeId);
    const globalSaveRef = doc(db, "anime_mylist_saves", `${uid}_${animeId}`);
    await deleteDoc(itemRef);
    await deleteDoc(globalSaveRef).catch(() => {});
    const latest = readPendingMyListOps(uid);
    if (latest[animeId] && latest[animeId].ts === opTs) {
      delete latest[animeId];
      writePendingMyListOps(uid, latest);
    }
  } catch (err: any) {
    console.warn("Could not remove anime from Firestore list:", err?.message || err);
  }
}

/**
 * Cleanup expired user list items (>90 days old) permanently from Firestore
 */
export async function cleanupExpiredUserListItems(uid: string): Promise<string[]> {
  if (!uid || !db) return [];
  try {
    const listRef = collection(db, "userLists", uid, "items");
    const snapshot = await getDocs(listRef);
    const now = Date.now();
    const validAnimeIds: string[] = [];
    const deletePromises: Promise<void>[] = [];

    snapshot.forEach((document) => {
      const data = document.data();
      const animeId = data.animeId || document.id;
      let createdAtMs = now;

      if (data.createdAt) {
        if (typeof data.createdAt.toMillis === 'function') {
          createdAtMs = data.createdAt.toMillis();
        } else if (data.createdAt.seconds) {
          createdAtMs = data.createdAt.seconds * 1000;
        } else if (typeof data.createdAt === 'number') {
          createdAtMs = data.createdAt;
        }
      }

      const ageMs = now - createdAtMs;

      if (ageMs > NINETY_DAYS_MS) {
        deletePromises.push(deleteDoc(doc(db, "userLists", uid, "items", document.id)));
      } else {
        validAnimeIds.push(animeId);
      }
    });

    if (deletePromises.length > 0) {
      await Promise.all(deletePromises);
      console.log(`[Firestore Cleanup] Deleted ${deletePromises.length} expired items (>90 days old) from user ${uid}'s list.`);
    }

    return applyPendingUserListOps(uid, validAnimeIds);
  } catch (err: any) {
    console.warn("Could not cleanup expired user list items in Firestore:", err?.message || err);
    return [];
  }
}

/**
 * Subscribe to real-time changes in user list with 90-day filtering & automatic cleanup of expired items
 */
export function subscribeToUserList(
  uid: string, 
  onUpdate: (validAnimeIds: string[]) => void
): () => void {
  if (!uid || !db) return () => {};

  const listRef = collection(db, "userLists", uid, "items");
  let unsubscribe: (() => void) | null = null;

  // Flush any pending writes from before a page reload
  flushPendingMyListOps(uid).catch(() => {});

  const processDocs = (docs: any[]) => {
    const now = Date.now();
    const validAnimeIds: string[] = [];
    const expiredDocIds: string[] = [];

    docs.forEach((document) => {
      const data = typeof document.data === 'function' ? document.data() : document;
      const animeId = data.animeId || document.id;
      let createdAtMs = now;

      if (data.createdAt) {
        if (typeof data.createdAt.toMillis === 'function') {
          createdAtMs = data.createdAt.toMillis();
        } else if (data.createdAt.seconds) {
          createdAtMs = data.createdAt.seconds * 1000;
        } else if (typeof data.createdAt === 'number') {
          createdAtMs = data.createdAt;
        }
      }

      const ageMs = now - createdAtMs;

      if (ageMs > NINETY_DAYS_MS) {
        expiredDocIds.push(document.id);
      } else if (animeId) {
        validAnimeIds.push(animeId);
      }
    });

    if (expiredDocIds.length > 0) {
      expiredDocIds.forEach((docId) => {
        deleteDoc(doc(db, "userLists", uid, "items", docId)).catch(() => {});
        deleteDoc(doc(db, "anime_mylist_saves", `${uid}_${docId}`)).catch(() => {});
      });
    }

    const finalIds = applyPendingUserListOps(uid, validAnimeIds);
    updateLocalUserMyListSnapshot(uid, finalIds);
    finalIds.forEach((animeId) => {
      if (animeId && db) {
        setDoc(
          doc(db, "anime_mylist_saves", `${uid}_${animeId}`),
          { animeId, userId: uid, updatedAt: serverTimestamp() },
          { merge: true }
        ).catch(() => {});
      }
    });
    onUpdate(finalIds);
  };

  // Immediate one-shot read for fast initial sync
  getDocs(listRef)
    .then((snap) => {
      processDocs(snap.docs);
    })
    .catch(() => {});

  try {
    unsubscribe = onSnapshot(listRef, (snapshot) => {
      processDocs(snapshot.docs);
    }, (error: any) => {
      const errMsg = String(error?.message || error);
      if (error?.code === 'not-found' || errMsg.includes('NOT_FOUND') || error?.code === 'permission-denied') {
        if (unsubscribe) {
          try { unsubscribe(); } catch {}
          unsubscribe = null;
        }
      } else {
        console.warn("Firestore user list subscription error:", error);
      }
    });
  } catch (err) {
    // Graceful offline fallback
  }

  return () => {
    if (unsubscribe) {
      try { unsubscribe(); } catch {}
    }
  };
}

/**
 * Optional helper: Sync local list items to Firestore when user logs in
 */
export async function syncLocalItemsToUserList(uid: string, localIds: string[]): Promise<void> {
  if (!uid || !localIds || localIds.length === 0) return;
  try {
    for (const animeId of localIds) {
      await addAnimeToUserList(uid, animeId);
    }
  } catch (err: any) {
    console.warn("Could not sync local items to user list in Firestore:", err?.message || err);
  }
}
