import React, { useState, useEffect } from 'react';
import { UserProfile, Language, TRANSLATIONS, Lecture } from '../types';
import { Flame, BookOpen, Search, Upload, X } from 'lucide-react';
import { canManage } from '../lib/permissions';
import SubjectBrowser from './SubjectBrowser';
import WeeklyListScreen from './WeeklyListScreen';
import RecordsScreen from './RecordsScreen';
import LeaderboardTab from './LeaderboardTab';
import LectureCard from './LectureCard';
import { motion, AnimatePresence } from 'motion/react';
import { db } from '../lib/firebase';
import { doc, getDoc } from 'firebase/firestore';
import { listOfflineLectures, type OfflineLecture } from '../lib/localDb';

function DownloadsTab({ lectures, lang, user, onNavigateToChat, onEdit, onOpenMCQ, onOpenReader }: any) {
  const [trigger, setTrigger] = useState(0);
  const [storedLectures, setStoredLectures] = useState<OfflineLecture[]>([]);
  const isRtl = lang === 'ar';

  // The Firestore-backed `lectures` array is empty on an offline cold start, and
  // this tab used to filter only that - so a student with saved PDFs was told
  // they had no downloads. IndexedDB holds a snapshot of each downloaded
  // lecture, which is the copy that survives having no network.
  useEffect(() => {
    let cancelled = false;
    listOfflineLectures()
      .then(rows => { if (!cancelled) setStoredLectures(rows); })
      .catch(() => { if (!cancelled) setStoredLectures([]); });
    return () => { cancelled = true; };
  }, [trigger]);

  // Live documents win where both exist - a title edited since the download
  // should show its current text - with the stored snapshot filling the rest.
  const liveById = new Map<string, Lecture>(lectures.map((l: Lecture) => [l.id, l]));
  const merged = new Map<string, Lecture>();
  for (const stored of storedLectures) {
    merged.set(stored.id, (liveById.get(stored.id) ?? stored) as Lecture);
  }
  for (const l of lectures as Lecture[]) {
    if (localStorage.getItem(`pdf_${l.id}`)) merged.set(l.id, l);
  }

  const downloadedLectures = Array.from(merged.values())
    .map((l: Lecture) => ({
      lecture: l,
      downloadedAt:
        parseInt(localStorage.getItem(`pdf_${l.id}`) || '0', 10)
        || storedLectures.find(s => s.id === l.id)?.savedAt
        || 0,
    }))
    .sort((a: any, b: any) => b.downloadedAt - a.downloadedAt);

  if (downloadedLectures.length === 0) {
    return (
      <div className="text-center py-12 bg-white dark:bg-zinc-800 rounded-3xl border border-slate-200 dark:border-zinc-700 border-dashed">
        <h3 className="text-slate-500 dark:text-slate-400 font-medium">
          {isRtl ? 'لا توجد تنزيلات محفوظة' : 'No saved downloads'}
        </h3>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
      {downloadedLectures.map(({ lecture }: any) => (
        <LectureCard
          key={lecture.id}
          lecture={lecture}
          lang={lang}
          user={user}
          onNavigateToChat={onNavigateToChat}
          onEdit={onEdit}
          onOpenMCQ={onOpenMCQ} onOpenReader={onOpenReader}
          onRemoveDownload={() => setTrigger(t => t + 1)}
        />
      ))}
    </div>
  );
}

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
  onNavigateToChat: () => void;
  onEdit: (l: Lecture) => void;
  onOpenMCQ?: (l: Lecture) => void;
  onOpenReader?: (l: Lecture) => void;
  setShowStudentManage: (val: boolean) => void;
  setShowStreakManage: (val: boolean) => void;
  setShowAdminManage: (val: boolean) => void;
  initialTab?: InnerTab;
}

export default function HomeScreen({
  user,
  lang,
  lectures,
  searchQuery,
  setSearchQuery,
  onShowUpload,
  isLoading,
  onNavigateToChat,
  onEdit,
  onOpenMCQ,
  onOpenReader,
  setShowStudentManage,
  setShowStreakManage,
  setShowAdminManage,
  initialTab = 'lectures'
}: HomeScreenProps) {
  const t = TRANSLATIONS[lang];
  const isRtl = lang === 'ar';
  
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
    { id: 'downloads', label: isRtl ? 'التنزيلات المحفوظة' : 'Saved Downloads' },
    { id: 'leaderboard', label: isRtl ? '🏆 لوحة الصدارة' : '🏆 Leaderboard' }
  ];

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8">
      {/* Personalized Greeting Header */}
      <div className={`mb-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${isRtl ? 'sm:text-right' : 'sm:text-left'}`}>
        <div>
          <h1 className="text-3xl sm:text-4xl font-black text-slate-900 dark:text-stone-100 tracking-tight mb-1">
            {getGreeting()}, {user?.name?.split(' ')[0] || (isRtl ? 'طالب' : 'Student')}
          </h1>
          <p className="text-slate-500 dark:text-slate-400 font-medium text-lg">
            {isRtl ? 'قسم الصيدلة - جامعة الصفوة' : 'Pharmacy Department - Al-Safwa University'}
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
                onNavigateToChat={onNavigateToChat}
                onEdit={onEdit}
                onOpenMCQ={onOpenMCQ} onOpenReader={onOpenReader}
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
                    onNavigateToChat={onNavigateToChat}
                    onEdit={onEdit}
                    onOpenMCQ={onOpenMCQ} onOpenReader={onOpenReader}
                  />
                </div>
              )}
            </div>
          );
        })()}
        {activeTab === 'downloads' && (
          <DownloadsTab
             lectures={lectures}
             lang={lang}
             user={user}
             onNavigateToChat={onNavigateToChat}
             onEdit={onEdit}
             onOpenMCQ={onOpenMCQ} onOpenReader={onOpenReader}
          />
        )}
        {activeTab === 'weekly' && (
          <WeeklyListScreen user={user} lang={lang} />
        )}
        {activeTab === 'records' && (
          <RecordsScreen user={user} lang={lang} searchQuery={searchQuery} onNavigateToChat={onNavigateToChat} />
        )}
        {activeTab === 'leaderboard' && (
          <LeaderboardTab user={user} lang={lang} />
        )}
      </div>
    </main>
  );
}
