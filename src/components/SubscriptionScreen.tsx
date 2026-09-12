import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Crown, Clock, CreditCard, CheckCircle2, XCircle, AlertCircle,
  Loader2, ChevronLeft, ChevronRight, Sparkles, Shield, ArrowRight,
  MessageSquare, Send, Copy, Check, ImagePlus, Trash2
} from 'lucide-react';
import { Language, TRANSLATIONS, PLAN_CONFIG, SubscriptionPlan, Subscription, UserProfile } from '../types';
import { IS_STORE_BUILD } from '../lib/platform';
import {
  EMPTY_PAYMENT_CONTACT, PaymentContact, RECEIPT_ACCEPT,
  checkReceiptFile, hasPaymentChannel, isProofSufficient,
  telegramUrl, whatsappUrl,
} from '../lib/paymentContact';
import {
  onUserSubscriptions, createPendingSubscription, initiateZainCashPayment,
  onPaymentContact, uploadPaymentReceipt,
  getRemainingDays, formatSubscriptionDate
} from '../services/subscriptionService';

interface SubscriptionScreenProps {
  user: UserProfile;
  lang: Language;
}

type PaymentMethod = 'zaincash' | 'superkey';
type ViewState = 'plans' | 'payment' | 'superkey_form' | 'success' | 'pending';

