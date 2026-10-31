import React, { useState, useEffect } from 'react';
import { UserProfile, Language, TRANSLATIONS, Lecture, COURSE_IDS, DEFAULT_COURSE_ID } from '../types';
import { Flame, Search, Upload, X, Clock, Sparkles } from 'lucide-react';
import { canManage } from '../lib/permissions';
import { useStageContext } from '../contexts/StageContext';
import SubjectBrowser from './SubjectBrowser';
import WeeklyListScreen from './WeeklyListScreen';
import LeaderboardTab from './LeaderboardTab';
import LectureCard from './LectureCard';
import { motion, AnimatePresence } from 'motion/react';
import PersonalSpaceTab from './PersonalSpaceTab';
import { type UserFile } from '../lib/localDb';
import CourseTabs from './CourseTabs';
import TahmeelSubjectsView from './TahmeelSubjectsView';
import { useStageSubjects } from '../hooks/useStageSubjects';

type InnerTab = 'lectures' | 'weekly' | 'leaderboard' | 'downloads';

interface HomeScreenProps {
  user: UserProfile | null;
  lang: Language;
  lectures: Lecture[];
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  /** Opens the lecture uploader. Staff only - see canManage(user, 'manageLectures'). */
  onShowUpload: () => void;
  isLoading: boolean;
  lectureLoadState?: 'loading' | 'ready' | 'error' | 'waiting-auth' | 'missing-stage';
  onRetryLectures?: () => void;
  onEdit: (l: Lecture) => void;
  onOpenMCQ?: (l: Lecture) => void;
  onOpenReader?: (l: Lecture) => void;
  setShowStudentManage: (val: boolean) => void;
  setShowStreakManage: (val: boolean) => void;
  setShowAdminManage: (val: boolean) => void;
  initialTab?: InnerTab;
  onOpenProgression?: () => void;
  onOpenLocalPdf?: (file: UserFile) => void;
  onNavigateToSubscription?: () => void;
  onShowPaywall?: () => void;
}

