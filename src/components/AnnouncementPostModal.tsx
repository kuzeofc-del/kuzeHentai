import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import {
  X,
  Heart,
  HeartCrack,
  MessageCircle,
  Send,
  Sparkles,
  CheckCircle2,
  Trash2,
  Maximize2,
  ChevronLeft,
  ChevronRight,
  CornerDownRight,
  Edit3,
  Users,
  Check
} from 'lucide-react';
import { User } from 'firebase/auth';
import { auth, db, doc, collection, getDoc, setDoc, onSnapshot } from '../lib/firebase';

export interface AnnouncementComment {
  id: string;
  userId: string;
  userName: string;
  userEmail?: string;
  userPhotoUrl?: string;
  text: string;
  createdAt: string;
  timestampMs: number;
  parentId?: string | null;
  edited?: boolean;
  isAdminAuthor?: boolean;
}

export interface VoterProfileInfo {
  name: string;
  photoUrl?: string;
}

export interface AnnouncementPostData {
  id: string;
  docId?: string;
  active: boolean;
  authorName?: string;
  authorPhotoUrl?: string;
  title?: string;
  content: string;
  imageUrl?: string;
  imageUrls?: string[];
  mediaChunkCounts?: number[];
  createdAt: string;
  updatedAt: string;
  votes: Record<string, 'like' | 'dislike'>; // userId -> 'like' | 'dislike'
  voterNames?: Record<string, string>; // userId -> displayName
  voterProfiles?: Record<string, VoterProfileInfo>; // userId -> { name, photoUrl }
  comments: AnnouncementComment[];
}

interface AnnouncementPostModalProps {
  currentUser: User | null;
  isWelcomeOpen?: boolean;
}

export function getPostImages(post: Partial<AnnouncementPostData> | null | undefined): string[] {
  if (!post) return [];
  if (Array.isArray(post.imageUrls) && post.imageUrls.length > 0) {
    return post.imageUrls.filter(Boolean);
  }
  if (post.imageUrl && post.imageUrl.trim()) {
    return [post.imageUrl.trim()];
  }
  return [];
}

// In-memory cache for reassembled uncompressed images so voting/commenting snapshots stay instant
const postMediaCache = new Map<string, string[]>();

export async function resolvePostImagesFromFirestore(
  post: (Partial<AnnouncementPostData> & { mediaChunkCounts?: number[] }) | null | undefined
): Promise<string[]> {
  if (!post) return [];
  const inlineImages = getPostImages(post);
  const chunkCounts = Array.isArray(post.mediaChunkCounts) ? post.mediaChunkCounts : [];
  if (chunkCounts.length === 0 || !post.id || !db) {
    return inlineImages;
  }

  const cacheKey = `${post.id}_${chunkCounts.join('-')}_${post.updatedAt || ''}`;
  const cached = postMediaCache.get(cacheKey);
  if (cached) return cached;

  try {
    const reconstructed: string[] = [];
    for (let imgIdx = 0; imgIdx < chunkCounts.length; imgIdx++) {
      const totalChunks = chunkCounts[imgIdx] || 0;
      if (totalChunks <= 0) continue;
      const chunkPromises = [];
      for (let c = 0; c < totalChunks; c++) {
        chunkPromises.push(
          getDoc(doc(db, 'announcements_media', `${post.id}_img_${imgIdx}_chunk_${c}`))
        );
      }
      const chunkSnaps = await Promise.all(chunkPromises);
      const fullDataUrl = chunkSnaps
        .map((snap) => (snap.exists() ? String(snap.data()?.data || '') : ''))
        .join('');
      if (fullDataUrl) {
        reconstructed.push(fullDataUrl);
      }
    }
    const finalImages = reconstructed.length > 0 ? reconstructed : inlineImages;
    if (finalImages.length > 0) {
      postMediaCache.set(cacheKey, finalImages);
    }
    return finalImages;
  } catch {
    return inlineImages;
  }
}

// Shared user profile resolver so reactions and comments always display latest custom name & photo
const userProfileCache = new Map<string, VoterProfileInfo>();

export async function resolveUserProfilesMap(
  uids: string[],
  fallbackNames?: Record<string, string>,
  fallbackProfiles?: Record<string, VoterProfileInfo>
): Promise<Record<string, VoterProfileInfo>> {
  const result: Record<string, VoterProfileInfo> = {};
  const uniqueUids = Array.from(new Set(uids.filter(Boolean)));

  await Promise.all(
    uniqueUids.map(async (targetUid) => {
      const savedProfile = fallbackProfiles?.[targetUid];
      const savedName = savedProfile?.name || fallbackNames?.[targetUid] || '';
      const savedPhoto = savedProfile?.photoUrl || '';

      if (db) {
        try {
          const snap = await getDoc(doc(db, 'users', targetUid));
          if (snap.exists()) {
            const data = snap.data();
            const fsName = String(
              data?.displayName || data?.username || data?.name || savedName || 'Usuario'
            ).trim();
            const fsPhoto = String(data?.photoURL || data?.photoUrl || savedPhoto || '').trim();
            const info: VoterProfileInfo = {
              name: fsName || 'Usuario',
              photoUrl: fsPhoto
            };
            userProfileCache.set(targetUid, info);
            result[targetUid] = info;
            return;
          }
        } catch {}
      }

      const cached = userProfileCache.get(targetUid);
      result[targetUid] = {
        name: cached?.name || savedName || 'Usuario',
        photoUrl: cached?.photoUrl || savedPhoto || ''
      };
    })
  );

  return result;
}

