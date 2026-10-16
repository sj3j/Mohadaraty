/**
 * ============================================================================
 * [LECTURER / DOCTOR TIER] BACKEND AGENT CONTRACT & INTEGRATION GUIDE
 * ============================================================================
 * 
 * 1. SCOPE & BOUNDARY:
 *    - EXCLUSIVELY DOCTOR / PROFESSOR-FACING.
 *    - Activation: Triggered in App.tsx when user.role === 'doctor'.
 *    - Bypasses student UI completely: drops standard bottom tabs, student courses,
 *      student timetable, and services navigation.
 *    - STRICT RULE FOR BACKEND AGENT: Doctor has authority ONLY over their assigned
 *      academic stage (user.assignedStageId) and assigned subjects (user.assignedSubjects, 1-2 subjects).
 *      DO NOT grant access to other stages, student profile editing, or system settings!
 * 
 * 2. CORE ARCHITECTURE — 3 DEDICATED DOCTOR SCREENS:
 * 
 *    SCREEN 1: Live QR Hall Session & Projector Display (DoctorLiveSessionView.tsx)
 *    - Purpose: Live classroom lecture attendance.
 *    - Projector Mode: Displays full-screen rotating/dynamic QR code for hall projector.
 *    - Live Attendees Feed: Real-time ticker of students checking in via camera.
 *    - Backend Requirements:
 *      * Connect to `POST /api/attendance/sessions` (shared/attendanceApi.ts).
 *      * Generate rotating dynamic cryptographic tokens (valid for ~15-30s) to prevent
 *        remote QR photo sharing over WhatsApp/Telegram.
 *      * Provide Close Session & Review actions.
 * 
 *    SCREEN 2: Excel-like Master Timetable Spreadsheet (DoctorExcelTimetableView.tsx)
 *    - Purpose: Official academic attendance ledger.
 *    - Layout: Sticky student column (Arabic name, group, code), followed by weekly lecture columns.
 *    - Interactive Cells: Doctor clicks any cell to toggle:
 *      * 'present' (✓ Present - Emerald)
 *      * 'absent' (✗ Absent - Rose)
 *      * 'excused' (⏱ Excused - Amber)
 *    - Feature: Export to official CSV / Excel sheet for college administration.
 *    - Backend Requirements:
 *      * Fetch student attendance matrix for the stage/subject.
 *      * Batch-save attendance overrides to Supabase `attendance_records`.
 * 
 *    SCREEN 3: Analytics, Trends & Deprivation Warnings (DoctorAnalyticsView.tsx)
 *    - Purpose: Attendance KPIs, charts, and student deprivation risk monitoring.
 *    - Calibration: Calibrated against the Iraqi Ministry 15% absence ceiling:
 *      * Safe (< 5%)
 *      * Alert (5% - 10%)
 *      * First Warning إنذار أول (10% - 15%)
 *      * Deprived حرمان (>= 15%)
 *    - Backend Requirements: Provide aggregate stats and one-click export for warnings.
 * 
 *    SUBJECT & MODE SELECTOR (SubjectModeModal.tsx):
 *    - Allows doctor to toggle between their assigned subjects (1 or 2).
 *    - Allows switching between Theoretical ('theoretical'), Practical ('practical'), or Both ('both').
 * ============================================================================
 */

import React, { useState } from 'react';
import { 
  QrCode, FileSpreadsheet, BarChart3, LogOut, BookOpen, 
  ChevronDown, GraduationCap, Sparkles, Layers 
} from 'lucide-react';
import type { Language, UserProfile } from '../../types';
import { DoctorSubject, DoctorPortalTab, LectureMode, StudentAttendanceRow, AttendanceCellStatus } from './types';
import { MOCK_DOCTOR_SUBJECTS, MOCK_LECTURES, MOCK_STUDENTS } from './mockData';
import SubjectModeModal from './SubjectModeModal';
import DoctorLiveSessionView from './DoctorLiveSessionView';
import DoctorExcelTimetableView from './DoctorExcelTimetableView';
import DoctorAnalyticsView from './DoctorAnalyticsView';

interface DoctorPortalProps {
  user: UserProfile;
  lang: Language;
  onLogout: () => void;
}

export default function DoctorPortal({ user, lang, onLogout }: DoctorPortalProps) {
  const isRtl = lang === 'ar';

  // Fallback to mock subjects if user has none assigned yet
  const availableSubjects: DoctorSubject[] = (user.assignedSubjects && user.assignedSubjects.length > 0)
    ? user.assignedSubjects.map((s) => ({
        id: s.id,
        nameAr: s.nameAr,
        nameEn: s.nameEn,
        stageId: user.assignedStageId || 'stage_3',
        stageNameAr: 'المرحلة الدراسية',
        type: s.type,
      }))
    : MOCK_DOCTOR_SUBJECTS;

  const [selectedSubject, setSelectedSubject] = useState<DoctorSubject>(availableSubjects[0]);
  const [selectedMode, setSelectedMode] = useState<LectureMode>(selectedSubject.type || 'both');
  const [isSubjectModalOpen, setIsSubjectModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<DoctorPortalTab>('excel');

  // Local mutable state for students' attendance in memory (no DB modification)
  const [students, setStudents] = useState<StudentAttendanceRow[]>(MOCK_STUDENTS);

  // Filter lectures matching active mode if theoretical or practical is selected
  const activeLectures = MOCK_LECTURES.filter((lec) => {
    if (selectedMode === 'both') return true;
    return lec.mode === selectedMode;
  });

  const handleUpdateAttendance = (studentId: string, lectureId: string, newStatus: AttendanceCellStatus) => {
    setStudents((prev) =>
      prev.map((student) => {
        if (student.studentId !== studentId) return student;
        return {
          ...student,
          attendance: {
            ...student.attendance,
            [lectureId]: newStatus,
          },
        };
      })
    );
  };

  const handleStudentMarkedPresent = (studentId: string, lectureId: string) => {
    handleUpdateAttendance(studentId, lectureId, 'present');
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-zinc-950 dark:text-zinc-100 font-sans" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Subject & Mode Selection Modal */}
      <SubjectModeModal
        isOpen={isSubjectModalOpen}
        onClose={() => setIsSubjectModalOpen(false)}
        subjects={availableSubjects}
        selectedSubject={selectedSubject}
        onSelectSubject={(subj) => {
          setSelectedSubject(subj);
          setSelectedMode(subj.type || 'both');
        }}
        selectedMode={selectedMode}
        onSelectMode={setSelectedMode}
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

            {/* Right/End: Logout Action */}
            <div className="flex items-center gap-2 ms-auto md:ms-0">
              <button
                onClick={onLogout}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-2xl text-xs font-bold text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors"
                title={isRtl ? 'تسجيل الخروج' : 'Log out'}
              >
                <LogOut className="h-4 w-4" />
                <span className="hidden sm:inline">{isRtl ? 'تسجيل الخروج' : 'Log out'}</span>
              </button>
            </div>
          </div>

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
              {
                id: 'analytics',
                labelAr: 'الإحصائيات والإنذارات',
                labelEn: 'Analytics & Sanctions',
                icon: BarChart3,
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
          />
        )}

        {activeTab === 'excel' && (
          <DoctorExcelTimetableView
            subject={selectedSubject}
            lectures={activeLectures}
            students={students}
            isRtl={isRtl}
            onUpdateAttendance={handleUpdateAttendance}
          />
        )}

        {activeTab === 'analytics' && (
          <DoctorAnalyticsView
            subject={selectedSubject}
            lectures={activeLectures}
            students={students}
            isRtl={isRtl}
          />
        )}
      </main>
    </div>
  );
}