export default function HomeScreen({
  user,
  lang,
  lectures,
  searchQuery,
  setSearchQuery,
  onShowUpload,
  isLoading,
  lectureLoadState,
  onRetryLectures,
  onEdit,
  onOpenMCQ,
  onOpenReader,
  setShowStudentManage,
  setShowStreakManage,
  setShowAdminManage,
  initialTab = 'lectures',
  onOpenProgression,
  onOpenLocalPdf,
  onNavigateToSubscription,
  onShowPaywall
}: HomeScreenProps) {
  const t = TRANSLATIONS[lang];
  const isRtl = lang === 'ar';
  const { isPendingProgression, provisionalStages, selectedStudentStage, setSelectedStudentStage, effectiveStageId } = useStageContext();
  const { subjects: stageSubjects } = useStageSubjects();
  const hasTahmeel = Boolean(user?.tahmeelSubjects?.length);
  const [tahmeelActive, setTahmeelActive] = useState(false);
  const courseCounts = COURSE_IDS.reduce((counts, courseId) => {
    counts[courseId] = stageSubjects.filter(subject => (subject.courseId || DEFAULT_COURSE_ID) === courseId).length;
    return counts;
  }, {} as Record<(typeof COURSE_IDS)[number], number>);
  
  const [activeTab, setActiveTab] = useState<InnerTab>(
    (initialTab as any) === 'records' ? 'lectures' : initialTab
  );

  useEffect(() => {
    if ((initialTab as any) === 'records') {
      setActiveTab('lectures');
    } else if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);

  useEffect(() => {
    if (!hasTahmeel) setTahmeelActive(false);
  }, [hasTahmeel]);


  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return isRtl ? 'صباح الخير' : 'Good morning';
    if (hour < 18) return isRtl ? 'مساء الخير' : 'Good afternoon';
    return isRtl ? 'مساء الخير' : 'Good evening';
  };

  // Only the lectures tab reads searchQuery; weekly, downloads and the leaderboard ignore it.
  const searchable = activeTab === 'lectures';
  const canUpload = canManage(user, 'manageLectures') && activeTab === 'lectures';

  const tabs: { id: InnerTab; label: string }[] = [
    { id: 'weekly', label: isRtl ? 'واجبات الأسبوع' : 'Weekly Tasks' },
    { id: 'lectures', label: isRtl ? 'المحاضرات' : 'Lectures' },
    { id: 'downloads', label: isRtl ? 'مساحتك' : 'Your Space' },
    { id: 'leaderboard', label: isRtl ? '🏆 لوحة الصدارة' : '🏆 Leaderboard' }
  ];

  return (
    <main className="max-w-7xl w-full min-w-0 mx-auto px-3 sm:px-6 lg:px-8 pt-4 sm:pt-8">
      {/* Provisional Mode Banner & Stage Switcher */}
      {isPendingProgression && provisionalStages && (
        <div className="mb-6 space-y-3">
          <div className="bg-gradient-to-r from-amber-500/15 via-orange-500/10 to-amber-500/15 border-2 border-amber-300 dark:border-amber-700/60 rounded-3xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-sm">
            <div className="flex items-start sm:items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-amber-500/20 text-amber-700 dark:text-amber-300 flex items-center justify-center shrink-0 mt-0.5 sm:mt-0">
                <Clock className="w-5 h-5" />
              </div>
              <div>
                <p className="font-bold text-base text-amber-950 dark:text-amber-100 flex items-center gap-2">
                  <span>{isRtl ? 'أنت في مرحلة الاطلاع المؤقت' : 'You are in provisional access mode'}</span>
                  <span className="text-[11px] font-black px-2 py-0.5 rounded-full bg-amber-200/80 dark:bg-amber-900/60 text-amber-900 dark:text-amber-200">
                    {isRtl ? 'الاختبارات معلقة' : 'Quizzes locked'}
                  </span>
                </p>
                <p className="text-xs sm:text-sm text-amber-800 dark:text-amber-300/90 mt-0.5">
                  {onOpenProgression
                    ? (isRtl
                        ? 'يمكنك تصفح مواد ومحاضرات المرحلتين بحرية. صدرت النتائج ويمكنك تأكيد نتيجتك الآن.'
                        : 'Browse lectures from both stages freely. Results are available and you can confirm now.')
                    : (isRtl
                        ? 'يمكنك تصفح مواد ومحاضرات المرحلتين مؤقتاً. سيظهر زر التأكيد عند فتح سؤال النتيجة.'
                        : 'Browse both stages temporarily. Confirmation will appear when the result question opens.')}
                </p>
              </div>
            </div>
            {onOpenProgression && (
              <button
                type="button"
                onClick={onOpenProgression}
                className="px-4 py-2.5 bg-amber-600 hover:bg-amber-700 text-white text-xs sm:text-sm font-black rounded-2xl shadow-sm transition-all flex items-center justify-center gap-1.5 shrink-0"
              >
                <Sparkles className="w-4 h-4" />
                <span>{isRtl ? 'تأكيد النتيجة النهائية' : 'Confirm Final Result'}</span>
              </button>
            )}
          </div>

          {/* Dual-Stage Toggle Pill Bar */}
          <div className="flex items-center justify-center p-1.5 bg-slate-100 dark:bg-zinc-800/80 rounded-2xl border border-slate-200/80 dark:border-zinc-700 max-w-md mx-auto">
            <button
              type="button"
              onClick={() => setSelectedStudentStage(provisionalStages.current?.id || null)}
              className={`flex-1 py-2 px-3 rounded-xl text-xs sm:text-sm font-bold transition-all text-center ${
                effectiveStageId === provisionalStages.current?.id
                  ? 'bg-white dark:bg-zinc-700 text-sky-600 dark:text-sky-300 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {isRtl ? provisionalStages.current?.nameAr : provisionalStages.current?.nameEn}
              <span className="text-[10px] opacity-70 block font-normal">{isRtl ? '(مرحلتك الحالية)' : '(Current)'}</span>
            </button>
            <button
              type="button"
              onClick={() => setSelectedStudentStage(provisionalStages.next?.id || null)}
              className={`flex-1 py-2 px-3 rounded-xl text-xs sm:text-sm font-bold transition-all text-center ${
                effectiveStageId === provisionalStages.next?.id
                  ? 'bg-white dark:bg-zinc-700 text-sky-600 dark:text-sky-300 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {isRtl ? provisionalStages.next?.nameAr : provisionalStages.next?.nameEn} ✨
              <span className="text-[10px] opacity-70 block font-normal">{isRtl ? '(المرحلة القادمة)' : '(Next Stage)'}</span>
            </button>
          </div>
        </div>
      )}

      {/* Personalized Greeting Header */}
      <div className={`mb-5 sm:mb-8 flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 ${isRtl ? 'sm:text-right' : 'sm:text-left'}`}>
        <div>
          <h1 className="text-2xl sm:text-4xl font-black text-slate-900 dark:text-stone-100 tracking-tight mb-1 break-words">
            {getGreeting()}, {user?.name?.split(' ')[0] || (isRtl ? 'طالب' : 'Student')}
          </h1>
          <p className="text-slate-500 dark:text-slate-400 font-medium text-base sm:text-lg">
            {isRtl ? 'المنصة الطلابية الجامعية' : 'University Student Platform'}
          </p>
        </div>
        
        {/* Two decorative chips ("الطلاب" / "أكاديمي") used to sit here. They had
            no onClick and no data behind them - leftover scaffolding - and their
            labels were hardcoded Arabic, so they stayed Arabic in English. The
            streak chip below is real and carries a live number. */}
        {user && (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 ps-2 pe-3 py-2 bg-white dark:bg-zinc-800 border-2 border-slate-100 dark:border-zinc-700 rounded-2xl shadow-sm">
              <div className="w-8 h-8 rounded-xl bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center shrink-0">
                <Flame className="w-4 h-4 text-orange-600 dark:text-orange-400" strokeWidth={2.5} />
              </div>
              <div className="min-w-0">
                <div className="text-[10px] font-bold text-slate-400 dark:text-slate-500 leading-none mb-0.5">
                  {isRtl ? 'الستريك' : 'Streak'}
                </div>
                <div className="text-sm font-black text-slate-800 dark:text-stone-100 leading-none">
                  {user.streakCount || 0} {isRtl ? 'يوم' : 'days'}
                </div>
              </div>
            </div>

          </div>
        )}
      </div>

      {/* Horizontal Scrollable Filter Chips */}
      <div className="flex max-w-full overflow-x-auto overscroll-x-contain hide-scrollbar gap-2 mb-5 sm:mb-8 pb-2" dir={isRtl ? 'rtl' : 'ltr'}>
        {tabs.map(tab => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`shrink-0 whitespace-nowrap px-3.5 sm:px-5 py-2.5 rounded-2xl font-bold text-xs sm:text-sm transition-colors border-2 ${
                isActive
                  ? 'bg-sky-500 border-sky-500 text-white shadow-sm'
                  : 'bg-white dark:bg-zinc-800 border-slate-100 dark:border-zinc-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-zinc-700/60 shadow-sm'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Search and upload. Both used to sit in the app header, which is gone -
          the theme, language, inbox and stage controls it also held moved into
          Settings, but these two act on the list right below them, so they moved
          onto the screen they act on instead. */}
      {(searchable || canUpload) && (
        <div className="flex items-center gap-2 mb-8 -mt-2">
          {searchable && (
            <div className="relative flex-1 min-w-0">
              <div className={`absolute inset-y-0 ${isRtl ? 'right-0 pr-4' : 'left-0 pl-4'} flex items-center pointer-events-none`}>
                <Search className="h-4 w-4 text-slate-400 dark:text-slate-500" strokeWidth={2.5} />
              </div>
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={t.searchPlaceholder}
                className={`w-full ${isRtl ? 'pr-11 pl-10' : 'pl-11 pr-10'} py-3 bg-white dark:bg-zinc-800 border-2 border-slate-100 dark:border-zinc-700 rounded-2xl text-sm font-bold text-slate-800 dark:text-stone-100 placeholder:font-medium placeholder-slate-400 dark:placeholder-slate-500 shadow-sm outline-none focus:border-sky-500 dark:focus:border-sky-500 transition-colors`}
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  aria-label={isRtl ? 'مسح البحث' : 'Clear search'}
                  className={`absolute inset-y-0 ${isRtl ? 'left-0 pl-3' : 'right-0 pr-3'} flex items-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors`}
                >
                  <X className="h-4 w-4" strokeWidth={2.5} />
                </button>
              )}
            </div>
          )}

          {canUpload && (
            <button
              onClick={onShowUpload}
              title={t.upload}
              className={`flex items-center justify-center gap-2 ${searchable ? 'w-12 sm:w-auto sm:px-5' : 'px-5'} h-12 shrink-0 bg-sky-500 hover:bg-sky-600 text-white rounded-2xl font-bold text-sm shadow-sm transition-colors`}
            >
              <Upload className="w-4 h-4" strokeWidth={2.5} />
              <span translate="no" className={`notranslate ${searchable ? 'hidden sm:inline' : ''}`}>{t.upload}</span>
            </button>
          )}
        </div>
      )}

      {/* Content Area */}
      <div className="relative">
        {activeTab === 'lectures' && (
          <div className="space-y-6">
            {(stageSubjects.length > 0 || hasTahmeel) && (
              <CourseTabs
                lang={lang}
                counts={courseCounts}
                showTahmeel={hasTahmeel}
                tahmeelActive={tahmeelActive}
                tahmeelCount={user?.tahmeelSubjects?.length}
                onTahmeelActiveChange={setTahmeelActive}
              />
            )}
            {tahmeelActive && user ? (
              <TahmeelSubjectsView
                user={user}
                lang={lang}
                searchQuery={searchQuery}
                onOpenMCQ={onOpenMCQ}
                onOpenReader={onOpenReader}
                onShowPaywall={onShowPaywall}
              />
            ) : (
              <SubjectBrowser
                lectures={lectures}
                lang={lang}
                user={user}
                searchQuery={searchQuery}
                isLoading={isLoading}
                lectureLoadState={lectureLoadState}
                onRetryLectures={onRetryLectures}
                onEdit={onEdit}
                onOpenMCQ={onOpenMCQ}
                onOpenReader={onOpenReader}
                onShowPaywall={onShowPaywall}
                showCourseTabs={false}
              />
            )}
          </div>
        )}
        {activeTab === 'downloads' && (
          <PersonalSpaceTab
            user={user}
            lang={lang}
            onOpenLocalPdf={(file) => {
              if (onOpenLocalPdf) onOpenLocalPdf(file);
            }}
            onNavigateToSubscription={onNavigateToSubscription}
            onShowPaywall={onShowPaywall}
          />
        )}
        {activeTab === 'weekly' && (
          <WeeklyListScreen user={user} lang={lang} />
        )}
        {activeTab === 'leaderboard' && (
          <LeaderboardTab user={user} lang={lang} />
        )}
      </div>
    </main>
  );
}
