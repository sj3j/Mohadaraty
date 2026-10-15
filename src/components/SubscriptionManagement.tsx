import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Loader2, Search, CheckCircle2, AlertTriangle, Gift, Wallet, History, CalendarClock, BarChart3, XCircle } from 'lucide-react';
import type { Language, Subscription, SubscriptionPlan, UserProfile } from '../types';
import { PLAN_CONFIG } from '../types';
import {
  canActivateSubscription,
  canViewExpiringSubscriptions,
  canViewOwnSupportBalance,
  canViewSubscriptionHistory,
  isMasterAdmin,
} from '../lib/permissions';
import {
  approveSubscription,
  cancelSubscription,
  extendSubscription,
  onAllSubscriptions,
  onPaymentContact,
  reconcileZainCash,
  rejectSubscription,
  savePaymentContact,
} from '../services/subscriptionService';
import {
  getActiveSubscriptions,
  getExpiringSubscriptions,
  getSubscriptionHistory,
  getSubscriptionPreview,
  getSubscriptionReports,
  getSupportBalances,
  grantAuditedSubscription,
  manualActivateSubscription,
  requestSupportGrant,
  modifySubscriptionEndDate,
  newRequestId,
  settleSupportBalance,
  terminateSubscription,
  voidSubscriptionRecord,
  type ActiveSubscriptionItem,
  type HistoryItem,
  type SubscriptionPreview,
  type SupportBalance,
  type SubscriptionStudentSearchResult,
} from '../services/subscriptionManagementService';
import StudentSearchDropdown from './subscription/StudentSearchDropdown';
import type { ManualPaymentMethod } from '../../shared/subscriptionTypes';
import { EMPTY_PAYMENT_CONTACT, hasPaymentChannel, normalizePaymentContact, type PaymentContact } from '../lib/paymentContact';
import { needsManualApproval } from '../lib/subscriptionStats';

interface Props { user: UserProfile; lang: Language; onClose: () => void }
type Tab = 'history' | 'active' | 'legacy' | 'balances' | 'reports' | 'expiring';

const money = (value: number) => `${Math.abs(value || 0).toLocaleString()} IQD`;
const dateText = (value?: string | null) => value ? new Date(value).toLocaleString() : '—';

