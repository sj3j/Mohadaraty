import React, { useState } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { Loader2, GraduationCap, X, AlertTriangle } from 'lucide-react';
import { Language, UserProfile } from '../types';
import { submitExamCode } from '../services/accountService';

/** How long "ask me later" holds. Long enough not to nag, short enough to land. */
export const SNOOZE_DAYS = 7;

/**
 * How long a skip on the onboarding screen holds.
 *
 * Much shorter than the banner's week: skipping there is one tap in the middle
 * of a flow the student is trying to get through, not a considered "not yet",
 * and a promoted student is being asked for a number that was probably issued
 * the same week. A week of silence would land them in the app with the tile
 * still empty and nothing to remind them.
 */
export const ONBOARDING_SNOOZE_DAYS = 1;

/**
 * Postpones the prompt for `days`.
 *
 * An ordinary client write, unlike the code itself: examCodePromptSnoozedUntil
 * is not in the firestore.rules freeze list, and it is nobody's business but
 * the student's. Never throws - losing a snooze only means being asked again,
 * which must not be allowed to block whatever the caller was doing.
 */
export async function snoozeExamCodePrompt(uid: string, days = SNOOZE_DAYS): Promise<void> {
  try {
    const until = new Date(Date.now() + days * 86400000).toISOString();
    await updateDoc(doc(db, 'users', uid), { examCodePromptSnoozedUntil: until });
  } catch (err) {
    console.error('Failed to snooze the exam-code prompt:', err);
  }
}

/**
 * True when this student should be asked for their exam code.
 *
 * Staff are never asked - the field is a student attribute. A code that is
 * already set is never re-asked, and neither is one currently snoozed.
 */
export function shouldAskForExamCode(user: UserProfile | null): boolean {
  if (!user || user.role !== 'student') return false;
  if ((user.examCode || '').trim()) return false;

  const until = user.examCodePromptSnoozedUntil;
  if (until && new Date(until).getTime() > Date.now()) return false;
  return true;
}

/**
 * Asks for the exam code the roster import no longer collects.
 *
 * It used to be a CSV column, which meant a student whose number had not been
 * issued yet could not be imported at all. Now they are imported without one
 * and asked here, with "ask me later" for the ones who still do not have it.
 *
 * Saving goes through /api/me/exam-code rather than the SDK: firestore.rules
 * freezes users.examCode against self-edits and makes `students` admin-only,
 * both deliberately - the code has to be written by the server or not at all.
 *
 * The snooze, by contrast, is an ordinary client write: it is not in the freeze
 * list, and it is nobody's business but the student's.
 */
export default function ExamCodePrompt({
  user, lang, onResolved, variant = 'banner',
}: {
  user: UserProfile;
  lang: Language;
  /** Hides the card. App.tsx holds the flag; the profile is not re-fetched. */
  onResolved: () => void;
  /**
   * 'dialog' is the same form reached deliberately from the profile, for a
   * student who tapped "ask me later" and then found their number. Without it
   * that choice would cost them a week.
   */
  variant?: 'banner' | 'dialog';
}) {
  const isRtl = lang === 'ar';
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await submitExamCode(value.trim());
      onResolved();
    } catch (err: any) {
      setError(err.message || (isRtl ? 'تعذّر حفظ الرقم.' : 'Could not save the code.'));
    } finally {
      setBusy(false);
    }
  };

  const snooze = async () => {
    setBusy(true);
    await snoozeExamCodePrompt(user.uid);
    setBusy(false);
    onResolved();
  };

  if (variant === 'dialog') {
    return (
      <div
        className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
        dir={isRtl ? 'rtl' : 'ltr'}
        onClick={onResolved}
      >
        <div
          className="w-full max-w-sm bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-xl"
          onClick={e => e.stopPropagation()}
        >
          <div className="w-14 h-14 bg-indigo-100 dark:bg-indigo-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
            <GraduationCap className="w-7 h-7 text-indigo-600 dark:text-indigo-400" />
          </div>
          <h2 className="text-lg font-black text-center text-slate-900 dark:text-stone-100 mb-1">
            {isRtl ? 'الرقم الامتحاني' : 'Exam number'}
          </h2>
          <p className="text-center text-xs font-bold text-slate-400 mb-5">
            {isRtl ? 'أرقام فقط. لا يمكن تغييره بعد الحفظ.' : 'Digits only. It cannot be changed after saving.'}
          </p>

          <form onSubmit={save} className="space-y-3">
            <input
              value={value}
              onChange={e => setValue(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              required
              autoFocus
              placeholder={isRtl ? 'مثال: 1023' : 'e.g. 1023'}
              dir="ltr"
              className="w-full bg-slate-50 dark:bg-zinc-950 border-2 border-slate-100 dark:border-zinc-800 rounded-xl px-4 py-3 outline-none focus:border-indigo-500 dark:text-stone-100 text-center font-mono font-black text-lg"
            />

            {error && (
              <p className="text-xs font-bold text-rose-600 dark:text-rose-400 flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                <span>{error}</span>
              </p>
            )}

            <button
              type="submit"
              disabled={busy || !value}
              className="w-full py-3 bg-indigo-600 text-white rounded-xl font-black hover:bg-indigo-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              {isRtl ? 'حفظ' : 'Save'}
            </button>
            <button
              type="button"
              onClick={onResolved}
              className="w-full py-2.5 rounded-xl font-bold text-sm text-slate-500 hover:bg-slate-50 dark:hover:bg-zinc-800"
            >
              {isRtl ? 'إلغاء' : 'Cancel'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-indigo-600 text-white px-4 py-3 sm:px-6 lg:px-8">
      <form
        onSubmit={save}
        className="flex flex-col sm:flex-row sm:items-center gap-3 max-w-5xl mx-auto"
      >
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <GraduationCap className="w-5 h-5 shrink-0" />
          <p className="text-sm font-medium">
            {isRtl ? 'أدخل رقمك الامتحاني' : 'Enter your exam number'}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <input
            value={value}
            onChange={e => setValue(e.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            required
            placeholder={isRtl ? 'مثال: 1023' : 'e.g. 1023'}
            dir="ltr"
            className="w-32 px-3 py-1.5 rounded-lg text-slate-900 text-sm font-bold bg-white placeholder-slate-400 outline-none focus:ring-2 focus:ring-white/60"
          />
          <button
            type="submit"
            disabled={busy || !value}
            className="px-4 py-1.5 bg-white text-indigo-600 text-sm font-bold rounded-lg hover:bg-indigo-50 transition-colors whitespace-nowrap disabled:opacity-50 flex items-center gap-1.5"
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {isRtl ? 'حفظ' : 'Save'}
          </button>
          <button
            type="button"
            onClick={snooze}
            disabled={busy}
            className="px-3 py-1.5 text-sm font-bold rounded-lg hover:bg-white/20 transition-colors whitespace-nowrap disabled:opacity-50"
          >
            {isRtl ? 'اسألني بعدين' : 'Ask me later'}
          </button>
          <button
            type="button"
            onClick={snooze}
            disabled={busy}
            className="p-1.5 hover:bg-white/20 rounded-lg transition-colors sm:hidden"
            title={isRtl ? 'لاحقاً' : 'Later'}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <p className="text-xs font-bold flex items-center gap-1.5 sm:basis-full">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
