import React, { useCallback, useEffect, useState } from 'react';
import { Crown, KeyRound, Loader2, RotateCcw, ExternalLink, AlertCircle } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import type { PurchasesPackage } from '@revenuecat/purchases-capacitor';
import { Language, SubscriptionPlan, TRANSLATIONS, UserProfile } from '../types';
import { planForProduct } from '../../shared/iap';
import { hasSubscriptionAccess, hasLiveSubscription } from '../../shared/subscriptionAccess';
import { getIosPlanLabel, getIosBillingDescription } from '../i18n/paymentsIos';
import {
  MANAGE_SUBSCRIPTION_URL, getPlans, purchase, restore, syncEntitlement,
} from '../lib/iap';

/**
 * The App Store build's subscription screen.
 *
 * vite.config.ts aliases `./components/SubscriptionScreen` here for
 * mode === 'ios'. The web original sells through ZainCash and Super Qi; the
 * Android stub sells nothing and states an access fact instead. This one sells
 * through APPLE, which is the only thing Apple permits and also something it
 * requires the app to actually offer.
 *
 * Compliant with Apple App Store Review Guideline 3.1.2 for Auto-Renewable
 * Subscriptions:
 *   - Clear plan durations and billing frequencies.
 *   - Auto-renew terms and centered cancellation disclaimer.
 *   - Functional Restore Purchases trigger.
 *   - Direct clickable links to Terms of Use (EULA) and Privacy Policy.
 */

export const TERMS_OF_USE_URL = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';
export const PRIVACY_POLICY_URL = 'https://mohadaraty.vercel.app/privacy';

type Busy = null | { kind: 'loading' } | { kind: 'buying'; id: string } | { kind: 'restoring' };

/**
 * Open external legal URLs safely in in-app browser or default browser.
 */
