import React, { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { 
  QrCode, Expand, RefreshCw, Users, CheckCircle2, Search, UserPlus, 
  Clock, ShieldAlert, Sparkles, Printer, Play, Square, Check
} from 'lucide-react';
import { DoctorSubject, LectureColumn, StudentAttendanceRow } from './types';
import type { useDoctorAttendance } from './useDoctorAttendance';
import { attendanceFlagLabel } from '../../../shared/attendanceSecurity';

interface DoctorLiveSessionViewProps {
  subject: DoctorSubject;
  lectures: LectureColumn[];
  students: StudentAttendanceRow[];
  isRtl: boolean;
  onStudentMarkedPresent: (studentId: string, lectureId: string) => void;
  attendance: ReturnType<typeof useDoctorAttendance>;
}

export default function DoctorLiveSessionView({
  subject,
  lectures,
  students,
  isRtl,
  onStudentMarkedPresent,
  attendance,
}: DoctorLiveSessionViewProps) {
  const [selectedLectureId, setSelectedLectureId] = useState('');
  const [expectedHeadcount, setExpectedHeadcount] = useState(60);
  const [searchQuery, setSearchQuery] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const projectorRef = useRef<HTMLDivElement>(null);
  const selectedLecture = lectures.find(lecture => lecture.id === selectedLectureId);
  const activeSession = attendance.snapshot?.session.occurrenceId === selectedLecture?.id ? attendance.snapshot : null;
  const isSessionActive = activeSession?.session.status === 'active';
  const currentQr = isSessionActive && attendance.occurrenceId === selectedLecture?.id ? attendance.qrToken : '';
  useEffect(() => { if (activeSession?.session.expectedHeadcount) setExpectedHeadcount(activeSession.session.expectedHeadcount); }, [activeSession?.session.id, activeSession?.session.expectedHeadcount]);
  useEffect(() => {
    let live = true;
    setQrDataUrl('');
    if (currentQr) void QRCode.toDataURL(currentQr, {
      width: 800, margin: 2, errorCorrectionLevel: 'M',
      color: { dark: '#042f2e', light: '#ffffff' },
    }).then(image => { if (live) setQrDataUrl(image); }).catch(() => { if (live) setQrDataUrl(''); });
    return () => { live = false; };
  }, [currentQr]);
  const toggleFullscreen = () => {
    if (!projectorRef.current) return;
    if (!document.fullscreenElement) void projectorRef.current.requestFullscreen().catch(() => undefined);
    else void document.exitFullscreen().catch(() => undefined);
  };
  const handleRefreshQr = () => {
    if (!selectedLecture) return;
    attendance.selectOccurrence(selectedLecture.id);
    void attendance.start(expectedHeadcount);
  };
  const handleManualAdd = (student: StudentAttendanceRow) => {
    if (!selectedLecture || !activeSession) return;
    onStudentMarkedPresent(student.studentId, selectedLecture.id);
    setSearchQuery('');
  };
  const unrecordedStudents = students.filter(student =>
    student.attendance[selectedLecture?.id] !== 'present' && student.attendance[selectedLecture?.id] !== 'pending'
    && student.name.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const recentScannedStudents = (activeSession?.records || []).filter(record => record.status === 'confirmed')
    .sort((first, second) => second.receivedAt.localeCompare(first.receivedAt)).slice(0, 4)
    .map(record => ({ id: record.id, name: record.officialName,
      time: new Date(record.receivedAt).toLocaleTimeString(isRtl ? 'ar-IQ' : 'en-GB', { timeZone: 'Asia/Baghdad', hour: '2-digit', minute: '2-digit' }) }));
  const confirmedCount = activeSession?.counts.confirmed || 0;
  const pendingManualCount = attendance.commands.filter(command =>
    (!command.kind || command.kind === 'manual') && command.sessionId === activeSession?.session.id && command.status === 'pending'
  ).length;
  const presentCount = confirmedCount + pendingManualCount;
  const totalCount = activeSession?.session.expectedHeadcount || expectedHeadcount;
  const attendanceRate = totalCount > 0 ? Math.round((confirmedCount / totalCount) * 100) : 0;
  const finalizationQueued = attendance.commands.some(command => command.sessionId === activeSession?.session.id && command.kind === 'session_update' && command.input.status === 'finalized' && command.status === 'pending');
  const canFinalize = activeSession?.session.status === 'ended' && !activeSession.offline
    && Date.parse(activeSession.serverNow) >= Date.parse(activeSession.session.reconciliationDeadline)
    && activeSession.counts.review === 0;

  return (
    <div className="space-y-6" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Top Banner: Active Lecture Selector & Status */}
      <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-4 p-5 rounded-3xl bg-white border border-slate-200/80 shadow-sm dark:bg-zinc-900 dark:border-zinc-800">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-500/10 text-teal-600 dark:bg-teal-500/20 dark:text-teal-400">
            <QrCode className="h-6 w-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-black uppercase tracking-wider text-teal-600 dark:text-teal-400">
                {isRtl ? 'المحاضرة الحالية' : 'Active Lecture'}
              </span>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-ping" />
            </div>
            <select
              value={selectedLectureId}
              onChange={(e) => { setSelectedLectureId(e.target.value); attendance.selectOccurrence(e.target.value); }}
              className="mt-1 font-black text-slate-900 bg-transparent dark:text-zinc-100 text-sm md:text-base border-none focus:ring-0 p-0 cursor-pointer"
            >
              <option value="" disabled>{isRtl ? 'اختر المحاضرة بتاريخها' : 'Select a dated lecture'}</option>
              {lectures.map((lec) => (
                <option key={lec.id} value={lec.id} className="dark:bg-zinc-900 text-slate-800 dark:text-zinc-200">
                  محاضرة {lec.number}: {lec.title} ({lec.date})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => { if (isSessionActive) void attendance.saveSession({ status: 'ended', reason: isRtl ? 'انتهى عرض الرمز' : 'QR display ended' }); else handleRefreshQr(); }}
            disabled={attendance.busy || !selectedLecture || (activeSession != null && activeSession.session.status !== 'active')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-2xl font-black text-xs transition-all shadow-sm ${
              isSessionActive
                ? 'bg-rose-50 text-rose-600 border border-rose-200 hover:bg-rose-100 dark:bg-rose-950/40 dark:border-rose-900/60 dark:text-rose-300'
                : 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-emerald-600/20'
            }`}
          >
            {isSessionActive ? (
              <>
                <Square className="h-4 w-4" />
                {isRtl ? 'إنهاء جلسة الحضور' : 'End Session'}
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                {activeSession ? (isRtl ? 'الجلسة مغلقة' : 'Session closed') : (isRtl ? 'بدء جلسة جديدة' : 'Start Session')}
              </>
            )}
          </button>
          {canFinalize && <button disabled={attendance.busy || finalizationQueued} onClick={() => void attendance.saveSession({ status: 'finalized', reason: isRtl ? 'اكتمل تدقيق الحضور بعد مهلة المزامنة' : 'Attendance reconciled after upload window' })} className="rounded-2xl bg-teal-600 px-3 py-2.5 text-xs font-bold text-white disabled:opacity-50">{finalizationQueued ? (isRtl ? 'بانتظار المزامنة' : 'Pending sync') : (isRtl ? 'اعتماد السجل النهائي' : 'Finalize ledger')}</button>}

          <button
            onClick={() => window.print()}
            className="p-2.5 rounded-2xl border border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 transition-colors"
            title={isRtl ? 'طباعة القائمة الاحتياطية' : 'Print backup roster'}
          >
            <Printer className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Main Grid: Projector QR on Left/Center + Live Stats on Right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Projector QR Card (takes 7 columns) */}
        <div 
          ref={projectorRef}
          className="lg:col-span-7 flex flex-col items-center justify-between p-6 sm:p-8 rounded-3xl bg-white border border-slate-200/80 shadow-md dark:bg-zinc-900 dark:border-zinc-800 fullscreen:p-12 fullscreen:bg-zinc-950 fullscreen:text-white"
        >
          <div className="w-full flex items-center justify-between mb-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-black bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">
                  <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                  {qrDataUrl ? (isRtl ? 'رمز الحضور جاهز' : 'Attendance QR Ready') : (isRtl ? 'الرمز غير معروض' : 'QR Not Displayed')}
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  {selectedLecture?.time || ''}
                </span>
              </div>
              <h3 className="mt-2 text-base sm:text-lg font-black text-slate-900 dark:text-zinc-100">
                {selectedLecture?.title}
              </h3>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                onClick={handleRefreshQr}
                disabled={attendance.busy || !selectedLecture || (activeSession != null && !isSessionActive)}
                className="p-2 rounded-xl text-slate-500 hover:bg-slate-100 hover:text-teal-600 dark:hover:bg-zinc-800 transition-colors"
                title={isRtl ? 'تحديث الرمز' : 'Refresh QR'}
              >
                <RefreshCw className="h-4 w-4" />
              </button>
              <button
                onClick={toggleFullscreen}
                className="p-2 rounded-xl text-slate-500 hover:bg-slate-100 hover:text-teal-600 dark:hover:bg-zinc-800 transition-colors"
                title={isRtl ? 'شاشة كاملة للقاعة' : 'Fullscreen for projector'}
              >
                <Expand className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* QR Code Container */}
          <div className="relative my-4 flex items-center justify-center p-6 sm:p-8 rounded-3xl bg-white border border-slate-100 shadow-xl max-w-sm sm:max-w-md w-full aspect-square">
            {qrDataUrl ? (
              <img 
                src={qrDataUrl} 
                alt="Attendance QR" 
                className="w-full h-full object-contain rounded-2xl"
              />
            ) : (
              <div className="text-center p-6 space-y-3">
                <QrCode className="h-16 w-16 mx-auto text-slate-300 dark:text-zinc-700 animate-pulse" />
                <p className="text-sm font-bold text-slate-400">
                  {isRtl ? 'ابدأ الجلسة أو جدد الرمز لعرض رمز موقع صالح' : 'Start the session or refresh to show a signed QR'}
                </p>
              </div>
            )}
          </div>

          {/* Guidance note */}
          <div className="w-full mt-4 p-3.5 rounded-2xl bg-slate-50 dark:bg-zinc-800/60 border border-slate-100 dark:border-zinc-800 text-center">
            <p className="text-xs font-bold text-slate-600 dark:text-zinc-300">
              {isRtl
                ? 'امسح الرمز عبر تطبيق محاضراتي. الرمز محمي وموثق تلقائياً دون الحاجة لاتصال فوري للطلاب.'
                : 'Scan via Mohadaraty app. Code is cryptographically validated and works with offline capture.'}
            </p>
          </div>
        </div>

        {/* Right Column: Live Metrics & Quick Student Adder (takes 5 columns) */}
        <div className="lg:col-span-5 space-y-6">
          <div className="rounded-2xl bg-white p-4 text-xs dark:bg-zinc-900">
            <label className="font-bold">{isRtl ? 'عدد الطلاب في القاعة' : 'Physical headcount'}</label>
            <input type="number" min={1} max={10000} value={expectedHeadcount} onChange={event => setExpectedHeadcount(Number(event.target.value))} className="ms-2 w-20 rounded-lg border p-2 dark:bg-zinc-800" />
            {activeSession && <button disabled={attendance.busy || expectedHeadcount === activeSession.session.expectedHeadcount} onClick={() => void attendance.saveSession({ expectedHeadcount })} className="ms-2 text-teal-700 disabled:opacity-40">{isRtl ? 'حفظ' : 'Save'}</button>}
            <p>{isRtl ? 'المؤكد' : 'Confirmed'}: {confirmedCount} · {isRtl ? 'يدوي بانتظار المزامنة' : 'Manual pending sync'}: {pendingManualCount}</p>
          </div>
          <button disabled={attendance.busy || attendance.offlineReady} onClick={() => void attendance.prepare()} className="w-full rounded-2xl border border-teal-300 bg-teal-50 p-3 text-xs font-bold text-teal-900 disabled:opacity-60">{attendance.offlineReady ? (isRtl ? 'أدوات العمل دون اتصال جاهزة' : 'Offline work pack ready') : (isRtl ? 'تحضير أدوات العمل دون اتصال' : 'Prepare offline work pack')}</button>
          {attendance.error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{attendance.error}</p>}
          {activeSession?.offline && <p role="status" className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900">{isRtl ? 'الطلاب المزامنون يظهرون بعد عودة الإنترنت. التسجيل اليدوي يُحفظ فوراً.' : 'Student uploads appear after reconnecting. Manual entries save immediately.'}</p>}
          {activeSession && confirmedCount > totalCount && <p role="alert" className="rounded-xl bg-red-100 p-3 text-sm font-black text-red-900">{isRtl ? `${confirmedCount - totalCount} حضور زائد عن عدد القاعة — راجع السجلات` : `${confirmedCount - totalCount} scans beyond physical headcount — review records`}</p>}
          {/* Headcount Card */}
          <div className="p-6 rounded-3xl bg-gradient-to-br from-teal-600 to-emerald-700 text-white shadow-lg shadow-teal-600/20">
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs font-bold uppercase tracking-wider text-teal-100">
                {isRtl ? 'إحصائية الحضور الآن' : 'Live Hall Headcount'}
              </span>
              <Users className="h-5 w-5 text-teal-200" />
            </div>

            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-black">{confirmedCount}</span>
              <span className="text-lg text-teal-200 font-bold">/ {totalCount}</span>
              <span className="ms-auto text-sm font-black px-3 py-1 rounded-xl bg-white/20 backdrop-blur-sm">
                {attendanceRate}%
              </span>
            </div>

            <div className="mt-4 w-full bg-black/20 rounded-full h-2.5 overflow-hidden">
              <div 
                className="bg-white h-2.5 rounded-full transition-all duration-500 ease-out"
                style={{ width: `${Math.min(100, attendanceRate)}%` }}
              />
            </div>
          </div>

          {/* Manual Student Search & Fast Add */}
          <div className="p-6 rounded-3xl bg-white border border-slate-200/80 shadow-sm dark:bg-zinc-900 dark:border-zinc-800 space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-black text-slate-900 dark:text-zinc-100">
                {isRtl ? 'تسجيل يدوي سريع للطلاب' : 'Quick Manual Check-in'}
              </h4>
              <span className="text-[11px] font-bold text-slate-400">
                {isRtl ? 'في حال تعطل جهاز الطالب' : 'For device issues'}
              </span>
            </div>

            {/* Search Input */}
            <div className="relative">
              <Search className="absolute start-3 top-3 h-4 w-4 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={isRtl ? 'ابحث بالاسم الرسمي...' : 'Search official name...'}
                className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pe-3 ps-10 text-xs font-bold text-slate-800 placeholder-slate-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </div>

            {/* Search Candidates List */}
            {searchQuery && (
              <div className="max-h-48 overflow-y-auto space-y-1 rounded-xl border border-slate-200 p-2 dark:border-zinc-700 bg-slate-50/50 dark:bg-zinc-800/40">
                {unrecordedStudents.length > 0 ? (
                  unrecordedStudents.slice(0, 5).map((student) => (
                    <div 
                      key={student.studentId}
                      className="flex items-center justify-between p-2 rounded-lg bg-white hover:bg-teal-50 dark:bg-zinc-800 dark:hover:bg-zinc-700 transition-colors"
                    >
                      <div>
                        <p className="text-xs font-black text-slate-800 dark:text-zinc-100">{student.name}</p>
                        <p className="text-[10px] text-slate-400">شعبة {student.group} • {student.examCode}</p>
                      </div>
                      <button
                        onClick={() => handleManualAdd(student)}
                        disabled={!activeSession || attendance.busy}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-teal-600 hover:bg-teal-700 text-white font-black text-[11px] transition-colors shadow-sm"
                      >
                        <UserPlus className="h-3.5 w-3.5" />
                        {isRtl ? 'تسجيل' : 'Mark'}
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="text-center py-3 text-xs text-slate-400 font-bold">
                    {isRtl ? 'لا يوجد طلاب غير مسجلين بهذا الاسم' : 'No matching unrecorded students'}
                  </p>
                )}
              </div>
            )}

            {/* Recent Check-ins */}
            <div className="pt-2 border-t border-slate-100 dark:border-zinc-800 space-y-2">
              <label className="text-[11px] font-black uppercase tracking-wider text-slate-400">
                {isRtl ? 'آخر الحضور المؤكد (وقت الاستلام)' : 'Recent confirmed (received time)'}
              </label>
              <div className="space-y-1.5">
                {recentScannedStudents.slice(0, 4).map((student) => (
                  <div 
                    key={student.id} 
                    className="flex items-center justify-between py-1.5 px-3 rounded-xl bg-slate-50 dark:bg-zinc-800/50 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                      <span className="font-bold text-slate-700 dark:text-zinc-200">{student.name}</span>
                    </div>
                    <span className="text-[10px] text-slate-400 font-mono">{student.time}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      {activeSession && <div className="rounded-3xl border border-slate-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h3 className="font-black">{isRtl ? 'مراجعة الحضور والإيصالات' : 'Attendance and receipt review'}</h3>
        <p className="text-xs text-slate-500">{isRtl ? 'يعرض وقت استلام الخادم، وليس وقت المسح دون اتصال.' : 'Times show server receipt, not an offline scan time.'}</p>
        <div className="mt-3 max-h-72 space-y-2 overflow-y-auto">
          {[...activeSession.records].sort((a, b) => Number(!!a.reviewFlags.length) - Number(!!b.reviewFlags.length) || a.receivedAt.localeCompare(b.receivedAt)).map(record => <div key={record.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-2 text-xs">
            <div><strong>{record.officialName}</strong> · {record.status === 'confirmed' ? (isRtl ? 'مؤكد' : 'Confirmed') : (isRtl ? 'ملغى' : 'Voided')}
              <p>{new Date(record.receivedAt).toLocaleString(isRtl ? 'ar-IQ' : 'en-GB', { timeZone: 'Asia/Baghdad' })}</p>
              <p className="text-amber-700">{record.reviewFlags.map(flag => attendanceFlagLabel(flag, isRtl)).join(' · ')}</p>
            </div>
            <button disabled={attendance.busy} className="rounded-lg border px-2 py-1" onClick={() => void attendance.updateCell(record.rosterStudentId, selectedLecture.id, record.status === 'confirmed' ? 'voided' : 'present')}>{record.status === 'confirmed' ? (isRtl ? 'إلغاء' : 'Void') : (isRtl ? 'استعادة' : 'Restore')}</button>
          </div>)}
          {activeSession.reviewReceipts.map(receipt => <div key={receipt.requestId} className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <strong>{activeSession.roster.find(student => student.studentId === receipt.rosterStudentId)?.officialName || receipt.rosterStudentId}</strong>
            <p>{attendanceFlagLabel(receipt.reason, isRtl)} · {receipt.requestId}</p>
            <button disabled={attendance.busy || ['device_session_conflict', 'device_unverified'].includes(receipt.reason)} className="me-2 rounded-lg bg-teal-600 px-2 py-1 text-white disabled:opacity-50" onClick={() => {
              const enrollment = ['device_enrollment_required', 'device_change_required'].includes(receipt.reason);
              if (!enrollment || window.confirm(isRtl ? 'هل تحققت شخصياً من هوية الطالب وملكية الجهاز؟' : 'Did you personally verify identity and device ownership?')) void attendance.review(receipt.requestId, enrollment, 'confirm');
            }}>{isRtl ? 'تأكيد' : 'Confirm'}</button>
            <button disabled={attendance.busy} className="rounded-lg bg-red-700 px-2 py-1 text-white" onClick={() => void attendance.review(receipt.requestId, false, 'reject')}>{isRtl ? 'رفض' : 'Reject'}</button>
          </div>)}
        </div>
      </div>}

    </div>
  );
}
