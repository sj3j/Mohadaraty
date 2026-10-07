import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Crown, Sparkles, ChevronLeft, ChevronRight } from 'lucide-react';
import { Language, TRANSLATIONS } from '../types';
import SubscriptionPerksModal from '../components/subscription/SubscriptionPerksModal';

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
  const [showPerksModal, setShowPerksModal] = useState(false);
  const ChevronIcon = isRtl ? ChevronLeft : ChevronRight;

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

            {/* Circular Perks Header Button */}
            <button
              type="button"
              onClick={() => setShowPerksModal(true)}
              title={isRtl ? 'عرض كامل ميزات الاشتراك' : 'View all subscription perks'}
              aria-label={isRtl ? 'عرض كامل ميزات الاشتراك' : 'View all subscription perks'}
              className="absolute top-4 right-4 rtl:right-auto rtl:left-4 p-2 rounded-full bg-white/20 hover:bg-white/30 hover:scale-105 active:scale-95 transition-all flex items-center justify-center group"
            >
              <Crown className="w-5 h-5 text-amber-200 group-hover:text-amber-100" />
              <span className="absolute -top-0.5 -end-0.5 w-2.5 h-2.5 bg-amber-300 rounded-full border-2 border-orange-500 animate-pulse" />
            </button>

            <div className="relative z-10 text-center pt-2">
              <div className="w-16 h-16 rounded-2xl bg-white/20 flex items-center justify-center mx-auto mb-3">
                <Crown className="w-8 h-8" strokeWidth={2.5} />
              </div>
              <h2 className="text-lg font-black">{t.subscriptionRequired}</h2>
            </div>
          </div>

          <div className="p-6 space-y-3">
            {/* Interactive VIP Perks Card Button */}
            <button
              type="button"
              onClick={() => setShowPerksModal(true)}
              className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-amber-500/5 dark:from-amber-400/15 dark:via-orange-400/10 dark:to-transparent border border-amber-400/40 dark:border-amber-500/30 text-amber-950 dark:text-amber-200 hover:border-amber-500/60 dark:hover:border-amber-400/50 hover:bg-amber-500/15 transition-all shadow-xs active:scale-[0.99] group text-start"
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-amber-500 to-orange-400 flex items-center justify-center text-white shadow-xs group-hover:scale-105 transition-transform shrink-0">
                  <Crown className="w-4.5 h-4.5" />
                </div>
                <div>
                  <div className="text-xs font-black text-slate-900 dark:text-white flex items-center gap-1.5">
                    <span>{isRtl ? 'استعراض كامل ميزات الاشتراك VIP' : 'Explore all VIP perks'}</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-md font-bold bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                      VIP
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 font-medium line-clamp-1 mt-0.5">
                    {isRtl ? 'ملحقات المحاضرات، بنك الأسئلة، سيموسان AI والمزيد' : 'Full attachments, question bank, Simosan AI & more'}
                  </div>
                </div>
              </div>
              <ChevronIcon className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5 transition-transform" />
            </button>

            <button
              onClick={onSubscribe}
              className="w-full flex items-center justify-center gap-2 rounded-2xl px-5 py-3.5 bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 hover:from-amber-600 hover:via-orange-600 hover:to-rose-600 text-white text-sm font-black shadow-lg shadow-orange-500/25 transition-all"
            >
              <Sparkles className="w-4 h-4" />
              {t.paySubscribe}
            </button>
            <button
              onClick={onClose}
              className="w-full rounded-2xl px-5 py-3 text-sm font-black text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
            >
              {isRtl ? 'ليس الآن' : 'Not now'}
            </button>
          </div>
        </motion.div>

        {/* Subscription Perks Modal */}
        <SubscriptionPerksModal
          isOpen={showPerksModal}
          onClose={() => setShowPerksModal(false)}
          lang={lang}
        />
      </motion.div>
    </AnimatePresence>
  );
}