export default function SubscriptionScreen({ user, lang }: SubscriptionScreenProps) {
  const isRtl = lang === 'ar';
  const t = TRANSLATIONS[lang];

  const [selectedPlan, setSelectedPlan] = useState<SubscriptionPlan>('seasonal');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('zaincash');
  const [viewState, setViewState] = useState<ViewState>('plans');
  const [superkeyRef, setSuperkeyRef] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  /** Who to message, and where the transfer goes. Empty until it loads. */
  const [contact, setContact] = useState<PaymentContact>(EMPTY_PAYMENT_CONTACT);
  /** The chosen receipt, not yet uploaded - the upload happens on submit so an
   *  abandoned form leaves no orphan object in the bucket. */
  const [receipt, setReceipt] = useState<{ file: File; preview: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const receiptInputRef = useRef<HTMLInputElement>(null);

  // Listen for user's subscriptions
  useEffect(() => {
    const unsub = onUserSubscriptions(user.uid, setSubscriptions);
    return unsub;
  }, [user.uid]);

  // The seller's own WhatsApp / Telegram / wallet number, live so a change in
  // Subscription Management reaches a student who already has this screen open.
  useEffect(() => onPaymentContact(setContact), []);

  // Object URLs are not garbage collected. Revoking in the cleanup releases the
  // PREVIOUS preview when the student picks a different image, and the last one
  // when they leave the screen.
  useEffect(() => {
    if (!receipt) return;
    return () => URL.revokeObjectURL(receipt.preview);
  }, [receipt]);

  // Return leg of a ZainCash payment. The server has already verified the
  // gateway JWT and confirmed the transaction via the Inquiry API before
  // granting anything, so this only reflects the outcome.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const payment = params.get('payment');
    if (!payment) return;

    if (payment === 'success') {
      setViewState('success');
    } else if (payment === 'pending') {
      setViewState('pending');
    } else {
      const reason = params.get('reason');
      setError(reason ? `${t.paymentFailed} (${reason})` : t.paymentFailed);
    }

    // Drop the query so a refresh does not replay the result.
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  const activeSubscription = subscriptions.find(s => s.status === 'active');
  const pendingSubscription = subscriptions.find(s => s.status === 'pending');
  const remainingDays = activeSubscription ? getRemainingDays(activeSubscription.endDate) : 0;

  const handleZainCashPayment = async () => {
    setIsProcessing(true);
    setError(null);
    try {
      const redirectUrl = await initiateZainCashPayment(selectedPlan, lang);
      window.location.href = redirectUrl;
    } catch (err: any) {
      setError(err.message || t.paymentFailed);
      setIsProcessing(false);
    }
  };

  const handleReceiptPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Cleared so re-picking the same file still fires a change event.
    e.target.value = '';
    if (!file) return;
    const problem = checkReceiptFile(file);
    if (problem) {
      setError(problem === 'size' ? t.receiptTooLarge : t.receiptWrongType);
      return;
    }
    setError(null);
    setReceipt({ file, preview: URL.createObjectURL(file) });
  };

  const handleCopyNumber = async () => {
    try {
      await navigator.clipboard.writeText(contact.walletNumber);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard on an insecure origin or inside some in-app browsers. The
      // number is on screen and selectable regardless, so this is not an error
      // worth showing.
    }
  };

  /**
   * Submit a manual transfer for review.
   *
   * The proof is a screenshot OR the transaction number - isProofSufficient()
   * is the same rule the submit button is disabled by and the service re-checks.
   */
  const handleSuperkeySubmit = async () => {
    const reference = superkeyRef.trim();
    if (!isProofSufficient(reference, !!receipt)) {
      setError(t.proofRequired);
      return;
    }
    setIsProcessing(true);
    setError(null);
    try {
      let uploaded: { url: string; path: string } | null = null;
      if (receipt) {
        setIsUploading(true);
        try {
          uploaded = await uploadPaymentReceipt(user.uid, receipt.file);
        } catch {
          // A failed upload must not throw away a reference the student has
          // already typed - either half is enough for an admin to match the
          // transfer. With nothing else to send, the upload IS the submission.
          if (!reference) throw new Error(t.receiptUploadFailed);
        } finally {
          setIsUploading(false);
        }
      }
      await createPendingSubscription(
        user.uid, user.email, user.name, selectedPlan,
        {
          transactionId: reference || undefined,
          receiptUrl: uploaded?.url,
          receiptPath: uploaded?.path,
        },
      );
      setViewState('pending');
    } catch (err: any) {
      setError(err?.message === 'NO_PAYMENT_PROOF' ? t.proofRequired : (err?.message || t.paymentFailed));
    } finally {
      setIsProcessing(false);
    }
  };

  const plans: { key: SubscriptionPlan; badge?: string; highlight?: boolean }[] = [
    { key: 'monthly' },
    { key: 'seasonal', badge: t.popular, highlight: true },
    { key: 'semi_annual', badge: t.bestValue },
  ];

  const statusIcons: Record<string, React.ReactNode> = {
    active: <CheckCircle2 className="w-4 h-4 text-emerald-500" />,
    pending: <AlertCircle className="w-4 h-4 text-amber-500" />,
    inactive: <XCircle className="w-4 h-4 text-slate-400" />,
    cancelled: <XCircle className="w-4 h-4 text-red-500" />,
  };

  const statusLabels: Record<string, string> = {
    active: t.subscriptionActive,
    pending: t.subscriptionPending,
    inactive: t.subscriptionExpired,
    cancelled: isRtl ? 'ملغي' : 'Cancelled',
  };

  const planLabels: Record<string, string> = {
    monthly: t.monthly,
    seasonal: t.seasonal,
    semi_annual: t.semiAnnual,
  };

  const paymentLabels: Record<string, string> = {
    zaincash: t.zaincash,
    superkey: t.superkey,
    admin_grant: t.adminGrant,
  };

  /**
   * What the WhatsApp button hands over.
   *
   * The seller has to match a transfer in their wallet history to an account in
   * this app, and the three things that make that possible - who, which plan,
   * how much - are exactly what a student retypes wrong. Telegram drops
   * prefilled text on a direct chat, so that button carries none.
   */
  const contactMessage = [
    isRtl ? 'مرحباً، أريد تفعيل اشتراك في تطبيق محاضراتي.' : 'Hello, I would like to activate a subscription in Mohadaraty.',
    `${isRtl ? 'الاسم' : 'Name'}: ${user.name || user.email}`,
    `${isRtl ? 'الخطة' : 'Plan'}: ${planLabels[selectedPlan]}`,
    `${isRtl ? 'المبلغ' : 'Amount'}: ${PLAN_CONFIG[selectedPlan].price.toLocaleString()} ${t.iqd}`,
  ].join('\n');

  const proofReady = isProofSufficient(superkeyRef, !!receipt);

  return (
    <div className="max-w-lg mx-auto px-4 pt-4" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Active Subscription Banner */}
      {activeSubscription && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6 p-5 rounded-3xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg shadow-emerald-500/20"
        >
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-xl bg-white/20">
              <Crown className="w-6 h-6" />
            </div>
            <div>
              <h3 className="font-bold text-lg">{t.subscriptionActive}</h3>
              <p className="text-emerald-100 text-sm">{planLabels[activeSubscription.plan]}</p>
            </div>
          </div>
          <div className="flex items-center justify-between mt-2 pt-3 border-t border-white/20">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-emerald-200" />
              <span className="text-sm text-emerald-100">
                {remainingDays} {t.daysRemaining}
              </span>
            </div>
            <span className="text-sm text-emerald-100">
              {t.expiresOn}: {formatSubscriptionDate(activeSubscription.endDate)}
            </span>
          </div>
        </motion.div>
      )}

      {/* Pending Banner */}
      {pendingSubscription && !activeSubscription && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6 p-5 rounded-3xl bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-lg"
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-white/20 animate-pulse">
              <AlertCircle className="w-6 h-6" />
            </div>
            <div>
              <h3 className="font-bold">{t.pendingApproval}</h3>
              <p className="text-amber-100 text-sm mt-1">
                {isRtl ? 'سيتم تفعيل اشتراكك بعد التأكد من الدفع' : 'Your subscription will be activated after payment verification'}
              </p>
            </div>
          </div>
        </motion.div>
      )}

      {/* Plan Selection */}
      <AnimatePresence mode="wait">
        {(viewState === 'plans' || viewState === 'payment' || viewState === 'superkey_form') && (
          <motion.div
            key="plans"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {/* Header */}
            <div className="text-center mb-6">
              <h2 className="text-xl font-bold text-slate-900 dark:text-white">{t.subscriptionPlans}</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                {isRtl ? 'اختر الخطة المناسبة لك' : 'Choose the plan that suits you'}
              </p>
            </div>

            {/* Plan Cards */}
            <div className="space-y-3 mb-8">
              {plans.map((plan, index) => {
                const config = PLAN_CONFIG[plan.key];
                const label = isRtl ? config.labelAr : config.labelEn;
                const isSelected = selectedPlan === plan.key;
                const perMonth = Math.round(config.price / (config.days / 30));
                
                return (
                  <motion.button
                    key={plan.key}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.05 * index }}
                    onClick={() => setSelectedPlan(plan.key)}
                    className={`relative w-full p-4 rounded-2xl border-2 text-right rtl:text-right transition-all ${
                      isSelected
                        ? plan.highlight
                          ? 'border-orange-400 bg-orange-50 dark:bg-orange-950/30 dark:border-orange-500 shadow-lg shadow-orange-500/10 ring-2 ring-orange-400/30'
                          : 'border-sky-400 bg-sky-50 dark:bg-sky-950/30 dark:border-sky-500 shadow-lg shadow-sky-500/10 ring-2 ring-sky-400/30'
                        : 'border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:border-slate-300 dark:hover:border-zinc-600'
                    }`}
                  >
                    {plan.badge && (
                      <span className={`absolute -top-2.5 ${isRtl ? 'right-4' : 'left-4'} px-3 py-0.5 rounded-full text-[11px] font-bold text-white ${
                        plan.key === 'semi_annual'
                          ? 'bg-gradient-to-r from-emerald-500 to-teal-500'
                          : 'bg-gradient-to-r from-orange-500 to-rose-500'
                      }`}>
                        {plan.badge}
                      </span>
                    )}
                    
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
                          isSelected
                            ? plan.highlight
                              ? 'border-orange-500 bg-orange-500'
                              : 'border-sky-500 bg-sky-500'
                            : 'border-slate-300 dark:border-zinc-600'
                        }`}>
                          {isSelected && <div className="w-2 h-2 rounded-full bg-white" />}
                        </div>
                        <div>
                          <h3 className="font-bold text-base text-slate-900 dark:text-white">{label}</h3>
                          <div className="flex items-center gap-1.5 mt-0.5 text-slate-500 dark:text-slate-400 text-xs">
                            <Clock className="w-3 h-3" />
                            <span>{config.days} {t.days}</span>
                            {config.days > 30 && (
                              <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                                ({perMonth.toLocaleString()} {t.pricePerMonth})
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="text-left rtl:text-right">
                        <span className="text-xl font-extrabold text-slate-900 dark:text-white">
                          {config.price.toLocaleString()}
                        </span>
                        <span className="text-xs text-slate-500 dark:text-slate-400"> {t.iqd}</span>
                      </div>
                    </div>
                  </motion.button>
                );
              })}
            </div>

            {/* Payment Section */}
            {!IS_STORE_BUILD && (
              <>
                {viewState === 'plans' && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                    <h3 className="font-bold text-slate-900 dark:text-white mb-3">{t.choosePayment}</h3>
                    <div className="grid grid-cols-2 gap-3 mb-4">
                      {(['zaincash', 'superkey'] as PaymentMethod[]).map(method => (
                        <button
                          key={method}
                          onClick={() => setPaymentMethod(method)}
                          className={`p-4 rounded-2xl border-2 transition-all text-center ${
                            paymentMethod === method
                              ? 'border-sky-400 bg-sky-50 dark:bg-sky-950/30 dark:border-sky-500'
                              : 'border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800'
                          }`}
                        >
                          <CreditCard className={`w-6 h-6 mx-auto mb-2 ${
                            paymentMethod === method ? 'text-sky-500' : 'text-slate-400'
                          }`} />
                          <span className={`text-sm font-medium ${
                            paymentMethod === method ? 'text-sky-700 dark:text-sky-300' : 'text-slate-600 dark:text-slate-400'
                          }`}>
                            {method === 'zaincash' ? t.zaincash : t.superkey}
                          </span>
                        </button>
                      ))}
                    </div>

                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => {
                        if (paymentMethod === 'zaincash') {
                          handleZainCashPayment();
                        } else {
                          setViewState('superkey_form');
                        }
                      }}
                      disabled={isProcessing}
                      className="w-full py-4 rounded-2xl bg-gradient-to-r from-sky-500 to-blue-600 text-white font-bold text-base shadow-lg shadow-sky-500/30 hover:shadow-sky-500/50 transition-all disabled:opacity-60 flex items-center justify-center gap-2"
                    >
                      {isProcessing ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                        <>
                          {paymentMethod === 'zaincash' ? t.payWithZaincash : t.payWithSuperkey}
                          {isRtl ? <ChevronLeft className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                        </>
                      )}
                    </motion.button>
                  </motion.div>
                )}

                {/* Super Qi / Qi Card: a manual transfer, reviewed by a human */}
                {viewState === 'superkey_form' && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="space-y-4"
                  >
                    <button
                      onClick={() => setViewState('plans')}
                      className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 mb-2"
                    >
                      {isRtl ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
                      {isRtl ? 'رجوع' : 'Back'}
                    </button>

                    {/* Where the money goes. Rendered only when a number is
                        actually configured - this block used to print the
                        literal placeholder 07XXXXXXXXX to every student. */}
                    {contact.walletNumber && (
                      <div className="p-4 rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
                        <p className="text-sm text-amber-800 dark:text-amber-200 font-medium mb-2">
                          {t.superkeyInstructions}
                        </p>
                        <p className="text-2xl font-bold text-amber-900 dark:text-amber-100 font-mono tracking-wider text-center py-2 select-all" dir="ltr">
                          {contact.walletNumber}
                        </p>
                        <div className="flex justify-center">
                          <button
                            onClick={handleCopyNumber}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 text-xs font-medium hover:bg-amber-200 dark:hover:bg-amber-900/70 transition-colors"
                          >
                            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                            {copied ? t.payCopied : t.copyNumber}
                          </button>
                        </div>
                        {contact.note && (
                          <p className="text-xs text-amber-700 dark:text-amber-300 text-center mt-2">{contact.note}</p>
                        )}
                        <p className="text-xs text-amber-600 dark:text-amber-400 text-center mt-2">
                          {isRtl ? `المبلغ: ${PLAN_CONFIG[selectedPlan].price.toLocaleString()} ${t.iqd}` : `Amount: ${PLAN_CONFIG[selectedPlan].price.toLocaleString()} ${t.iqd}`}
                        </p>
                      </div>
                    )}

                    {/* A human to talk to. WhatsApp, Telegram, or whichever one
                        of the two is configured - a transfer nobody can query
                        needs somebody to confirm it. */}
                    {hasPaymentChannel(contact) ? (
                      <div className="p-4 rounded-2xl bg-sky-50 dark:bg-sky-950/30 border border-sky-200 dark:border-sky-800">
                        <p className="text-sm font-medium text-sky-900 dark:text-sky-200">{t.contactUsToPay}</p>
                        <p className="text-xs text-sky-700 dark:text-sky-400 mt-1">{t.contactUsToPayHint}</p>
                        <div className={`grid gap-2 mt-3 ${contact.whatsapp && contact.telegram ? 'grid-cols-2' : 'grid-cols-1'}`}>
                          {contact.whatsapp && (
                            <a
                              href={whatsappUrl(contact, contactMessage)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center justify-center gap-2 py-3 rounded-xl bg-emerald-500 text-white text-sm font-bold shadow-sm shadow-emerald-500/30 hover:bg-emerald-600 transition-colors"
                            >
                              <MessageSquare className="w-4 h-4" />
                              {t.payWhatsapp}
                            </a>
                          )}
                          {contact.telegram && (
                            <a
                              href={telegramUrl(contact)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center justify-center gap-2 py-3 rounded-xl bg-sky-500 text-white text-sm font-bold shadow-sm shadow-sky-500/30 hover:bg-sky-600 transition-colors"
                            >
                              <Send className="w-4 h-4" />
                              {t.payTelegram}
                            </a>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="p-4 rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                        <p className="text-sm text-amber-800 dark:text-amber-200">{t.noPaymentContact}</p>
                      </div>
                    )}

                    {/* Proof: a screenshot OR the transaction number. Either
                        one submits; demanding the number is what used to leave
                        a student who had already paid with no way forward. */}
                    <div className="space-y-3">
                      <div>
                        <h4 className="text-sm font-bold text-slate-900 dark:text-white">{t.paymentProof}</h4>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{t.proofOneOfTwo}</p>
                      </div>

                      <input
                        ref={receiptInputRef}
                        type="file"
                        accept={RECEIPT_ACCEPT}
                        onChange={handleReceiptPick}
                        className="hidden"
                      />

                      {receipt ? (
                        <div className="flex items-center gap-3 p-3 rounded-2xl border-2 border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30">
                          <img
                            src={receipt.preview}
                            alt=""
                            className="w-14 h-14 rounded-xl object-cover flex-shrink-0 bg-white"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-slate-900 dark:text-white truncate">{receipt.file.name}</p>
                            <button
                              onClick={() => receiptInputRef.current?.click()}
                              className="text-xs text-sky-600 dark:text-sky-400 font-medium hover:underline mt-0.5"
                            >
                              {t.changeReceipt}
                            </button>
                          </div>
                          <button
                            onClick={() => setReceipt(null)}
                            title={t.removeReceipt}
                            aria-label={t.removeReceipt}
                            className="p-2 rounded-xl text-red-500 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors flex-shrink-0"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => receiptInputRef.current?.click()}
                          className="w-full py-4 rounded-2xl border-2 border-dashed border-slate-300 dark:border-zinc-600 text-slate-600 dark:text-slate-300 text-sm font-medium hover:border-sky-400 hover:text-sky-600 dark:hover:text-sky-400 transition-colors flex items-center justify-center gap-2"
                        >
                          <ImagePlus className="w-5 h-5" />
                          {t.attachReceipt}
                        </button>
                      )}

                      <div className="flex items-center gap-3">
                        <div className="h-px flex-1 bg-slate-200 dark:bg-zinc-700" />
                        <span className="text-xs text-slate-400">{t.payOr}</span>
                        <div className="h-px flex-1 bg-slate-200 dark:bg-zinc-700" />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                          {t.enterTransactionId}
                        </label>
                        <input
                          type="text"
                          value={superkeyRef}
                          onChange={(e) => setSuperkeyRef(e.target.value)}
                          placeholder={isRtl ? 'رقم العملية...' : 'Transaction reference...'}
                          className="w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-900 dark:text-white placeholder-slate-400 focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20 outline-none transition-all"
                        />
                      </div>
                    </div>

                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={handleSuperkeySubmit}
                      disabled={isProcessing || !proofReady}
                      className="w-full py-4 rounded-2xl bg-gradient-to-r from-amber-500 to-orange-500 text-white font-bold text-base shadow-lg shadow-amber-500/30 disabled:opacity-60 flex items-center justify-center gap-2"
                    >
                      {isProcessing ? (
                        <>
                          <Loader2 className="w-5 h-5 animate-spin" />
                          {isUploading && <span className="text-sm">{t.uploadingReceipt}</span>}
                        </>
                      ) : (
                        <>
                          {t.submitPayment}
                          <ArrowRight className="w-5 h-5 rtl:rotate-180" />
                        </>
                      )}
                    </motion.button>

                    {!proofReady && (
                      <p className="text-xs text-slate-400 text-center">{t.proofRequired}</p>
                    )}
                  </motion.div>
                )}
              </>
            )}

            {/* Store build message */}
            {IS_STORE_BUILD && (
              <div className="text-center py-6 px-4 rounded-2xl bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-slate-300">
                <Shield className="w-8 h-8 mx-auto mb-3 text-slate-400" />
                <p className="font-medium">{t.askRepresentative}</p>
              </div>
            )}

            {/* Error */}
            {error && (
              <motion.div
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-4 p-3 rounded-xl bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 text-sm text-center"
              >
                {error}
              </motion.div>
            )}
          </motion.div>
        )}

        {/* Success View */}
        {viewState === 'success' && (
          <motion.div
            key="success"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center py-8"
          >
            <motion.div
              animate={{ scale: [1, 1.1, 1] }}
              transition={{ repeat: Infinity, duration: 2 }}
              className="inline-flex p-4 rounded-3xl bg-emerald-100 dark:bg-emerald-900/30 mb-4"
            >
              <CheckCircle2 className="w-12 h-12 text-emerald-500" />
            </motion.div>
            <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">
              {t.subscriptionActivated}
            </h2>
          </motion.div>
        )}

        {/* Pending View */}
        {viewState === 'pending' && (
          <motion.div
            key="pending"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center py-8"
          >
            <motion.div
              animate={{ rotate: [0, 5, -5, 0] }}
              transition={{ repeat: Infinity, duration: 3 }}
              className="inline-flex p-4 rounded-3xl bg-amber-100 dark:bg-amber-900/30 mb-4"
            >
              <AlertCircle className="w-12 h-12 text-amber-500" />
            </motion.div>
            <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">
              {t.pendingApproval}
            </h2>
            <p className="text-slate-500 dark:text-slate-400 text-sm">
              {isRtl ? 'سيتم تفعيل اشتراكك بعد التأكد من الدفع' : 'Your subscription will be activated after payment verification'}
            </p>
            <button
              onClick={() => setViewState('plans')}
              className="mt-6 px-6 py-2 rounded-xl bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-slate-300 text-sm hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
            >
              {isRtl ? 'رجوع' : 'Back'}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Transaction History */}
      {subscriptions.length > 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="mt-8"
        >
          <h3 className="font-bold text-slate-900 dark:text-white mb-3">{t.transactionHistory}</h3>
          <div className="space-y-2">
            {subscriptions.map((sub) => (
              <div
                key={sub.id}
                className="p-3.5 rounded-2xl bg-white dark:bg-zinc-800 border border-slate-100 dark:border-zinc-700 flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  {statusIcons[sub.status]}
                  <div>
                    <p className="text-sm font-medium text-slate-900 dark:text-white">
                      {planLabels[sub.plan]} — {sub.amount > 0 ? `${sub.amount.toLocaleString()} ${t.iqd}` : t.adminGrant}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {paymentLabels[sub.paymentMethod]} • {formatSubscriptionDate(sub.createdAt)}
                    </p>
                  </div>
                </div>
                <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                  sub.status === 'active' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' :
                  sub.status === 'pending' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' :
                  'bg-slate-100 text-slate-500 dark:bg-zinc-700 dark:text-slate-400'
                }`}>
                  {statusLabels[sub.status]}
                </span>
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </div>
  );
}
