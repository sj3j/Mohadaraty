import React, { useState, useEffect, useMemo, useRef } from 'react';
import QRCode from 'qrcode';
import { 
  QrCode, Expand, RefreshCw, Users, CheckCircle2, Search, UserPlus, 
  Clock, ShieldAlert, Sparkles, Printer, Play, Square, Check,
  Trash2, CalendarDays, ChevronDown, X, BookOpen, Layers
} from 'lucide-react';
import { DoctorSubject, LectureColumn, StudentAttendanceRow, WeeklyLectureColumn } from './types';
import type { useDoctorAttendance } from './useDoctorAttendance';
import { attendanceFlagLabel, attendanceLocationBadge, attendanceScanTimeBadge } from '../../../shared/attendanceSecurity';
import { buildWeeklyColumns, getLectureDayName, formatLectureTime } from './DoctorExcelTimetableView';
import AttendanceQrDisplay from '../attendance/AttendanceQrDisplay';

interface DoctorLiveSessionViewProps {
  subject: DoctorSubject;
  lectures: LectureColumn[];
  students: StudentAttendanceRow[];
  isRtl: boolean;
  selectedLectureId: string;
  onSelectLecture: (lectureId: string) => void;
  onStudentMarkedPresent: (studentId: string, lectureId: string) => void;
  attendance: ReturnType<typeof useDoctorAttendance>;
}

