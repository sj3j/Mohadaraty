/**
 * Every string that names a way to hand over real money.
 *
 * Split out of TRANSLATIONS so the native build can drop it. Google Play and
 * the App Store enforce their payments policy by SCANNING the uploaded
 * artefact, not by using the app - so a runtime `if (!IS_STORE_BUILD)` that
 * merely hides a button still ships "ZainCash", "Pay with ZainCash" and "IQD"
 * inside the binary for a static scan to find. scripts/assert-no-payment-surface.mjs
 * is what proves they are gone, and it was failing on exactly these keys.
 *
 * vite.config.ts aliases this module to src/native-stubs/payments.ts when
 * mode === 'native', so the literals never enter the native graph at all.
 *
 * Only keys used SOLELY by the purchase UI belong here.
 *
 * That used to exclude "subscription required" / "ask your representative" /
 * "subscription active", because the native stubs rendered them to explain why
 * content was locked. They no longer do: the stubs were rewritten to speak in
 * ACCESS terms (accessStatus / accessActive / accessManagedByRep, which live in
 * src/types.ts) precisely so a store build never says "subscription" at all.
 * With no native consumer left, the whole subscription vocabulary moved here
 * and now leaves the native graph with everything else.
 */

export const PAYMENT_STRINGS = {
  ar: {
    subscription: 'اشتراك',
    subscriptionPlans: 'خطط الاشتراك',
    subscriptionActive: 'الاشتراك فعال',
    subscriptionExpired: 'الاشتراك منتهي',
    subscriptionPending: 'بانتظار التأكيد',
    subscriptionRequired: 'يتطلب اشتراك',
    mcqRequiresSubscription: 'ميزة الأسئلة تتطلب اشتراكاً فعالاً',
    askRepresentative: 'اطلب من الممثل تفعيل الميزة',
    subscriptionActivated: 'تم تفعيل الاشتراك!',
    manageSubscriptions: 'إدارة الاشتراكات',
    totalSubscribers: 'إجمالي المشتركين',
    pricePerMonth: 'دينار/شهر',
    choosePayment: 'اختر طريقة الدفع',
    zaincash: 'زين كاش',
    superkey: 'سوبر كي',
    payWithZaincash: 'ادفع عبر زين كاش',
    payWithSuperkey: 'ادفع عبر سوبر كي',
    superkeyInstructions: 'أرسل المبلغ إلى رقم سوبر كي التالي:',
    enterTransactionId: 'أدخل رقم العملية',
    submitPayment: 'تأكيد الدفع',
    totalRevenue: 'إجمالي الإيرادات',
    paymentMethodStats: 'إحصائيات طرق الدفع',
    iqd: 'دينار',
    paymentSuccessful: 'تم الدفع بنجاح!',
    paymentFailed: 'فشل الدفع',
  },
  en: {
    subscription: 'Subscription',
    subscriptionPlans: 'Subscription Plans',
    subscriptionActive: 'Subscription Active',
    subscriptionExpired: 'Subscription Expired',
    subscriptionPending: 'Pending Confirmation',
    subscriptionRequired: 'Subscription Required',
    mcqRequiresSubscription: 'MCQ feature requires an active subscription',
    askRepresentative: 'Ask your representative to activate this feature',
    subscriptionActivated: 'Subscription Activated!',
    manageSubscriptions: 'Manage Subscriptions',
    totalSubscribers: 'Total Subscribers',
    pricePerMonth: 'IQD/mo',
    choosePayment: 'Choose Payment Method',
    zaincash: 'ZainCash',
    superkey: 'SuperKey',
    payWithZaincash: 'Pay with ZainCash',
    payWithSuperkey: 'Pay with SuperKey',
    superkeyInstructions: 'Send the amount to the following SuperKey number:',
    enterTransactionId: 'Enter Transaction ID',
    submitPayment: 'Confirm Payment',
    totalRevenue: 'Total Revenue',
    paymentMethodStats: 'Payment Method Stats',
    iqd: 'IQD',
    paymentSuccessful: 'Payment Successful!',
    paymentFailed: 'Payment Failed',
  },
};
