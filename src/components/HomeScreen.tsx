import React, { useState, useEffect } from 'react';
import { UserProfile, Language, TRANSLATIONS, Lecture } from '../types';
import { Flame, BookOpen, Search, Upload, X, Clock, Sparkles } from 'lucide-react';
import { canManage } from '../lib/permissions';
import { useStageContext } from '../contexts/StageContext';
import SubjectBrowser from './SubjectBrowser';
import WeeklyListScreen from './WeeklyListScreen';
import RecordsScreen from './RecordsScreen';
import LeaderboardTab from './LeaderboardTab';
import LectureCard from './LectureCard';
import { motion, AnimatePresence } from 'motion/react';
import { db } from '../lib/firebase';
import { doc, getDoc } from 'firebase/firestore';
import PersonalSpaceTab from './PersonalSpaceTab';
import { type UserFile } from '../lib/localDb';

type InnerTab = 'lectures' | 'weekly' | 'records' | 'leaderboard' | 'downloads';

interface HomeScreenProps {
  user: UserProfile | null;
  lang: Language;
  lectures: Lecture[];
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  /** Opens the lecture uploader. Staff only - see canManage(user, 'manageLectures'). */
  onShowUpload: () => void;
  isLoading: boolean;
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
  
  const [activeTab, setActiveTab] = useState<InnerTab>(initialTab);
  const [pendingDaysLeft, setPendingDaysLeft] = useState<number | null>(null);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (user?.hasPendingStreakReset && user.uid) {
      getDoc(doc(db, 'pending_streak_resets', user.uid)).then(d => {
        if (d.exists()) {
          const data = d.data();
          if (data.expiresAt) {
            const exp = data.expiresAt.toDate ? data.expiresAt.toDate() : new Date(data.expiresAt);
            const now = new Date();
            const diffTime = exp.getTime() - now.getTime();
            if (diffTime > 0) {
              setPendingDaysLeft(Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
            }
          }
        }
      }).catch(console.error);
    } else {
      setPendingDaysLeft(null);
    }
  }, [user?.uid, user?.hasPendingStreakReset]);

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return isRtl ? 'صباح الخير' : 'Good morning';
    if (hour < 18) return isRtl ? 'مساء الخير' : 'Good afternoon';
    return isRtl ? 'مساء الخير' : 'Good evening';
  };

  // Only the two tabs that actually read searchQuery offer the field. Weekly,
  // downloads and the leaderboard ignore it, and a search box that silently does
  // nothing is worse than no search box.
  const searchable = activeTab === 'lectures' || activeTab === 'records';
  const canUpload = canManage(user, 'manageLectures') && activeTab === 'lectures';

  const tabs: { id: InnerTab; label: string }[] = [
    { id: 'weekly', label: isRtl ? 'واجبات الأسبوع' : 'Weekly Tasks' },
    { id: 'records', label: isRtl ? 'التسجيلات' : 'Records' },
    { id: 'lectures', label: isRtl ? 'المحاضرات' : 'Lectures' },
    { id: 'downloads', label: isRtl ? 'مساحتك' : 'Your Space' },
    { id: 'leaderboard', label: isRtl ? '🏆 لوحة الصدارة' : '🏆 Leaderboard' }
  ];

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8">
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
                  {isRtl
                    ? 'يمكنك تصفح مواد ومحاضرات المرحلتين بحرية. هل صدرت نتيجتك النهائية؟ اضغط هنا للتأكيد.'
                    : 'Browse lectures from both stages freely. Did your official results come out? Tap to confirm.'}
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
      <div className={`mb-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${isRtl ? 'sm:text-right' : 'sm:text-left'}`}>
        <div>
          <h1 className="text-3xl sm:text-4xl font-black text-slate-900 dark:text-stone-100 tracking-tight mb-1">
            {getGreeting()}, {user?.name?.split(' ')[0] || (isRtl ? 'طالب' : 'Student')}
          </h1>
          <p className="text-slate-500 dark:text-slate-400 font-medium text-lg">
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

            {user.hasPendingStreakReset && pendingDaysLeft !== null && (
              <div className="flex items-center gap-1.5 px-3 py-2 bg-rose-50 dark:bg-rose-900/30 border-2 border-rose-100 dark:border-rose-900/50 rounded-2xl shadow-sm cursor-help relative group">
                <span className="text-xs font-black text-rose-600 dark:text-rose-400">
                  {isRtl ? `ستريك معلق (${pendingDaysLeft})` : `Streak at risk (${pendingDaysLeft})`}
                </span>
                <div className="absolute top-full mt-2 w-48 p-2 bg-slate-800 text-white text-xs rounded-xl shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-20 end-0">
                  {isRtl
                    ? `أمامك ${pendingDaysLeft} أيام لاستعادة الستريك المفقود قبل أن يختفي العرض نهائياً.`
                    : `You have ${pendingDaysLeft} days to restore your lost streak before the offer disappears.`}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Horizontal Scrollable Filter Chips */}
      <div className="flex overflow-x-auto hide-scrollbar gap-2 mb-8 pb-2" dir={isRtl ? 'rtl' : 'ltr'}>
        {tabs.map(tab => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`whitespace-nowrap px-5 py-2.5 rounded-2xl font-bold text-sm transition-colors border-2 ${
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
                placeholder={activeTab === 'records' ? t.searchPlaceholderRecords : t.searchPlaceholder}
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
        {activeTab === 'lectures' && (() => {
          const currentLectures = lectures.filter(l => !user?.tahmeelSubjects?.includes(l.subjectId || ''));
          const tahmeelLectures = lectures.filter(l => user?.tahmeelSubjects?.includes(l.subjectId || ''));
          
          return (
            <div className="space-y-12">
              <SubjectBrowser
                lectures={currentLectures}
                lang={lang}
                user={user}
                searchQuery={searchQuery}
                isLoading={isLoading}
                onEdit={onEdit}
                onOpenMCQ={onOpenMCQ}
                onOpenReader={onOpenReader}
                onShowPaywall={onShowPaywall}
              />
              
              {tahmeelLectures.length > 0 && (
                <div className="border-t border-slate-200 dark:border-zinc-800 pt-8">
                  <div className="flex items-center gap-3 mb-6 px-2 sm:px-0">
                    <div className="w-10 h-10 rounded-xl bg-yellow-100 dark:bg-yellow-900/30 flex items-center justify-center">
                      <BookOpen className="w-5 h-5 text-yellow-600 dark:text-yellow-400" />
                    </div>
                    <h2 className="text-2xl font-black text-slate-900 dark:text-stone-100">
                      {isRtl ? 'مواد التحميل' : 'Carry-over Subjects'}
                    </h2>
                  </div>
                  <SubjectBrowser
                    lectures={tahmeelLectures}
                    lang={lang}
                    user={user}
                    searchQuery={searchQuery}
                    isLoading={isLoading}
                    onEdit={onEdit}
                    onOpenMCQ={onOpenMCQ}
                    onOpenReader={onOpenReader}
                    onShowPaywall={onShowPaywall}
                  />
                </div>
              )}
            </div>
          );
        })()}
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
        {activeTab === 'records' && (
          <RecordsScreen user={user} lang={lang} searchQuery={searchQuery} />
        )}
        {activeTab === 'leaderboard' && (
          <LeaderboardTab user={user} lang={lang} />
        )}
      </div>
    </main>
  );
}
