import React from 'react';
import { KeyRound } from 'lucide-react';
import { Language, TRANSLATIONS, UserProfile } from '../types';

/**
 * Native replacement for src/components/SubscriptionScreen.tsx.
 *
 * The real screen sells access: plan cards with prices, a payment-method
 * chooser, and a ZainCash hand-off. Both stores forbid taking real money
 * outside their own billing, and they check by scanning the binary - so the
 * screen is excluded at BUILD time here rather than hidden behind
 * IS_STORE_BUILD, which left every price and provider name in the bundle.
 *
 * What replaces it is an ACCESS STATUS screen, not a quieter shop. That
 * distinction is the whole point:
 *
 *   - It never says "subscription", "plan", "price" or "buy". On a store build
 *     those words invite a reviewer to hunt for the purchase flow, and finding
 *     one outside Play billing is the violation.
 *   - It does not tell anyone where or how to pay. Pointing a user to an
 *     external way to purchase is steering, which is prohibited independently
 *     of whether the app itself takes the money.
 *   - It states only two facts: whether this account has access, and who
 *     changes that. Both are true and neither is a transaction.
 *
 * This is honest rather than evasive: access here really is provisioned by a
 * stage representative against the college roster. The web build, which is not
 * bound by store billing rules, keeps the real screen.
 *
 * Access itself is unaffected: App.tsx gates content on `user.isSubscribed`,
 * read from the users document, so anyone already active keeps everything.
 */
export default function SubscriptionScreen({ user, lang }: { user: UserProfile | null; lang: Language }) {
  const t = TRANSLATIONS[lang];
  const isRtl = lang === 'ar';

  const active = !!user?.isSubscribed;

  // Shown only when access is active, and only as a date. An expiry is a fact
  // about the account; a renewal prompt would be an offer.
  const until = (() => {
    const raw = user?.subscriptionEnd;
    if (!active || !raw) return null;
    try {
      const d = raw?.toDate ? raw.toDate() : new Date(raw);
      if (Number.isNaN(d.getTime())) return null;
      return d.toLocaleDateString(isRtl ? 'ar-IQ' : 'en-GB', {
        year: 'numeric', month: 'long', day: 'numeric',
      });
    } catch {
      return null;
    }
  })();

  return (
    <div className="p-4 sm:p-6 max-w-lg mx-auto" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800 rounded-3xl p-6 text-center">
        <div
          className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 ${
            active
              ? 'bg-emerald-100 dark:bg-emerald-900/30'
              : 'bg-slate-100 dark:bg-zinc-800'
          }`}
        >
          <KeyRound className={`w-8 h-8 ${active ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}`} />
        </div>

        <h2 className="text-lg font-black text-slate-900 dark:text-stone-100 mb-2">
          {t.accessStatus}
        </h2>

        <p
          className={`text-base font-black mb-1 ${
            active ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'
          }`}
        >
          {active ? t.accessActive : t.accessInactive}
        </p>

        {until && (
          <p className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3">
            {t.accessUntil} {until}
          </p>
        )}

        <p className="text-sm font-bold text-slate-500 dark:text-slate-400 leading-relaxed mt-3">
          {t.accessManagedByRep}
        </p>
      </div>
    </div>
  );
}