async function openExternalUrl(url: string): Promise<void> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { Browser } = await import('@capacitor/browser');
      await Browser.open({ url });
      return;
    }
  } catch (err) {
    console.warn('[legal] Browser.open failed, falling back to window.open', err);
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * What to call a plan.
 *
 * Uses explicit localized names (e.g. "فصلي (3 أشهر)" per Guideline 3.1.2)
 * rather than raw StoreKit titles which may lack duration clarification or Arabic localization.
 */
function planLabel(productId: string, fallbackTitle: string, isRtl: boolean): string {
  const plan = planForProduct(productId);
  return getIosPlanLabel(plan, fallbackTitle, isRtl);
}

export default function SubscriptionScreen({ user, lang }: { user: UserProfile | null; lang: Language }) {
  const t = TRANSLATIONS[lang] as any;
  const isRtl = lang === 'ar';

  const [packages, setPackages] = useState<PurchasesPackage[]>([]);
  const [busy, setBusy] = useState<Busy>({ kind: 'loading' });
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  // Set by a successful purchase or restore, so the screen reflects the new
  // state immediately instead of waiting for the users/{uid} listener in
  // App.tsx to deliver the server's write.
  const [justActivated, setJustActivated] = useState(false);

  const active = justActivated || hasSubscriptionAccess(user);
  const subscriber = justActivated || hasLiveSubscription(user);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [list] = await Promise.all([
        getPlans(),
        // A renewal that happened while the app was closed should be visible
        // the moment this screen opens, not after the next webhook.
        syncEntitlement(),
      ]);
      if (!alive) return;
      setPackages(list);
      setBusy(null);
    })();
    return () => { alive = false; };
  }, []);

  const onBuy = useCallback(async (pkg: PurchasesPackage) => {
    setNotice(null);
    setBusy({ kind: 'buying', id: pkg.identifier });
    const outcome = await purchase(pkg);
    setBusy(null);
    switch (outcome.status) {
      case 'purchased':
        setJustActivated(true);
        setNotice({ tone: 'ok', text: t.payThanks });
        break;
      case 'cancelled':
        // Dismissing Apple's sheet is a decision, not a failure. Saying
        // anything here reads as nagging.
        break;
      case 'pending':
        setNotice({ tone: 'warn', text: t.payDeferred });
        break;
      case 'already_owned':
        setNotice({ tone: 'warn', text: t.payRestore });
        break;
      default:
        setNotice({ tone: 'warn', text: t.payFailed });
    }
  }, [t]);

  const onRestore = useCallback(async () => {
    setNotice(null);
    setBusy({ kind: 'restoring' });
    const { restored } = await restore();
    setBusy(null);
    if (restored) {
      setJustActivated(true);
      setNotice({ tone: 'ok', text: t.payRestored });
    } else {
      setNotice({ tone: 'warn', text: t.payNothingToRestore });
    }
  }, [t]);

  const until = (() => {
    const raw = user?.subscriptionEnd;
    if (!subscriber || !raw) return null;
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
    <div className="p-4 sm:p-6 max-w-lg mx-auto space-y-4" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* ---- current state ------------------------------------------------ */}
      <div className="bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800 rounded-3xl p-6 text-center">
        <div className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 ${
          active ? 'bg-emerald-100 dark:bg-emerald-900/30' : 'bg-slate-100 dark:bg-zinc-800'
        }`}>
          {active
            ? <Crown className="w-8 h-8 text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} />
            : <KeyRound className="w-8 h-8 text-slate-400" />}
        </div>
        <p className={`text-base font-black mb-1 ${
          active ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'
        }`}>
          {active
            ? t.subscriptionActive
            : (user?.subscriptionEnd ? t.subscriptionExpired : t.payNoSubscription)}
        </p>
        {until && (
          <p className="text-sm font-bold text-slate-500 dark:text-slate-400">
            {t.payUntil} {until}
          </p>
        )}
      </div>

      {notice && (
        <div className={`rounded-2xl px-4 py-3 text-sm font-bold flex items-start gap-2 ${
          notice.tone === 'ok'
            ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300'
            : 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300'
        }`}>
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{notice.text}</span>
        </div>
      )}

      {/* ---- the store ---------------------------------------------------- */}
      {busy?.kind === 'loading' ? (
        <div className="flex justify-center py-10">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
        </div>
      ) : packages.length === 0 ? (
        // StoreKit unreachable, or no offering configured yet.
        <div className="bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800 rounded-3xl p-6 text-center">
          <p className="text-sm font-bold text-slate-500 dark:text-slate-400">{t.payUnavailable}</p>
        </div>
      ) : (
        <div className="space-y-3">
          <h3 className="text-sm font-black text-slate-500 dark:text-slate-400 px-1">
            {t.payChoosePlan}
          </h3>
          {packages.map(pkg => {
            const buying = busy?.kind === 'buying' && busy.id === pkg.identifier;
            const plan = planForProduct(pkg.product.identifier) as SubscriptionPlan | null;
            const title = planLabel(pkg.product.identifier, pkg.product.title, isRtl);
            const billingDesc = getIosBillingDescription(plan, pkg.product.priceString, isRtl);
            const isBestValue = plan === 'annual';

            return (
              <button
                key={pkg.identifier}
                onClick={() => onBuy(pkg)}
                disabled={Boolean(busy)}
                className="w-full flex items-center justify-between gap-3 bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800 hover:border-sky-300 dark:hover:border-sky-700 disabled:opacity-60 rounded-2xl px-5 py-4 transition-colors text-start"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="block text-sm font-black text-slate-900 dark:text-stone-100 truncate">
                      {title}
                    </span>
                    {isBestValue && (
                      <span className="inline-flex items-center text-[10px] font-black px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 shrink-0">
                        {t.payBestValue || (isRtl ? 'الأكثر توفيراً' : 'Best Value')}
                      </span>
                    )}
                  </span>
                  {billingDesc && (
                    <span className="block text-xs font-bold text-slate-500 dark:text-zinc-400 truncate mt-0.5">
                      {billingDesc}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  {/* Apple's own localized price. Never ours. */}
                  <span dir="ltr" className="text-sm font-black text-sky-600 dark:text-sky-400">
                    {pkg.product.priceString}
                  </span>
                  {buying && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Auto-renew disclaimer - centered and contrasted directly above action/legal buttons */}
      <p className="text-xs font-bold text-slate-500 dark:text-zinc-400 text-center leading-relaxed px-2 pt-1">
        {t.payAutoRenewNote}
      </p>

      {/* ---- restore + manage + legal ------------------------------------- */}
      <div className="flex flex-col gap-2 pt-1">
        <button
          type="button"
          onClick={onRestore}
          disabled={Boolean(busy)}
          className="w-full flex items-center justify-center gap-2 rounded-2xl px-5 py-3 border-2 border-slate-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-slate-300 dark:hover:border-zinc-700 text-sm font-black text-slate-600 dark:text-slate-300 disabled:opacity-60 transition-colors"
        >
          {busy?.kind === 'restoring'
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : <RotateCcw className="w-4 h-4" />}
          {busy?.kind === 'restoring' ? t.payRestoring : t.payRestore}
        </button>

        {subscriber && (
          <a
            href={MANAGE_SUBSCRIPTION_URL}
            className="w-full flex items-center justify-center gap-2 rounded-2xl px-5 py-3 text-sm font-black text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            {t.payManage}
          </a>
        )}

        {/* Mandatory Legal Links (App Store Guideline 3.1.2) */}
        <div className="flex items-center justify-center gap-2 pt-2 pb-1 text-xs font-bold text-slate-500 dark:text-zinc-400">
          <button
            type="button"
            onClick={() => openExternalUrl(TERMS_OF_USE_URL)}
            className="hover:text-slate-800 dark:hover:text-zinc-200 hover:underline transition-colors focus:outline-none"
          >
            {t.payTerms}
          </button>
          <span className="select-none text-slate-300 dark:text-zinc-600">•</span>
          <button
            type="button"
            onClick={() => openExternalUrl(PRIVACY_POLICY_URL)}
            className="hover:text-slate-800 dark:hover:text-zinc-200 hover:underline transition-colors focus:outline-none"
          >
            {t.payPrivacy}
          </button>
        </div>
      </div>
    </div>
  );
}
