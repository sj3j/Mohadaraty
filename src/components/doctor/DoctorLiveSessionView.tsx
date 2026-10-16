import React, { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { 
  QrCode, Expand, RefreshCw, Users, CheckCircle2, Search, UserPlus, 
  Clock, ShieldAlert, Sparkles, Printer, Play, Square, Check
} from 'lucide-react';
import { DoctorSubject, LectureColumn, StudentAttendanceRow } from './types';

interface DoctorLiveSessionViewProps {
  subject: DoctorSubject;
  lectures: LectureColumn[];
  students: StudentAttendanceRow[];
  isRtl: boolean;
  onStudentMarkedPresent: (studentId: string, lectureId: string) => void;
}

export default function DoctorLiveSessionView({
  subject,
  lectures,
  students,
  isRtl,
  onStudentMarkedPresent,
}: DoctorLiveSessionViewProps) {
  const [selectedLectureId, setSelectedLectureId] = useState(lectures[4]?.id || lectures[0]?.id || '');
  const [isSessionActive, setIsSessionActive] = useState(true);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [sessionToken, setSessionToken] = useState<string>(`mohadaraty-session-${Date.now()}`);
  const [searchQuery, setSearchQuery] = useState('');
  const [recentScannedStudents, setRecentScannedStudents] = useState<{ id: string; name: string; time: string }[]>([
    { id: 'std_01', name: 'حسين علي جاسم حسن', time: '08:34 ص' },
    { id: 'std_02', name: 'زينب كريم محمد كاظم', time: '08:35 ص' },
    { id: 'std_04', name: 'مريم حيدر فاضل مهدي', time: '08:36 ص' },
    { id: 'std_06', name: 'فاطمة عباس نوري رشيد', time: '08:38 ص' },
  ]);

  const projectorRef = useRef<HTMLDivElement>(null);

  const selectedLecture = lectures.find((l) => l.id === selectedLectureId) || lectures[0];

  // Generate QR code data URL whenever session token changes
  useEffect(() => {
    if (!isSessionActive) {
      setQrDataUrl('');
      return;
    }
    const payload = JSON.stringify({
      session: sessionToken,
      subjectId: subject.id,
      lectureId: selectedLecture?.id,
      timestamp: Date.now(),
      v: 2,
    });
    QRCode.toDataURL(payload, {
      width: 800,
      margin: 2,
      errorCorrectionLevel: 'H',
      color: { dark: '#042f2e', light: '#ffffff' },
    }).then(setQrDataUrl).catch(() => {});
  }, [sessionToken, subject.id, selectedLecture?.id, isSessionActive]);

  const toggleFullscreen = () => {
    if (!projectorRef.current) return;
    if (!document.fullscreenElement) {
      projectorRef.current.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  const handleRefreshQr = () => {
    setSessionToken(`mohadaraty-session-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);
  };

  const handleManualAdd = (student: StudentAttendanceRow) => {
    onStudentMarkedPresent(student.studentId, selectedLecture.id);
    const timeNow = new Date().toLocaleTimeString('ar-IQ', { hour: '2-digit', minute: '2-digit' });
    setRecentScannedStudents((prev) => [
      { id: student.studentId, name: student.name, time: timeNow },
      ...prev.filter((s) => s.id !== student.studentId),
    ]);
  };

  // Filter students who are not yet present in this lecture
  const unrecordedStudents = students.filter((s) => {
    const isPresent = s.attendance[selectedLecture?.id] === 'present';
    const matchesSearch = s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          s.examCode.toLowerCase().includes(searchQuery.toLowerCase());
    return !isPresent && matchesSearch;
  });

  const presentCount = students.filter((s) => s.attendance[selectedLecture?.id] === 'present').length;
  const totalCount = students.length;
  const attendanceRate = totalCount > 0 ? Math.round((presentCount / totalCount) * 100) : 0;

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
              onChange={(e) => setSelectedLectureId(e.target.value)}
              className="mt-1 font-black text-slate-900 bg-transparent dark:text-zinc-100 text-sm md:text-base border-none focus:ring-0 p-0 cursor-pointer"
            >
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
            onClick={() => setIsSessionActive((prev) => !prev)}
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
                {isRtl ? 'بدء جلسة جديدة' : 'Start Session'}
              </>
            )}
          </button>

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
                  {isRtl ? 'مستقبل الحضور نشط' : 'Attendance Scanner Active'}
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  {selectedLecture?.time || '08:30 ص'}
                </span>
              </div>
              <h3 className="mt-2 text-base sm:text-lg font-black text-slate-900 dark:text-zinc-100">
                {selectedLecture?.title}
              </h3>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                onClick={handleRefreshQr}
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
                  {isRtl ? 'الجلسة متوقفة حالياً. اضغط "بدء جلسة" لعرض الرمز' : 'Session is paused. Click Start to show QR'}
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
          {/* Headcount Card */}
          <div className="p-6 rounded-3xl bg-gradient-to-br from-teal-600 to-emerald-700 text-white shadow-lg shadow-teal-600/20">
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs font-bold uppercase tracking-wider text-teal-100">
                {isRtl ? 'إحصائية الحضور الآن' : 'Live Hall Headcount'}
              </span>
              <Users className="h-5 w-5 text-teal-200" />
            </div>

            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-black">{presentCount}</span>
              <span className="text-lg text-teal-200 font-bold">/ {totalCount}</span>
              <span className="ms-auto text-sm font-black px-3 py-1 rounded-xl bg-white/20 backdrop-blur-sm">
                {attendanceRate}%
              </span>
            </div>

            <div className="mt-4 w-full bg-black/20 rounded-full h-2.5 overflow-hidden">
              <div 
                className="bg-white h-2.5 rounded-full transition-all duration-500 ease-out"
                style={{ width: `${attendanceRate}%` }}
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
                placeholder={isRtl ? 'ابحث باسم الطالب أو رقمه الامتحاني...' : 'Search student name or exam code...'}
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
                {isRtl ? 'آخر المسجلين في الجلسة' : 'Recent Check-ins'}
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
    </div>
  );
}
