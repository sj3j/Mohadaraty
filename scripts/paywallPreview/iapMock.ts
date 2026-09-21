/**
 * Stand-in for src/lib/iap.ts, used only by the paywall preview.
 *
 * The preview exists so the App Store Connect review screenshot is taken from
 * the REAL SubscriptionScreen.ios.tsx rather than a mock-up. That only works if
 * the mock is confined to the boundary the component already treats as
 * external - the store - so everything below returns what RevenueCat would and
 * nothing else is faked.
 *
 * Prices are passed in from the build (see vite.config.ts) because they belong
 * to App Store Connect, not to this repo: a hardcoded figure here would drift
 * from the tier the moment either changed.
 */
import type { PurchasesPackage } from '@revenuecat/purchases-capacitor';

declare const __PREVIEW_PRICES__: Record<string, string>;
declare const __PREVIEW_ACTIVE__: boolean;

const PRODUCTS: { id: string; identifier: string; ar: string; en: string }[] = [
  { id: 'com.mohadaraty.app.1month', identifier: '$rc_monthly', ar: 'شهر واحد', en: '1 Month' },
  { id: 'com.mohadaraty.app.3months', identifier: '$rc_three_month', ar: '٣ أشهر', en: '3 Months' },
  { id: 'com.mohadaraty.app.6months', identifier: '$rc_six_month', ar: '٦ أشهر', en: '6 Months' },
  { id: 'com.mohadaraty.app.1year', identifier: '$rc_annual', ar: 'سنة كاملة', en: '1 Year' },
];

export const IAP_ENABLED = true;
export const MANAGE_SUBSCRIPTION_URL = 'itms-apps://apps.apple.com/account/subscriptions';

export async function getPlans(): Promise<PurchasesPackage[]> {
  const lang = document.documentElement.getAttribute('data-preview-lang') === 'en' ? 'en' : 'ar';
  return PRODUCTS.map(p => ({
    identifier: p.identifier,
    packageType: p.identifier,
    offeringIdentifier: 'default',
    product: {
      identifier: p.id,
      title: lang === 'en' ? p.en : p.ar,
      description: '',
      priceString: __PREVIEW_PRICES__[p.id] ?? '',
    },
  })) as unknown as PurchasesPackage[];
}

export async function syncEntitlement() {
  return __PREVIEW_ACTIVE__
    ? { active: true, expiresAt: null, plan: 'annual' }
    : { active: false, expiresAt: null, plan: null };
}

export async function purchase() { return { status: 'cancelled' as const }; }
export async function restore() { return { restored: false }; }
export async function configureIap() {}
export async function identifyIap() {}
export async function signOutIap() {}
