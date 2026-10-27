import React, { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { auth, db, handleFirestoreError, isTransientNetworkError, OperationType } from './lib/firebase';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { collection, query, orderBy, onSnapshot, getDocs, where, doc, setDoc, serverTimestamp, getDoc, limit } from 'firebase/firestore';
import { Lecture, UserProfile, Category, CATEGORIES, Language, TRANSLATIONS, LectureType } from './types';
import { useStageContext } from './contexts/StageContext';
import LectureCard from './components/LectureCard';
import AdminUpload from './components/AdminUpload';
import AdminManagement from './components/AdminManagement';
import StudentManagement from './components/StudentManagement';
import StreakManagement from './components/StreakManagement';
import AcademicCalendarModal from './components/AcademicCalendarModal';
import SettingsScreen from './components/settings/SettingsScreen';
import ProgressionScreen from './components/ProgressionScreen';
import { useAcademicPhase } from './hooks/useAcademicPhase';
import { useTheme } from './hooks/useTheme';
import { useNativePush } from './hooks/useNativePush';
import { useAuthWatchdog, safeSetStorageItem, safeGetStorageItem } from './hooks/useAuthWatchdog';
import { saveCachedUserProfile, getCachedUserProfile, clearCachedUserProfile, hasExplicitLogoutMarker, clearExplicitLogoutMarker } from './lib/authPersistence';
import { logSessionBootstrap, resolveAuthState, resolveUserDocument, resolveWhitelistVerification } from './lib/sessionRestoration';
import { logPerfMark } from './lib/perf';
import { resolveLectureLoadDecision, type LectureLoadState } from './lib/lectureLoadState';
import { recordNativeDiagnostic } from './lib/nativeDiagnostics';
import { canAttemptStreakActivity, createSingleFlight } from './lib/streakActivity';
import { resolveProgressionUiState, ProgressionRound } from '../shared/progression';
import { isMasterAdminEmail, isObserverEmail } from '../shared/masterAdmins';
import { hasSubscriptionAccess } from '../shared/subscriptionAccess';
import { IAP_ENABLED, identifyIap, signOutIap } from './lib/iap';
import AdminGradesScreen from './components/grades/AdminGradesScreen';
import AdminQuestionBankScreen from './components/questionBank/AdminQuestionBankScreen';
import LectureMCQDirectEditModal from './components/mcq/LectureMCQDirectEditModal';
import { MCQQuestion } from './types/mcq.types';
import StudentGradesScreen from './components/grades/StudentGradesScreen';
import AntiCheatDashboard from './components/AntiCheatDashboard';
import AdminLogsScreen from './components/AdminLogsScreen';
// Aliased to a null stub for mode === 'native' in vite.config.ts - it renders
// dollar amounts, which must not enter the artefact the Play scanner reads.
import SimosanAdminScreen from './components/SimosanAdminScreen';
import TelegramMirrorModal from './components/TelegramMirrorModal';
import BottomNav, { Tab } from './components/BottomNav';
import { canManage, canManageAntiCheat, canManageMcqSystem, canViewStaffInbox, isMasterAdmin } from './lib/permissions';
import AnnouncementsScreen from './components/AnnouncementsScreen';
import WeeklyListScreen from './components/WeeklyListScreen';
import ProfileScreen from './components/ProfileScreen';
import RecordsScreen from './components/RecordsScreen';
import SimosanSoonScreen from './components/SimosanSoonScreen';
import SimosanPage from './components/simosan/SimosanPage';
import DoctorPortal from './components/doctor/DoctorPortal';
import SubjectBrowser from './components/SubjectBrowser';
import HomeScreen from './components/HomeScreen';
import LoginScreen from './components/LoginScreen';
import OnboardingScreen from './components/OnboardingScreen';
import { resolveLegalPath } from './components/legal';
import SupportPage from './pages/SupportPage';
import PasswordChangeGate from './components/PasswordChangeGate';
import ExamCodePrompt, { shouldAskForExamCode } from './components/ExamCodePrompt';
import OnboardingSlides from './components/OnboardingSlides';
import GlobalAudioPlayer from './components/GlobalAudioPlayer';
import MCQOverlay from './components/MCQOverlay';
// Lazy: pdf.js and its worker are ~1MB and must not land in the main chunk.
const PdfReaderOverlay = lazy(() => import('./components/pdf/PdfReaderOverlay'));
import NotificationsModal from './components/NotificationsModal';
import SubscriptionScreen from './components/SubscriptionScreen';
import SubscriptionManagement from './components/SubscriptionManagement';
import SubscriptionPaywall from './components/SubscriptionPaywall';
import { Loader2, BookOpen, SearchX, Lock, Shield, Users, UserCircle, AlertCircle, ArrowUp, ArrowDown, Flame, GraduationCap, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Fuse from 'fuse.js';
import { usePushNotifications } from './hooks/usePushNotifications';
import { type UserFile, getUserFileBlob } from './lib/localDb';
import { syncPendingSubmissions } from './services/mcqAnswerService';
import { apiUrl } from './lib/apiBase';
import { ensureOfflineAttendancePrepared, startAttendanceSync } from './services/attendanceService';
import { useMobileReleaseGate } from './hooks/useMobileReleaseGate';
import ForceUpdateScreen from './components/ForceUpdateScreen';

type SortField = 'title' | 'date' | 'number';
type SortOrder = 'asc' | 'desc';

export default function App() {
  const [lang, setLang] = useState<Language>('ar');
  const t = TRANSLATIONS[lang];
  const isRtl = lang === 'ar';
  
  const { effectiveStageId, setActiveUser } = useStageContext();

  useEffect(() => {
    // Attempt to sync any offline MCQ submissions when the app loads or comes online
    syncPendingSubmissions();
    const handleOnline = () => syncPendingSubmissions();
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, []);

  const [showOnboarding, setShowOnboarding] = useState(() => {
    return !localStorage.getItem('hasSeenTour_v3');
  });

  const [showNotificationsModal, setShowNotificationsModal] = useState(false);
  const [hasUnreadInbox, setHasUnreadInbox] = useState(false);
  // Both of these live on students/{id}, which the auth listener reads ONCE -
  // it is not a snapshot the way the users doc is. So the acknowledgement is
  // held here rather than waiting for a profile that will not update.
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [examCodeResolved, setExamCodeResolved] = useState(false);
  // Which end-of-year question is open comes from the academic calendar's
  // results dates, replacing the old settings/app_settings.isProgressionSeasonActive
  // flag that nothing ever wrote.
  const {
    gate: progressionGateNow,
    yearLabel: academicYearLabel,
    calendar: academicCalendar,
  } = useAcademicPhase();

  // Eligibility itself is always derived from the shared selector. The round
  // is held only while a submission is in flight/accepted, so a live completed
  // snapshot cannot tear down the congratulations screen before it renders.
  const [heldProgressionRound, setHeldProgressionRound] = useState<ProgressionRound | null>(null);
  const [forceShowProgression, setForceShowProgression] = useState(false);
  const [progressionNotice, setProgressionNotice] = useState<string | null>(null);

  const [user, setUser] = useState<UserProfile | null>(() => {
    const wasSignedIn = safeGetStorageItem('wasSignedIn') === 'true';
    return wasSignedIn ? getCachedUserProfile() : null;
  });
  const [authenticatedUid, setAuthenticatedUid] = useState<string | null>(null);
  const mobileReleaseGate = useMobileReleaseGate(user?.role, authenticatedUid);
  const authGenerationRef = useRef(0);
  const streakActivitySingleFlight = useMemo(createSingleFlight, []);

  const isProgressionSnoozed = useMemo(() => {
    if (!user) return false;
    const raw = localStorage.getItem(`progression_snooze_${user.uid}`);
    if (!raw) return false;
    const until = parseInt(raw, 10);
    return !isNaN(until) && Date.now() < until;
  }, [user, heldProgressionRound, forceShowProgression]);

  const progressionUiState = useMemo(() => {
    if (!user || user.role === 'doctor' || user.role === 'observer') return { openRound: null, hasActivePendingAccess: false };
    return resolveProgressionUiState({
      gate: progressionGateNow,
      yearLabel: academicYearLabel,
      stages: academicCalendar.progressionStages,
      acceptedRound: heldProgressionRound,
      user,
    });
  }, [user, progressionGateNow, academicYearLabel, academicCalendar.progressionStages, heldProgressionRound]);

  useEffect(() => {
    if (!progressionNotice) return;
    const timeout = window.setTimeout(() => setProgressionNotice(null), 6000);
    return () => window.clearTimeout(timeout);
  }, [progressionNotice]);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const safeIsAuthReady = useAuthWatchdog(isAuthReady);

  // If watchdog forced ready for a returning user on a slow network or cold boot,
  // ensure we hydrate from cache rather than falling through to LoginScreen
  useEffect(() => {
    if (safeIsAuthReady && !user && !hasExplicitLogoutMarker()) {
      const wasSignedIn = safeGetStorageItem('wasSignedIn') === 'true';
      if (wasSignedIn) {
        const cached = getCachedUserProfile();
        if (cached) {
          console.info('[auth] Watchdog unblocked returning user; restoring cached profile.');
          setUser(cached);
        }
      }
    }
  }, [safeIsAuthReady, user]);
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [lectureLoadState, setLectureLoadState] = useState<LectureLoadState>('waiting-auth');
  const [lectureRetry, setLectureRetry] = useState(0);
  const lectureScopeRef = useRef<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<Category | 'all'>('all');
  const [selectedType, setSelectedType] = useState<LectureType | 'all'>('all');
  const [sortBy, setSortBy] = useState<SortField>('number');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const [currentTab, setCurrentTab] = useState<Tab>('home');
  const [activeSimosanService, setActiveSimosanService] = useState<'hub' | 'attendance'>('hub');

  useEffect(() => {
    if (currentTab !== 'simosan') setActiveSimosanService('hub');
  }, [currentTab]);

  useEffect(() => {
    if (!user?.uid) return;
    return startAttendanceSync(user.uid);
  }, [user?.uid]);
  useEffect(() => {
    const doctorStageId = user?.assignedStageId || user?.stageId;
    if (user?.role !== 'doctor' || !doctorStageId) return;
    const prepare = () => { void ensureOfflineAttendancePrepared(doctorStageId, user.uid).catch(() => undefined); };
    const reconnect = () => { void ensureOfflineAttendancePrepared(doctorStageId, user.uid, true).catch(() => undefined); };
    prepare();
    window.addEventListener('online', reconnect);
    window.addEventListener('focus', prepare);
    return () => { window.removeEventListener('online', reconnect); window.removeEventListener('focus', prepare); };
  }, [user?.uid, user?.role, user?.assignedStageId, user?.stageId]);
  const [showUpload, setShowUpload] = useState(false);
  const [lectureToEdit, setLectureToEdit] = useState<Lecture | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showAdminManage, setShowAdminManage] = useState(false);
  const [showStudentManage, setShowStudentManage] = useState(false);
  const [showStreakManage, setShowStreakManage] = useState(false);
  const [showCalendarSettings, setShowCalendarSettings] = useState(false);
  const [showAdminGrades, setShowAdminGrades] = useState(false);
  const [showAdminBank, setShowAdminBank] = useState(false);
  const [adminBankTargetQuestionId, setAdminBankTargetQuestionId] = useState<string | null>(null);
  const [adminBankTargetAlert, setAdminBankTargetAlert] = useState<any | null>(null);
  const [editingLectureMcq, setEditingLectureMcq] = useState<{
    lectureId: string;
    lectureTitle?: string;
    question: MCQQuestion;
    alert: any;
  } | null>(null);

  const handleNavigateToReportedQuestion = async (alertData: any) => {
    if (!alertData) return;

    // 1. If explicitly from a lecture or has a lectureId
    if (alertData.source === 'lecture' && alertData.lectureId) {
      try {
        const { getExistingMCQsForLecture } = await import('./services/mcqGenerationService');
        const questions = await getExistingMCQsForLecture(alertData.lectureId);
        const target = questions.find(
          q => q.id === alertData.questionId || (q.stem && alertData.questionStem && q.stem.includes(alertData.questionStem.substring(0, 25)))
        );
        if (target) {
          setEditingLectureMcq({
            lectureId: alertData.lectureId,
            lectureTitle: alertData.lectureTitle,
            question: target,
            alert: alertData
          });
          return;
        }
      } catch (e) {
        console.warn('Failed to load lecture MCQ for report, falling back to bank:', e);
      }
    }

    // 2. Check if question exists in questionBank
    if (alertData.questionId) {
      try {
        const bankDoc = await getDoc(doc(db, 'questionBank', alertData.questionId));
        if (bankDoc.exists()) {
          setAdminBankTargetQuestionId(alertData.questionId);
          setAdminBankTargetAlert(alertData);
          setShowAdminBank(true);
          return;
        }
      } catch (e) {
        console.warn('Bank check failed:', e);
      }
    }

    // 3. Fallback: Open AdminQuestionBankScreen with question stem search
    setAdminBankTargetQuestionId(alertData.questionId || null);
    setAdminBankTargetAlert(alertData);
    setShowAdminBank(true);
  };
  const [showAntiCheat, setShowAntiCheat] = useState(false);
  const [showAdminLogs, setShowAdminLogs] = useState(false);
  const [showSimosanAdmin, setShowSimosanAdmin] = useState(false);
  const [showTelegramMirror, setShowTelegramMirror] = useState(false);
  const [showStudentGrades, setShowStudentGrades] = useState(false);
  const [showSubManage, setShowSubManage] = useState(false);
  const [showPaywall, setShowPaywall] = useState(false);

  // Return leg of a ZainCash payment: the gateway sends the customer back to
  // /?payment=... , which lands on the default tab. Surface the subscription
  // screen so the result is visible; that screen reads and clears the param.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('payment')) {
      setCurrentTab('subscription');
    }
  }, []);

  useEffect(() => {
    const handleOpenAntiCheat = () => { if (canManageAntiCheat(user)) setShowAntiCheat(true); };
    const handleOpenBank = () => { if (canManageMcqSystem(user)) setShowAdminBank(true); };
    window.addEventListener('open-anti-cheat-board', handleOpenAntiCheat);
    window.addEventListener('open-admin-bank', handleOpenBank);
    return () => {
      window.removeEventListener('open-anti-cheat-board', handleOpenAntiCheat);
      window.removeEventListener('open-admin-bank', handleOpenBank);
    };
  }, [user]);
  const [hasUnreadAnnouncements, setHasUnreadAnnouncements] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [mcqLecture, setMcqLecture] = useState<Lecture | null>(null);
  const [readerLecture, setReaderLecture] = useState<Lecture | null>(null);
  const [localReaderFile, setLocalReaderFile] = useState<UserFile | null>(null);
  const [localBlobUrl, setLocalBlobUrl] = useState<string | null>(null);
  const { theme, setTheme } = useTheme();

  const { permission, requestPermission, isRequesting } = usePushNotifications(user);
  // Native builds need the OS push channel; the web hook above is a no-op there.
  useNativePush(user);
  const [hideNotificationBanner, setHideNotificationBanner] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('hideNotificationBanner') === 'true';
    }
    return false;
  });

  const handleDismissNotification = () => {
    setHideNotificationBanner(true);
    if (typeof window !== 'undefined') {
      localStorage.setItem('hideNotificationBanner', 'true');
    }
  };

  useEffect(() => {
    document.documentElement.dir = isRtl ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
  }, [lang, isRtl]);

  // Auth Listener
  useEffect(() => {
    logPerfMark('auth-listener-started');
    let userUnsubscribe: (() => void) | undefined;

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      logPerfMark('auth-first-state');
      if (userUnsubscribe) {
        userUnsubscribe();
      }

      // If we are in the middle of Google login, the user instance is the generic Google one.
      // We ignore it and wait for the custom token login to trigger onAuthStateChanged again.
      //
      // The flag is time-boxed because this return deliberately skips
      // setIsAuthReady(true): if a Google sign-in dies between setting the flag
      // and clearing it - the network dropping mid-handshake is enough - a stale
      // flag pinned the app on the spinner for the rest of the session AND
      // suppressed the whitelist error handling below.
      const googleLoginStartedAt = Number(sessionStorage.getItem('googleLoginStartedAt') || 0);
      const googleLoginIsFresh = googleLoginStartedAt > 0 && Date.now() - googleLoginStartedAt < 120_000;
      if (sessionStorage.getItem('googleLoginInProgress') === 'true') {
        if (googleLoginIsFresh) {
          return;
        }
        console.warn('Stale googleLoginInProgress flag; clearing and continuing.');
        sessionStorage.removeItem('googleLoginInProgress');
        sessionStorage.removeItem('googleLoginStartedAt');
      }

      const generation = ++authGenerationRef.current;
      setAuthenticatedUid(firebaseUser?.uid ?? null);

      if (firebaseUser) {
        logSessionBootstrap(resolveAuthState({
          firebaseUserPresent: true,
          isOnline: navigator.onLine,
          wasSignedIn: safeGetStorageItem('wasSignedIn') === 'true',
          cachedProfileAvailable: getCachedUserProfile(firebaseUser.uid) !== null,
        }));
        safeSetStorageItem('wasSignedIn', 'true');
        clearExplicitLogoutMarker();

        let tokenResult: Awaited<ReturnType<typeof firebaseUser.getIdTokenResult>> | null = null;
        try {
          tokenResult = await firebaseUser.getIdTokenResult(false);
        } catch (err) {
          console.warn('Could not read ID token claims (likely offline); continuing without them.', err);
        }

        const claimEmail = typeof tokenResult?.claims?.email === 'string' ? tokenResult.claims.email : null;
        const cachedProfile = getCachedUserProfile(firebaseUser.uid);
        const userEmail = claimEmail || firebaseUser.email || cachedProfile?.email || firebaseUser.uid;
        const isMasterAdmin = tokenResult?.claims.role === 'master_admin' || isMasterAdminEmail(userEmail) || isMasterAdminEmail(firebaseUser.email || '');
        const isObserver = tokenResult?.claims.role === 'observer' || isObserverEmail(userEmail) || isObserverEmail(firebaseUser.email || '');
        
        let studentData: any = null;
        let whitelistConfirmedByServer = true;

        if (isMasterAdminEmail(userEmail) && tokenResult?.claims.role !== 'master_admin') {
          try {
             const token = await firebaseUser.getIdToken();
             await fetch(apiUrl('/api/bootstrap-admin'), {
               method: 'POST',
               headers: { 'Authorization': `Bearer ${token}` }
             });
             // Force refresh so claims take effect
             await firebaseUser.getIdToken(true);
          } catch(e) {
             console.error('Failed to bootstrap admin access', e);
          }
        }

        if (!isMasterAdmin && !isObserver && userEmail) {
          try {
            const emailLower = userEmail.toLowerCase();
            
            // Check allowed_admins
            const adminDoc = await getDoc(doc(db, 'allowed_admins', emailLower));
            whitelistConfirmedByServer = whitelistConfirmedByServer && !adminDoc.metadata.fromCache;
            if (adminDoc.exists()) {
              const data = adminDoc.data();
              studentData = {
                name: 'Admin',
                email: emailLower,
                isActive: true,
                role: data.role || 'admin',
                managedStageId: data.managedStageId,
                permissions: data.permissions
              };
            } else {
              // Check students collection
              const studentDoc = await getDoc(doc(db, 'students', emailLower));
              whitelistConfirmedByServer = whitelistConfirmedByServer && !studentDoc.metadata.fromCache;
              if (studentDoc.exists()) {
                const data = studentDoc.data();
                studentData = {
                  ...data,
                  id: studentDoc.id
                };
              }
            }

            // If not found yet by primary email, inspect users/{uid} document:
            let userDocSnap: any = null;
            if (!studentData) {
              userDocSnap = await getDoc(doc(db, 'users', firebaseUser.uid));
              whitelistConfirmedByServer = whitelistConfirmedByServer && !userDocSnap.metadata.fromCache;
              if (userDocSnap.exists()) {
                const uData = userDocSnap.data();
                if (uData.role === 'doctor') {
                  studentData = { ...uData, isActive: uData.staffDisabled !== true };
                } else if (uData.email && uData.email.toLowerCase() !== emailLower) {
                  // User doc points to canonical student record (e.g. roster ID vs google email)
                  const canonicalStudentDoc = await getDoc(doc(db, 'students', uData.email.toLowerCase()));
                  whitelistConfirmedByServer = whitelistConfirmedByServer && !canonicalStudentDoc.metadata.fromCache;
                  if (canonicalStudentDoc.exists()) {
                    studentData = { ...canonicalStudentDoc.data(), id: canonicalStudentDoc.id };
                  } else {
                    studentData = { ...uData, id: uData.email || firebaseUser.uid, isActive: uData.staffDisabled !== true && uData.isActive !== false };
                  }
                } else {
                  studentData = { ...uData, id: uData.email || firebaseUser.uid, isActive: uData.staffDisabled !== true && uData.isActive !== false };
                }
              }
            }

            // If still not found, check if emailLower is a linked googleEmail in students collection:
            if (!studentData && emailLower.includes('@') && !emailLower.endsWith('@roster.local')) {
              try {
                const linkedQuery = await getDocs(query(collection(db, 'students'), where('googleEmail', '==', emailLower), limit(1)));
                if (!linkedQuery.empty) {
                  const linkedDoc = linkedQuery.docs[0];
                  studentData = { ...linkedDoc.data(), id: linkedDoc.id };
                }
              } catch (e) {
                console.warn('googleEmail query lookup fallback failed:', e);
              }
            }

            if (!studentData) {
              const decision = resolveWhitelistVerification({
                outcome: 'missing',
                isOnline: navigator.onLine,
                isTransientError: false,
                confirmedByServer: whitelistConfirmedByServer,
              });
              logSessionBootstrap(decision);
              if (decision.shouldSignOut) {
                await signOut(auth);
                setLoginError(isRtl ? 'هذا الحساب غير مسجل في التطبيق. يرجى التواصل مع الإدارة.' : 'This account is not registered. Please contact administration.');
                setUser(null);
                clearCachedUserProfile();
                setIsAuthReady(true);
                return;
              }
            }
            
            if (studentData && !studentData.isActive) {
              const decision = resolveWhitelistVerification({
                outcome: 'disabled',
                isOnline: navigator.onLine,
                isTransientError: false,
                confirmedByServer: whitelistConfirmedByServer,
              });
              logSessionBootstrap(decision);
              if (decision.shouldSignOut) {
                await signOut(auth);
                setLoginError(isRtl ? 'تم تعطيل حسابك. يرجى التواصل مع الإدارة.' : 'Your account has been deactivated. Please contact administration.');
                setUser(null);
                clearCachedUserProfile();
                setIsAuthReady(true);
                return;
              }
            }
          } catch (error: any) {
            console.error("Error checking student whitelist:", error);
            if (sessionStorage.getItem('googleLoginInProgress') === 'true') {
               return; // Ignore error during rapid sign-out for Google auth bypass
            }

            // A document getDoc REJECTS offline when it is not in cache, so this
            // catch used to fire on every offline launch and sign the student
            // out - which wipes the refresh token, making it unrecoverable even
            // after reconnecting, while LoginScreen refuses to sign back in
            // without a network. "Cannot reach the server" is not a verdict
            // about the account; leave the session alone and let the users/{uid}
            // listener below populate the profile from cache.
            // A thrown read is never an account verdict, even for errors such
            // as permission-denied. Preserve credentials and retry later.
            const decision = resolveWhitelistVerification({
              outcome: 'error',
              isOnline: navigator.onLine,
              isTransientError: isTransientNetworkError(error),
              confirmedByServer: false,
            });
            logSessionBootstrap(decision);
          }
        }

        // Listen to user document
        userUnsubscribe = onSnapshot(doc(db, 'users', firebaseUser.uid), async (userDoc) => {
          if (authGenerationRef.current !== generation) return;
          // Read before the exists() guard: exists() is a type predicate, and in
          // the negative branch it narrows the snapshot to `never`.
          const servedFromCache = userDoc.metadata.fromCache;

          // onSnapshot does NOT reject offline - it delivers a fromCache snapshot
          // in which an uncached document reads as non-existent. Without this
          // check the branch read that as "the account was deleted" and signed
          // out every master admin and Google-uid account on an offline launch
          // (roster students dodged it only because their uid contains an '@').
          // Absence is only meaningful when it comes from the server.
          const cachedProfile = getCachedUserProfile(firebaseUser.uid);
          const userDocumentDecision = resolveUserDocument({
            exists: userDoc.exists(),
            fromCache: servedFromCache,
            isOnline: navigator.onLine,
            rosterUser: firebaseUser.uid.includes('@'),
            cachedProfileAvailable: cachedProfile !== null,
          });
          if (userDocumentDecision.shouldSignOut) {
            logSessionBootstrap(userDocumentDecision);
            await signOut(auth);
            setLoginError(isRtl ? 'يرجى إعادة تسجيل الدخول' : 'Please sign in again');
            setUser(null);
            clearCachedUserProfile();
            setIsAuthReady(true);
            return;
          }

          // Cached miss: nothing to render a profile from, but the session is
          // fine. Fall back to local cached profile if available!
          if (!userDoc.exists() && servedFromCache) {
            logSessionBootstrap(userDocumentDecision);
            if (userDocumentDecision.useCachedProfile && cachedProfile) {
              setUser(cachedProfile);
            }
            setIsAuthReady(true);
            return;
          }

          if (userDoc.exists()) {
            const whitelistRole = ['admin', 'moderator', 'support'].includes(studentData?.role) ? studentData.role : null;
            
            const defaultEmailName = firebaseUser.email ? firebaseUser.email.split('@')[0] : '';
            const isDefaultName = userDoc.data().name === defaultEmailName || 
                                  userDoc.data().name === 'Admin' || 
                                  userDoc.data().name === 'Moderator' || 
                                  userDoc.data().name === 'Student';
            
            // If the user has a custom name in their profile, use it.
            // Otherwise, prefer the name from the students collection (studentData.name),
            // then fallback to the default generated name.
            const resolvedName = (!isDefaultName && userDoc.data().name) 
              ? userDoc.data().name 
              : (studentData?.name && studentData.name !== 'Admin' && studentData.name !== 'Moderator' ? studentData.name : (userDoc.data().name || firebaseUser.displayName || (isMasterAdmin ? 'Master Admin' : isObserver ? 'Observer' : 'Student')));

            const masterAdminPermissions = isMasterAdmin ? {
              manageLectures: true,
              manageAnnouncements: true,
              manageRecords: true,
              manageHomeworks: true,
              manageStudents: true,
              manageGrades: true
            } : undefined;

            const profile: UserProfile = {
              uid: firebaseUser.uid,
              name: resolvedName,
              email: firebaseUser.email || userDoc.data().email || firebaseUser.uid || '',
              // allowed_admins is the appointment registry; users/{uid} is the
              // live runtime projection and must win after an edit/revocation.
              role: isMasterAdmin ? 'admin' : isObserver ? 'observer' : (userDoc.data().role || whitelistRole || 'student'),
              isMasterAdmin,
              staffDisabled: userDoc.data().staffDisabled === true,
              photoUrl: userDoc.data().photoUrl || firebaseUser.photoURL || undefined,
              streakCount: userDoc.data().streakCount || 0,
              // streakCount used to be the ONLY streak field hydrated here, so the
              // profile modal read undefined for every other one: "الأطول" fell
              // through ProfileScreen's Math.max to just re-display the current
              // streak, and "الدروع" rendered a permanent 1/3 out of
              // `freezeTokens ?? 1` on accounts that actually held 3.
              longestStreak: userDoc.data().longestStreak || 0,
              bestStreakAllTime: userDoc.data().bestStreakAllTime || 0,
              freezeTokens: userDoc.data().freezeTokens ?? 3,
              hasPendingStreakReset: userDoc.data().hasPendingStreakReset === true,
              lastActiveDate: userDoc.data().lastActiveDate ?? null,
              examCode: studentData?.examCode || userDoc.data().examCode || undefined,
              // students/ is the authority for both: it is server-write-only,
              // so a student cannot clear their own forced password change or
              // invent a linked Google address from the console.
              mustChangePassword: studentData?.mustChangePassword === true,
              googleEmail: studentData?.googleEmail || undefined,
              examCodePromptSnoozedUntil: userDoc.data().examCodePromptSnoozedUntil || undefined,
              // Older user documents can lack `group` even when the canonical
              // roster record has `subgroup`. Preserve that entitlement while
              // the profile is being repaired rather than suppressing lectures.
              group: userDoc.data().group || studentData?.subgroup || undefined,
              favorites: userDoc.data().favorites || [],
              studied: userDoc.data().studied || [],
              completedWeeklyTasks: userDoc.data().completedWeeklyTasks || [],
              notificationPreferences: userDoc.data().notificationPreferences || { lectures: true, announcements: true, records: true, homeworks: true },
              memberSince: studentData?.createdAt || userDoc.data().createdAt,
              permissions: masterAdminPermissions || userDoc.data().permissions || studentData?.permissions,
              stageId: userDoc.data().stageId || studentData?.stageId || undefined,
              pendingStageId: userDoc.data().pendingStageId || undefined,
              pendingProgressionYear: userDoc.data().pendingProgressionYear || undefined,
              pendingProgressionSetAt: userDoc.data().pendingProgressionSetAt || undefined,
              managedStageId: userDoc.data().managedStageId || studentData?.managedStageId || undefined,
              assignedStageId: userDoc.data().assignedStageId || undefined,
              assignedSubjects: userDoc.data().assignedSubjects || undefined,
              tahmeelSubjects: userDoc.data().tahmeelSubjects || undefined,
              hasCompletedProgression: userDoc.data().hasCompletedProgression === true,
              lastProgressionYear: userDoc.data().lastProgressionYear || undefined,
              progressionYear: userDoc.data().progressionYear || undefined,
              progressionState: userDoc.data().progressionState || undefined,
              graduated: userDoc.data().graduated === true,
              blockedUsers: userDoc.data().blockedUsers || [],
              hideNameOnLeaderboard: userDoc.data().hideNameOnLeaderboard,
              hidePhotoOnLeaderboard: userDoc.data().hidePhotoOnLeaderboard,
              // Written only by the Admin SDK and frozen against self-edit in
              // firestore.rules, so these are safe to trust as read. They are
              // also the whole client access gate: omitting them - which this
              // projection did - left hasMCQAccess() reading undefined for
              // every account, so a paying student saw the paywall on the
              // question bank and "no active subscription" on their profile
              // while Simosan, gated server-side, worked fine.
              isSubscribed: userDoc.data().isSubscribed === true,
              subscriptionEnd: userDoc.data().subscriptionEnd ?? undefined,
              subscriptionPlan: userDoc.data().subscriptionPlan ?? undefined,
              subscriptionBannerTheme: userDoc.data().subscriptionBannerTheme ?? undefined
            };
            setUser(profile);
            saveCachedUserProfile(profile);
          } else {
            const masterAdminPermissions = isMasterAdmin ? {
              manageLectures: true,
              manageAnnouncements: true,
              manageRecords: true,
              manageHomeworks: true,
              manageStudents: true,
              manageGrades: true
            } : undefined;

            const profile: UserProfile = {
              uid: firebaseUser.uid,
              name: studentData?.name || firebaseUser.displayName || (isMasterAdmin ? 'Master Admin' : isObserver ? 'Observer' : 'Student'),
              email: firebaseUser.email || firebaseUser.uid || '',
              role: isMasterAdmin ? 'admin' : isObserver ? 'observer' : (studentData?.role || 'student'),
              isMasterAdmin,
              photoUrl: firebaseUser.photoURL || undefined,
              examCode: studentData?.examCode || undefined,
              group: studentData?.subgroup || undefined,
              mustChangePassword: studentData?.mustChangePassword === true,
              googleEmail: studentData?.googleEmail || undefined,
              favorites: [],
              studied: [],
              completedWeeklyTasks: [],
              notificationPreferences: { lectures: true, announcements: true, records: true, homeworks: true },
              memberSince: studentData?.createdAt,
              permissions: masterAdminPermissions || studentData?.permissions,
              stageId: studentData?.stageId || undefined,
              managedStageId: studentData?.managedStageId || undefined,
              hideNameOnLeaderboard: false,
              hidePhotoOnLeaderboard: false
            };
            setUser(profile);
            saveCachedUserProfile(profile);
          }
          setIsAuthReady(true);
        }, (error) => {
          handleFirestoreError(error, OperationType.GET, `users/${firebaseUser.uid}`);
          // Fallback if permission denied
          const masterAdminPermissions = isMasterAdmin ? {
            manageLectures: true,
            manageAnnouncements: true,
            manageRecords: true,
            manageHomeworks: true,
            manageStudents: true,
            manageGrades: true
          } : undefined;

          const profile: UserProfile = {
            uid: firebaseUser.uid,
            name: studentData?.name || firebaseUser.displayName || (isMasterAdmin ? 'Master Admin' : isObserver ? 'Observer' : 'Student'),
            email: firebaseUser.email || '',
            role: isMasterAdmin ? 'admin' : isObserver ? 'observer' : (studentData?.role || 'student'),
            isMasterAdmin,
            photoUrl: firebaseUser.photoURL || undefined,
            examCode: studentData?.examCode || undefined,
            group: studentData?.subgroup || undefined,
            mustChangePassword: studentData?.mustChangePassword === true,
            googleEmail: studentData?.googleEmail || undefined,
            favorites: [],
            studied: [],
            completedWeeklyTasks: [],
            notificationPreferences: { lectures: true, announcements: true, records: true, homeworks: true },
            memberSince: studentData?.createdAt,
            permissions: masterAdminPermissions || studentData?.permissions,
            stageId: studentData?.stageId || undefined,
            managedStageId: studentData?.managedStageId || undefined,
            hideNameOnLeaderboard: false,
            hidePhotoOnLeaderboard: false
          };
          if (authGenerationRef.current !== generation) return;
          setUser(profile);
          saveCachedUserProfile(profile);
          setIsAuthReady(true);
        });
      } else {
        if (hasExplicitLogoutMarker()) {
          safeSetStorageItem('wasSignedIn', 'false');
          if (userUnsubscribe) userUnsubscribe();
          setUser(null);
          setIsAuthReady(true);
          return;
        }
        const wasSignedIn = safeGetStorageItem('wasSignedIn') === 'true';
        const cached = getCachedUserProfile();
        const decision = resolveAuthState({
          firebaseUserPresent: false,
          isOnline: navigator.onLine,
          wasSignedIn,
          cachedProfileAvailable: cached !== null,
        });
        logSessionBootstrap(decision);
        if (decision.useCachedProfile && cached) {
          setUser(cached);
          setIsAuthReady(true);
          return;
        }

        safeSetStorageItem('wasSignedIn', 'false');
        clearCachedUserProfile();
        if (userUnsubscribe) {
          userUnsubscribe();
        }
        
        setUser(null);
        setIsAuthReady(true);
      }
    });
    return () => {
      unsubscribe();
      if (userUnsubscribe) {
        userUnsubscribe();
      }
    };
  }, []);

  /**
   * Apple In-App Purchase identity, iOS only.
   *
   * Deliberately its OWN effect rather than a few lines inside the auth
   * listener above. That listener is the boot path, and the offline rules in
   * CLAUDE.md apply to it: anything awaited in there can hang forever without a
   * network, and a throw on the wrong line used to sign people out
   * irrecoverably. Nothing here is awaited by the listener and nothing here can
   * reject into it.
   *
   * Everything in src/lib/iap.ts is a no-op unless __IOS_BUILD__ is true, so on
   * web and Android this effect resolves immediately and the SDK is not even in
   * the bundle - the dynamic import behind that build-time constant is dropped
   * by the bundler.
   *
   * Keyed on uid, not on `user`: the users/{uid} listener re-fires that object
   * on every profile write (streaks, favourites), and re-running a store
   * handshake on each of those would be pointless traffic.
   */
  useEffect(() => {
    if (!IAP_ENABLED) return;
    if (user?.uid) {
      // identifyIap configures the SDK, mints the opaque App User ID through
      // /api/iap/identity, logs in, and then reconciles - so a purchase made on
      // another device, or a renewal that happened while the app was closed,
      // lands without waiting for the next webhook.
      identifyIap().catch(err => console.warn('[iap] identify failed', err));
    } else {
      signOutIap().catch(err => console.warn('[iap] signOut failed', err));
    }
  }, [user?.uid]);

  useEffect(() => {
    const profileUid = user?.uid ?? null;

    const recordActivity = () => {
      const firebaseUser = auth.currentUser;
      if (!canAttemptStreakActivity({
        profileUid,
        authenticatedUid,
        isAuthReady,
        safeIsAuthReady,
        isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
        isVisible: typeof document !== 'undefined' ? document.visibilityState !== 'hidden' : true,
      }) || !firebaseUser || firebaseUser.uid !== profileUid) {
        return;
      }

      void streakActivitySingleFlight.run(async (signal) => {
        try {
          const token = await firebaseUser.getIdToken();
          const response = await fetch(apiUrl('/api/record-activity'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            signal,
          });
          const data = await response.json();
          if (!response.ok || !data.success) {
            throw new Error(data.error || `Activity request failed with ${response.status}`);
          }
          if (data.freezeUsed) console.log('Freeze token used!');
        } catch (e) {
          console.error('Failed to record activity', e);
        }
      }, 12000);
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) recordActivity();
    };

    recordActivity();
    window.addEventListener('online', recordActivity);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    let removeNativeListener: (() => void) | null = null;
    let isCancelled = false;

    // Connect native Capacitor appStateChange for iOS & Android background resume
    (async () => {
      try {
        const { Capacitor } = await import('@capacitor/core');
        if (!Capacitor?.isNativePlatform?.()) return;

        const { App: CapApp } = await import('@capacitor/app');
        const handle = await CapApp.addListener('appStateChange', (state) => {
          if (state.isActive) {
            recordActivity();
          }
        });
        if (isCancelled) {
          handle.remove();
        } else {
          removeNativeListener = () => { handle.remove(); };
        }
      } catch (err) {
        console.warn('[streak] Native app state listener setup failed', err);
      }
    })();

    return () => {
      isCancelled = true;
      window.removeEventListener('online', recordActivity);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (removeNativeListener) removeNativeListener();
    };
  }, [authenticatedUid, isAuthReady, safeIsAuthReady, streakActivitySingleFlight, user?.uid]);

  useEffect(() => {
    if (!user) return;
    
    // Simplistic check for unread notifications (inbox)
    // We check homeworks and system notifications
    const checkInbox = async () => {
      try {
        const lastRead = parseInt(localStorage.getItem('lastReadInbox') || '0', 10);
        let latestTime = 0;

        // Check latest homework. Scoped to the reader's stage, or the badge
        // lights up for homework they will never see in the list.
        if (!user.isMasterAdmin && user.role !== 'admin' && effectiveStageId) {
           const hwQuery = query(collection(db, 'homeworks'), where('stageId', '==', effectiveStageId), orderBy('createdAt', 'desc'), limit(1));
           const hwSnap = await getDocs(hwQuery);
           if (!hwSnap.empty) {
             const t = hwSnap.docs[0].data().createdAt?.toMillis?.() || 0;
             if (t > latestTime) latestTime = t;
           }
        }

        // Check latest system notif
        const sysQuery = query(collection(db, 'systemNotifications'), where('userId', '==', user.uid), orderBy('createdAt', 'desc'), limit(1));
        const sysSnap = await getDocs(sysQuery);
        if (!sysSnap.empty) {
          const t = sysSnap.docs[0].data().createdAt?.toMillis?.() || 0;
          if (t > latestTime) latestTime = t;
        }

        // Check latest admin alert
        if (canViewStaffInbox(user)) {
          const adQuery = query(collection(db, 'adminAlerts'), orderBy('createdAt', 'desc'), limit(5));
          const adSnap = await getDocs(adQuery);
          for (const docSnap of adSnap.docs) {
            const data = docSnap.data();
            if (data.type === 'ai_quota_exhausted' && !isMasterAdmin(user) && !canManageMcqSystem(user)) {
              continue;
            }
            const t = data.createdAt?.toMillis?.() || 0;
            if (t > latestTime) latestTime = t;
            break;
          }
        }

        if (latestTime > lastRead) {
          setHasUnreadInbox(true);
        }
      } catch (e) {
        console.warn("Could not check inbox:", e);
      }
    };

    checkInbox();
    // Optional polling every 60 seconds
    const interval = setInterval(checkInbox, 60000);
    return () => clearInterval(interval);
  }, [user?.uid, user?.role, effectiveStageId]);

  // Announcements Listener for Notifications
  useEffect(() => {
    if (!user) return;
    if (!effectiveStageId) return;

    const q = query(collection(db, 'announcements'), where('stageId', '==', effectiveStageId), orderBy('createdAt', 'desc'), limit(1));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      if (!snapshot.empty) {
        const latestPost = snapshot.docs[0].data();
        const latestTime = latestPost.createdAt?.toMillis?.() || 0;
        const lastRead = parseInt(localStorage.getItem('lastReadAnnouncement') || '0', 10);
        
        if (latestTime > lastRead && currentTab !== 'announcements') {
          setHasUnreadAnnouncements(true);
        }
      }
    }, (error) => {
      console.warn("Could not listen to announcements (may lack permissions):", error);
      handleFirestoreError(error, OperationType.LIST, 'announcements');
    });
    return () => unsubscribe();
  }, [currentTab, user?.uid, user?.group, user?.role, effectiveStageId]);

  useEffect(() => {
    if (currentTab === 'announcements') {
      setHasUnreadAnnouncements(false);
      localStorage.setItem('lastReadAnnouncement', Date.now().toString());
    }
  }, [currentTab]);

  // Hand the profile to StageContext so it can resolve effectiveStageId for
  // students and representatives, not just the master-admin stage picker.
  useEffect(() => {
    setActiveUser(user, Boolean(isAuthReady && authenticatedUid === user?.uid));
  }, [user, authenticatedUid, isAuthReady, setActiveUser]);

  // Lectures Listener
  useEffect(() => {
    const decision = resolveLectureLoadDecision({
      profileUid: user?.uid,
      authenticatedUid,
      isAuthReady,
      effectiveStageId,
      // Stage entitlement is authoritative. Legacy accounts may legitimately
      // have no users.group while still carrying a valid users/students stage.
      canBrowseLectures: Boolean(user),
    });

    if (!user) {
      setLectures([]);
      setIsLoading(false);
      setLectureLoadState(decision.state);
      return;
    }

    // No resolved stage means we cannot say which content this user is entitled
    // to. Showing every stage's lectures was the old fallback; it leaks the whole
    // university to anyone whose profile is mid-sync.
    if (!effectiveStageId) {
      setLectures([]);
      setIsLoading(false);
      setLectureLoadState(decision.state);
      return;
    }

    const scope = decision.scope!;
    if (lectureScopeRef.current !== scope) {
      lectureScopeRef.current = scope;
      setLectures([]);
    }

    // A cached profile may render before Firebase restores its native session.
    // Do not start an unauthenticated query; restart as soon as the matching
    // UID is available, even if group and stage did not change.
    if (!decision.shouldSubscribe) {
      setIsLoading(true);
      setLectureLoadState(decision.state);
      recordNativeDiagnostic({
        phase: 'lecture-load', outcome: decision.state,
        authenticated: Boolean(isAuthReady && authenticatedUid === user.uid),
      });
      return;
    }

    setIsLoading(true);
    setLectureLoadState(decision.state);
    const q = query(collection(db, 'lectures'), where('stageId', '==', effectiveStageId), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const docs = snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data({ serverTimestamps: 'estimate' }) } as Lecture))
        // The year-end wipe leaves each lecture behind as a stub with no PDF, so
        // that bank questions scoped to it still resolve. Filtered here rather
        // than in the query: a `where` would need an index and would also drop
        // every lecture predating the field.
        .filter(l => !(l as any).archived);
      setLectures(docs);
      setIsLoading(false);
      // An empty cache is not proof that the server has no lectures. Keep it
      // distinct from a confirmed empty query so iOS users can retry.
      setLectureLoadState(snapshot.metadata.fromCache && docs.length === 0 ? 'error' : 'ready');
      recordNativeDiagnostic({
        phase: 'lecture-load',
        outcome: snapshot.metadata.fromCache && docs.length === 0 ? 'cache-empty' : 'snapshot',
        authenticated: true,
        fromCache: snapshot.metadata.fromCache,
        count: docs.length,
      });
    }, (error) => {
      console.warn("Could not listen to lectures (may lack permissions):", error);
      setIsLoading(false);
      setLectureLoadState('error');
      recordNativeDiagnostic({
        phase: 'lecture-load', outcome: 'listener-error',
        code: (error as { code?: string }).code || 'unknown', authenticated: true,
      });
      handleFirestoreError(error, OperationType.LIST, 'lectures');
    });

    return () => unsubscribe();
  }, [user?.uid, user?.role, effectiveStageId, authenticatedUid, isAuthReady, lectureRetry]);

  const retryLectures = useCallback(() => setLectureRetry(value => value + 1), []);

  const filteredLectures = React.useMemo(() => {
    let base = lectures.filter(lecture => {
      const matchesCategory = selectedCategory === 'all' || lecture.category === selectedCategory;
      const matchesType = selectedType === 'all' || lecture.type === selectedType;
      return matchesCategory && matchesType;
    });

    if (searchQuery.trim()) {
      const fuse = new Fuse(base, {
        keys: ['title', 'description'],
        threshold: 0.4,
        ignoreLocation: true,
      });
      base = fuse.search(searchQuery).map(result => result.item);
    }

    return base.sort((a, b) => {
      let comparison = 0;
      if (sortBy === 'title') {
        comparison = a.title.localeCompare(b.title, lang === 'ar' ? 'ar' : 'en');
      } else if (sortBy === 'date') {
        const dateA = a.createdAt?.toMillis?.() || 0;
        const dateB = b.createdAt?.toMillis?.() || 0;
        comparison = dateA - dateB;
      } else if (sortBy === 'number') {
        const numA = a.number || 0;
        const numB = b.number || 0;
        comparison = numA - numB;
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });
  }, [lectures, selectedCategory, selectedType, searchQuery, sortBy, sortOrder, lang]);

  const handleEditLecture = useCallback((l: Lecture) => { setLectureToEdit(l); setShowUpload(true); }, []);
  const handleCloseUpload = useCallback(() => { setShowUpload(false); setLectureToEdit(null); }, []);

  // The one access predicate, shared with the server (shared/simosan.ts's
  // hasAiAccess wraps the same function), so what the UI offers and what the
  // API allows cannot drift apart. This was a hand-written copy of it.
  const hasMCQAccess = (u: UserProfile | null) => hasSubscriptionAccess(u);

  const handleOpenReader = useCallback((l: Lecture) => setReaderLecture(l), []);

  const handleOpenLocalPdf = useCallback(async (file: UserFile) => {
    try {
      const blob = await getUserFileBlob(file.id);
      if (blob) {
        const url = URL.createObjectURL(blob);
        setLocalBlobUrl(url);
        setLocalReaderFile(file);
      }
    } catch (e) {
      console.error('Failed to open local PDF', e);
    }
  }, []);

  const handleCloseLocalReader = useCallback(() => {
    if (localBlobUrl) {
      URL.revokeObjectURL(localBlobUrl);
      setLocalBlobUrl(null);
    }
    setLocalReaderFile(null);
  }, [localBlobUrl]);

  const handleOpenMCQ = useCallback((l: Lecture) => {
    setMcqLecture(l);
  }, []);

  // Google Play and Apple App Store public routes (/privacy, /terms, /delete-account, /support)
  // must be reachable without an account and render completely standalone ahead of auth,
  // loading spinners, dashboards, and navigation bars (Guideline 1.5, 3.1.1, 3.1.2).
  const currentPath = window.location.pathname.replace(/\/+$/, '').toLowerCase() || '/';
  if (currentPath === '/support' || currentPath === '/support-center' || currentPath === '/help') {
    return <SupportPage />;
  }

  const legalPage = resolveLegalPath(window.location.pathname);
  if (legalPage) return legalPage;

  if (!safeIsAuthReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-zinc-950">
        <Loader2 className="w-10 h-10 text-sky-600 dark:text-sky-400 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <LoginScreen lang={lang} externalError={loginError} onClearError={() => setLoginError(null)} />;
  }

  if (user.role === 'student' && mobileReleaseGate.required) {
    return <ForceUpdateScreen gate={mobileReleaseGate} lang={lang} />;
  }

  // Dedicated Doctor Portal Pathway:
  // When a doctor logs in (role === 'doctor'), all standard app screens, bottom tabs,
  // and student navigation are dropped to provide a focused attendance interface.
  if (user?.role === 'doctor') {
    return (
      <DoctorPortal
        user={user}
        lang={lang}
        onLogout={() => {
          console.info('[auth-session] doctor signed-out: explicit-logout');
          setCurrentTab('profile');
          safeSetStorageItem('wasSignedIn', 'false');
          clearCachedUserProfile(user?.uid);
          void signOut(auth);
        }}
      />
    );
  }

  const effectiveProgressionRound = progressionUiState.openRound;

  if (effectiveProgressionRound && (!isProgressionSnoozed || forceShowProgression)) {
    return (
      <ProgressionScreen
        user={user}
        lang={lang}
        round={effectiveProgressionRound}
        hasActivePendingAccess={progressionUiState.hasActivePendingAccess}
        onSubmissionStarted={() => setHeldProgressionRound(effectiveProgressionRound)}
        onSubmissionRejected={() => setHeldProgressionRound(null)}
        onUnavailable={() => {
          setHeldProgressionRound(null);
          setForceShowProgression(false);
          setProgressionNotice(isRtl
            ? 'لا يوجد سؤال انتقال متاح لك حالياً. تم تحديث حالتك.'
            : 'No progression question is currently available. Your status was refreshed.');
        }}
        onDone={() => {
          setHeldProgressionRound(null);
          setForceShowProgression(false);
        }}
      />
    );
  }

  if (user.mustChangePassword && !passwordChanged) {
    return <PasswordChangeGate lang={lang} onDone={() => setPasswordChanged(true)} />;
  }

  // A legacy account can legitimately be stage-assigned before its old group
  // field is backfilled. Stage access is sufficient to enter the content UI.
  if (!user.group && !user.stageId && user.role === 'student') {
    return <OnboardingScreen user={user} lang={lang} />;
  }

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return isRtl ? 'صباح الخير' : 'Good morning';
    if (hour < 18) return isRtl ? 'مساء الخير' : 'Good afternoon';
    return isRtl ? 'مساء الخير' : 'Good evening';
  };

  // Staff compose from a docked bar that owns the bottom edge of the
  // announcements screen, so the floating nav is removed there rather than
  // stacked on top of it - the screen grows a back arrow instead (its `onBack`).
  // Students are unaffected: they never mount the composer, and keep the nav.
  const composingAnnouncements = currentTab === 'announcements' && canManage(user, 'manageAnnouncements');

  const isAnyOverlayOpen = showOnboarding || showUpload || showAdminManage || showStudentManage || showAdminGrades || showAdminBank || showStudentGrades || showAntiCheat || showAdminLogs || showSimosanAdmin || showSubManage || showPaywall || (mcqLecture !== null) || (readerLecture !== null) || (localReaderFile !== null);
  const isReaderOpen = (readerLecture !== null) || (localReaderFile !== null);

  return (
    // index.html sets viewport-fit=cover, so the WebView paints beneath the
    // status bar. The sticky header used to absorb that inset with its own
    // pt-[env(safe-area-inset-top)]; with the header gone the root carries it,
    // or every screen's first row sits under the system clock on a notched phone.
    //
    // The bottom padding is the floating nav's real footprint - a 72px bar over
    // BottomNav's own 16px inset, plus 16px of air, which is the 104px. The
    // safe-area term rides along because BottomNav pads by the same inset: from
    // targetSdk 35 the WebView also paints beneath the gesture bar, so without it
    // the nav floats up and the last card slides underneath by exactly that much.
    //
    // It is the ONLY bottom clearance in the app: every screen used to add its own
    // pb-24/28/32 on top of the root's pb-20, which is what left a blank
    // half-screen under the last card. A screen that needs more room now says so
    // by its own content, not by re-padding.
    <div
      className={`min-h-screen ${isReaderOpen ? 'bg-transparent' : 'bg-stone-50 dark:bg-zinc-900'} text-slate-900 dark:text-stone-100 ${composingAnnouncements || isReaderOpen ? '' : 'pb-[calc(104px+env(safe-area-inset-bottom))]'} font-sans transition-colors duration-300`}
      style={isReaderOpen ? { paddingTop: 0 } : { paddingTop: 'env(safe-area-inset-top)' }}
      dir={isRtl ? 'rtl' : 'ltr'}
    >

      {!isReaderOpen && progressionNotice && (
        <div className="fixed top-[calc(12px+env(safe-area-inset-top))] left-1/2 -translate-x-1/2 z-[200] w-[min(92vw,520px)] rounded-2xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-4 py-3 text-sm font-bold text-amber-900 dark:text-amber-100 shadow-xl">
          {progressionNotice}
        </div>
      )}

      {!isReaderOpen && user && permission === 'default' && !hideNotificationBanner && (
        <div className="bg-sky-600 text-white px-4 py-3 sm:px-6 lg:px-8 flex items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <p className="text-sm font-medium">
              {isRtl ? 'قم بتفعيل الإشعارات لتلقي تنبيهات عند إضافة محاضرات جديدة.' : 'Enable notifications to receive alerts when new lectures are added.'}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => {
                requestPermission();
                handleDismissNotification();
              }}
              disabled={isRequesting}
              className="px-4 py-1.5 bg-white text-sky-600 text-sm font-bold rounded-lg hover:bg-sky-50 transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isRequesting ? (isRtl ? 'جاري التفعيل...' : 'Enabling...') : (isRtl ? 'تفعيل' : 'Enable')}
            </button>
            <button onClick={handleDismissNotification} className="p-1.5 hover:bg-white/20 rounded-lg transition-colors" title="Dismiss">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}

      {!isReaderOpen && user && !examCodeResolved && shouldAskForExamCode(user) && (
        <ExamCodePrompt
          user={user}
          lang={lang}
          onResolved={() => setExamCodeResolved(true)}
        />
      )}

      {!isReaderOpen && ['home', 'lectures', 'weekly', 'records', 'leaderboard', 'downloads'].includes(currentTab) && (
        <HomeScreen 
          user={user} 
          lang={lang} 
          lectures={lectures} 
          searchQuery={searchQuery} 
          setSearchQuery={setSearchQuery}
          onShowUpload={() => setShowUpload(true)}
          isLoading={isLoading} 
          lectureLoadState={lectureLoadState}
          onRetryLectures={retryLectures}
          onEdit={handleEditLecture} 
          onOpenMCQ={handleOpenMCQ}
          onOpenReader={handleOpenReader}
          onOpenLocalPdf={handleOpenLocalPdf}
          setShowStudentManage={setShowStudentManage}
          setShowStreakManage={setShowStreakManage} 
          setShowAdminManage={setShowAdminManage} 
          initialTab={currentTab === 'home' ? 'lectures' : currentTab as any} 
          onOpenProgression={effectiveProgressionRound ? () => setForceShowProgression(true) : undefined}
          onNavigateToSubscription={() => setCurrentTab('subscription')}
          onShowPaywall={() => setShowPaywall(true)}
        />
      )}
      {!isReaderOpen && currentTab === 'announcements' && (
        <AnnouncementsScreen user={user} lang={lang} lectures={lectures} onOpenMCQ={handleOpenMCQ} onOpenReader={handleOpenReader} onBack={() => setCurrentTab('home')} />
      )}
      {!isReaderOpen && currentTab === 'simosan' && (
        activeSimosanService === 'attendance'
          ? <SimosanPage user={user} lang={lang} stageId={effectiveStageId || user.stageId || ''} onBack={() => setActiveSimosanService('hub')} />
          : <SimosanSoonScreen lang={lang} onSelectService={service => {
              if (service === 'attendance') setActiveSimosanService('attendance');
            }} />
      )}
      {!isReaderOpen && currentTab === 'subscription' && (
        <SubscriptionScreen user={user} lang={lang} />
      )}
      {!isReaderOpen && currentTab === 'profile' && (
        <ProfileScreen 
          user={user} 
          lang={lang} 
          setShowStudentGrades={setShowStudentGrades} 
          onOpenSettings={() => setCurrentTab('settings')}
          hasUnreadInbox={hasUnreadInbox}
          onNavigate={(tab: string) => setCurrentTab(tab as Tab)}
          onNavigateToSubscription={() => setCurrentTab('subscription')}
          onOpenProgression={effectiveProgressionRound ? () => setForceShowProgression(true) : undefined}
          progressionRound={effectiveProgressionRound}
          hasActivePendingProgression={progressionUiState.hasActivePendingAccess}
        />
      )}
      {/* A real page, not an overlay: the profile unmounts behind it and the nav
          bars stay usable. Opening an admin tool from here leaves currentTab on
          'settings', so closing that tool returns to settings rather than
          dumping the user back on the profile. */}
      {!isReaderOpen && currentTab === 'settings' && (
        <SettingsScreen
          onBack={() => setCurrentTab('profile')}
          user={user}
          lang={lang}
          setLang={setLang}
          theme={theme}
          setTheme={setTheme}
          notificationPermission={permission}
          onRequestNotifications={requestPermission}
          hasUnreadInbox={hasUnreadInbox}
          onOpenInbox={() => {
            setShowNotificationsModal(true);
            setHasUnreadInbox(false);
            localStorage.setItem('lastReadInbox', Date.now().toString());
          }}
          onOpenTour={() => setShowOnboarding(true)}
          onLogout={() => {
            console.info('[auth-session] signed-out: explicit-logout');
            setCurrentTab('profile');
            safeSetStorageItem('wasSignedIn', 'false');
            clearCachedUserProfile(user?.uid);
            void signOut(auth);
          }}
          onOpen={(what) => {
            if (what === 'adminManage') setShowAdminManage(true);
            else if (what === 'studentManage') setShowStudentManage(true);
            else if (what === 'streakManage') setShowStreakManage(true);
            else if (what === 'adminGrades') setShowAdminGrades(true);
            else if (what === 'studentGrades') setShowStudentGrades(true);
            else if (what === 'adminLogs') setShowAdminLogs(true);
            else if (what === 'simosanAdmin') setShowSimosanAdmin(true);
              else if (what === 'telegramMirror') setShowTelegramMirror(true);
            else if (what === 'subManage') setShowSubManage(true);
            else if (what === 'calendar') setShowCalendarSettings(true);
            else if (what === 'subscription') setCurrentTab('subscription');
          }}
        />
      )}

      <AdminUpload 
        isOpen={showUpload} 
        onClose={handleCloseUpload} 
        lang={lang} 
        lectureToEdit={lectureToEdit}
        user={user}
      />
      <AdminManagement isOpen={showAdminManage} onClose={() => setShowAdminManage(false)} lang={lang} user={user} />
      <StreakManagement isOpen={showStreakManage} onClose={() => setShowStreakManage(false)} lang={lang} user={user} />
      <AcademicCalendarModal isOpen={showCalendarSettings} onClose={() => setShowCalendarSettings(false)} lang={lang} user={user} />
      <StudentManagement isOpen={showStudentManage} onClose={() => setShowStudentManage(false)} lang={lang} user={user} />
      <AdminGradesScreen isOpen={showAdminGrades} onClose={() => setShowAdminGrades(false)} user={user} />
      <AdminQuestionBankScreen 
        isOpen={showAdminBank} 
        onClose={() => {
          setShowAdminBank(false);
          setAdminBankTargetQuestionId(null);
          setAdminBankTargetAlert(null);
        }} 
        lang={lang} 
        targetQuestionId={adminBankTargetQuestionId}
        targetAlert={adminBankTargetAlert}
        canOpenAntiCheat={canManageAntiCheat(user)}
      />
      <AntiCheatDashboard isOpen={showAntiCheat} onClose={() => setShowAntiCheat(false)} lang={lang} />
      <AdminLogsScreen isOpen={showAdminLogs} onClose={() => setShowAdminLogs(false)} lang={lang} />
      <SimosanAdminScreen isOpen={showSimosanAdmin} onClose={() => setShowSimosanAdmin(false)} lang={lang} />
      <TelegramMirrorModal isOpen={showTelegramMirror} onClose={() => setShowTelegramMirror(false)} lang={lang} user={user} />
      <StudentGradesScreen isOpen={showStudentGrades} onClose={() => setShowStudentGrades(false)} />
      {showSubManage && <SubscriptionManagement user={user!} lang={lang} onClose={() => setShowSubManage(false)} />}
      
      {showPaywall && (
        <SubscriptionPaywall 
          lang={lang} 
          onClose={() => setShowPaywall(false)} 
          onSubscribe={() => {
            setShowPaywall(false);
            setCurrentTab('subscription');
          }} 
        />
      )}
      
      {showNotificationsModal && user && (
        <NotificationsModal
          user={user}
          lang={lang}
          onClose={() => setShowNotificationsModal(false)}
          onNavigateToQuestion={handleNavigateToReportedQuestion}
        />
      )}

      {editingLectureMcq && (
        <LectureMCQDirectEditModal
          isOpen={true}
          lectureId={editingLectureMcq.lectureId}
          lectureTitle={editingLectureMcq.lectureTitle}
          question={editingLectureMcq.question}
          alertData={editingLectureMcq.alert}
          onClose={() => setEditingLectureMcq(null)}
          onSaved={() => setEditingLectureMcq(null)}
        />
      )}

      {mcqLecture && user && (
        <MCQOverlay 
          lecture={mcqLecture} 
          user={user} 
          lang={lang} 
          isSubscribed={hasMCQAccess(user)}
          onShowPaywall={() => setShowPaywall(true)}
          onClose={() => setMcqLecture(null)} 
        />
      )}

      {readerLecture?.pdfUrl && (
        <Suspense fallback={null}>
          <PdfReaderOverlay
            lectureId={readerLecture.id}
            lectureTitle={readerLecture.title}
            pdfUrl={readerLecture.pdfUrl}
            stageId={readerLecture.stageId}
            subjectId={readerLecture.subjectId}
            user={user}
            lang={lang}
            onClose={() => setReaderLecture(null)}
            onOpenSubscription={() => {
              setReaderLecture(null);
              setShowPaywall(true);
            }}
          />
        </Suspense>
      )}

      {localReaderFile && localBlobUrl && (
        <Suspense fallback={null}>
          <PdfReaderOverlay
            lectureId={localReaderFile.id}
            lectureTitle={localReaderFile.name}
            pdfUrl={localBlobUrl}
            isLocalFile={true}
            user={user}
            lang={lang}
            onClose={handleCloseLocalReader}
            onOpenSubscription={() => {
              handleCloseLocalReader();
              setShowPaywall(true);
            }}
          />
        </Suspense>
      )}

      <AnimatePresence>
        {showOnboarding && (
          <OnboardingSlides 
            lang={lang}
            onComplete={() => {
              localStorage.setItem('hasSeenTour_v3', 'true');
              setShowOnboarding(false);
            }} 
          />
        )}
      </AnimatePresence>

      <GlobalAudioPlayer isRtl={isRtl} />
      <AnimatePresence>
        {(!isAnyOverlayOpen && !composingAnnouncements) && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 30 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 30 }}
            transition={{ type: "spring", stiffness: 400, damping: 25 }}
            className="relative z-50"
          >
            <BottomNav currentTab={currentTab} setCurrentTab={setCurrentTab} lang={lang} hasUnreadAnnouncements={hasUnreadAnnouncements} hasUnreadInbox={hasUnreadInbox} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
