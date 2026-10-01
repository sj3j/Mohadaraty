import React, { useEffect, useState } from 'react';
import { Loader2, KeyRound, Check, AlertTriangle, Link2, Unlink, Trash2 } from 'lucide-react';
import { Language } from '../../types';
import {
  AccountSummary, AccountError, DeletionStatus, fetchAccount, changePassword,
  linkGoogle, unlinkGoogle, fetchDeletionStatus, requestDeletion, cancelDeletion,
} from '../../services/accountService';
import { IS_IOS_BUILD } from '../../lib/platform';

/**
 * Password and Google linking for the signed-in student.
 *
 * Both go through /api/me/*: they end in a write to `students/{id}`, which
 * firestore.rules makes admin-only. Nothing here sends a document id - the
 * server resolves it from the verified token.
 *
 * There is deliberately no "forgot my password" here. That needs a delivery
 * channel, and this app has no mail sender at all - and roster students have no
 * mailbox to send to. Linking a Google account IS the recovery path: once
 * linked, Google sign-in gets them back in without an admin.
 */
export default function AccountSecuritySettings({ lang }: { lang: Language }) {
  const isRtl = lang === 'ar';

  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState(false);

  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);

  const [deletionStatus, setDeletionStatus] = useState<DeletionStatus>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteReason, setDeleteReason] = useState('');

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setAccount(await fetchAccount());
    } catch (err: any) {
      setLoadError(err.message || (isRtl ? 'تعذّر تحميل بيانات الحساب.' : 'Could not load account.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    // Never block the page on this - the rest of the screen is still useful if
    // the status cannot be read.
    fetchDeletionStatus()
      .then(r => setDeletionStatus(r.status))
      .catch(err => console.error('Could not read the deletion request status:', err));
  }, []);

  const submitDeletion = async () => {
    setDeleteError(null);
    setDeleteBusy(true);
    try {
      await requestDeletion(deleteReason.trim());
      setDeletionStatus('pending');
      setConfirmDelete(false);
      setDeleteReason('');
    } catch (err: any) {
      setDeleteError(err.message || (isRtl ? 'تعذّر إرسال الطلب.' : 'Could not send the request.'));
    } finally {
      setDeleteBusy(false);
    }
  };

  const withdrawDeletion = async () => {
    setDeleteError(null);
    setDeleteBusy(true);
    try {
      await cancelDeletion();
      setDeletionStatus(null);
    } catch (err: any) {
      setDeleteError(err.message || (isRtl ? 'تعذّر سحب الطلب.' : 'Could not withdraw the request.'));
    } finally {
      setDeleteBusy(false);
    }
  };

  const handlePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError(null);
    if (next !== confirm) {
      setPwError(isRtl ? 'كلمتا المرور غير متطابقتين.' : 'The two passwords do not match.');
      return;
    }
    setPwBusy(true);
    try {
      await changePassword(current, next);
      setPwDone(true);
      setCurrent(''); setNext(''); setConfirm('');
      load();
    } catch (err: any) {
      setPwError(err.message || (isRtl ? 'تعذّر تغيير كلمة المرور.' : 'Could not change password.'));
    } finally {
      setPwBusy(false);
    }
  };

  const handleLink = async () => {
    setGoogleError(null);
    setGoogleBusy(true);
    try {
      await linkGoogle();
      await load();
    } catch (err: any) {
      // A closed popup is the user changing their mind, not a failure.
      if (err?.code === 'auth/popup-closed-by-user' || err?.code === 'auth/cancelled-popup-request') return;
      setGoogleError(err instanceof AccountError
        ? err.message
        : (isRtl ? 'تعذّر ربط حساب Google.' : 'Could not link Google.'));
    } finally {
      setGoogleBusy(false);
    }
  };

  const handleUnlink = async () => {
    const ok = window.confirm(isRtl
      ? 'سيتم فصل حساب Google. ستحتاج كلمة المرور لتسجيل الدخول بعد ذلك.'
      : 'This unlinks Google. You will need your password to sign in afterwards.');
    if (!ok) return;
    setGoogleError(null);
    setGoogleBusy(true);
    try {
      await unlinkGoogle();
      await load();
    } catch (err: any) {
      setGoogleError(err.message || (isRtl ? 'تعذّر فصل الحساب.' : 'Could not unlink.'));
    } finally {
      setGoogleBusy(false);
    }
  };

  const field = 'w-full bg-slate-50 dark:bg-zinc-950 border-2 border-slate-100 dark:border-zinc-800 rounded-xl px-4 py-3 outline-none focus:border-sky-500 dark:text-stone-100 transition-colors text-sm';
  const label = 'block text-xs font-black text-slate-500 dark:text-slate-400 mb-1.5 px-1';

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="w-6 h-6 animate-spin text-sky-500" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="p-4 bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400 rounded-2xl text-sm font-bold">
        {loadError}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* How they sign in today. A roster student's "email" is a synthetic id,
          so showing it would be worse than useless - the login code is the
          thing they actually type. */}
      <section className="bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800 rounded-2xl p-4">
        <h2 className="text-xs font-black uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-3">
          {isRtl ? 'تسجيل الدخول' : 'Sign in'}
        </h2>
        <dl className="space-y-2.5 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-slate-500 dark:text-slate-400 font-bold">{isRtl ? 'الاسم' : 'Name'}</dt>
            <dd className="font-black text-slate-800 dark:text-slate-100 truncate">{account?.name}</dd>
          </div>
          {account?.loginCode && (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-500 dark:text-slate-400 font-bold">{isRtl ? 'رمز الدخول' : 'Login code'}</dt>
              <dd className="font-mono font-black text-sky-600 dark:text-sky-400" dir="ltr">{account.loginCode}</dd>
            </div>
          )}
          {!account?.placeholderEmail && (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-500 dark:text-slate-400 font-bold">{isRtl ? 'البريد' : 'Email'}</dt>
              <dd className="font-bold text-slate-800 dark:text-slate-100 truncate" dir="ltr">{account?.studentId}</dd>
            </div>
          )}
        </dl>
      </section>

      {/* Google - Hidden on iOS to comply with Apple Guideline 4.8 (no social login without Sign in with Apple) */}
      {!IS_IOS_BUILD && (
        <section className="bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800 rounded-2xl p-4">
          <h2 className="text-xs font-black uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-1">
            {isRtl ? 'حساب Google' : 'Google account'}
          </h2>
          <p className="text-xs font-bold text-slate-400 dark:text-slate-500 mb-3 leading-relaxed">
            {isRtl
              ? 'اربط بريدك لتتمكن من الدخول بضغطة واحدة، ولاستعادة حسابك إذا نسيت كلمة المرور.'
              : 'Link your address to sign in with one tap, and to get back in if you forget your password.'}
          </p>

          {account?.googleEmail ? (
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0 text-sm font-bold text-emerald-600 dark:text-emerald-400 truncate flex items-center gap-1.5" dir="ltr">
                <Check className="w-4 h-4 shrink-0" strokeWidth={3} />
                {account.googleEmail}
              </span>
              <button
                onClick={handleUnlink}
                disabled={googleBusy}
                className="shrink-0 px-3 py-2 rounded-xl text-xs font-black text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/20 hover:bg-rose-100 disabled:opacity-50 flex items-center gap-1.5"
              >
                {googleBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Unlink className="w-3.5 h-3.5" />}
                {isRtl ? 'فصل' : 'Unlink'}
              </button>
            </div>
          ) : (
            <button
              onClick={handleLink}
              disabled={googleBusy}
              className="w-full py-3 rounded-xl font-black text-sm bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-zinc-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {googleBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
              {isRtl ? 'ربط حساب Google' : 'Link a Google account'}
            </button>
          )}

          {googleError && (
            <p className="mt-2.5 text-xs font-bold text-rose-600 dark:text-rose-400 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>{googleError}</span>
            </p>
          )}
        </section>
      )}

      {/* Account deletion.
          Play requires an in-app path to deletion for any app with accounts.
          It is a REQUEST rather than an immediate wipe: approving one destroys
          a sign-in identity and a dozen documents, and the roster record it
          touches belongs to the college. */}
      <section className="bg-white dark:bg-zinc-900 border-2 border-rose-100 dark:border-rose-900/40 rounded-2xl p-4">
        <h2 className="text-xs font-black uppercase tracking-wider text-rose-500 mb-1">
          {isRtl ? 'حذف الحساب' : 'Delete account'}
        </h2>

        {deletionStatus === 'pending' ? (
          <>
            <p className="text-xs font-bold text-slate-500 dark:text-slate-400 mb-3 leading-relaxed">
              {isRtl
                ? 'طلبك قيد المراجعة لدى ممثل المرحلة. يمكنك سحبه ما دام لم يُنفَّذ.'
                : 'Your request is with your stage representative. You can withdraw it until it is carried out.'}
            </p>
            <button
              onClick={withdrawDeletion}
              disabled={deleteBusy}
              className="w-full py-2.5 rounded-xl font-black text-sm bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-slate-200 hover:bg-slate-200 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {deleteBusy && <Loader2 className="w-4 h-4 animate-spin" />}
              {isRtl ? 'سحب الطلب' : 'Withdraw request'}
            </button>
          </>
        ) : confirmDelete ? (
          <>
            <p className="text-xs font-bold text-slate-500 dark:text-slate-400 mb-3 leading-relaxed">
              {isRtl
                ? 'سيُحذف ملفك الشخصي وهوية الدخول وإجابات الاختبارات نهائياً. تبقى درجاتك وسجل قيدك لدى الكلية.'
                : 'Your profile, sign-in identity and quiz answers are removed permanently. Your grades and enrolment record stay with the college.'}
            </p>
            <a
              href="/delete-account"
              target="_blank"
              rel="noreferrer"
              className="block text-xs font-bold text-sky-600 dark:text-sky-400 hover:underline mb-3"
            >
              {isRtl ? 'ما الذي يُحذف بالضبط؟' : 'Exactly what is deleted?'}
            </a>
            <input
              value={deleteReason}
              onChange={e => setDeleteReason(e.target.value)}
              placeholder={isRtl ? 'السبب (اختياري)' : 'Reason (optional)'}
              className={field + ' mb-2'}
            />
            <div className="flex gap-2">
              <button
                onClick={submitDeletion}
                disabled={deleteBusy}
                className="flex-1 py-2.5 rounded-xl font-black text-sm bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {deleteBusy && <Loader2 className="w-4 h-4 animate-spin" />}
                {isRtl ? 'تأكيد الطلب' : 'Confirm request'}
              </button>
              <button
                onClick={() => { setConfirmDelete(false); setDeleteError(null); }}
                disabled={deleteBusy}
                className="flex-1 py-2.5 rounded-xl font-bold text-sm text-slate-500 hover:bg-slate-50 dark:hover:bg-zinc-800 disabled:opacity-50"
              >
                {isRtl ? 'إلغاء' : 'Cancel'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs font-bold text-slate-400 dark:text-slate-500 mb-3 leading-relaxed">
              {isRtl
                ? 'يُراجع الطلب ممثل مرحلتك قبل التنفيذ.'
                : 'Your stage representative reviews the request before it is carried out.'}
            </p>
            <button
              onClick={() => setConfirmDelete(true)}
              className="w-full py-2.5 rounded-xl font-black text-sm text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/20 hover:bg-rose-100 flex items-center justify-center gap-2"
            >
              <Trash2 className="w-4 h-4" />
              {isRtl ? 'طلب حذف الحساب' : 'Request account deletion'}
            </button>
          </>
        )}

        {deleteError && (
          <p className="mt-2.5 text-xs font-bold text-rose-600 dark:text-rose-400 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>{deleteError}</span>
          </p>
        )}
      </section>

      <p className="text-center text-[11px] font-bold text-slate-400">
        <a href="/privacy" target="_blank" rel="noreferrer" className="hover:underline">
          {isRtl ? 'سياسة الخصوصية' : 'Privacy policy'}
        </a>
      </p>

      {/* Password */}
      <section className="bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800 rounded-2xl p-4">
        <h2 className="text-xs font-black uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-3">
          {isRtl ? 'تغيير كلمة المرور' : 'Change password'}
        </h2>

        {pwDone ? (
          <div className="flex items-center gap-2 text-sm font-black text-emerald-600 dark:text-emerald-400">
            <Check className="w-4 h-4" strokeWidth={3} />
            {isRtl ? 'تم تغيير كلمة المرور.' : 'Password changed.'}
          </div>
        ) : (
          <form onSubmit={handlePassword} className="space-y-3">
            <div>
              <label className={label}>{isRtl ? 'كلمة المرور الحالية' : 'Current password'}</label>
              <input type="password" required autoComplete="current-password" dir="ltr"
                className={field} value={current} onChange={e => setCurrent(e.target.value)} />
            </div>
            <div>
              <label className={label}>{isRtl ? 'كلمة المرور الجديدة' : 'New password'}</label>
              <input type="password" required minLength={6} autoComplete="new-password" dir="ltr"
                className={field} value={next} onChange={e => setNext(e.target.value)} />
            </div>
            <div>
              <label className={label}>{isRtl ? 'تأكيد كلمة المرور' : 'Confirm password'}</label>
              <input type="password" required minLength={6} autoComplete="new-password" dir="ltr"
                className={field} value={confirm} onChange={e => setConfirm(e.target.value)} />
            </div>

            {pwError && (
              <p className="text-xs font-bold text-rose-600 dark:text-rose-400 flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                <span>{pwError}</span>
              </p>
            )}

            <button
              type="submit"
              disabled={pwBusy || !current || !next || !confirm}
              className="w-full py-3 bg-sky-600 text-white rounded-xl font-black text-sm hover:bg-sky-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {pwBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
              {isRtl ? 'حفظ' : 'Save'}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
