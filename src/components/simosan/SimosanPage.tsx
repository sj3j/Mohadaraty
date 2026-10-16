import React from 'react';
import { ArrowLeft, ArrowRight, CalendarCheck2 } from 'lucide-react';
import type { Language, UserProfile } from '../../types';
import StudentSimosanView from './StudentSimosanView';
import ProfessorSimosanView from './ProfessorSimosanView';
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

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-8 pt-4" dir={isRtl ? 'rtl' : 'ltr'}>
      <header className="sticky top-0 z-20 -mx-4 mb-5 border-b border-slate-200/80 bg-stone-50/95 px-4 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="rounded-full p-2 hover:bg-slate-200/70 dark:hover:bg-zinc-800" aria-label="Back">
            <Back className="h-5 w-5" />
          </button>
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            <CalendarCheck2 className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-black">{isRtl ? 'سجل الحضور والغياب' : 'Attendance Portal'}</h1>
            <p className="text-xs text-slate-500">
              {isRtl ? 'تتبع حضور المواد ومسح رمز الحضور المباشر' : 'Track subject attendance & live QR scanner'}
            </p>
          </div>
        </div>
      </header>
      {canManageAttendance(user) ? <ProfessorSimosanView key={`${user.uid}:${stageId}`} ownerUid={user.uid} lang={lang} stageId={stageId} /> : <StudentSimosanView key={user.uid} user={user} lang={lang} />}
    </main>
  );
}
