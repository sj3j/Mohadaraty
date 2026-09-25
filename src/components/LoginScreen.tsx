import React, { useState } from 'react';
import { auth, db } from '../lib/firebase';
import { signInWithCustomToken, UserCredential } from 'firebase/auth';
import { doc, setDoc, getDoc, serverTimestamp, collection, query, where, getDocs } from 'firebase/firestore';
import { Language, TRANSLATIONS } from '../types';
import { Loader2, UserRound, Lock, LogIn } from 'lucide-react';
import { apiUrl } from '../lib/apiBase';
import { getGoogleCustomToken, NoAccountError, GoogleNativeSignInError,
  GoogleTokenBody } from '../lib/googleSignIn';
import { carriedProgressionFields } from '../../shared/progression';
import { isMasterAdminEmail } from '../../shared/masterAdmins';
import SignupScreen from './SignupScreen';
import ClaimAccountScreen from './ClaimAccountScreen';
import FaqSheet, { FaqTrigger } from './support/FaqSheet';

interface LoginScreenProps {
  lang: Language;
  externalError?: string | null;
  onClearError?: () => void;
}

const errorMessages: Record<string, string> = {
  'auth/wrong-password':
    'كلمة المرور غير صحيحة',
  'auth/user-not-found':
    'لا يوجد حساب بهذه البيانات',
  'auth/invalid-email':
    'صيغة البريد الإلكتروني غير صحيحة',
  'auth/invalid-credential':
    'بيانات الدخول غير صحيحة. تحقق من الاسم أو البريد وكلمة المرور.',
  'AMBIGUOUS_IDENTIFIER':
    'يوجد أكثر من طالب بهذا الاسم. سجّل الدخول برمز الدخول أو تواصل مع الإدارة.',
  'auth/user-disabled':
    'تم تعطيل هذا الحساب، تواصل مع الإدارة',
  'auth/network-request-failed':
    'خطأ في الشبكة — تحقق من الإنترنت وحاول مرة أخرى',
  'auth/timeout':
    'انتهت مهلة الاتصال — حاول مرة أخرى',
  'auth/too-many-requests':
    'تم تجاوز عدد المحاولات — انتظر قليلاً وحاول مرة أخرى',
  'auth/web-storage-unsupported':
    'متصفحك لا يدعم هذه الميزة — تحقق من إعدادات Safari',
  'auth/operation-not-allowed':
    'تسجيل الدخول بالبريد الإلكتروني غير مفعّل',
  'OFFLINE':
    'لا يوجد اتصال بالإنترنت',
};

interface SignInOutcome {
  credential: UserCredential;
  /**
   * The students/ document id the server resolved the identifier to. The
   * caller must use THIS for its whitelist lookups, not what was typed: with
   * name and code login the typed string is usually not a document id at all.
   */
  studentId: string;
}

const signInWithRetry = async (
  identifier: string,
  password: string,
  retries = 1
): Promise<SignInOutcome> => {
  try {
    // Sent verbatim - no lowercasing. It may be an Arabic name, and the server
    // is what decides whether this is an email, a login code or a name.
    // `email` is sent alongside for installed builds still on the old field.
    const typed = identifier.trim();

    const response = await fetch(apiUrl('/api/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: typed, email: typed, password: password.trim() })
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const errorMsg = data.error || 'Invalid credentials';
      
      const err = new Error(errorMsg);
      if (data.code === 'AMBIGUOUS_IDENTIFIER') {
        (err as any).code = 'AMBIGUOUS_IDENTIFIER';
      } else if (response.status === 401 || response.status === 404) {
        (err as any).code = 'auth/invalid-credential';
      } else if (response.status === 403) {
        (err as any).code = 'auth/user-disabled';
      } else {
        (err as any).code = 'auth/internal-error';
      }
      throw err;
    }

    const { token, studentId } = await response.json();
    const credential = await signInWithCustomToken(auth, token);
    return { credential, studentId: (studentId || typed).toLowerCase() };
  } catch (error: any) {
    if (
      retries > 0 &&
      (error.code === 'auth/network-request-failed' || error.message.includes('network-request-failed') || error.message.includes('Failed to fetch'))
    ) {
      await new Promise(r => setTimeout(r, 1500));
      return signInWithRetry(identifier, password, retries - 1);
    }
    if (error.message.includes('Failed to fetch')) {
      error.code = 'auth/network-request-failed';
    }
    throw error;
  }
};

const isIOSPrivateMode = async (): Promise<boolean> => {
  try {
    localStorage.setItem('__test__', '1');
    localStorage.removeItem('__test__');
    return false;
  } catch {
    return true;
  }
};

const isIOS = (): boolean =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' &&
   navigator.maxTouchPoints > 1);

