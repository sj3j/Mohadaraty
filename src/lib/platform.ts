/**
 * Which build is this, and what is it allowed to do about money.
 *
 * Two flags, because the two stores want opposite things and one boolean could
 * not say both:
 *
 *   Play  - forbids taking real money outside its own billing AND forbids
 *           steering users to pay elsewhere. The Android build therefore sells
 *           nothing; access is provisioned by a stage representative.
 *   Apple - requires that digital access be sold THROUGH its billing. The iOS
 *           build therefore does sell - via RevenueCat/StoreKit - and hiding
 *           that would be its own rejection.
 *
 * Both are build-time constants substituted by vite.config.ts, so Vite's dead
 * code elimination removes the unused branch entirely rather than shipping it
 * behind a runtime `if`. That matters: the stores scan the uploaded artefact,
 * and a hidden purchase surface is still IN it. See src/native-stubs/ and
 * scripts/assert-no-payment-surface.mjs.
 */

declare const __NATIVE_BUILD__: boolean;
declare const __IOS_BUILD__: boolean;

/**
 * Running inside an app binary (Android APK/AAB or iOS .ipa) rather than on the
 * web. This is the flag for things that are true of any packaged build - the
 * absolute API base in src/lib/apiBase.ts, and any screen that is build-time
 * stubbed on BOTH native targets.
 *
 * It is NOT "cannot sell". iOS is a store build that sells. Use CAN_SELL for
 * that question.
 */
export const IS_STORE_BUILD: boolean =
  typeof __NATIVE_BUILD__ !== 'undefined' ? __NATIVE_BUILD__ : false;

/** The App Store build specifically - the one with Apple IAP compiled in. */
export const IS_IOS_BUILD: boolean =
  typeof __IOS_BUILD__ !== 'undefined' ? __IOS_BUILD__ : false;

/**
 * May this build show purchase vocabulary and a route to a buy flow?
 *
 * Web yes (ZainCash / Super Qi), iOS yes (Apple IAP), Android no.
 *
 * Every runtime check that used to ask `IS_STORE_BUILD` in order to soften a
 * "Subscription" row into an "Access" row, or to hide the route to the paywall
 * entirely, means THIS. Asking IS_STORE_BUILD there would leave the iOS build
 * with an Apple paywall that nothing in the UI can reach - which is not a
 * cosmetic bug, it is an app that cannot be bought from.
 */
export const CAN_SELL: boolean = !IS_STORE_BUILD || IS_IOS_BUILD;