export default function SubscriptionManagement({ user, lang, onClose }: Props) {
  const rtl = lang === 'ar';
  const master = isMasterAdmin(user);
  const canActivate = canActivateSubscription(user);
  const canHistory = canViewSubscriptionHistory(user);
  const canOwnBalance = canViewOwnSupportBalance(user);
  const canExpiring = canViewExpiringSubscriptions(user);
  const tabs = useMemo<Tab[]>(() => [
    ...(canHistory ? ['history' as const] : []),
    ...(master ? ['active' as const, 'legacy' as const, 'balances' as const, 'reports' as const] : []),
    ...(!master && canOwnBalance ? ['balances' as const] : []),
    ...(canExpiring ? ['expiring' as const] : []),
  ], [master, canHistory, canOwnBalance, canExpiring]);
  const [tab, setTab] = useState<Tab>(tabs[0] || 'history');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const [notice, setNotice] = useState('');
  const [showActivation, setShowActivation] = useState(false);
  const [activationEmail, setActivationEmail] = useState('');
  const [selectedActivationStudent, setSelectedActivationStudent] = useState<SubscriptionStudentSearchResult | null>(null);
  const [activationPlan, setActivationPlan] = useState<SubscriptionPlan>('monthly');
  const [paymentMethod, setPaymentMethod] = useState<ManualPaymentMethod>('cash');
  const [activationNote, setActivationNote] = useState('');
  const [preview, setPreview] = useState<SubscriptionPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [activationRequestId, setActivationRequestId] = useState('');
  const previewSequence = useRef(0);

  const [showGrant, setShowGrant] = useState(false);
  const [grantEmail, setGrantEmail] = useState('');
  const [selectedGrantStudent, setSelectedGrantStudent] = useState<SubscriptionStudentSearchResult | null>(null);
  const [grantPlan, setGrantPlan] = useState<SubscriptionPlan>('monthly');
  const [grantReason, setGrantReason] = useState('');
  const [grantRequestId, setGrantRequestId] = useState('');
  const retryRequestIds = useRef(new Map<string, string>());

  const [historyRows, setHistoryRows] = useState<HistoryItem[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [filters, setFilters] = useState({ student: '', staff: '', reference: '' });

  const [legacy, setLegacy] = useState<Subscription[]>([]);
  const [contact, setContact] = useState<PaymentContact>(EMPTY_PAYMENT_CONTACT);
  const contactSeeded = useRef(false);

  const [balances, setBalances] = useState<SupportBalance[]>([]);
  const [ownBalance, setOwnBalance] = useState<SupportBalance | null>(null);
  const [ledger, setLedger] = useState<any[]>([]);
  const [reports, setReports] = useState<any>(null);
  const [period, setPeriod] = useState<'today' | 'this_month' | 'last_month' | 'this_year'>('today');
  const [expiring, setExpiring] = useState<any[]>([]);
  const [expiringCursor, setExpiringCursor] = useState<string | null>(null);

  const [activeRows, setActiveRows] = useState<ActiveSubscriptionItem[]>([]);
  const [activeCursor, setActiveCursor] = useState<string | null>(null);
  const [activeSearch, setActiveSearch] = useState('');

  const [modifyingTarget, setModifyingTarget] = useState<{ studentId: string; studentEmail: string; studentName: string; currentExpiry?: string | null } | null>(null);
  const [modifyNewDate, setModifyNewDate] = useState('');
  const [modifyReason, setModifyReason] = useState('');

  const [terminatingTarget, setTerminatingTarget] = useState<{ studentId: string; studentEmail: string; studentName: string; currentExpiry?: string | null } | null>(null);
  const [terminateImmediate, setTerminateImmediate] = useState(true);
  const [terminateCustomDate, setTerminateCustomDate] = useState('');
  const [terminateReason, setTerminateReason] = useState('');

  const fail = (err: unknown) => {
    console.error(err);
    setError(err instanceof Error ? err.message : 'Request failed');
  };

  const loadHistory = async (append = false) => {
    if (!canHistory) return;
    setBusy('history'); setError('');
    try {
      const result = await getSubscriptionHistory({
        ...filters,
        cursor: append ? historyCursor : null,
      });
      setHistoryRows(current => append ? [...current, ...result.items] : result.items);
      setHistoryCursor(result.nextCursor);
    } catch (err) { fail(err); } finally { setBusy(''); }
  };

  const loadBalances = async () => {
    setBusy('balances'); setError('');
    try {
      const result = await getSupportBalances(master ? undefined : user.uid);
      if (master) setBalances(result.balances || []);
      else {
        setOwnBalance(result.balance || null);
        setLedger(result.ledger || []);
      }
    } catch (err) { fail(err); } finally { setBusy(''); }
  };

  const loadReports = async () => {
    if (!master) return;
    setBusy('reports'); setError('');
    try { setReports(await getSubscriptionReports(period)); }
    catch (err) { fail(err); } finally { setBusy(''); }
  };

  const loadExpiring = async (append = false) => {
    if (!canExpiring) return;
    setBusy('expiring'); setError('');
    try {
      const result = await getExpiringSubscriptions(append ? expiringCursor : null);
      setExpiring(current => append ? [...current, ...result.items] : result.items);
      setExpiringCursor(result.nextCursor);
    } catch (err) { fail(err); } finally { setBusy(''); }
  };

  const loadActive = async (append = false) => {
    if (!master) return;
    setBusy('active'); setError('');
    try {
      const result = await getActiveSubscriptions({
        search: activeSearch.trim() || undefined,
        cursor: append ? activeCursor : null,
      });
      setActiveRows(current => append ? [...current, ...result.items] : result.items);
      setActiveCursor(result.nextCursor);
    } catch (err) { fail(err); } finally { setBusy(''); }
  };

  const handleModifyEndDate = async () => {
    if (!modifyingTarget || !modifyNewDate) return;
    setBusy('modify_date'); setError('');
    try {
      const dateObj = new Date(`${modifyNewDate}T23:59:59+03:00`);
      if (isNaN(dateObj.getTime())) {
        throw new Error(rtl ? 'تاريخ غير صالح' : 'Invalid date');
      }
      await modifySubscriptionEndDate({
        studentEmail: modifyingTarget.studentEmail || modifyingTarget.studentId,
        newEndDate: dateObj.toISOString(),
        reason: modifyReason || undefined,
      });
      setModifyingTarget(null);
      setModifyNewDate('');
      setModifyReason('');
      if (tab === 'active') await loadActive();
      if (tab === 'expiring') await loadExpiring();
      if (canHistory) await loadHistory();
    } catch (err) { fail(err); } finally { setBusy(''); }
  };

  const handleTerminate = async () => {
    if (!terminatingTarget) return;
    setBusy('terminate'); setError(''); setNotice('');
    try {
      await terminateSubscription({
        studentEmail: terminatingTarget.studentEmail || terminatingTarget.studentId,
        immediate: true,
        reason: terminateReason || undefined,
      });
      setTerminatingTarget(null);
      setTerminateImmediate(true);
      setTerminateCustomDate('');
      setTerminateReason('');
      setNotice(rtl ? 'تم إلغاء الاشتراك بنجاح وخصم قيمته من التقارير' : 'Subscription cancelled and value deducted from reports');
      if (tab === 'active') await loadActive();
      if (tab === 'expiring') await loadExpiring();
      if (canHistory) await loadHistory();
      if (master) await loadReports();
    } catch (err) { fail(err); } finally { setBusy(''); }
  };

  useEffect(() => { if (tab === 'history') loadHistory(); }, [tab]);
  useEffect(() => { if (tab === 'balances') loadBalances(); }, [tab]);
  useEffect(() => { if (tab === 'reports') loadReports(); }, [tab, period]);
  useEffect(() => { if (tab === 'expiring') loadExpiring(); }, [tab]);
  useEffect(() => { if (tab === 'active') loadActive(); }, [tab]);

  useEffect(() => {
    if (!master) return;
    const unsub = onAllSubscriptions(setLegacy);
    reconcileZainCash('all').catch(() => undefined);
    const unsubContact = onPaymentContact(value => {
      if (!contactSeeded.current) { contactSeeded.current = true; setContact(value); }
    });
    return () => { unsub(); unsubContact(); };
  }, [master]);

  // Lookup is intentionally debounced and both abort- and sequence-guarded.
  // Some fetch implementations deliver an already-resolved response after
  // abort; the sequence check prevents that stale result from enabling submit.
  useEffect(() => {
    setPreview(null);
    const email = activationEmail.trim().toLowerCase();
    if (!showActivation || !email) return;
    const sequence = ++previewSequence.current;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setPreviewing(true); setError('');
      try {
        const result = await getSubscriptionPreview(email, activationPlan, controller.signal);
        if (sequence === previewSequence.current) setPreview(result);
      } catch (err: any) {
        if (err?.name !== 'AbortError' && sequence === previewSequence.current) fail(err);
      } finally {
        if (sequence === previewSequence.current) setPreviewing(false);
      }
    }, 400);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [showActivation, activationEmail, activationPlan]);

  const activate = async () => {
    if (!preview) return;
    setBusy('activate'); setError(''); setNotice('');
    try {
      if (paymentMethod === 'grant') {
        await requestSupportGrant({
          requestId: activationRequestId,
          studentEmail: preview.studentEmail,
          plan: activationPlan,
          reason: activationNote || undefined,
        });
        setNotice(rtl ? 'تم إرسال طلب المنحة بنجاح وهو بانتظار موافقة الماستر أدمن.' : 'Grant request submitted successfully and is pending Master Admin approval.');
      } else {
        await manualActivateSubscription({
          requestId: activationRequestId,
          studentEmail: preview.studentEmail,
          plan: activationPlan as Exclude<SubscriptionPlan, 'annual'>,
          paymentMethod,
          note: activationNote || undefined,
          previewStateToken: preview.stateToken,
        });
      }
      setShowActivation(false); setActivationEmail(''); setSelectedActivationStudent(null); setPreview(null); setActivationRequestId('');
      if (canHistory) { setTab('history'); await loadHistory(); }
    } catch (err: any) {
      fail(err);
      if (err?.code === 'PREVIEW_STALE') setPreview(null);
    } finally { setBusy(''); }
  };

  const grant = async () => {
    if (!grantEmail.trim()) return;
    setBusy('grant'); setError('');
    try {
      await grantAuditedSubscription({
        requestId: grantRequestId, studentEmail: grantEmail.trim().toLowerCase(), plan: grantPlan,
        reason: grantReason || undefined,
      });
      setShowGrant(false); setGrantEmail(''); setSelectedGrantStudent(null); setGrantReason(''); setGrantRequestId('');
      if (canHistory) { setTab('history'); await loadHistory(); }
    } catch (err) { fail(err); } finally { setBusy(''); }
  };

  const voidRow = async (row: HistoryItem) => {
    const reason = window.prompt(rtl ? 'سبب الإلغاء (اختياري)' : 'Void reason (optional)') || undefined;
    if (!window.confirm(rtl ? 'سيتم استرجاع حالة الطالب السابقة وعكس رصيد الدعم. متابعة؟' : 'This restores the exact previous student state and reverses Support credit. Continue?')) return;
    const retryKey = `void:${row.id}:${reason || ''}`;
    const requestId = retryRequestIds.current.get(retryKey) || newRequestId();
    retryRequestIds.current.set(retryKey, requestId);
    setBusy(row.id); setError('');
    try { await voidSubscriptionRecord(row.id, requestId, reason); retryRequestIds.current.delete(retryKey); await loadHistory(); }
    catch (err) { fail(err); } finally { setBusy(''); }
  };

  const settle = async (balance: SupportBalance, action: 'receive' | 'reset' | 'payout') => {
    let amount: number | undefined;
    let full = false;
    if (action === 'receive') {
      const entered = window.prompt(rtl ? `المبلغ المستلم (الرصيد ${money(balance.outstanding)})، اتركه فارغاً للاستلام الكامل` : `Amount received (balance ${money(balance.outstanding)}); leave blank for full receipt`);
      if (entered === null) return;
      full = !entered.trim();
      if (!full) amount = Number(entered);
      if (!full && (!Number.isSafeInteger(amount) || amount! <= 0 || amount! > balance.outstanding)) {
        setError(rtl ? 'أدخل مبلغاً صحيحاً لا يتجاوز الرصيد.' : 'Enter a positive integer no greater than the outstanding balance.');
        return;
      }
    }
    const exactAmount = action === 'receive'
      ? (full ? balance.outstanding : amount || 0)
      : Math.abs(balance.outstanding);
    const noteInput = window.prompt(rtl ? 'ملاحظة اختيارية' : 'Optional note', '');
    if (noteInput === null) return;
    const note = noteInput.trim() || undefined;
    if (note && Array.from(note).length > 200) {
      setError(rtl ? 'الملاحظة يجب ألا تتجاوز 200 حرف.' : 'Note must be at most 200 characters.');
      return;
    }
    const message = action === 'payout'
      ? (rtl ? `الماستر يدفع لموظف الدعم ${money(exactAmount)} لتصفير الرصيد. تأكيد؟` : `Master pays Support ${money(exactAmount)} to settle the negative balance. Confirm?`)
      : action === 'reset'
        ? (rtl ? `تصفير ${money(exactAmount)} كتسوية، وليس كأموال مستلمة؟` : `Reset ${money(exactAmount)} as an adjustment, not received money?`)
        : (rtl ? `تأكيد استلام ${money(exactAmount)}؟` : `Confirm receipt of ${money(exactAmount)}?`);
    if (!window.confirm(message)) return;
    const retryKey = JSON.stringify(['settle', balance.supportUid, action, balance.outstanding, exactAmount, full, note || '']);
    const requestId = retryRequestIds.current.get(retryKey) || newRequestId();
    retryRequestIds.current.set(retryKey, requestId);
    setBusy(balance.supportUid); setError('');
    try {
      await settleSupportBalance(balance.supportUid, action, {
        requestId, expectedOutstanding: balance.outstanding, amount, full, note,
      });
      retryRequestIds.current.delete(retryKey);
      await loadBalances();
    } catch (err) { fail(err); } finally { setBusy(''); }
  };

  const pendingGrants = legacy.filter(s => s.status === 'pending' && s.paymentMethod === 'grant');
  const pendingSuperKey = legacy.filter(s => s.status === 'pending' && s.paymentMethod !== 'grant' && needsManualApproval(s));
  const pendingTotal = pendingGrants.length + pendingSuperKey.length;

  const tabLabel: Record<Tab, string> = rtl ? {
    history: 'السجل',
    active: 'الاشتراكات الفعالة',
    legacy: pendingTotal > 0 ? `طلبات الدفع (${pendingTotal})` : 'طلبات الدفع',
    balances: 'حسابات الدعم',
    reports: 'التقارير',
    expiring: 'قريب الانتهاء',
  } : {
    history: 'History',
    active: 'Active subscriptions',
    legacy: pendingTotal > 0 ? `Payment queue (${pendingTotal})` : 'Payment queue',
    balances: 'Support accounting',
    reports: 'Reports',
    expiring: 'Expiring soon',
  };

  const normalizedContact = normalizePaymentContact(contact);

  const reportPlans = [
    { key: 'monthly', ar: 'الشهري (Monthly)', en: 'Monthly' },
    { key: 'seasonal', ar: 'الفصلي (Seasonal)', en: 'Seasonal' },
    { key: 'semi_annual', ar: 'النصف سنوي (Semi-annual)', en: 'Semi-annual' },
    { key: 'annual', ar: 'السنوي (Yearly)', en: 'Yearly' },
  ] as const;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-50 dark:bg-zinc-950" dir={rtl ? 'rtl' : 'ltr'}>
      <header className="sticky top-[env(safe-area-inset-top)] z-20 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/90">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          <div>
            <h1 className="font-bold text-slate-900 dark:text-white">{rtl ? 'إدارة الاشتراكات' : 'Subscription management'}</h1>
            {user.role === 'support' && user.staffDisabled && <p className="text-xs text-red-500">{rtl ? 'حساب الدعم معطّل' : 'Support account disabled'}</p>}
          </div>
          <div className="flex gap-2">
            {canActivate && <button onClick={() => { setActivationRequestId(newRequestId()); setActivationEmail(''); setSelectedActivationStudent(null); setShowActivation(true); }} className="rounded-xl bg-sky-600 px-3 py-2 text-sm font-bold text-white">{rtl ? 'تفعيل يدوي' : 'Manual activation'}</button>}
            {master && <button onClick={() => { setGrantRequestId(newRequestId()); setGrantEmail(''); setSelectedGrantStudent(null); setShowGrant(true); }} className="rounded-xl bg-amber-500 px-3 py-2 text-sm font-bold text-white"><Gift className="me-1 inline h-4 w-4" />{rtl ? 'منح' : 'Grant'}</button>}
            <button onClick={onClose} className="rounded-xl bg-slate-100 p-2 text-slate-600 dark:bg-zinc-800 dark:text-slate-300"><X className="h-5 w-5" /></button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl p-4">
        {notice && <div className="mb-4 flex items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
            <span>{notice}</span>
          </div>
          <button onClick={() => setNotice('')} className="text-emerald-700 hover:text-emerald-900 dark:text-emerald-300"><X className="h-4 w-4" /></button>
        </div>}
        {error && <div className="mb-4 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"><AlertTriangle className="h-4 w-4" />{error}</div>}
        <nav className="mb-5 flex gap-2 overflow-x-auto">
          {tabs.map(value => <button key={value} onClick={() => setTab(value)} className={`whitespace-nowrap rounded-xl px-4 py-2 text-sm font-bold ${tab === value ? 'bg-slate-900 text-white dark:bg-white dark:text-zinc-900' : 'bg-white text-slate-600 dark:bg-zinc-900 dark:text-slate-300'}`}>{tabLabel[value]}</button>)}
        </nav>

        {tab === 'history' && canHistory && (
          <section>
            <div className="mb-4 grid gap-2 rounded-2xl bg-white p-4 shadow-sm dark:bg-zinc-900 md:grid-cols-4">
              <input value={filters.student} onChange={e => setFilters({ ...filters, student: e.target.value })} placeholder={rtl ? 'بريد الطالب (مطابقة تامة)' : 'Student email (exact)'} className="rounded-xl border p-2 dark:border-zinc-700 dark:bg-zinc-800" />
              <input value={filters.staff} onChange={e => setFilters({ ...filters, staff: e.target.value })} placeholder={rtl ? 'معرّف الموظف' : 'Staff UID (exact)'} className="rounded-xl border p-2 dark:border-zinc-700 dark:bg-zinc-800" />
              <input value={filters.reference} onChange={e => setFilters({ ...filters, reference: e.target.value })} placeholder={rtl ? 'المرجع' : 'Reference code'} className="rounded-xl border p-2 uppercase dark:border-zinc-700 dark:bg-zinc-800" />
              <button onClick={() => loadHistory()} className="rounded-xl bg-sky-600 p-2 font-bold text-white"><Search className="me-1 inline h-4 w-4" />{rtl ? 'بحث' : 'Search'}</button>
            </div>
            <div className="space-y-3">
              {historyRows.map(row => <article key={`${row.source}-${row.id}`} className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div><p className="font-bold text-slate-900 dark:text-white">{row.studentName || row.studentEmail || row.studentId}</p><p className="text-xs text-slate-500">{row.studentEmail || row.studentId}</p></div>
                  <div className="flex gap-2">
                    <span className="rounded-full bg-slate-100 px-2 py-1 text-xs dark:bg-zinc-800">{row.type}</span>
                    {row.voidedBy && <span className="rounded-full bg-red-100 px-2 py-1 text-xs font-bold text-red-700">VOID</span>}
                    {row.cancelledBy && <span className="rounded-full bg-rose-100 px-2 py-1 text-xs font-bold text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{rtl ? 'ملغي' : 'CANCELLED'}</span>}
                  </div>
                </div>
                <div className="mt-3 grid gap-2 text-xs text-slate-600 dark:text-slate-300 sm:grid-cols-2 lg:grid-cols-4">
                  <span>{rtl ? 'الخطة' : 'Plan'}: {row.plan || '—'}</span><span>{rtl ? 'المبلغ' : 'Amount'}: {money(row.amount || 0)}</span>
                  <span>{rtl ? 'الدفع' : 'Payment'}: {row.paymentMethod || '—'}</span><span>{rtl ? 'المرجع' : 'Reference'}: {row.referenceCode || '—'}</span>
                  <span>{rtl ? 'الموظف' : 'Staff'}: {row.actor?.name || row.actor?.email || '—'}</span><span>{rtl ? 'السبب' : 'Reason'}: {row.reason || '—'}</span>
                  <span>{rtl ? 'التاريخ' : 'Date'}: {dateText(row.createdAt)}</span><span>{rtl ? 'الانتهاء' : 'Expiry'}: {dateText(row.endDate)}</span>
                </div>
                {master && row.source === 'private' && ['activation', 'grant'].includes(row.type) && !row.voidedBy && !row.cancelledBy && <button onClick={() => voidRow(row)} disabled={!!busy} className="mt-3 rounded-lg bg-red-50 px-3 py-1.5 text-xs font-bold text-red-700 disabled:opacity-50 dark:bg-red-950/30 dark:text-red-300">{busy === row.id ? '…' : (rtl ? 'إبطال' : 'Void')}</button>}
              </article>)}
            </div>
            {busy === 'history' && <Loader2 className="mx-auto mt-4 h-5 w-5 animate-spin" />}
            {historyCursor && <button onClick={() => loadHistory(true)} className="mx-auto mt-4 block rounded-xl bg-white px-4 py-2 text-sm dark:bg-zinc-900">{rtl ? 'المزيد' : 'Load more'}</button>}
          </section>
        )}

        {tab === 'active' && master && (
          <section className="space-y-4">
            <div className="flex flex-wrap gap-2 rounded-2xl bg-white p-4 shadow-sm dark:bg-zinc-900">
              <input
                value={activeSearch}
                onChange={e => setActiveSearch(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') loadActive(); }}
                placeholder={rtl ? 'بحث بالبريد أو الاسم...' : 'Search by email or name...'}
                className="min-w-[240px] flex-1 rounded-xl border p-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
              />
              <button
                onClick={() => loadActive()}
                disabled={busy === 'active'}
                className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-bold text-white hover:bg-sky-700 disabled:opacity-50"
              >
                <Search className="me-1 inline h-4 w-4" />{rtl ? 'بحث' : 'Search'}
              </button>
              {activeSearch && (
                <button
                  onClick={() => { setActiveSearch(''); }}
                  className="rounded-xl bg-slate-100 px-3 py-2 text-sm text-slate-600 dark:bg-zinc-800 dark:text-slate-300"
                >
                  {rtl ? 'مسح' : 'Clear'}
                </button>
              )}
            </div>

            <div className="space-y-3">
              {activeRows.map(item => (
                <article key={item.studentId} className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-bold text-slate-900 dark:text-white">{item.studentName}</p>
                      <p className="text-xs text-slate-500">{item.studentEmail}</p>
                      <div className="mt-1 flex items-center gap-2">
                        <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                          {item.plan ? ((rtl ? PLAN_CONFIG[item.plan]?.labelAr : PLAN_CONFIG[item.plan]?.labelEn) || item.plan) : (rtl ? 'فعال' : 'Active')}
                        </span>
                        {item.daysLeft !== null && (
                          <span className={`text-xs ${item.daysLeft <= 7 ? 'font-bold text-amber-600' : 'text-slate-500'}`}>
                            {item.daysLeft} {rtl ? 'يوم متبقي' : item.daysLeft === 1 ? 'day left' : 'days left'}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-end text-sm text-slate-600 dark:text-slate-300">
                      <p className="text-xs text-slate-400">{rtl ? 'تاريخ الانتهاء' : 'Expiry'}</p>
                      <p className="font-mono text-xs">{dateText(item.expiry)}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3 dark:border-zinc-800">
                    <button
                      onClick={() => {
                        setModifyingTarget({
                          studentId: item.studentId,
                          studentEmail: item.studentEmail,
                          studentName: item.studentName,
                          currentExpiry: item.expiry,
                        });
                        setModifyNewDate(item.expiry ? new Date(item.expiry).toISOString().slice(0, 10) : '');
                        setModifyReason('');
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-sky-50 px-3 py-1.5 text-xs font-bold text-sky-700 hover:bg-sky-100 dark:bg-sky-950/40 dark:text-sky-300"
                    >
                      <CalendarClock className="h-3.5 w-3.5" />
                      {rtl ? 'تعديل تاريخ الانتهاء' : 'Modify end date'}
                    </button>
                    <button
                      onClick={() => {
                        setTerminatingTarget({
                          studentId: item.studentId,
                          studentEmail: item.studentEmail,
                          studentName: item.studentName,
                          currentExpiry: item.expiry,
                        });
                        setTerminateImmediate(true);
                        setTerminateCustomDate(item.expiry ? new Date(item.expiry).toISOString().slice(0, 10) : '');
                        setTerminateReason('');
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-700 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      {rtl ? 'إلغاء الاشتراك' : 'Cancel subscription'}
                    </button>
                  </div>
                </article>
              ))}
              {activeRows.length === 0 && busy !== 'active' && (
                <div className="rounded-2xl bg-white p-8 text-center text-sm text-slate-500 dark:bg-zinc-900">
                  {rtl ? 'لا توجد اشتراكات فعالة مطابقة' : 'No active subscriptions found'}
                </div>
              )}
            </div>
            {busy === 'active' && <Loader2 className="mx-auto mt-4 h-5 w-5 animate-spin" />}
            {activeCursor && (
              <button onClick={() => loadActive(true)} className="mx-auto mt-4 block rounded-xl bg-white px-4 py-2 text-sm dark:bg-zinc-900">
                {rtl ? 'المزيد' : 'Load more'}
              </button>
            )}
          </section>
        )}

        {tab === 'legacy' && master && <section className="space-y-4">
          <div className="rounded-2xl bg-white p-4 dark:bg-zinc-900">
            <h2 className="mb-3 font-bold">{rtl ? 'إعدادات تواصل الدفع' : 'Payment contact settings'}</h2>
            <div className="grid gap-2 md:grid-cols-4">
              <input value={contact.walletNumber} onChange={e => setContact({ ...contact, walletNumber: e.target.value })} placeholder={rtl ? 'رقم المحفظة' : 'Wallet number'} className="rounded-xl border p-2 dark:border-zinc-700 dark:bg-zinc-800" />
              <input value={contact.whatsapp} onChange={e => setContact({ ...contact, whatsapp: e.target.value })} placeholder="WhatsApp" className="rounded-xl border p-2 dark:border-zinc-700 dark:bg-zinc-800" />
              <input value={contact.telegram} onChange={e => setContact({ ...contact, telegram: e.target.value })} placeholder="Telegram" className="rounded-xl border p-2 dark:border-zinc-700 dark:bg-zinc-800" />
              <button disabled={!hasPaymentChannel(normalizedContact)} onClick={() => savePaymentContact(contact).catch(fail)} className="rounded-xl bg-sky-600 p-2 font-bold text-white disabled:opacity-50">{rtl ? 'حفظ' : 'Save'}</button>
            </div>
          </div>
          {/* Support Grant Requests */}
          <div className="rounded-2xl border border-amber-200/70 bg-gradient-to-br from-amber-50/50 via-white to-amber-50/20 p-4 shadow-sm dark:border-amber-900/40 dark:from-amber-950/20 dark:via-zinc-900 dark:to-amber-950/10">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Gift className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                <h2 className="font-bold text-slate-800 dark:text-zinc-100">
                  {rtl ? 'طلبات المنح المعلّقة من الدعم' : 'Pending Support Grant Requests'}
                </h2>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800 dark:bg-amber-900/60 dark:text-amber-300">
                  {pendingGrants.length}
                </span>
              </div>
            </div>

            {pendingGrants.length === 0 ? (
              <p className="py-2 text-center text-xs text-slate-400 dark:text-zinc-500">
                {rtl ? 'لا توجد طلبات منح معلّقة حالياً' : 'No pending grant requests'}
              </p>
            ) : (
              <div className="space-y-3">
                {pendingGrants.map(sub => (
                  <article key={sub.id} className="rounded-xl border border-amber-100 bg-white p-4 shadow-xs dark:border-zinc-800 dark:bg-zinc-800/90">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-bold text-slate-900 dark:text-zinc-100">{sub.userName || sub.userEmail}</p>
                        <p className="text-xs text-slate-500 dark:text-zinc-400">{sub.userEmail}</p>
                      </div>
                      <span className="inline-flex items-center rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
                        {PLAN_CONFIG[sub.plan as SubscriptionPlan]?.[rtl ? 'labelAr' : 'labelEn'] || sub.plan}
                      </span>
                    </div>

                    <div className="mt-2.5 space-y-1.5 border-t border-slate-100 pt-2 text-xs dark:border-zinc-700/60">
                      <div className="flex items-center gap-1.5 text-slate-600 dark:text-zinc-300">
                        <span className="text-slate-400 dark:text-zinc-500">{rtl ? 'مقدم الطلب (الدعم):' : 'Requested by:'}</span>
                        <span className="font-semibold">
                          {(sub as any).requestedBy?.name || (sub as any).requestedBy?.email || (rtl ? 'موظف دعم' : 'Support')}
                        </span>
                        {(sub as any).requestedBy?.email && (sub as any).requestedBy?.name && (
                          <span className="text-slate-400">({(sub as any).requestedBy?.email})</span>
                        )}
                      </div>
                      {sub.notes && (
                        <div className="rounded-lg bg-amber-50/70 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                          <span className="font-semibold">{rtl ? 'السبب / الملاحظة: ' : 'Reason: '}</span>
                          {sub.notes}
                        </div>
                      )}
                    </div>

                    <div className="mt-3 flex gap-2">
                      <button
                        disabled={busy === sub.id}
                        onClick={async () => {
                          setBusy(sub.id); setError(''); setNotice('');
                          try {
                            await approveSubscription(sub.id);
                            setNotice(rtl ? 'تمت الموافقة على طلب المنحة وتفعيل الاشتراك' : 'Grant request approved and activated');
                          } catch (err) { fail(err); } finally { setBusy(''); }
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-bold text-white shadow-xs hover:bg-emerald-700 disabled:opacity-50"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        {rtl ? 'موافقة وتفعيل' : 'Approve & Activate'}
                      </button>
                      <button
                        disabled={busy === sub.id}
                        onClick={async () => {
                          if (!window.confirm(rtl ? 'هل أنت متأكد من رفض طلب المنحة؟' : 'Are you sure you want to reject this grant request?')) return;
                          setBusy(sub.id); setError(''); setNotice('');
                          try {
                            await rejectSubscription(sub.id);
                            setNotice(rtl ? 'تم رفض طلب المنحة' : 'Grant request rejected');
                          } catch (err) { fail(err); } finally { setBusy(''); }
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-1.5 text-xs font-bold text-rose-700 hover:bg-rose-100 disabled:opacity-50 dark:border-rose-900/40 dark:bg-rose-950/40 dark:text-rose-300"
                      >
                        <XCircle className="h-3.5 w-3.5" />
                        {rtl ? 'رفض' : 'Reject'}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>

          {/* Super Qi Requests */}
          <div className="rounded-2xl bg-white p-4 dark:bg-zinc-900">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Wallet className="h-5 w-5 text-sky-500" />
                <h2 className="font-bold">{rtl ? 'طلبات Super Qi المعلّقة' : 'Pending Super Qi requests'}</h2>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-700 dark:bg-zinc-800 dark:text-zinc-300">
                  {pendingSuperKey.length}
                </span>
              </div>
            </div>

            {pendingSuperKey.length === 0 ? (
              <p className="py-2 text-center text-xs text-slate-400 dark:text-zinc-500">
                {rtl ? 'لا توجد طلبات Super Qi معلّقة حالياً' : 'No pending Super Qi requests'}
              </p>
            ) : (
              <div className="space-y-3">
                {pendingSuperKey.map(sub => (
                  <article key={sub.id} className="rounded-xl border border-slate-100 p-4 dark:border-zinc-800">
                    <p className="font-bold">{sub.userName || sub.userEmail}</p>
                    <p className="text-xs text-slate-500">{sub.userEmail} · {sub.plan} · {money(sub.amount)}</p>
                    {sub.receiptUrl && (
                      <a href={sub.receiptUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm text-sky-600 underline">
                        {rtl ? 'عرض الإيصال' : 'View receipt'}
                      </a>
                    )}
                    <div className="mt-3 flex gap-2">
                      <button
                        disabled={busy === sub.id}
                        onClick={async () => {
                          setBusy(sub.id); setError(''); setNotice('');
                          try {
                            await approveSubscription(sub.id);
                            setNotice(rtl ? 'تمت الموافقة على الدفع وتفعيل الاشتراك' : 'Payment approved and activated');
                          } catch (err) { fail(err); } finally { setBusy(''); }
                        }}
                        className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        {rtl ? 'موافقة' : 'Approve'}
                      </button>
                      <button
                        disabled={busy === sub.id}
                        onClick={async () => {
                          setBusy(sub.id); setError(''); setNotice('');
                          try {
                            await rejectSubscription(sub.id);
                            setNotice(rtl ? 'تم رفض الطلب' : 'Request rejected');
                          } catch (err) { fail(err); } finally { setBusy(''); }
                        }}
                        className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        {rtl ? 'رفض' : 'Reject'}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
          <details className="rounded-2xl bg-white p-4 dark:bg-zinc-900"><summary className="cursor-pointer font-bold">{rtl ? 'إجراءات السجل القديمة' : 'Legacy entitlement actions'}</summary>
            <div className="mt-3 space-y-2">{legacy.filter(item => !needsManualApproval(item)).slice(0, 50).map(sub => <div key={sub.id} className="flex flex-wrap items-center justify-between gap-2 border-t py-2 text-sm dark:border-zinc-800"><span>{sub.userEmail} · {sub.plan} · {sub.status}</span><span className="flex gap-2">{sub.auditedRecordId ? <span className="text-xs text-slate-500">{rtl ? 'استخدم السجل ← إبطال' : 'Use History → Void'}</span> : sub.status === 'active' && <><button onClick={() => { const days = Number(window.prompt('Days', '30')); if (days) extendSubscription(sub.id, days).catch(fail); }} className="text-sky-600">{rtl ? 'تمديد' : 'Extend'}</button><button onClick={() => cancelSubscription(sub.id).catch(fail)} className="text-red-600">{rtl ? 'إلغاء' : 'Cancel'}</button></>}</span></div>)}</div>
          </details>
        </section>}

        {tab === 'balances' && <section className="space-y-3">
          {!master && ownBalance && <BalanceCard balance={ownBalance} rtl={rtl} />}
          {!master && ledger.length > 0 && <div className="rounded-2xl bg-white p-4 dark:bg-zinc-900"><h3 className="mb-2 font-bold">{rtl ? 'الحركات' : 'Ledger'}</h3>{ledger.map(row => <div key={row.id} className="flex justify-between border-t py-2 text-xs dark:border-zinc-800"><span>{row.type} · {row.referenceCode}</span><span>{row.balanceDelta > 0 ? '+' : ''}{money(row.balanceDelta)}</span></div>)}</div>}
          {master && balances.map(balance => <div key={balance.supportUid} className="rounded-2xl bg-white p-4 dark:bg-zinc-900"><BalanceCard balance={balance} rtl={rtl} />
            <div className="mt-3 flex flex-wrap gap-2">
              {balance.outstanding > 0 && <><button onClick={() => settle(balance, 'receive')} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white">{rtl ? 'استلام جزئي/كامل' : 'Receive partial/full'}</button><button onClick={() => settle(balance, 'reset')} className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-bold text-white">{rtl ? 'تصفير كتسوية' : 'Reset adjustment'}</button></>}
              {balance.outstanding < 0 && <button onClick={() => settle(balance, 'payout')} className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-bold text-white">{rtl ? 'الماستر يدفع للدعم' : 'Master pays Support'}</button>}
            </div>
          </div>)}
          {busy === 'balances' && <Loader2 className="mx-auto h-5 w-5 animate-spin" />}
        </section>}

        {tab === 'reports' && master && <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <select
              value={period}
              onChange={e => setPeriod(e.target.value as any)}
              className="rounded-xl border bg-white p-2.5 text-sm font-semibold dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="today">{rtl ? 'اليوم (Today)' : 'Today'}</option>
              <option value="this_month">{rtl ? 'هذا الشهر (This month)' : 'This month'}</option>
              <option value="last_month">{rtl ? 'الشهر الماضي (Last month)' : 'Last month'}</option>
              <option value="this_year">{rtl ? 'السنة الحالية (This year)' : 'This year'}</option>
            </select>
          </div>

          {reports && (
            <div className="space-y-4">
              <div className="rounded-2xl border-2 border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-transparent p-5 shadow-sm dark:bg-zinc-900">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <span className="inline-block rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                      {rtl ? 'إجمالي سنوي' : 'Yearly Total'}
                    </span>
                    <h3 className="mt-1 text-sm font-medium text-slate-600 dark:text-slate-400">
                      {rtl ? 'إجمالي الإيرادات السنوية' : 'Total Yearly Revenue'}
                    </h3>
                  </div>
                  <p className="text-3xl font-black text-emerald-600 dark:text-emerald-400">
                    {money(reports.yearlyRevenue || 0)}
                  </p>
                </div>
              </div>

              <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
                <table className="w-full text-start text-sm">
                  <thead className="border-b border-slate-100 bg-slate-50 text-xs font-bold text-slate-500 dark:border-zinc-800 dark:bg-zinc-800/50 dark:text-slate-400">
                    <tr>
                      <th className="p-3 text-start">{rtl ? 'الخطة' : 'Plan'}</th>
                      <th className="p-3 text-start">{rtl ? 'عدد الاشتراكات' : 'Subscription count'}</th>
                      <th className="p-3 text-start">{rtl ? 'قيمة الاشتراكات' : 'Total value'}</th>
                      <th className="p-3 text-start">{rtl ? 'عدد المشتركين' : 'Unique subscribers'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-zinc-800">
                    {reportPlans.map(p => {
                      const item = reports.revenue?.planBreakdown?.[p.key] || { count: 0, revenue: 0, uniqueSubscribers: 0 };
                      return (
                        <tr key={p.key} className="hover:bg-slate-50/50 dark:hover:bg-zinc-800/30">
                          <td className="p-3 font-bold text-slate-800 dark:text-slate-200">
                            {rtl ? p.ar : p.en}
                          </td>
                          <td className="p-3 text-slate-600 dark:text-slate-300">
                            {item.count.toLocaleString()}
                          </td>
                          <td className="p-3 font-semibold text-emerald-600 dark:text-emerald-400">
                            {money(item.revenue)}
                          </td>
                          <td className="p-3 text-slate-600 dark:text-slate-300">
                            {item.uniqueSubscribers.toLocaleString()}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="border-t-2 border-slate-200 bg-slate-50/80 font-bold dark:border-zinc-700 dark:bg-zinc-800/80">
                    <tr>
                      <td className="p-3 text-slate-900 dark:text-white">{rtl ? 'الإجمالي' : 'Total'}</td>
                      <td className="p-3 text-slate-900 dark:text-white">
                        {reportPlans.reduce((acc, p) => acc + (reports.revenue?.planBreakdown?.[p.key]?.count || 0), 0).toLocaleString()}
                      </td>
                      <td className="p-3 text-emerald-600 dark:text-emerald-400">
                        {money(reportPlans.reduce((acc, p) => acc + (reports.revenue?.planBreakdown?.[p.key]?.revenue || 0), 0))}
                      </td>
                      <td className="p-3 text-slate-900 dark:text-white">
                        {((reports.revenue as any)?.totalUniqueSubscribers ?? reportPlans.reduce((acc, p) => acc + (reports.revenue?.planBreakdown?.[p.key]?.uniqueSubscribers || 0), 0)).toLocaleString()}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <ReportCard label={rtl ? `إيراد الفترة المحدد (${period})` : `Selected period revenue (${period})`} value={money(reports.revenue.total)} />
                <ReportCard label={rtl ? 'حسب المصدر' : 'By source'} value={Object.entries(reports.revenue.bySource).map(([k, v]) => `${k}: ${money(v as number)}`).join(' · ') || '—'} />
                <ReportCard label={rtl ? 'حسب الخطة' : 'By plan'} value={Object.entries(reports.revenue.byPlan).map(([k, v]) => `${k}: ${money(v as number)}`).join(' · ') || '—'} />
              </div>
            </div>
          )}
          {busy === 'reports' && <Loader2 className="mx-auto h-5 w-5 animate-spin" />}
        </section>}

        {tab === 'expiring' && canExpiring && <section className="space-y-3">
          {expiring.map(item => (
            <article key={item.studentId} className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex justify-between gap-3">
                <div>
                  <p className="font-bold text-slate-900 dark:text-white">{item.studentName}</p>
                  <p className="text-xs text-slate-500">{item.studentEmail}</p>
                </div>
                <div className="text-end text-sm">
                  <p>{dateText(item.expiry)} · {item.daysLeft} {rtl ? 'يوم' : item.daysLeft === 1 ? 'day' : 'days'}</p>
                  <p className="text-xs text-slate-500">{rtl ? 'الوسم' : 'Tag'}: {item.staffTag}</p>
                </div>
              </div>
              {master && (
                <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3 dark:border-zinc-800">
                  <button
                    onClick={() => {
                      setModifyingTarget({
                        studentId: item.studentId,
                        studentEmail: item.studentEmail,
                        studentName: item.studentName,
                        currentExpiry: item.expiry,
                      });
                      setModifyNewDate(item.expiry ? new Date(item.expiry).toISOString().slice(0, 10) : '');
                      setModifyReason('');
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-sky-50 px-3 py-1.5 text-xs font-bold text-sky-700 hover:bg-sky-100 dark:bg-sky-950/40 dark:text-sky-300"
                  >
                    <CalendarClock className="h-3.5 w-3.5" />
                    {rtl ? 'تعديل تاريخ الانتهاء' : 'Modify end date'}
                  </button>
                  <button
                    onClick={() => {
                      setTerminatingTarget({
                        studentId: item.studentId,
                        studentEmail: item.studentEmail,
                        studentName: item.studentName,
                        currentExpiry: item.expiry,
                      });
                      setTerminateImmediate(true);
                      setTerminateCustomDate(item.expiry ? new Date(item.expiry).toISOString().slice(0, 10) : '');
                      setTerminateReason('');
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-700 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300"
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    {rtl ? 'إلغاء الاشتراك' : 'Cancel subscription'}
                  </button>
                </div>
              )}
            </article>
          ))}
          {expiringCursor && <button onClick={() => loadExpiring(true)} className="mx-auto block rounded-xl bg-white px-4 py-2 text-sm dark:bg-zinc-900">{rtl ? 'المزيد' : 'Load more'}</button>}
          {busy === 'expiring' && <Loader2 className="mx-auto h-5 w-5 animate-spin" />}
        </section>}
      </main>

      {showActivation && <Modal title={rtl ? 'تفعيل اشتراك مدفوع' : 'Manual paid activation'} onClose={() => { setShowActivation(false); setActivationRequestId(''); setSelectedActivationStudent(null); }}>
        <StudentSearchDropdown
          value={activationEmail}
          selectedStudent={selectedActivationStudent}
          onSelect={(student, rawEmail) => {
            setSelectedActivationStudent(student);
            setActivationEmail(rawEmail ?? student?.email ?? '');
          }}
          rtl={rtl}
          placeholder={rtl ? 'ابحث باسم الطالب أو البريد...' : 'Search by student name or email...'}
          disabled={busy === 'activate'}
        />
        <div className="grid grid-cols-2 gap-2">
          <select value={activationPlan} onChange={e => setActivationPlan(e.target.value as any)} className="rounded-xl border p-3 dark:border-zinc-700 dark:bg-zinc-800">
            {paymentMethod === 'grant' && <option value="ten_days">{rtl ? '10 أيام (10 Days)' : '10 Days'}</option>}
            <option value="monthly">{rtl ? 'شهري (Monthly)' : 'Monthly'}</option>
            <option value="seasonal">{rtl ? 'فصلي (Seasonal)' : 'Seasonal'}</option>
            <option value="semi_annual">{rtl ? 'نصف سنوي (Semi-annual)' : 'Semi-annual'}</option>
            {paymentMethod === 'grant' && <option value="annual">{rtl ? 'سنوي (Annual)' : 'Annual'}</option>}
          </select>
          <select value={paymentMethod} onChange={e => {
            const nextMethod = e.target.value as ManualPaymentMethod;
            setPaymentMethod(nextMethod);
            if (nextMethod === 'grant') {
              setActivationPlan('ten_days');
            } else if (activationPlan === 'ten_days' || activationPlan === 'annual') {
              setActivationPlan('monthly');
            }
          }} className="rounded-xl border p-3 dark:border-zinc-700 dark:bg-zinc-800">
            <option value="cash">{rtl ? 'نقداً (Cash)' : 'Cash'}</option>
            <option value="zaincash">ZainCash</option>
            <option value="superkey">Super Qi</option>
            <option value="grant">{rtl ? 'منحة (بانتظار الموافقة)' : 'Grant (Pending Approval)'}</option>
            <option value="other">{rtl ? 'أخرى (Other)' : 'Other'}</option>
          </select>
        </div>
        {paymentMethod === 'grant' && (
          <div className="rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
            <div className="flex items-center gap-1.5 font-bold mb-1">
              <Gift className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <span>{rtl ? 'طلب منحة عبر الدعم' : 'Support Grant Request'}</span>
            </div>
            <p>{rtl ? 'سيتم إرسال هذا الطلب إلى الماستر أدمن للموافقة عليه قبل التفعيل (القيمة: صفر).' : 'This request will be submitted to the Master Admin for review & approval before activation (Amount: 0).'}</p>
          </div>
        )}
        <input value={activationNote} maxLength={200} onChange={e => setActivationNote(e.target.value)} placeholder={paymentMethod === 'grant' ? (rtl ? 'سبب طلب المنحة (اختياري)' : 'Grant reason (optional)') : (rtl ? 'ملاحظة اختيارية' : 'Optional note')} className="w-full rounded-xl border p-3 dark:border-zinc-700 dark:bg-zinc-800" />
        {previewing && <Loader2 className="mx-auto h-5 w-5 animate-spin" />}
        {preview && <div className="rounded-xl bg-slate-50 p-3 text-sm dark:bg-zinc-800"><p className="font-bold">{preview.studentName}</p><p>{rtl ? 'الحالة الحالية' : 'Current'}: {preview.isSubscribed ? `${preview.currentPlan} · ${dateText(preview.currentExpiry)}` : (rtl ? 'غير مشترك' : 'Not subscribed')}</p><p>{rtl ? 'السعر' : 'Price'}: {paymentMethod === 'grant' ? (rtl ? '0 د.ع (منحة)' : '0 IQD (Grant)') : money(preview.price)}</p><p>{rtl ? 'الانتهاء الجديد' : 'New expiry'}: {dateText(preview.newExpiry)}</p>{preview.activeWarning && <p className="mt-1 font-bold text-amber-600">{rtl ? 'سيتم تمديد الوقت فوق الاشتراك الفعال.' : 'Time will stack onto the active entitlement.'}</p>}</div>}
        <button onClick={activate} disabled={!activationRequestId || !preview || preview.studentEmail !== activationEmail.trim().toLowerCase() || busy === 'activate'} className={`w-full rounded-xl p-3 font-bold text-white disabled:opacity-40 transition-colors ${paymentMethod === 'grant' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-sky-600 hover:bg-sky-700'}`}>{busy === 'activate' ? '…' : (paymentMethod === 'grant' ? (rtl ? 'إرسال طلب المنحة' : 'Submit grant request') : (rtl ? 'تأكيد التفعيل' : 'Confirm activation'))}</button>
      </Modal>}

      {showGrant && <Modal title={rtl ? 'منح اشتراك مجاني' : 'Grant complimentary subscription'} onClose={() => { setShowGrant(false); setGrantRequestId(''); setSelectedGrantStudent(null); }}>
        <StudentSearchDropdown
          value={grantEmail}
          selectedStudent={selectedGrantStudent}
          onSelect={(student, rawEmail) => {
            setSelectedGrantStudent(student);
            setGrantEmail(rawEmail ?? student?.email ?? '');
          }}
          rtl={rtl}
          placeholder={rtl ? 'ابحث باسم الطالب أو البريد...' : 'Search by student name or email...'}
          disabled={busy === 'grant'}
        />
        <select value={grantPlan} onChange={e => setGrantPlan(e.target.value as SubscriptionPlan)} className="w-full rounded-xl border p-3 dark:border-zinc-700 dark:bg-zinc-800">
          <option value="ten_days">{rtl ? '10 أيام (10 Days)' : '10 Days'}</option>
          <option value="monthly">Monthly</option>
          <option value="seasonal">Seasonal</option>
          <option value="semi_annual">Semi-annual</option>
          <option value="annual">Annual (grant only)</option>
        </select>
        <input value={grantReason} maxLength={200} onChange={e => setGrantReason(e.target.value)} placeholder={rtl ? 'السبب (اختياري)' : 'Reason (optional)'} className="w-full rounded-xl border p-3 dark:border-zinc-700 dark:bg-zinc-800" />
        <p className="text-xs text-slate-500">{rtl ? 'القيمة المسجلة: صفر. الخطة السنوية و10 أيام متاحة في المنح.' : 'Recorded amount: 0. Annual and 10 days are available in grant flows.'}</p>
        <button onClick={grant} disabled={!grantRequestId || !grantEmail.trim() || busy === 'grant'} className="w-full rounded-xl bg-amber-500 p-3 font-bold text-white disabled:opacity-40">{busy === 'grant' ? '…' : (rtl ? 'تأكيد المنح' : 'Confirm grant')}</button>
      </Modal>}

      {modifyingTarget && (
        <Modal
          title={rtl ? 'تعديل تاريخ انتهاء الاشتراك' : 'Modify subscription end date'}
          onClose={() => setModifyingTarget(null)}
        >
          <div className="rounded-xl bg-slate-50 p-3 text-sm dark:bg-zinc-800">
            <p className="font-bold text-slate-900 dark:text-white">{modifyingTarget.studentName}</p>
            <p className="text-xs text-slate-500">{modifyingTarget.studentEmail}</p>
            <p className="mt-1 text-xs">
              {rtl ? 'تاريخ الانتهاء الحالي' : 'Current expiry'}: <span className="font-semibold">{dateText(modifyingTarget.currentExpiry)}</span>
            </p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-400">
              {rtl ? 'تاريخ الانتهاء الجديد' : 'New ending date'}
            </label>
            <input
              type="date"
              value={modifyNewDate}
              onChange={e => setModifyNewDate(e.target.value)}
              className="w-full rounded-xl border p-3 dark:border-zinc-700 dark:bg-zinc-800"
            />
          </div>
          <input
            value={modifyReason}
            maxLength={200}
            onChange={e => setModifyReason(e.target.value)}
            placeholder={rtl ? 'سبب التعديل (اختياري)' : 'Reason for change (optional)'}
            className="w-full rounded-xl border p-3 dark:border-zinc-700 dark:bg-zinc-800"
          />
          <button
            onClick={handleModifyEndDate}
            disabled={!modifyNewDate || busy === 'modify_date'}
            className="w-full rounded-xl bg-sky-600 p-3 font-bold text-white disabled:opacity-40"
          >
            {busy === 'modify_date' ? '…' : (rtl ? 'تأكيد تعديل التاريخ' : 'Confirm date change')}
          </button>
        </Modal>
      )}

      {terminatingTarget && (
        <Modal
          title={rtl ? 'إلغاء اشتراك الطالب' : 'Cancel student subscription'}
          onClose={() => setTerminatingTarget(null)}
        >
          <div className="rounded-xl bg-slate-50 p-3 text-sm dark:bg-zinc-800">
            <p className="font-bold text-slate-900 dark:text-white">{terminatingTarget.studentName}</p>
            <p className="text-xs text-slate-500">{terminatingTarget.studentEmail}</p>
            <p className="mt-1 text-xs">
              {rtl ? 'تاريخ الانتهاء الحالي' : 'Current expiry'}: <span className="font-semibold">{dateText(terminatingTarget.currentExpiry)}</span>
            </p>
          </div>
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs leading-relaxed text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
            {rtl
              ? 'سيتم إلغاء الاشتراك فوراً، وتعطيل وصول الطالب، وخصم قيمة الاشتراك من التقارير المالية (الاشتراكات الممنوحة مجاناً لا تتضمن أي خصم لأن قيمتها 0).'
              : 'The subscription will be cancelled immediately, student access revoked, and its value deducted from financial reports (complimentary grants incur 0 deduction).'}
          </div>
          <input
            value={terminateReason}
            maxLength={200}
            onChange={e => setTerminateReason(e.target.value)}
            placeholder={rtl ? 'سبب الإلغاء (اختياري)' : 'Cancellation reason (optional)'}
            className="w-full rounded-xl border p-3 text-sm dark:border-zinc-700 dark:bg-zinc-800"
          />
          <button
            onClick={handleTerminate}
            disabled={busy === 'terminate'}
            className="w-full rounded-xl bg-rose-600 p-3 font-bold text-white hover:bg-rose-700 disabled:opacity-40"
          >
            {busy === 'terminate' ? '…' : (rtl ? 'تأكيد إلغاء الاشتراك' : 'Confirm cancellation')}
          </button>
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose(): void; children: React.ReactNode }) {
  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" onClick={onClose}><div className="w-full max-w-md space-y-3 rounded-2xl bg-white p-5 shadow-xl dark:bg-zinc-900" onClick={e => e.stopPropagation()}><div className="flex items-center justify-between"><h2 className="font-bold">{title}</h2><button onClick={onClose}><X className="h-5 w-5" /></button></div>{children}</div></div>;
}

function BalanceCard({ balance, rtl }: { balance: SupportBalance; rtl: boolean }) {
  const meaning = balance.outstanding > 0
    ? (rtl ? 'على موظف الدعم تسليم هذا المبلغ' : 'Support must hand over this amount')
    : balance.outstanding < 0
      ? (rtl ? 'مبلغ مستحق لموظف الدعم' : 'Credit owed to Support')
      : (rtl ? 'تمت التسوية' : 'Settled');
  return <div><div className="flex items-start justify-between gap-3"><div><p className="font-bold">{balance.supportName || balance.supportEmail || balance.supportUid}{balance.staffDisabled && <span className="ms-2 rounded-full bg-red-100 px-2 py-0.5 text-[10px] text-red-700">{rtl ? 'معطّل' : 'Disabled'}</span>}{balance.removed && <span className="ms-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">{rtl ? 'دعم سابق' : 'Former Support'}</span>}</p><p className="text-xs text-slate-500">{meaning}</p></div><p className={`text-lg font-black ${balance.outstanding < 0 ? 'text-violet-600' : balance.outstanding > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>{balance.outstanding < 0 ? '−' : ''}{money(balance.outstanding)}</p></div><div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-500 md:grid-cols-5"><span>Credited {money(balance.totalCredited)}</span><span>Received {money(balance.totalReceived)}</span><span>Reset {money(balance.totalReset)}</span><span>Reversed {money(balance.totalReversed)}</span><span>Paid out {money(balance.totalPaidOut)}</span></div></div>;
}

function ReportCard({ label, value }: { label: string; value: string }) {
  return <div className="rounded-2xl bg-white p-4 dark:bg-zinc-900"><BarChart3 className="mb-2 h-5 w-5 text-sky-500" /><p className="text-xs text-slate-500">{label}</p><p className="mt-1 font-bold">{value}</p></div>;
}
