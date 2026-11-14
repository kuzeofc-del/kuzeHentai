import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { X, Send, MessageSquareWarning, RefreshCw, ShieldCheck, Bot, Trash2 } from 'lucide-react';
import { User } from 'firebase/auth';
import { auth, db, doc, getDoc, collection, addDoc, getDocs, deleteDoc, query, where } from '../lib/firebase';

interface ChatMessage {
  id: string;
  sender: 'bot' | 'user' | 'admin';
  text: string;
  timestamp: string;
  timestampMs?: number;
}

interface ReportIssueModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: User | null;
}

const CHAT_CYCLE_24H_MS = 24 * 60 * 60 * 1000; // 24 hours

const DEFAULT_GREETING: ChatMessage = {
  id: 'greeting',
  sender: 'bot',
  text: '¡Hola! 👋 Aquí puedes reportar cualquier problema, video que no reproduzca o enlace caído, y también sugerir nuevos animes o funciones para la página. ¡Cuéntanos qué anime, episodio o idea tienes para que podamos revisarlo y responderte!',
  timestamp: 'Justo ahora',
  timestampMs: Date.now()
};

const TELEGRAM_BOT_TOKEN = '8870602337:AAHM2VP4BPE1EHxgJFzjHyFu6fxyu71Cyd4';
const TELEGRAM_CHAT_ID = '8401789540';

interface QuickAction {
  label: string;
  template: string;
  hint: string;
  isSuggestion?: boolean;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    label: '⚠️ Video no reproduce',
    template: '⚠️ Video no reproduce / Enlace caído\n• Anime: \n• Episodio: \n• Detalle: ',
    hint: 'Completa el nombre del anime y número de episodio antes de enviar'
  },
  {
    label: '💡 Sugerir un anime',
    template: '💡 Sugerencia de nuevo anime\n• Nombre del anime: \n• Temporada / Detalles: ',
    hint: 'Escribe el nombre del anime que te gustaría que agreguemos',
    isSuggestion: true
  },
  {
    label: '✨ Sugerir función',
    template: '✨ Sugerencia de nueva función\n• Función o mejora: \n• ¿Cómo te gustaría que funcione?: ',
    hint: 'Cuéntanos qué función o mejora te gustaría tener en la web',
    isSuggestion: true
  },
  {
    label: '🔊 Audio / Subtítulos',
    template: '🔊 Problema de audio o subtítulo\n• Anime: \n• Episodio: \n• Detalle del error: ',
    hint: 'Indica el anime, episodio y si falla el audio o subtítulo'
  },
  {
    label: '🐞 Error en la página',
    template: '🐞 Error o fallo en la web\n• Qué sucede: ',
    hint: 'Describe qué parte de la página presentó el error'
  }
];

