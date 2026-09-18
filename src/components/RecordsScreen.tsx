import React, { useState, useEffect } from 'react';
import { collection, query, orderBy, onSnapshot, where } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { RecordItem, Language, TRANSLATIONS, UserProfile, CATEGORIES, LectureType } from '../types';
import { Loader2, Mic, Search, Play, Pause, Plus, HardDrive, Clock, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Fuse from 'fuse.js';
import AdminRecordUpload from './AdminRecordUpload';
import AudioPlayer from './AudioPlayer';
import { useStageContext } from '../contexts/StageContext';
import CourseTabs from './CourseTabs';
import { DEFAULT_COURSE_ID } from '../types';
import { canManage } from '../lib/permissions';
import { useStageSubjects } from '../hooks/useStageSubjects';
import { resolveSubjectLabel, subjectSlugOf, subjectAccent, findSubject } from '../lib/subjectDisplay';
import type { SubjectAccent } from '../lib/subjectDisplay';

/**
 * Hand-picked colours for the five legacy categories, kept so pre-migration
 * recordings look exactly as they always did. Every other subject is coloured
 * by `subjectAccent`, which hashes the slug rather than indexing the list -
 * a representative reordering subjects must not repaint the screen.
 */
const CATEGORY_UI: Record<string, { emoji: string; color: string; border: string; bg: string; badge: string }> = {
  all: { emoji: '📚', color: 'text-indigo-500', border: 'border-indigo-500', bg: 'bg-indigo-50 dark:bg-indigo-900/20', badge: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300' },
  pharmacology: { emoji: '💊', color: 'text-red-500', border: 'border-red-500', bg: 'bg-red-50 dark:bg-red-900/20', badge: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  pharmacognosy: { emoji: '🌿', color: 'text-emerald-500', border: 'border-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-900/20', badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
  organic_chemistry: { emoji: '⚗️', color: 'text-blue-500', border: 'border-blue-500', bg: 'bg-blue-50 dark:bg-blue-900/20', badge: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
  biochemistry: { emoji: '🧬', color: 'text-purple-500', border: 'border-purple-500', bg: 'bg-purple-50 dark:bg-purple-900/20', badge: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' },
  cosmetics: { emoji: '💄', color: 'text-pink-500', border: 'border-pink-500', bg: 'bg-pink-50 dark:bg-pink-900/20', badge: 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300' },
};

const uiFor = (slug: string): SubjectAccent => CATEGORY_UI[slug] || subjectAccent(slug);

interface RecordsScreenProps {
  user: UserProfile | null;
  lang: Language;
  searchQuery: string;
}

export default function RecordsScreen({ user, lang, searchQuery }: RecordsScreenProps) {
  const t = TRANSLATIONS[lang];
  const isRtl = lang === 'ar';

  const [records, setRecords] = useState<RecordItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // A subject SLUG, not a legacy Category: on stages 2/4/5 these are real
  // curriculum slugs, and only pre-migration stage-3 content still uses one of
  // the five hardcoded values.
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedType, setSelectedType] = useState<LectureType | 'all'>('all');
  const [showUpload, setShowUpload] = useState(false);
  const [recordToEdit, setRecordToEdit] = useState<RecordItem | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [localSearch, setLocalSearch] = useState('');

  const { effectiveStageId, activeCourseId } = useStageContext();
  const { subjects } = useStageSubjects();

  // A subject tab means nothing once the course or the stage changes under it -
  // the slug it holds may not exist in the new list at all, which would show an
  // empty screen with no tab highlighted.
  useEffect(() => {
    setSelectedCategory('all');
    setSelectedType('all');
  }, [activeCourseId, effectiveStageId]);

  useEffect(() => {
    // Without a stage there is no safe query to run - an unfiltered read would
    // return every stage's recordings.
    if (!effectiveStageId) {
      setRecords([]);
      setIsLoading(false);
      return;
    }

    const q = query(collection(db, 'records'), where('stageId', '==', effectiveStageId), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data({ serverTimestamps: 'estimate' }) } as RecordItem));
      setRecords(docs);
      setIsLoading(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'records');
      setIsLoading(false);
    });

    return () => unsubscribe();
  }, [effectiveStageId]);

  // Only split by course once this stage actually has course-tagged records;
  // otherwise every record would hide behind a tab the user never set.
  const stageHasCourses = records.some(r => !!r.courseId);

  // Course-filtered but NOT subject-filtered: the subject tabs are built from
  // this, so a tab exists for every subject actually present.
  const courseRecords = records.filter(
    record => !stageHasCourses || (record.courseId || DEFAULT_COURSE_ID) === activeCourseId,
  );

  let baseRecords = courseRecords.filter(record => {
    // Per RECORD, never per screen. `migrateToStages.js` backfilled `subjectId`
    // only `.where('stageId','==','stage_3')`, so records uploaded to stages
    // 1/2/4/5 before the seed still carry `category` and no `subjectId`. A
    // screen-level "does this stage have a curriculum" switch would make
    // exactly those vanish; subjectSlugOf falls back on the document itself.
    const matchesCategory = selectedCategory === 'all' || subjectSlugOf(record) === selectedCategory;
    const matchesType = selectedType === 'all' || record.type === selectedType;
    return matchesCategory && matchesType;
  });

  /**
   * One tab per subject: this stage's curriculum for the active course, UNIONED
   * with every subject actually present in the loaded recordings.
   *
   * The union is what stops a recording becoming unreachable. Its subject may
   * have been hidden by a representative (`useStageSubjects` drops
   * `isActive: false`), may sit in the other course, or may be one of the five
   * legacy categories no curriculum lists. `StudentGradesScreen` takes the same
   * stance for its stage tabs, and for the same reason.
   */
  const subjectTabs: { slug: string; label: string }[] = (() => {
    const tabs: { slug: string; label: string }[] = [];
    const seen = new Set<string>();
    const push = (slug: string, label: string) => {
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
      tabs.push({ slug, label: label || slug });
    };
    subjects
      .filter(s => !stageHasCourses || (s.courseId || DEFAULT_COURSE_ID) === activeCourseId)
      .forEach(s => push(s.id, isRtl ? s.nameAr : s.nameEn));
    courseRecords.forEach(r => push(subjectSlugOf(r), resolveSubjectLabel(r, subjects, lang)));
    return tabs;
  })();

  const activeSearch = localSearch.trim() || searchQuery.trim();

  if (activeSearch) {
    const fuse = new Fuse(baseRecords, {
      keys: ['title', 'description'],
      threshold: 0.4,
      ignoreLocation: true,
    });
    baseRecords = fuse.search(activeSearch).map(result => result.item);
  }

  const filteredRecords = baseRecords.sort((a, b) => {
    const numA = a.number || 0;
    const numB = b.number || 0;
    return numA - numB;
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-8 h-8 text-sky-600 dark:text-sky-400 animate-spin" />
      </div>
    );
  }

  const isAdmin = canManage(user, 'manageRecords');

  const handleDeleteRecord = async (id: string) => {
    try {
      const { deleteDoc, doc } = await import('firebase/firestore');
      await deleteDoc(doc(db, 'records', id));
      setDeletingId(null);
    } catch (err) {
      console.error('Error deleting record:', err);
    }
  };

  // The subject's own declared types, then the legacy table, then whatever the
  // loaded recordings actually are - a hidden subject is in neither list, and
  // hiding the practical toggle on a subject that has practical recordings
  // would make them unreachable.
  const currentCatTypes: LectureType[] = selectedCategory === 'all'
    ? ['theoretical', 'practical']
    : findSubject(subjects, selectedCategory)?.types
      || CATEGORIES.find(c => c.value === selectedCategory)?.types
      || Array.from(new Set(courseRecords.filter(r => subjectSlugOf(r) === selectedCategory).map(r => r.type)));

  const uic = selectedCategory === 'all' ? CATEGORY_UI.all : uiFor(selectedCategory);
  const selectedLabel = selectedCategory === 'all'
    ? t.allSubjects
    : subjectTabs.find(s => s.slug === selectedCategory)?.label || selectedCategory;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-sky-100 dark:bg-sky-900/30 rounded-2xl text-sky-600 dark:text-sky-400">
            <Mic className="w-6 h-6" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-stone-100">{t.navRecords}</h1>
        </div>
        {isAdmin && (
          <button
            onClick={() => setShowUpload(true)}
            className="w-12 h-12 flex items-center justify-center bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors shadow-lg shadow-red-500/30 shrink-0"
            title={isRtl ? 'رفع تسجيل' : 'Upload Record'}
          >
            <Plus className="w-6 h-6" />
          </button>
        )}
      </div>

      {stageHasCourses && <CourseTabs lang={lang} className="mb-6" />}

      {/* Local Search Bar */}
      {!searchQuery.trim() && (
        <div className="relative mb-6">
          <Search className={`w-5 h-5 absolute top-1/2 -translate-y-1/2 text-slate-400 ${isRtl ? 'right-4' : 'left-4'}`} />
          <input
            type="text"
            placeholder={isRtl ? 'ابحث في التسجيلات...' : 'Search recordings...'}
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            className={`w-full bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-xl py-3 ${isRtl ? 'pr-12 pl-4' : 'pl-12 pr-4'} focus:outline-none focus:border-sky-500 transition-colors font-medium dark:text-white`}
          />
        </div>
      )}

      {/* Horizontal Tabs */}
      <div className="flex overflow-x-auto gap-3 pb-4 mb-2 no-scrollbar" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
        <button
          onClick={() => { setSelectedCategory('all'); setSelectedType('all'); }}
          className={`flex-shrink-0 px-5 py-3 rounded-2xl font-bold flex items-center gap-2 border transition-all ${
            selectedCategory === 'all' 
              ? 'bg-indigo-50 border-indigo-500 text-indigo-700 dark:bg-indigo-900/30 dark:border-indigo-500 dark:text-indigo-300 shadow-sm'
              : 'bg-white border-slate-200 text-slate-600 dark:bg-zinc-800 dark:border-zinc-700 dark:text-slate-400 hover:border-slate-300'
          }`}
        >
          <span className="text-lg">📚</span>
          <span>{t.allSubjects}</span>
        </button>
        {subjectTabs.map(tab => {
          const tabUi = uiFor(tab.slug);
          return (
            <button
              key={tab.slug}
              onClick={() => { setSelectedCategory(tab.slug); setSelectedType('all'); }}
              className={`flex-shrink-0 px-5 py-3 rounded-2xl font-bold flex items-center gap-2 border transition-all ${
                selectedCategory === tab.slug
                  ? `${tabUi.bg} ${tabUi.border} ${tabUi.color} shadow-sm`
                  : 'bg-white border-slate-200 text-slate-600 dark:bg-zinc-800 dark:border-zinc-700 dark:text-slate-400 hover:border-slate-300'
              }`}
            >
              <span className="text-lg">{tabUi.emoji}</span>
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        {/* Subject Info Card */}
        <div className={`flex-1 p-4 rounded-2xl flex items-center gap-4 ${uic.bg}`}>
          <div className="text-4xl">{uic.emoji}</div>
          <div>
            <h2 className={`font-bold text-lg leading-tight ${uic.color}`}>
               {selectedLabel}
            </h2>
            <p className="text-sm font-medium opacity-80 mt-1" style={{ color: 'inherit' }}>
               {filteredRecords.length} {isRtl ? 'تسجيلات' : 'Recordings'}
            </p>
          </div>
        </div>

        {/* Filters */}
        {currentCatTypes.includes('practical') && (
          <div className="flex bg-white dark:bg-zinc-800 p-1.5 rounded-2xl border border-slate-200 dark:border-zinc-700 h-fit self-center min-w-max">
            <button
              onClick={() => setSelectedType('all')}
              className={`px-6 py-2 rounded-xl text-sm font-bold transition-all ${
                selectedType === 'all'
                  ? 'bg-slate-100 dark:bg-zinc-700 text-slate-900 dark:text-stone-100 shadow-sm'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
              }`}
            >
              {isRtl ? 'الكل' : 'All'}
            </button>
            <button
              onClick={() => setSelectedType('theoretical')}
              className={`px-6 py-2 rounded-xl text-sm font-bold transition-all ${
                selectedType === 'theoretical'
                  ? 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 shadow-sm'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
              }`}
            >
              {t.theoretical}
            </button>
            <button
              onClick={() => setSelectedType('practical')}
              className={`px-6 py-2 rounded-xl text-sm font-bold transition-all ${
                selectedType === 'practical'
                  ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 shadow-sm'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
              }`}
            >
              {t.practical}
            </button>
          </div>
        )}
      </div>

      {filteredRecords.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
          <AnimatePresence mode="popLayout">
            {filteredRecords.map((record, index) => {
              const isNew = record.createdAt && (Date.now() - record.createdAt.toMillis()) < 7 * 24 * 60 * 60 * 1000;
              const recSlug = subjectSlugOf(record);
              const recUi = recSlug ? uiFor(recSlug) : CATEGORY_UI.all;
              const recLabel = resolveSubjectLabel(record, subjects, lang);

              return (
              <motion.div
                layout
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.3, delay: index * 0.05, ease: [0.25, 0.1, 0.25, 1] }} 
                key={record.id}
                className="bg-white dark:bg-zinc-800 rounded-3xl p-5 border border-slate-200 dark:border-zinc-700 shadow-sm flex flex-col relative hover:shadow-xl hover:-translate-y-1 transition-all duration-300"
              >
              {isNew && (
                 <span className="bg-red-500 text-white text-[10px] font-black px-2 py-0.5 rounded-full absolute -top-2 start-4 rotate-[-10deg] shadow-sm z-10">
                   {isRtl ? 'جديد!' : 'NEW!'}
                 </span>
              )}

              <div className="flex justify-between items-start mb-4">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    {recLabel && (
                      <span className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider ${recUi.badge} flex items-center justify-center gap-1`}>
                        <span>{recUi.emoji}</span>
                        <span>{recLabel}</span>
                      </span>
                    )}
                    <span className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider ${
                      record.type === 'theoretical' 
                        ? 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300'
                        : 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                    }`}>
                      {record.type === 'theoretical' ? t.theoretical : t.practical}
                    </span>
                  </div>
                  <h3 className="text-lg font-bold text-slate-900 dark:text-stone-100 line-clamp-2 leading-tight">
                    {record.number ? `Lec ${record.number}: ` : ''}{record.title}
                  </h3>
                </div>
                {isAdmin && (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => {
                        setRecordToEdit(record);
                        setShowUpload(true);
                      }}
                      className="p-2 text-slate-400 hover:text-sky-600 dark:hover:text-sky-400 hover:bg-sky-50 dark:hover:bg-sky-900/30 rounded-full transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                      </svg>
                    </button>
                    {deletingId === record.id ? (
                      <div className="flex items-center gap-2 bg-white dark:bg-zinc-800 p-1 rounded-lg shadow-sm border border-slate-200 dark:border-zinc-700">
                        <button
                          onClick={() => handleDeleteRecord(record.id)}
                          className="px-2 py-1 text-xs font-bold bg-red-100 text-red-600 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 rounded-md transition-colors"
                        >
                          {isRtl ? 'تأكيد' : 'Confirm'}
                        </button>
                        <button
                          onClick={() => setDeletingId(null)}
                          className="px-2 py-1 text-xs font-bold bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-zinc-700 dark:text-slate-300 rounded-md transition-colors"
                        >
                          {isRtl ? 'إلغاء' : 'Cancel'}
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeletingId(record.id)}
                        className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-full transition-colors"
                      >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    )}
                  </div>
                )}
              </div>

              {record.description && (
                <p className="text-sm text-slate-500 dark:text-slate-400 mb-4 line-clamp-2 flex-grow">
                  {record.description}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2 mb-4 text-[10px] sm:text-xs text-slate-400 dark:text-slate-500">
                <div className="flex items-center gap-1 bg-slate-100 dark:bg-zinc-800/50 px-2 py-1 rounded-md">
                   <Clock className="w-3.5 h-3.5" />
                   <span>{record.createdAt?.toDate ? record.createdAt.toDate().toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-US') : t.recently}</span>
                </div>
                {record.uploaderName && (
                  <div className="flex items-center gap-1 bg-emerald-50 dark:bg-emerald-900/10 px-2 py-1 rounded-md text-emerald-600 dark:text-emerald-400 font-medium border border-emerald-100 dark:border-emerald-900/30">
                    <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                    <span>{isRtl ? ` ${record.uploaderName}` : ` ${record.uploaderName}`}</span>
                  </div>
                )}
              </div>

              {record.size && (
                <div className="flex items-center gap-1 text-xs text-slate-400 dark:text-slate-500 mb-4 font-medium">
                  <HardDrive className="w-3.5 h-3.5" />
                  <span>{record.size} MB</span>
                </div>
              )}

              <div className="mt-auto pt-4 border-t border-slate-100 dark:border-zinc-700">
                <div className="flex flex-col gap-3">
                  <AudioPlayer id={record.id} src={record.audioUrl} title={record.title} />
                </div>
              </div>
            </motion.div>
            );
          })}
          </AnimatePresence>
        </div>
      ) : (
        <div className="text-center py-20 px-4">
          <div className="w-20 h-20 bg-slate-100 dark:bg-zinc-800 rounded-full flex items-center justify-center mx-auto mb-6">
            <Search className="w-10 h-10 text-slate-400 dark:text-slate-500" />
          </div>
          <h3 className="text-xl font-bold text-slate-900 dark:text-stone-100 mb-2">
            {isRtl ? 'لا توجد تسجيلات' : 'No records found'}
          </h3>
          <p className="text-slate-500 dark:text-slate-400 max-w-md mx-auto">
            {isRtl ? 'لم نتمكن من العثور على أي تسجيلات تطابق الفلاتر الحالية.' : 'We couldn\'t find any records matching your current filters.'}
          </p>
        </div>
      )}

      <AdminRecordUpload
        isOpen={showUpload}
        onClose={() => {
          setShowUpload(false);
          setRecordToEdit(null);
        }}
        lang={lang}
        recordToEdit={recordToEdit}
        user={user}
      />
    </div>
  );
}
