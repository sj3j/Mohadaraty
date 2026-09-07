import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import confetti from 'canvas-confetti';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { Language, Subject, UserProfile, COURSE_IDS, COURSE_LABELS, CourseId } from '../types';
import { GraduationCap, CheckCircle2, RotateCcw, AlertTriangle, Loader2, PartyPopper, BookMarked } from 'lucide-react';
import { ProgressionRound } from '../../shared/progression';
import { apiUrl } from '../lib/apiBase';

interface ProgressionScreenProps {
  user: UserProfile;
  lang: Language;
  round: ProgressionRound;
  /** Refetches the user doc so the app can move past this screen. */
  onDone: () => void;
}

type Choice = 'passed' | 'resit' | 'tahmeel' | 'failed';

/**
 * The end-of-year question, asked once results are published and blocking until
 * answered. Round one is نجحت / دور ثاني; round two, after the resit results,
 * is نجحت / تحميل / رسبت.
 *
 * The answer goes to /api/progression/submit rather than straight to Firestore:
 * promotion has to write `students/{email}.stageId` too, which students cannot
 * do, and which syncUserStage would otherwise use to undo the whole thing at
 * their next login.
 */
export default function ProgressionScreen({ user, lang, round, onDone }: ProgressionScreenProps) {
  const isRtl = lang === 'ar';

  const [choice, setChoice] = useState<Choice | null>(null);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [selectedTahmeel, setSelectedTahmeel] = useState<string[]>([]);
  const [loadingSubjects, setLoadingSubjects] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ promoted: boolean; graduated: boolean; stageName: string | null } | null>(null);

  // Subjects of the stage they are LEAVING - تحميل carries them forward.
  useEffect(() => {
    if (round !== 'resit' || !user.stageId) return;
    let cancelled = false;
    setLoadingSubjects(true);
    getDocs(query(collection(db, 'subjects'), where('stageId', '==', user.stageId)))
      .then(snap => {
        if (cancelled) return;
        setSubjects(
          snap.docs.map(d => d.data() as Subject)
            .filter(s => s.isActive !== false)
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
        );
      })
      .catch(err => console.error('Error loading subjects:', err))
      .finally(() => { if (!cancelled) setLoadingSubjects(false); });
    return () => { cancelled = true; };
  }, [round, user.stageId]);

  const byCourse = useMemo(() => {
    const map = new Map<CourseId, Subject[]>();
    for (const id of COURSE_IDS) map.set(id, []);
    for (const s of subjects) {
      const course = (COURSE_IDS as readonly string[]).includes(s.courseId) ? s.courseId : COURSE_IDS[1];
      map.get(course as CourseId)!.push(s);
    }
    return map;
  }, [subjects]);

  const toggle = (id: string) =>
    setSelectedTahmeel(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const canSubmit = !!choice && !isSaving &&
    !(choice === 'tahmeel' && selectedTahmeel.length === 0);

  const handleSubmit = async () => {
    if (!canSubmit || !choice) return;
    setIsSaving(true);
    setError(null);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('No auth token');

      const res = await fetch(apiUrl('/api/progression/submit'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          round,
          answer: choice,
          tahmeelSubjects: choice === 'tahmeel' ? selectedTahmeel : [],
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        const apiErr = new Error(data.error || 'API error');
        (apiErr as any).isApiError = true;
        throw apiErr;
      }

      if (data.promoted || data.graduated) {
        setResult({
          promoted: data.promoted,
          graduated: data.graduated,
          stageName: isRtl ? data.stageNameAr : data.stageNameEn,
        });
        confetti({ particleCount: 120, spread: 75, origin: { y: 0.6 } });
        setTimeout(() => confetti({ particleCount: 80, spread: 100, origin: { y: 0.5 } }), 350);
      } else {
        onDone();
      }
    } catch (err: any) {
      console.error('Progression submit failed:', err);
      // Only the server's own error (e.g. "no progression question is open
      // yet") is specific enough to show as-is; a missing token or a real
      // network failure gets the generic connectivity message instead.
      setError(err?.isApiError && err.message
        ? err.message
        : isRtl
          ? 'تعذّر حفظ إجابتك. تحقّق من الاتصال وحاول مرة أخرى.'
          : 'Could not save your answer. Check your connection and try again.');
    } finally {
      setIsSaving(false);
    }
  };

  // ---- congratulations -----------------------------------------------------
  if (result) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-zinc-950 p-4" dir={isRtl ? 'rtl' : 'ltr'}>
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
          className="bg-white dark:bg-zinc-900 rounded-3xl p-8 w-full max-w-md text-center shadow-2xl border border-slate-200 dark:border-zinc-800"
        >
          <div className="w-20 h-20 bg-emerald-100 dark:bg-emerald-900/30 rounded-full flex items-center justify-center mx-auto mb-5">
            <PartyPopper className="w-10 h-10 text-emerald-600 dark:text-emerald-400" />
          </div>
          <h2 className="text-2xl font-black text-slate-900 dark:text-white mb-3">
            {result.graduated
              ? (isRtl ? 'مبروك التخرّج! 🎓' : 'Congratulations, graduate! 🎓')
              : (isRtl ? 'مبروك النجاح! 🎉' : 'Congratulations! 🎉')}
          </h2>
          <p className="text-slate-600 dark:text-slate-400 mb-8">
            {result.graduated
              ? (isRtl
                  ? 'أكملت مراحل الدراسة كلها. يبقى حسابك مفتوحاً للاطلاع على المحتوى.'
                  : 'You have completed every stage. Your account stays open for reading the content.')
              : (isRtl
                  ? `تم نقلك إلى ${result.stageName || 'المرحلة التالية'}. اختر شعبتك الجديدة، وأضف رقمك الامتحاني الجديد إن توفّر.`
                  : `You have moved up to ${result.stageName || 'the next stage'}. Pick your new group, and add your new exam number if you have it.`)}
          </p>
          <button
            onClick={onDone}
            className="w-full py-4 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold transition-colors"
          >
            {isRtl ? 'متابعة' : 'Continue'}
          </button>
        </motion.div>
      </div>
    );
  }

  // ---- the question --------------------------------------------------------
  const Option = ({ value, tone, icon: Icon, title, subtitle, children }: {
    value: Choice; tone: 'emerald' | 'amber' | 'rose' | 'sky';
    icon: any; title: string; subtitle: string; children?: React.ReactNode;
  }) => {
    const active = choice === value;
    const tones: Record<string, string> = {
      emerald: active ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20' : 'hover:border-emerald-300',
      amber:   active ? 'border-amber-500 bg-amber-50 dark:bg-amber-900/20'       : 'hover:border-amber-300',
      rose:    active ? 'border-rose-500 bg-rose-50 dark:bg-rose-900/20'          : 'hover:border-rose-300',
      sky:     active ? 'border-sky-500 bg-sky-50 dark:bg-sky-900/20'             : 'hover:border-sky-300',
    };
    const iconTone: Record<string, string> = {
      emerald: 'text-emerald-500', amber: 'text-amber-500', rose: 'text-rose-500', sky: 'text-sky-500',
    };
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => setChoice(value)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setChoice(value); } }}
        className={`w-full p-4 rounded-2xl border-2 transition-all cursor-pointer ${
          active ? tones[tone] : `border-slate-200 dark:border-zinc-800 ${tones[tone]}`
        }`}
      >
        <div className="flex items-center gap-4">
          <Icon className={`w-6 h-6 shrink-0 ${active ? iconTone[tone] : 'text-slate-400'}`} />
          <div className="text-start min-w-0">
            <div className="font-bold text-slate-900 dark:text-white">{title}</div>
            <div className="text-sm text-slate-600 dark:text-slate-400">{subtitle}</div>
          </div>
        </div>
        {children}
      </div>
    );
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-zinc-950 p-4" dir={isRtl ? 'rtl' : 'ltr'}>
      <motion.div
        initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
        className="bg-white dark:bg-zinc-900 rounded-3xl p-6 md:p-8 w-full max-w-lg shadow-2xl border border-slate-200 dark:border-zinc-800 max-h-[92vh] overflow-y-auto"
      >
        <div className="text-center mb-8">
          <div className="w-20 h-20 bg-sky-100 dark:bg-sky-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
            <GraduationCap className="w-10 h-10 text-sky-600 dark:text-sky-400" />
          </div>
          <h2 className="text-2xl font-black text-slate-900 dark:text-white mb-2">
            {isRtl ? 'نتيجة العام الدراسي' : 'Your result this year'}
          </h2>
          <p className="text-slate-600 dark:text-slate-400">
            {round === 'first'
              ? (isRtl
                  ? 'صدرت النتائج. اختر نتيجتك للمتابعة.'
                  : 'Results are out. Tell us how you did to continue.')
              : (isRtl
                  ? 'صدرت نتائج الدور الثاني. اختر نتيجتك للمتابعة.'
                  : 'The resit results are out. Tell us how you did to continue.')}
          </p>
        </div>

        <div className="space-y-3 mb-8">
          <Option
            value="passed" tone="emerald" icon={CheckCircle2}
            title={isRtl ? 'نجحت' : 'Passed'}
            subtitle={isRtl ? 'الانتقال إلى المرحلة التالية' : 'Move up to the next stage'}
          />

          {round === 'first' ? (
            <Option
              value="resit" tone="amber" icon={RotateCcw}
              title={isRtl ? 'دور ثاني' : 'Resit'}
              subtitle={isRtl
                ? 'سنسألك مرة أخرى عند صدور نتائج الدور الثاني'
                : 'We will ask again when the resit results are published'}
            />
          ) : (
            <>
              <Option
                value="tahmeel" tone="sky" icon={BookMarked}
                title={isRtl ? 'تحميل' : 'Carrying subjects'}
                subtitle={isRtl
                  ? 'الانتقال للمرحلة التالية مع مواد محمّلة'
                  : 'Move up while carrying subjects forward'}
              >
                <AnimatePresence>
                  {choice === 'tahmeel' && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                      className="mt-4 pt-4 border-t border-sky-200 dark:border-sky-800/50 overflow-hidden"
                      onClick={e => e.stopPropagation()}
                    >
                      <p className="text-sm font-bold text-slate-800 dark:text-slate-200 mb-3 text-start">
                        {isRtl ? 'اختر المواد المحمّلة:' : 'Select the subjects you are carrying:'}
                      </p>

                      {loadingSubjects ? (
                        <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-sky-500" /></div>
                      ) : subjects.length === 0 ? (
                        <p className="text-sm text-slate-500">{isRtl ? 'لا توجد مواد متاحة.' : 'No subjects available.'}</p>
                      ) : (
                        <div className="space-y-4 max-h-56 overflow-y-auto pe-1">
                          {COURSE_IDS.map(courseId => {
                            const list = byCourse.get(courseId) || [];
                            if (list.length === 0) return null;
                            return (
                              <div key={courseId}>
                                <p className="text-[11px] font-black uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1.5 text-start">
                                  {isRtl ? COURSE_LABELS[courseId].ar : COURSE_LABELS[courseId].en}
                                </p>
                                <div className="space-y-1">
                                  {list.map(sub => (
                                    <label key={sub.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-white/60 dark:hover:bg-black/20 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={selectedTahmeel.includes(sub.id)}
                                        onChange={() => toggle(sub.id)}
                                        className="w-4 h-4 rounded text-sky-600 focus:ring-sky-500"
                                      />
                                      <span className="text-sm font-medium text-slate-800 dark:text-slate-200 text-start">
                                        {isRtl ? sub.nameAr : sub.nameEn}
                                      </span>
                                    </label>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </Option>

              <Option
                value="failed" tone="rose" icon={AlertTriangle}
                title={isRtl ? 'رسبت' : 'Did not pass'}
                subtitle={isRtl ? 'البقاء في المرحلة الحالية' : 'Stay in your current stage'}
              />
            </>
          )}
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/30 border border-red-100 dark:border-red-900/50 text-red-600 dark:text-red-400 rounded-xl text-sm">
            {error}
          </div>
        )}

        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="w-full py-4 rounded-2xl bg-sky-600 hover:bg-sky-700 text-white font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {isSaving && <Loader2 className="w-5 h-5 animate-spin" />}
          {isRtl ? 'تأكيد' : 'Confirm'}
        </button>

        <p className="mt-4 text-center text-xs text-slate-500 dark:text-slate-400">
          {isRtl
            ? 'لا يمكن تغيير الإجابة بعد التأكيد. راجع الإدارة إذا اخترت خطأً.'
            : 'This cannot be changed after you confirm. Contact an admin if you pick the wrong one.'}
        </p>
      </motion.div>
    </div>
  );
}
