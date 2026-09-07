import React, { useRef, useState } from 'react';
import { db } from '../lib/firebase';
import { doc, setDoc } from 'firebase/firestore';
import { Language, UserProfile } from '../types';
import { AlertTriangle, GraduationCap, Loader2, UserCheck } from 'lucide-react';
import { useStageContext } from '../contexts/StageContext';
import { submitExamCode } from '../services/accountService';
import { ONBOARDING_SNOOZE_DAYS, shouldAskForExamCode, snoozeExamCodePrompt } from './ExamCodePrompt';

interface OnboardingScreenProps {
  user: UserProfile;
  lang: Language;
}

/** Mirrors EXAM_CODE_RE in shared/accountSelfService.ts, so a bad value is
 *  caught here rather than after a round trip. */
const EXAM_CODE_RE = /^\d{1,12}$/;

/**
 * The gate a student passes through when their group is unknown.
 *
 * Reached in two situations, and the second is why the exam code is here too:
 * a brand-new account that has never picked a group, and a student who was just
 * promoted - submitProgression clears both the group and the exam number,
 * because a group from the stage they left may not exist in the new one and an
 * exam number belongs to the year it was issued for.
 *
 * The group is required; the exam number is not. A student can be promoted
 * before their new number has been issued, so it is offered with a way past,
 * and the banner in App.tsx keeps asking afterwards.
 */
