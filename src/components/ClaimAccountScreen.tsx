import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Loader2, AlertCircle, ArrowRight, ArrowLeft, Link2 } from 'lucide-react';
import { Language, TRANSLATIONS } from '../types';
import { claimWithGoogle, ClaimError, GoogleTokenBody } from '../lib/googleSignIn';

interface ClaimAccountScreenProps {
  lang: Language;
  /** The verified Google address, shown so they know which one they are linking. */
  googleEmail: string;
  /** The token obtained at sign-in. Reused rather than re-prompting for one. */
  tokenBody: GoogleTokenBody;
  onBackToLogin: () => void;
  /** They really are new: hand them to the signup form. */
  onNeedSignup: () => void;
  /** Linked and authenticated - the custom token to open the session with. */
  onClaimed: (result: { token: string; studentId: string }) => Promise<void> | void;
}

/**
 * The other half of NO_ACCOUNT: link this Google identity to an account the
 * student already has, instead of creating a second one.
 *
 * Why this screen exists at all. A staff-created account is a `students/{id}`
 * document with a hashed password, and its Auth record is materialised by
 * signInWithCustomToken with uid = that document id and NO email property - so
 * Firebase cannot tell that it and a Google identity are the same person, and
 * `auth/account-exists-with-different-credential` never fires. The server
 * already reads the join (students.googleEmail), but nothing could WRITE it
 * without first being signed in, which is exactly what this student cannot do.
 * So Google sign-in reported "no account", the app offered the signup form, and
 * the second account was born. This is the path that was missing.
 *
 * The identifier field accepts whatever they already log in with - college
 * email, login code, or full name, all three handled by resolveStudentLogin.
 * It deliberately does NOT accept an exam code: those are reissued every year,
 * so an exam code identifies a year's enrolment rather than a person.
 */
export default function ClaimAccountScreen({
  lang, googleEmail, tokenBody, onBackToLogin, onNeedSignup, onClaimed,
}: ClaimAccountScreenProps) {
  const isRtl = lang === 'ar';
  const t = TRANSLATIONS[lang];
  const Back = isRtl ? ArrowRight : ArrowLeft;

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = identifier.trim().length > 0 && password.length > 0 && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);
    try {
      const result = await claimWithGoogle(tokenBody, identifier.trim(), password);
      await onClaimed(result);
    } catch (err: any) {
      // The server's messages are already the student-facing ones, in Arabic,
      // and they distinguish a wrong password from a disabled account from a
      // name that matches several students. Passing them through beats
      // flattening all of it to one string.
      setError(err instanceof ClaimError && err.message
        ? err.message
        : (isRtl ? 'تعذّر ربط الحساب. حاول مرة أخرى.' : 'Could not link the account. Please try again.'));
      setSubmitting(false);
    }
  };

  const field = 'w-full px-4 py-3 rounded-2xl bg-slate-50 dark:bg-zinc-800/60 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500';
  const label = 'block text-xs font-black text-slate-500 dark:text-slate-400 mb-1.5';

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-zinc-950 p-4" dir={isRtl ? 'rtl' : 'ltr'}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
        className="bg-white dark:bg-zinc-900 rounded-3xl p-7 w-full max-w-md shadow-2xl border border-slate-200 dark:border-zinc-800"
      >
        <button
          type="button"
          onClick={onBackToLogin}
          className="mb-4 inline-flex items-center gap-1.5 text-sm font-bold text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors"
        >
          <Back className="w-4 h-4" />
          {isRtl ? 'رجوع' : 'Back'}
        </button>

        <div className="w-14 h-14 rounded-2xl bg-sky-100 dark:bg-sky-900/30 flex items-center justify-center mb-4">
          <Link2 className="w-7 h-7 text-sky-600 dark:text-sky-400" />
        </div>

        <h2 className="text-xl font-black text-slate-900 dark:text-white mb-2">
          {t.claimTitle}
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed mb-1">
          {t.claimIntro}
        </p>
        <p className="text-sm font-bold text-slate-800 dark:text-slate-200 mb-6" dir="ltr">
          {googleEmail}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className={label}>{t.claimIdentifier}</label>
            <input
              value={identifier}
              onChange={e => setIdentifier(e.target.value)}
              autoComplete="username"
              className={field}
              disabled={submitting}
            />
          </div>

          <div>
            <label className={label}>{t.password}</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              dir="ltr"
              autoComplete="current-password"
              className={field}
              disabled={submitting}
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-2xl bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800">
              <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 mt-0.5 shrink-0" />
              <p className="text-sm text-rose-700 dark:text-rose-300 leading-relaxed">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full py-3.5 rounded-2xl bg-sky-600 hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold transition-colors flex items-center justify-center gap-2"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            {t.claimSubmit}
          </button>
        </form>

        <div className="mt-5 pt-5 border-t border-slate-200 dark:border-zinc-800">
          <button
            type="button"
            onClick={onNeedSignup}
            className="w-full py-3 rounded-2xl bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-slate-300 font-bold text-sm transition-colors"
          >
            {t.claimNoAccount}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
