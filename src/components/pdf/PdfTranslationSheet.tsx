import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertCircle,
  ArrowLeftRight,
  Check,
  Copy,
  ExternalLink,
  Languages,
  RotateCw,
  Search,
  Sparkles,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  detectLanguage,
  isArabicText,
  openExternalTranslate,
  speakText,
  translateText,
} from '../../services/translateService';
import { copyText } from '../../lib/textActions';

export interface PdfTranslationSheetProps {
  sourceText?: string;
  isRtl: boolean;
  hasAccess?: boolean;
  onOpenSubscription?: () => void;
  onClose: () => void;
}

/**
 * Non-intrusive in-reader floating translation bottom sheet.
 *
 * Replaces the disruptive external Google Translate browser tab. Sits as a
 * sibling of the PDF reader viewport to prevent scroll/pinch transform corruption.
 */
export default function PdfTranslationSheet({
  sourceText = '',
  isRtl,
  hasAccess = true,
  onOpenSubscription,
  onClose,
}: PdfTranslationSheetProps) {
  const [inputText, setInputText] = useState(sourceText || '');
  const initialSourceIsArabic = isArabicText(inputText);
  const [targetLang, setTargetLang] = useState<'ar' | 'en'>(
    initialSourceIsArabic ? 'en' : 'ar',
  );

  const [isLoading, setIsLoading] = useState(hasAccess);
  const [error, setError] = useState<string | null>(null);
  const [translatedText, setTranslatedText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [speakingOriginal, setSpeakingOriginal] = useState(false);
  const [showFullSource, setShowFullSource] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const cancelSpeechRef = useRef<(() => void) | null>(null);

  const fetchTranslation = useCallback(
    async (target: 'ar' | 'en', overrideText?: string) => {
      const text = (overrideText !== undefined ? overrideText : inputText).trim();
      if (!text) {
        setTranslatedText(null);
        setIsLoading(false);
        return;
      }

      if (abortRef.current) {
        abortRef.current.abort();
      }

      const ac = new AbortController();
      abortRef.current = ac;

      setIsLoading(true);
      setError(null);

      try {
        const result = await translateText(text, target, ac.signal);
        setTranslatedText(result);
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        setError(
          err?.message && /[\u0600-\u06FF]/.test(err.message)
            ? err.message
            : (isRtl ? 'تعذّر إكمال الترجمة. يرجى المحاولة مرة أخرى.' : 'Could not complete translation. Please try again.'),
        );
      } finally {
        setIsLoading(false);
        abortRef.current = null;
      }
    },
    [inputText, isRtl],
  );

  // Sync prop changes
  useEffect(() => {
    if (sourceText) {
      setInputText(sourceText);
    }
  }, [sourceText]);

  // Trigger translation on mount or targetLang change (if user has access)
  useEffect(() => {
    if (!hasAccess || !inputText.trim()) {
      setIsLoading(false);
      return;
    }
    fetchTranslation(targetLang, inputText);

    return () => {
      if (abortRef.current) abortRef.current.abort();
      if (cancelSpeechRef.current) {
        cancelSpeechRef.current();
        cancelSpeechRef.current = null;
      }
    };
  }, [targetLang, hasAccess]);

  // Clean speech synthesis on unmount
  useEffect(() => {
    return () => {
      if (cancelSpeechRef.current) {
        cancelSpeechRef.current();
        cancelSpeechRef.current = null;
      }
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        try {
          window.speechSynthesis.cancel();
        } catch {}
      }
    };
  }, []);

  const handleToggleLang = () => {
    if (cancelSpeechRef.current) {
      cancelSpeechRef.current();
      cancelSpeechRef.current = null;
    }
    setSpeaking(false);
    setSpeakingOriginal(false);
    setTargetLang((curr) => (curr === 'ar' ? 'en' : 'ar'));
  };

  const handleCopy = async () => {
    if (!translatedText) return;
    const res = await copyText(translatedText);
    if (res === 'ok') {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  const handleSpeakTranslation = () => {
    if (speaking) {
      if (cancelSpeechRef.current) {
        cancelSpeechRef.current();
        cancelSpeechRef.current = null;
      }
      setSpeaking(false);
      return;
    }

    if (cancelSpeechRef.current) {
      cancelSpeechRef.current();
      cancelSpeechRef.current = null;
    }
    setSpeakingOriginal(false);

    if (translatedText) {
      cancelSpeechRef.current = speakText(translatedText, targetLang, (isSpeaking) => {
        setSpeaking(isSpeaking);
        if (!isSpeaking) {
          cancelSpeechRef.current = null;
        }
      });
    }
  };

  const handleSpeakOriginal = () => {
    const text = inputText.trim();
    if (!text) return;
    if (speakingOriginal) {
      if (cancelSpeechRef.current) {
        cancelSpeechRef.current();
        cancelSpeechRef.current = null;
      }
      setSpeakingOriginal(false);
      return;
    }

    if (cancelSpeechRef.current) {
      cancelSpeechRef.current();
      cancelSpeechRef.current = null;
    }
    setSpeaking(false);

    const sourceLang = detectLanguage(text);
    cancelSpeechRef.current = speakText(text, sourceLang, (isSpeaking) => {
      setSpeakingOriginal(isSpeaking);
      if (!isSpeaking) {
        cancelSpeechRef.current = null;
      }
    });
  };

  const isLongSource = inputText.length > 140;
  const displayedSource = isLongSource && !showFullSource
    ? `${inputText.slice(0, 140)}...`
    : inputText;

  const handleClose = () => {
    if (cancelSpeechRef.current) {
      cancelSpeechRef.current();
      cancelSpeechRef.current = null;
    }
    setSpeaking(false);
    setSpeakingOriginal(false);
    onClose();
  };

  return (
    <>
      {/* Backdrop — intercepts touch events to prevent PDF canvas scroll-bleed */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={handleClose}
        onTouchMove={(e) => e.preventDefault()}
        className="fixed inset-0 z-[170] bg-black/50 backdrop-blur-sm"
      />

      {/* Bottom sheet container */}
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 32, stiffness: 320 }}
        dir={isRtl ? 'rtl' : 'ltr'}
        onTouchStart={(e) => e.stopPropagation()}
        className="fixed inset-x-0 bottom-0 z-[171] rounded-t-3xl bg-white dark:bg-zinc-900 border-t border-slate-200 dark:border-zinc-800 shadow-[0_-8px_32px_rgba(0,0,0,0.28)] pb-[max(env(safe-area-inset-bottom),0.75rem)] flex flex-col max-h-[85vh]"
      >
        {/*
          Drag lives strictly on the handle pill to prevent competing with
          vertical text scrolling in the translation body.
        */}
        <motion.div
          drag="y"
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={0.35}
          dragMomentum={false}
          onDragEnd={(_, info) => {
            if (info.offset.y > 50) handleClose();
          }}
          className="shrink-0 pt-2.5 pb-1 flex items-center justify-center cursor-grab active:cursor-grabbing touch-none"
          aria-label={isRtl ? 'إغلاق اللوحة' : 'Close sheet'}
        >
          <div className="w-10 h-1.5 rounded-full bg-slate-300 dark:bg-zinc-600" />
        </motion.div>

        {/* Header */}
        <div className="shrink-0 px-4 pb-3 pt-1 border-b border-slate-100 dark:border-zinc-800 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
              hasAccess
                ? 'bg-sky-50 dark:bg-sky-950/40 text-sky-500'
                : 'bg-violet-50 dark:bg-violet-950/40 text-violet-500'
            }`}>
              {hasAccess ? <Languages className="w-4.5 h-4.5" /> : <Sparkles className="w-4.5 h-4.5 text-amber-500" />}
            </div>
            <div className="flex items-center gap-1.5 min-w-0">
              <h3 className="font-black text-slate-900 dark:text-zinc-100 text-sm truncate">
                {isRtl ? 'الترجمة المباشرة' : 'Translation'}
              </h3>
              {!hasAccess && (
                <span className="px-1.5 py-0.5 rounded-md bg-gradient-to-r from-violet-500 to-indigo-500 text-white text-[10px] font-black shrink-0">
                  {isRtl ? 'بلس' : 'Plus'}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {/* Language direction toggle */}
            <button
              onClick={handleToggleLang}
              title={isRtl ? 'تبديل اتجاه اللغة' : 'Swap language direction'}
              className="h-8 px-2.5 rounded-full bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-xs font-black text-slate-700 dark:text-zinc-200 flex items-center gap-1.5 transition active:scale-95"
            >
              <span>{targetLang === 'ar' ? 'EN ➔ AR' : 'AR ➔ EN'}</span>
              <ArrowLeftRight className="w-3.5 h-3.5 text-slate-400" />
            </button>

            {hasAccess && (
              <>
                {/* TTS Action */}
                <button
                  onClick={handleSpeakTranslation}
                  disabled={!translatedText || isLoading}
                  title={speaking ? (isRtl ? 'إيقاف الصوت' : 'Stop speaking') : (isRtl ? 'نطق الترجمة' : 'Speak')}
                  className={`w-8 h-8 rounded-full flex items-center justify-center transition active:scale-90 ${
                    speaking
                      ? 'bg-sky-500 text-white animate-pulse'
                      : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-30'
                  }`}
                >
                  {speaking ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                </button>

                {/* Copy Action */}
                <button
                  onClick={handleCopy}
                  disabled={!translatedText || isLoading}
                  title={isRtl ? 'نسخ الترجمة' : 'Copy'}
                  className="w-8 h-8 rounded-full flex items-center justify-center text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 active:scale-90 transition disabled:opacity-30"
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                </button>
              </>
            )}

            {/* Dismiss */}
            <button
              onClick={handleClose}
              aria-label={isRtl ? 'إغلاق' : 'Close'}
              className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 active:scale-90 transition"
            >
              <X className="w-4.5 h-4.5" />
            </button>
          </div>
        </div>

        {/* Body content */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3.5 overscroll-contain touch-pan-y">
          {/* Medical Term / Passage Input & Search */}
          <div className="flex items-center gap-2 p-2 bg-slate-50 dark:bg-zinc-800/80 rounded-2xl border border-slate-200 dark:border-zinc-700">
            <Search className="w-4 h-4 text-slate-400 shrink-0 mx-1" />
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && inputText.trim()) {
                  fetchTranslation(targetLang, inputText.trim());
                }
              }}
              placeholder={isRtl ? 'اكتب أو الصق مصطلحاً طبياً للترجمة...' : 'Type or paste a medical/lecture term...'}
              className="flex-1 bg-transparent text-xs text-slate-900 dark:text-zinc-100 placeholder-slate-400 outline-none"
            />
            {inputText.trim() && (
              <button
                type="button"
                onClick={() => fetchTranslation(targetLang, inputText.trim())}
                className="px-3 py-1 bg-sky-500 hover:bg-sky-600 active:scale-95 text-white text-xs font-bold rounded-xl transition shadow-sm"
              >
                {isRtl ? 'ترجم' : 'Translate'}
              </button>
            )}
          </div>

          {/* Source Text Card */}
          {inputText && (
            <div className="rounded-2xl bg-slate-50 dark:bg-zinc-800/60 p-3 border border-slate-100 dark:border-zinc-800/80">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <span className="text-[11px] font-bold text-slate-400 dark:text-slate-500">
                  {isRtl ? 'النص المطلوب' : 'Source Passage'}
                </span>
                <button
                  onClick={handleSpeakOriginal}
                  title={speakingOriginal ? (isRtl ? 'إيقاف' : 'Stop') : (isRtl ? 'استماع للأصل' : 'Listen to original')}
                  className={`text-[11px] font-bold flex items-center gap-1 transition ${
                    speakingOriginal ? 'text-sky-500' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
                  }`}
                >
                  {speakingOriginal ? <VolumeX className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
                  <span>{speakingOriginal ? (isRtl ? 'إيقاف' : 'Stop') : (isRtl ? 'استماع' : 'Listen')}</span>
                </button>
              </div>

              <p
                dir={initialSourceIsArabic ? 'rtl' : 'ltr'}
                className="text-xs font-medium text-slate-700 dark:text-slate-300 leading-relaxed break-words"
              >
                {displayedSource}
              </p>

              {isLongSource && (
                <button
                  onClick={() => setShowFullSource((v) => !v)}
                  className="mt-1 text-[11px] font-bold text-sky-500 hover:underline"
                >
                  {showFullSource
                    ? (isRtl ? 'عرض أقل' : 'Show less')
                    : (isRtl ? 'عرض النص كاملاً' : 'Show full text')}
                </button>
              )}
            </div>
          )}

          {/* Translated Result Output / Subscription Paywall Gate */}
          <div className="px-1">
            {!hasAccess ? (
              <div className="rounded-2xl bg-gradient-to-br from-violet-600 via-indigo-600 to-purple-700 text-white p-4 shadow-lg space-y-3 border border-violet-400/30">
                <div className="flex items-center gap-2 font-black text-sm">
                  <Sparkles className="w-4.5 h-4.5 text-amber-300 shrink-0" />
                  <span>
                    {isRtl
                      ? 'الترجمة الفورية — ميزة باقة بلس'
                      : 'Instant Translation — Plus Feature'}
                  </span>
                </div>
                <p className="text-xs font-medium text-violet-100 leading-relaxed" dir="auto">
                  {isRtl
                    ? 'استمتع بترجمة فورية غير محدودة للمصطلحات والفقرات داخل قارئ المحاضرات مع النطق الصوتي والمزيد.'
                    : 'Enjoy unlimited in-reader translation for medical terms and lecture passages with voice pronunciation and more.'}
                </p>
                {onOpenSubscription && (
                  <button
                    onClick={() => {
                      handleClose();
                      onOpenSubscription();
                    }}
                    className="w-full py-2.5 px-3 rounded-xl bg-white text-violet-900 font-black text-xs hover:bg-violet-50 active:scale-95 transition shadow-sm flex items-center justify-center gap-1.5"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-violet-600" />
                    <span>{isRtl ? 'ترقية الحساب الآن' : 'Upgrade Account Now'}</span>
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-black text-slate-400 dark:text-slate-500">
                    {targetLang === 'ar' ? (isRtl ? 'الترجمة إلى العربية' : 'Arabic Translation') : (isRtl ? 'الترجمة إلى الإنجليزية' : 'English Translation')}
                  </span>
                  {copied && (
                    <span className="text-[11px] font-bold text-emerald-500 animate-fade-in">
                      {isRtl ? 'تم النسخ!' : 'Copied!'}
                    </span>
                  )}
                </div>

                {isLoading ? (
                  <div className="space-y-2.5 py-3 animate-pulse">
                    <div className="h-4.5 bg-slate-200 dark:bg-zinc-800 rounded-full w-full" />
                    <div className="h-4.5 bg-slate-200 dark:bg-zinc-800 rounded-full w-11/12" />
                    <div className="h-4.5 bg-slate-200 dark:bg-zinc-800 rounded-full w-3/4" />
                  </div>
                ) : error ? (
                  <div className="rounded-2xl bg-amber-50/80 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/40 p-3.5 space-y-2.5">
                    <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400 text-xs font-bold">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <span>{error}</span>
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={() => fetchTranslation(targetLang)}
                        className="h-8 px-3 rounded-xl bg-amber-600 text-white text-xs font-black flex items-center gap-1.5 active:scale-95 transition"
                      >
                        <RotateCw className="w-3.5 h-3.5" />
                        <span>{isRtl ? 'إعادة المحاولة' : 'Retry'}</span>
                      </button>
                      <button
                        onClick={() => openExternalTranslate(sourceText, targetLang)}
                        className="h-8 px-3 rounded-xl border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-xs font-bold flex items-center gap-1.5 hover:bg-amber-100/50 dark:hover:bg-amber-900/30 active:scale-95 transition"
                      >
                        <span>{isRtl ? 'فتح في ترجمة Google' : 'Google Translate'}</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    dir={targetLang === 'ar' ? 'rtl' : 'ltr'}
                    className="select-text text-base font-bold text-slate-900 dark:text-zinc-100 leading-relaxed break-words"
                  >
                    {translatedText}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Footer fallback link for peace of mind */}
        <div className="shrink-0 px-4 pt-2 border-t border-slate-100 dark:border-zinc-800 flex items-center justify-between text-[11px] text-slate-400">
          <button
            onClick={() => openExternalTranslate(sourceText, targetLang)}
            className="inline-flex items-center gap-1 hover:text-slate-600 dark:hover:text-slate-200 transition"
          >
            <span>{isRtl ? 'فتح في ترجمة Google' : 'Open in Google Translate'}</span>
            <ExternalLink className="w-3 h-3" />
          </button>
          <span className="text-[10px] text-slate-400/80">
            {sourceText.length} {isRtl ? 'حرف' : 'chars'}
          </span>
        </div>
      </motion.div>
    </>
  );
}
