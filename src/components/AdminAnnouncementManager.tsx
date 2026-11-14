import React, { useState, useEffect, useRef } from 'react';
import {
  Plus,
  Trash2,
  Heart,
  HeartCrack,
  MessageCircle,
  CheckCircle2,
  Send,
  Image as ImageIcon,
  X,
  Edit3,
  Camera,
  Maximize2,
  ChevronLeft,
  ChevronRight,
  Users,
  CornerDownRight,
  Check
} from 'lucide-react';
import {
  auth,
  db,
  doc,
  collection,
  getDocs,
  setDoc,
  deleteDoc,
  onSnapshot
} from '../lib/firebase';
import {
  AnnouncementPostData,
  AnnouncementComment,
  VoterProfileInfo,
  getPostImages,
  resolvePostImagesFromFirestore,
  resolveUserProfilesMap
} from './AnnouncementPostModal';

interface AdminAnnouncementManagerProps {
  onShowNotification: (message: string, type: 'success' | 'error') => void;
  onSetProgress?: (progress: { percent: number } | null) => void;
}

const ensureSafeAvatarImage = (
  dataUrl: string,
  maxBase64Length = 90000,
  maxDim = 256
): Promise<string> => {
  if (!dataUrl || !dataUrl.startsWith('data:image/')) {
    return Promise.resolve(dataUrl);
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
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
        while (result.length > maxBase64Length && quality > 0.3) {
          quality -= 0.12;
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

const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => resolve((ev.target?.result as string) || '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

const clearPostMediaChunksByPostId = async (targetPostId: string) => {
  if (!db || !targetPostId) return;
  try {
    const snap = await getDocs(collection(db, 'announcements_media'));
    if (!snap.empty) {
      const toDelete = snap.docs.filter(
        (d) =>
          d.id.startsWith(`${targetPostId}_img_`) || d.data()?.postId === targetPostId
      );
      if (toDelete.length > 0) {
        await Promise.all(toDelete.map((d) => deleteDoc(d.ref)));
      }
    }
  } catch {}
};

export default function AdminAnnouncementManager({
  onShowNotification,
  onSetProgress
}: AdminAnnouncementManagerProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Published posts from Firestore (sorted newest first)
  const [publishedPosts, setPublishedPosts] = useState<AnnouncementPostData[]>([]);
  const [profilesMap, setProfilesMap] = useState<Record<string, VoterProfileInfo>>({});

  // Form visibility & editing state
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingPost, setEditingPost] = useState<AnnouncementPostData | null>(null);

  // Form fields
  const [title, setTitle] = useState<string>('');
  const [content, setContent] = useState<string>('');
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [adminAvatarUrl, setAdminAvatarUrl] = useState<string>('');

  // Per-post delete confirmation popover state ("¿Estás seguro?" -> Sí / No)
  const [deleteConfirmPostId, setDeleteConfirmPostId] = useState<string | null>(null);

  // Per-post Reactions & Comments UI state
  const [openReactionsByPost, setOpenReactionsByPost] = useState<Record<string, boolean>>({});
  const [reactionsFilterByPost, setReactionsFilterByPost] = useState<
    Record<string, 'all' | 'like' | 'dislike'>
  >({});
  const [openCommentsByPost, setOpenCommentsByPost] = useState<Record<string, boolean>>({});
  const [replyTarget, setReplyTarget] = useState<{ postId: string; commentId: string } | null>(
    null
  );
  const [replyText, setReplyText] = useState('');
  const [editingTarget, setEditingTarget] = useState<{
    postId: string;
    commentId: string;
  } | null>(null);
  const [editingText, setEditingText] = useState('');
  const [avatarLoadError, setAvatarLoadError] = useState(false);
  const [zoomedGallery, setZoomedGallery] = useState<{
    images: string[];
    index: number;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // Sync Admin Google profile picture or saved custom admin avatar
  useEffect(() => {
    const savedCustomAvatar = localStorage.getItem('kh_admin_custom_avatar') || '';
    const googlePhoto = auth?.currentUser?.photoURL || '';
    setAdminAvatarUrl(savedCustomAvatar || googlePhoto);
  }, []);

  // Listen to all published posts in Firestore
  useEffect(() => {
    if (!db) {
      setLoading(false);
      return;
    }

    let isCancelled = false;
    const colRef = collection(db, 'announcements');
    const unsub = onSnapshot(
      colRef,
      async (snap) => {
        if (snap.empty) {
          setLoading(false);
          setPublishedPosts([]);
          return;
        }

        const rawDocs: Array<{
          docId: string;
          data: Partial<AnnouncementPostData> & { deleted?: boolean };
        }> = [];

        snap.docs.forEach((docSnap) => {
          const data = docSnap.data() as Partial<AnnouncementPostData> & { deleted?: boolean };
          const hasChunkedMedia =
            Array.isArray(data?.mediaChunkCounts) && data.mediaChunkCounts.some((n) => n > 0);
          const inlineImages = getPostImages(data);

          if (
            data &&
            !data.deleted &&
            data.id &&
            (Boolean(data.content?.trim()) || inlineImages.length > 0 || hasChunkedMedia)
          ) {
            rawDocs.push({ docId: docSnap.id, data });
          }
        });

        if (rawDocs.length === 0) {
          setLoading(false);
          setPublishedPosts([]);
          return;
        }

        const googlePhoto = auth?.currentUser?.photoURL || '';
        const savedCustomAvatar = localStorage.getItem('kh_admin_custom_avatar') || '';

        const loaded: AnnouncementPostData[] = [];
        for (const item of rawDocs) {
          const images = await resolvePostImagesFromFirestore(item.data);
          if (isCancelled) return;
          if (!item.data.content?.trim() && images.length === 0) continue;

          const resolvedPhoto = item.data.authorPhotoUrl || savedCustomAvatar || googlePhoto;

          loaded.push({
            id: item.data.id!,
            docId: item.docId,
            active: Boolean(item.data.active),
            authorName: 'Administrador',
            authorPhotoUrl: resolvedPhoto,
            title: item.data.title || '',
            content: item.data.content || '',
            imageUrl: images[0] || '',
            imageUrls: images,
            mediaChunkCounts: item.data.mediaChunkCounts || [],
            createdAt: item.data.createdAt || new Date().toISOString(),
            updatedAt: item.data.updatedAt || new Date().toISOString(),
            votes: item.data.votes && typeof item.data.votes === 'object' ? item.data.votes : {},
            voterNames:
              item.data.voterNames && typeof item.data.voterNames === 'object'
                ? item.data.voterNames
                : {},
            voterProfiles:
              item.data.voterProfiles && typeof item.data.voterProfiles === 'object'
                ? item.data.voterProfiles
                : {},
            comments: Array.isArray(item.data.comments) ? item.data.comments : []
          });
        }

        if (isCancelled) return;
        setLoading(false);

        // Sort newest first
        loaded.sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );

        setPublishedPosts(loaded);
        setAvatarLoadError(false);

        if (loaded[0]?.authorPhotoUrl && !adminAvatarUrl) {
          setAdminAvatarUrl(loaded[0].authorPhotoUrl);
        }

        const allUids: string[] = [];
        const combinedVoterNames: Record<string, string> = {};
        const combinedVoterProfiles: Record<string, VoterProfileInfo> = {};

        for (const p of loaded) {
          Object.keys(p.votes || {}).forEach((u) => allUids.push(u));
          (p.comments || []).forEach((c) => allUids.push(c.userId));
          Object.assign(combinedVoterNames, p.voterNames || {});
          Object.assign(combinedVoterProfiles, p.voterProfiles || {});
        }

        resolveUserProfilesMap(allUids, combinedVoterNames, combinedVoterProfiles).then((map) => {
          if (!isCancelled) {
            setProfilesMap(map);
          }
        });
      },
      () => {
        setLoading(false);
      }
    );

    return () => {
      isCancelled = true;
      unsub();
    };
  }, [adminAvatarUrl]);

  // Open form to create a brand new post
  const handleOpenNewPostForm = () => {
    setEditingPost(null);
    setTitle('');
    setContent('');
    setImageUrls([]);
    const savedCustomAvatar = localStorage.getItem('kh_admin_custom_avatar') || '';
    const googlePhoto =
      auth?.currentUser?.photoURL || publishedPosts[0]?.authorPhotoUrl || '';
    setAdminAvatarUrl(savedCustomAvatar || googlePhoto);
    setIsFormOpen(true);
  };

  // Open form to edit a specific published post
  const handleOpenEditPostForm = (post: AnnouncementPostData) => {
    setEditingPost(post);
    setTitle(post.title || '');
    setContent(post.content || '');
    setImageUrls(getPostImages(post));
    setAdminAvatarUrl(
      post.authorPhotoUrl ||
        localStorage.getItem('kh_admin_custom_avatar') ||
        auth?.currentUser?.photoURL ||
        ''
    );
    setIsFormOpen(true);
  };

  // Read selected images in 100% original uncompressed quality (no canvas/webp compression)
  const handleImagesSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files: File[] = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    if (files.length === 0) return;

    const rawImages: string[] = [];
    for (const file of files) {
      try {
        const rawDataUrl = await readFileAsDataUrl(file);
        if (rawDataUrl) {
          rawImages.push(rawDataUrl);
        }
      } catch {}
    }

    if (rawImages.length > 0) {
      setImageUrls((prev) => [...prev, ...rawImages]);
    }
  };

  const handleRemoveImageAt = (indexToRemove: number) => {
    setImageUrls((prev) => prev.filter((_, idx) => idx !== indexToRemove));
  };

  const handleAvatarSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const raw = ev.target?.result as string;
      if (raw) {
        const optimized = await ensureSafeAvatarImage(raw, 90000, 256);
        setAdminAvatarUrl(optimized);
        setAvatarLoadError(false);
        try {
          localStorage.setItem('kh_admin_custom_avatar', optimized);
        } catch {}
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handlePublishPost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim() && imageUrls.length === 0) {
      onShowNotification(
        'Escribe el mensaje o agrega al menos una foto antes de publicar.',
        'error'
      );
      return;
    }

    setSaving(true);
    onSetProgress?.({ percent: 20 });

    try {
      // Keep 100% original uncompressed images
      const originalImages = imageUrls.filter(Boolean);

      const resolvedAvatar =
        adminAvatarUrl ||
        auth?.currentUser?.photoURL ||
        editingPost?.authorPhotoUrl ||
        publishedPosts[0]?.authorPhotoUrl ||
        '';

      const nowIso = new Date().toISOString();
      const isNew = !editingPost;
      const nextId = isNew ? `post-${Date.now()}` : editingPost.id;
      const targetDocId = isNew ? nextId : editingPost.docId || editingPost.id;

      // If editing an existing post, clean up only that post's previous media chunks
      if (!isNew) {
        await clearPostMediaChunksByPostId(nextId);
      }
      onSetProgress?.({ percent: 45 });

      const totalChars = originalImages.reduce((acc, s) => acc + s.length, 0);
      const CHUNK_SIZE = 700000;
      let inlineImageUrls: string[] = [];
      const mediaChunkCounts: number[] = [];

      if (totalChars <= 650000) {
        inlineImageUrls = originalImages;
      } else {
        for (let imgIdx = 0; imgIdx < originalImages.length; imgIdx++) {
          const fullImg = originalImages[imgIdx];
          const numChunks = Math.ceil(fullImg.length / CHUNK_SIZE);
          mediaChunkCounts.push(numChunks);

          const chunkWrites = [];
          for (let c = 0; c < numChunks; c++) {
            const slice = fullImg.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE);
            chunkWrites.push(
              setDoc(doc(db, 'announcements_media', `${nextId}_img_${imgIdx}_chunk_${c}`), {
                postId: nextId,
                imgIndex: imgIdx,
                chunkIndex: c,
                data: slice,
                updatedAt: nowIso
              })
            );
          }
          await Promise.all(chunkWrites);
        }
      }

      onSetProgress?.({ percent: 80 });

      const payload: AnnouncementPostData = {
        id: nextId,
        active: true,
        authorName: 'Administrador',
        authorPhotoUrl: resolvedAvatar,
        title: title.trim(),
        content: content.trim(),
        imageUrl: inlineImageUrls[0] || '',
        imageUrls: inlineImageUrls,
        mediaChunkCounts,
        createdAt: isNew ? nowIso : editingPost.createdAt || nowIso,
        updatedAt: nowIso,
        votes: isNew ? {} : editingPost.votes || {},
        voterNames: isNew ? {} : editingPost.voterNames || {},
        voterProfiles: isNew ? {} : editingPost.voterProfiles || {},
        comments: isNew ? [] : editingPost.comments || []
      };

      await setDoc(doc(db, 'announcements', targetDocId), payload);

      onSetProgress?.({ percent: 100 });
      await new Promise((r) => setTimeout(r, 220));

      setIsFormOpen(false);
      setEditingPost(null);

      onShowNotification(
        isNew
          ? '¡Post publicado! Ahora aparecerá debajo y se enviará a los usuarios registrados.'
          : '¡Post actualizado correctamente!',
        'success'
      );
    } catch (err: any) {
      onShowNotification('Error al publicar el post: ' + (err?.message || 'Error de red'), 'error');
    } finally {
      setSaving(false);
      onSetProgress?.(null);
    }
  };

  // Delete a specific post, all its comments, replies, votes, voter profiles, and media chunks from Firestore
  const handleDeletePost = async (postToDelete: AnnouncementPostData) => {
    try {
      setDeleteConfirmPostId(null);
      onSetProgress?.({ percent: 30 });
      const targetDocId = postToDelete.docId || postToDelete.id;
      const postRef = doc(db, 'announcements', targetDocId);

      await setDoc(postRef, {
        id: '',
        active: false,
        deleted: true,
        title: '',
        content: '',
        imageUrl: '',
        imageUrls: [],
        mediaChunkCounts: [],
        votes: {},
        voterNames: {},
        voterProfiles: {},
        comments: [],
        updatedAt: new Date().toISOString()
      });

      onSetProgress?.({ percent: 65 });
      await clearPostMediaChunksByPostId(postToDelete.id);
      await deleteDoc(postRef);

      onSetProgress?.({ percent: 100 });
      await new Promise((r) => setTimeout(r, 200));

      if (editingPost?.id === postToDelete.id) {
        setIsFormOpen(false);
        setEditingPost(null);
      }

      onShowNotification(
        'Post, comentarios, reacciones y fotos borrados por completo de la base de datos.',
        'success'
      );
    } catch (err: any) {
      onShowNotification('Error al borrar el post: ' + (err?.message || 'Error de red'), 'error');
    } finally {
      onSetProgress?.(null);
    }
  };

  // Admin can reply to comments on any post
  const handleAdminReply = async (targetPost: AnnouncementPostData, parentId: string) => {
    const cleanText = replyText.trim();
    if (!cleanText) return;

    const adminUid = auth?.currentUser?.uid || 'admin';
    const effectiveAdminPhoto =
      adminAvatarUrl ||
      targetPost.authorPhotoUrl ||
      auth?.currentUser?.photoURL ||
      '';
    const now = new Date();
    const newReply: AnnouncementComment = {
      id: `comm-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      userId: adminUid,
      userName: 'Administrador',
      userEmail: auth?.currentUser?.email || '',
      userPhotoUrl: effectiveAdminPhoto,
      text: cleanText,
      createdAt: now.toLocaleString('es-ES', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      }),
      timestampMs: Date.now(),
      parentId,
      edited: false,
      isAdminAuthor: true
    };

    const nextComments = [...(targetPost.comments || []), newReply];
    setReplyTarget(null);
    setReplyText('');

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
      onShowNotification('Respuesta publicada', 'success');
    } catch {
      onShowNotification('Error al publicar respuesta', 'error');
    }
  };

  // Admin can edit ONLY their own comment/reply
  const handleAdminEditOwnComment = async (
    targetPost: AnnouncementPostData,
    commentId: string
  ) => {
    const cleanText = editingText.trim();
    if (!cleanText) return;
    const adminUid = auth?.currentUser?.uid || 'admin';

    const target = (targetPost.comments || []).find((c) => c.id === commentId);
    if (!target || (target.userId !== adminUid && !target.isAdminAuthor)) {
      setEditingTarget(null);
      return;
    }

    const nextComments = (targetPost.comments || []).map((c) =>
      c.id === commentId ? { ...c, text: cleanText, edited: true } : c
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
      onShowNotification('Comentario actualizado', 'success');
    } catch {
      onShowNotification('Error al editar comentario', 'error');
    }
  };

  const handleDeleteComment = async (
    targetPost: AnnouncementPostData,
    commentId: string
  ) => {
    const nextComments = (targetPost.comments || []).filter(
      (c) => c.id !== commentId && c.parentId !== commentId
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
      onShowNotification('Comentario eliminado', 'success');
    } catch {
      onShowNotification('Error al eliminar comentario', 'error');
    }
  };

  const getDisplayInfoForUser = (
    post: AnnouncementPostData,
    targetUid: string,
    fallbackName?: string,
    fallbackPhoto?: string,
    isAdminAuthor?: boolean
  ): VoterProfileInfo => {
    if (isAdminAuthor) {
      return {
        name: 'Administrador',
        photoUrl:
          adminAvatarUrl ||
          post.authorPhotoUrl ||
          fallbackPhoto ||
          auth?.currentUser?.photoURL ||
          ''
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

  const effectiveAvatar =
    adminAvatarUrl ||
    publishedPosts[0]?.authorPhotoUrl ||
    auth?.currentUser?.photoURL ||
    '';

  const adminUid = auth?.currentUser?.uid || 'admin';

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Top Section: "Agregar Post" Button + Total Published Counter */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <button
          type="button"
          onClick={() => {
            if (isFormOpen) {
              setIsFormOpen(false);
              setEditingPost(null);
            } else {
              handleOpenNewPostForm();
            }
          }}
          className="w-full sm:w-auto px-6 py-3.5 rounded-xl bg-brand-red hover:bg-brand-red-hover text-white font-display font-bold text-xs sm:text-sm uppercase tracking-wider flex items-center justify-center gap-2.5 transition-all cursor-pointer shadow-lg shadow-brand-red/25"
        >
          {isFormOpen ? (
            <>
              <X className="w-4 h-4" />
              <span>Cerrar Formulario</span>
            </>
          ) : (
            <>
              <Plus className="w-5 h-5" />
              <span>Agregar Post</span>
            </>
          )}
        </button>

        {publishedPosts.length > 0 && (
          <span className="px-3 py-1.5 rounded-xl bg-purple-500/15 border border-purple-500/30 text-xs font-mono text-purple-300">
            {publishedPosts.length === 1
              ? '1 Post publicado'
              : `${publishedPosts.length} Posts publicados`}
          </span>
        )}
      </div>

      {/* Collapsible Form: Only shown after clicking "Agregar Post" (or "Editar") */}
      {isFormOpen && (
        <form
          onSubmit={handlePublishPost}
          className="bg-[#0b0714] border border-purple-500/40 rounded-2xl p-5 space-y-4 shadow-2xl"
        >
          {/* Author Header Preview inside Form with option to customize profile photo */}
          <div className="flex items-center justify-between gap-3 pb-3 border-b border-white/10">
            <div className="flex items-center gap-3">
              <div className="relative group shrink-0">
                <div className="w-11 h-11 rounded-full bg-gradient-to-br from-purple-600 to-fuchsia-600 p-0.5 overflow-hidden">
                  {effectiveAvatar && !avatarLoadError ? (
                    <img
                      src={effectiveAvatar}
                      alt="Administrador"
                      referrerPolicy="no-referrer"
                      onError={() => setAvatarLoadError(true)}
                      className="w-full h-full rounded-full object-cover bg-[#0b0714]"
                    />
                  ) : (
                    <div className="w-full h-full rounded-full bg-[#0b0714] flex items-center justify-center font-display font-black text-xs text-white">
                      AD
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => avatarInputRef.current?.click()}
                  className="absolute -bottom-1 -right-1 p-1 rounded-full bg-purple-600 hover:bg-purple-500 text-white border border-black shadow cursor-pointer"
                  title="Cambiar mi foto de perfil"
                >
                  <Camera className="w-3 h-3" />
                </button>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleAvatarSelect}
                  className="hidden"
                />
              </div>

              <div>
                <div className="flex items-center gap-1.5">
                  <span className="font-sans font-bold text-sm sm:text-base text-white">
                    Administrador
                  </span>
                  <CheckCircle2 className="w-4 h-4 text-sky-400 fill-sky-400/20" />
                </div>
                <span className="text-xs font-mono text-neutral-400">@Administrador</span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => avatarInputRef.current?.click()}
              className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] font-mono text-purple-300 cursor-pointer"
            >
              Cambiar foto perfil
            </button>
          </div>

          {/* Optional Title */}
          <div className="space-y-1.5">
            <label className="font-mono text-[10px] text-neutral-400 uppercase tracking-widest block">
              Título (Opcional)
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ej: Nueva función o pregunta para la comunidad..."
              className="w-full bg-[#130c21] border border-purple-500/30 focus:border-purple-400 rounded-xl p-2.5 text-sm text-white placeholder-neutral-500 outline-none transition-colors"
            />
          </div>

          {/* Post Message Content */}
          <div className="space-y-1.5">
            <label className="font-mono text-[10px] text-neutral-400 uppercase tracking-widest block">
              Contenido del Post *
            </label>
            <textarea
              rows={4}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="¿Qué quieres comunicar o preguntar a los usuarios registrados?"
              className="w-full bg-[#130c21] border border-purple-500/30 focus:border-purple-400 rounded-xl p-3 text-sm text-white placeholder-neutral-500 outline-none transition-colors resize-y"
            />
          </div>

          {/* Multi-Photo Upload Section */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <label className="font-mono text-[10px] text-neutral-400 uppercase tracking-widest block">
                Fotos Adjuntas ({imageUrls.length})
              </label>
              {imageUrls.length > 0 && (
                <button
                  type="button"
                  onClick={() => setImageUrls([])}
                  className="text-[11px] font-mono text-rose-400 hover:text-rose-300 cursor-pointer"
                >
                  Quitar todas
                </button>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleImagesSelect}
              className="hidden"
            />

            {/* Grid of Selected Photos */}
            {imageUrls.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                {imageUrls.map((imgSrc, idx) => (
                  <div
                    key={idx}
                    className="relative group rounded-xl overflow-hidden border border-purple-500/40 bg-black/60 h-36 flex items-center justify-center"
                  >
                    <img
                      src={imgSrc}
                      alt={`Foto ${idx + 1}`}
                      className="w-full h-full object-cover"
                    />
                    <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/80 text-[10px] font-mono text-white">
                      #{idx + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRemoveImageAt(idx)}
                      className="absolute top-1.5 right-1.5 p-1 rounded-full bg-rose-600 hover:bg-rose-500 text-white shadow cursor-pointer"
                      title="Quitar esta foto"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}

                {/* Add More Photos Tile */}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="h-36 rounded-xl border border-dashed border-purple-500/40 hover:border-purple-400 bg-[#130c21]/50 hover:bg-purple-950/30 transition-all flex flex-col items-center justify-center gap-1.5 text-purple-300 cursor-pointer"
                >
                  <Plus className="w-6 h-6" />
                  <span className="text-xs font-medium">Agregar más fotos</span>
                </button>
              </div>
            )}

            {imageUrls.length === 0 && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full py-4 border border-dashed border-purple-500/35 hover:border-purple-400 rounded-xl bg-[#130c21]/60 hover:bg-purple-950/25 transition-all flex items-center justify-center gap-2.5 cursor-pointer text-purple-300"
              >
                <ImageIcon className="w-5 h-5" />
                <span className="text-xs sm:text-sm font-medium">
                  Agregar fotos al post (Puedes elegir todas las que quieras)
                </span>
              </button>
            )}
          </div>

          {/* Submit / Publish Button */}
          <div className="pt-2 flex items-center justify-end gap-3 border-t border-white/10">
            <button
              type="button"
              onClick={() => {
                setIsFormOpen(false);
                setEditingPost(null);
              }}
              className="px-4 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-neutral-300 text-xs font-mono uppercase tracking-wider cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-6 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-display font-bold text-xs uppercase tracking-wider flex items-center gap-2 transition-all cursor-pointer shadow-lg shadow-purple-600/30"
            >
              <Send className="w-4 h-4" />
              <span>
                {saving
                  ? 'Publicando...'
                  : editingPost
                  ? 'Guardar Cambios'
                  : 'Publicar Post'}
              </span>
            </button>
          </div>
        </form>
      )}

      {/* Feed of Published Posts Below the Button (Newest First) */}
      {!loading &&
        publishedPosts.map((publishedPost, postIdx) => {
          const likesCount = Object.values(publishedPost.votes || {}).filter(
            (v) => v === 'like'
          ).length;
          const dislikesCount = Object.values(publishedPost.votes || {}).filter(
            (v) => v === 'dislike'
          ).length;
          const totalReactionsCount = likesCount + dislikesCount;
          const publishedImages = getPostImages(publishedPost);

          const showReactionsList = Boolean(openReactionsByPost[publishedPost.id]);
          const reactionsFilter = reactionsFilterByPost[publishedPost.id] || 'all';
          // Default comments to open in Admin panel unless toggled closed
          const showPostComments =
            openCommentsByPost[publishedPost.id] === undefined
              ? true
              : openCommentsByPost[publishedPost.id];
          const showDeleteConfirm = deleteConfirmPostId === publishedPost.id;

          // Group top-level comments and nested replies (including replies to replies) for this post
          const allComments = [...(publishedPost.comments || [])];
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

          const reactionEntries = Object.entries(publishedPost.votes || {}).filter(
            ([voterUid, voteType]) => {
              if (!voterUid) return false;
              if (reactionsFilter === 'like') return voteType === 'like';
              if (reactionsFilter === 'dislike') return voteType === 'dislike';
              return true;
            }
          );

          const formattedPostDate = (() => {
            if (!publishedPost.createdAt) return 'Ahora';
            try {
              return new Date(publishedPost.createdAt).toLocaleDateString('es-ES', {
                day: '2-digit',
                month: 'short',
                year: 'numeric'
              });
            } catch {
              return 'Reciente';
            }
          })();

          return (
            <div
              key={publishedPost.id}
              className="bg-[#0b0714] border border-purple-500/35 rounded-2xl p-4 sm:p-5 space-y-4 shadow-2xl"
            >
              {/* Post Header: Admin Avatar + "Administrador" + Edit & Trash Icon Delete Button */}
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-full bg-gradient-to-br from-purple-600 to-fuchsia-600 p-0.5 shadow-md shadow-purple-600/30 shrink-0 overflow-hidden">
                    {publishedPost.authorPhotoUrl && !avatarLoadError ? (
                      <img
                        src={publishedPost.authorPhotoUrl}
                        alt="Administrador"
                        referrerPolicy="no-referrer"
                        onError={() => setAvatarLoadError(true)}
                        className="w-full h-full rounded-full object-cover bg-[#0b0714]"
                      />
                    ) : (
                      <div className="w-full h-full rounded-full bg-[#0b0714] flex items-center justify-center font-display font-black text-sm text-white">
                        AD
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="font-sans font-bold text-base text-white">
                        Administrador
                      </span>
                      <CheckCircle2 className="w-4 h-4 text-sky-400 fill-sky-400/20 shrink-0" />
                      {publishedPosts.length > 1 && (
                        <span className="ml-1 px-2 py-0.5 rounded-full bg-purple-500/15 border border-purple-500/30 text-[10px] font-mono text-purple-300">
                          #{postIdx + 1}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 text-xs font-mono text-neutral-400">
                      <span>@Administrador</span>
                      <span>·</span>
                      <span>{formattedPostDate}</span>
                    </div>
                  </div>
                </div>

                {/* Edit & Trash Icon-Only Delete Post Actions */}
                <div className="relative flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleOpenEditPostForm(publishedPost)}
                    className="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-purple-500/20 border border-white/10 hover:border-purple-500/40 text-neutral-200 hover:text-purple-200 text-xs font-mono flex items-center gap-1.5 transition-all cursor-pointer"
                    title="Editar este post"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Editar</span>
                  </button>

                  {/* Trash Can Icon ONLY (No text "Eliminar" or "Borrar Post") */}
                  <button
                    type="button"
                    onClick={() =>
                      setDeleteConfirmPostId(showDeleteConfirm ? null : publishedPost.id)
                    }
                    className="p-2 rounded-xl bg-rose-950/60 hover:bg-rose-600 border border-rose-500/40 text-rose-200 hover:text-white transition-all cursor-pointer flex items-center justify-center"
                    title="Eliminar post"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>

                  {/* Confirmation Box: "¿Estás seguro?" + "Sí" / "No" */}
                  {showDeleteConfirm && (
                    <div className="absolute right-0 top-full mt-2 z-30 w-44 bg-[#160d26] border border-rose-500/50 rounded-xl p-3 shadow-2xl text-center space-y-2.5">
                      <p className="font-sans font-bold text-xs text-white">¿Estás seguro?</p>
                      <div className="flex items-center justify-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleDeletePost(publishedPost)}
                          className="flex-1 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs cursor-pointer transition-colors"
                        >
                          Sí
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteConfirmPostId(null)}
                          className="flex-1 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-neutral-200 font-bold text-xs cursor-pointer transition-colors"
                        >
                          No
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Post Content */}
              <div className="space-y-2 pt-1">
                {publishedPost.title && (
                  <h3 className="font-sans font-bold text-base sm:text-lg text-white leading-snug">
                    {publishedPost.title}
                  </h3>
                )}
                <p className="font-sans text-sm sm:text-[15px] text-neutral-100 whitespace-pre-line leading-relaxed">
                  {publishedPost.content}
                </p>
              </div>

              {/* Attached Post Images (Single or Multi-Photo Gallery) */}
              {publishedImages.length === 1 && (
                <div
                  onClick={() => setZoomedGallery({ images: publishedImages, index: 0 })}
                  className="relative rounded-2xl overflow-hidden border border-white/15 bg-black/60 max-h-96 flex items-center justify-center cursor-pointer group"
                >
                  <img
                    src={publishedImages[0]}
                    alt={publishedPost.title || 'Imagen del post'}
                    className="w-full max-h-96 object-contain"
                  />
                  <div className="absolute bottom-2.5 right-2.5 p-1.5 rounded-lg bg-black/75 border border-white/20 text-white/80">
                    <Maximize2 className="w-3.5 h-3.5" />
                  </div>
                </div>
              )}

              {publishedImages.length > 1 && (
                <div className="grid grid-cols-2 gap-2 rounded-2xl overflow-hidden">
                  {publishedImages.map((imgSrc, idx) => (
                    <div
                      key={idx}
                      onClick={() => setZoomedGallery({ images: publishedImages, index: idx })}
                      className={`relative overflow-hidden border border-white/15 bg-black/60 cursor-pointer group rounded-xl flex items-center justify-center ${
                        publishedImages.length === 3 && idx === 0
                          ? 'col-span-2 max-h-64'
                          : 'h-44 sm:h-52'
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
                          {idx + 1}/{publishedImages.length}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Compact Reaction Metrics Bar: Full Heart, Broken Heart, View Reactions, and Comments Toggle */}
              <div className="pt-3 pb-2 border-y border-white/10 flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  {/* Compact Full Heart Box (Icon + Number Only) */}
                  <button
                    type="button"
                    onClick={() => {
                      setReactionsFilterByPost((prev) => ({
                        ...prev,
                        [publishedPost.id]: 'like'
                      }));
                      setOpenReactionsByPost((prev) => ({
                        ...prev,
                        [publishedPost.id]: true
                      }));
                    }}
                    className="py-1.5 px-2.5 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-mono text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer hover:bg-emerald-500/25 transition-colors"
                    title="Ver quiénes reaccionaron con corazón completo"
                  >
                    <Heart className="w-4 h-4 shrink-0 fill-emerald-400 text-emerald-400" />
                    <span>{likesCount}</span>
                  </button>

                  {/* Compact Broken Heart Box (Icon + Number Only) */}
                  <button
                    type="button"
                    onClick={() => {
                      setReactionsFilterByPost((prev) => ({
                        ...prev,
                        [publishedPost.id]: 'dislike'
                      }));
                      setOpenReactionsByPost((prev) => ({
                        ...prev,
                        [publishedPost.id]: true
                      }));
                    }}
                    className="py-1.5 px-2.5 rounded-xl bg-rose-500/15 border border-rose-500/40 text-rose-300 font-mono text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer hover:bg-rose-500/25 transition-colors"
                    title="Ver quiénes reaccionaron con corazón roto"
                  >
                    <HeartCrack className="w-4 h-4 shrink-0 text-rose-400" />
                    <span>{dislikesCount}</span>
                  </button>

                  {/* Toggle to view everyone who reacted */}
                  <button
                    type="button"
                    onClick={() => {
                      setReactionsFilterByPost((prev) => ({
                        ...prev,
                        [publishedPost.id]: 'all'
                      }));
                      setOpenReactionsByPost((prev) => ({
                        ...prev,
                        [publishedPost.id]: !prev[publishedPost.id]
                      }));
                    }}
                    className={`py-1.5 px-2.5 rounded-xl font-mono text-[11px] flex items-center gap-1.5 transition-all cursor-pointer border ${
                      showReactionsList
                        ? 'bg-purple-500/25 border-purple-400 text-purple-200'
                        : 'bg-white/[0.04] hover:bg-white/10 border-white/10 text-neutral-300 hover:text-white'
                    }`}
                  >
                    <Users className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                    <span>Ver reacciones ({totalReactionsCount})</span>
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() =>
                    setOpenCommentsByPost((prev) => ({
                      ...prev,
                      [publishedPost.id]: !showPostComments
                    }))
                  }
                  className={`py-1.5 px-3 rounded-xl font-sans text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer border ${
                    showPostComments
                      ? 'bg-purple-600/25 border-purple-400 text-purple-200'
                      : 'bg-white/[0.04] hover:bg-purple-500/15 border-white/10 text-neutral-300'
                  }`}
                >
                  <MessageCircle className="w-4 h-4 text-purple-400 shrink-0" />
                  <span>Comentarios</span>
                  <span className="px-1.5 py-0.5 rounded-full bg-black/40 text-[11px] font-mono font-bold">
                    {totalCommentsCount}
                  </span>
                </button>
              </div>

              {/* Expandable Reactions List with Profile Photo & Custom Name */}
              {showReactionsList && (
                <div className="p-3 rounded-xl bg-[#130b21] border border-purple-500/30 space-y-2.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-[11px] font-mono uppercase tracking-wider text-purple-300 font-bold">
                      Reacciones del Post
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() =>
                          setReactionsFilterByPost((prev) => ({
                            ...prev,
                            [publishedPost.id]: 'all'
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
                            [publishedPost.id]: 'like'
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
                            [publishedPost.id]: 'dislike'
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
                      No hay reacciones en esta categoría.
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
                      {reactionEntries.map(([voterUid, voteType]) => {
                        const info = getDisplayInfoForUser(publishedPost, voterUid);
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
              )}

              {/* Comments Section Inside the Post Card (with Nested Replies & Admin Reply/Edit/Delete) */}
              {showPostComments && (
                <div className="space-y-2.5 pt-1">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] uppercase tracking-wider text-neutral-400 font-semibold">
                      Comentarios en la publicación ({totalCommentsCount})
                    </span>
                  </div>

                  {topLevelComments.length === 0 ? (
                    <div className="py-6 text-center rounded-xl bg-white/[0.02] border border-white/5">
                      <p className="text-xs font-mono text-neutral-500">
                        Todavía no hay comentarios en este post.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2.5 max-h-96 overflow-y-auto pr-1">
                      {topLevelComments.map((c) => {
                        const authorInfo = getDisplayInfoForUser(
                          publishedPost,
                          c.userId,
                          c.userName,
                          c.userPhotoUrl,
                          c.isAdminAuthor
                        );
                        const userVote = publishedPost.votes?.[c.userId];
                        const isOwnAdminComment = Boolean(
                          c.userId === adminUid || c.isAdminAuthor
                        );
                        const isEditingThis =
                          editingTarget?.postId === publishedPost.id &&
                          editingTarget?.commentId === c.id;
                        const isReplyingThis =
                          replyTarget?.postId === publishedPost.id &&
                          replyTarget?.commentId === c.id;
                        const replies = repliesByParentId.get(c.id) || [];

                        return (
                          <div
                            key={c.id}
                            className="p-3 rounded-xl bg-[#130b21] border border-white/10 space-y-2"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="space-y-1 min-w-0 flex-1">
                                <div className="flex items-center flex-wrap gap-2">
                                  {authorInfo.photoUrl ? (
                                    <img
                                      src={authorInfo.photoUrl}
                                      alt={authorInfo.name}
                                      referrerPolicy="no-referrer"
                                      className="w-7 h-7 rounded-full object-cover border border-purple-500/40 shrink-0"
                                    />
                                  ) : (
                                    <div className="w-7 h-7 rounded-full bg-purple-600/30 border border-purple-500/40 flex items-center justify-center text-[10px] font-bold text-purple-200 uppercase shrink-0">
                                      {(authorInfo.name || 'U').charAt(0)}
                                    </div>
                                  )}
                                  <div className="flex items-center gap-1.5 flex-nowrap min-w-0">
                                    <span className="font-sans font-bold text-xs sm:text-sm text-white truncate">
                                      {authorInfo.name}
                                    </span>
                                    {c.isAdminAuthor && (
                                      <span className="px-1.5 py-0.5 rounded bg-purple-500/20 border border-purple-500/40 text-purple-300 text-[9px] font-mono font-bold uppercase shrink-0 whitespace-nowrap">
                                        Admin
                                      </span>
                                    )}
                                  </div>
                                  {userVote === 'like' && (
                                    <span className="p-1 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
                                      <Heart className="w-3 h-3 fill-emerald-400 text-emerald-400" />
                                    </span>
                                  )}
                                  {userVote === 'dislike' && (
                                    <span className="p-1 rounded bg-rose-500/15 border border-rose-500/30 text-rose-300">
                                      <HeartCrack className="w-3 h-3 text-rose-400" />
                                    </span>
                                  )}
                                  <span className="font-mono text-[10px] text-neutral-500">
                                    · {c.createdAt}
                                    {c.edited ? ' (editado)' : ''}
                                  </span>
                                </div>

                                {isEditingThis ? (
                                  <div className="pl-9 space-y-2 pt-1">
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
                                        className="px-2.5 py-1 rounded-lg bg-white/5 text-[11px] font-mono text-neutral-300 cursor-pointer"
                                      >
                                        Cancelar
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          handleAdminEditOwnComment(publishedPost, c.id)
                                        }
                                        disabled={!editingText.trim()}
                                        className="px-3 py-1 rounded-lg bg-purple-600 text-[11px] font-semibold text-white flex items-center gap-1 cursor-pointer"
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

                                <div className="pl-9 flex items-center gap-3 pt-1">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setReplyTarget(
                                        isReplyingThis
                                          ? null
                                          : { postId: publishedPost.id, commentId: c.id }
                                      );
                                      setReplyText('');
                                    }}
                                    className="text-[11px] font-medium text-purple-400 hover:text-purple-300 flex items-center gap-1 cursor-pointer"
                                  >
                                    <CornerDownRight className="w-3 h-3" />
                                    <span>Responder</span>
                                  </button>

                                  {isOwnAdminComment && !isEditingThis && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingTarget({
                                          postId: publishedPost.id,
                                          commentId: c.id
                                        });
                                        setEditingText(c.text);
                                      }}
                                      className="text-[11px] font-medium text-neutral-400 hover:text-sky-300 flex items-center gap-1 cursor-pointer"
                                    >
                                      <Edit3 className="w-3 h-3" />
                                      <span>Editar</span>
                                    </button>
                                  )}
                                </div>
                              </div>

                              <button
                                type="button"
                                onClick={() => handleDeleteComment(publishedPost, c.id)}
                                className="p-1.5 rounded-lg text-neutral-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors cursor-pointer shrink-0"
                                title="Borrar comentario"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>

                            {isReplyingThis && (
                              <div className="ml-6 sm:ml-8 pt-2 border-t border-purple-900/30">
                                <div className="flex items-center gap-2 bg-[#180f28] border border-purple-800/50 rounded-lg p-2">
                                  <input
                                    type="text"
                                    value={replyText}
                                    onChange={(e) => setReplyText(e.target.value)}
                                    placeholder={`Responder a ${authorInfo.name} como Administrador...`}
                                    className="flex-1 bg-transparent text-xs text-white placeholder-neutral-500 focus:outline-none"
                                    autoFocus
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        e.preventDefault();
                                        handleAdminReply(publishedPost, c.id);
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
                                    onClick={() => handleAdminReply(publishedPost, c.id)}
                                    disabled={!replyText.trim()}
                                    className="px-2.5 py-1 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white text-[11px] font-semibold rounded transition-all cursor-pointer"
                                  >
                                    Enviar
                                  </button>
                                </div>
                              </div>
                            )}

                            {replies.length > 0 && (
                              <div className="ml-6 sm:ml-8 pl-3 border-l-2 border-purple-900/40 space-y-2 pt-2">
                                {replies.map((reply) => {
                                  const replyAuthor = getDisplayInfoForUser(
                                    publishedPost,
                                    reply.userId,
                                    reply.userName,
                                    reply.userPhotoUrl,
                                    reply.isAdminAuthor
                                  );
                                  const isReplyOwnAdmin = Boolean(
                                    reply.userId === adminUid || reply.isAdminAuthor
                                  );
                                  const isEditingReply =
                                    editingTarget?.postId === publishedPost.id &&
                                    editingTarget?.commentId === reply.id;
                                  const isReplyingToReply =
                                    replyTarget?.postId === publishedPost.id &&
                                    replyTarget?.commentId === reply.id;
                                  const parentReplyObj =
                                    reply.parentId && reply.parentId !== c.id
                                      ? commentById.get(reply.parentId)
                                      : undefined;
                                  const parentReplyAuthor = parentReplyObj
                                    ? getDisplayInfoForUser(
                                        publishedPost,
                                        parentReplyObj.userId,
                                        parentReplyObj.userName,
                                        parentReplyObj.userPhotoUrl,
                                        parentReplyObj.isAdminAuthor
                                      )
                                    : null;

                                  return (
                                    <div
                                      key={reply.id}
                                      className="p-2.5 rounded-lg bg-[#180f29] border border-purple-900/30 space-y-1.5"
                                    >
                                      <div className="flex items-start justify-between gap-2">
                                        <div className="space-y-1 min-w-0 flex-1">
                                          <div className="flex items-center gap-2 flex-wrap">
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
                                            <span className="text-[9px] font-mono text-neutral-500">
                                              · {reply.createdAt}
                                              {reply.edited ? ' (editado)' : ''}
                                            </span>
                                          </div>

                                          {isEditingReply ? (
                                            <div className="pl-8 space-y-1.5">
                                              <textarea
                                                rows={2}
                                                value={editingText}
                                                onChange={(e) => setEditingText(e.target.value)}
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
                                                    handleAdminEditOwnComment(publishedPost, reply.id)
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
                                                      : {
                                                          postId: publishedPost.id,
                                                          commentId: reply.id
                                                        }
                                                  );
                                                  setReplyText('');
                                                }}
                                                className="text-[10px] font-medium text-purple-400 hover:text-purple-300 flex items-center gap-1 cursor-pointer"
                                              >
                                                <CornerDownRight className="w-2.5 h-2.5" />
                                                <span>Responder</span>
                                              </button>

                                              {isReplyOwnAdmin && (
                                                <button
                                                  type="button"
                                                  onClick={() => {
                                                    setEditingTarget({
                                                      postId: publishedPost.id,
                                                      commentId: reply.id
                                                    });
                                                    setEditingText(reply.text);
                                                  }}
                                                  className="text-[10px] font-medium text-neutral-400 hover:text-sky-300 flex items-center gap-1 cursor-pointer"
                                                >
                                                  <Edit3 className="w-2.5 h-2.5" />
                                                  <span>Editar</span>
                                                </button>
                                              )}
                                            </div>
                                          )}
                                        </div>

                                        <button
                                          type="button"
                                          onClick={() => handleDeleteComment(publishedPost, reply.id)}
                                          className="p-1 rounded text-neutral-500 hover:text-rose-400 cursor-pointer shrink-0"
                                          title="Borrar respuesta"
                                        >
                                          <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                      </div>

                                      {isReplyingToReply && (
                                        <div className="pl-8 pt-1.5">
                                          <div className="flex items-center gap-2 bg-[#180f28] border border-purple-800/50 rounded-lg p-2">
                                            <input
                                              type="text"
                                              value={replyText}
                                              onChange={(e) => setReplyText(e.target.value)}
                                              placeholder={`Responder a ${replyAuthor.name} como Administrador...`}
                                              className="flex-1 bg-transparent text-xs text-white placeholder-neutral-500 focus:outline-none"
                                              autoFocus
                                              onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                  e.preventDefault();
                                                  handleAdminReply(publishedPost, reply.id);
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
                                                handleAdminReply(publishedPost, reply.id)
                                              }
                                              disabled={!replyText.trim()}
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
              )}
            </div>
          );
        })}

      {/* Fullscreen Lightbox Carousel for Published Post Photos */}
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
            alt={`Foto ${zoomedGallery.index + 1}`}
            onClick={(e) => e.stopPropagation()}
            className="max-w-full max-h-[88dvh] object-contain rounded-lg shadow-2xl"
          />
        </div>
      )}
    </div>
  );
}
