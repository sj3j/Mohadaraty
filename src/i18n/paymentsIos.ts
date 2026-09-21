/**
 * The App Store build's purchase vocabulary.
 *
 * vite.config.ts aliases `../i18n/payments` to this file when mode === 'ios',
 * the way it aliases the same specifier to src/native-stubs/payments.ts for
 * mode === 'native'. Three files, one specifier, three policies:
 *
 *   web      src/i18n/payments.ts        ZainCash + Super Qi, IQD, receipts
 *   android  src/native-stubs/payments.ts  {} - the build sells nothing
 *   ios      this file                    Apple IAP only
 *
 * What is deliberately ABSENT is the whole web rail: no ZainCash, no Super Qi /
 * سوبر كي, no wallet number, no WhatsApp or Telegram, no receipt upload, no
 * transaction-id entry, no IQD. Apple Guideline 3.1.1 forbids both taking money
 * for digital content outside its billing and steering users to somewhere that
 * does - so those strings are as unshippable here as they are in the APK, and
 * for the same reason: the store scans the artefact, it does not use the app.
 *
 * Equally deliberate is what IS here. Android softens "الاشتراك" into
 * "حالة الوصول" because naming a subscription invites a reviewer to hunt for a
 * purchase flow that must not exist. On iOS the purchase flow must exist, so
 * the honest words are the correct ones.
 *
 * NO PRICE LITERALS AND NO CURRENCY CODES. Every amount a student sees comes
 * from RevenueCat's localized `priceString`, which is the App Store's own
 * figure in the viewer's own storefront currency. Hardcoding one would both be
 * wrong for most students and trip the currency rule in
 * scripts/assert-no-payment-surface.mjs.
 *
 * Generic-sounding keys carry a `pay` prefix, the convention src/i18n/payments.ts
 * set, so nothing outside the purchase UI can come to depend on a string that
 * does not exist in the other two builds.
 */

export const PAYMENT_STRINGS = {
  ar: {
    // -- shared vocabulary, same keys the web build defines -----------------
    subscription: 'اشتراك',
    subscriptionPlans: 'خطط الاشتراك',
    subscriptionActive: 'الاشتراك فعال',
    subscriptionExpired: 'الاشتراك منتهي',
    subscriptionRequired: 'هذه الميزة تحتاج اشتراكاً فعالاً',
    mcqRequiresSubscription: 'بنك الأسئلة يحتاج اشتراكاً فعالاً',
    subscriptionActivated: 'تم تفعيل اشتراكك',

    // -- the Apple purchase flow -------------------------------------------
    payChoosePlan: 'اختر خطتك',
    paySubscribe: 'اشترك الآن',
    payRenew: 'جدّد الاشتراك',
    payUntil: 'ينتهي في',
    /** Apple requires a visible, working restore control on every app that
     *  sells a non-consumable or an auto-renewable subscription. */
    payRestore: 'استعادة المشتريات',
    payRestoring: 'جارٍ الاستعادة…',
    payRestored: 'تمت استعادة اشتراكك',
    payNothingToRestore: 'لا توجد مشتريات لاستعادتها على هذا الحساب',
    /** Deep-links to Apple's own subscription management. Sending a user to
     *  the platform's own settings is not steering - it is where Apple
     *  requires auto-renewable subscriptions to be managed and cancelled. */
    payManage: 'إدارة الاشتراك',
    payProcessing: 'جارٍ إتمام العملية…',
    payVerifying: 'جارٍ التحقق…',
    payThanks: 'شكراً لك! تم تفعيل اشتراكك',
    payCancelled: 'تم إلغاء العملية',
    payFailed: 'تعذّر إتمام العملية',
    payDeferred: 'بانتظار الموافقة على الشراء',
    /** StoreKit unreachable, or the offering has no packages yet. A plain
     *  statement beats a blank screen. */
    payUnavailable: 'المتجر غير متاح حالياً، حاول لاحقاً',
    payAutoRenewNote: 'يتجدد الاشتراك تلقائياً ما لم يتم إيقافه قبل انتهاء المدة.',
    payTerms: 'شروط الاستخدام',
    payPrivacy: 'سياسة الخصوصية',
  },
  en: {
    subscription: 'Subscription',
    subscriptionPlans: 'Subscription plans',
    subscriptionActive: 'Subscription active',
    subscriptionExpired: 'Subscription expired',
    subscriptionRequired: 'This feature needs an active subscription',
    mcqRequiresSubscription: 'The question bank needs an active subscription',
    subscriptionActivated: 'Your subscription is active',

    payChoosePlan: 'Choose your plan',
    paySubscribe: 'Subscribe',
    payRenew: 'Renew',
    payUntil: 'Expires',
    payRestore: 'Restore purchases',
    payRestoring: 'Restoring…',
    payRestored: 'Your subscription has been restored',
    payNothingToRestore: 'No purchases to restore on this account',
    payManage: 'Manage subscription',
    payProcessing: 'Completing your purchase…',
    payVerifying: 'Verifying…',
    payThanks: 'Thank you! Your subscription is active',
    payCancelled: 'Purchase cancelled',
    payFailed: 'The purchase could not be completed',
    payDeferred: 'Waiting for approval',
    payUnavailable: 'The store is unavailable right now, please try again later',
    payAutoRenewNote: 'Subscriptions renew automatically unless turned off before the period ends.',
    payTerms: 'Terms of Use',
    payPrivacy: 'Privacy Policy',
  },
};