export default function DoctorLiveSessionView({
  subject,
  lectures,
  students,
  isRtl,
  onStudentMarkedPresent,
  attendance, selectedLectureId, onSelectLecture,
}: DoctorLiveSessionViewProps) {
  const [expectedHeadcount, setExpectedHeadcount] = useState(60);
  const [searchQuery, setSearchQuery] = useState('');
  const [includeAllStudents, setIncludeAllStudents] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [isAllAttendedModalOpen, setIsAllAttendedModalOpen] = useState(false);
  const [attendedSearchQuery, setAttendedSearchQuery] = useState('');
  const projectorRef = useRef<HTMLDivElement>(null);
  const autoStartedSessionRef = useRef<string>('');

  // 1. Build weekly columns from lectures for current subject & mode
  const weeklyColumns = useMemo(() => buildWeeklyColumns(lectures, isRtl), [lectures, isRtl]);

  // 2. Server date in Baghdad timezone
  const todayDate = useMemo(() => {
    if (attendance.workspace?.bootstrap.serverNow) {
      return new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Baghdad',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(new Date(attendance.workspace.bootstrap.serverNow));
    }
    return new Date().toISOString().slice(0, 10);
  }, [attendance.workspace?.bootstrap.serverNow]);

  // 3. Find default/current week
  const defaultWeek = useMemo(() => {
    if (!weeklyColumns.length) return null;
    const current = weeklyColumns.find(w => todayDate >= w.startDate && todayDate <= w.endDate);
    if (current) return current;
    const future = weeklyColumns.find(w => w.startDate >= todayDate);
    return future || weeklyColumns[weeklyColumns.length - 1];
  }, [weeklyColumns, todayDate]);

  // 4. Track selected week ID
  const [selectedWeekId, setSelectedWeekId] = useState<string>('');
  const activeWeekCol = useMemo(() => {
    return weeklyColumns.find(w => w.id === selectedWeekId) || defaultWeek || weeklyColumns[0];
  }, [weeklyColumns, selectedWeekId, defaultWeek]);

  // Initialize selectedWeekId
  useEffect(() => {
    if (!selectedWeekId && defaultWeek) {
      setSelectedWeekId(defaultWeek.id);
    }
  }, [defaultWeek, selectedWeekId]);

  // Sync selectedWeekId if selectedLectureId comes from outside
  useEffect(() => {
    if (!selectedLectureId || !weeklyColumns.length) return;
    const matchingWeek = weeklyColumns.find(w => w.occurrences.some(o => o.id === selectedLectureId));
    if (matchingWeek && matchingWeek.id !== selectedWeekId) {
      setSelectedWeekId(matchingWeek.id);
    }
  }, [selectedLectureId, weeklyColumns]);

  // 5. Build group options for active week
  interface GroupSlotOption {
    id: string;
    groupLabel: string;
    dayTimeLabel: string;
    occurrence: LectureColumn;
    isToday: boolean;
  }

  const groupOptions: GroupSlotOption[] = useMemo(() => {
    if (!activeWeekCol) return [];
    return activeWeekCol.occurrences.map((occ) => {
      const dayName = getLectureDayName(occ, isRtl);
      const timeStr = formatLectureTime(occ.time, occ.endTime);
      const isToday = occ.date === todayDate;

      let groupLabel = '';
      if (!occ.audienceGroups || occ.audienceGroups.length === 0) {
        groupLabel = isRtl ? 'جميع الشعب (الدفعة كاملة)' : 'All Groups';
      } else if (occ.audienceGroups.length === 1) {
        groupLabel = isRtl ? `شعبة ${occ.audienceGroups[0]}` : `Group ${occ.audienceGroups[0]}`;
      } else {
        groupLabel = isRtl ? `شعب (${occ.audienceGroups.join(', ')})` : `Groups (${occ.audienceGroups.join(', ')})`;
      }

      const dayTimeLabel = [dayName, occ.date, timeStr].filter(Boolean).join(' • ');

      return {
        id: occ.id,
        groupLabel,
        dayTimeLabel,
        occurrence: occ,
        isToday,
      };
    });
  }, [activeWeekCol, isRtl, todayDate]);

  // 6. Selected occurrence
  const currentSlotOption = groupOptions.find(opt => opt.id === selectedLectureId) || groupOptions.find(opt => opt.isToday) || groupOptions[0];

  // Auto-select and auto-start session whenever week or group is chosen
  useEffect(() => {
    if (!currentSlotOption) return;
    const occId = currentSlotOption.id;

    if (selectedLectureId !== occId) {
      onSelectLecture(occId);
      attendance.selectOccurrence(occId);
    }

    // Auto-create/start session if not already running for this occurrence
    if (attendance.workspace && !attendance.busy) {
      const existingSession = attendance.workspace.sessions.find(s => s.occurrenceId === occId);
      const isEnded = existingSession?.status === 'ended' || existingSession?.status === 'finalized';
      const isAlreadyActive = existingSession?.status === 'active' && attendance.snapshot?.session.occurrenceId === occId;

      if (!isEnded && !isAlreadyActive && autoStartedSessionRef.current !== occId) {
        autoStartedSessionRef.current = occId;
        attendance.selectOccurrence(occId);
        void attendance.start(expectedHeadcount);
      }
    }
  }, [currentSlotOption, selectedLectureId, attendance.workspace, attendance.busy, expectedHeadcount]);

  const selectedLecture = lectures.find(lecture => lecture.id === (selectedLectureId || currentSlotOption?.id));
  const activeSession = attendance.snapshot?.session.occurrenceId === selectedLecture?.id ? attendance.snapshot : null;
  const isSessionActive = activeSession?.session.status === 'active';
  const currentQr = isSessionActive && attendance.occurrenceId === selectedLecture?.id ? attendance.qrToken : '';

  useEffect(() => { if (activeSession?.session.expectedHeadcount) setExpectedHeadcount(activeSession.session.expectedHeadcount); }, [activeSession?.session.id, activeSession?.session.expectedHeadcount]);
  useEffect(() => {
    let live = true;
    setQrDataUrl('');
    if (currentQr) void QRCode.toDataURL(currentQr, { width: 1200, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } }).then(image => { if (live) setQrDataUrl(image); });
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

  const handleDeleteAttendedStudent = (rosterStudentId: string, studentName: string) => {
    if (!selectedLecture) return;
    const confirmMessage = isRtl
      ? `هل أنت متأكد من إلغاء حضور الطالب (${studentName})؟`
      : `Are you sure you want to remove attendance for (${studentName})?`;
    if (!window.confirm(confirmMessage)) return;
    void attendance.updateCell(rosterStudentId, selectedLecture.id, 'voided');
  };

  const lectureAudiences = selectedLecture?.audienceGroups || [];
  const hasAudienceRestriction = lectureAudiences.length > 0;

  const unrecordedStudents = students.filter(student => {
    if (selectedLecture?.id && (student.attendance[selectedLecture.id] === 'present' || student.attendance[selectedLecture.id] === 'pending')) {
      return false;
    }
    const query = searchQuery.trim().toLowerCase();
    const matchesSearch = !query || student.name.toLowerCase().includes(query) || student.examCode.toLowerCase().includes(query);
    if (!matchesSearch) return false;

    if (!includeAllStudents && hasAudienceRestriction) {
      return !!student.group && lectureAudiences.includes(student.group);
    }
    return true;
  });

  const recentScannedStudents = (activeSession?.records || []).filter(record => record.status === 'confirmed')
    .sort((first, second) => second.receivedAt.localeCompare(first.receivedAt)).slice(0, 6)
    .map(record => ({ 
      id: record.id, 
      rosterStudentId: record.rosterStudentId,
      name: record.officialName,
      entryMethod: record.entryMethod,
      time: new Date(record.receivedAt).toLocaleTimeString(isRtl ? 'ar-IQ' : 'en-GB', { timeZone: 'Asia/Baghdad', hour: '2-digit', minute: '2-digit' }) 
    }));

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

  const allConfirmedRecords = (activeSession?.records || []).filter(record => record.status === 'confirmed');
  const filteredConfirmedRecords = allConfirmedRecords.filter(record => {
    const q = attendedSearchQuery.trim().toLowerCase();
    if (!q) return true;
    return record.officialName.toLowerCase().includes(q) || record.rosterStudentId.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-6" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Top Banner: Timetable-Driven Week & Group Selector */}
      <div className="p-5 rounded-3xl bg-white border border-slate-200/80 shadow-xs dark:bg-zinc-900 dark:border-zinc-800 space-y-4">
        <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-teal-500/10 text-teal-600 dark:bg-teal-500/20 dark:text-teal-400">
              <QrCode className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-black uppercase tracking-wider text-teal-600 dark:text-teal-400">
                  {isRtl ? 'جلسة الحضور المباشرة' : 'Live Attendance Session'}
                </span>
                {isSessionActive && (
                  <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-ping" />
                    {isRtl ? 'مباشر الآن' : 'Live'}
                  </span>
                )}
                {activeSession && !isSessionActive && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-400">
                    {isRtl ? 'مغلقة' : 'Closed'}
                  </span>
                )}
              </div>
              <h2 className="text-base font-black text-slate-900 dark:text-zinc-100 mt-0.5">
                {selectedLecture?.title || (isRtl ? 'حدد الأسبوع والشعبة لبدء الجلسة' : 'Select Week & Group to start session')}
              </h2>
            </div>
          </div>

          {/* Action Controls */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                if (isSessionActive) {
                  void attendance.saveSession({ status: 'ended', reason: isRtl ? 'انتهى عرض الرمز' : 'QR display ended' });
                } else {
                  handleRefreshQr();
                }
              }}
              disabled={attendance.busy || !selectedLecture || (activeSession != null && activeSession.session.status !== 'active')}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-2xl font-black text-xs transition-all shadow-xs cursor-pointer ${
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
            {canFinalize && (
              <button
                disabled={attendance.busy || finalizationQueued}
                onClick={() => void attendance.saveSession({ status: 'finalized', reason: isRtl ? 'اكتمل تدقيق الحضور بعد مهلة المزامنة' : 'Attendance reconciled after upload window' })}
                className="rounded-2xl bg-teal-600 px-3 py-2.5 text-xs font-bold text-white disabled:opacity-50 cursor-pointer"
              >
                {finalizationQueued ? (isRtl ? 'بانتظار المزامنة' : 'Pending sync') : (isRtl ? 'اعتماد السجل النهائي' : 'Finalize ledger')}
              </button>
            )}
            <button
              onClick={() => window.print()}
              className="p-2.5 rounded-2xl border border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              title={isRtl ? 'طباعة القائمة الاحتياطية' : 'Print backup roster'}
            >
              <Printer className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Timetable Session Selectors: Week & Group */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-3 border-t border-slate-100 dark:border-zinc-800">
          {/* Week Selector Card */}
          <div className="flex items-center gap-3 p-3 rounded-2xl border border-slate-200/90 bg-slate-50/70 hover:bg-slate-100/60 dark:border-zinc-700/80 dark:bg-zinc-800/60 dark:hover:bg-zinc-800 transition-all">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300 shrink-0">
              <CalendarDays className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <label className="block text-[11px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-wider">
                {isRtl ? 'الأسبوع الدراسي' : 'Academic Week'}
              </label>
              <div className="relative">
                <select
                  value={activeWeekCol?.id || ''}
                  onChange={(e) => {
                    setSelectedWeekId(e.target.value);
                  }}
                  className="w-full mt-0.5 bg-transparent font-black text-xs md:text-sm text-slate-900 dark:text-zinc-100 border-none focus:ring-0 p-0 cursor-pointer pe-6 truncate"
                >
                  {weeklyColumns.map((col) => {
                    const isCurrent = todayDate >= col.startDate && todayDate <= col.endDate;
                    const weekTitle = isRtl ? col.titleAr : col.titleEn;
                    const dateRange = `(${col.startDate} - ${col.endDate})`;
                    return (
                      <option key={col.id} value={col.id} className="dark:bg-zinc-900 text-slate-800 dark:text-zinc-200">
                        {weekTitle} {dateRange} {isCurrent ? (isRtl ? '⭐ (الأسبوع الحالي)' : '⭐ (Current)') : ''}
                      </option>
                    );
                  })}
                  {weeklyColumns.length === 0 && (
                    <option value="" disabled>
                      {isRtl ? 'لا توجد أسابيع مجدولة' : 'No scheduled weeks'}
                    </option>
                  )}
                </select>
                <ChevronDown className="absolute end-0 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
              </div>
            </div>
          </div>

          {/* Group / Timetable Slot Selector Card */}
          <div className="flex items-center gap-3 p-3 rounded-2xl border border-slate-200/90 bg-slate-50/70 hover:bg-slate-100/60 dark:border-zinc-700/80 dark:bg-zinc-800/60 dark:hover:bg-zinc-800 transition-all">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300 shrink-0">
              <Users className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <label className="block text-[11px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-wider">
                {isRtl ? 'الشعبة والجلسة المجدولة' : 'Group & Scheduled Slot'}
              </label>
              <div className="relative">
                <select
                  value={selectedLectureId || currentSlotOption?.id || ''}
                  onChange={(e) => {
                    onSelectLecture(e.target.value);
                    attendance.selectOccurrence(e.target.value);
                  }}
                  className="w-full mt-0.5 bg-transparent font-black text-xs md:text-sm text-slate-900 dark:text-zinc-100 border-none focus:ring-0 p-0 cursor-pointer pe-6 truncate"
                >
                  {groupOptions.map((opt) => (
                    <option key={opt.id} value={opt.id} className="dark:bg-zinc-900 text-slate-800 dark:text-zinc-200">
                      {opt.groupLabel} • {opt.dayTimeLabel} {opt.isToday ? (isRtl ? '📍 (اليوم)' : '📍 (Today)') : ''}
                    </option>
                  ))}
                  {groupOptions.length === 0 && (
                    <option value="" disabled>
                      {isRtl ? 'لا توجد جلسات لهذا الأسبوع' : 'No sessions for this week'}
                    </option>
                  )}
                </select>
                <ChevronDown className="absolute end-0 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
              </div>
            </div>
          </div>
        </div>

        {/* Selected Slot Context Tag */}
        {selectedLecture && (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 text-[11px] font-bold text-slate-500 dark:text-zinc-400">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-teal-700 dark:text-teal-300 font-black">
                {isRtl ? subject.nameAr : subject.nameEn} ({selectedLecture.mode === 'practical' ? (isRtl ? 'عملي' : 'Lab') : (isRtl ? 'نظري' : 'Theory')})
              </span>
              <span>•</span>
              <span>{getLectureDayName(selectedLecture, isRtl)} {selectedLecture.date}</span>
              {selectedLecture.time && <span>• {formatLectureTime(selectedLecture.time, selectedLecture.endTime)}</span>}
              {selectedLecture.location && <span>• {selectedLecture.location}</span>}
            </div>
            <span className="text-teal-600 dark:text-teal-400 font-semibold">
              {isRtl ? '✓ يتم إنشاء وتفعيل الجلسة تلقائياً وفق الجدول' : '✓ Session is created and started automatically per timetable'}
            </span>
          </div>
        )}
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
          <div className="relative my-4 flex items-center justify-center w-full">
            {currentQr ? (
              <AttendanceQrDisplay
                token={currentQr}
                title={selectedLecture?.title || ''}
                subtitle={`${selectedLecture?.date || ''} · ${selectedLecture?.time || ''}`}
                countLabel={`${confirmedCount} / ${totalCount}`}
                isRtl={isRtl}
                unavailableLabel={isRtl ? 'ابدأ الجلسة لعرض الرمز' : 'Start the session to display the QR'}
              />
            ) : (
              <div className="flex flex-col items-center justify-center p-8 rounded-3xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-md max-w-sm sm:max-w-md w-full aspect-square text-center space-y-3">
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
          <div className="p-6 rounded-3xl bg-white border border-slate-200/80 shadow-sm dark:bg-zinc-900 dark:border-zinc-800 space-y-3.5">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-black text-slate-900 dark:text-zinc-100">
                {isRtl ? 'تسجيل يدوي سريع للطلاب' : 'Quick Manual Check-in'}
              </h4>
              <span className="text-[11px] font-bold text-slate-400">
                {isRtl ? 'في حال تعطل جهاز الطالب' : 'For device issues'}
              </span>
            </div>

            {/* Audience Scoping Indicator & Makeup Override Toggle */}
            {hasAudienceRestriction && (
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 p-2.5 rounded-2xl bg-teal-50/70 dark:bg-teal-950/30 border border-teal-200/60 dark:border-teal-900/60 text-xs">
                <div className="flex items-center gap-1.5 text-teal-900 dark:text-teal-200 font-bold">
                  <Users className="h-4 w-4 text-teal-600 dark:text-teal-400 shrink-0" />
                  <span>
                    {isRtl ? `مخصصة لشعبة: ${lectureAudiences.join(', ')}` : `Audience: ${lectureAudiences.join(', ')}`}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setIncludeAllStudents(prev => !prev)}
                  className={`px-2.5 py-1 rounded-xl text-[11px] font-black transition-all cursor-pointer ${
                    includeAllStudents
                      ? 'bg-amber-600 text-white shadow-xs'
                      : 'bg-white text-teal-700 border border-teal-200 shadow-xs hover:bg-teal-50 dark:bg-zinc-800 dark:text-teal-300 dark:border-zinc-700'
                  }`}
                >
                  {includeAllStudents
                    ? (isRtl ? 'عرض كل الطلاب (حضور استثنائي)' : 'Showing all (Makeup allowed)')
                    : (isRtl ? 'تضمين كل الطلاب (استثناء)' : 'Allow makeup from other groups')}
                </button>
              </div>
            )}

            {/* Search Input */}
            <div className="relative">
              <Search className="absolute start-3 top-3 h-4 w-4 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={isRtl ? 'ابحث بالاسم الرسمي أو الرمز...' : 'Search official name or code...'}
                className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pe-3 ps-10 text-xs font-bold text-slate-800 placeholder-slate-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </div>

            {/* Search Candidates List */}
            {searchQuery && (
              <div className="max-h-48 overflow-y-auto space-y-1 rounded-xl border border-slate-200 p-2 dark:border-zinc-700 bg-slate-50/50 dark:bg-zinc-800/40">
                {unrecordedStudents.length > 0 ? (
                  unrecordedStudents.slice(0, 6).map((student) => {
                    const isOutsideAudience = hasAudienceRestriction && (!student.group || !lectureAudiences.includes(student.group));
                    return (
                      <div 
                        key={student.studentId}
                        className="flex items-center justify-between p-2 rounded-lg bg-white hover:bg-teal-50 dark:bg-zinc-800 dark:hover:bg-zinc-700 transition-colors"
                      >
                        <div className="min-w-0 pe-2">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <p className="text-xs font-black text-slate-800 dark:text-zinc-100 truncate">{student.name}</p>
                            {isOutsideAudience && (
                              <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 font-bold">
                                {isRtl ? 'استثنائي' : 'Makeup'}
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-slate-400">
                            {isRtl ? `شعبة ${student.group || 'غير محدد'}` : `Group ${student.group || 'Unassigned'}`} • {student.examCode}
                          </p>
                        </div>
                        <button
                          onClick={() => handleManualAdd(student)}
                          disabled={!activeSession || attendance.busy}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-teal-600 hover:bg-teal-700 text-white font-black text-[11px] transition-colors shadow-sm shrink-0 cursor-pointer"
                        >
                          <UserPlus className="h-3.5 w-3.5" />
                          {isRtl ? 'تسجيل' : 'Mark'}
                        </button>
                      </div>
                    );
                  })
                ) : (
                  <p className="text-center py-3 text-xs text-slate-400 font-bold">
                    {isRtl ? 'لا يوجد طلاب غير مسجلين بهذا الاسم' : 'No matching unrecorded students'}
                  </p>
                )}
              </div>
            )}

            {/* Recent Check-ins */}
            <div className="pt-2 border-t border-slate-100 dark:border-zinc-800 space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-black uppercase tracking-wider text-slate-400">
                  {isRtl ? 'آخر الحضور المؤكد' : 'Recent confirmed'}
                </label>
                <span className="text-[10px] text-teal-600 dark:text-teal-400 font-bold">
                  {confirmedCount} {isRtl ? 'طالب' : 'students'}
                </span>
              </div>
              <div className="space-y-1.5">
                {recentScannedStudents.map((student) => (
                  <div 
                    key={student.id} 
                    className="flex items-center justify-between py-1.5 px-3 rounded-xl bg-slate-50 dark:bg-zinc-800/50 text-xs hover:bg-slate-100/80 dark:hover:bg-zinc-800 transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                      <span className="font-bold text-slate-700 dark:text-zinc-200 truncate">{student.name}</span>
                      {student.entryMethod === 'manual' && (
                        <span className="text-[9px] px-1.5 py-0.2 rounded bg-teal-100 text-teal-800 dark:bg-teal-950/60 dark:text-teal-300 font-bold shrink-0">
                          {isRtl ? 'يدوي' : 'Manual'}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] text-slate-400 font-mono">{student.time}</span>
                      <button
                        type="button"
                        onClick={() => handleDeleteAttendedStudent(student.rosterStudentId, student.name)}
                        disabled={attendance.busy}
                        className="p-1 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/50 transition-colors cursor-pointer"
                        title={isRtl ? 'إلغاء حضور الطالب (حذف المسجل بالخطأ)' : 'Remove student attendance'}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
                {recentScannedStudents.length === 0 && (
                  <p className="text-center py-2 text-xs text-slate-400 font-bold">
                    {isRtl ? 'لم يُسجل حضور أي طالب بعد' : 'No attendance recorded yet'}
                  </p>
                )}
              </div>

              {/* View & Search All Attended Button */}
              {allConfirmedRecords.length > 0 && (
                <button
                  type="button"
                  onClick={() => setIsAllAttendedModalOpen(true)}
                  className="w-full mt-2 py-2 px-3 rounded-xl border border-slate-200 hover:border-teal-500/50 bg-white hover:bg-teal-50/50 dark:border-zinc-700 dark:bg-zinc-800/60 dark:hover:bg-zinc-800 text-xs font-bold text-teal-700 dark:text-teal-300 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Users className="h-3.5 w-3.5" />
                  <span>
                    {isRtl ? `عرض والبحث في كل الحضور المسجل (${confirmedCount})` : `View & Search All Attended (${confirmedCount})`}
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      {activeSession && <div className="rounded-3xl border border-slate-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h3 className="font-black">{isRtl ? 'مراجعة الحضور والإيصالات' : 'Attendance and receipt review'}</h3>
        <p className="text-xs text-slate-500">{isRtl ? 'يعرض توقيت المسح بالمنطقة الزمنية لهاتف الطالب ووقت المزامنة مع الخادم.' : 'Shows student phone scan time & timezone alongside server sync time.'}</p>
        <div className="mt-3 max-h-72 space-y-2 overflow-y-auto">
          {[...activeSession.records].sort((a, b) => Number(!!a.reviewFlags.length) - Number(!!b.reviewFlags.length) || a.receivedAt.localeCompare(b.receivedAt)).map(record => <div key={record.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-2 text-xs">
            <div><strong>{record.officialName}</strong> · {record.status === 'confirmed' ? (isRtl ? 'مؤكد' : 'Confirmed') : (isRtl ? 'ملغى' : 'Voided')}
              <p className="text-slate-500">{new Date(record.receivedAt).toLocaleString(isRtl ? 'ar-IQ' : 'en-GB', { timeZone: 'Asia/Baghdad' })}</p>
              <div className="flex flex-wrap items-center gap-2 mt-1">
                {attendanceLocationBadge(record.advisory, isRtl) && (
                  <span className="text-[11px] font-bold text-slate-700 dark:text-zinc-300">
                    {attendanceLocationBadge(record.advisory, isRtl)}
                  </span>
                )}
                {attendanceScanTimeBadge(record.advisory, isRtl) && (
                  <span className="text-[11px] font-bold text-teal-700 dark:text-teal-400 bg-teal-50 dark:bg-teal-950/40 px-2 py-0.5 rounded-lg border border-teal-200/50 dark:border-teal-800/50">
                    {attendanceScanTimeBadge(record.advisory, isRtl)}
                  </span>
                )}
              </div>
              <p className="text-amber-700">{record.reviewFlags.map(flag => attendanceFlagLabel(flag, isRtl)).join(' · ')}</p>
            </div>
            <button disabled={attendance.busy} className="rounded-lg border px-2 py-1 cursor-pointer hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors" onClick={() => {
              if (record.status === 'confirmed') {
                handleDeleteAttendedStudent(record.rosterStudentId, record.officialName);
              } else {
                void attendance.updateCell(record.rosterStudentId, selectedLecture.id, 'present');
              }
            }}>{record.status === 'confirmed' ? (isRtl ? 'إلغاء' : 'Void') : (isRtl ? 'استعادة' : 'Restore')}</button>
          </div>)}
          {activeSession.reviewReceipts.map(receipt => <div key={receipt.requestId} className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <div className="flex items-center gap-1.5">
              {receipt.reason === 'late_arrival' && (
                <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-bold text-amber-900">
                  {isRtl ? 'وصول متأخر' : 'LATE'}
                </span>
              )}
              <strong>{activeSession.roster.find(student => student.studentId === receipt.rosterStudentId)?.officialName || receipt.rosterStudentId}</strong>
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              {attendanceLocationBadge(receipt.advisory, isRtl) && (
                <span className="text-[11px] font-bold text-amber-900">
                  {attendanceLocationBadge(receipt.advisory, isRtl)}
                </span>
              )}
              {attendanceScanTimeBadge(receipt.advisory, isRtl) && (
                <span className="text-[11px] font-bold text-teal-800 bg-teal-100/70 px-2 py-0.5 rounded-lg">
                  {attendanceScanTimeBadge(receipt.advisory, isRtl)}
                </span>
              )}
            </div>
            <p className="mt-1">{attendanceFlagLabel(receipt.reason, isRtl)} · {receipt.requestId}</p>
            <div className="mt-2">
              <button disabled={attendance.busy || ['device_session_conflict', 'device_unverified'].includes(receipt.reason)} className="me-2 rounded-lg bg-teal-600 px-2 py-1 text-white disabled:opacity-50" onClick={() => {
                const isLate = receipt.reason === 'late_arrival';
                const enrollment = ['device_enrollment_required', 'device_change_required'].includes(receipt.reason);
                if (isLate) {
                  if (window.confirm(isRtl ? 'هذا الإيصال تم استلامه بعد الموعد النهائي التلقائي (36 ساعة). هل تؤكد الحضور بصفتك أستاذ المادة؟' : 'This receipt arrived after the 36-hour automatic deadline. Do you confirm attendance as the authorized doctor?')) {
                    void attendance.review(receipt.requestId, enrollment, 'confirm', true);
                  }
                  return;
                }
                if (!enrollment || window.confirm(isRtl ? 'هل تحققت شخصياً من هوية الطالب وملكية الجهاز؟' : 'Did you personally verify identity and device ownership?')) void attendance.review(receipt.requestId, enrollment, 'confirm');
              }}>{isRtl ? 'تأكيد' : 'Confirm'}</button>
              <button disabled={attendance.busy} className="rounded-lg bg-red-700 px-2 py-1 text-white" onClick={() => void attendance.review(receipt.requestId, false, 'reject')}>{isRtl ? 'رفض' : 'Reject'}</button>
            </div>
          </div>)}
        </div>
      </div>}

      {/* All Attended Students Modal with Quick Delete & Search */}
      {isAllAttendedModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div 
            className="w-full max-w-lg md:max-w-xl max-h-[85vh] flex flex-col rounded-3xl bg-white shadow-2xl border border-slate-200 dark:bg-zinc-900 dark:border-zinc-800 overflow-hidden"
            dir={isRtl ? 'rtl' : 'ltr'}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-zinc-800">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300">
                  <Users className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-black text-slate-900 dark:text-zinc-100">
                    {isRtl ? 'قائمة الحضور المسجل للمحاضرة' : 'Attended Students Roster'}
                  </h3>
                  <p className="text-xs text-slate-400 dark:text-zinc-500">
                    {isRtl ? `إجمالي ${allConfirmedRecords.length} طالب حاضر • يمكنك البحث وإلغاء أي طالب مسجل بالخطأ` : `Total ${allConfirmedRecords.length} present • Search and remove any mistaken entry`}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsAllAttendedModalOpen(false)}
                className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 transition-colors cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Search Input */}
            <div className="p-4 border-b border-slate-100 dark:border-zinc-800 bg-slate-50/50 dark:bg-zinc-800/40">
              <div className="relative">
                <Search className="absolute start-3 top-3 h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  value={attendedSearchQuery}
                  onChange={(e) => setAttendedSearchQuery(e.target.value)}
                  placeholder={isRtl ? 'ابحث بالاسم الرسمي أو الرمز لإلغاء الحضور...' : 'Search official name or ID to remove...'}
                  className="w-full rounded-xl border border-slate-200 bg-white py-2 pe-3 ps-9 text-xs font-bold text-slate-800 placeholder-slate-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
            </div>

            {/* List of Attended Students */}
            <div className="p-4 space-y-2 flex-1 overflow-y-auto">
              {filteredConfirmedRecords.length > 0 ? (
                filteredConfirmedRecords.map((record) => (
                  <div
                    key={record.id}
                    className="flex items-center justify-between p-3 rounded-2xl border border-slate-100 bg-slate-50/60 dark:border-zinc-800 dark:bg-zinc-800/50 hover:bg-white dark:hover:bg-zinc-800 transition-colors"
                  >
                    <div className="min-w-0 pe-2">
                      <div className="flex items-center gap-2">
                        <span className="font-black text-xs text-slate-800 dark:text-zinc-100 truncate">
                          {record.officialName}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.2 rounded font-mono font-bold bg-slate-200/70 text-slate-600 dark:bg-zinc-700 dark:text-zinc-300">
                          {record.entryMethod === 'manual' ? (isRtl ? 'يدوي' : 'Manual') : 'QR'}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-400 mt-0.5">
                        {record.rosterStudentId} • {new Date(record.receivedAt).toLocaleTimeString(isRtl ? 'ar-IQ' : 'en-GB', { timeZone: 'Asia/Baghdad', hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleDeleteAttendedStudent(record.rosterStudentId, record.officialName)}
                      disabled={attendance.busy}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300 text-xs font-bold transition-colors cursor-pointer"
                      title={isRtl ? 'إلغاء الحضور' : 'Void attendance'}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>{isRtl ? 'إلغاء الحضور' : 'Remove'}</span>
                    </button>
                  </div>
                ))
              ) : (
                <div className="py-8 text-center text-xs text-slate-400 font-bold">
                  {isRtl ? 'لا يوجد طلاب مطابقون في الحضور المسجل' : 'No matching attended students found'}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-slate-100 dark:border-zinc-800 bg-slate-50/50 dark:bg-zinc-800/40 flex justify-end">
              <button
                type="button"
                onClick={() => setIsAllAttendedModalOpen(false)}
                className="px-4 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-slate-800 dark:text-zinc-100 text-xs font-bold transition-colors cursor-pointer"
              >
                {isRtl ? 'إغلاق' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
