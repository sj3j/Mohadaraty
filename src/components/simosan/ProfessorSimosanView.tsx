import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { AlertTriangle, CheckCircle2, Expand, Loader2, Printer, QrCode, RefreshCw, Search, Square, Trash2, UserPlus, XCircle } from 'lucide-react';
import type { AttendanceBootstrap, AttendanceSessionSnapshot } from '../../../shared/attendance';
import type { Language } from '../../types';
import {
  createAttendanceSession,
  getAttendanceBootstrap,
  getAttendanceSessionSnapshot,
  markAttendanceManually,
  resolveAttendanceReview,
  setAttendanceRecordStatus,
  updateAttendanceSession,
  cancelAttendanceSession,
  createOfflineAttendanceSession,
  getOfflineAttendancePack,
  ensureOfflineAttendancePrepared,
  listDoctorAttendanceCommands,
  subscribeAttendanceChanges,
  type DoctorAttendanceCommand,
} from '../../services/attendanceService';
import { attendanceFlagLabel, attendanceLocationBadge } from '../../../shared/attendanceSecurity';
import { secureRequestId } from '../../lib/secureRandom';
import AttendanceQrDisplay from '../attendance/AttendanceQrDisplay';

interface ProfessorSimosanViewProps {
  lang: Language;
  stageId: string;
  ownerUid: string;
}

const newId = () => secureRequestId();

