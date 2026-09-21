import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Crown, Sparkles } from 'lucide-react';
import { Language, TRANSLATIONS } from '../types';

interface SubscriptionPaywallProps {
  lang: Language;
  onClose: () => void;
  onSubscribe: () => void;
}

/**
 * The App Store build's paywall prompt.
 *
 * vite.config.ts aliases `./components/SubscriptionPaywall` here for
 * mode === 'ios'. Unlike the Android stub - which accepts `onSubscribe` and
 * deliberately ignores it, because that build has nowhere to send anyone -
 * this one calls it, and App.tsx routes it to the subscription tab where
 * SubscriptionScreen.ios.tsx renders the real Apple offering.
 *
 * It renders NO plan cards and NO prices. The web paywall lists PLAN_CONFIG
 * with IQD figures; those are the web rail's and are wrong on iOS, where the
 * only correct price is Apple's localized `priceString` for the viewer's own
 * storefront. Fetching offerings here just to preview them would duplicate the
 * screen this modal exists to open, and would show a second spinner in front
 * of the first.
 */
export default function SubscriptionPaywall({ lang, onClose, onSubscribe }: SubscriptionPaywallProps) {
  const isRtl = lang === 'ar';
  const t = TRANSLATIONS[lang] as any;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
        onClick={onClose}
      >
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 20 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          onClick={(e) => e.stopPropagation()}
          className="relative w-full max-w-sm bg-white dark:bg-zinc-900 rounded-3xl shadow-2xl overflow-hidden"
          dir={isRtl ? 'rtl' : 'ltr'}
        >
          <div className="relative px-6 pt-8 pb-8 bg-gradient-to-br from-amber-500 via-orange-500 to-rose-500 text-white overflow-hidden">
            <div className="absolute -top-10 -right-10 w-40 h-40 bg-white/10 rounded-full" />
            <div className="absolute -bottom-8 -left-8 w-32 h-32 bg-white/10 rounded-full" />

            <button
              onClick={onClose}
              className="absolute top-4 left-4 rtl:left-auto rtl:right-4 p-2 rounded-full bg-white/20 hover:bg-white/30 transition-colors"
              aria-label={isRtl ? 'إغلاق' : 'Close'}
            >
              <X className="w-5 h-5" />
            </button>

            <div className="relative z-10 text-center pt-2">
              <div className="w-16 h-16 rounded-2xl bg-white/20 flex items-center justify-center mx-auto mb-3">
                <Crown className="w-8 h-8" strokeWidth={2.5} />
              </div>
              <h2 className="text-lg font-black">{t.subscriptionRequired}</h2>
            </div>
          </div>

          <div className="p-6 space-y-3">
            <button
              onClick={onSubscribe}
              className="w-full flex items-center justify-center gap-2 rounded-2xl px-5 py-3.5 bg-sky-500 hover:bg-sky-600 text-white text-sm font-black transition-colors"
            >
              <Sparkles className="w-4 h-4" />
              {t.paySubscribe}
            </button>
            <button
              onClick={onClose}
              className="w-full rounded-2xl px-5 py-3 text-sm font-black text-slate-500 dark:text-slate-400"
            >
              {isRtl ? 'ليس الآن' : 'Not now'}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
