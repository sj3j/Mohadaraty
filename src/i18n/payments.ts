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
    superkey: 'سوبر كي / كي كارد',
    payWithZaincash: 'ادفع عبر زين كاش',
    payWithSuperkey: 'ادفع عبر سوبر كي',
    superkeyInstructions: 'أرسل المبلغ إلى حساب سوبر كي / كي كارد التالي:',
    enterTransactionId: 'رقم العملية',
    submitPayment: 'تأكيد الدفع',
    totalRevenue: 'إجمالي الإيرادات',
    paymentMethodStats: 'إحصائيات طرق الدفع',
    iqd: 'دينار',
    paymentSuccessful: 'تم الدفع بنجاح!',
    paymentFailed: 'فشل الدفع',
    // ─── Manual (Super Qi / Qi Card) flow ───────────────────────────────
    contactUsToPay: 'تواصل معنا لإكمال الدفع',
    contactUsToPayHint: 'راسلنا على أحد الحسابات التالية وأرسل إشعار التحويل.',
    payWhatsapp: 'واتساب',
    payTelegram: 'تيليجرام',
    noPaymentContact: 'لم تُضَف بعد معلومات الدفع اليدوي. تواصل مع ممثل مرحلتك.',
    copyNumber: 'نسخ الرقم',
    payCopied: 'تم النسخ',
    paymentProof: 'إثبات الدفع',
    proofOneOfTwo: 'أرفق صورة الإشعار أو اكتب رقم العملية — واحد منهما يكفي.',
    attachReceipt: 'إرفاق صورة الإشعار',
    changeReceipt: 'تغيير الصورة',
    removeReceipt: 'إزالة الصورة',
    uploadingReceipt: 'جاري رفع الصورة...',
    receiptTooLarge: 'حجم الصورة كبير جداً (الحد 5 ميغابايت).',
    receiptWrongType: 'الملف ليس صورة. أرفق صورة PNG أو JPG.',
    receiptUploadFailed: 'تعذّر رفع الصورة. حاول مرة أخرى أو أرسل رقم العملية.',
    proofRequired: 'أرفق صورة الإشعار أو اكتب رقم العملية.',
    viewReceipt: 'عرض الإشعار',
    payOr: 'أو',
    // Admin editor for the details above.
    paymentContactSettings: 'معلومات الدفع اليدوي',
    paymentContactHint: 'يظهر هذا للطالب عند اختيار سوبر كي / كي كارد. يكفي واتساب أو تيليجرام — واحد منهما مطلوب.',
    walletNumberLabel: 'رقم سوبر كي / كي كارد',
    whatsappLabel: 'رقم واتساب',
    telegramLabel: 'حساب تيليجرام',
    paymentNoteLabel: 'ملاحظة (اختياري)',
    channelRequired: 'أضف واتساب أو تيليجرام على الأقل.',
    telegramInvalid: 'اسم مستخدم تيليجرام غير صالح (5-32 حرفاً، أحرف وأرقام و _ ).',
    whatsappInvalid: 'رقم واتساب غير صالح.',
    paySave: 'حفظ',
    paySaved: 'تم الحفظ',
    paySaveFailed: 'تعذّر الحفظ',
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
    // "SuperKey" was a mis-transliteration of سوبر كي - the product is Super Qi,
    // Qi Card's own wallet app. The stored paymentMethod stays 'superkey'
    // because live subscriptions carry it; only the label is corrected.
    superkey: 'Super Qi / Qi Card',
    payWithZaincash: 'Pay with ZainCash',
    payWithSuperkey: 'Pay with Super Qi',
    superkeyInstructions: 'Send the amount to this Super Qi / Qi Card account:',
    enterTransactionId: 'Transaction number',
    submitPayment: 'Confirm Payment',
    totalRevenue: 'Total Revenue',
    paymentMethodStats: 'Payment Method Stats',
    iqd: 'IQD',
    paymentSuccessful: 'Payment Successful!',
    paymentFailed: 'Payment Failed',
    // ─── Manual (Super Qi / Qi Card) flow ───────────────────────────────
    contactUsToPay: 'Contact us to complete the payment',
    contactUsToPayHint: 'Message one of these accounts and send the transfer receipt.',
    payWhatsapp: 'WhatsApp',
    payTelegram: 'Telegram',
    noPaymentContact: 'Manual payment details have not been added yet. Contact your stage representative.',
    copyNumber: 'Copy number',
    payCopied: 'Copied',
    paymentProof: 'Proof of payment',
    proofOneOfTwo: 'Attach the receipt screenshot or enter the transaction number — either one is enough.',
    attachReceipt: 'Attach receipt image',
    changeReceipt: 'Change image',
    removeReceipt: 'Remove image',
    uploadingReceipt: 'Uploading image...',
    receiptTooLarge: 'That image is too large (5 MB max).',
    receiptWrongType: 'That file is not an image. Attach a PNG or JPG.',
    receiptUploadFailed: 'Could not upload the image. Try again, or send the transaction number instead.',
    proofRequired: 'Attach the receipt image or enter the transaction number.',
    viewReceipt: 'View receipt',
    payOr: 'or',
    // Admin editor for the details above.
    paymentContactSettings: 'Manual payment details',
    paymentContactHint: 'Shown to students who choose Super Qi / Qi Card. WhatsApp or Telegram — at least one is required.',
    walletNumberLabel: 'Super Qi / Qi Card number',
    whatsappLabel: 'WhatsApp number',
    telegramLabel: 'Telegram username',
    paymentNoteLabel: 'Note (optional)',
    channelRequired: 'Add a WhatsApp number or a Telegram username.',
    telegramInvalid: 'Not a valid Telegram username (5-32 of letters, digits, _).',
    whatsappInvalid: 'Not a valid WhatsApp number.',
    paySave: 'Save',
    paySaved: 'Saved',
    paySaveFailed: 'Could not save',
  },
};
