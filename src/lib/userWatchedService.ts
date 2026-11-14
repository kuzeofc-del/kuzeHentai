/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

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

const getPendingWatchedKey = (uid: string) => `kh_pending_watched_ops_${uid}`;

function readPendingWatchedOps(uid: string): Record<string, { action: 'add' | 'remove'; ts: number }> {
  if (!uid || typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(getPendingWatchedKey(uid));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writePendingWatchedOps(uid: string, ops: Record<string, { action: 'add' | 'remove'; ts: number }>): void {
  if (!uid || typeof window === 'undefined') return;
  try {
    if (Object.keys(ops).length === 0) {
      localStorage.removeItem(getPendingWatchedKey(uid));
    } else {
      localStorage.setItem(getPendingWatchedKey(uid), JSON.stringify(ops));
    }
  } catch {}
}

export function applyPendingUserWatchedOps(uid: string, baseIds: string[]): string[] {
  if (!uid) return baseIds;
  const ops = readPendingWatchedOps(uid);
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

async function flushPendingWatchedOps(uid: string): Promise<void> {
  if (!uid || !db) return;
  const ops = readPendingWatchedOps(uid);
  const entries = Object.entries(ops);
  if (entries.length === 0) return;

  for (const [animeId, op] of entries) {
    try {
      const itemRef = doc(db, "userWatched", uid, "items", animeId);
      if (op.action === 'add') {
        await setDoc(itemRef, {
          animeId,
          userId: uid,
          createdAt: serverTimestamp()
        }, { merge: true });
      } else {
        await deleteDoc(itemRef);
      }
      const latest = readPendingWatchedOps(uid);
      if (latest[animeId] && latest[animeId].ts === op.ts) {
        delete latest[animeId];
        writePendingWatchedOps(uid, latest);
      }
    } catch {
      // Keep in pending queue for next retry
    }
  }
}

/**
 * Add an anime to user's watched list in Firestore
 */
export async function addAnimeToWatched(uid: string, animeId: string): Promise<void> {
  if (!uid || !animeId) return;
  const opTs = Date.now();
  const pending = readPendingWatchedOps(uid);
  pending[animeId] = { action: 'add', ts: opTs };
  writePendingWatchedOps(uid, pending);

  if (!db) return;
  try {
    const itemRef = doc(db, "userWatched", uid, "items", animeId);
    await setDoc(itemRef, {
      animeId,
      userId: uid,
      createdAt: serverTimestamp()
    }, { merge: true });
    const latest = readPendingWatchedOps(uid);
    if (latest[animeId] && latest[animeId].ts === opTs) {
      delete latest[animeId];
      writePendingWatchedOps(uid, latest);
    }
  } catch (err: any) {
    console.warn("[Firestore Watched] Could not add anime to watched list:", err?.message || err);
  }
}

/**
 * Remove an anime from user's watched list in Firestore
 */
export async function removeAnimeFromWatched(uid: string, animeId: string): Promise<void> {
  if (!uid || !animeId) return;
  const opTs = Date.now();
  const pending = readPendingWatchedOps(uid);
  pending[animeId] = { action: 'remove', ts: opTs };
  writePendingWatchedOps(uid, pending);

  if (!db) return;
  try {
    const itemRef = doc(db, "userWatched", uid, "items", animeId);
    await deleteDoc(itemRef);
    const latest = readPendingWatchedOps(uid);
    if (latest[animeId] && latest[animeId].ts === opTs) {
      delete latest[animeId];
      writePendingWatchedOps(uid, latest);
    }
  } catch (err: any) {
    console.warn("[Firestore Watched] Could not remove anime from watched list:", err?.message || err);
  }
}

/**
 * Subscribe to real-time changes in user watched list in Firestore
 */
export function subscribeToUserWatched(
  uid: string, 
  onUpdate: (animeIds: string[]) => void
): () => void {
  if (!uid || !db) return () => {};

  const listRef = collection(db, "userWatched", uid, "items");
  let unsubscribe: (() => void) | null = null;

  flushPendingWatchedOps(uid).catch(() => {});

  const processDocs = (docs: any[]) => {
    const animeIds: string[] = [];
    docs.forEach((document) => {
      const data = typeof document.data === 'function' ? document.data() : document;
      const animeId = data.animeId || document.id;
      if (animeId) {
        animeIds.push(animeId);
      }
    });
    onUpdate(applyPendingUserWatchedOps(uid, animeIds));
  };

  getDocs(listRef)
    .then((snap) => {
      processDocs(snap.docs);
    })
    .catch(() => {});

  try {
    unsubscribe = onSnapshot(listRef, (snapshot) => {
      processDocs(snapshot.docs);
    }, (err) => {
      console.warn("[Firestore Watched] Snapshot error:", err?.message || err);
    });
  } catch (err) {
    console.warn("[Firestore Watched] Failed to attach listener:", err);
  }

  return () => {
    if (unsubscribe) {
      unsubscribe();
    }
  };
}

/**
 * Sync guest watched items into the user's permanent Firestore account
 */
export async function syncLocalWatchedToUser(uid: string, localIds: string[]): Promise<void> {
  if (!uid || !localIds || localIds.length === 0) return;
  try {
    const promises = localIds.map(animeId => addAnimeToWatched(uid, animeId));
    await Promise.all(promises);
  } catch (err) {
    console.warn("[Firestore Watched] Failed to sync local watched items:", err);
  }
}