export default function AnnouncementPostModal({
  currentUser,
  isWelcomeOpen = false
}: AnnouncementPostModalProps) {
  const [posts, setPosts] = useState<AnnouncementPostData[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [openedManuallyFromProfile, setOpenedManuallyFromProfile] = useState(false);

  // Per-post interactive UI states keyed by post.id
  const [openCommentsByPost, setOpenCommentsByPost] = useState<Record<string, boolean>>({});
  const [openReactionsByPost, setOpenReactionsByPost] = useState<Record<string, boolean>>({});
  const [reactionsFilterByPost, setReactionsFilterByPost] = useState<
    Record<string, 'all' | 'like' | 'dislike'>
  >({});
  const [commentTextByPost, setCommentTextByPost] = useState<Record<string, string>>({});
  const [replyTarget, setReplyTarget] = useState<{ postId: string; commentId: string } | null>(
    null
  );
  const [replyText, setReplyText] = useState('');
  const [editingTarget, setEditingTarget] = useState<{
    postId: string;
    commentId: string;
  } | null>(null);
  const [editingText, setEditingText] = useState('');
  const [submittingPostId, setSubmittingPostId] = useState<string | null>(null);
  const [votingPostId, setVotingPostId] = useState<string | null>(null);

  const [resolvedUserName, setResolvedUserName] = useState<string>('');
  const [resolvedUserPhoto, setResolvedUserPhoto] = useState<string>('');
  const [profilesMap, setProfilesMap] = useState<Record<string, VoterProfileInfo>>({});
  const [zoomedGallery, setZoomedGallery] = useState<{
    images: string[];
    index: number;
  } | null>(null);
  const [feedbackToast, setFeedbackToast] = useState<string | null>(null);
  const [avatarErrors, setAvatarErrors] = useState<Record<string, boolean>>({});

  const uid = currentUser?.uid || '';

  // Resolve the user's accurate custom displayName and photoURL from Auth or Firestore 'users' collection
  const resolveCurrentUserProfile = useCallback(async (): Promise<{
    name: string;
    photoUrl: string;
  }> => {
    const authName = auth?.currentUser?.displayName?.trim() || currentUser?.displayName?.trim() || '';
    const authPhoto = auth?.currentUser?.photoURL || currentUser?.photoURL || '';

    if (uid && db) {
      try {
        const snap = await getDoc(doc(db, 'users', uid));
        if (snap.exists()) {
          const data = snap.data();
          const fsName = String(data?.displayName || data?.username || data?.name || '').trim();
          const fsPhoto = String(data?.photoURL || data?.photoUrl || authPhoto || '').trim();
          const finalName = fsName || authName || currentUser?.email?.split('@')[0] || 'Usuario';
          setResolvedUserName(finalName);
          setResolvedUserPhoto(fsPhoto);
          return { name: finalName, photoUrl: fsPhoto };
        }
      } catch {}
    }

    const fallbackName = authName || currentUser?.email?.split('@')[0] || 'Usuario';
    setResolvedUserName(fallbackName);
    setResolvedUserPhoto(authPhoto);
    return { name: fallbackName, photoUrl: authPhoto };
  }, [uid, currentUser]);

  useEffect(() => {
    if (uid) {
      resolveCurrentUserProfile();
    }
  }, [uid, currentUser?.displayName, currentUser?.photoURL, resolveCurrentUserProfile]);

  // Listen to custom event from UserProfileModal ("Post" card) so user can always open it manually
  useEffect(() => {
    const handleManualOpen = () => {
      resolveCurrentUserProfile();
      setOpenedManuallyFromProfile(true);
      setIsOpen(true);
    };
    window.addEventListener('kh_open_announcement_post', handleManualOpen);
    return () => window.removeEventListener('kh_open_announcement_post', handleManualOpen);
  }, [resolveCurrentUserProfile]);

  // Listen to all active announcement posts in Firestore (sorted newest first)
  useEffect(() => {
    if (!uid || !db) {
      setIsOpen(false);
      return;
    }

    let isCancelled = false;
    const colRef = collection(db, 'announcements');
    const unsubscribe = onSnapshot(
      colRef,
      async (snap) => {
        if (snap.empty) {
          setPosts([]);
          if (!openedManuallyFromProfile) {
            setIsOpen(false);
          }
          return;
        }

        const rawDocs: Array<{
          docId: string;
          raw: Partial<AnnouncementPostData> & { deleted?: boolean };
        }> = [];

        snap.docs.forEach((docSnap) => {
          const raw = docSnap.data() as Partial<AnnouncementPostData> & { deleted?: boolean };
          const hasChunkedMedia =
            Array.isArray(raw?.mediaChunkCounts) && raw.mediaChunkCounts.some((n) => n > 0);
          const inlineImages = getPostImages(raw);
          if (
            raw &&
            !raw.deleted &&
            raw.active &&
            raw.id &&
            (Boolean(raw.content?.trim()) || inlineImages.length > 0 || hasChunkedMedia)
          ) {
            rawDocs.push({ docId: docSnap.id, raw });
          }
        });

        if (rawDocs.length === 0) {
          setPosts([]);
          if (!openedManuallyFromProfile) {
            setIsOpen(false);
          }
          return;
        }

        const loadedPosts: AnnouncementPostData[] = [];
        for (const item of rawDocs) {
          const images = await resolvePostImagesFromFirestore(item.raw);
          if (isCancelled) return;
          if (!item.raw.content?.trim() && images.length === 0) continue;

          loadedPosts.push({
            id: item.raw.id!,
            docId: item.docId,
            active: Boolean(item.raw.active),
            authorName: item.raw.authorName || 'Administrador',
            authorPhotoUrl: item.raw.authorPhotoUrl || '',
            title: item.raw.title || '',
            content: item.raw.content || '',
            imageUrl: images[0] || '',
            imageUrls: images,
            mediaChunkCounts: item.raw.mediaChunkCounts || [],
            createdAt: item.raw.createdAt || new Date().toISOString(),
            updatedAt: item.raw.updatedAt || new Date().toISOString(),
            votes: item.raw.votes && typeof item.raw.votes === 'object' ? item.raw.votes : {},
            voterNames:
              item.raw.voterNames && typeof item.raw.voterNames === 'object'
                ? item.raw.voterNames
                : {},
            voterProfiles:
              item.raw.voterProfiles && typeof item.raw.voterProfiles === 'object'
                ? item.raw.voterProfiles
                : {},
            comments: Array.isArray(item.raw.comments) ? item.raw.comments : []
          });
        }

        if (isCancelled) return;

        // Sort newest first
        loadedPosts.sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );

        setPosts(loadedPosts);

        // Gather all user IDs across all posts to resolve their latest profile photo & custom name
        const allUids: string[] = [];
        const combinedVoterNames: Record<string, string> = {};
        const combinedVoterProfiles: Record<string, VoterProfileInfo> = {};

        for (const p of loadedPosts) {
          Object.keys(p.votes || {}).forEach((u) => allUids.push(u));
          (p.comments || []).forEach((c) => allUids.push(c.userId));
          Object.assign(combinedVoterNames, p.voterNames || {});
          Object.assign(combinedVoterProfiles, p.voterProfiles || {});
        }

        resolveUserProfilesMap(allUids, combinedVoterNames, combinedVoterProfiles).then(
          (resolvedMap) => {
            if (!isCancelled) {
              setProfilesMap(resolvedMap);
            }
          }
        );

        // Check if there is at least one new post that the user hasn't seen/dismissed or interacted with yet
        let hasUnseenPost = false;

        for (const p of loadedPosts) {
          const interactedKey = `kh_ann_done_${p.id}_${uid}`;
          const seenKey = `kh_ann_seen_${p.id}_${uid}`;
          const globalSeenKey = `kh_ann_seen_${p.id}`;
          const legacyDismissedDayKey = `kh_ann_dismissed_day_${p.id}_${uid}`;

          const hasVotedInCloud = Boolean(p.votes[uid]);
          const hasCommentedInCloud = p.comments.some((c) => c.userId === uid);
          const hasDoneLocally =
            localStorage.getItem(interactedKey) === '1' ||
            localStorage.getItem(seenKey) === '1' ||
            localStorage.getItem(globalSeenKey) === '1' ||
            Boolean(localStorage.getItem(legacyDismissedDayKey));

          if (hasVotedInCloud || hasCommentedInCloud || hasDoneLocally) {
            try {
              localStorage.setItem(interactedKey, '1');
              localStorage.setItem(seenKey, '1');
              localStorage.setItem(globalSeenKey, '1');
            } catch {}
            continue;
          }

          hasUnseenPost = true;
        }

        if (hasUnseenPost && !isWelcomeOpen) {
          setIsOpen(true);
        }
      },
      (err) => {
        console.warn('Announcement listener warning:', err);
      }
    );

    return () => {
      isCancelled = true;
      unsubscribe();
    };
  }, [uid, isWelcomeOpen, openedManuallyFromProfile]);

  if (!isOpen || !currentUser) return null;

  const handleDismissModal = () => {
    for (const p of posts) {
      try {
        const interactedKey = `kh_ann_done_${p.id}_${uid}`;
        const seenKey = `kh_ann_seen_${p.id}_${uid}`;
        const globalSeenKey = `kh_ann_seen_${p.id}`;
        localStorage.setItem(interactedKey, '1');
        localStorage.setItem(seenKey, '1');
        localStorage.setItem(globalSeenKey, '1');
      } catch {}
    }
    setOpenedManuallyFromProfile(false);
    setIsOpen(false);
  };

  // If opened manually from User Profile and no active posts exist right now
  if (posts.length === 0) {
    const emptyModal = (
      <div className="fixed inset-0 z-[999990] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
        <div onClick={handleDismissModal} className="fixed inset-0" />
        <div className="relative z-10 w-full max-w-sm bg-[#0b0714] border border-purple-500/35 rounded-2xl p-6 text-center space-y-4 shadow-2xl">
          <div className="w-12 h-12 rounded-2xl bg-purple-500/15 border border-purple-500/30 flex items-center justify-center mx-auto text-purple-400">
            <MessageCircle className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <h3 className="font-display font-bold text-base text-white">Post del Administrador</h3>
            <p className="text-xs font-mono text-neutral-400">
              No hay ningún post publicado en este momento.
            </p>
          </div>
          <button
            type="button"
            onClick={handleDismissModal}
            className="w-full py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-display font-bold text-xs uppercase tracking-wider cursor-pointer transition-colors"
          >
            Cerrar
          </button>
        </div>
      </div>
    );
    return typeof document !== 'undefined' ? createPortal(emptyModal, document.body) : null;
  }

  const showTempToast = (msg: string) => {
    setFeedbackToast(msg);
    setTimeout(() => {
      setFeedbackToast((prev) => (prev === msg ? null : prev));
    }, 2600);
  };

  const getDisplayInfoForUser = (
    post: AnnouncementPostData,
    targetUid: string,
    fallbackName?: string,
    fallbackPhoto?: string
  ): VoterProfileInfo => {
    if (targetUid === uid) {
      return {
        name:
          resolvedUserName ||
          currentUser?.displayName ||
          fallbackName ||
          currentUser?.email?.split('@')[0] ||
          'Usuario',
        photoUrl: resolvedUserPhoto || currentUser?.photoURL || fallbackPhoto || ''
      };
    }
    const fromLive = profilesMap[targetUid];
    const fromPostProfile = post.voterProfiles?.[targetUid];
    const fromVoterNames = post.voterNames?.[targetUid];

    return {
      name: fromLive?.name || fromPostProfile?.name || fallbackName || fromVoterNames || 'Usuario',
      photoUrl: fromLive?.photoUrl || fromPostProfile?.photoUrl || fallbackPhoto || ''
    };
  };

  // Handle Like (Full Heart) / Dislike (Broken Heart) vote for a specific post
  const handleVote = async (targetPost: AnnouncementPostData, voteType: 'like' | 'dislike') => {
    if (votingPostId === targetPost.id || !uid) return;
    setVotingPostId(targetPost.id);

    try {
      const profile = await resolveCurrentUserProfile();
      const nextVotes = { ...(targetPost.votes || {}) };
      const nextVoterNames = { ...(targetPost.voterNames || {}) };
      const nextVoterProfiles = { ...(targetPost.voterProfiles || {}) };

      nextVotes[uid] = voteType;
      nextVoterNames[uid] = profile.name;
      nextVoterProfiles[uid] = {
        name: profile.name,
        photoUrl: profile.photoUrl
      };

      const interactedKey = `kh_ann_done_${targetPost.id}_${uid}`;
      try {
        localStorage.setItem(interactedKey, '1');
      } catch {}

      setProfilesMap((prev) => ({
        ...prev,
        [uid]: { name: profile.name, photoUrl: profile.photoUrl }
      }));

      setPosts((prev) =>
        prev.map((p) =>
          p.id === targetPost.id
            ? {
                ...p,
                votes: nextVotes,
                voterNames: nextVoterNames,
                voterProfiles: nextVoterProfiles
              }
            : p
        )
      );

      const targetDocId = targetPost.docId || targetPost.id;
      await setDoc(
        doc(db, 'announcements', targetDocId),
        {
          votes: nextVotes,
          voterNames: nextVoterNames,
          voterProfiles: nextVoterProfiles,
          updatedAt: new Date().toISOString()
        },
        { merge: true }
      );

      showTempToast(
        voteType === 'like' ? '¡Reaccionaste con ❤️!' : '¡Reaccionaste con 💔!'
      );
    } catch (err) {
      console.warn('Error saving vote:', err);
    } finally {
      setVotingPostId(null);
    }
  };

  // Handle submitting a top-level comment or a nested reply on a specific post
  const handleSubmitCommentOrReply = async (
    targetPost: AnnouncementPostData,
    parentId: string | null,
    rawText: string
  ) => {
    const cleanText = rawText.trim();
    if (!cleanText || submittingPostId === targetPost.id || !uid) return;

    setSubmittingPostId(targetPost.id);
    try {
      const profile = await resolveCurrentUserProfile();
      const now = new Date();
      const newComment: AnnouncementComment = {
        id: `comm-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        userId: uid,
        userName: profile.name,
        userEmail: currentUser.email || '',
        userPhotoUrl: profile.photoUrl,
        text: cleanText,
        createdAt: now.toLocaleString('es-ES', {
          day: '2-digit',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit'
        }),
        timestampMs: Date.now(),
        parentId: parentId || null,
        edited: false
      };

      const nextComments = [...(targetPost.comments || []), newComment];

      const interactedKey = `kh_ann_done_${targetPost.id}_${uid}`;
      try {
        localStorage.setItem(interactedKey, '1');
      } catch {}

      setProfilesMap((prev) => ({
        ...prev,
        [uid]: { name: profile.name, photoUrl: profile.photoUrl }
      }));

      setPosts((prev) =>
        prev.map((p) => (p.id === targetPost.id ? { ...p, comments: nextComments } : p))
      );

      if (parentId) {
        setReplyTarget(null);
        setReplyText('');
      } else {
        setCommentTextByPost((prev) => ({ ...prev, [targetPost.id]: '' }));
      }

      const targetDocId = targetPost.docId || targetPost.id;
      await setDoc(
        doc(db, 'announcements', targetDocId),
        {
          comments: nextComments,
          updatedAt: new Date().toISOString()
        },
        { merge: true }
      );

      showTempToast(parentId ? '¡Respuesta publicada!' : '¡Comentario publicado!');
    } catch (err) {
      console.warn('Error saving comment:', err);
    } finally {
      setSubmittingPostId(null);
    }
  };

  // Handle editing own comment (ONLY author can edit their own comment)
  const handleSaveEditedComment = async (
    targetPost: AnnouncementPostData,
    commentId: string
  ) => {
    const cleanText = editingText.trim();
    if (!cleanText || !uid) return;

    const target = (targetPost.comments || []).find((c) => c.id === commentId);
    if (!target || target.userId !== uid) {
      setEditingTarget(null);
      return;
    }

    const profile = await resolveCurrentUserProfile();
    const nextComments = (targetPost.comments || []).map((c) =>
      c.id === commentId && c.userId === uid
        ? {
            ...c,
            text: cleanText,
            userName: profile.name,
            userPhotoUrl: profile.photoUrl,
            edited: true
          }
        : c
    );

    setPosts((prev) =>
      prev.map((p) => (p.id === targetPost.id ? { ...p, comments: nextComments } : p))
    );
    setEditingTarget(null);
    setEditingText('');

    try {
      const targetDocId = targetPost.docId || targetPost.id;
      await setDoc(
        doc(db, 'announcements', targetDocId),
        {
          comments: nextComments,
          updatedAt: new Date().toISOString()
        },
        { merge: true }
      );
      showTempToast('Comentario editado');
    } catch (err) {
      console.warn('Error editing comment:', err);
    }
  };

  // Delete own comment (and its child replies if top-level)
  const handleDeleteOwnComment = async (
    targetPost: AnnouncementPostData,
    commentId: string
  ) => {
    if (!uid) return;
    const target = (targetPost.comments || []).find((c) => c.id === commentId);
    if (!target || target.userId !== uid) return;

    const nextComments = (targetPost.comments || []).filter(
      (c) => c.id !== commentId && c.parentId !== commentId
    );
    setPosts((prev) =>
      prev.map((p) => (p.id === targetPost.id ? { ...p, comments: nextComments } : p))
    );
    try {
      const targetDocId = targetPost.docId || targetPost.id;
      await setDoc(
        doc(db, 'announcements', targetDocId),
        {
          comments: nextComments,
          updatedAt: new Date().toISOString()
        },
        { merge: true }
      );
    } catch {}
  };

  const hasInteractedWithAll = posts.every(
    (p) => Boolean(p.votes?.[uid]) || (p.comments || []).some((c) => c.userId === uid)
  );

  const modalContent = (
    <AnimatePresence>
      <div className="fixed inset-0 z-[999990] flex items-center justify-center p-3 sm:p-5 overflow-y-auto bg-black/80 backdrop-blur-md">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={handleDismissModal}
          className="fixed inset-0"
        />

        {/* Social Media Post Feed Modal */}
        <motion.div
          initial={{ opacity: 0, scale: 0.94, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.94, y: 16 }}
          transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
          className="relative z-10 w-full max-w-lg bg-[#0b0714] border border-purple-500/35 rounded-2xl shadow-[0_25px_70px_rgba(0,0,0,0.95)] overflow-hidden flex flex-col max-h-[90dvh]"
        >
          {/* Top Banner Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-[#120b22]/90 backdrop-blur-md shrink-0">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-purple-500/20 border border-purple-500/40 text-purple-300 text-[11px] font-mono font-bold uppercase tracking-wider">
                <Sparkles className="w-3 h-3 text-purple-400" />
                {posts.length > 1
                  ? `Posts del Administrador (${posts.length})`
                  : 'Post del Administrador'}
              </span>
            </div>
            <button
              type="button"
              onClick={handleDismissModal}
              className="p-1.5 rounded-full text-neutral-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              title="Cerrar"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Feedback Toast Banner */}
          {feedbackToast && (
            <div className="mx-4 mt-3 px-3.5 py-2 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-xs font-medium flex items-center justify-between shrink-0">
              <span>{feedbackToast}</span>
              <button
                type="button"
                onClick={handleDismissModal}
                className="ml-3 px-2.5 py-1 rounded-lg bg-emerald-500 text-black font-bold text-[11px] hover:bg-emerald-400 transition-colors cursor-pointer shrink-0"
              >
                Listo, cerrar
              </button>
            </div>
          )}

          {/* Scrollable Feed of Published Posts (Newest at Top) */}
          <div className="overflow-y-auto p-4 sm:p-5 space-y-6 scrollbar-thin scrollbar-thumb-purple-900/60 scrollbar-track-transparent">
            {posts.map((post, postIdx) => {
              const myVote = post.votes?.[uid] || null;
              const likesCount = Object.values(post.votes || {}).filter((v) => v === 'like').length;
              const dislikesCount = Object.values(post.votes || {}).filter(
                (v) => v === 'dislike'
              ).length;
              const totalReactionsCount = likesCount + dislikesCount;
              const postImages = getPostImages(post);

              const showComments = Boolean(openCommentsByPost[post.id]);
              const showReactionsModal = Boolean(openReactionsByPost[post.id]);
              const reactionsFilter = reactionsFilterByPost[post.id] || 'all';
              const currentCommentText = commentTextByPost[post.id] || '';

              // Group top-level comments and nested replies (including replies to replies) for this post
              const allComments = [...(post.comments || [])];
              const commentById = new Map<string, AnnouncementComment>();
              for (const c of allComments) {
                commentById.set(c.id, c);
              }
              const findRootCommentId = (c: AnnouncementComment): string | null => {
                if (!c.parentId) return null;
                let currParentId: string | null | undefined = c.parentId;
                let lastValidParentId: string = c.parentId;
                const visited = new Set<string>([c.id]);
                while (currParentId && !visited.has(currParentId)) {
                  visited.add(currParentId);
                  const parentObj = commentById.get(currParentId);
                  if (!parentObj) break;
                  lastValidParentId = parentObj.id;
                  currParentId = parentObj.parentId;
                }
                return lastValidParentId;
              };

              const topLevelComments: AnnouncementComment[] = [];
              const repliesByParentId = new Map<string, AnnouncementComment[]>();

              for (const c of allComments) {
                if (!c.parentId) {
                  topLevelComments.push(c);
                } else {
                  const rootId = findRootCommentId(c) || c.parentId;
                  const list = repliesByParentId.get(rootId) || [];
                  list.push(c);
                  repliesByParentId.set(rootId, list);
                }
              }
              topLevelComments.sort((a, b) => b.timestampMs - a.timestampMs);
              repliesByParentId.forEach((list) => {
                list.sort((a, b) => a.timestampMs - b.timestampMs);
              });

              const totalCommentsCount = allComments.length;

              const formattedPostDate = (() => {
                try {
                  return new Date(post.createdAt).toLocaleDateString('es-ES', {
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric'
                  });
                } catch {
                  return 'Reciente';
                }
              })();

              const reactionEntries = Object.entries(post.votes || {}).filter(
                ([voterUid, type]) => {
                  if (!voterUid) return false;
                  if (reactionsFilter === 'like') return type === 'like';
                  if (reactionsFilter === 'dislike') return type === 'dislike';
                  return true;
                }
              );

              return (
                <div
                  key={post.id}
                  className={`space-y-4 ${
                    posts.length > 1
                      ? 'p-4 rounded-2xl bg-[#110a1f]/90 border border-purple-500/25 shadow-lg'
                      : ''
                  }`}
                >
                  {/* Author Row: Admin Profile Photo + "Administrador" */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="w-11 h-11 rounded-full bg-gradient-to-br from-purple-600 to-fuchsia-600 p-0.5 shadow-md shadow-purple-600/30 shrink-0 overflow-hidden">
                        {post.authorPhotoUrl && !avatarErrors[post.id] ? (
                          <img
                            src={post.authorPhotoUrl}
                            alt="Administrador"
                            referrerPolicy="no-referrer"
                            onError={() =>
                              setAvatarErrors((prev) => ({ ...prev, [post.id]: true }))
                            }
                            className="w-full h-full rounded-full object-cover bg-[#0b0714]"
                          />
                        ) : (
                          <div className="w-full h-full rounded-full bg-[#0b0714] flex items-center justify-center font-display font-black text-sm text-white tracking-tighter">
                            AD
                          </div>
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="font-sans font-bold text-sm sm:text-base text-white">
                            Administrador
                          </span>
                          <CheckCircle2 className="w-4 h-4 text-sky-400 fill-sky-400/20 shrink-0" />
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-neutral-400 font-mono">
                          <span>@Administrador</span>
                          <span>·</span>
                          <span>{formattedPostDate}</span>
                        </div>
                      </div>
                    </div>

                    {posts.length > 1 && (
                      <span className="px-2 py-0.5 rounded-full bg-purple-500/15 border border-purple-500/30 text-[10px] font-mono text-purple-300">
                        #{postIdx + 1}
                      </span>
                    )}
                  </div>

                  {/* Post Title & Text Content */}
                  <div className="space-y-2">
                    {post.title && (
                      <h3 className="font-sans font-bold text-base sm:text-lg text-white leading-snug">
                        {post.title}
                      </h3>
                    )}
                    <p className="font-sans text-sm sm:text-[15px] text-neutral-100 whitespace-pre-line leading-relaxed">
                      {post.content}
                    </p>
                  </div>

                  {/* Attached Post Images (Single or Multi-Photo Gallery) */}
                  {postImages.length === 1 && (
                    <div
                      onClick={() => setZoomedGallery({ images: postImages, index: 0 })}
                      className="relative rounded-2xl overflow-hidden border border-white/15 bg-black/60 cursor-pointer group max-h-80 flex items-center justify-center"
                    >
                      <img
                        src={postImages[0]}
                        alt={post.title || 'Imagen del post'}
                        className="w-full max-h-80 object-contain transition-transform duration-300 group-hover:scale-[1.02]"
                      />
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setZoomedGallery({ images: postImages, index: 0 });
                        }}
                        className="absolute bottom-2.5 right-2.5 p-1.5 rounded-lg bg-black/75 border border-white/20 text-white/80 hover:text-white opacity-85 group-hover:opacity-100 transition-opacity cursor-pointer"
                        title="Ver imagen completa"
                      >
                        <Maximize2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}

                  {postImages.length > 1 && (
                    <div className="space-y-1.5">
                      <div className="grid grid-cols-2 gap-2 rounded-2xl overflow-hidden">
                        {postImages.map((imgSrc, idx) => (
                          <div
                            key={idx}
                            onClick={() => setZoomedGallery({ images: postImages, index: idx })}
                            className={`relative overflow-hidden border border-white/15 bg-black/60 cursor-pointer group rounded-xl flex items-center justify-center ${
                              postImages.length === 3 && idx === 0
                                ? 'col-span-2 max-h-60'
                                : 'h-40 sm:h-48'
                            }`}
                          >
                            <img
                              src={imgSrc}
                              alt={`Foto ${idx + 1}`}
                              className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                            />
                            <div className="absolute bottom-2 right-2 px-2 py-0.5 rounded-md bg-black/75 border border-white/15 text-[10px] font-mono text-white/90 flex items-center gap-1">
                              <Maximize2 className="w-3 h-3" />
                              <span>
                                {idx + 1}/{postImages.length}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                      <p className="text-[11px] font-mono text-neutral-400 text-center">
                        Toca cualquier foto para verla en pantalla completa ({postImages.length}{' '}
                        fotos)
                      </p>
                    </div>
                  )}

                  {/* Compact Reaction Bar: Full Heart (Like), Broken Heart (Dislike), View Reactions, and Comments Button */}
                  <div className="pt-2.5 pb-2 border-y border-white/10 flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2">
                      {/* Compact Full Heart Button (Only Icon + Count, No Text) */}
                      <button
                        type="button"
                        disabled={votingPostId === post.id}
                        onClick={() => handleVote(post, 'like')}
                        className={`py-1.5 px-2.5 rounded-xl font-mono text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer border ${
                          myVote === 'like'
                            ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.3)]'
                            : 'bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/35 text-emerald-300'
                        }`}
                        title="Me gusta"
                      >
                        <Heart
                          className={`w-4 h-4 shrink-0 ${
                            myVote === 'like'
                              ? 'fill-emerald-400 text-emerald-300'
                              : 'text-emerald-400'
                          }`}
                        />
                        <span>{likesCount}</span>
                      </button>

                      {/* Compact Broken Heart Button (Only Icon + Count, No Text) */}
                      <button
                        type="button"
                        disabled={votingPostId === post.id}
                        onClick={() => handleVote(post, 'dislike')}
                        className={`py-1.5 px-2.5 rounded-xl font-mono text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer border ${
                          myVote === 'dislike'
                            ? 'bg-rose-500/20 border-rose-500 text-rose-300 shadow-[0_0_12px_rgba(244,63,94,0.3)]'
                            : 'bg-rose-500/10 hover:bg-rose-500/20 border-rose-500/35 text-rose-300'
                        }`}
                        title="No me gusta"
                      >
                        <HeartCrack
                          className={`w-4 h-4 shrink-0 ${
                            myVote === 'dislike'
                              ? 'fill-rose-400/30 text-rose-300'
                              : 'text-rose-400'
                          }`}
                        />
                        <span>{dislikesCount}</span>
                      </button>

                      {/* Button to view who reacted with Like / Dislike */}
                      <button
                        type="button"
                        onClick={() =>
                          setOpenReactionsByPost((prev) => ({
                            ...prev,
                            [post.id]: !prev[post.id]
                          }))
                        }
                        className={`py-1.5 px-2.5 rounded-xl font-mono text-[11px] flex items-center gap-1.5 transition-all cursor-pointer border ${
                          showReactionsModal
                            ? 'bg-purple-500/25 border-purple-400 text-purple-200'
                            : 'bg-white/[0.04] hover:bg-white/10 border-white/10 text-neutral-300 hover:text-white'
                        }`}
                        title="Ver quiénes reaccionaron"
                      >
                        <Users className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                        <span>Reacciones ({totalReactionsCount})</span>
                      </button>
                    </div>

                    {/* Comments Toggle Button */}
                    <button
                      type="button"
                      onClick={() =>
                        setOpenCommentsByPost((prev) => ({
                          ...prev,
                          [post.id]: !prev[post.id]
                        }))
                      }
                      className={`py-1.5 px-3 rounded-xl font-sans text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer border shrink-0 ${
                        showComments
                          ? 'bg-purple-600/25 border-purple-400 text-purple-200 shadow-[0_0_12px_rgba(168,85,247,0.25)]'
                          : 'bg-white/[0.04] hover:bg-purple-500/15 border-white/10 text-neutral-300 hover:text-purple-200'
                      }`}
                      title="Ver y escribir comentarios"
                    >
                      <MessageCircle
                        className={`w-4 h-4 shrink-0 ${
                          showComments ? 'fill-purple-400/30 text-purple-300' : 'text-purple-400'
                        }`}
                      />
                      <span>Comentarios</span>
                      <span className="px-1.5 py-0.5 rounded-full bg-black/40 text-[11px] font-mono">
                        {totalCommentsCount}
                      </span>
                    </button>
                  </div>

                  {/* Expandable List of Users Who Reacted (with Profile Photo and Custom Name) */}
                  <AnimatePresence initial={false}>
                    {showReactionsModal && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="p-3 rounded-xl bg-[#130b21] border border-purple-500/30 space-y-2.5">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <span className="text-[11px] font-mono uppercase tracking-wider text-purple-300 font-bold">
                              Personas que reaccionaron
                            </span>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() =>
                                  setReactionsFilterByPost((prev) => ({
                                    ...prev,
                                    [post.id]: 'all'
                                  }))
                                }
                                className={`px-2 py-0.5 rounded-lg text-[10px] font-mono cursor-pointer transition-colors ${
                                  reactionsFilter === 'all'
                                    ? 'bg-purple-600 text-white font-bold'
                                    : 'bg-white/5 text-neutral-400 hover:text-white'
                                }`}
                              >
                                Todos ({totalReactionsCount})
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setReactionsFilterByPost((prev) => ({
                                    ...prev,
                                    [post.id]: 'like'
                                  }))
                                }
                                className={`px-2 py-0.5 rounded-lg text-[10px] font-mono flex items-center gap-1 cursor-pointer transition-colors ${
                                  reactionsFilter === 'like'
                                    ? 'bg-emerald-500/30 border border-emerald-500/50 text-emerald-200 font-bold'
                                    : 'bg-white/5 text-neutral-400 hover:text-emerald-300'
                                }`}
                              >
                                <Heart className="w-3 h-3 fill-emerald-400 text-emerald-400" />
                                <span>{likesCount}</span>
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setReactionsFilterByPost((prev) => ({
                                    ...prev,
                                    [post.id]: 'dislike'
                                  }))
                                }
                                className={`px-2 py-0.5 rounded-lg text-[10px] font-mono flex items-center gap-1 cursor-pointer transition-colors ${
                                  reactionsFilter === 'dislike'
                                    ? 'bg-rose-500/30 border border-rose-500/50 text-rose-200 font-bold'
                                    : 'bg-white/5 text-neutral-400 hover:text-rose-300'
                                }`}
                              >
                                <HeartCrack className="w-3 h-3 text-rose-400" />
                                <span>{dislikesCount}</span>
                              </button>
                            </div>
                          </div>

                          {reactionEntries.length === 0 ? (
                            <p className="text-xs font-mono text-neutral-500 py-2 text-center">
                              Aún no hay reacciones en esta categoría.
                            </p>
                          ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-44 overflow-y-auto pr-1">
                              {reactionEntries.map(([voterUid, voteType]) => {
                                const info = getDisplayInfoForUser(post, voterUid);
                                return (
                                  <div
                                    key={voterUid}
                                    className="flex items-center justify-between gap-2 p-2 rounded-lg bg-[#1a102c] border border-white/10"
                                  >
                                    <div className="flex items-center gap-2 min-w-0">
                                      {info.photoUrl ? (
                                        <img
                                          src={info.photoUrl}
                                          alt={info.name}
                                          referrerPolicy="no-referrer"
                                          className="w-7 h-7 rounded-full object-cover border border-purple-500/40 shrink-0"
                                        />
                                      ) : (
                                        <div className="w-7 h-7 rounded-full bg-purple-700/50 border border-purple-500/40 flex items-center justify-center text-[11px] font-bold text-white uppercase shrink-0">
                                          {(info.name || 'U').charAt(0)}
                                        </div>
                                      )}
                                      <span className="text-xs font-semibold text-white truncate">
                                        {info.name}
                                      </span>
                                    </div>
                                    {voteType === 'like' ? (
                                      <span className="p-1 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 shrink-0">
                                        <Heart className="w-3.5 h-3.5 fill-emerald-400 text-emerald-400" />
                                      </span>
                                    ) : (
                                      <span className="p-1 rounded-lg bg-rose-500/15 border border-rose-500/40 text-rose-400 shrink-0">
                                        <HeartCrack className="w-3.5 h-3.5 text-rose-400" />
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* Expandable Comments Section (with Replies & Own Comment Editing) */}
                  <AnimatePresence initial={false}>
                    {showComments && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.22 }}
                        className="overflow-hidden space-y-3 pt-1"
                      >
                        {/* Main Comment Input Form */}
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            handleSubmitCommentOrReply(post, null, currentCommentText);
                          }}
                          className="space-y-2"
                        >
                          <div className="flex items-start gap-2.5">
                            {resolvedUserPhoto || currentUser.photoURL ? (
                              <img
                                src={resolvedUserPhoto || currentUser.photoURL || ''}
                                alt={resolvedUserName}
                                referrerPolicy="no-referrer"
                                className="w-8 h-8 rounded-full object-cover border border-purple-500/40 shrink-0 mt-0.5"
                              />
                            ) : (
                              <div className="w-8 h-8 rounded-full bg-purple-900/60 border border-purple-500/40 flex items-center justify-center text-xs font-bold text-purple-200 uppercase shrink-0 mt-0.5">
                                {(resolvedUserName || 'U').charAt(0)}
                              </div>
                            )}
                            <div className="flex-1 space-y-2">
                              <textarea
                                rows={2}
                                value={currentCommentText}
                                onChange={(e) =>
                                  setCommentTextByPost((prev) => ({
                                    ...prev,
                                    [post.id]: e.target.value
                                  }))
                                }
                                placeholder="Escribe un comentario sobre esta publicación..."
                                className="w-full bg-[#140d24] border border-purple-500/30 focus:border-purple-400 rounded-xl p-2.5 text-xs sm:text-sm text-white placeholder-neutral-500 outline-none resize-none transition-colors"
                              />
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[11px] text-neutral-400 font-mono">
                                  Comentando como{' '}
                                  <strong className="text-purple-300">{resolvedUserName}</strong>
                                </span>
                                <button
                                  type="submit"
                                  disabled={
                                    !currentCommentText.trim() || submittingPostId === post.id
                                  }
                                  className="px-4 py-1.5 rounded-full bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white font-sans font-bold text-xs flex items-center gap-1.5 transition-all cursor-pointer shadow-md shadow-purple-600/25"
                                >
                                  <Send className="w-3.5 h-3.5" />
                                  <span>
                                    {submittingPostId === post.id ? 'Publicando...' : 'Comentar'}
                                  </span>
                                </button>
                              </div>
                            </div>
                          </div>
                        </form>

                        {/* Comments Thread */}
                        <div className="space-y-2.5 pt-1">
                          <div className="flex items-center justify-between">
                            <span className="font-mono text-[11px] uppercase tracking-wider text-neutral-400 font-semibold">
                              Comentarios ({totalCommentsCount})
                            </span>
                          </div>

                          {topLevelComments.length === 0 ? (
                            <div className="py-5 text-center rounded-xl bg-white/[0.02] border border-white/5">
                              <p className="text-xs text-neutral-500 font-mono">
                                Aún no hay comentarios. ¡Sé el primero en comentar!
                              </p>
                            </div>
                          ) : (
                            <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
                              {topLevelComments.map((c) => {
                                const authorInfo = getDisplayInfoForUser(
                                  post,
                                  c.userId,
                                  c.userName,
                                  c.userPhotoUrl
                                );
                                const userVoteBadge = post.votes?.[c.userId];
                                const isMine = c.userId === uid;
                                const isEditingThis =
                                  editingTarget?.postId === post.id &&
                                  editingTarget?.commentId === c.id;
                                const isReplyingThis =
                                  replyTarget?.postId === post.id &&
                                  replyTarget?.commentId === c.id;
                                const replies = repliesByParentId.get(c.id) || [];

                                return (
                                  <div
                                    key={c.id}
                                    className="p-3 rounded-xl bg-[#130b21] border border-white/10 space-y-2"
                                  >
                                    {/* Top-level Comment Header */}
                                    <div className="flex items-center justify-between gap-2">
                                      <div className="flex items-center gap-2 min-w-0">
                                        {authorInfo.photoUrl ? (
                                          <img
                                            src={authorInfo.photoUrl}
                                            alt={authorInfo.name}
                                            referrerPolicy="no-referrer"
                                            className="w-7 h-7 rounded-full object-cover border border-purple-500/40 shrink-0"
                                          />
                                        ) : (
                                          <div className="w-7 h-7 rounded-full bg-purple-600/30 border border-purple-500/40 flex items-center justify-center text-[11px] font-bold text-purple-200 uppercase shrink-0">
                                            {(authorInfo.name || 'U').charAt(0)}
                                          </div>
                                        )}
                                        <span className="font-sans font-bold text-xs text-white truncate">
                                          {authorInfo.name}
                                        </span>
                                        {c.isAdminAuthor && (
                                          <span className="px-1.5 py-0.5 rounded bg-purple-500/20 border border-purple-500/40 text-purple-300 text-[9px] font-mono font-bold uppercase shrink-0">
                                            Admin
                                          </span>
                                        )}
                                        {userVoteBadge === 'like' && (
                                          <span className="p-1 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 shrink-0">
                                            <Heart className="w-3 h-3 fill-emerald-400 text-emerald-400" />
                                          </span>
                                        )}
                                        {userVoteBadge === 'dislike' && (
                                          <span className="p-1 rounded bg-rose-500/15 border border-rose-500/30 text-rose-300 shrink-0">
                                            <HeartCrack className="w-3 h-3 text-rose-400" />
                                          </span>
                                        )}
                                      </div>
                                      <div className="flex items-center gap-1.5 shrink-0">
                                        <span className="text-[10px] font-mono text-neutral-500">
                                          {c.createdAt}
                                          {c.edited ? ' (editado)' : ''}
                                        </span>
                                      </div>
                                    </div>

                                    {/* Comment Body or Inline Edit Input */}
                                    {isEditingThis ? (
                                      <div className="pl-9 space-y-2">
                                        <textarea
                                          rows={2}
                                          value={editingText}
                                          onChange={(e) => setEditingText(e.target.value)}
                                          className="w-full bg-[#1a102c] border border-purple-500/50 rounded-lg p-2 text-xs text-white outline-none resize-none"
                                          autoFocus
                                        />
                                        <div className="flex items-center justify-end gap-2">
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setEditingTarget(null);
                                              setEditingText('');
                                            }}
                                            className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-[11px] font-mono text-neutral-300 cursor-pointer"
                                          >
                                            Cancelar
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => handleSaveEditedComment(post, c.id)}
                                            disabled={!editingText.trim()}
                                            className="px-3 py-1 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-[11px] font-semibold text-white flex items-center gap-1 cursor-pointer"
                                          >
                                            <Check className="w-3 h-3" />
                                            <span>Guardar</span>
                                          </button>
                                        </div>
                                      </div>
                                    ) : (
                                      <p className="text-xs sm:text-sm text-neutral-200 pl-9 whitespace-pre-line break-words">
                                        {c.text}
                                      </p>
                                    )}

                                    {/* Comment Actions: Responder, Editar (only author), Eliminar (only author) */}
                                    <div className="pl-9 flex items-center gap-3 pt-0.5">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setReplyTarget(
                                            isReplyingThis
                                              ? null
                                              : { postId: post.id, commentId: c.id }
                                          );
                                          setReplyText('');
                                        }}
                                        className="text-[11px] font-medium text-purple-400 hover:text-purple-300 flex items-center gap-1 cursor-pointer transition-colors"
                                      >
                                        <CornerDownRight className="w-3 h-3" />
                                        <span>Responder</span>
                                      </button>

                                      {isMine && !isEditingThis && (
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setEditingTarget({
                                              postId: post.id,
                                              commentId: c.id
                                            });
                                            setEditingText(c.text);
                                          }}
                                          className="text-[11px] font-medium text-neutral-400 hover:text-sky-300 flex items-center gap-1 cursor-pointer transition-colors"
                                        >
                                          <Edit3 className="w-3 h-3" />
                                          <span>Editar</span>
                                        </button>
                                      )}

                                      {isMine && (
                                        <button
                                          type="button"
                                          onClick={() => handleDeleteOwnComment(post, c.id)}
                                          className="text-[11px] font-medium text-neutral-400 hover:text-rose-400 flex items-center gap-1 cursor-pointer transition-colors"
                                        >
                                          <Trash2 className="w-3 h-3" />
                                          <span>Eliminar</span>
                                        </button>
                                      )}
                                    </div>

                                    {/* Inline Reply Box (Anime comments style) */}
                                    {isReplyingThis && (
                                      <div className="ml-6 sm:ml-8 pt-2 border-t border-purple-900/30">
                                        <div className="flex items-center gap-2 bg-[#180f28] border border-purple-800/50 rounded-lg p-2">
                                          <input
                                            type="text"
                                            value={replyText}
                                            onChange={(e) => setReplyText(e.target.value)}
                                            placeholder={`Responder a ${authorInfo.name}...`}
                                            className="flex-1 bg-transparent text-xs text-white placeholder-neutral-500 focus:outline-none"
                                            autoFocus
                                            onKeyDown={(e) => {
                                              if (e.key === 'Enter') {
                                                e.preventDefault();
                                                handleSubmitCommentOrReply(post, c.id, replyText);
                                              }
                                            }}
                                          />
                                          <button
                                            type="button"
                                            onClick={() => setReplyTarget(null)}
                                            className="p-1 text-neutral-400 hover:text-white cursor-pointer"
                                          >
                                            <X className="w-3.5 h-3.5" />
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() =>
                                              handleSubmitCommentOrReply(post, c.id, replyText)
                                            }
                                            disabled={
                                              submittingPostId === post.id || !replyText.trim()
                                            }
                                            className="px-2.5 py-1 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white text-[11px] font-semibold rounded transition-all cursor-pointer"
                                          >
                                            Enviar
                                          </button>
                                        </div>
                                      </div>
                                    )}

                                    {/* Nested Replies Thread */}
                                    {replies.length > 0 && (
                                      <div className="ml-6 sm:ml-8 pl-3 border-l-2 border-purple-900/40 space-y-2 pt-2">
                                        {replies.map((reply) => {
                                          const replyAuthor = getDisplayInfoForUser(
                                            post,
                                            reply.userId,
                                            reply.userName,
                                            reply.userPhotoUrl
                                          );
                                          const isReplyMine = reply.userId === uid;
                                          const isEditingReply =
                                            editingTarget?.postId === post.id &&
                                            editingTarget?.commentId === reply.id;
                                          const isReplyingToReply =
                                            replyTarget?.postId === post.id &&
                                            replyTarget?.commentId === reply.id;
                                          const parentReplyObj =
                                            reply.parentId && reply.parentId !== c.id
                                              ? commentById.get(reply.parentId)
                                              : undefined;
                                          const parentReplyAuthor = parentReplyObj
                                            ? getDisplayInfoForUser(
                                                post,
                                                parentReplyObj.userId,
                                                parentReplyObj.userName,
                                                parentReplyObj.userPhotoUrl
                                              )
                                            : null;

                                          return (
                                            <div
                                              key={reply.id}
                                              className="p-2.5 rounded-lg bg-[#180f29] border border-purple-900/30 space-y-1.5"
                                            >
                                              <div className="flex items-center justify-between gap-2">
                                                <div className="flex items-center gap-2 min-w-0">
                                                  {replyAuthor.photoUrl ? (
                                                    <img
                                                      src={replyAuthor.photoUrl}
                                                      alt={replyAuthor.name}
                                                      referrerPolicy="no-referrer"
                                                      className="w-6 h-6 rounded-full object-cover border border-purple-500/40 shrink-0"
                                                    />
                                                  ) : (
                                                    <div className="w-6 h-6 rounded-full bg-purple-700/40 border border-purple-500/40 flex items-center justify-center text-[10px] font-bold text-purple-200 uppercase shrink-0">
                                                      {(replyAuthor.name || 'U').charAt(0)}
                                                    </div>
                                                  )}
                                                  <div className="flex items-center gap-1.5 flex-nowrap min-w-0">
                                                    <span className="font-sans font-semibold text-[11px] text-purple-200 truncate">
                                                      {replyAuthor.name}
                                                    </span>
                                                    {reply.isAdminAuthor && (
                                                      <span className="px-1.5 py-0.5 rounded bg-purple-500/20 border border-purple-500/40 text-purple-300 text-[9px] font-mono font-bold uppercase shrink-0 whitespace-nowrap">
                                                        Admin
                                                      </span>
                                                    )}
                                                  </div>
                                                </div>
                                                <span className="text-[9px] font-mono text-neutral-500 shrink-0">
                                                  {reply.createdAt}
                                                  {reply.edited ? ' (editado)' : ''}
                                                </span>
                                              </div>

                                              {isEditingReply ? (
                                                <div className="pl-8 space-y-1.5">
                                                  <textarea
                                                    rows={2}
                                                    value={editingText}
                                                    onChange={(e) =>
                                                      setEditingText(e.target.value)
                                                    }
                                                    className="w-full bg-[#120b20] border border-purple-500/50 rounded-lg p-2 text-xs text-white outline-none resize-none"
                                                    autoFocus
                                                  />
                                                  <div className="flex items-center justify-end gap-2">
                                                    <button
                                                      type="button"
                                                      onClick={() => {
                                                        setEditingTarget(null);
                                                        setEditingText('');
                                                      }}
                                                      className="px-2 py-0.5 rounded bg-white/5 text-[10px] font-mono text-neutral-300 cursor-pointer"
                                                    >
                                                      Cancelar
                                                    </button>
                                                    <button
                                                      type="button"
                                                      onClick={() =>
                                                        handleSaveEditedComment(post, reply.id)
                                                      }
                                                      disabled={!editingText.trim()}
                                                      className="px-2.5 py-0.5 rounded bg-purple-600 text-[10px] font-semibold text-white cursor-pointer"
                                                    >
                                                      Guardar
                                                    </button>
                                                  </div>
                                                </div>
                                              ) : (
                                                <p className="text-xs text-neutral-200 pl-8 whitespace-pre-line break-words">
                                                  {parentReplyAuthor && (
                                                    <span className="text-purple-400 font-semibold mr-1">
                                                      @{parentReplyAuthor.name}
                                                    </span>
                                                  )}
                                                  {reply.text}
                                                </p>
                                              )}

                                              {!isEditingReply && (
                                                <div className="pl-8 flex items-center gap-3 pt-0.5">
                                                  <button
                                                    type="button"
                                                    onClick={() => {
                                                      setReplyTarget(
                                                        isReplyingToReply
                                                          ? null
                                                          : { postId: post.id, commentId: reply.id }
                                                      );
                                                      setReplyText('');
                                                    }}
                                                    className="text-[10px] font-medium text-purple-400 hover:text-purple-300 flex items-center gap-1 cursor-pointer transition-colors"
                                                  >
                                                    <CornerDownRight className="w-2.5 h-2.5" />
                                                    <span>Responder</span>
                                                  </button>

                                                  {isReplyMine && (
                                                    <>
                                                      <button
                                                        type="button"
                                                        onClick={() => {
                                                          setEditingTarget({
                                                            postId: post.id,
                                                            commentId: reply.id
                                                          });
                                                          setEditingText(reply.text);
                                                        }}
                                                        className="text-[10px] font-medium text-neutral-400 hover:text-sky-300 flex items-center gap-1 cursor-pointer"
                                                      >
                                                        <Edit3 className="w-2.5 h-2.5" />
                                                        <span>Editar</span>
                                                      </button>
                                                      <button
                                                        type="button"
                                                        onClick={() =>
                                                          handleDeleteOwnComment(post, reply.id)
                                                        }
                                                        className="text-[10px] font-medium text-neutral-400 hover:text-rose-400 flex items-center gap-1 cursor-pointer"
                                                      >
                                                        <Trash2 className="w-2.5 h-2.5" />
                                                        <span>Eliminar</span>
                                                      </button>
                                                    </>
                                                  )}
                                                </div>
                                              )}

                                              {isReplyingToReply && (
                                                <div className="pl-8 pt-1.5">
                                                  <div className="flex items-center gap-2 bg-[#180f28] border border-purple-800/50 rounded-lg p-2">
                                                    <input
                                                      type="text"
                                                      value={replyText}
                                                      onChange={(e) => setReplyText(e.target.value)}
                                                      placeholder={`Responder a ${replyAuthor.name}...`}
                                                      className="flex-1 bg-transparent text-xs text-white placeholder-neutral-500 focus:outline-none"
                                                      autoFocus
                                                      onKeyDown={(e) => {
                                                        if (e.key === 'Enter') {
                                                          e.preventDefault();
                                                          handleSubmitCommentOrReply(
                                                            post,
                                                            reply.id,
                                                            replyText
                                                          );
                                                        }
                                                      }}
                                                    />
                                                    <button
                                                      type="button"
                                                      onClick={() => setReplyTarget(null)}
                                                      className="p-1 text-neutral-400 hover:text-white cursor-pointer"
                                                    >
                                                      <X className="w-3.5 h-3.5" />
                                                    </button>
                                                    <button
                                                      type="button"
                                                      onClick={() =>
                                                        handleSubmitCommentOrReply(
                                                          post,
                                                          reply.id,
                                                          replyText
                                                        )
                                                      }
                                                      disabled={
                                                        submittingPostId === post.id ||
                                                        !replyText.trim()
                                                      }
                                                      className="px-2.5 py-1 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white text-[11px] font-semibold rounded transition-all cursor-pointer"
                                                    >
                                                      Enviar
                                                    </button>
                                                  </div>
                                                </div>
                                              )}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>

          {/* Footer Reminder Info */}
          <div className="px-4 py-2.5 border-t border-white/10 bg-[#0d0818] flex items-center justify-between gap-2 shrink-0">
            <span className="text-[11px] text-neutral-400 font-mono">
              {hasInteractedWithAll
                ? '✓ Gracias por participar.'
                : 'Toca ❤️, 💔 o 💬 para opinar.'}
            </span>
            <button
              type="button"
              onClick={handleDismissModal}
              className="px-3 py-1 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-mono text-neutral-200 hover:text-white transition-colors cursor-pointer shrink-0"
            >
              Cerrar
            </button>
          </div>
        </motion.div>

        {/* Fullscreen Image Lightbox Carousel */}
        {zoomedGallery !== null && zoomedGallery.images[zoomedGallery.index] && (
          <div
            onClick={() => setZoomedGallery(null)}
            className="fixed inset-0 z-[999999] bg-black/95 flex items-center justify-center p-4"
          >
            <button
              type="button"
              onClick={() => setZoomedGallery(null)}
              className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white cursor-pointer z-10"
            >
              <X className="w-6 h-6" />
            </button>

            {zoomedGallery.images.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setZoomedGallery((prev) =>
                      prev
                        ? {
                            ...prev,
                            index:
                              (prev.index - 1 + prev.images.length) % prev.images.length
                          }
                        : null
                    );
                  }}
                  className="absolute left-3 sm:left-6 p-2.5 rounded-full bg-white/10 hover:bg-white/25 text-white cursor-pointer z-10"
                >
                  <ChevronLeft className="w-6 h-6" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setZoomedGallery((prev) =>
                      prev
                        ? {
                            ...prev,
                            index: (prev.index + 1) % prev.images.length
                          }
                        : null
                    );
                  }}
                  className="absolute right-3 sm:right-6 p-2.5 rounded-full bg-white/10 hover:bg-white/25 text-white cursor-pointer z-10"
                >
                  <ChevronRight className="w-6 h-6" />
                </button>
                <div className="absolute bottom-5 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-black/80 border border-white/20 text-xs font-mono text-white">
                  {zoomedGallery.index + 1} / {zoomedGallery.images.length}
                </div>
              </>
            )}

            <img
              src={zoomedGallery.images[zoomedGallery.index]}
              alt={`Imagen ${zoomedGallery.index + 1}`}
              onClick={(e) => e.stopPropagation()}
              className="max-w-full max-h-[88dvh] object-contain rounded-lg shadow-2xl"
            />
          </div>
        )}
      </div>
    </AnimatePresence>
  );

  return typeof document !== 'undefined' ? createPortal(modalContent, document.body) : null;
}