/** What a brand-new account starts the season on. See both setDoc calls below. */
const FRESH_STREAK_FIELDS = {
  streakCount: 0,
  longestStreak: 0,
  bestStreakAllTime: 0,
  freezeTokens: 3,
  lastActiveDate: null,
} as const;

/**
 * Creates the `users/{uid}` document for a session that has just opened, or
 * leaves the existing one alone.
 *
 * ONE copy, called by all three sign-in paths - password, Google, and the claim
 * that links the two. There were two near-identical copies of this and they had
 * already drifted: the Google path never carried `examCode` or the imported
 * `group` across, so a student who happened to sign in with Google lost both.
 * A third copy for the claim path would have drifted the same way, and the
 * comment on `email` below records what a drift here actually costs.
 *
 * `resolvedId` is the students/ document id the SERVER resolved to, never the
 * address Google asserted and never the string the student typed. Every lookup
 * that reconciles a session to a profile queries `users.email` against that id
 * (shared/studentLookup.ts resolveSessionUid, shared/googleLogin.ts), so storing
 * anything else here forks the account into two documents on the next sign-in -
 * which is the very duplicate this whole path exists to prevent.
 */
async function ensureUserDoc(opts: {
  uid: string;
  resolvedId: string;
  /** From the Google profile, when there is one. */
  profileName?: string | null;
  profilePhoto?: string | null;
}): Promise<void> {
  const { uid, resolvedId, profileName, profilePhoto } = opts;

  let userRole = 'student';
  let studentData: any = {};
  let managedStageId: string | null = null;

  const isMasterAdmin = isMasterAdminEmail(resolvedId);

  if (isMasterAdmin) {
    userRole = 'admin'; // syncRole promotes this to master_admin from the claim.
  } else {
    const allowedDoc = await getDoc(doc(db, 'allowed_admins', resolvedId));
    if (allowedDoc.exists()) {
      userRole = allowedDoc.data().role || 'admin';
      managedStageId = allowedDoc.data().managedStageId || null;
    } else {
      try {
        const studentDoc = await getDoc(doc(db, 'students', resolvedId));
        if (studentDoc.exists()) {
          studentData = studentDoc.data() || {};
          userRole = studentData.role || 'student';
        }
      } catch (e: any) {
        if (e.code === 'permission-denied') {
          throw new Error('غير مصرح لك بالدخول. يرجى التواصل مع الإدارة لإضافة بريدك الإلكتروني.');
        }
        throw e;
      }
    }
  }

  const userRef = doc(db, 'users', uid);
  const userSnap = await getDoc(userRef);

  if (userSnap.exists()) {
    // If the whitelist says admin and the stored doc disagrees, catch it up.
    const currentRole = userSnap.data().role;
    if (currentRole !== userRole && userRole === 'admin') {
      await setDoc(userRef, { role: userRole }, { merge: true });
    }
    return;
  }

  const initialName = studentData.name
    || profileName
    || (userRole === 'admin' ? 'Admin' : 'Student');

  await setDoc(userRef, {
    name: initialName,
    originalName: initialName,
    email: resolvedId,
    role: userRole,
    examCode: studentData.examCode || '',
    ...(profilePhoto ? { photoUrl: profilePhoto } : {}),
    // Seed the stage at creation time; rules only allow a student to write
    // stageId on create or during progression season.
    ...(studentData.stageId ? { stageId: studentData.stageId } : {}),
    ...(managedStageId ? { managedStageId } : {}),
    // shared/groups.ts: anything that assigns a group has to write both
    // students.subgroup and users.group. The importer can only write the first -
    // the users doc does not exist yet - so it is carried across here, which
    // also lets an imported student skip the group step.
    ...(studentData.subgroup ? { group: studentData.subgroup } : {}),
    // A fresh-intake roster import stamps this on the students doc, since it
    // cannot write to a uid that does not exist yet. See RosterImport and
    // shared/progression.ts's completedProgressionFields.
    ...carriedProgressionFields(studentData),
    createdAt: serverTimestamp(),
    favorites: [],
    studied: [],
    completedWeeklyTasks: [],
    // Seeded, not left absent. LeaderboardTab orders by streakCount, and an
    // orderBy silently EXCLUDES documents that lack the field - so a student who
    // signed up during a break, when record-activity returns early and writes
    // nothing, was missing from the board entirely.
    ...FRESH_STREAK_FIELDS,
    notificationPreferences: { lectures: true, announcements: true },
  });
}

