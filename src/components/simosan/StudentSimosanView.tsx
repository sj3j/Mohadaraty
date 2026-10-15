import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Camera, CheckCircle2, ChevronDown, Clock3, CloudOff, Loader2, LogIn, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { attendanceWeekNumber, attendanceWeekStart, canonicalAttendanceState, type AttendanceMine, type LocalAttendanceReceipt } from '../../../shared/attendance';
import type { Language, UserProfile } from '../../types';
import {
  captureAttendanceQr,
  getMyAttendance,
  listLocalAttendanceReceipts,
  subscribeAttendanceChanges,
  syncAttendanceReceipts,
} from '../../services/attendanceService';
import QrScannerModal from './QrScannerModal';

interface StudentSimosanViewProps {
  user: UserProfile;
  lang: Language;
}

const dateInBaghdad = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Baghdad' });

export default function StudentSimosanView({ user, lang }: StudentSimosanViewProps) {
  const isRtl = lang === 'ar';
  const [scannerOpen, setScannerOpen] = useState(false);
  const [local, setLocal] = useState<LocalAttendanceReceipt[]>([]);
  const [mine, setMine] = useState<AttendanceMine | null>(null);
  const [ready, setReady] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [openWeek, setOpenWeek] = useState('');

  const hydrateLocal = useCallback(async () => {
    try {
      setLocal(await listLocalAttendanceReceipts(user.uid));
    } finally {
      setReady(true);
    }
  }, [user.uid]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError('');
    try {
      await syncAttendanceReceipts(user.uid);
      await hydrateLocal();
      setMine(await getMyAttendance(user.uid));
    } catch (refreshError: any) {
      setError(refreshError?.message === 'login_required'
        ? (isRtl ? 'يلزم تسجيل الدخول للمزامنة. الدليل المحفوظ لم يُحذف.' : 'Sign in to sync. Saved evidence was not deleted.')
        : (isRtl ? 'تعذّر التحديث الآن. سيبقى الدليل محفوظاً على هذا الجهاز.' : 'Unable to refresh. Evidence remains saved on this device.'));
    } finally {
      setRefreshing(false);
    }
  }, [hydrateLocal, isRtl, user.uid]);

  useEffect(() => {
    void hydrateLocal().then(refresh);
    return subscribeAttendanceChanges(() => { void hydrateLocal(); });
  }, [hydrateLocal, refresh]);

  const handleScan = useCallback(async (value: string) => {
    setScannerOpen(false);
    setError('');
    try {
      const { receipt, alreadySaved } = await captureAttendanceQr(value);
      await hydrateLocal();
      setNotice(alreadySaved
        ? (isRtl ? `هذا المسح محفوظ مسبقاً — رقم الإيصال ${receipt.requestId}` : `Already saved — receipt ${receipt.requestId}`)
        : (isRtl ? `تم الحفظ على هذا الجهاز — بانتظار المزامنة. رقم الإيصال ${receipt.requestId}` : `Saved on this device — pending sync. Receipt ${receipt.requestId}`));
      void refresh();
    } catch (scanError: any) {
      setError(scanError?.message === 'login_required'
        ? (isRtl ? 'سجّل الدخول قبل المسح حتى يُربط الإيصال بصاحبه الصحيح.' : 'Sign in before scanning so the receipt is bound to the correct account.')
        : scanError?.message === 'attendance_not_saved'
          ? (isRtl ? 'لم يُحفظ الإيصال: مساحة التخزين غير متاحة أو ممتلئة. التقط صورة للرمز واطلب إثباتاً يدوياً من الأستاذ.' : 'Receipt was not saved: storage is unavailable or full. Photograph the code and request manual confirmation.')
          : (isRtl ? 'هذا ليس رمز حضور صالحاً. لم يتم حفظ شيء.' : 'This is not a valid attendance code. Nothing was saved.'));
    }
  }, [hydrateLocal, isRtl, refresh]);

  const occurrences = useMemo(() => {
    const map = new Map<string, any>();
    for (const occurrence of mine?.occurrences || []) map.set(occurrence.id, occurrence);
    for (const session of mine?.sessions || []) map.set(session.occurrence.id, session.occurrence);
    for (const receipt of local) {
      if (!map.has(receipt.occurrenceId) && receipt.occurrence) {
        map.set(receipt.occurrenceId, {
          ...receipt.occurrence,
          termId: '', timetableSessionId: '', startAt: `${receipt.occurrence.lectureDate}T${receipt.occurrence.startTime}:00+03:00`,
          endAt: `${receipt.occurrence.lectureDate}T${receipt.occurrence.endTime}:00+03:00`, day: 0, audienceGroups: [],
        });
      }
    }
    return [...map.values()].sort((a, b) => a.startAt.localeCompare(b.startAt));
  }, [local, mine]);
  const sessionsByOccurrence = useMemo(() => new Map((mine?.sessions || []).map(session => [session.occurrenceId, session])), [mine]);
  const recordsBySession = useMemo(() => new Map((mine?.records || []).map(record => [record.sessionId, record])), [mine]);
  const localByOccurrence = useMemo(() => new Map(local.map(receipt => [receipt.occurrenceId, receipt])), [local]);
  const serverDate = mine ? dateInBaghdad(mine.serverNow) : '';
  const currentWeek = serverDate ? attendanceWeekStart(serverDate) : '';

  const weeks = useMemo(() => {
    const grouped = new Map<string, any[]>();
    for (const occurrence of occurrences) {
      const key = attendanceWeekStart(occurrence.lectureDate);
      grouped.set(key, [...(grouped.get(key) || []), occurrence]);
    }
    return [...grouped.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [occurrences]);

  useEffect(() => {
    if (!openWeek && currentWeek) setOpenWeek(currentWeek);
  }, [currentWeek, openWeek]);

  const statusFor = (occurrence: any) => {
    const session = sessionsByOccurrence.get(occurrence.id);
    const record = session ? recordsBySession.get(session.id) : undefined;
    const receipt = localByOccurrence.get(occurrence.id);
    const state = canonicalAttendanceState(record, receipt);
    if (state !== 'none') return state;
    return session?.status === 'finalized' ? 'absent' : 'upcoming';
  };

  const statusUi = (state: string) => {
    if (state === 'confirmed') return { label: isRtl ? 'مؤكد' : 'Confirmed', icon: CheckCircle2, cls: 'text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/40' };
    if (state === 'absent' || state === 'voided') return { label: isRtl ? 'غائب' : 'Absent', icon: XCircle, cls: 'text-red-700 bg-red-50 dark:text-red-300 dark:bg-red-950/40' };
    if (state === 'syncing') return { label: isRtl ? 'تتم المزامنة' : 'Syncing', icon: RefreshCw, cls: 'text-sky-700 bg-sky-50 dark:text-sky-300 dark:bg-sky-950/40' };
    if (state === 'login_required') return { label: isRtl ? 'يلزم تسجيل الدخول' : 'Login required', icon: LogIn, cls: 'text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/40' };
    if (state === 'review') return { label: isRtl ? 'قيد المراجعة' : 'Under review', icon: AlertTriangle, cls: 'text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/40' };
    if (state === 'invalid') return { label: isRtl ? 'يحتاج مساعدة' : 'Needs help', icon: AlertTriangle, cls: 'text-red-700 bg-red-50 dark:text-red-300 dark:bg-red-950/40' };
    if (state === 'pending') return { label: isRtl ? 'محفوظ محلياً' : 'Saved locally', icon: CloudOff, cls: 'text-violet-700 bg-violet-50 dark:text-violet-300 dark:bg-violet-950/40' };
    return { label: isRtl ? 'قادمة' : 'Upcoming', icon: Clock3, cls: 'text-slate-600 bg-slate-100 dark:text-slate-300 dark:bg-zinc-800' };
  };

  if (!ready) return <div className="flex justify-center py-16"><Loader2 className="h-7 w-7 animate-spin text-sky-600" /></div>;

  return (
    <div className="space-y-4" dir={isRtl ? 'rtl' : 'ltr'}>
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-zinc-700 dark:bg-zinc-800">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="mb-1 flex items-center gap-2 text-sm font-black text-emerald-700 dark:text-emerald-300"><ShieldCheck className="h-5 w-5" />{isRtl ? 'حضور موثوق حتى دون اتصال' : 'Reliable offline attendance'}</div>
            <p className="text-sm leading-6 text-slate-500 dark:text-slate-400">{isRtl ? 'يُحفظ الإيصال أولاً على الجهاز، ثم تتم مزامنته تلقائياً. الأخضر يعني تأكيد الخادم فقط.' : 'The receipt is saved on-device first, then synced automatically. Green means server-confirmed only.'}</p>
          </div>
          <button onClick={() => void refresh()} disabled={refreshing} className="rounded-full p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-zinc-700"><RefreshCw className={`h-5 w-5 ${refreshing ? 'animate-spin' : ''}`} /></button>
        </div>
        <button onClick={() => setScannerOpen(true)} className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-sky-600 px-4 py-3.5 font-black text-white shadow-lg shadow-sky-600/20 active:scale-[0.99]">
          <Camera className="h-5 w-5" /> {isRtl ? 'مسح رمز الحضور' : 'Scan attendance QR'}
        </button>
      </section>

      {notice && <div className="break-words rounded-2xl border border-violet-200 bg-violet-50 p-4 text-sm font-bold text-violet-800 dark:border-violet-900 dark:bg-violet-950/30 dark:text-violet-200">{notice}</div>}
      {error && <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">{error}</div>}

      <section className="space-y-3">
        <h2 className="px-1 text-lg font-black text-slate-900 dark:text-white">{isRtl ? 'السجل الأسبوعي' : 'Weekly schedule'}</h2>
        {weeks.length === 0 && <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-zinc-700">{isRtl ? 'لا توجد محاضرات متاحة في الجدول حالياً.' : 'No timetable lectures are available yet.'}</div>}
        {weeks.map(([week, items], index) => {
          const expanded = openWeek === week;
          const confirmed = items.filter(item => statusFor(item) === 'confirmed').length;
          const completed = items.filter(item => ['confirmed', 'absent', 'voided'].includes(statusFor(item))).length;
          const academicWeek = mine?.term ? attendanceWeekNumber(mine.term as any, week) : weeks.length - index;
          return (
            <div key={week} className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-zinc-700 dark:bg-zinc-800">
              <button onClick={() => setOpenWeek(expanded ? '' : week)} className="flex w-full items-center justify-between gap-3 p-4 text-start">
                <div><div className="font-black">{isRtl ? `الأسبوع ${academicWeek}` : `Week ${academicWeek}`}</div><div className="mt-1 text-xs text-slate-500">{isRtl ? `حضر ${confirmed} من ${completed || items.length} محاضرات` : `Attended ${confirmed} of ${completed || items.length} lectures`}</div></div>
                <ChevronDown className={`h-5 w-5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
              </button>
              {expanded && <div className="border-t border-slate-100 dark:border-zinc-700">
                {items.map(item => {
                  const state = statusFor(item);
                  const ui = statusUi(state);
                  const Icon = ui.icon;
                  const receipt = localByOccurrence.get(item.id);
                  return <div key={item.id} className="flex items-center justify-between gap-3 border-b border-slate-100 p-4 last:border-0 dark:border-zinc-700/70">
                    <div className="min-w-0"><div className="truncate font-bold">{item.title}</div><div className="mt-1 text-xs text-slate-500">{item.lectureDate} · {item.startTime}–{item.endTime}</div>{receipt && state !== 'confirmed' && <div className="mt-1 break-all text-[10px] text-slate-400">{isRtl ? 'إيصال' : 'Receipt'}: {receipt.requestId}</div>}</div>
                    <span className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-black ${ui.cls}`}><Icon className={`h-3.5 w-3.5 ${state === 'syncing' ? 'animate-spin' : ''}`} />{ui.label}</span>
                  </div>;
                })}
              </div>}
            </div>
          );
        })}
      </section>
      {scannerOpen && <QrScannerModal lang={lang} onScan={handleScan} onClose={() => setScannerOpen(false)} />}
    </div>
  );
}