export default function ProfessorSimosanView({ lang, stageId, ownerUid }: ProfessorSimosanViewProps) {
  const isRtl = lang === 'ar';
  const [bootstrap, setBootstrap] = useState<AttendanceBootstrap | null>(null);
  const [occurrenceId, setOccurrenceId] = useState('');
  const [headcount, setHeadcount] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [qrToken, setQrToken] = useState('');
  const [qrImage, setQrImage] = useState('');
  const [snapshot, setSnapshot] = useState<AttendanceSessionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [recordFilter, setRecordFilter] = useState<'all' | 'review'>('all');
  const [offlineReady, setOfflineReady] = useState(false);
  const [commands, setCommands] = useState<DoctorAttendanceCommand[]>([]);
  const requestIdRef = useRef(newId());
  const projectorRef = useRef<HTMLDivElement>(null);
  const lastSessionRef = useRef('');
  const notesDirtyRef = useRef(false);
  const latestNotesRef = useRef(notes);
  latestNotesRef.current = notes;

  const refreshSnapshot = useCallback(async () => {
    if (!sessionId) return;
    try {
      const next = await getAttendanceSessionSnapshot(sessionId, ownerUid);
      setSnapshot(next);
      if (!notesDirtyRef.current) setNotes(next.session.notes);
      if (lastSessionRef.current !== next.session.id) {
        lastSessionRef.current = next.session.id;
        setNotes(next.session.notes);
        setHeadcount(next.session.physicalHeadcount);
      }
      setError('');
    } catch {
      setError(isRtl ? 'تعذر تحديث قائمة الحضور. ستتم المحاولة تلقائياً.' : 'Could not refresh attendance. Retrying automatically.');
    }
  }, [isRtl, sessionId, ownerUid]);

  useEffect(() => {
    let active = true;
    const reload = () => void listDoctorAttendanceCommands(ownerUid).then(items => { if (active) setCommands(items); }).catch(() => undefined);
    reload();
    const stop = subscribeAttendanceChanges(reload);
    void ensureOfflineAttendancePrepared(stageId, ownerUid).then(pack => { if (active) setOfflineReady(!!pack); });
    return () => { active = false; stop(); };
  }, [ownerUid, stageId]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    getAttendanceBootstrap(stageId, ownerUid).then(data => {
      if (!live) return;
      setBootstrap(data);
      const today = new Date(data.serverNow).toLocaleDateString('en-CA', { timeZone: data.timezone });
      const preferred = data.occurrences.find(item => item.lectureDate === today) || data.occurrences[data.occurrences.length - 1];
      setOccurrenceId(preferred?.id || '');
    }).catch(() => setError(isRtl ? 'تعذر تحميل جدول الحضور.' : 'Could not load attendance timetable.')).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [isRtl, stageId, ownerUid]);

  useEffect(() => {
    if (!sessionId) return;
    void refreshSnapshot();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshSnapshot();
    }, 10000);
    const visible = () => { if (document.visibilityState === 'visible') void refreshSnapshot(); };
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refreshSnapshot, sessionId]);

  useEffect(() => {
    if (!qrToken) return setQrImage('');
    QRCode.toDataURL(qrToken, { width: 700, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
      .then(setQrImage)
      .catch(() => setError(isRtl ? 'تعذر رسم رمز الحضور.' : 'Could not render attendance QR.'));
  }, [isRtl, qrToken]);

  useEffect(() => {
    if (!snapshot || !notesDirtyRef.current || notes === snapshot.session.notes || notes.length > 2000) return;
    const timer = window.setTimeout(async () => {
      try {
        await updateAttendanceSession(snapshot.session.id, {
          requestId: newId(), expectedRevision: snapshot.session.revision, notes, reason: '',
        }, ownerUid);
        if (latestNotesRef.current === notes) notesDirtyRef.current = false;
        await refreshSnapshot();
      } catch (saveError: any) {
        if (saveError?.message === 'revision_conflict') await refreshSnapshot();
        else setError(isRtl ? 'لم تُحفظ الملاحظات بعد. ستبقى ظاهرة لإعادة المحاولة.' : 'Notes are not saved yet. They remain visible for retry.');
      }
    }, 900);
    return () => clearTimeout(timer);
  }, [isRtl, notes, refreshSnapshot, snapshot, ownerUid]);

  const startSession = async () => {
    if (!occurrenceId) return;
    setBusy(true);
    setError('');
    try {
      const input = {
        stageId, occurrenceId, physicalHeadcount: headcount, notes, requestId: requestIdRef.current,
      };
      let created;
      let createdOffline = false;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        created = await createOfflineAttendanceSession(input, ownerUid);
        createdOffline = true;
      } else {
        try {
          created = await createAttendanceSession(input);
        } catch (failure: any) {
          const retryable = Number(failure?.status) >= 500
            || /fetch|network|timeout|temporarily_unavailable/i.test(String(failure?.message || ''));
          if (!offlineReady || !retryable) throw failure;
          created = await createOfflineAttendanceSession(input, ownerUid);
          createdOffline = true;
        }
      }
      setSessionId(created.sessionId);
      setQrToken(created.qrToken);
      if (createdOffline && notes) await updateAttendanceSession(created.sessionId, { notes, requestId: newId(), reason: '' }, ownerUid);
    } catch (startError: any) {
      setError(startError?.message === 'attendance_not_configured'
        ? (isRtl ? 'خدمة الحضور غير مهيأة على الخادم.' : 'Attendance backend is not configured.')
        : (isRtl ? 'تعذر بدء الجلسة. أعد المحاولة دون تغيير المحاضرة.' : 'Could not start the session. Retry without changing the lecture.'));
    } finally {
      setBusy(false);
    }
  };

  const saveHeadcount = async () => {
    if (!snapshot || headcount === snapshot.session.physicalHeadcount) return;
    try {
      await updateAttendanceSession(snapshot.session.id, {
        requestId: newId(), expectedRevision: snapshot.session.revision, physicalHeadcount: headcount, reason: '',
      }, ownerUid);
      await refreshSnapshot();
    } catch {
      await refreshSnapshot();
      setError(isRtl ? 'تعذر حفظ العدد؛ تم استرجاع آخر قيمة مؤكدة.' : 'Headcount was not saved; the last confirmed value was restored.');
    }
  };

  const mutate = async (operation: () => Promise<any>) => {
    if (!snapshot) return;
    setBusy(true);
    try {
      await operation();
      await refreshSnapshot();
    } catch (mutationError: any) {
      if (mutationError?.message === 'revision_conflict') {
        await refreshSnapshot();
        setError(isRtl ? 'تغيرت القائمة على جهاز آخر. تم تحديثها؛ راجع القيم قبل إعادة الإجراء.' : 'The roster changed elsewhere. Review the refreshed values before retrying.');
      } else setError(isRtl ? 'تعذر إكمال الإجراء. المسودات المحفوظة باقية؛ تحقق من الاتصال والصلاحيات وأعد المحاولة.' : 'Could not complete this action. Saved drafts remain; check connectivity and permissions, then retry.');
    } finally {
      setBusy(false);
    }
  };

  const filteredRoster = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query || !snapshot) return [];
    const recorded = new Set(snapshot.records.filter(item => item.status === 'confirmed').map(item => item.rosterStudentId));
    for (const command of commands) if (command.kind !== 'import' && command.sessionId === sessionId && command.status === 'pending') recorded.add(String(command.input.studentId));
    return snapshot.roster.filter(student => !recorded.has(student.studentId)
      && (student.officialName.toLocaleLowerCase().includes(query) || student.rosterIdentifier.toLocaleLowerCase().includes(query))).slice(0, 8);
  }, [search, snapshot, commands, sessionId]);

  const filteredRecords = useMemo(() => {
    if (!snapshot) return [];
    const records = recordFilter === 'review'
      ? snapshot.records.filter(record => record.reviewFlags.length > 0)
      : snapshot.records;
    return [...records].sort((first, second) =>
      Number(second.reviewFlags.length > 0) - Number(first.reviewFlags.length > 0)
      || first.receivedAt.localeCompare(second.receivedAt));
  }, [recordFilter, snapshot]);

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="h-7 w-7 animate-spin text-sky-600" /></div>;

  return (
    <div className="space-y-4" dir={isRtl ? 'rtl' : 'ltr'}>
      <section className="rounded-2xl border border-teal-200 bg-teal-50 p-4 dark:border-teal-900 dark:bg-teal-950/30">
        <p className="text-sm font-bold">{offlineReady ? (isRtl ? 'الجدول وقائمة الدفعة محفوظان للعمل دون اتصال' : 'Timetable and full cohort saved for offline use') : (isRtl ? 'جهّز الجهاز أثناء الاتصال قبل الذهاب للقاعة' : 'Prepare this device online before going to the classroom')}</p>
        <p className="mt-2 text-xs font-bold text-teal-800 dark:text-teal-200">{offlineReady ? (isRtl ? 'يُحدّث تلقائياً عند توفر الاتصال.' : 'It refreshes automatically whenever connectivity is available.') : (isRtl ? 'اتصل بالإنترنت مرة واحدة ليُجهز الجهاز تلقائياً.' : 'Connect once so this device can prepare automatically.')}</p>
        <p className="mt-2 text-xs text-slate-500">{isRtl ? 'عند انقطاع الإنترنت تظهر التسجيلات اليدوية هنا فوراً؛ إيصالات الطلاب تظهر بعد مزامنتها. مهلة الإرسال ٣٦ ساعة من النهاية المجدولة.' : 'Offline manual entries appear immediately. Student receipts appear after synchronization. Upload deadline: scheduled end + 36 hours.'}</p>
      </section>
      {!sessionId && <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-zinc-700 dark:bg-zinc-800">
        <h2 className="text-lg font-black">{isRtl ? 'بدء جلسة حضور' : 'Start attendance session'}</h2>
        <div className="mt-4 space-y-3">
          <label className="block text-sm font-bold text-slate-600 dark:text-slate-300">{isRtl ? 'المحاضرة المؤرخة' : 'Dated lecture occurrence'}</label>
          <select value={occurrenceId} onChange={event => { setOccurrenceId(event.target.value); requestIdRef.current = newId(); }} className="w-full rounded-xl border border-slate-200 bg-white p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            {(bootstrap?.occurrences || []).map(item => <option key={item.id} value={item.id}>{item.lectureDate} · {item.startTime} · {item.title}</option>)}
          </select>
          <label className="block text-sm font-bold text-slate-600 dark:text-slate-300">{isRtl ? 'عدد الموجودين المتوقع' : 'Expected hall headcount'}</label>
          <input type="number" min={0} max={10000} value={headcount ?? ''} onChange={event => setHeadcount(event.target.value === '' ? null : Number(event.target.value))} className="w-full rounded-xl border border-slate-200 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-900" />
          <label className="block text-sm font-bold text-slate-600 dark:text-slate-300">{isRtl ? 'ملاحظات' : 'Notes'}</label>
          <textarea value={notes} onChange={event => { notesDirtyRef.current = true; setNotes(event.target.value); }} maxLength={2000} className="min-h-24 w-full rounded-xl border border-slate-200 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-900" />
          <button onClick={startSession} disabled={busy || !occurrenceId} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-sky-600 px-4 py-3 font-black text-white disabled:opacity-50"><QrCode className="h-5 w-5" />{busy ? (isRtl ? 'جارٍ البدء...' : 'Starting...') : (isRtl ? 'إنشاء رمز الحضور' : 'Create attendance QR')}</button>
        </div>
      </section>}

      {error && <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">{error}</div>}

      {sessionId && <>
        <button onClick={() => { setSessionId(''); setSnapshot(null); setQrToken(''); requestIdRef.current = newId(); }} className="text-sm font-bold text-teal-700">{isRtl ? 'اختيار محاضرة أخرى' : 'Choose another lecture'}</button>
        <section ref={projectorRef} className="rounded-3xl border border-slate-200 bg-white p-5 text-center shadow-sm fullscreen:flex fullscreen:flex-col fullscreen:items-center fullscreen:justify-center dark:border-zinc-700 dark:bg-zinc-800">
          <div className="mb-3 flex items-center justify-between text-start">
            <div><h2 className="font-black">{snapshot?.session.occurrence.title || (isRtl ? 'جلسة الحضور' : 'Attendance session')}</h2><p className="text-xs text-slate-500">{snapshot?.session.occurrence.lectureDate} · {snapshot?.session.occurrence.startTime}</p></div>
            <button onClick={() => projectorRef.current?.requestFullscreen()} className="rounded-full p-2 hover:bg-slate-100 dark:hover:bg-zinc-700" title={isRtl ? 'ملء الشاشة' : 'Fullscreen'}><Expand className="h-5 w-5" /></button>
          </div>
          {snapshot?.session.status !== 'active' && snapshot ? <p>{isRtl ? 'أُغلق عرض الرمز' : 'QR display closed'}</p> : qrToken ? <AttendanceQrDisplay token={qrToken} title={snapshot?.session.occurrence.title || (isRtl ? 'جلسة الحضور' : 'Attendance session')} subtitle={`${snapshot?.session.occurrence.lectureDate || ''} · ${snapshot?.session.occurrence.startTime || ''}`} countLabel={snapshot ? (snapshot.session.physicalHeadcount == null ? `${snapshot.counts.confirmed}` : `${snapshot.counts.confirmed} / ${snapshot.session.physicalHeadcount}`) : undefined} isRtl={isRtl} unavailableLabel={isRtl ? 'تعذر عرض الرمز' : 'Could not display QR'} /> : <Loader2 className="mx-auto my-20 h-8 w-8 animate-spin" />}
          <p className="mt-3 text-xs font-bold text-slate-500">{isRtl ? 'لا يعتمد الرمز على ساعة جهاز الطالب.' : 'This code does not depend on the student device clock.'}</p>
        </section>

        {snapshot && <>
          {commands.filter(command => command.sessionId === sessionId && command.kind === 'session_update' && command.status !== 'synced').map(command => <div key={command.requestId} className="rounded-xl border border-amber-300 p-3 text-sm">
            {command.status === 'pending' ? (isRtl ? 'تعديل الجلسة محفوظ — بانتظار المزامنة' : 'Session edit saved — pending synchronization') : (isRtl ? 'تعارض في تعديل الجلسة؛ البيانات التالية محفوظة ولم تُحذف. راجع القيم وأعد إدخال التعديل المطلوب.' : 'Session edit conflict. These saved values were not discarded; review and re-enter the intended change.')}
            <p className="mt-1 whitespace-pre-wrap">{String(command.input.notes ?? command.input.physicalHeadcount ?? command.input.status ?? '')}</p>
          </div>)}
          {snapshot.offline && <div role="status" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{isRtl ? 'قائمة محفوظة دون اتصال — ليست عدداً مباشراً للماسحين' : 'Cached offline roster — not a live scan count'}</div>}
          {snapshot.session.status === 'ended' && !snapshot.offline && Date.parse(snapshot.serverNow) > Date.parse(snapshot.session.reconciliationDeadline) && !snapshot.reviewReceipts.length && <button disabled={busy} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-bold" onClick={() => {
            const reason = prompt(isRtl ? 'سبب اعتماد القائمة النهائية (سوف يظهر الغياب لمن لم يسجل)' : 'Finalization reason (students without evidence will be shown absent)');
            if (reason) void mutate(() => updateAttendanceSession(sessionId, { requestId: newId(), status: 'finalized', reason }, ownerUid));
          }}>{isRtl ? 'اعتماد القائمة النهائية' : 'Finalize attendance'}</button>}
          {commands.filter(command => command.sessionId === sessionId && command.kind !== 'import' && command.kind !== 'session_update' && command.status !== 'synced').map(command => <div key={command.requestId} className="rounded-xl border border-amber-300 p-3 text-sm">
            <strong>{snapshot.roster.find(student => student.studentId === command.input.studentId)?.officialName}</strong> · {command.status === 'pending' ? (isRtl ? 'تسجيل يدوي محفوظ على الجهاز — بانتظار المزامنة' : 'Manual attendance saved on device — pending synchronization') : (isRtl ? 'التسجيل محفوظ لكن يحتاج معالجة الأستاذ' : 'Saved entry needs lecturer attention')}
          </div>)}
          {snapshot.counts.discrepancy > 0 && snapshot.session.physicalHeadcount != null && <div className="rounded-2xl border-2 border-red-300 bg-red-50 p-4 text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200"><div className="flex items-center gap-2 font-black"><AlertTriangle className="h-5 w-5" />{isRtl ? `تنبيه فرق العدد: ${snapshot.counts.confirmed} / ${snapshot.session.physicalHeadcount}` : `Headcount discrepancy: ${snapshot.counts.confirmed} / ${snapshot.session.physicalHeadcount}`}</div><p className="mt-1 text-xs">{isRtl ? 'هذا تنبيه على مستوى الجلسة، ولا يلغي حضور أي طالب تلقائياً.' : 'This is a session-level warning and never voids a student automatically.'}</p></div>}

          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-zinc-700 dark:bg-zinc-800">
            <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-black">{isRtl ? 'القائمة المباشرة' : 'Live roster'}</h2><p className="text-sm text-slate-500">{snapshot.counts.confirmed}{snapshot.session.physicalHeadcount == null ? '' : ` / ${snapshot.session.physicalHeadcount}`} · {isRtl ? 'آخر تحديث' : 'Updated'} {new Date(snapshot.serverNow).toLocaleTimeString(lang === 'ar' ? 'ar-IQ' : 'en-GB')}</p></div><div className="flex gap-1"><button onClick={() => window.print()} className="rounded-full p-2 hover:bg-slate-100 dark:hover:bg-zinc-700" title={isRtl ? 'طباعة قائمة احتياطية' : 'Print contingency roster'}><Printer className="h-5 w-5" /></button><button onClick={() => void refreshSnapshot()} className="rounded-full p-2 hover:bg-slate-100 dark:hover:bg-zinc-700"><RefreshCw className="h-5 w-5" /></button></div></div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div><label className="text-xs font-bold text-slate-500">{isRtl ? 'عدد القاعة' : 'Hall count'}</label><input type="number" min={0} value={headcount ?? ''} onChange={event => setHeadcount(event.target.value === '' ? null : Number(event.target.value))} onBlur={saveHeadcount} className="mt-1 w-full rounded-xl border border-slate-200 bg-white p-2.5 dark:border-zinc-700 dark:bg-zinc-900" /></div>
              <div><label className="text-xs font-bold text-slate-500">{isRtl ? 'ملاحظات — تحفظ تلقائياً' : 'Notes — auto-saved'}</label><input value={notes} onChange={event => { notesDirtyRef.current = true; setNotes(event.target.value); }} maxLength={2000} className="mt-1 w-full rounded-xl border border-slate-200 bg-white p-2.5 dark:border-zinc-700 dark:bg-zinc-900" /></div>
            </div>
            <div className="relative mt-4"><Search className="absolute start-3 top-3 h-4 w-4 text-slate-400" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder={isRtl ? 'بحث بالاسم الرسمي أو الرمز' : 'Search official name or roster ID'} className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pe-3 ps-10 dark:border-zinc-700 dark:bg-zinc-900" /></div>
            {filteredRoster.length > 0 && <div className="mt-2 overflow-hidden rounded-xl border border-slate-200 dark:border-zinc-700">{filteredRoster.map(student => <button key={student.studentId} onClick={() => mutate(() => markAttendanceManually(sessionId, { requestId: newId(), studentId: student.studentId, reason: isRtl ? 'إثبات يدوي من الأستاذ' : 'Professor manual confirmation', expectedRevision: snapshot.session.revision }, ownerUid))} className="flex w-full items-center justify-between border-b border-slate-100 p-3 text-start last:border-0 hover:bg-slate-50 dark:border-zinc-700 dark:hover:bg-zinc-700"><span><b>{student.officialName}</b><small className="ms-2 text-slate-400">{student.rosterIdentifier}</small></span><UserPlus className="h-4 w-4 text-sky-600" /></button>)}</div>}

            <div className="mt-4 flex gap-2" role="group" aria-label={isRtl ? 'تصفية القائمة' : 'Roster filter'}>
              <button onClick={() => setRecordFilter('all')} className={`rounded-full px-3 py-1.5 text-xs font-black ${recordFilter === 'all' ? 'bg-slate-900 text-white dark:bg-white dark:text-zinc-900' : 'bg-slate-100 text-slate-600 dark:bg-zinc-700 dark:text-zinc-200'}`}>{isRtl ? 'الكل' : 'All'}</button>
              <button onClick={() => setRecordFilter('review')} className={`rounded-full px-3 py-1.5 text-xs font-black ${recordFilter === 'review' ? 'bg-amber-600 text-white' : 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200'}`}>{isRtl ? 'مراجعة' : 'Review'} ({snapshot.records.filter(record => record.reviewFlags.length > 0).length})</button>
            </div>
            <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[560px] text-sm"><thead><tr className="border-b border-slate-200 text-start text-xs text-slate-500 dark:border-zinc-700"><th className="p-2 text-start">{isRtl ? 'الاسم الرسمي' : 'Official name'}</th><th className="p-2 text-start">{isRtl ? 'الاستلام' : 'Received'}</th><th className="p-2 text-start">{isRtl ? 'الطريقة' : 'Method'}</th><th className="p-2 text-start">{isRtl ? 'الحالة' : 'Status'}</th><th className="p-2" /></tr></thead><tbody>{filteredRecords.map(record => { const locationBadge = attendanceLocationBadge(record.advisory, isRtl); return <tr key={record.id} className="border-b border-slate-100 dark:border-zinc-700/70"><td className="p-2 font-bold">{record.officialName}{locationBadge && <div className={`mt-1 text-xs font-black ${record.advisory?.locationStatus === 'off_campus' ? 'text-amber-700 dark:text-amber-300' : 'text-teal-700 dark:text-teal-300'}`}>{locationBadge}</div>}<div className="mt-1 text-xs font-normal text-amber-700">{record.reviewFlags.map(flag => attendanceFlagLabel(flag, isRtl)).join(' · ')}</div>{record.reviewFlags.length > 0 && <AlertTriangle className="ms-1 inline h-4 w-4 text-amber-500" />}</td><td className="p-2">{new Date(record.receivedAt).toLocaleString(lang === 'ar' ? 'ar-IQ' : 'en-GB', { timeZone: 'Asia/Baghdad' })}</td><td className="p-2">{record.entryMethod === 'manual' ? (isRtl ? 'يدوي' : 'Manual') : 'QR'}</td><td className="p-2">{record.status === 'confirmed' ? <span className="text-emerald-600">{isRtl ? 'مؤكد' : 'Confirmed'}</span> : <span className="text-red-600">{isRtl ? 'ملغى' : 'Voided'}</span>}</td><td className="p-2"><button disabled={busy} onClick={() => { if (record.status === 'confirmed' && !confirm(isRtl ? `هل أنت متأكد من إلغاء حضور الطالب (${record.officialName})؟` : `Are you sure you want to remove attendance for (${record.officialName})?`)) return; const reason = isRtl ? (record.status === 'confirmed' ? 'إلغاء يدوي بواسطة التدريسي' : 'استعادة بواسطة التدريسي') : (record.status === 'confirmed' ? 'Manual void by professor' : 'Manual restore by professor'); void mutate(() => setAttendanceRecordStatus(record.id, record.status === 'confirmed' ? 'void' : 'restore', { requestId: newId(), expectedRevision: record.revision, reason })); }} className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-bold dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer">{record.status === 'confirmed' ? (isRtl ? 'إلغاء' : 'Void') : (isRtl ? 'استعادة' : 'Restore')}</button></td></tr>; })}</tbody></table></div>
          </section>

          {snapshot.reviewReceipts.length > 0 && <section className="rounded-3xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-800 dark:bg-amber-950/20"><h2 className="font-black">{isRtl ? 'إيصالات تحتاج مراجعة' : 'Receipts needing review'}</h2>{snapshot.reviewReceipts.map(receipt => { const student = snapshot.roster.find(item => item.studentId === receipt.rosterStudentId); const locationBadge = attendanceLocationBadge(receipt.advisory, isRtl); return <div key={receipt.requestId} className="mt-3 rounded-xl bg-white p-3 dark:bg-zinc-900"><div className="font-bold">{student?.officialName || receipt.rosterStudentId || (isRtl ? 'هوية غير مطابقة' : 'Unmatched identity')}</div>{locationBadge && <div className={`mt-1 text-xs font-black ${receipt.advisory?.locationStatus === 'off_campus' ? 'text-amber-700 dark:text-amber-300' : 'text-teal-700 dark:text-teal-300'}`}>{locationBadge}</div>}<div className="mt-1 text-xs text-slate-500">{attendanceFlagLabel(receipt.reason, isRtl)} · {new Date(receipt.receivedAt).toLocaleString()}</div><div className="mt-3 flex gap-2"><button disabled={busy || ['device_session_conflict', 'device_unverified'].includes(receipt.reason)} onClick={() => { const enrollDevice = ['device_enrollment_required', 'device_change_required'].includes(receipt.reason); if (enrollDevice && !confirm(isRtl ? 'هل تحققت شخصياً من هوية الطالب وأن هذا جهازه؟' : 'Have you personally checked the student ID and ownership of this device?')) return; const reason = prompt(isRtl ? 'سبب التأكيد والتحقق من الهوية' : 'Confirmation and identity verification reason'); if (reason) void mutate(() => resolveAttendanceReview(receipt.requestId, { requestId: newId(), decision: 'confirm', reason, enrollDevice, expectedRevision: receipt.reviewRevision || 1 })); }} className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-black text-white"><CheckCircle2 className="h-4 w-4" />{isRtl ? 'تأكيد' : 'Confirm'}</button><button onClick={() => { const reason = prompt(isRtl ? 'سبب الرفض' : 'Rejection reason'); if (reason) void mutate(() => resolveAttendanceReview(receipt.requestId, { requestId: newId(), decision: 'reject', reason, expectedRevision: receipt.reviewRevision || 1 })); }} className="flex items-center gap-1 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-black text-white"><XCircle className="h-4 w-4" />{isRtl ? 'رفض' : 'Reject'}</button></div></div>; })}</section>}

          {snapshot.session.status === 'active' && <button onClick={() => mutate(() => updateAttendanceSession(sessionId, { requestId: newId(), expectedRevision: snapshot.session.revision, status: 'ended', reason: isRtl ? 'أنهى الأستاذ عرض الجلسة' : 'Professor ended collection display' }, ownerUid))} className="flex w-full items-center justify-center gap-2 rounded-2xl border border-slate-300 bg-white px-4 py-3 font-black text-slate-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-slate-200"><Square className="h-4 w-4" />{isRtl ? 'إنهاء عرض الجمع' : 'End collection display'}</button>}
          <button onClick={() => {
            const reason = window.prompt(isRtl ? 'اكتب سبب إلغاء جلسة الحضور:' : 'Reason for cancelling this attendance session:')?.trim();
            if (!reason || !window.confirm(isRtl ? 'سيتم إبطال الرمز واستبعاد الجلسة من الإجماليات. متابعة؟' : 'The QR will be revoked and this attempt excluded from totals. Continue?')) return;
            void cancelAttendanceSession(sessionId, { requestId: newId(), expectedRevision: snapshot.session.revision, reason }, ownerUid)
              .then(async () => {
                setSessionId(''); setQrToken(''); setSnapshot(null); setError('');
                const pack = await ensureOfflineAttendancePrepared(stageId, ownerUid, true).catch(() => undefined);
                setOfflineReady(!!pack);
                requestIdRef.current = newId();
              })
              .catch(() => setError(isRtl ? 'تعذر إلغاء الجلسة.' : 'Could not cancel the session.'));
          }} className="flex w-full items-center justify-center gap-2 rounded-2xl border border-rose-300 bg-white px-4 py-3 font-black text-rose-700 dark:border-rose-800 dark:bg-zinc-800 dark:text-rose-300"><Trash2 className="h-4 w-4" />{isRtl ? 'إلغاء الجلسة' : 'Cancel session'}</button>
        </>}
      </>}
    </div>
  );
}