export default function ReportIssueModal({
  isOpen,
  onClose,
  currentUser
}: ReportIssueModalProps) {
  // Compute effective userId for strict per-user isolation and reply correlation
  const effectiveUserId = currentUser?.uid || (() => {
    try {
      let localAnonId = localStorage.getItem('kh_report_anon_id');
      if (!localAnonId) {
        localAnonId = 'anon-' + Math.random().toString(36).substring(2, 9);
        localStorage.setItem('kh_report_anon_id', localAnonId);
      }
      return localAnonId;
    } catch {
      return 'anon-guest';
    }
  })();

  const chatMessagesKey = `kh_report_chat_messages_${effectiveUserId}`;
  const chatStartedKey = `kh_report_chat_started_at_${effectiveUserId}`;
  const sentMsgIdsKey = `kh_report_sent_msg_ids_${effectiveUserId}`;

  const [resolvedUserName, setResolvedUserName] = useState<string>(() => {
    return (
      auth?.currentUser?.displayName?.trim() ||
      currentUser?.displayName?.trim() ||
      currentUser?.email?.split('@')[0] ||
      'Usuario Anónimo'
    );
  });

  // Always resolve the exact username from Firebase Auth and Firestore 'users' collection
  const resolveAccurateUserName = useCallback(async (): Promise<string> => {
    const authName = auth?.currentUser?.displayName?.trim() || currentUser?.displayName?.trim();
    if (currentUser?.uid && db) {
      try {
        const userSnap = await getDoc(doc(db, 'users', currentUser.uid));
        if (userSnap.exists()) {
          const data = userSnap.data();
          const firestoreName = (data?.displayName || data?.username || data?.name || '').trim();
          if (firestoreName) {
            setResolvedUserName(firestoreName);
            return firestoreName;
          }
        }
      } catch {}
    }
    const fallback = authName || currentUser?.email?.split('@')[0] || 'Usuario Anónimo';
    setResolvedUserName(fallback);
    return fallback;
  }, [currentUser]);

  useEffect(() => {
    if (isOpen) {
      resolveAccurateUserName();
    }
  }, [isOpen, currentUser, resolveAccurateUserName]);

  const loadMessagesForUser = useCallback((uidKey: string, startedKey: string): ChatMessage[] => {
    try {
      // Remove legacy shared key so messages never leak between accounts on the same device
      localStorage.removeItem('kh_report_chat_messages');
      localStorage.removeItem('kh_report_chat_started_at');

      const now = Date.now();
      const globalClearedAt = Number(localStorage.getItem('kh_support_cleared_at') || '0');
      const lastStarted = Number(localStorage.getItem(startedKey) || '0');

      if (
        (lastStarted && now - lastStarted > CHAT_CYCLE_24H_MS) ||
        (globalClearedAt > 0 && lastStarted > 0 && lastStarted <= globalClearedAt)
      ) {
        localStorage.removeItem(uidKey);
        localStorage.setItem(startedKey, String(now));
        return [DEFAULT_GREETING];
      }

      const saved = localStorage.getItem(uidKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const valid = parsed.filter((m: any) => {
            if (m.id === 'greeting') return true;
            const msgTs = Number(m.timestampMs || 0);
            if (globalClearedAt > 0 && (!msgTs || msgTs <= globalClearedAt)) return false;
            return !msgTs || (now - msgTs < CHAT_CYCLE_24H_MS);
          });
          if (valid.length > 0) return valid;
        }
      }
    } catch {}
    return [DEFAULT_GREETING];
  }, []);

  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    loadMessagesForUser(chatMessagesKey, chatStartedKey)
  );

  const [inputText, setInputText] = useState('');
  const [activeHint, setActiveHint] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isCheckingReplies, setIsCheckingReplies] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reload isolated chat history whenever the active user account changes
  useEffect(() => {
    setMessages(loadMessagesForUser(chatMessagesKey, chatStartedKey));
  }, [chatMessagesKey, chatStartedKey, loadMessagesForUser]);

  // Listen for global support chat reset triggered from Admin Panel -> Espacio
  useEffect(() => {
    const handleGlobalSupportCleared = () => {
      setMessages([DEFAULT_GREETING]);
      try {
        localStorage.removeItem(chatMessagesKey);
        localStorage.removeItem(sentMsgIdsKey);
        localStorage.setItem(chatStartedKey, String(Date.now()));
      } catch {}
    };
    window.addEventListener('kh_support_chat_cleared', handleGlobalSupportCleared);
    return () => window.removeEventListener('kh_support_chat_cleared', handleGlobalSupportCleared);
  }, [chatMessagesKey, chatStartedKey, sentMsgIdsKey]);

  // 24-hour chat expiration check, global reset check, and Firestore cleanup
  useEffect(() => {
    if (!isOpen) return;
    const now = Date.now();
    const lastStarted = localStorage.getItem(chatStartedKey);
    if (lastStarted && now - Number(lastStarted) > CHAT_CYCLE_24H_MS) {
      setMessages([DEFAULT_GREETING]);
      localStorage.removeItem(chatMessagesKey);
      localStorage.setItem(chatStartedKey, String(now));
    } else if (!lastStarted) {
      localStorage.setItem(chatStartedKey, String(now));
    }

    // Clean up older reports in Firestore database (older than 24h)
    const purgeOldDbReports = async () => {
      if (!db) return;
      try {
        const cutoff = now - CHAT_CYCLE_24H_MS;
        const q = query(collection(db, 'support_reports'), where('timestampMs', '<', cutoff));
        const snap = await getDocs(q);
        snap.forEach((d) => {
          deleteDoc(d.ref).catch(() => {});
        });
      } catch (e) {}
    };
    purgeOldDbReports();
  }, [isOpen, chatMessagesKey, chatStartedKey]);

  // Auto scroll to bottom when new messages arrive
  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isOpen, messages]);

  // Save messages in per-user localStorage key
  useEffect(() => {
    try {
      localStorage.setItem(chatMessagesKey, JSON.stringify(messages));
    } catch {}
  }, [messages, chatMessagesKey]);

  // Check for admin replies from Telegram strictly for the current user account
  const fetchReplies = useCallback(async (manual = false) => {
    if (manual) setIsCheckingReplies(true);
    try {
      const userEmail = (currentUser?.email || '').trim().toLowerCase();
      const currentNameLower = (
        resolvedUserName ||
        auth?.currentUser?.displayName ||
        currentUser?.displayName ||
        ''
      ).trim().toLowerCase();

      let mySentTelegramIds: number[] = [];
      try {
        const rawIds = localStorage.getItem(sentMsgIdsKey);
        if (rawIds) {
          const parsedIds = JSON.parse(rawIds);
          if (Array.isArray(parsedIds)) {
            mySentTelegramIds = parsedIds.map(Number).filter(Boolean);
          }
        }
      } catch {}

      // Check if admin cleared all support messages in Firestore
      let globalClearedAt = Number(localStorage.getItem('kh_support_cleared_at') || '0');
      try {
        if (db) {
          const resetSnap = await getDoc(doc(db, 'support_config', 'reset_state'));
          if (resetSnap.exists()) {
            const remoteClearedAt = Number(resetSnap.data()?.clearedAtMs || 0);
            if (remoteClearedAt > globalClearedAt) {
              globalClearedAt = remoteClearedAt;
              localStorage.setItem('kh_support_cleared_at', String(remoteClearedAt));
              const lastStarted = Number(localStorage.getItem(chatStartedKey) || '0');
              if (lastStarted <= remoteClearedAt) {
                localStorage.removeItem(chatMessagesKey);
                localStorage.removeItem(sentMsgIdsKey);
                localStorage.setItem(chatStartedKey, String(Date.now()));
                setMessages([DEFAULT_GREETING]);
              }
            }
          }
        }
      } catch {}

      // 1. Direct Telegram Bot API getUpdates query (strictly filtered by exact user)
      try {
        const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?limit=100`);
        if (tgRes.ok) {
          const tgData = await tgRes.json();
          if (tgData?.ok && Array.isArray(tgData.result)) {
            const matchedReplies: ChatMessage[] = [];

            for (const update of tgData.result) {
              const msg = update?.message;
              if (!msg || !msg.text) continue;
              if (msg.from && msg.from.is_bot) continue;

              const msgTimestampMs = (msg.date || Math.floor(Date.now() / 1000)) * 1000;
              if (globalClearedAt > 0 && msgTimestampMs <= globalClearedAt) {
                continue;
              }

              // ONLY deliver replies that quote a report belonging to THIS specific user
              const replyTo = msg.reply_to_message;
              if (!replyTo) continue;

              let isForMe = false;

              // Check 1: Exact Telegram message_id sent from this user account
              if (replyTo.message_id && mySentTelegramIds.includes(Number(replyTo.message_id))) {
                isForMe = true;
              } else if (replyTo.text) {
                const quotedText = replyTo.text;
                const idMatch = quotedText.match(/(?:ID Usuario|userId):\s*[`*]?([^\s\n\r`*]+)/i);
                const emailMatch = quotedText.match(/(?:Correo|email):\s*[`*]?([^\s\n\r`*]+)/i);
                const userMatch = quotedText.match(/(?:Usuario|userName):\s*[`*]?([^\n\r`*]+)/i);

                const quotedUserId = idMatch?.[1]?.trim() || '';
                const quotedEmail = emailMatch?.[1]?.trim().toLowerCase() || '';
                const quotedUserName = userMatch?.[1]?.trim().toLowerCase() || '';

                if (quotedUserId) {
                  if (quotedUserId === effectiveUserId) {
                    isForMe = true;
                  }
                } else if (quotedEmail) {
                  if (userEmail && quotedEmail === userEmail) {
                    isForMe = true;
                  }
                } else if (
                  quotedUserName &&
                  currentNameLower &&
                  currentNameLower !== 'usuario anónimo' &&
                  quotedUserName === currentNameLower
                ) {
                  isForMe = true;
                }
              }

              if (isForMe) {
                const replyId = 'tg-reply-' + (msg.message_id || update.update_id);
                matchedReplies.push({
                  id: replyId,
                  sender: 'admin',
                  text: msg.text,
                  timestamp: new Date(msgTimestampMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                  timestampMs: msgTimestampMs
                });
              }
            }

            if (matchedReplies.length > 0) {
              setMessages(prev => {
                const existingIds = new Set(prev.map(m => m.id));
                const newOnes = matchedReplies.filter(r => !existingIds.has(r.id));
                if (newOnes.length === 0) return prev;
                return [...prev, ...newOnes];
              });
            }
          }
        }
      } catch (tgErr) {
        console.warn('Telegram direct fetch error:', tgErr);
      }

      // 2. Fallback check on local Node endpoint if running with local server
      try {
        const params = new URLSearchParams({
          userId: effectiveUserId,
          email: userEmail
        });
        const res = await fetch(`/api/reports/replies?${params.toString()}`);
        if (res.ok) {
          const contentType = res.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            const data = await res.json();
            if (data?.replies && Array.isArray(data.replies) && data.replies.length > 0) {
              setMessages(prev => {
                const existingIds = new Set(prev.map(m => m.id));
                const newReplies = data.replies.filter((r: any) => {
                  if (existingIds.has(r.id)) return false;
                  if (globalClearedAt > 0 && r.createdAt && Number(r.createdAt) <= globalClearedAt) return false;
                  return true;
                });
                if (newReplies.length === 0) return prev;
                return [
                  ...prev,
                  ...newReplies.map((r: any) => ({
                    id: r.id,
                    sender: 'admin' as const,
                    text: r.text,
                    timestamp: r.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    timestampMs: r.createdAt || Date.now()
                  }))
                ];
              });
            }
          }
        }
      } catch {}
    } catch {
      // Ignore polling errors
    } finally {
      if (manual) {
        setTimeout(() => setIsCheckingReplies(false), 500);
      }
    }
  }, [effectiveUserId, currentUser, resolvedUserName, chatMessagesKey, chatStartedKey, sentMsgIdsKey]);

  useEffect(() => {
    if (!isOpen) return;

    fetchReplies(false);
    const interval = setInterval(() => fetchReplies(false), 3000);
    return () => clearInterval(interval);
  }, [isOpen, fetchReplies]);

  if (!isOpen) return null;

  // Clicking a quick action fills the template in the input WITHOUT sending,
  // prompting the user to specify anime and episode.
  const handleSelectQuickAction = (action: QuickAction) => {
    setInputText(action.template);
    setActiveHint(action.hint);
    if (textareaRef.current) {
      textareaRef.current.focus();
      // Position cursor at a convenient spot (after "• Anime: ")
      setTimeout(() => {
        if (textareaRef.current) {
          const animeIdx = action.template.indexOf('• Anime: ');
          if (animeIdx !== -1) {
            const pos = animeIdx + '• Anime: '.length;
            textareaRef.current.setSelectionRange(pos, pos);
          } else {
            const len = textareaRef.current.value.length;
            textareaRef.current.setSelectionRange(len, len);
          }
        }
      }, 50);
    }
  };

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || isSending) return;

    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const userMsgId = 'user-' + Date.now();
    const timeNow = Date.now();
    const newUserMsg: ChatMessage = {
      id: userMsgId,
      sender: 'user',
      text,
      timestamp: timeStr,
      timestampMs: timeNow
    };

    const isSuggestion = /sugerencia|sugerir|nueva funci|nuevo anime|idea/i.test(text);

    setMessages(prev => [...prev, newUserMsg]);
    setInputText('');
    setActiveHint(null);
    setIsSending(true);

    try {
      const now = new Date();
      const dateFormatted = now.toLocaleString('es-ES', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      const userDisplay = await resolveAccurateUserName();
      const userEmail = (currentUser?.email || auth?.currentUser?.email || '').trim();

      // 1. Guardar mensaje directamente en Firestore (Base de datos)
      if (db) {
        try {
          await addDoc(collection(db, 'support_reports'), {
            userId: effectiveUserId,
            userName: userDisplay,
            userEmail,
            message: text,
            isSuggestion,
            timestampMs: timeNow,
            createdAt: now.toISOString(),
            deviceInfo: typeof navigator !== 'undefined' ? navigator.userAgent : ''
          });
        } catch (dbErr) {
          console.warn('Firestore report save notice:', dbErr);
        }
      }

      const userHeader = userEmail
        ? `👤 Usuario: ${userDisplay}\n📧 Correo: ${userEmail}`
        : `👤 Usuario: ${userDisplay}`;

      const telegramText =
        `${userHeader}\n\n\n` +
        `💬 Mensaje:\n${text}\n\n\n` +
        `📅 Fecha: ${dateFormatted}`;

      // 2. Envío DIRECTO a Telegram
      let sentTelegramMsgId: number | undefined;
      const directPromise = fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: telegramText
        })
      })
        .then(async (res) => {
          if (res.ok) {
            const tgData = await res.json();
            const msgId = Number(tgData?.result?.message_id || 0);
            if (msgId) {
              sentTelegramMsgId = msgId;
              try {
                const existingRaw = localStorage.getItem(sentMsgIdsKey);
                const existingArr = existingRaw ? JSON.parse(existingRaw) : [];
                const nextArr = Array.isArray(existingArr) ? [...existingArr, msgId].slice(-50) : [msgId];
                localStorage.setItem(sentMsgIdsKey, JSON.stringify(nextArr));
              } catch {}
            }
          }
        })
        .catch(err => {
          console.warn('Direct Telegram fetch warning:', err);
        });

      await Promise.race([directPromise, new Promise(res => setTimeout(res, 2500))]);

      // 3. Respaldo a endpoint local /api/reports si corre con Node
      fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: effectiveUserId,
          userName: userDisplay,
          userEmail,
          message: text,
          telegramMessageId: sentTelegramMsgId,
          sentViaClient: Boolean(sentTelegramMsgId)
        })
      }).catch(() => null);
    } catch (err) {
      console.warn('Report dispatch error:', err);
    } finally {
      setIsSending(false);
    }

    // Automated friendly bot response
    setTimeout(() => {
      const botMsgId = 'bot-' + Date.now();
      const botResponse: ChatMessage = {
        id: botMsgId,
        sender: 'bot',
        text: isSuggestion
          ? '¡Muchas gracias por tu sugerencia! 💡 Se ha guardado en la base de datos y la hemos recibido. Te responderemos aquí mismo cuando la revisemos o agreguemos.'
          : '¡Reporte recibido y guardado en la base de datos! ✅ Muchas gracias por tu aviso. El administrador lo está revisando y te responderá aquí mismo cuando quede solucionado.',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        timestampMs: Date.now()
      };
      setMessages(prev => [...prev, botResponse]);
    }, 700);
  };

  const handleClearChat = () => {
    setMessages([DEFAULT_GREETING]);
    setActiveHint(null);
    try {
      localStorage.removeItem(chatMessagesKey);
      localStorage.setItem(chatStartedKey, String(Date.now()));
    } catch {}
  };

  const modalUI = (
    <AnimatePresence>
      <div className="fixed inset-0 z-[1000000] flex items-center justify-center p-3 sm:p-4 h-screen h-[100dvh] w-screen w-[100dvw] overflow-hidden">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={onClose}
          className="fixed inset-0 bg-black/85 z-0"
        />

        {/* Chat Window Card */}
        <motion.div
          initial={{ opacity: 0, x: 50 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 50 }}
          transition={{ duration: 0.22, ease: [0.25, 1, 0.5, 1] }}
          style={{ willChange: 'transform, opacity' }}
          className="relative z-10 w-full max-w-[450px] h-[570px] max-h-[90vh] max-h-[90dvh] bg-[#110822] border border-purple-900/60 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="px-4 py-3 bg-[#160b2d] border-b border-purple-900/40 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="relative">
                <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-purple-700 via-amber-500 to-[#ff5588] flex items-center justify-center shadow-md">
                  <MessageSquareWarning className="h-4 w-4 text-white" />
                </div>
                <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-emerald-500 border-2 border-[#160b2d] rounded-full animate-pulse" />
              </div>
              <div>
                <h3 className="font-display font-bold text-xs sm:text-sm text-white tracking-wide flex items-center gap-1.5">
                  <span>Reporte de problemas o sugerencias</span>
                </h3>
                <p className="text-[10px] text-purple-300/80 font-mono flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  Soporte y Sugerencias • En línea
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => fetchReplies(true)}
                disabled={isCheckingReplies}
                className="p-1.5 text-neutral-400 hover:text-emerald-300 rounded-lg hover:bg-white/5 transition-colors cursor-pointer"
                title="Comprobar respuestas del administrador"
              >
                <RefreshCw className={`h-3.5 w-3.5 transition-transform ${isCheckingReplies ? 'animate-spin text-emerald-400' : ''}`} />
              </button>
              <button
                type="button"
                onClick={handleClearChat}
                className="p-1.5 text-neutral-400 hover:text-rose-400 rounded-lg hover:bg-white/5 transition-colors cursor-pointer"
                title="Limpiar mensajes"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={onClose}
                className="p-1.5 text-neutral-400 hover:text-white rounded-lg hover:bg-white/10 transition-colors cursor-pointer"
                title="Cerrar chat"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Messages Body */}
          <div className="flex-1 overflow-y-auto p-3.5 space-y-3 scrollbar-thin scrollbar-thumb-purple-900/40 bg-[#0e061c]/90">
            {messages.map(msg => {
              const isUser = msg.sender === 'user';
              const isAdmin = msg.sender === 'admin';

              return (
                <div
                  key={msg.id}
                  className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                >
                  {isAdmin && (
                    <div className="flex items-center gap-1 text-[10px] font-semibold text-emerald-400 mb-1 px-1">
                      <ShieldCheck className="w-3 h-3 text-emerald-400" />
                      <span>Respuesta del Administrador:</span>
                    </div>
                  )}
                  {msg.sender === 'bot' && msg.id !== 'greeting' && (
                    <div className="flex items-center gap-1 text-[10px] text-purple-400/80 mb-0.5 px-1">
                      <Bot className="w-3 h-3" />
                      <span>Asistente Automático</span>
                    </div>
                  )}

                  <div
                    className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 text-xs sm:text-[13px] leading-relaxed shadow-md ${
                      isUser
                        ? 'bg-gradient-to-r from-purple-700 to-[#e11d48] text-white rounded-br-xs font-sans'
                        : isAdmin
                        ? 'bg-gradient-to-r from-emerald-950/90 to-[#0e2a22] border border-emerald-600/50 text-emerald-100 rounded-bl-xs font-sans shadow-emerald-950/40'
                        : 'bg-[#1b1031] border border-purple-900/50 text-neutral-200 rounded-bl-xs font-sans'
                    }`}
                  >
                    <p className="whitespace-pre-wrap break-words">{msg.text}</p>
                  </div>
                  <span className="text-[9px] font-mono text-neutral-500 mt-1 px-1">
                    {msg.timestamp}
                  </span>
                </div>
              );
            })}

            {isSending && (
              <div className="flex items-center gap-2 text-neutral-400 text-xs font-mono">
                <div className="w-2 h-2 rounded-full bg-purple-500 animate-bounce" />
                <div className="w-2 h-2 rounded-full bg-purple-500 animate-bounce [animation-delay:0.2s]" />
                <div className="w-2 h-2 rounded-full bg-purple-500 animate-bounce [animation-delay:0.4s]" />
                <span className="text-[10px] text-purple-300">Enviando mensaje...</span>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Quick Suggestions Chips (Click to fill template, does not send immediately) */}
          <div className="px-3 py-2 bg-[#140a28] border-t border-purple-950 flex flex-col gap-1.5 shrink-0">
            <div className="flex items-center justify-between text-[10px] font-mono text-purple-300/70">
              <span>Plantillas rápidas (toca para rellenar datos):</span>
            </div>
            <div className="flex gap-1.5 overflow-x-auto scrollbar-none pb-0.5">
              {QUICK_ACTIONS.map((action, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => handleSelectQuickAction(action)}
                  className={`px-2.5 py-1 text-[10px] font-sans rounded-full shrink-0 transition-all cursor-pointer select-none border flex items-center gap-1 active:scale-95 ${
                    action.isSuggestion
                      ? 'text-amber-200 bg-amber-950/40 border-amber-700/50 hover:bg-amber-800/40'
                      : 'text-purple-200 bg-[#1e1039] border-purple-800/40 hover:bg-purple-800/50'
                  }`}
                  title="Toca para rellenar la plantilla"
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>

          {/* Active Hint Banner */}
          {activeHint && (
            <div className="px-3 py-1.5 bg-amber-500/10 border-t border-amber-500/20 flex items-center justify-between shrink-0">
              <p className="text-[11px] text-amber-300 font-sans flex items-center gap-1.5">
                <span className="text-xs">✏️</span>
                <span>{activeHint}</span>
              </p>
              <button
                type="button"
                onClick={() => setActiveHint(null)}
                className="text-amber-400/70 hover:text-amber-300 text-[10px] ml-2"
              >
                ✕
              </button>
            </div>
          )}

          {/* Input Box */}
          <form
            onSubmit={e => {
              e.preventDefault();
              handleSend();
            }}
            className="p-3 bg-[#160b2d] border-t border-purple-900/40 flex items-end gap-2 shrink-0"
          >
            <div className="flex-1 relative">
              <textarea
                ref={textareaRef}
                value={inputText}
                onChange={e => setInputText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                rows={2}
                placeholder="Escribe el problema o sugerencia (Shift+Enter para salto de línea)..."
                className="w-full bg-[#0c0517] text-white text-xs placeholder:text-neutral-500 rounded-xl px-3.5 py-2.5 pr-3 border border-purple-900/60 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all resize-none font-sans"
              />
            </div>
            <button
              type="submit"
              disabled={!inputText.trim() || isSending}
              className="p-2.5 mb-1 bg-gradient-to-r from-purple-600 via-pink-600 to-[#e11d48] text-white rounded-xl hover:opacity-90 active:scale-95 transition-all disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer shadow-lg shadow-purple-950/50 shrink-0"
              title="Enviar mensaje"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </motion.div>
      </div>
    </AnimatePresence>
  );

  return createPortal(modalUI, document.body);
}