export default function OnboardingScreen({ user, lang }: OnboardingScreenProps) {
  const isRtl = lang === 'ar';

  const [group, setGroup] = useState('');
  const [examCode, setExamCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Revealed only after the exam code has actually failed, so an optional
   *  field can never be what walls a student out of a blocking screen. */
  const [showSkipEscape, setShowSkipEscape] = useState(false);
  /**
   * The code reached the server on an earlier attempt.
   *
   * Load-bearing on retry: if the code saved and the group write then failed,
   * a second attempt would POST the same code again, get 409 ALREADY_SET, and
   * - without this - stop before the group write for ever.
   */
  const askExamCode = shouldAskForExamCode(user);
  const codeAlreadySaved = useRef(false);

  // Offer only the subgroups the representative configured for this student's
  // stage, instead of letting them type anything into the field.
  const { groupConfig } = useStageContext();
  const subgroupOptions = groupConfig.groups.flatMap(g =>
    Array.from({ length: g.subgroupCount }, (_, i) => `${g.id}${i + 1}`)
  );

  /** The group write is LAST, always: App.tsx unmounts this screen the moment
   *  user.group lands, so anything after it has no UI left to report into. */
  const saveGroup = async () => {
    // setDoc-merge rather than updateDoc: the users document is not guaranteed
    // to exist on every path that reaches this screen.
    await setDoc(doc(db, 'users', user.uid), { group: group.trim() }, { merge: true });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!group.trim()) return;

    const code = examCode.trim();
    setIsLoading(true);
    setError(null);

    try {
      if (askExamCode && code && !codeAlreadySaved.current) {
        if (!EXAM_CODE_RE.test(code)) {
          setError(isRtl ? 'الرقم الامتحاني يجب أن يتكون من أرقام فقط.' : 'The exam number must be digits only.');
          setIsLoading(false);
          return;
        }
        try {
          await submitExamCode(code);
          codeAlreadySaved.current = true;
        } catch (err: any) {
          // 409 means a code is already on file - the student's intent is
          // satisfied, so this is a success for our purposes, not a failure.
          if (err?.status === 409) {
            codeAlreadySaved.current = true;
          } else {
            setError(err?.message || (isRtl ? 'تعذّر حفظ الرقم الامتحاني.' : 'Could not save the exam number.'));
            setShowSkipEscape(true);
            setIsLoading(false);
            return;
          }
        }
      }

      // Skipped the number outright: hold the prompt briefly so the banner does
      // not reappear on the very next screen.
      if (askExamCode && !code) {
        await snoozeExamCodePrompt(user.uid, ONBOARDING_SNOOZE_DAYS);
      }

      await saveGroup();
      // App.tsx re-renders on its own once user.group is set.
    } catch (err) {
      console.error('Error updating profile:', err);
      setError(isRtl ? 'حدث خطأ أثناء حفظ البيانات' : 'Error saving data');
      setIsLoading(false);
    }
  };

  /** The way past a number that will not save. Keeps the group, drops the code. */
  const continueWithoutCode = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await snoozeExamCodePrompt(user.uid, ONBOARDING_SNOOZE_DAYS);
      await saveGroup();
    } catch (err) {
      console.error('Error updating profile:', err);
      setError(isRtl ? 'حدث خطأ أثناء حفظ البيانات' : 'Error saving data');
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 dark:bg-zinc-950 p-4" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="w-full max-w-md bg-white dark:bg-zinc-900 rounded-3xl p-8 shadow-xl border border-slate-200 dark:border-zinc-800">
        <div className="w-16 h-16 bg-sky-100 dark:bg-sky-900/30 rounded-full flex items-center justify-center mx-auto mb-6">
          <UserCheck className="w-8 h-8 text-sky-600 dark:text-sky-400" />
        </div>

        <h1 className="text-2xl font-black text-center text-slate-900 dark:text-stone-100 mb-2">
          {isRtl ? 'أكمل ملفك الشخصي' : 'Complete Your Profile'}
        </h1>
        <p className="text-center text-slate-500 dark:text-slate-400 mb-8 text-sm">
          {askExamCode
            ? (isRtl
                ? 'يرجى إدخال الجروب للمتابعة، ورقمك الامتحاني إن توفّر.'
                : 'Please enter your group to continue, and your exam number if you have it.')
            : (isRtl ? 'يرجى إدخال الجروب للمتابعة' : 'Please enter your group to continue')}
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
              {isRtl ? 'الجروب (Group)' : 'Group'}
            </label>
            <select
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              required
              className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl px-4 py-3 outline-none focus:border-sky-500 dark:text-stone-100 transition-colors"
            >
              <option value="">{isRtl ? 'اختر الجروب' : 'Select your group'}</option>
              {subgroupOptions.map(sub => (
                <option key={sub} value={sub}>
                  {isRtl ? `المجموعة ${sub}` : `Group ${sub}`}
                </option>
              ))}
            </select>
          </div>

          {askExamCode && (
            <div>
              <label className="flex items-center gap-2 text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
                <GraduationCap className="w-4 h-4 text-indigo-500 shrink-0" />
                <span>{isRtl ? 'الرقم الامتحاني' : 'Exam number'}</span>
                <span className="font-bold text-xs text-slate-400">
                  {isRtl ? '(اختياري)' : '(optional)'}
                </span>
              </label>
              <input
                value={examCode}
                onChange={(e) => setExamCode(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                dir="ltr"
                placeholder={isRtl ? 'مثال: 1023' : 'e.g. 1023'}
                className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl px-4 py-3 outline-none focus:border-indigo-500 dark:text-stone-100 transition-colors text-center font-mono font-black"
              />
              <p className="mt-2 text-xs font-bold text-slate-400 dark:text-slate-500">
                {isRtl
                  ? 'أرقام فقط. لا يمكن تغييره بعد الحفظ، ويمكنك إضافته لاحقاً من ملفك الشخصي.'
                  : 'Digits only. It cannot be changed after saving, and you can add it later from your profile.'}
              </p>
            </div>
          )}

          {error && (
            <p className="text-xs font-bold text-rose-600 dark:text-rose-400 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>{error}</span>
            </p>
          )}

          <button
            type="submit"
            disabled={isLoading || !group.trim()}
            className="w-full py-4 bg-sky-600 text-white rounded-xl font-bold hover:bg-sky-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 mt-4"
          >
            {isLoading && <Loader2 className="w-5 h-5 animate-spin" />}
            <span>{isRtl ? 'حفظ ومتابعة' : 'Save and Continue'}</span>
          </button>

          {showSkipEscape && (
            <button
              type="button"
              onClick={continueWithoutCode}
              disabled={isLoading || !group.trim()}
              className="w-full py-2.5 rounded-xl font-bold text-sm text-slate-500 hover:bg-slate-50 dark:hover:bg-zinc-800 disabled:opacity-50"
            >
              {isRtl ? 'متابعة بدون الرقم' : 'Continue without the number'}
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
