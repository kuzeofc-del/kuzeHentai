import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import {
  Sparkles,
  ChevronRight,
  ChevronLeft,
  X,
  MessageSquareWarning,
  Send,
  Bookmark,
  Star,
  Eye,
  Smartphone,
  ArrowLeftRight,
  Check,
  ExternalLink
} from 'lucide-react';
import { User } from 'firebase/auth';
import { db, doc, setDoc, getDoc, serverTimestamp } from '../lib/firebase';
import { useAppTheme } from '../lib/theme';

interface WelcomeOnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: User | null;
  onOpenReportModal?: () => void;
  onOpenProfileModal?: () => void;
}

const TELEGRAM_GROUP_URL = 'https://t.me/kuzehenta';

export default function WelcomeOnboardingModal({
  isOpen,
  onClose,
  currentUser,
  onOpenReportModal,
  onOpenProfileModal
}: WelcomeOnboardingModalProps) {
  const [appTheme] = useAppTheme();
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);

  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);

  const displayName =
    currentUser?.displayName ||
    currentUser?.email?.split('@')[0] ||
    'Usuario';

  const totalSteps = 4;

  const markOnboardingComplete = async () => {
    const uid = currentUser?.uid;
    if (uid) {
      try {
        localStorage.setItem(`kh_onboarding_done_${uid}`, 'true');
        localStorage.removeItem(`kh_show_welcome_${uid}`);
      } catch {}
      if (db) {
        try {
          await setDoc(
            doc(db, 'users', uid),
            {
              onboardingCompleted: true,
              updatedAt: serverTimestamp()
            },
            { merge: true }
          );
        } catch {}
      }
    }
  };

  useEffect(() => {
    if (isOpen) {
      setStep(0);
      setDirection(1);
      document.body.style.overflow = 'hidden';
      markOnboardingComplete();
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen, currentUser?.uid]);

  if (!isOpen) return null;

  const handleFinish = () => {
    markOnboardingComplete();
    onClose();
  };

  const handleNext = () => {
    if (step < totalSteps - 1) {
      setDirection(1);
      setStep((s) => s + 1);
    } else {
      handleFinish();
    }
  };

  const handlePrev = () => {
    if (step > 0) {
      setDirection(-1);
      setStep((s) => s - 1);
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const endX = e.changedTouches[0]?.clientX ?? touchStartX.current;
    const endY = e.changedTouches[0]?.clientY ?? touchStartY.current;
    const deltaX = endX - touchStartX.current;
    const deltaY = endY - touchStartY.current;

    touchStartX.current = null;
    touchStartY.current = null;

    if (Math.abs(deltaX) > 40 && Math.abs(deltaX) > Math.abs(deltaY) * 1.1) {
      if (deltaX < 0 && step < totalSteps - 1) {
        setDirection(1);
        setStep((s) => s + 1);
      } else if (deltaX > 0 && step > 0) {
        setDirection(-1);
        setStep((s) => s - 1);
      }
    }
  };

  const isBlack = appTheme === 'black';

  const modalUI = (
    <div className="fixed inset-0 z-[999999] flex items-center justify-center p-4 sm:p-6 h-screen h-[100dvh] w-screen w-[100dvw] overflow-hidden">
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={handleFinish}
        className="fixed inset-0 bg-black/85 backdrop-blur-xs z-0"
      />

      {/* Modal Card */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 15 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 15 }}
        transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        className={`relative z-10 w-full max-w-md rounded-2xl p-5 sm:p-6 shadow-[0_25px_70px_rgba(0,0,0,0.95)] overflow-hidden select-none ${
          isBlack
            ? 'bg-black border border-neutral-800'
            : 'bg-[#120b1c] border border-purple-800/50'
        }`}
      >
        {/* Top bar: Step counter + Skip button */}
        <div className="flex items-center justify-between pb-3 border-b border-white/10">
          <div className="flex items-center gap-1.5">
            {Array.from({ length: totalSteps }).map((_, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => {
                  setDirection(idx > step ? 1 : -1);
                  setStep(idx);
                }}
                className={`h-1.5 rounded-full transition-all duration-300 cursor-pointer ${
                  idx === step
                    ? 'w-7 bg-purple-500'
                    : idx < step
                    ? 'w-2.5 bg-purple-500/50'
                    : 'w-2 bg-white/15 hover:bg-white/30'
                }`}
                aria-label={`Paso ${idx + 1}`}
              />
            ))}
          </div>

          <button
            type="button"
            onClick={handleFinish}
            className="inline-flex items-center gap-1 text-[11px] font-mono text-neutral-400 hover:text-white transition-colors cursor-pointer px-2 py-1 rounded-lg hover:bg-white/5"
          >
            <span>Omitir</span>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Slide Content Area */}
        <div className="min-h-[310px] sm:min-h-[325px] flex flex-col justify-between pt-4">
          <AnimatePresence mode="wait" custom={direction}>
            <motion.div
              key={step}
              custom={direction}
              initial={(dir: number) => ({ opacity: 0, x: dir >= 0 ? 40 : -40 })}
              animate={{ opacity: 1, x: 0 }}
              exit={(dir: number) => ({ opacity: 0, x: dir >= 0 ? -40 : 40 })}
              transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
              className="space-y-4"
            >
              {/* STEP 0: BIENVENIDA */}
              {step === 0 && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-purple-700 to-purple-500 flex items-center justify-center text-white shadow-lg shadow-purple-900/40 shrink-0">
                      <Sparkles className="h-6 w-6" />
                    </div>
                    <div>
                      <span className="font-mono text-[10px] uppercase tracking-widest text-purple-400 block">
                        Cuenta creada con éxito
                      </span>
                      <h3 className="font-display font-bold text-lg sm:text-xl text-white leading-tight">
                        ¡Bienvenido, {displayName}!
                      </h3>
                    </div>
                  </div>

                  <p className="text-xs sm:text-sm text-neutral-300 leading-relaxed">
                    Gracias por unirte a <strong className="text-white">KuzeHentai</strong>. Te preparamos esta guía rápida para que aproveches al máximo todas las funciones de tu cuenta:
                  </p>

                  <div className="space-y-2.5 pt-1">
                    <div className={`p-3 rounded-xl border flex items-start gap-3 ${isBlack ? 'bg-[#08080a] border-neutral-800' : 'bg-[#180e26] border-purple-900/40'}`}>
                      <Bookmark className="h-4 w-4 text-purple-400 shrink-0 mt-0.5" />
                      <div className="text-xs">
                        <p className="font-semibold text-white">Mi Lista y Animes Vistos</p>
                        <p className="text-neutral-400 text-[11px] mt-0.5">
                          Guarda tus animes favoritos y marca los que ya viste. Todo se sincroniza automáticamente en tu cuenta.
                        </p>
                      </div>
                    </div>

                    <div className={`p-3 rounded-xl border flex items-start gap-3 ${isBlack ? 'bg-[#08080a] border-neutral-800' : 'bg-[#180e26] border-purple-900/40'}`}>
                      <Star className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                      <div className="text-xs">
                        <p className="font-semibold text-white">Calificaciones y Comentarios</p>
                        <p className="text-neutral-400 text-[11px] mt-0.5">
                          Califica cada anime con estrellas (puedes tocar la misma estrella para quitar tu voto) y comenta con la comunidad.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* STEP 1: GESTOS DE DESPLAZAMIENTO */}
              {step === 1 && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-indigo-600 to-purple-500 flex items-center justify-center text-white shadow-lg shadow-indigo-900/40 shrink-0">
                      <Smartphone className="h-6 w-6" />
                    </div>
                    <div>
                      <span className="font-mono text-[10px] uppercase tracking-widest text-purple-400 block">
                        Navegación inteligente
                      </span>
                      <h3 className="font-display font-bold text-lg sm:text-xl text-white leading-tight">
                        Usa Gestos para Navegar
                      </h3>
                    </div>
                  </div>

                  <p className="text-xs sm:text-sm text-neutral-300 leading-relaxed">
                    No necesitas tocar siempre los botones de atrás. Puedes moverte por toda la aplicación deslizando tu dedo en la pantalla:
                  </p>

                  {/* Animated swipe visual */}
                  <div className={`p-3 rounded-xl border flex items-center justify-between gap-3 ${isBlack ? 'bg-[#08080a] border-neutral-800' : 'bg-[#180e26] border-purple-900/50'}`}>
                    <div className="space-y-1">
                      <p className="text-xs font-semibold text-white flex items-center gap-1.5">
                        <ArrowLeftRight className="h-3.5 w-3.5 text-purple-400" />
                        <span>Volver atrás deslizando</span>
                      </p>
                      <p className="text-[11px] text-neutral-400 leading-relaxed">
                        Desliza de <strong className="text-neutral-200">izquierda a derecha</strong> para salir de cualquier <strong className="text-neutral-200">anime</strong>, <strong className="text-neutral-200">estudio</strong>, <strong className="text-neutral-200">género</strong> o cerrar el <strong className="text-neutral-200">reproductor de video</strong> sin tocar el botón de atrás.
                      </p>
                    </div>
                    <div className="shrink-0 px-2.5 py-1.5 rounded-lg bg-purple-500/15 border border-purple-500/30 font-mono text-[10px] text-purple-300 font-bold">
                      👉 Atrás
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <div className={`p-3 rounded-xl border space-y-1 ${isBlack ? 'bg-[#08080a] border-neutral-800' : 'bg-[#180e26] border-purple-900/40'}`}>
                      <p className="text-xs font-semibold text-white">Pasar de Páginas</p>
                      <p className="text-[11px] text-neutral-400 leading-snug">
                        Desliza hacia la <strong className="text-neutral-200">izquierda o derecha</strong> para cambiar de página en estudios, géneros y catálogo.
                      </p>
                    </div>
                    <div className={`p-3 rounded-xl border space-y-1 ${isBlack ? 'bg-[#08080a] border-neutral-800' : 'bg-[#180e26] border-purple-900/40'}`}>
                      <p className="text-xs font-semibold text-white">Mi Lista / Vistos</p>
                      <p className="text-[11px] text-neutral-400 leading-snug">
                        Desliza a la izquierda o derecha para alternar entre tus Guardados y Vistos.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* STEP 2: REPORTAR ERRORES O SUGERENCIAS */}
              {step === 2 && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-amber-600 to-orange-500 flex items-center justify-center text-white shadow-lg shadow-amber-900/30 shrink-0">
                      <MessageSquareWarning className="h-6 w-6" />
                    </div>
                    <div>
                      <span className="font-mono text-[10px] uppercase tracking-widest text-amber-400 block">
                        Soporte directo 24/7
                      </span>
                      <h3 className="font-display font-bold text-lg sm:text-xl text-white leading-tight">
                        Reportes y Sugerencias
                      </h3>
                    </div>
                  </div>

                  <p className="text-xs sm:text-sm text-neutral-300 leading-relaxed">
                    ¿Un episodio no reproduce, hay un enlace caído o quieres pedir que agreguemos un anime?
                  </p>

                  <div className={`p-3.5 rounded-xl border space-y-2.5 ${isBlack ? 'bg-[#08080a] border-neutral-800' : 'bg-[#180e26] border-purple-900/50'}`}>
                    <div className="flex items-center gap-2.5 text-xs text-white font-medium">
                      <span className="w-5 h-5 rounded-full bg-purple-600 text-white font-mono text-[10px] font-bold flex items-center justify-center shrink-0">
                        1
                      </span>
                      <span>Toca tu <strong>foto de perfil</strong> arriba a la derecha.</span>
                    </div>
                    <div className="flex items-center gap-2.5 text-xs text-white font-medium">
                      <span className="w-5 h-5 rounded-full bg-amber-500 text-black font-mono text-[10px] font-bold flex items-center justify-center shrink-0">
                        2
                      </span>
                      <span>Entra en <strong>«Reporte problema o sugerencias»</strong>.</span>
                    </div>
                    <div className="flex items-center gap-2.5 text-xs text-white font-medium">
                      <span className="w-5 h-5 rounded-full bg-emerald-500 text-black font-mono text-[10px] font-bold flex items-center justify-center shrink-0">
                        3
                      </span>
                      <span>Envía tu reporte o sugerencia y te responderemos ahí mismo.</span>
                    </div>
                  </div>

                  {onOpenReportModal && (
                    <button
                      type="button"
                      onClick={() => {
                        markOnboardingComplete();
                        onClose();
                        onOpenReportModal();
                      }}
                      className="w-full py-2.5 px-4 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 text-xs font-medium flex items-center justify-center gap-2 transition-colors cursor-pointer"
                    >
                      <MessageSquareWarning className="h-4 w-4" />
                      <span>Probar chat de reportes y sugerencias ahora</span>
                    </button>
                  )}
                </div>
              )}

              {/* STEP 3: INVITACIÓN AL GRUPO DE TELEGRAM */}
              {step === 3 && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-[#0088cc] to-[#29b6f6] flex items-center justify-center text-white shadow-lg shadow-sky-900/40 shrink-0">
                      <Send className="h-6 w-6" />
                    </div>
                    <div>
                      <span className="font-mono text-[10px] uppercase tracking-widest text-sky-400 block">
                        Comunidad Oficial
                      </span>
                      <h3 className="font-display font-bold text-lg sm:text-xl text-white leading-tight">
                        Únete a nuestro Telegram
                      </h3>
                    </div>
                  </div>

                  <p className="text-xs sm:text-sm text-neutral-300 leading-relaxed">
                    Forma parte de nuestra comunidad en <strong className="text-white">Telegram</strong> para enterarte al instante de nuevos episodios, estrenos, avisos importantes y compartir con otros miembros.
                  </p>

                  <div className={`p-4 rounded-xl border space-y-3 ${isBlack ? 'bg-[#08080a] border-neutral-800' : 'bg-[#180e26] border-sky-500/30'}`}>
                    <a
                      href={TELEGRAM_GROUP_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-[#0088cc] to-[#1da1f2] hover:from-[#0077b5] hover:to-[#0d8bd9] text-white font-display font-semibold text-xs sm:text-sm tracking-wide flex items-center justify-center gap-2 shadow-lg shadow-sky-950/60 transition-all active:scale-98 cursor-pointer"
                    >
                      <Send className="h-4 w-4" />
                      <span>Unirse al Grupo de Telegram</span>
                      <ExternalLink className="h-3.5 w-3.5 opacity-80" />
                    </a>

                    <p className="text-[11px] text-neutral-400 text-center font-mono">
                      ¡También puedes cambiar el tema a Negro o Violeta desde tu perfil!
                    </p>
                  </div>
                </div>
              )}
            </motion.div>
          </AnimatePresence>

          {/* Bottom Navigation Bar */}
          <div className="pt-4 mt-4 border-t border-white/10 flex items-center justify-between gap-3">
            {step > 0 ? (
              <button
                type="button"
                onClick={handlePrev}
                className="px-3.5 py-2 rounded-xl border border-white/15 hover:border-white/30 text-neutral-300 hover:text-white text-xs font-medium flex items-center gap-1 transition-colors cursor-pointer"
              >
                <ChevronLeft className="h-4 w-4" />
                <span>Anterior</span>
              </button>
            ) : (
              <span className="text-[10px] font-mono text-neutral-500">
                Desliza o toca Siguiente →
              </span>
            )}

            <button
              type="button"
              onClick={handleNext}
              className="ml-auto px-5 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-brand-red hover:from-purple-500 hover:to-brand-red/90 text-white font-display font-semibold text-xs tracking-wider uppercase flex items-center gap-1.5 shadow-lg shadow-purple-900/40 transition-all active:scale-95 cursor-pointer"
            >
              {step < totalSteps - 1 ? (
                <>
                  <span>Siguiente</span>
                  <ChevronRight className="h-4 w-4" />
                </>
              ) : (
                <>
                  <Check className="h-4 w-4" />
                  <span>¡Comenzar!</span>
                </>
              )}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modalUI, document.body) : null;
}
