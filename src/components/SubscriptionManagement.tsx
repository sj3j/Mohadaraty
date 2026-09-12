import React, { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X, Crown, Users, CreditCard, DollarSign, Clock, CheckCircle2, XCircle,
  AlertCircle, Search, ChevronDown, ChevronUp, Loader2, Gift, Plus,
  TrendingUp, Calendar, ArrowRight, Paperclip, MessageSquare, Send, Check
} from 'lucide-react';
import { Language, TRANSLATIONS, PLAN_CONFIG, SubscriptionPlan, Subscription, UserProfile } from '../types';
import {
  onAllSubscriptions, approveSubscription, rejectSubscription,
  extendSubscription, cancelSubscription, grantSubscription,
  onPaymentContact, savePaymentContact,
  getRemainingDays, formatSubscriptionDate
} from '../services/subscriptionService';
import {
  EMPTY_PAYMENT_CONTACT, PaymentContact,
  hasPaymentChannel, normalizePaymentContact, normalizeTelegram, normalizeWhatsapp,
} from '../lib/paymentContact';
import { db } from '../lib/firebase';
import { collection, getDocs } from 'firebase/firestore';

interface SubscriptionManagementProps {
  user: UserProfile;
  lang: Language;
  onClose: () => void;
}

export default function SubscriptionManagement({ user, lang, onClose }: SubscriptionManagementProps) {
  const isRtl = lang === 'ar';
  const t = TRANSLATIONS[lang];

  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterPlan, setFilterPlan] = useState<string>('all');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showGrantModal, setShowGrantModal] = useState(false);
  const [showExtendModal, setShowExtendModal] = useState<string | null>(null);
  const [extendDays, setExtendDays] = useState(30);
  const [grantUserId, setGrantUserId] = useState('');
  const [grantPlan, setGrantPlan] = useState<SubscriptionPlan>('monthly');
  const [grantNotes, setGrantNotes] = useState('');
  const [allUsers, setAllUsers] = useState<{ uid: string; name: string; email: string }[]>([]);
  const [userSearch, setUserSearch] = useState('');
  /** Draft of settings/payment_contact - what a student sees on the manual
   *  (Super Qi / Qi Card) form. */
  const [contactDraft, setContactDraft] = useState<PaymentContact>(EMPTY_PAYMENT_CONTACT);
  const [contactSave, setContactSave] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  /** The live listener must not overwrite what an admin is typing, so the
   *  stored values seed the draft once and never again. */
  const contactSeeded = useRef(false);

  useEffect(() => {
    const unsub = onAllSubscriptions(setSubscriptions);
    return unsub;
  }, []);

  useEffect(() => onPaymentContact(contact => {
    if (contactSeeded.current) return;
    contactSeeded.current = true;
    setContactDraft(contact);
  }), []);

  // Load all users for grant modal
  useEffect(() => {
    if (showGrantModal && allUsers.length === 0) {
      getDocs(collection(db, 'users')).then(snap => {
        const users = snap.docs.map(d => ({
          uid: d.id,
          name: d.data().name || '',
          email: d.data().email || '',
        }));
        setAllUsers(users);
      });
    }
  }, [showGrantModal]);

  // Stats
  const stats = useMemo(() => {
    const active = subscriptions.filter(s => s.status === 'active');
    const pending = subscriptions.filter(s => s.status === 'pending');
    const totalRevenue = subscriptions
      .filter(s => s.status === 'active' || s.status === 'inactive')
      .reduce((sum, s) => sum + (s.amount || 0), 0);
    
    const byPlan = {
      monthly: active.filter(s => s.plan === 'monthly').length,
      seasonal: active.filter(s => s.plan === 'seasonal').length,
      semi_annual: active.filter(s => s.plan === 'semi_annual').length,
    };

    const byPayment = {
      zaincash: subscriptions.filter(s => s.paymentMethod === 'zaincash' && (s.status === 'active' || s.status === 'inactive')),
      superkey: subscriptions.filter(s => s.paymentMethod === 'superkey' && (s.status === 'active' || s.status === 'inactive')),
      admin_grant: subscriptions.filter(s => s.paymentMethod === 'admin_grant'),
    };

    return { active: active.length, pending: pending.length, totalRevenue, byPlan, byPayment };
  }, [subscriptions]);

  // Filtered list
  const filtered = useMemo(() => {
    return subscriptions.filter(s => {
      if (filterStatus !== 'all' && s.status !== filterStatus) return false;
      if (filterPlan !== 'all' && s.plan !== filterPlan) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return (
          (s.userEmail || '').toLowerCase().includes(q) ||
          (s.userName || '').toLowerCase().includes(q) ||
          (s.transactionId || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [subscriptions, filterStatus, filterPlan, searchQuery]);

  const handleAction = async (action: () => Promise<void>, id: string) => {
    setActionLoading(id);
    try {
      await action();
    } catch (err) {
      console.error(err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleGrant = async () => {
    if (!grantUserId) return;
    setActionLoading('grant');
    try {
      await grantSubscription(grantUserId, grantPlan, grantNotes || undefined);
      setShowGrantModal(false);
      setGrantUserId('');
      setGrantNotes('');
    } catch (err) {
      console.error(err);
    } finally {
      setActionLoading(null);
    }
  };

  // Normalised here as well as on save so the admin is told about a bad entry
  // before they commit it: a local 07xx number would otherwise be stored, and a
  // wa.me link built from it opens WhatsApp's "invalid number" page.
  const contactPreview = normalizePaymentContact(contactDraft);
  const whatsappBad = !!contactDraft.whatsapp.trim() && !contactPreview.whatsapp;
  const telegramBad = !!contactDraft.telegram.trim() && !contactPreview.telegram;
  const channelMissing = !hasPaymentChannel(contactPreview);

  const handleSaveContact = async () => {
    setContactSave('saving');
    try {
      await savePaymentContact(contactDraft);
      // Show what students will actually get: 07xx rewritten to 9647xx, a
      // pasted t.me link reduced to the username.
      setContactDraft(normalizePaymentContact(contactDraft));
      setContactSave('saved');
      window.setTimeout(() => setContactSave(cur => (cur === 'saved' ? 'idle' : cur)), 2000);
    } catch (err) {
      console.error(err);
      setContactSave('error');
    }
  };

  const handleExtend = async (subId: string) => {
    setActionLoading(subId);
    try {
      await extendSubscription(subId, extendDays);
      setShowExtendModal(null);
    } catch (err) {
      console.error(err);
    } finally {
      setActionLoading(null);
    }
  };

  const planLabel = (plan: string) => {
    const labels: Record<string, string> = {
      monthly: t.monthly, seasonal: t.seasonal, semi_annual: t.semiAnnual,
    };
    return labels[plan] || plan;
  };

  const paymentLabel = (method: string) => {
    const labels: Record<string, string> = {
      zaincash: t.zaincash, superkey: t.superkey, admin_grant: t.adminGrant,
    };
    return labels[method] || method;
  };

  const statusColors: Record<string, string> = {
    active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    inactive: 'bg-slate-100 text-slate-500 dark:bg-zinc-700 dark:text-slate-400',
    cancelled: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  };

  const filteredUsers = allUsers.filter(u =>
    !userSearch || u.name.toLowerCase().includes(userSearch.toLowerCase()) || u.email.toLowerCase().includes(userSearch.toLowerCase())
  ).slice(0, 20);

  return (
    <div className="fixed inset-0 z-50 bg-slate-50 dark:bg-zinc-950 overflow-y-auto" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-xl border-b border-slate-200 dark:border-zinc-800 px-4 pt-[max(env(safe-area-inset-top),0.75rem)] pb-3 flex items-center justify-between">
        <h1 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Crown className="w-5 h-5 text-amber-500" />
          {t.manageSubscriptions}
        </h1>
        <button onClick={onClose} className="p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors">
          <X className="w-5 h-5 text-slate-500" />
        </button>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-6 pb-24">
        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {[
            { label: t.activeSubscribers, value: stats.active, icon: Users, color: 'from-emerald-500 to-teal-500', iconBg: 'bg-emerald-100 dark:bg-emerald-900/30', iconColor: 'text-emerald-600 dark:text-emerald-400' },
            { label: t.pendingPayments, value: stats.pending, icon: AlertCircle, color: 'from-amber-500 to-orange-500', iconBg: 'bg-amber-100 dark:bg-amber-900/30', iconColor: 'text-amber-600 dark:text-amber-400' },
            { label: t.totalRevenue, value: `${stats.totalRevenue.toLocaleString()} ${t.iqd}`, icon: DollarSign, color: 'from-sky-500 to-blue-500', iconBg: 'bg-sky-100 dark:bg-sky-900/30', iconColor: 'text-sky-600 dark:text-sky-400' },
            { label: t.totalSubscribers, value: subscriptions.length, icon: TrendingUp, color: 'from-violet-500 to-purple-500', iconBg: 'bg-violet-100 dark:bg-violet-900/30', iconColor: 'text-violet-600 dark:text-violet-400' },
          ].map((stat, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 * i }}
              className="p-4 rounded-2xl bg-white dark:bg-zinc-800 border border-slate-100 dark:border-zinc-700 shadow-sm"
            >
              <div className={`inline-flex p-2 rounded-xl ${stat.iconBg} mb-2`}>
                <stat.icon className={`w-4 h-4 ${stat.iconColor}`} />
              </div>
              <p className="text-2xl font-bold text-slate-900 dark:text-white">{stat.value}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{stat.label}</p>
            </motion.div>
          ))}
        </div>

        {/* Breakdown Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
          {/* By Plan */}
          <div className="p-4 rounded-2xl bg-white dark:bg-zinc-800 border border-slate-100 dark:border-zinc-700">
            <h3 className="font-bold text-sm text-slate-900 dark:text-white mb-3">{t.subscriberBreakdown}</h3>
            <div className="space-y-2">
              {(['monthly', 'seasonal', 'semi_annual'] as const).map(plan => (
                <div key={plan} className="flex items-center justify-between">
                  <span className="text-sm text-slate-600 dark:text-slate-400">{planLabel(plan)}</span>
                  <span className="text-sm font-bold text-slate-900 dark:text-white">{stats.byPlan[plan]}</span>
                </div>
              ))}
            </div>
          </div>

          {/* By Payment */}
          <div className="p-4 rounded-2xl bg-white dark:bg-zinc-800 border border-slate-100 dark:border-zinc-700">
            <h3 className="font-bold text-sm text-slate-900 dark:text-white mb-3">{t.paymentMethodStats}</h3>
            <div className="space-y-2">
              {(['zaincash', 'superkey', 'admin_grant'] as const).map(method => {
                const subs = stats.byPayment[method];
                const revenue = subs.reduce((s, sub) => s + (sub.amount || 0), 0);
                return (
                  <div key={method} className="flex items-center justify-between">
                    <span className="text-sm text-slate-600 dark:text-slate-400">{paymentLabel(method)}</span>
                    <div className="text-right rtl:text-left">
                      <span className="text-sm font-bold text-slate-900 dark:text-white">{subs.length}</span>
                      <span className="text-xs text-slate-400 mr-2 rtl:ml-2">({revenue.toLocaleString()} {t.iqd})</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Manual payment details.
            A Super Qi / Qi Card transfer lands in a wallet this app cannot
            query, so the student needs a number to send to and a human to
            confirm it with. Editable here rather than in an env var because the
            receiving number is the most likely thing to change, and a rebuild
            is not an acceptable cost for that. */}
        <div className="mb-6 p-4 rounded-2xl bg-white dark:bg-zinc-800 border border-slate-100 dark:border-zinc-700">
          <h3 className="font-bold text-sm text-slate-900 dark:text-white flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-amber-500" />
            {t.paymentContactSettings}
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{t.paymentContactHint}</p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
            <label className="block">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t.walletNumberLabel}</span>
              <input
                type="text"
                value={contactDraft.walletNumber}
                onChange={e => setContactDraft({ ...contactDraft, walletNumber: e.target.value })}
                placeholder="0770 000 0000"
                dir="ltr"
                className="mt-1 w-full px-3 py-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm text-slate-900 dark:text-white placeholder-slate-400 outline-none focus:border-sky-400"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
                <MessageSquare className="w-3.5 h-3.5 text-emerald-500" />
                {t.whatsappLabel}
              </span>
              <input
                type="text"
                value={contactDraft.whatsapp}
                onChange={e => setContactDraft({ ...contactDraft, whatsapp: e.target.value })}
                placeholder="07700000000"
                dir="ltr"
                className={`mt-1 w-full px-3 py-2.5 rounded-xl border bg-white dark:bg-zinc-900 text-sm text-slate-900 dark:text-white placeholder-slate-400 outline-none focus:border-sky-400 ${
                  whatsappBad ? 'border-red-400 dark:border-red-500' : 'border-slate-200 dark:border-zinc-700'
                }`}
              />
              {whatsappBad && <span className="text-[11px] text-red-500">{t.whatsappInvalid}</span>}
            </label>

            <label className="block">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
                <Send className="w-3.5 h-3.5 text-sky-500" />
                {t.telegramLabel}
              </span>
              <input
                type="text"
                value={contactDraft.telegram}
                onChange={e => setContactDraft({ ...contactDraft, telegram: e.target.value })}
                placeholder="@mohadaraty"
                dir="ltr"
                className={`mt-1 w-full px-3 py-2.5 rounded-xl border bg-white dark:bg-zinc-900 text-sm text-slate-900 dark:text-white placeholder-slate-400 outline-none focus:border-sky-400 ${
                  telegramBad ? 'border-red-400 dark:border-red-500' : 'border-slate-200 dark:border-zinc-700'
                }`}
              />
              {telegramBad && <span className="text-[11px] text-red-500">{t.telegramInvalid}</span>}
            </label>

            <label className="block">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t.paymentNoteLabel}</span>
              <input
                type="text"
                value={contactDraft.note}
                onChange={e => setContactDraft({ ...contactDraft, note: e.target.value })}
                className="mt-1 w-full px-3 py-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm text-slate-900 dark:text-white placeholder-slate-400 outline-none focus:border-sky-400"
              />
            </label>
          </div>

          <div className="flex items-center gap-3 mt-3">
            <button
              onClick={handleSaveContact}
              disabled={contactSave === 'saving' || channelMissing || whatsappBad || telegramBad}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-sky-500 text-white text-sm font-medium hover:bg-sky-600 disabled:opacity-50 transition-colors"
            >
              {contactSave === 'saving' ? <Loader2 className="w-4 h-4 animate-spin" />
                : contactSave === 'saved' ? <Check className="w-4 h-4" /> : null}
              {contactSave === 'saved' ? t.paySaved : t.paySave}
            </button>
            {channelMissing && <span className="text-xs text-amber-600 dark:text-amber-400">{t.channelRequired}</span>}
            {contactSave === 'error' && <span className="text-xs text-red-500">{t.paySaveFailed}</span>}
          </div>
        </div>

        {/* Actions Bar */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute top-1/2 -translate-y-1/2 right-3 rtl:right-3 rtl:left-auto w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={isRtl ? 'بحث بالاسم أو الإيميل...' : 'Search by name or email...'}
              className="w-full pr-10 rtl:pr-10 pl-4 py-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-slate-900 dark:text-white placeholder-slate-400 outline-none focus:border-sky-400"
            />
          </div>
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="px-3 py-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-slate-900 dark:text-white outline-none"
          >
            <option value="all">{isRtl ? 'جميع الحالات' : 'All Status'}</option>
            <option value="active">{t.subscriptionActive}</option>
            <option value="pending">{t.subscriptionPending}</option>
            <option value="inactive">{t.subscriptionExpired}</option>
            <option value="cancelled">{isRtl ? 'ملغي' : 'Cancelled'}</option>
          </select>
          <select
            value={filterPlan}
            onChange={e => setFilterPlan(e.target.value)}
            className="px-3 py-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-slate-900 dark:text-white outline-none"
          >
            <option value="all">{isRtl ? 'جميع الخطط' : 'All Plans'}</option>
            <option value="monthly">{t.monthly}</option>
            <option value="seasonal">{t.seasonal}</option>
            <option value="semi_annual">{t.semiAnnual}</option>
          </select>
          <button
            onClick={() => setShowGrantModal(true)}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 text-white text-sm font-medium shadow-sm hover:shadow-md transition-all"
          >
            <Gift className="w-4 h-4" />
            {t.grantSubscription}
          </button>
        </div>

        {/* Pending Approvals (highlighted) */}
        {stats.pending > 0 && filterStatus !== 'active' && (
          <div className="mb-4 p-4 rounded-2xl bg-amber-50 dark:bg-amber-950/20 border-2 border-amber-300 dark:border-amber-700">
            <h3 className="font-bold text-amber-800 dark:text-amber-300 mb-3 flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              {t.pendingPayments} ({stats.pending})
            </h3>
            <div className="space-y-2">
              {subscriptions.filter(s => s.status === 'pending').map(sub => (
                <div key={sub.id} className="p-3 rounded-xl bg-white dark:bg-zinc-800 flex items-center justify-between gap-3">
                  {/* The receipt is what approval is decided on, so it is a
                      thumbnail here rather than a link to click through. */}
                  {sub.receiptUrl && (
                    <a
                      href={sub.receiptUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={t.viewReceipt}
                      className="flex-shrink-0"
                    >
                      <img src={sub.receiptUrl} alt={t.viewReceipt} className="w-12 h-12 rounded-lg object-cover bg-slate-100 dark:bg-zinc-700" />
                    </a>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-900 dark:text-white truncate">{sub.userName || sub.userEmail}</p>
                    <p className="text-xs text-slate-500">{planLabel(sub.plan)} • {sub.amount.toLocaleString()} {t.iqd} • {paymentLabel(sub.paymentMethod)}</p>
                    {sub.transactionId && (
                      <p className="text-xs text-slate-400 mt-0.5 font-mono">Ref: {sub.transactionId}</p>
                    )}
                    {sub.receiptUrl && (
                      <a
                        href={sub.receiptUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 mt-0.5 text-xs font-medium text-sky-600 dark:text-sky-400 hover:underline"
                      >
                        <Paperclip className="w-3 h-3" />
                        {t.viewReceipt}
                      </a>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => handleAction(() => approveSubscription(sub.id), sub.id)}
                      disabled={actionLoading === sub.id}
                      className="px-3 py-1.5 rounded-lg bg-emerald-500 text-white text-xs font-medium hover:bg-emerald-600 disabled:opacity-50 transition-colors"
                    >
                      {actionLoading === sub.id ? <Loader2 className="w-3 h-3 animate-spin" /> : t.approve}
                    </button>
                    <button
                      onClick={() => handleAction(() => rejectSubscription(sub.id), sub.id)}
                      disabled={actionLoading === sub.id}
                      className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium hover:bg-red-600 disabled:opacity-50 transition-colors"
                    >
                      {t.reject}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Subscriptions Table */}
        <div className="space-y-2">
          {filtered.length === 0 && (
            <div className="text-center py-12 text-slate-400">
              <CreditCard className="w-10 h-10 mx-auto mb-3 opacity-50" />
              <p>{t.noTransactions}</p>
            </div>
          )}
          {filtered.map(sub => (
            <motion.div
              key={sub.id}
              layout
              className="p-4 rounded-2xl bg-white dark:bg-zinc-800 border border-slate-100 dark:border-zinc-700"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-bold text-slate-900 dark:text-white">{sub.userName || sub.userEmail}</p>
                    <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${statusColors[sub.status]}`}>
                      {sub.status === 'active' ? t.subscriptionActive :
                       sub.status === 'pending' ? t.subscriptionPending :
                       sub.status === 'inactive' ? t.subscriptionExpired : isRtl ? 'ملغي' : 'Cancelled'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    {sub.userEmail} • {planLabel(sub.plan)} • {paymentLabel(sub.paymentMethod)}
                    {sub.amount > 0 ? ` • ${sub.amount.toLocaleString()} ${t.iqd}` : ''}
                  </p>
                  <div className="flex items-center gap-4 mt-1.5 text-xs text-slate-400">
                    {sub.startDate && (
                      <span className="flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        {formatSubscriptionDate(sub.startDate)} → {formatSubscriptionDate(sub.endDate)}
                      </span>
                    )}
                    {sub.status === 'active' && sub.endDate && (
                      <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                        {getRemainingDays(sub.endDate)} {t.daysRemaining}
                      </span>
                    )}
                  </div>
                  {sub.transactionId && (
                    <p className="text-xs text-slate-400 mt-1 font-mono">TxID: {sub.transactionId}</p>
                  )}
                  {sub.receiptUrl && (
                    <a
                      href={sub.receiptUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 mt-1 text-xs font-medium text-sky-600 dark:text-sky-400 hover:underline"
                    >
                      <Paperclip className="w-3 h-3" />
                      {t.viewReceipt}
                    </a>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {sub.status === 'pending' && (
                    <>
                      <button
                        onClick={() => handleAction(() => approveSubscription(sub.id), sub.id)}
                        disabled={!!actionLoading}
                        className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 transition-colors disabled:opacity-50"
                        title={t.approve}
                      >
                        {actionLoading === sub.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                      </button>
                      <button
                        onClick={() => handleAction(() => rejectSubscription(sub.id), sub.id)}
                        disabled={!!actionLoading}
                        className="p-2 rounded-lg bg-red-50 dark:bg-red-900/30 text-red-600 hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors disabled:opacity-50"
                        title={t.reject}
                      >
                        <XCircle className="w-4 h-4" />
                      </button>
                    </>
                  )}
                  {sub.status === 'active' && (
                    <>
                      <button
                        onClick={() => { setShowExtendModal(sub.id); setExtendDays(30); }}
                        className="p-2 rounded-lg bg-sky-50 dark:bg-sky-900/30 text-sky-600 hover:bg-sky-100 dark:hover:bg-sky-900/50 transition-colors"
                        title={t.extend}
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleAction(() => cancelSubscription(sub.id), sub.id)}
                        disabled={!!actionLoading}
                        className="p-2 rounded-lg bg-red-50 dark:bg-red-900/30 text-red-600 hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors disabled:opacity-50"
                        title={t.cancel}
                      >
                        {actionLoading === sub.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>

      {/* Extend Modal */}
      <AnimatePresence>
        {showExtendModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
            onClick={() => setShowExtendModal(null)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="w-full max-w-sm bg-white dark:bg-zinc-900 rounded-2xl p-6 shadow-xl"
            >
              <h3 className="font-bold text-lg text-slate-900 dark:text-white mb-4">{t.extend}</h3>
              <label className="block text-sm text-slate-600 dark:text-slate-400 mb-2">{t.extendDays}</label>
              <input
                type="number"
                min={1}
                max={365}
                value={extendDays}
                onChange={e => setExtendDays(Number(e.target.value))}
                className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-900 dark:text-white outline-none focus:border-sky-400 mb-4"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => setShowExtendModal(null)}
                  className="flex-1 py-2.5 rounded-xl bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-slate-300 text-sm font-medium"
                >
                  {isRtl ? 'إلغاء' : 'Cancel'}
                </button>
                <button
                  onClick={() => handleExtend(showExtendModal)}
                  disabled={!!actionLoading}
                  className="flex-1 py-2.5 rounded-xl bg-sky-500 text-white text-sm font-medium disabled:opacity-50"
                >
                  {actionLoading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : t.extend}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Grant Modal */}
      <AnimatePresence>
        {showGrantModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
            onClick={() => setShowGrantModal(false)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="w-full max-w-md bg-white dark:bg-zinc-900 rounded-2xl p-6 shadow-xl max-h-[80vh] overflow-y-auto"
            >
              <h3 className="font-bold text-lg text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                <Gift className="w-5 h-5 text-amber-500" />
                {t.grantSubscription}
              </h3>

              {/* User search */}
              <label className="block text-sm text-slate-600 dark:text-slate-400 mb-2">
                {isRtl ? 'اختر المستخدم' : 'Select User'}
              </label>
              <input
                type="text"
                value={userSearch}
                onChange={e => setUserSearch(e.target.value)}
                placeholder={isRtl ? 'بحث بالاسم أو الإيميل...' : 'Search by name or email...'}
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-slate-900 dark:text-white placeholder-slate-400 outline-none focus:border-sky-400 mb-2"
              />
              {userSearch && (
                <div className="max-h-40 overflow-y-auto rounded-xl border border-slate-200 dark:border-zinc-700 mb-4">
                  {filteredUsers.map(u => (
                    <button
                      key={u.uid}
                      onClick={() => { setGrantUserId(u.uid); setUserSearch(u.name || u.email); }}
                      className={`w-full px-3 py-2 text-right rtl:text-right text-sm hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors ${
                        grantUserId === u.uid ? 'bg-sky-50 dark:bg-sky-900/30' : ''
                      }`}
                    >
                      <p className="font-medium text-slate-900 dark:text-white">{u.name}</p>
                      <p className="text-xs text-slate-400">{u.email}</p>
                    </button>
                  ))}
                </div>
              )}

              {/* Plan select */}
              <label className="block text-sm text-slate-600 dark:text-slate-400 mb-2 mt-3">
                {isRtl ? 'الخطة' : 'Plan'}
              </label>
              <select
                value={grantPlan}
                onChange={e => setGrantPlan(e.target.value as SubscriptionPlan)}
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-slate-900 dark:text-white outline-none mb-3"
              >
                <option value="monthly">{t.monthly} (30 {t.days})</option>
                <option value="seasonal">{t.seasonal} (90 {t.days})</option>
                <option value="semi_annual">{t.semiAnnual} (180 {t.days})</option>
              </select>

              {/* Notes */}
              <label className="block text-sm text-slate-600 dark:text-slate-400 mb-2">
                {isRtl ? 'ملاحظات (اختياري)' : 'Notes (optional)'}
              </label>
              <input
                type="text"
                value={grantNotes}
                onChange={e => setGrantNotes(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-slate-900 dark:text-white outline-none focus:border-sky-400 mb-4"
              />

              <div className="flex gap-2">
                <button
                  onClick={() => setShowGrantModal(false)}
                  className="flex-1 py-2.5 rounded-xl bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-slate-300 text-sm font-medium"
                >
                  {isRtl ? 'إلغاء' : 'Cancel'}
                </button>
                <button
                  onClick={handleGrant}
                  disabled={!grantUserId || actionLoading === 'grant'}
                  className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 text-white text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-1"
                >
                  {actionLoading === 'grant' ? <Loader2 className="w-4 h-4 animate-spin" /> : (
                    <>
                      <Gift className="w-4 h-4" />
                      {t.grantSubscription}
                    </>
                  )}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
