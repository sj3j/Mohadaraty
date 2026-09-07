import React from 'react';
import { KeyRound, X } from 'lucide-react';
import { Language, TRANSLATIONS } from '../types';

/**
 * Native replacement for src/components/SubscriptionPaywall.tsx.
 *
 * This is what a student sees when they tap a feature their account does not
 * have - the moment a store review is most likely to look at, because it is
 * exactly where a paywall would normally push a purchase.
 *
 * So it does not push one. The real paywall ends in "Subscribe now" and leads
 * to the payment flow; this sheet states that the feature is not active on the
 * account, names who activates it, and stops. No price, no provider, no CTA,
 * and `onSubscribe` is accepted and deliberately ignored so App.tsx needs no
 * change.
 *
 * Why the wording avoids "subscription required": that phrasing reads as a
 * purchase prompt, and combined with any hint of where to buy it becomes
 * steering - prohibited whether or not the app itself handles the money. What
 * is left is a true statement about the account's state, which no policy
 * forbids.
 */
export default function SubscriptionPaywall({
  lang, onClose,
}: {
  lang: Language;
  onClose: () => void;
  onSubscribe?: () => void;
}) {
  const t = TRANSLATIONS[lang];
  const isRtl = lang === 'ar';

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4"
      dir={isRtl ? 'rtl' : 'ltr'}
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-2xl relative"
        onClick={e => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label={isRtl ? 'إغلاق' : 'Close'}
          className="absolute top-4 end-4 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800"
        >
          <X className="w-4 h-4 text-slate-400" />
        </button>

        <div className="w-14 h-14 bg-slate-100 dark:bg-zinc-800 rounded-full flex items-center justify-center mx-auto mb-4">
          <KeyRound className="w-7 h-7 text-slate-400" />
        </div>

        <h3 className="text-base font-black text-center text-slate-900 dark:text-stone-100 mb-2">
          {t.accessFeatureLocked}
        </h3>
        <p className="text-sm font-bold text-center text-slate-500 dark:text-slate-400 leading-relaxed">
          {t.accessManagedByRep}
        </p>
      </div>
    </div>
  );
}
