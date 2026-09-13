import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { HelpCircle, X } from 'lucide-react';
import { Language } from '../../types';
import { FAQ_TITLE, FAQ_SUBTITLE } from '../../lib/support';
import { useBackDismiss } from '../../hooks/useBackDismiss';
import FaqList from './FaqList';

/**
 * The FAQ as an overlay, for the login and signup screens - the two places a
 * student is standing when they need it and have no Settings to open.
 *
 * The body keeps the page ground (slate-50 / zinc-950) rather than the panel's
 * white, because `FaqList` draws white cards and they would otherwise vanish
 * into it.
 */
export default function FaqSheet({
  open, onClose, lang,
}: {
  open: boolean;
  onClose: () => void;
  lang: Language;
}) {
  const isRtl = lang === 'ar';

  // Android hardware back closes the sheet instead of leaving the app.
  useBackDismiss(open, onClose, 'faq');

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center sm:p-4" dir={isRtl ? 'rtl' : 'ltr'}>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />

          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.98 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="relative w-full sm:max-w-md max-h-[88vh] flex flex-col bg-slate-50 dark:bg-zinc-950 rounded-t-3xl sm:rounded-3xl shadow-2xl border border-slate-200 dark:border-zinc-800 overflow-hidden"
          >
            <div className="flex items-center gap-3 px-5 py-4 bg-white dark:bg-zinc-900 border-b-2 border-slate-100 dark:border-zinc-800">
              <div className="flex-1 min-w-0">
                <h2 className="text-lg font-black text-slate-900 dark:text-white truncate">
                  {isRtl ? FAQ_TITLE.ar : FAQ_TITLE.en}
                </h2>
                <p className="text-xs font-bold text-slate-400 dark:text-slate-500 truncate mt-0.5">
                  {isRtl ? FAQ_SUBTITLE.ar : FAQ_SUBTITLE.en}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={isRtl ? 'إغلاق' : 'Close'}
                className="p-2 -me-2 shrink-0 rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
              >
                <X className="w-5 h-5" strokeWidth={2.5} />
              </button>
            </div>

            {/* The sheet reaches the bottom edge on a phone, so it owns the
                gesture-bar inset the app root cannot pad for it. */}
            <div className="flex-1 overflow-y-auto px-4 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
              <FaqList lang={lang} />
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

/**
 * The quiet link that opens the sheet. Shared so the login and signup screens
 * cannot drift apart in wording or weight - it sits under a primary action on
 * both and must not compete with it.
 */
export function FaqTrigger({ lang, onClick }: { lang: Language; onClick: () => void }) {
  const isRtl = lang === 'ar';
  return (
    <button
      type="button"
      onClick={onClick}
      className="mx-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold text-slate-400 dark:text-slate-500 hover:text-sky-600 dark:hover:text-sky-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
    >
      <HelpCircle className="w-4 h-4 shrink-0" strokeWidth={2.5} />
      <span>{isRtl ? 'الأسئلة الشائعة ومشاكل الدخول' : 'FAQ & sign-in help'}</span>
    </button>
  );
}
