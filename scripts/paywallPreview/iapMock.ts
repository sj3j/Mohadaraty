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

/**
 * The real offering, as configured in RevenueCat.
 *
 * `title` is deliberately the App Store Connect display name VERBATIM,
 * including the fact that three are English and one is Arabic. The screen is
 * supposed to ignore it in favour of PLAN_CONFIG's localised label, so leaving
 * the inconsistency here is what proves it does.
 */
const PRODUCTS: { id: string; identifier: string; title: string }[] = [
  { id: 'com.mohadaraty.app.1month', identifier: '$rc_monthly', title: 'شهري' },
  { id: 'com.mohadaraty.app.3months', identifier: '$rc_three_month', title: '3 Months' },
  { id: 'com.mohadaraty.app.6months', identifier: '$rc_six_month', title: '6 Months' },
  { id: 'com.mohadaraty.app.1year', identifier: '$rc_annual', title: '1 Year' },
];

export const IAP_ENABLED = true;
export const MANAGE_SUBSCRIPTION_URL = 'itms-apps://apps.apple.com/account/subscriptions';

export async function getPlans(): Promise<PurchasesPackage[]> {
  return PRODUCTS.map(p => ({
    identifier: p.identifier,
    packageType: p.identifier,
    offeringIdentifier: 'default',
    product: {
      identifier: p.id,
      title: p.title,
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
