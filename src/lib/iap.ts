/**
 * Apple In-App Purchase, brokered by RevenueCat. The only module that touches
 * the SDK.
 *
 * Three things this file exists to guarantee:
 *
 * 1. **The plugin never enters the web or Android bundle.** `IAP_ENABLED` is a
 *    build-time literal (vite.config.ts substitutes `__IOS_BUILD__`), every
 *    entry point returns early on it, and the SDK is reached only through a
 *    dynamic `import()` behind that guard - so Rollup drops the import
 *    entirely from the other two targets rather than shipping a purchase SDK
 *    into an APK that is forbidden to have one. Type-only imports are erased
 *    by the compiler and cost nothing.
 *
 * 2. **The client is never the authority on entitlement.** `purchase()` and
 *    `restore()` return only enough for the UI to stop spinning; what actually
 *    unlocks content is `syncEntitlement()`, which asks OUR server, which asks
 *    RevenueCat with the secret key and writes users/{uid}. A CustomerInfo
 *    object read in the WebView is a hint, not a grant.
 *
 * 3. **The App User ID is opaque and server-minted.** Never the Firebase uid:
 *    a roster student's uid IS their college email (see CLAUDE.md, "two
 *    identity spaces"), and RevenueCat's own guidance is not to put PII in an
 *    App User ID. /api/iap/identity returns a hash and guarantees the reverse
 *    link exists BEFORE a purchase can happen, so a webhook can always
 *    attribute the payment.
 */
import type {
  CustomerInfo,
  PurchasesOffering,
  PurchasesPackage,
} from '@revenuecat/purchases-capacitor';
import { IS_IOS_BUILD } from './platform';
import { apiUrl } from './apiBase';
import { auth } from './firebase';

/** Compiled to a literal, so everything below it is dead code off iOS. */
export const IAP_ENABLED: boolean = IS_IOS_BUILD;

/**
 * Public SDK key. Public by design, exactly like the Firebase web key already
 * in firebase-applet-config.json - it can only read offerings and start a
 * purchase Apple itself must then authorise. The SECRET key (sk_...) is a
 * server env var and must never appear in a bundle.
 */
const PUBLIC_API_KEY: string = (import.meta as any).env?.VITE_REVENUECAT_IOS_KEY || '';

/**
 * PURCHASES_ERROR_CODE members, as literals.
 *
 * The enum is a runtime value: importing it rather than its type would pull
 * the whole SDK into every bundle and defeat the guard above. The values are a
 * stable part of RevenueCat's public API (see the plugin's errors.d.ts).
 */
const ERR_CANCELLED = '1';
const ERR_PAYMENT_PENDING = '20';
const ERR_PRODUCT_ALREADY_PURCHASED = '6';

/** One import, one configure, however many callers. */
let pluginPromise: Promise<any> | null = null;
let configured = false;

async function sdk(): Promise<any | null> {
  if (!IAP_ENABLED) return null;
  if (!pluginPromise) {
    pluginPromise = import('@revenuecat/purchases-capacitor')
      .then(m => m.Purchases)
      .catch(err => {
        // A missing native plugin must degrade to "no store", never crash the
        // app shell - the reader, lectures and streaks have nothing to do with
        // purchasing and must keep working.
        console.warn('[iap] plugin unavailable', err);
        pluginPromise = null;
        return null;
      });
  }
  return pluginPromise;
}

async function idToken(): Promise<string | null> {
  try {
    return (await auth.currentUser?.getIdToken()) ?? null;
  } catch {
    return null;
  }
}

async function postJson(path: string, body?: unknown): Promise<any | null> {
  const token = await idToken();
  if (!token) return null;
  try {
    const res = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      console.warn(`[iap] ${path} -> ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[iap] ${path} failed`, err);
    return null;
  }
}

/**
 * Configure once per process. Safe to call on every auth transition.
 *
 * Deliberately does NOT take an appUserID: configuring anonymously and then
 * calling identify() is what lets RevenueCat alias a purchase made before the
 * identity call onto the right customer, instead of stranding it on an
 * anonymous id.
 */
export async function configureIap(): Promise<void> {
  if (!IAP_ENABLED || configured) return;
  const Purchases = await sdk();
  if (!Purchases) return;
  if (!PUBLIC_API_KEY) {
    console.warn('[iap] VITE_REVENUECAT_IOS_KEY is not set - the store will not load');
    return;
  }
  try {
    const already = await Purchases.isConfigured();
    if (!already?.isConfigured) {
      await Purchases.configure({ apiKey: PUBLIC_API_KEY });
    }
    configured = true;
  } catch (err) {
    console.warn('[iap] configure failed', err);
  }
}

