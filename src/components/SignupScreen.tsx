import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Loader2, AlertCircle, CheckCircle2, ArrowRight, ArrowLeft } from 'lucide-react';
import { Language } from '../types';
import { apiUrl } from '../lib/apiBase';
import { subgroupOptions, FALLBACK_GROUP_CONFIG, GroupConfigLike } from '../../shared/groups';
import FaqSheet, { FaqTrigger } from './support/FaqSheet';

interface StageOption {
  id: string;
  nameAr: string | null;
  nameEn: string | null;
  groupConfig: GroupConfigLike | null;
}

interface SignupScreenProps {
  lang: Language;
  onBackToLogin: () => void;
  /** Pre-filled when they arrived here from a Google account with no student record. */
  prefill?: { email?: string; name?: string | null } | null;
}

/**
 * Self-service signup. Creates a REQUEST, not an account.
 *
 * Login is gated on a students/{email} record existing, so nothing here grants
 * access - the stage representative approving the request is what does.
 *
 * The name is three separate fields rather than one parsed string: Arabic
 * عبد-compounds are written open or closed ("عبد الحسين" / "عبدالحسين"), so
 * counting spaces mis-reads real names in both directions.
 */
export default function SignupScreen({ lang, onBackToLogin, prefill }: SignupScreenProps) {
  const isRtl = lang === 'ar';
  const Back = isRtl ? ArrowRight : ArrowLeft;

  const [stages, setStages] = useState<StageOption[]>([]);
  const [loadingStages, setLoadingStages] = useState(true);

  const [firstName, setFirstName] = useState('');
  const [fatherName, setFatherName] = useState('');
  const [grandfatherName, setGrandfatherName] = useState('');
  const [email, setEmail] = useState(prefill?.email || '');
  const [password, setPassword] = useState('');
  const [stageId, setStageId] = useState('');
  const [subgroup, setSubgroup] = useState('');
  const [examCode, setExamCode] = useState('');
  const [noExamCode, setNoExamCode] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [showFaq, setShowFaq] = useState(false);

  // Split a Google display name across the three fields as a starting point.
  useEffect(() => {
    if (!prefill?.name) return;
    const parts = prefill.name.trim().split(/\s+/);
    if (parts[0]) setFirstName(parts[0]);
    if (parts[1]) setFatherName(parts[1]);
    if (parts[2]) setGrandfatherName(parts.slice(2).join(' '));
  }, [prefill?.name]);

  // Stages come from the API, not Firestore: the applicant has no credentials
  // yet and firestore.rules requires auth to read anything.
  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl('/api/signup/stages'))
      .then(r => r.json())
      .then(d => { if (!cancelled) setStages(d.stages || []); })
      .catch(err => console.error('Failed to load stages:', err))
      .finally(() => { if (!cancelled) setLoadingStages(false); });
    return () => { cancelled = true; };
  }, []);

  const subgroups = useMemo(() => {
    const stage = stages.find(s => s.id === stageId);
    return subgroupOptions(stage?.groupConfig || FALLBACK_GROUP_CONFIG);
  }, [stages, stageId]);

  // Reset a subgroup that the newly-picked stage does not offer.
  useEffect(() => {
    if (subgroup && !subgroups.includes(subgroup)) setSubgroup('');
  }, [subgroups, subgroup]);

  const complete = firstName.trim() && fatherName.trim() && grandfatherName.trim()
    && email.trim() && password.length >= 6 && stageId && subgroup
    && (noExamCode || examCode.trim());

  const submit = async () => {
    if (!complete || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/signup/request'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName, fatherName, grandfatherName,
          email, password, stageId, subgroup,
          examCode: noExamCode ? '' : examCode,
          noExamCode,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'تعذّر إرسال الطلب');
      setDone(true);
    } catch (err: any) {
      setError(err.message || (isRtl ? 'حدث خطأ' : 'Something went wrong'));
    } finally {
      setSubmitting(false);
    }
  };

  const field = 'w-full px-4 py-3 rounded-2xl bg-slate-50 dark:bg-zinc-800/60 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500';
  const label = 'block text-xs font-black text-slate-500 dark:text-slate-400 mb-1.5';

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-zinc-950 p-4" dir={isRtl ? 'rtl' : 'ltr'}>
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
          className="bg-white dark:bg-zinc-900 rounded-3xl p-8 w-full max-w-md text-center shadow-2xl border border-slate-200 dark:border-zinc-800"
        >
          <div className="w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mx-auto mb-5">
            <CheckCircle2 className="w-8 h-8 text-emerald-600 dark:text-emerald-400" />
          </div>
          <h2 className="text-xl font-black text-slate-900 dark:text-white mb-2">
            {isRtl ? 'تم إرسال طلبك' : 'Request sent'}
          </h2>
          <p className="text-slate-600 dark:text-slate-400 mb-8 leading-relaxed">
            {isRtl
              ? 'سيراجع ممثل مرحلتك الطلب. ستتمكن من تسجيل الدخول بالبريد وكلمة المرور بعد الموافقة.'
              : 'Your stage representative will review it. You will be able to log in with this email and password once approved.'}
          </p>
          <button onClick={onBackToLogin} className="w-full py-3.5 rounded-2xl bg-sky-600 hover:bg-sky-700 text-white font-bold transition-colors">
            {isRtl ? 'العودة لتسجيل الدخول' : 'Back to login'}
          </button>

          <div className="mt-3">
            <FaqTrigger lang={lang} onClick={() => setShowFaq(true)} />
          </div>
        </motion.div>

        <FaqSheet open={showFaq} onClose={() => setShowFaq(false)} lang={lang} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-zinc-950 p-4 py-8" dir={isRtl ? 'rtl' : 'ltr'}>
      <motion.div
        initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
        className="bg-white dark:bg-zinc-900 rounded-3xl p-6 md:p-8 w-full max-w-md mx-auto shadow-2xl border border-slate-200 dark:border-zinc-800"
      >
        <button onClick={onBackToLogin} className="flex items-center gap-2 text-sm font-bold text-slate-500 dark:text-slate-400 mb-6">
          <Back className="w-4 h-4" />
          {isRtl ? 'تسجيل الدخول' : 'Log in'}
        </button>

        <div className="text-center mb-7">
          <div className="w-16 h-16 rounded-2xl bg-sky-100 dark:bg-sky-900/30 flex items-center justify-center mx-auto mb-4">
            {/* Same brand mark as LoginScreen; this was a stand-in GraduationCap. */}
            <img src="/icons/logo-mark.png" alt="" className="w-10 h-10 object-contain" />
          </div>
          <h1 className="text-2xl font-black text-slate-900 dark:text-white">
            {isRtl ? 'إنشاء حساب' : 'Create an account'}
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            {isRtl ? 'يفعّله ممثل مرحلتك بعد المراجعة' : 'Activated by your stage representative'}
          </p>
        </div>

        <div className="space-y-4">
          <div>
            <label className={label}>{isRtl ? 'الاسم الثلاثي' : 'Full name (three parts)'}</label>
            <div className="grid grid-cols-3 gap-2">
              <input value={firstName} onChange={e => setFirstName(e.target.value)}
                placeholder={isRtl ? 'الاسم' : 'First'} className={field} />
              <input value={fatherName} onChange={e => setFatherName(e.target.value)}
                placeholder={isRtl ? 'الأب' : 'Father'} className={field} />
              <input value={grandfatherName} onChange={e => setGrandfatherName(e.target.value)}
                placeholder={isRtl ? 'الجد' : 'Grandfather'} className={field} />
            </div>
            <p className="text-[11px] text-slate-400 mt-1.5">
              {isRtl ? 'مثال: منتظر / نهاد / حسين' : 'e.g. Muntadher / Nihad / Hussein'}
            </p>
          </div>

          <div>
            <label className={label}>{isRtl ? 'البريد الإلكتروني' : 'Email'}</label>
            <input type="email" dir="ltr" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="student@example.com" className={field} />
          </div>

          <div>
            <label className={label}>{isRtl ? 'كلمة المرور' : 'Password'}</label>
            <input type="password" dir="ltr" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="••••••••" className={field} />
            {password.length > 0 && password.length < 6 && (
              <p className="text-[11px] text-amber-600 mt-1.5">
                {isRtl ? '٦ أحرف على الأقل' : 'At least 6 characters'}
              </p>
            )}
          </div>

          <div>
            <label className={label}>{isRtl ? 'المرحلة' : 'Stage'}</label>
            <select value={stageId} onChange={e => setStageId(e.target.value)} className={field} disabled={loadingStages}>
              <option value="">{loadingStages ? (isRtl ? 'جاري التحميل…' : 'Loading…') : (isRtl ? 'اختر المرحلة' : 'Select a stage')}</option>
              {stages.map(s => (
                <option key={s.id} value={s.id}>{isRtl ? (s.nameAr || s.id) : (s.nameEn || s.id)}</option>
              ))}
            </select>
          </div>

          <div>
            <label className={label}>{isRtl ? 'الشعبة' : 'Group'}</label>
            <select value={subgroup} onChange={e => setSubgroup(e.target.value)} className={field} disabled={!stageId}>
              <option value="">{isRtl ? 'اختر الشعبة' : 'Select a group'}</option>
              {subgroups.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>

          <div>
            <label className={label}>{isRtl ? 'الرقم الامتحاني' : 'Exam code'}</label>
            <input value={examCode} onChange={e => setExamCode(e.target.value)} dir="ltr"
              disabled={noExamCode} placeholder="1234"
              className={`${field} ${noExamCode ? 'opacity-50' : ''}`} />
            <label className="flex items-center gap-2 mt-2 cursor-pointer">
              <input type="checkbox" checked={noExamCode}
                onChange={e => { setNoExamCode(e.target.checked); if (e.target.checked) setExamCode(''); }}
                className="w-4 h-4 rounded text-sky-600 focus:ring-sky-500" />
              <span className="text-xs font-bold text-slate-600 dark:text-slate-300">
                {isRtl ? 'لم أستلم رقماً امتحانياً لهذا العام' : 'I have not been given one this year'}
              </span>
            </label>
          </div>

          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/30 border border-red-100 dark:border-red-900/50 text-red-600 dark:text-red-400 rounded-xl flex items-center gap-2 text-sm">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          <button onClick={submit} disabled={!complete || submitting}
            className="w-full py-4 rounded-2xl bg-sky-600 hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold transition-colors flex items-center justify-center gap-2">
            {submitting && <Loader2 className="w-5 h-5 animate-spin" />}
            {isRtl ? 'إرسال الطلب' : 'Send request'}
          </button>

          {/* Same help as the login screen: most people who reach this form do
              so because they could not sign in, and an existing account is the
              answer for a good share of them. */}
          <FaqTrigger lang={lang} onClick={() => setShowFaq(true)} />
        </div>
      </motion.div>

      <FaqSheet open={showFaq} onClose={() => setShowFaq(false)} lang={lang} />
    </div>
  );
}
