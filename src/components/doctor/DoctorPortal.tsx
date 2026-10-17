/**
 * Lecturer portal. Session and cell permissions are enforced by the Firebase-authenticated
 * attendance gateway against exact stage and timetable-slot assignments.
 * The ledger uses audited manual confirm/void operations. Sanctions analytics require
 * an approved institutional policy and are intentionally not displayed.
 */

import React, { useState } from 'react';
import { 
  QrCode, FileSpreadsheet, BarChart3, LogOut, BookOpen, 
  ChevronDown, GraduationCap, Sparkles, Layers, ArrowRight, ArrowLeft, RefreshCw
} from 'lucide-react';
import type { Language, UserProfile } from '../../types';
import { DoctorSubject, DoctorPortalTab, LectureMode, LectureColumn, StudentAttendanceRow, AttendanceCellStatus } from './types';
import { useDoctorAttendance } from './useDoctorAttendance';
import SubjectModeModal from './SubjectModeModal';
import DoctorLiveSessionView from './DoctorLiveSessionView';
import DoctorExcelTimetableView from './DoctorExcelTimetableView';


interface DoctorPortalProps {
  user: UserProfile;
  lang: Language;
  onLogout: () => void;
  onBack?: () => void;
  onOpenOfflineTools?: () => void;
  stageId?: string;
}