/**
 * Tie the RevenueCat customer to this account, then reconcile.
 *
 * The identity round-trip is what mints the opaque App User ID and writes the
 * reverse-link document the webhook needs, so it has to succeed before any
 * purchase - which is why it happens at sign-in rather than at the paywall.
 */
export async function identifyIap(): Promise<void> {
  if (!IAP_ENABLED) return;
  await configureIap();
  const Purchases = await sdk();
  if (!Purchases || !configured) return;

  const identity = await postJson('/api/iap/identity');
  const appUserID = identity?.rcAppUserId;
  if (!appUserID) return;

  try {
    await Purchases.logIn({ appUserID });
  } catch (err) {
    console.warn('[iap] logIn failed', err);
    return;
  }
  // A purchase made on another device, or a renewal that happened while the
  // app was closed, lands here rather than waiting for the next webhook.
  await syncEntitlement();
}

export async function signOutIap(): Promise<void> {
  if (!IAP_ENABLED || !configured) return;
  const Purchases = await sdk();
  if (!Purchases) return;
  try {
    await Purchases.logOut();
  } catch (err) {
    // Logging out an already-anonymous customer throws; that is not a failure.
    console.warn('[iap] logOut', err);
  }
}

/**
 * Ask OUR server what this account is entitled to. The server asks RevenueCat
 * with the secret key and writes users/{uid} - so this, not CustomerInfo, is
 * what the rest of the app's access gate ends up reading.
 */
export async function syncEntitlement(): Promise<{
  active: boolean;
  expiresAt: string | null;
  plan: string | null;
} | null> {
  if (!IAP_ENABLED) return null;
  return postJson('/api/iap/sync');
}

/** The current offering's packages, or [] when the store is unreachable. */
export async function getPlans(): Promise<PurchasesPackage[]> {
  if (!IAP_ENABLED) return [];
  await configureIap();
  const Purchases = await sdk();
  if (!Purchases || !configured) return [];
  try {
    const offerings = await Purchases.getOfferings();
    const current: PurchasesOffering | null = offerings?.current ?? null;
    return current?.availablePackages ?? [];
  } catch (err) {
    console.warn('[iap] getOfferings failed', err);
    return [];
  }
}

export type PurchaseOutcome =
  | { status: 'purchased'; customerInfo: CustomerInfo }
  /** The student dismissed Apple's sheet. Not an error - say nothing. */
  | { status: 'cancelled' }
  /** Ask-to-Buy / SCA. Apple will settle later; the webhook will land it. */
  | { status: 'pending' }
  /** Already owned on this Apple ID - restore rather than charge again. */
  | { status: 'already_owned' }
  | { status: 'failed'; message: string };

export async function purchase(pkg: PurchasesPackage): Promise<PurchaseOutcome> {
  if (!IAP_ENABLED) return { status: 'failed', message: 'unsupported' };
  const Purchases = await sdk();
  if (!Purchases || !configured) return { status: 'failed', message: 'unconfigured' };
  try {
    const result = await Purchases.purchasePackage({ aPackage: pkg });
    // Entitlement is granted by the server, not by this return value.
    await syncEntitlement();
    return { status: 'purchased', customerInfo: result.customerInfo };
  } catch (err: any) {
    const code = String(err?.code ?? '');
    if (code === ERR_CANCELLED || err?.userCancelled) return { status: 'cancelled' };
    if (code === ERR_PAYMENT_PENDING) return { status: 'pending' };
    if (code === ERR_PRODUCT_ALREADY_PURCHASED) return { status: 'already_owned' };
    console.warn('[iap] purchase failed', err);
    return { status: 'failed', message: String(err?.message ?? 'unknown') };
  }
}

/**
 * Apple requires a visible restore control on any app selling an
 * auto-renewable subscription, and it is the only route back for a student who
 * reinstalled or changed device.
 */
export async function restore(): Promise<{ restored: boolean }> {
  if (!IAP_ENABLED) return { restored: false };
  const Purchases = await sdk();
  if (!Purchases || !configured) return { restored: false };
  try {
    await Purchases.restorePurchases();
  } catch (err) {
    console.warn('[iap] restore failed', err);
    return { restored: false };
  }
  const synced = await syncEntitlement();
  return { restored: Boolean(synced?.active) };
}

/**
 * Apple's own subscription management. Not steering: Apple requires
 * auto-renewable subscriptions to be manageable and cancellable, and this is
 * the surface it provides for it.
 */
export const MANAGE_SUBSCRIPTION_URL = 'itms-apps://apps.apple.com/account/subscriptions';
