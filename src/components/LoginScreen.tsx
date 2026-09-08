import React, { useState } from 'react';
import { auth, db } from '../lib/firebase';
import { signInWithCustomToken, UserCredential } from 'firebase/auth';
import { doc, setDoc, getDoc, serverTimestamp, collection, query, where, getDocs } from 'firebase/firestore';
import { Language, TRANSLATIONS } from '../types';
import { Loader2, UserRound, Lock, LogIn } from 'lucide-react';
import { apiUrl } from '../lib/apiBase';
import { getGoogleCustomToken, NoAccountError } from '../lib/googleSignIn';
import { carriedProgressionFields } from '../../shared/progression';
import { isMasterAdminEmail } from '../../shared/masterAdmins';
import SignupScreen from './SignupScreen';

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

export default function LoginScreen({ lang, externalError, onClearError }: LoginScreenProps) {
  const [showSignup, setShowSignup] = useState(false);
  const [signupPrefill, setSignupPrefill] = useState<{ email?: string; name?: string | null } | null>(null);
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
      
      let userRole = 'student';
      let whitelistStageId: string | null = null;
      let whitelistManagedStageId: string | null = null;
      let whitelistStudentData: any = null;

      // The id the SERVER resolved, not the address Google asserted: a roster
      // student who linked a Gmail is keyed by a synthetic id, so looking them
      // up by the Gmail would find nothing and drop their role and stage.
      const resolvedId = studentId || (result.user.email || profile.email || '').toLowerCase();

      if (resolvedId) {
        const emailLower = resolvedId;
        
        const isMasterAdmin = isMasterAdminEmail(emailLower);
        
        if (isMasterAdmin) {
           userRole = 'admin'; // Will become master_admin by cloud function
        } else {
          // Check allowed_admins
          const adminDoc = await getDoc(doc(db, 'allowed_admins', emailLower));
          if (adminDoc.exists()) {
            const data = adminDoc.data();
            userRole = data.role || 'admin';
            whitelistManagedStageId = data.managedStageId || null;
          } else {
            // Check students collection
            const studentDoc = await getDoc(doc(db, 'students', emailLower));
            if (studentDoc.exists()) {
              const data = studentDoc.data();
              if (data.isActive === false) return; // shouldn't reach here since API checks it
              userRole = data.role || 'student';
              whitelistStageId = data.stageId || null;
              whitelistStudentData = data;
            }
          }
        }
      }

      // Check if user exists in Firestore
      const userRef = doc(db, 'users', result.user.uid);
      const userSnap = await getDoc(userRef);
      
      if (!userSnap.exists()) {
        // Create new user document
        const initialName = profile.name || (userRole === 'admin' ? 'Admin' : 'Student');
        await setDoc(userRef, {
          name: initialName,
          originalName: initialName,
          // The resolved student id, not the Google address: every lookup that
          // reconciles a session to a profile queries users.email against the
          // students/ document id, so storing anything else here forks the
          // account into two documents on the next sign-in.
          email: resolvedId,
          role: userRole,
          photoUrl: profile.photoUrl,
          // Seed the stage at creation time; rules only allow a student to
          // write stageId on create or during progression season.
          ...(whitelistStageId ? { stageId: whitelistStageId } : {}),
          ...(whitelistManagedStageId ? { managedStageId: whitelistManagedStageId } : {}),
          // A fresh-intake roster import stamps this on the students doc, since
          // it cannot write to a uid that does not exist yet. See RosterImport
          // and shared/progression.ts's completedProgressionFields.
          ...carriedProgressionFields(whitelistStudentData),
          createdAt: serverTimestamp(),
          favorites: [],
          studied: [],
          completedWeeklyTasks: [],
          notificationPreferences: { lectures: true, announcements: true }
        });
      } else {
        // If user exists but role is different from whitelist, update it
        const currentRole = userSnap.data().role;
        if (currentRole !== userRole && (userRole === 'admin')) {
          await setDoc(userRef, { role: userRole }, { merge: true });
        }
      }
    } catch (error: any) {
      if (error.code !== 'auth/popup-closed-by-user' && error.code !== 'auth/cancelled-popup-request') {
        console.error('Error signing in:', error);
        // The Google identity is valid, there is just no student record yet.
        // Route to signup with what Google told us, rather than showing a
        // credential error for a password they never set.
        if (error instanceof NoAccountError) {
          setSignupPrefill({ email: error.email, name: error.name });
          setShowSignup(true);
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

      // Check if user exists in users collection
      const userRef = doc(db, 'users', result.user.uid);
      const userSnap = await getDoc(userRef);
      
      let userRole = 'student';
      let studentData: any = {};
      // The id the SERVER resolved, never the typed string: a name or a login
      // code is not a document id, and a roster student's id is synthetic.
      const emailLower = studentId;
      
      const allowedDoc = await getDoc(doc(db, 'allowed_admins', emailLower));
      
      const isMasterAdmin = isMasterAdminEmail(emailLower);
      
      if (isMasterAdmin) {
        userRole = 'admin';
      } else if (allowedDoc.exists()) {
        userRole = allowedDoc.data().role || 'admin';
      } else {
        try {
          const studentDoc = await getDoc(doc(db, 'students', emailLower));
          if (studentDoc.exists()) {
            studentData = studentDoc.data() || {};
            userRole = studentData.role || 'student';
          }
        } catch (e: any) {
          if (e.code === 'permission-denied') {
            console.log("User not in students whitelist or admin collection");
            throw new Error('غير مصرح لك بالدخول. يرجى التواصل مع الإدارة لإضافة بريدك الإلكتروني.');
          }
          throw e; // rethrow other errors
        }
      }
      
      if (!userSnap.exists()) {
        const initialName = studentData.name || (userRole === 'admin' ? 'Admin' : 'Student');
        
        await setDoc(userRef, {
          name: initialName,
          originalName: initialName,
          email: emailLower,
          role: userRole,
          examCode: studentData.examCode || '',
          ...(studentData.stageId ? { stageId: studentData.stageId } : {}),
          // shared/groups.ts: anything that assigns a group has to write both
          // students.subgroup and users.group. The importer can only write the
          // first - the users doc does not exist yet - so it is carried across
          // here, which also lets an imported student skip the group step.
          ...(studentData.subgroup ? { group: studentData.subgroup } : {}),
          // Same reasoning for a fresh-intake stamp - see completedProgressionFields.
          ...carriedProgressionFields(studentData),
          createdAt: serverTimestamp(),
          favorites: [],
          studied: [],
          completedWeeklyTasks: [],
          notificationPreferences: { lectures: true, announcements: true }
        });
      } else {
        const currentRole = userSnap.data().role;
        if (currentRole !== userRole && (userRole === 'admin')) {
          await setDoc(userRef, { role: userRole }, { merge: true });
        }
      }

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
      </div>
    </div>
  );
}