export default function LoginScreen({ lang, externalError, onClearError }: LoginScreenProps) {
  const [showSignup, setShowSignup] = useState(false);
  const [showFaq, setShowFaq] = useState(false);
  const [signupPrefill, setSignupPrefill] = useState<{ email?: string; name?: string | null } | null>(null);
  // Set when Google sign-in found no student record. Holds the TOKEN as well as
  // the address, so the claim step needs no second popup.
  const [claimContext, setClaimContext] =
    useState<{ email: string; tokenBody: GoogleTokenBody } | null>(null);
  const t = TRANSLATIONS[lang];
  const isRtl = lang === 'ar';
  const [isLoading, setIsLoading] = useState(false);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPrivateMode, setIsPrivateMode] = useState(false);

  React.useEffect(() => {
    const checkPrivateMode = async () => {
      if (isIOS() && await isIOSPrivateMode()) {
        setIsPrivateMode(true);
      }
    };
    checkPrivateMode();
  }, []);

  React.useEffect(() => {
    if (externalError) {
      setError(externalError);
      setIsLoading(false);
    }
  }, [externalError]);

  const handleGoogleSignIn = async () => {
    setIsLoading(true);
    setError(null);
    if (onClearError) onClearError();
    try {
      sessionStorage.setItem('googleLoginInProgress', 'true');
      // Timestamped so App.tsx can expire a flag left behind by an interrupted
      // sign-in. Without it a dropped network mid-handshake pins the app on the
      // boot spinner for the rest of the session.
      sessionStorage.setItem('googleLoginStartedAt', String(Date.now()));

      // Native uses the OS account picker and sends a raw Google token; web
      // keeps the popup and sends a Firebase token. Both come back as our own
      // custom token, so everything below is unchanged.
      const { token, studentId, profile } = await getGoogleCustomToken();
      
      // We must remove the flag before signing in with custom token 
      // so that App's onAuthStateChanged listener picks it up.
      sessionStorage.removeItem('googleLoginInProgress');
      // Sign in again using custom token
      const result = await signInWithCustomToken(auth, token);
      
      // The id the SERVER resolved, not the address Google asserted: a roster
      // student who linked a Gmail is keyed by a synthetic id, so looking them
      // up by the Gmail would find nothing and drop their role and stage.
      const resolvedId = studentId || (result.user.email || profile.email || '').toLowerCase();

      await ensureUserDoc({
        uid: result.user.uid,
        resolvedId,
        profileName: profile.name,
        profilePhoto: profile.photoUrl,
      });
    } catch (error: any) {
      if (error.code !== 'auth/popup-closed-by-user' && error.code !== 'auth/cancelled-popup-request') {
        console.error('Error signing in:', error);
        // The Google identity is valid, there is just no student record yet.
        // Route to signup with what Google told us, rather than showing a
        // credential error for a password they never set.
        // NOT a dead end, and no longer a funnel straight into a second
        // account. A staff-created account has no Firebase email/password
        // identity at all - it is a students/ row whose Auth record carries no
        // email - so Firebase cannot see that this Google identity is the same
        // person, and nothing but asking them can. Offer the link first; the
        // signup form is one tap further on, for someone who really is new.
        if (error instanceof NoAccountError) {
          setSignupPrefill({ email: error.email, name: error.name });
          if (error.tokenBody) {
            setClaimContext({ email: error.email, tokenBody: error.tokenBody });
          } else {
            setShowSignup(true);
          }
          return;
        }
        if (!externalError) {
          let errorMsg = error.message || '';
          if (error.code === 'auth/network-request-failed' || errorMsg.includes('network-request-failed') || errorMsg.includes('Failed to fetch')) {
            setError(isRtl 
              ? 'خطأ في الشبكة. لحل المشكلة (خاصة لمستخدمي الآيفون):\n١- افتح الرابط في متصفح سفاري (Safari) أو كروم وليس من داخل التليجرام أو تطبيقات أخرى.\n٢- تأكد من صحة تاريخ ووقت الجهاز.\n٣- قم بإيقاف (Private Relay) من إعدادات الـ iCloud.\n٤- جرب شبكة إنترنت مختلفة.' 
              : 'Network error. Troubleshooting (iOS):\n1- Open directly in Safari/Chrome (not in-app browsers).\n2- Check device date/time.\n3- Disable Private Relay.\n4- Try a different network.');
          } else if (error.code === 'auth/account-exists-with-different-credential') {
            setError(isRtl ? 'هذا البريد الإلكتروني مسجل مسبقاً. يرجى تسجيل الدخول باستخدام البريد الإلكتروني وكلمة المرور' : 'This email is already registered. Please sign in using your email and password.');
          } else if (error instanceof GoogleNativeSignInError && error.reason === 'no-google-account') {
            // The OS picker had nothing to show. Naming the remedy matters:
            // the raw exception says "No credentials available", which reads
            // as a fault in OUR app and leaves the student with nothing to do.
            setError(isRtl
              ? 'لا يوجد حساب Google على هذا الجهاز. أضف حسابك من إعدادات الهاتف ثم أعد المحاولة، أو سجّل الدخول بالبريد وكلمة المرور.'
              : 'No Google account on this device. Add one in your phone settings and try again, or sign in with your email and password.');
          } else if (error instanceof GoogleNativeSignInError && error.reason === 'app-not-registered') {
            // Ours, not theirs - no amount of retrying or account-switching
            // fixes an unregistered signing certificate, so do not send the
            // student round that loop.
            setError(isRtl
              ? 'هذه النسخة من التطبيق غير مُسجّلة لدى Google. المشكلة من عندنا وليست من حسابك — سجّل الدخول بالبريد وكلمة المرور وأبلغنا.'
              : "This build of the app isn't registered with Google. That is our fault, not your account — sign in with your email and password and let us know.");
          } else {
            setError(isRtl ? 'حدث خطأ أثناء تسجيل الدخول: ' + errorMsg : 'Error signing in: ' + errorMsg);
          }
        }
      }
    } finally {
      sessionStorage.removeItem('googleLoginInProgress');
      sessionStorage.removeItem('googleLoginStartedAt');
      if (!externalError) {
        setIsLoading(false);
      }
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    if (!navigator.onLine) {
      setError(errorMessages['OFFLINE']);
      return;
    }
    setError(null);
    setIsLoading(true);
    if (onClearError) onClearError();

    try {
      const { credential: result, studentId } = await signInWithRetry(identifier, password);

      // The id the SERVER resolved, never the typed string: a name or a login
      // code is not a document id, and a roster student's id is synthetic.
      await ensureUserDoc({ uid: result.user.uid, resolvedId: studentId });

    } catch (err: any) {
      console.error('Email sign in error:', err);
      setError(
        errorMessages[err.code] ||
        errorMessages[err.message] ||
        `حدث خطأ غير متوقع (${err.code || 'unknown'})`
      );
    } finally {
      setIsLoading(false);
    }
  };


  if (showSignup) {
    return (
      <SignupScreen
        lang={lang}
        prefill={signupPrefill}
        onBackToLogin={() => { setShowSignup(false); setSignupPrefill(null); }}
        onClaimExisting={claimContext ? () => setShowSignup(false) : undefined}
      />
    );
  }

  // Offered BEFORE signup, not instead of it. Checked after showSignup so that
  // stepping forward to the form is not immediately undone by this branch.
  if (claimContext) {
    return (
      <ClaimAccountScreen
        lang={lang}
        googleEmail={claimContext.email}
        tokenBody={claimContext.tokenBody}
        onBackToLogin={() => { setClaimContext(null); setSignupPrefill(null); setIsLoading(false); }}
        onNeedSignup={() => setShowSignup(true)}
        onClaimed={async ({ token, studentId }) => {
          // Same two steps every other path takes, in the same order: open the
          // session, then reconcile the profile document against the id the
          // server resolved. Because that id is the EXISTING account's, the
          // users doc is already there and nothing new is written.
          sessionStorage.removeItem('googleLoginInProgress');
          const credential = await signInWithCustomToken(auth, token);
          await ensureUserDoc({ uid: credential.user.uid, resolvedId: studentId });
          setClaimContext(null);
          setSignupPrefill(null);
        }}
      />
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 dark:bg-zinc-950 p-4" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="w-full max-w-md bg-white dark:bg-zinc-900 rounded-3xl p-8 shadow-xl border border-slate-200 dark:border-zinc-800 text-center">
        <div className="w-20 h-20 bg-sky-100 dark:bg-sky-900/30 rounded-full flex items-center justify-center mx-auto mb-6">
          {/* The real brand mark. This was a lucide GraduationCap standing in
              for a logo the app did not have a local copy of. */}
          <img src="/icons/logo-mark.png" alt={t.appName} className="w-12 h-12 object-contain" />
        </div>
        
        <h1 className="text-3xl font-black text-slate-900 dark:text-stone-100 mb-2">
          {t.appName}
        </h1>
        <p className="text-slate-500 dark:text-slate-400 mb-8">
          {t.university} - {t.department}
        </p>

        {isPrivateMode && (
          <div className="mb-6 p-4 bg-orange-50 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 rounded-xl text-sm font-bold border border-orange-200 dark:border-orange-900/50 whitespace-pre-line text-center">
            ⚠️ أنت في وضع التصفح الخاص.
            <br />
            قد لا يعمل تسجيل الدخول بشكل صحيح.
            <br />
            يُنصح بفتح الرابط في متصفح عادي.
          </div>
        )}

        {error && (
          <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-xl text-sm font-bold border border-red-100 dark:border-red-900/50 whitespace-pre-line">
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} className="mb-6 space-y-4 text-left">
          <div>
            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1.5 px-1">
              {isRtl ? 'البريد الإلكتروني أو الاسم أو رمز الدخول' : 'Email, name or login code'}
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <UserRound className="h-5 w-5 text-slate-400" />
              </div>
              <input
                // Not type="email": students imported from a roster have no
                // address and sign in with their name or a "D4-01234" code,
                // both of which the browser would reject as malformed.
                type="text"
                required
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                onBlur={(e) => setIdentifier(e.target.value.trim())}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                autoComplete="username"
                inputMode={identifier.includes('@') ? 'email' : 'text'}
                className="block w-full pl-10 pr-3 py-3 border border-slate-200 dark:border-zinc-700 rounded-xl leading-5 bg-slate-50 dark:bg-zinc-800 placeholder-slate-400 focus:outline-none focus:bg-white dark:focus:bg-zinc-900 focus:ring-2 focus:ring-sky-500 focus:border-sky-500 sm:text-sm transition-colors text-slate-900 dark:text-stone-100"
                placeholder={isRtl ? 'أحمد علي حسين' : 'name, email or code'}
                // An Arabic name must render RTL; an address or a code must not.
                dir={/[؀-ۿ]/.test(identifier) ? 'auto' : 'ltr'}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1.5 px-1">
              {isRtl ? 'كلمة المرور' : 'Password'}
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Lock className="h-5 w-5 text-slate-400" />
              </div>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                autoComplete="current-password"
                className="block w-full pl-10 pr-3 py-3 border border-slate-200 dark:border-zinc-700 rounded-xl leading-5 bg-slate-50 dark:bg-zinc-800 placeholder-slate-400 focus:outline-none focus:bg-white dark:focus:bg-zinc-900 focus:ring-2 focus:ring-sky-500 focus:border-sky-500 sm:text-sm transition-colors text-slate-900 dark:text-stone-100"
                placeholder="••••••••"
                dir="ltr"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading || !identifier || !password}
            style={{ opacity: isLoading ? 0.7 : 1 }}
            className="w-full flex items-center justify-center gap-2 bg-sky-600 text-white px-6 py-3.5 rounded-xl font-bold hover:bg-sky-700 transition-all disabled:opacity-50 mt-2"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>جاري التحقق...</span>
              </>
            ) : (
              <>
                <LogIn className="w-5 h-5 shrink-0" />
                <span>تسجيل الدخول ←</span>
              </>
            )}
          </button>
        </form>

        <div className="relative mb-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-slate-200 dark:border-zinc-800"></div>
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="px-2 bg-white dark:bg-zinc-900 text-slate-500 dark:text-slate-400">
              {isRtl ? 'أو' : 'Or'}
            </span>
          </div>
        </div>

        <button
          onClick={handleGoogleSignIn}
          disabled={isLoading}
          type="button"
          className="w-full flex items-center justify-center gap-3 bg-white dark:bg-zinc-800 border-2 border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-slate-200 px-6 py-3.5 rounded-xl font-bold hover:bg-slate-50 dark:hover:bg-zinc-700 transition-all disabled:opacity-50"
        >
          {isLoading ? (
            <Loader2 className="w-6 h-6 animate-spin text-sky-600 shrink-0" />
          ) : (
            <>
              <svg className="w-6 h-6 shrink-0" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
              <span>{isRtl ? 'المتابعة باستخدام جوجل' : 'Continue with Google'}</span>
            </>
          )}
        </button>

        <p className="mt-6 text-center text-sm font-bold text-slate-500 dark:text-slate-400">
          {isRtl ? 'ليس لديك حساب؟' : "Don't have an account?"}{' '}
          <button
            onClick={() => setShowSignup(true)}
            className="text-sky-600 dark:text-sky-400 hover:underline font-black"
          >
            {isRtl ? 'أنشئ حساباً' : 'Sign up'}
          </button>
        </p>

        {/* Where a student stuck on this screen is told what their credentials
            are and who to ask. Deliberately quiet: it sits under the primary
            actions rather than competing with them. */}
        <div className="mt-3">
          <FaqTrigger lang={lang} onClick={() => setShowFaq(true)} />
        </div>

        <div className="mt-6 text-center text-xs font-bold text-slate-400 dark:text-slate-500 leading-relaxed">
          {isRtl ? 'بتسجيل الدخول، فإنك توافق على ' : 'By continuing, you agree to our '}
          <a href="/terms" className="text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 underline underline-offset-2">
            {isRtl ? 'شروط الاستخدام' : 'Terms of Use'}
          </a>
          {isRtl ? ' و ' : ' and '}
          <a href="/privacy" className="text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 underline underline-offset-2">
            {isRtl ? 'سياسة الخصوصية' : 'Privacy Policy'}
          </a>
        </div>
      </div>

      <FaqSheet open={showFaq} onClose={() => setShowFaq(false)} lang={lang} />
    </div>
  );
}
