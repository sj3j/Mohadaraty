import React, { useState } from 'react';
import { ArrowLeft, ArrowRight, CalendarCheck2, GraduationCap, User } from 'lucide-react';
import type { Language, UserProfile } from '../../types';
import StudentSimosanView from './StudentSimosanView';
import DoctorPortal from '../doctor/DoctorPortal';
import { canManageAttendance } from '../../lib/permissions';

interface SimosanPageProps {
  user: UserProfile;
  lang: Language;
  stageId: string;
  onBack: () => void;
}

export default function SimosanPage({ user, lang, stageId, onBack }: SimosanPageProps) {
  const isRtl = lang === 'ar';
  const Back = isRtl ? ArrowRight : ArrowLeft;
  const hasStaffManage = canManageAttendance(user);
  const [viewMode, setViewMode] = useState<'student' | 'doctor'>('student');

  // If in lecturer/doctor portal mode, render full-width DoctorPortal
  if (hasStaffManage && viewMode === 'doctor') {
    return (
      <div className="relative min-h-screen bg-slate-50 dark:bg-zinc-950">
        <DoctorPortal
          user={user}
          lang={lang}
          stageId={stageId}
          onLogout={onBack}
          onBack={() => setViewMode('student')}
        />
      </div>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-8 pt-4" dir={isRtl ? 'rtl' : 'ltr'}>
      <header className="sticky top-0 z-20 -mx-4 mb-5 border-b border-slate-200/80 bg-stone-50/95 px-4 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button onClick={onBack} className="rounded-full p-2 hover:bg-slate-200/70 dark:hover:bg-zinc-800 transition-colors" aria-label="Back">
              <Back className="h-5 w-5" />
            </button>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
              <CalendarCheck2 className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-black text-slate-900 dark:text-zinc-100">
                {isRtl ? 'سجل الحضور والغياب' : 'Attendance Portal'}
              </h1>
              <p className="text-xs text-slate-500 dark:text-zinc-400">
                {isRtl ? 'تتبع حضور المواد ومسح رمز الحضور المباشر' : 'Track subject attendance & live QR scanner'}
              </p>
            </div>
          </div>

        </div>

        {/* Staff / Admin View Switcher: Toggle between Student UI & Lecturer Portal */}
        {hasStaffManage && (
          <div className="mt-3.5 flex items-center gap-2 p-1.5 rounded-2xl bg-slate-200/80 dark:bg-zinc-800 text-xs">
            <button
              onClick={() => setViewMode('student')}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl font-black transition-all cursor-pointer ${
                viewMode === 'student'
                  ? 'bg-white text-emerald-700 shadow-md shadow-slate-200/50 dark:bg-zinc-900 dark:text-emerald-400 dark:shadow-none'
                  : 'text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              <User className="h-4 w-4" />
              <span>{isRtl ? 'شاشة الطالب (Student UI)' : 'Student View'}</span>
            </button>
            <button
              onClick={() => setViewMode('doctor')}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl font-black transition-all cursor-pointer ${
                viewMode === 'doctor'
                  ? 'bg-teal-600 text-white shadow-md shadow-teal-600/30'
                  : 'text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              <GraduationCap className="h-4 w-4" />
              <span>{isRtl ? 'بوابة التدريسيين (Lecturer Portal)' : 'Lecturer Portal'}</span>
            </button>
          </div>
        )}
      </header>

      {/* Main Student Attendance UI */}
      <StudentSimosanView key={user.uid} user={user} lang={lang} />
    </main>
  );
}