export default function DoctorPortal({ user, lang, onLogout, onBack, onOpenOfflineTools, stageId }: DoctorPortalProps) {
  const isRtl = lang === 'ar';
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;

  const attendance = useDoctorAttendance(user.uid, isRtl, stageId);
  const availableSubjects: DoctorSubject[] = (attendance.workspace?.subjects || []).map(subject => ({
    id: subject.id, nameAr: subject.nameAr, nameEn: subject.nameEn,
    stageId: attendance.workspace!.stageId, stageNameAr: attendance.workspace!.stageId,
    type: subject.type,
  }));
  const [selectedSubjectId, setSelectedSubjectId] = useState('');
  const selectedSubject = availableSubjects.find(subject => subject.id === selectedSubjectId) || availableSubjects[0];
  const [selectedMode, setSelectedMode] = useState<LectureMode>('both');
  const [matrixPage, setMatrixPage] = useState<number | null>(null);
  const [isSubjectModalOpen, setIsSubjectModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<DoctorPortalTab>('excel');
  const assignedSlots = new Set(attendance.workspace?.subjects.find(subject => subject.id === selectedSubject?.id)?.timetableSessionIds || []);
  const activeOccurrences = (attendance.workspace?.bootstrap.occurrences || []).filter(occurrence =>
    assignedSlots.has(occurrence.timetableSessionId)
    && (selectedMode === 'both' || occurrence.mode === (selectedMode === 'theoretical' ? 'theory' : 'practical'))
  );
  const activeLectures: LectureColumn[] = activeOccurrences.map((occurrence, index) => ({
    id: occurrence.id, number: index + 1, date: occurrence.lectureDate,
    title: occurrence.title, mode: occurrence.mode === 'practical' ? 'practical' : 'theoretical',
    time: occurrence.startTime, location: occurrence.location,
  }));
  const matrixPageSize = 20;
  const totalMatrixPages = Math.max(1, Math.ceil(activeLectures.length / matrixPageSize));
  const serverDate = attendance.workspace?.bootstrap.serverNow
    ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Baghdad', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(attendance.workspace.bootstrap.serverNow)) : '';
  const nearestIndex = activeOccurrences.findIndex(occurrence => occurrence.lectureDate >= serverDate);
  const suggestedPage = Math.floor((nearestIndex < 0 ? Math.max(0, activeLectures.length - 1) : nearestIndex) / matrixPageSize);
  const currentMatrixPage = Math.max(0, Math.min(matrixPage ?? suggestedPage, totalMatrixPages - 1));
  const matrixLectures = activeLectures.slice(currentMatrixPage * matrixPageSize, (currentMatrixPage + 1) * matrixPageSize);
  const students = attendance.students;
  const handleUpdateAttendance = (studentId: string, lectureId: string, newStatus: AttendanceCellStatus) => {
    void attendance.updateCell(studentId, lectureId, newStatus);
  };
  const handleStudentMarkedPresent = (studentId: string, lectureId: string) => {
    void attendance.updateCell(studentId, lectureId, 'present');
  };
  if (!selectedSubject) return <div className="min-h-screen p-6 dark:bg-zinc-950 dark:text-white" role="status">
    {attendance.error || (isRtl ? 'جاري تحميل تكليفات التدريسي والمواد…' : 'Loading assigned subjects and timetable…')}
    <button className="ms-3 rounded-xl bg-teal-600 px-3 py-2 text-white" onClick={() => void attendance.refresh()}>{isRtl ? 'إعادة المحاولة' : 'Retry'}</button>
    <button className="ms-3" onClick={onLogout}>{isRtl ? 'خروج' : 'Sign out'}</button>
  </div>;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-zinc-950 dark:text-zinc-100 font-sans" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Subject & Mode Selection Modal */}
      <SubjectModeModal
        isOpen={isSubjectModalOpen}
        onClose={() => setIsSubjectModalOpen(false)}
        subjects={availableSubjects}
        selectedSubject={selectedSubject}
        onSelectSubject={(subj) => {
          setSelectedSubjectId(subj.id);
          setSelectedMode(subj.type || 'both');
          setMatrixPage(null);
        }}
        selectedMode={selectedMode}
        onSelectMode={mode => { setSelectedMode(mode); setMatrixPage(null); }}
        isRtl={isRtl}
      />

      {/* Doctor Portal Dedicated Top Header */}
      <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/95 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-900/95 shadow-xs">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-3.5">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            {/* Left/Start: Branding & Doctor Info */}
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-tr from-teal-600 to-emerald-500 text-white shadow-md shadow-teal-600/20">
                <GraduationCap className="h-6 w-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-base font-black text-slate-900 dark:text-zinc-100">
                    {user.name ? `د. ${user.name}` : (isRtl ? 'منصة الأستاذ التدريسي' : 'Doctor Attendance Portal')}
                  </h1>
                  <span className="px-2 py-0.5 rounded-md text-[10px] font-black bg-teal-100 text-teal-800 dark:bg-teal-950/60 dark:text-teal-300">
                    {isRtl ? 'بوابة الحضور' : 'Attendance'}
                  </span>
                </div>
                <p className="text-xs text-slate-400 dark:text-zinc-500">
                  {selectedSubject.stageNameAr} • كلية الصيدلة
                </p>
              </div>
            </div>

            {/* Middle: Subject & Mode Selector Trigger Button */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsSubjectModalOpen(true)}
                className="flex items-center gap-2.5 px-4 py-2 rounded-2xl border border-slate-200 bg-slate-50/80 hover:bg-slate-100 dark:border-zinc-700/80 dark:bg-zinc-800/80 dark:hover:bg-zinc-700 transition-all text-xs font-black shadow-xs"
              >
                <BookOpen className="h-4 w-4 text-teal-600 dark:text-teal-400" />
                <span className="truncate max-w-[180px] sm:max-w-[260px] text-slate-800 dark:text-zinc-200">
                  {isRtl ? selectedSubject.nameAr : selectedSubject.nameEn}
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded-md bg-teal-500/10 text-teal-700 dark:text-teal-300">
                  {selectedMode === 'both' ? (isRtl ? 'نظري + عملي' : 'All') : selectedMode === 'practical' ? (isRtl ? 'عملي' : 'Prac') : (isRtl ? 'نظري' : 'Theo')}
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
              </button>
            </div>

            {/* Right/End: Actions */}
            <div className="flex items-center gap-2 ms-auto md:ms-0">
              <button onClick={() => void attendance.refresh()} disabled={attendance.busy} className="rounded-xl border border-teal-200 p-2 text-teal-700 disabled:opacity-40" title={isRtl ? 'تحديث سجل الحضور' : 'Refresh attendance ledger'}><RefreshCw className="h-4 w-4" /></button>
              {onOpenOfflineTools && (
                <button
                  onClick={onOpenOfflineTools}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-2xl text-xs font-bold border border-teal-200 bg-teal-50/60 text-teal-700 hover:bg-teal-100 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-300 transition-colors cursor-pointer"
                  title={isRtl ? 'حزمة العمل دون اتصال والمزامنة' : 'Offline Pack & Sync Tools'}
                >
                  <Sparkles className="h-4 w-4" />
                  <span className="hidden sm:inline">{isRtl ? 'أدوات دون اتصال' : 'Offline Tools'}</span>
                </button>
              )}
              {onBack ? (
                <button
                  onClick={onBack}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-2xl text-xs font-black text-slate-700 bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700 transition-colors cursor-pointer"
                  title={isRtl ? 'الرجوع لشاشة الطالب' : 'Return to Student View'}
                >
                  <BackIcon className="h-4 w-4" />
                  <span>{isRtl ? 'شاشة الطالب' : 'Student View'}</span>
                </button>
              ) : (
                <button
                  onClick={onLogout}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-2xl text-xs font-bold text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors cursor-pointer"
                  title={isRtl ? 'تسجيل الخروج' : 'Log out'}
                >
                  <LogOut className="h-4 w-4" />
                  <span className="hidden sm:inline">{isRtl ? 'تسجيل الخروج' : 'Log out'}</span>
                </button>
              )}
            </div>
          </div>

          {attendance.error && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{attendance.error}</p>}
          {attendance.workspace?.offline && <p role="status" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{isRtl ? 'عرض نسخة محفوظة؛ مزامنة الطلاب ستظهر عند عودة الاتصال' : 'Showing cached data; student uploads appear when connected'}</p>}
          {/* Navigation Tabs for the 3 Screens */}
          <div className="mt-3.5 flex items-center gap-1 border-t border-slate-100 pt-3 dark:border-zinc-800/80">
            {[
              {
                id: 'excel',
                labelAr: 'جدول الحضور العام (Excel)',
                labelEn: 'Master Attendance (Excel)',
                icon: FileSpreadsheet,
              },
              {
                id: 'live',
                labelAr: 'جلسة الحضور المباشرة (QR)',
                labelEn: 'Live Hall Session (QR)',
                icon: QrCode,
              },
            ].map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as DoctorPortalTab)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-2xl font-black text-xs transition-all ${
                    isActive
                      ? 'bg-teal-600 text-white shadow-md shadow-teal-600/20'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800/60'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span>{isRtl ? tab.labelAr : tab.labelEn}</span>
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
        {activeTab === 'live' && (
          <DoctorLiveSessionView
            subject={selectedSubject}
            lectures={activeLectures}
            students={students}
            isRtl={isRtl}
            onStudentMarkedPresent={handleStudentMarkedPresent}
            attendance={attendance}
          />
        )}

        {activeTab === 'excel' && (
          <div className="space-y-3">
            {totalMatrixPages > 1 && <div className="flex items-center justify-center gap-3 text-xs font-bold">
              <button disabled={currentMatrixPage === 0} onClick={() => setMatrixPage(currentMatrixPage - 1)} className="rounded-xl border px-3 py-2 disabled:opacity-40">{isRtl ? 'الأقدم' : 'Older'}</button>
              <span>{currentMatrixPage + 1} / {totalMatrixPages}</span>
              <button disabled={currentMatrixPage >= totalMatrixPages - 1} onClick={() => setMatrixPage(currentMatrixPage + 1)} className="rounded-xl border px-3 py-2 disabled:opacity-40">{isRtl ? 'الأحدث' : 'Newer'}</button>
            </div>}
          <DoctorExcelTimetableView
            subject={selectedSubject}
            lectures={matrixLectures}
            students={students}
            isRtl={isRtl}
            onUpdateAttendance={handleUpdateAttendance}
            isOffline={attendance.workspace?.offline === true}
          />
          </div>
        )}


      </main>
    </div>
  );
}

