import React, { useState, useEffect } from 'react';
import { Lecture, Category, CATEGORIES, Language, TRANSLATIONS, LectureType, UserProfile, LectureTab } from '../types';
import LectureCard from './LectureCard';
import SpotlightTooltip from './SpotlightTooltip';
import ManageLectureTabsModal from './ManageLectureTabsModal';
import { db } from '../lib/firebase';
import { collection, query, getDocs, where } from 'firebase/firestore';
import { motion, AnimatePresence } from 'motion/react';
import { useStageContext } from '../contexts/StageContext';
import CourseTabs from './CourseTabs';
import { COURSE_IDS, DEFAULT_COURSE_ID } from '../types';
import { BookOpen, ChevronRight, ChevronLeft, ArrowLeft, ArrowRight, Loader2, SearchX, List, LayoutGrid, Grid, Settings, CheckSquare, Archive, Download, X, Share2 } from 'lucide-react';
import { canManageGroups } from '../lib/permissions';
import { isNativePlatform, downloadAndPublishLecture } from '../lib/nativePdfRepository';
import { safeFileName } from '../lib/shareFileName';
import { forceDownload } from '../lib/utils';
import { shareMultipleFiles, type ShareFileInput } from '../lib/shareFile';
import { useStageSubjects } from '../hooks/useStageSubjects';

interface SubjectBrowserProps {
  lectures: Lecture[];
  lang: Language;
  user: UserProfile | null;
  onEdit?: (lecture: Lecture) => void;
  onOpenMCQ?: (lecture: Lecture) => void;
  onOpenReader?: (lecture: Lecture) => void;
  searchQuery?: string;
  isLoading?: boolean;
  onRemoveDownload?: (lecture: Lecture) => void;
  onShowPaywall?: () => void;
  lectureLoadState?: 'loading' | 'ready' | 'error' | 'waiting-auth' | 'missing-stage';
  onRetryLectures?: () => void;
}

function LectureLoadFailure({ isRtl, onRetry }: { isRtl: boolean; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center px-4 bg-white dark:bg-zinc-800 rounded-3xl border border-amber-200 dark:border-amber-900/60 border-dashed">
      <div className="w-16 h-16 bg-amber-50 dark:bg-amber-900/30 rounded-full flex items-center justify-center mb-4">
        <BookOpen className="w-8 h-8 text-amber-600 dark:text-amber-400" />
      </div>
      <h3 className="text-lg font-bold text-slate-900 dark:text-stone-100 mb-1">
        {isRtl ? 'تعذّر تحديث المحاضرات الآن' : 'Lectures could not be refreshed'}
      </h3>
      <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md">
        {isRtl ? 'تحقق من الاتصال ثم أعد المحاولة. ستبقى الملفات التي نزّلتها متاحة.' : 'Check your connection and try again. Your downloaded files remain available.'}
      </p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-4 px-4 py-2 bg-sky-500 hover:bg-sky-600 text-white rounded-xl text-sm font-bold transition-colors">
          {isRtl ? 'إعادة المحاولة' : 'Retry'}
        </button>
      )}
    </div>
  );
}

export default function SubjectBrowser({ lectures, lang, user, onEdit, onOpenMCQ, onOpenReader, searchQuery = '', isLoading = false, onRemoveDownload, onShowPaywall, lectureLoadState = 'ready', onRetryLectures }: SubjectBrowserProps) {
  const t = TRANSLATIONS[lang];
  const isRtl = lang === 'ar';
  
  const [selectedCategory, setSelectedCategory] = useState<Category | 'all'>('all');
  const [selectedType, setSelectedType] = useState<LectureType>('theoretical');
  const [selectedTabId, setSelectedTabId] = useState<string | 'all'>('all');
  const [customTabs, setCustomTabs] = useState<LectureTab[]>([]);
  const [showTabsModal, setShowTabsModal] = useState(false);
  const [gridColumns, setGridColumns] = useState<1 | 2 | 3>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('gridColumns');
      if (saved === '1' || saved === '2' || saved === '3') {
        return parseInt(saved) as 1 | 2 | 3;
      }
    }
    return 1;
  });

  // Batch selection mode state
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isProcessingBatch, setIsProcessingBatch] = useState(false);
  const [batchActionStatus, setBatchActionStatus] = useState<string | null>(null);

  const handleToggleSelect = (lecture: Lecture) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(lecture.id)) next.delete(lecture.id);
      else next.add(lecture.id);
      return next;
    });
  };

  const handleToggleSelectAll = (visibleLectures: Lecture[]) => {
    if (selectedIds.size === visibleLectures.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(visibleLectures.map(l => l.id)));
    }
  };

  const handleBatchDownload = async (selectedLectures: Lecture[]) => {
    if (selectedLectures.length === 0 || isProcessingBatch) return;
    setIsProcessingBatch(true);
    const native = await isNativePlatform();
    let completed = 0;
    let successful = 0;
    const failed: string[] = [];
    const total = selectedLectures.length;

    for (const lec of selectedLectures) {
      completed++;
      setBatchActionStatus(
        isRtl
          ? `جارٍ تنزيل ${completed} من ${total}: ${lec.title}`
          : `Downloading ${completed} of ${total}: ${lec.title}`
      );

      try {
        if (native) {
          const result = await downloadAndPublishLecture({
            id: lec.id,
            title: lec.title,
            pdfUrl: lec.pdfUrl,
            subjectId: lec.subjectId,
            stageId: lec.stageId,
            number: lec.number,
            type: lec.type,
          });
          if (!result.success) throw new Error(result.error || 'Native download failed');
        } else {
          const res = await fetch(lec.pdfUrl);
          if (!res.ok) throw new Error(`Download failed (${res.status})`);
          {
            const blob = await res.blob();
            const { dbPut, STORE_BLOBS, saveOfflineLecture } = await import('../lib/localDb');
            await dbPut(STORE_BLOBS, { url: lec.pdfUrl, blob, savedAt: Date.now() });
            await saveOfflineLecture({
              id: lec.id,
              title: lec.title,
              pdfUrl: lec.pdfUrl,
              subjectId: lec.subjectId,
              stageId: lec.stageId,
              number: lec.number,
              type: lec.type,
              savedAt: Date.now(),
            });
          }
        }
        successful++;
      } catch (err) {
        console.warn('Batch download item failed:', lec.id, err);
        failed.push(lec.title);
      }
    }

    setBatchActionStatus(isRtl ? 'اكتمل التنزيل بنجاح!' : 'Batch download complete!');
    setBatchActionStatus(
      failed.length === 0
        ? `Downloaded ${successful} file${successful === 1 ? '' : 's'}.`
        : `Downloaded ${successful} of ${total}. Failed: ${failed.join(', ')}`,
    );
    setTimeout(() => {
      setBatchActionStatus(null);
      setIsProcessingBatch(false);
      setIsSelectionMode(false);
      setSelectedIds(new Set());
    }, 1500);
  };

  const handleBatchShareFiles = async (selectedLectures: Lecture[]) => {
    if (selectedLectures.length === 0 || isProcessingBatch) return;
    setIsProcessingBatch(true);
    setBatchActionStatus(isRtl ? 'جارٍ تجهيز الملفات للمشاركة...' : 'Preparing files to share...');

    try {
      const shareInputs: ShareFileInput[] = [];

      for (let i = 0; i < selectedLectures.length; i++) {
        const lec = selectedLectures[i];
        setBatchActionStatus(
          isRtl
            ? `جارٍ تجهيز ${i + 1} من ${selectedLectures.length}: ${lec.title}`
            : `Preparing ${i + 1} of ${selectedLectures.length}: ${lec.title}`
        );

        const safeTitle = lec.number ? `${lec.title} - ${lec.number}` : lec.title;
        shareInputs.push({
          url: lec.pdfUrl,
          name: safeTitle,
          extension: 'pdf',
          mimeType: 'application/pdf',
          title: lec.title,
          lectureId: lec.id,
        });
      }

      if (shareInputs.length === 0) {
        throw new Error('No files could be gathered for share');
      }

      setBatchActionStatus(isRtl ? 'جارٍ فتح نافذة المشاركة...' : 'Opening share sheet...');
      const batchTitle = isRtl ? 'محاضرات محددة' : 'Selected Lectures';
      const result = await shareMultipleFiles(shareInputs, batchTitle, (curr, total, name) => {
        setBatchActionStatus(
          isRtl ? `جارٍ تجهيز ${curr} من ${total}: ${name}` : `Preparing ${curr} of ${total}: ${name}`
        );
      });

      if (result === 'shared' || result === 'downloaded') {
        setBatchActionStatus(isRtl ? 'تمت المشاركة بنجاح!' : 'Shared successfully!');
      }
    } catch (err: any) {
      console.error('Batch share files failed:', err);
      alert(isRtl ? 'تعذّرت مشاركة الملفات' : 'Failed to share files');
    } finally {
      setTimeout(() => {
        setBatchActionStatus(null);
        setIsProcessingBatch(false);
      }, 1500);
    }
  };

  const { effectiveStageId, activeCourseId } = useStageContext();
  const { subjects, isLoading: isSubjectsLoading } = useStageSubjects();

  useEffect(() => {
    localStorage.setItem('gridColumns', gridColumns.toString());
  }, [gridColumns]);

  const fetchCustomTabs = async () => {
    try {
      const q = query(collection(db, 'app_settings', 'lectureTabs', 'tabs'));
      const snap = await getDocs(q);
      const loaded: LectureTab[] = [];
      snap.forEach(d => {
        const tab = { id: d.id, ...d.data() } as LectureTab;
        // Only this stage's tabs. Tabs predating the per-stage split have no
        // stageId and stay visible everywhere - see ManageLectureTabsModal.
        if (!tab.stageId || tab.stageId === effectiveStageId) loaded.push(tab);
      });
      setCustomTabs(loaded);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    if (!showTabsModal) {
      fetchCustomTabs();
    }
  }, [showTabsModal]);

  // If searching, show all matching lectures regardless of category
  if (searchQuery.trim()) {
    if (isLoading) {
      return (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <Loader2 className="w-8 h-8 text-sky-600 dark:text-sky-400 animate-spin" />
          <p className="text-slate-500 dark:text-slate-400 font-medium">{t.loading}</p>
        </div>
      );
    }

    if (lectures.length === 0 && lectureLoadState !== 'error' && lectureLoadState !== 'waiting-auth') {
      return (
        <div className="flex flex-col items-center justify-center py-20 text-center px-4">
          <div className="w-20 h-20 bg-slate-100 dark:bg-zinc-800 rounded-full flex items-center justify-center mb-6">
            <SearchX className="w-10 h-10 text-slate-400 dark:text-slate-500" />
          </div>
          <h3 className="text-xl font-bold text-slate-900 dark:text-stone-100 mb-2">{t.noLectures}</h3>
          <p className="text-slate-500 dark:text-slate-400 max-w-md">{t.noLecturesDesc}</p>
        </div>
      );
    }

    if (lectures.length === 0) {
      return <LectureLoadFailure isRtl={isRtl} onRetry={onRetryLectures} />;
    }

    return (
      <div>
        <div className="flex items-center justify-between mb-4 px-4 sm:px-0">
          <div className="text-sm font-medium text-slate-500 dark:text-slate-400">
            {lectures.length} {t.navLectures}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setIsSelectionMode(prev => !prev);
                if (isSelectionMode) setSelectedIds(new Set());
              }}
              className={`p-1.5 px-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                isSelectionMode
                  ? 'bg-sky-500 text-white shadow-sm'
                  : 'bg-slate-100 dark:bg-zinc-800/50 text-slate-600 dark:text-zinc-300 hover:bg-slate-200 dark:hover:bg-zinc-700'
              }`}
              title={isSelectionMode ? (isRtl ? 'إلغاء التحديد' : 'Done') : (isRtl ? 'تحديد متعدد' : 'Select')}
            >
              <CheckSquare className="w-3.5 h-3.5" />
              <span>{isSelectionMode ? (isRtl ? 'تم' : 'Done') : (isRtl ? 'تحديد' : 'Select')}</span>
            </button>
            <div className="flex items-center gap-1 bg-slate-100 dark:bg-zinc-800/50 p-1 rounded-xl">
              <button
                onClick={() => setGridColumns(1)}
                className={`p-1.5 rounded-lg transition-colors ${gridColumns === 1 ? 'bg-white dark:bg-zinc-700 shadow-sm text-sky-600 dark:text-sky-400' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}`}
                title="1 Column"
              >
                <List className="w-4 h-4" />
              </button>
              <button
                onClick={() => setGridColumns(2)}
                className={`p-1.5 rounded-lg transition-colors ${gridColumns === 2 ? 'bg-white dark:bg-zinc-700 shadow-sm text-sky-600 dark:text-sky-400' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}`}
                title="2 Columns"
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
              <button
                onClick={() => setGridColumns(3)}
                className={`p-1.5 rounded-lg transition-colors ${gridColumns === 3 ? 'bg-white dark:bg-zinc-700 shadow-sm text-sky-600 dark:text-sky-400' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}`}
                title="3 Columns"
              >
                <Grid className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
        <div className={`grid gap-2 sm:gap-4 md:gap-6 px-2 sm:px-0 ${
          gridColumns === 1 ? 'grid-cols-1' : 
          gridColumns === 2 ? 'grid-cols-2' : 
          'grid-cols-3'
        }`}>
          {lectures.map(lecture => (
            <LectureCard
              key={lecture.id}
              lecture={lecture}
              lang={lang}
              user={user}
              onEdit={onEdit}
              onOpenMCQ={onOpenMCQ}
              onOpenReader={onOpenReader}
              onRemoveDownload={onRemoveDownload}
              onShowPaywall={onShowPaywall}
              isSelectionMode={isSelectionMode}
              isSelected={selectedIds.has(lecture.id)}
              onToggleSelect={handleToggleSelect}
            />
          ))}
        </div>
      </div>
    );
  }

  // One matcher for both call sites. subjectId is authoritative; the category
  // clauses are the legacy fallback for content that predates the migration.
  const lecturesForSubject = (subj: any) => lectures.filter(l =>
    l.subjectId === subj?.id ||
    l.category === subj?.id ||
    l.category === subj?.nameEn?.toLowerCase() ||
    l.category === subj?.nameEn?.toLowerCase().replace(' ', '_')
  );

  const courseSubjects = subjects.filter(sub => (sub.courseId || DEFAULT_COURSE_ID) === activeCourseId);
  const courseCounts = COURSE_IDS.reduce((acc, id) => {
    acc[id] = subjects.filter(sub => (sub.courseId || DEFAULT_COURSE_ID) === id).length;
    return acc;
  }, {} as Record<string, number>);

  if (selectedCategory === 'all') {
    const categoryColors: Record<string, { bg: string, text: string, progress: string }> = {
      'pharmacology': { bg: 'bg-indigo-50 dark:bg-indigo-900/30', text: 'text-indigo-600 dark:text-indigo-400', progress: 'bg-indigo-500' },
      'pharmacognosy': { bg: 'bg-emerald-50 dark:bg-emerald-900/30', text: 'text-emerald-600 dark:text-emerald-400', progress: 'bg-emerald-500' },
      'organic_chemistry': { bg: 'bg-rose-50 dark:bg-rose-900/30', text: 'text-rose-600 dark:text-rose-400', progress: 'bg-rose-500' },
      'biochemistry': { bg: 'bg-amber-50 dark:bg-amber-900/30', text: 'text-amber-600 dark:text-amber-400', progress: 'bg-amber-500' },
      'cosmetics': { bg: 'bg-fuchsia-50 dark:bg-fuchsia-900/30', text: 'text-fuchsia-600 dark:text-fuchsia-400', progress: 'bg-fuchsia-500' }
    };
    
    return (
      <div className="flex flex-col gap-4">
        {!isSubjectsLoading && subjects.length > 0 && (
          <CourseTabs lang={lang} counts={courseCounts} />
        )}
        {isSubjectsLoading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <Loader2 className="w-8 h-8 text-sky-600 dark:text-sky-400 animate-spin" />
          </div>
        ) : subjects.length > 0 ? (
          courseSubjects.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <SearchX className="w-10 h-10 text-slate-300 dark:text-zinc-600" />
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {isRtl ? 'لا توجد مواد في هذا الكورس بعد' : 'No subjects in this course yet'}
              </p>
            </div>
          ) :
          courseSubjects.map((subj, index) => {
            const catId = subj.id;
            const categoryLectures = lecturesForSubject(subj);
            const count = categoryLectures.length;
          const studiedCount = categoryLectures.filter(l => user?.studied?.includes(l.id)).length;
          const progress = count > 0 ? Math.round((studiedCount / count) * 100) : 0;
          
          // Deterministic color assignment based on index
          const defaultColors = [
            { bg: 'bg-[#2196F3]/10', text: 'text-[#2196F3]', progress: 'bg-[#2196F3]' },
            { bg: 'bg-emerald-50 dark:bg-emerald-900/30', text: 'text-emerald-600 dark:text-emerald-400', progress: 'bg-emerald-500' },
            { bg: 'bg-indigo-50 dark:bg-indigo-900/30', text: 'text-indigo-600 dark:text-indigo-400', progress: 'bg-indigo-500' },
            { bg: 'bg-rose-50 dark:bg-rose-900/30', text: 'text-rose-600 dark:text-rose-400', progress: 'bg-rose-500' },
            { bg: 'bg-amber-50 dark:bg-amber-900/30', text: 'text-amber-600 dark:text-amber-400', progress: 'bg-amber-500' },
            { bg: 'bg-fuchsia-50 dark:bg-fuchsia-900/30', text: 'text-fuchsia-600 dark:text-fuchsia-400', progress: 'bg-fuchsia-500' }
          ];
          const colors = categoryColors[catId] || categoryColors[subj.nameEn?.toLowerCase()] || defaultColors[index % defaultColors.length];
          
          return (
            <button
              key={catId}
              onClick={() => {
                setSelectedCategory(catId as any);
                setSelectedType('theoretical');
              }}
              className={`flex flex-col p-5 bg-white dark:bg-zinc-800 rounded-[16px] shadow-[0_2px_12px_rgba(0,0,0,0.06)] hover:shadow-md transition-all group overflow-hidden relative ${isRtl ? 'border-r-4' : 'border-l-4'} border-${colors.progress.replace('bg-', '')}`}
            >
              <div className="flex items-center justify-between w-full mb-6">
                <div className="flex items-center gap-4">
                  <div className={`p-3 rounded-xl ${colors.bg} ${colors.text} group-hover:scale-110 transition-transform`}>
                    <BookOpen className="w-6 h-6" />
                  </div>
                  <div className="text-start">
                    <h3 className="text-lg font-bold text-slate-900 dark:text-stone-100 mb-1">{isRtl ? subj.nameAr : subj.nameEn}</h3>
                    <div className="inline-flex items-center justify-center bg-sky-100 dark:bg-sky-900/40 text-[#2196F3] dark:text-sky-400 text-xs font-bold px-3 py-1 rounded-full">
                      {count} {t.navLectures}
                    </div>
                  </div>
                </div>
                <div className="text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-300 transition-colors bg-slate-50 dark:bg-zinc-900 p-2 rounded-full">
                  {isRtl ? <ChevronLeft className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                </div>
              </div>
              
              <div className="w-full flex items-center justify-between gap-3 text-sm mb-1 text-slate-500 dark:text-slate-400">
                <span className="font-bold text-slate-700 dark:text-slate-300">{progress}%</span>
              </div>
              <div className="w-full h-2 bg-slate-100 dark:bg-zinc-700 rounded-full overflow-hidden" id={index === 0 ? "subject-progress-0" : undefined}>
                <div 
                  className={`h-full ${colors.progress} rounded-full transition-all duration-500 ease-out`}
                  style={{ width: `${progress}%` }}
                />
              </div>
            </button>
          );
        })
        ) : (
          CATEGORIES.map((cat, index) => {
            const categoryLectures = lectures.filter(l => l.category === cat.value);
            const count = categoryLectures.length;
            const studiedCount = categoryLectures.filter(l => user?.studied?.includes(l.id)).length;
            const progress = count > 0 ? Math.round((studiedCount / count) * 100) : 0;
            const colors = categoryColors[cat.value] || { bg: 'bg-[#2196F3]/10', text: 'text-[#2196F3]', progress: 'bg-[#2196F3]', border: 'border-[#2196F3]' };
            
            return (
              <button
                key={cat.value}
                onClick={() => {
                  setSelectedCategory(cat.value);
                  setSelectedType('theoretical');
                }}
                className={`flex flex-col p-5 bg-white dark:bg-zinc-800 rounded-[16px] shadow-[0_2px_12px_rgba(0,0,0,0.06)] hover:shadow-md transition-all group overflow-hidden relative ${isRtl ? 'border-r-4' : 'border-l-4'} ${categoryColors[cat.value] ? 'border-' + categoryColors[cat.value].progress.replace('bg-', '') : 'border-[#2196F3]'}`}
              >
                <div className="flex items-center justify-between w-full mb-6">
                  <div className="flex items-center gap-4">
                    <div className={`p-3 rounded-xl ${colors.bg} ${colors.text} group-hover:scale-110 transition-transform`}>
                      <BookOpen className="w-6 h-6" />
                    </div>
                    <div className="text-start">
                      <h3 className="text-lg font-bold text-slate-900 dark:text-stone-100 mb-1">{t[cat.labelKey]}</h3>
                      <div className="inline-flex items-center justify-center bg-sky-100 dark:bg-sky-900/40 text-[#2196F3] dark:text-sky-400 text-xs font-bold px-3 py-1 rounded-full">
                        {count} {t.navLectures}
                      </div>
                    </div>
                  </div>
                  <div className="text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-300 transition-colors bg-slate-50 dark:bg-zinc-900 p-2 rounded-full">
                    {isRtl ? <ChevronLeft className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                  </div>
                </div>
                
                <div className="w-full flex items-center justify-between gap-3 text-sm mb-1 text-slate-500 dark:text-slate-400">
                  <span className="font-bold text-slate-700 dark:text-slate-300">{progress}%</span>
                </div>
                <div className="w-full h-2 bg-slate-100 dark:bg-zinc-700 rounded-full overflow-hidden" id={index === 0 ? "subject-progress-0" : undefined}>
                  <div 
                    className={`h-full ${colors.progress} rounded-full transition-all duration-500 ease-out`}
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </button>
            );
          })
        )}
        <SpotlightTooltip targetSelector="#subject-progress-0" text="يتتبع تقدمك في كل مادة" tooltipKey="lectures" />
      </div>
    );
  }

  const currentCategoryData = CATEGORIES.find(c => c.value === selectedCategory);
  const currentSubjectData = subjects.find(s => s.id === selectedCategory);
  
  const categoryLectures = lecturesForSubject(currentSubjectData || { id: selectedCategory });
  let filteredLectures = categoryLectures.filter(l => l.type === selectedType);

  if (selectedTabId !== 'all') {
    const tabObj = customTabs.find(t => t.id === selectedTabId);
    if (tabObj) {
      filteredLectures = filteredLectures.filter(l => tabObj.lectureIds.includes(l.id));
    }
  }

  // Sort by lecture number
  filteredLectures.sort((a, b) => (a.number || 0) - (b.number || 0));

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-4 mb-6">
        <button
          onClick={() => setSelectedCategory('all')}
          className="p-2 bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors"
        >
          {isRtl ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
        </button>
        <h2 className="text-2xl font-bold text-slate-900 dark:text-stone-100">
          {currentSubjectData ? (isRtl ? currentSubjectData.nameAr : currentSubjectData.nameEn) : (currentCategoryData ? t[currentCategoryData.labelKey] : '')}
        </h2>
      </div>

      <div className="flex gap-2 mb-4 bg-slate-100 dark:bg-zinc-800/50 p-1.5 rounded-2xl">
        <button
          onClick={() => setSelectedType('theoretical')}
          className={`flex-1 py-3 px-4 rounded-xl text-sm font-bold transition-all ${
            selectedType === 'theoretical'
              ? 'bg-white dark:bg-zinc-700 text-sky-600 dark:text-sky-400 shadow-sm'
              : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
          }`}
        >
          {t.theoretical}
        </button>
        <button
          onClick={() => setSelectedType('practical')}
          className={`flex-1 py-3 px-4 rounded-xl text-sm font-bold transition-all ${
            selectedType === 'practical'
              ? 'bg-white dark:bg-zinc-700 text-sky-600 dark:text-sky-400 shadow-sm'
              : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
          }`}
        >
          {t.practical}
        </button>
      </div>

      <div className="flex items-center gap-2 mb-6 overflow-x-auto pb-2 scrollbar-hide">
        <button
          onClick={() => setSelectedTabId('all')}
          className={`px-4 py-1.5 rounded-full text-sm font-bold whitespace-nowrap transition-colors ${
            selectedTabId === 'all'
              ? 'bg-sky-500 text-white shadow-sm'
              : 'bg-white border border-slate-200 dark:bg-zinc-800 dark:border-zinc-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-zinc-700'
          }`}
        >
          {isRtl ? 'الكل' : 'All'}
        </button>
        {customTabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setSelectedTabId(tab.id)}
            className={`px-4 py-1.5 rounded-full text-sm font-bold whitespace-nowrap transition-colors ${
              selectedTabId === tab.id
                ? 'bg-sky-500 text-white shadow-sm'
                : 'bg-white border border-slate-200 dark:bg-zinc-800 dark:border-zinc-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-zinc-700'
            }`}
          >
            {tab.name}
          </button>
        ))}
        {canManageGroups(user) && (
          <button
            onClick={() => setShowTabsModal(true)}
            className={`px-3 py-1.5 rounded-full text-sm font-bold whitespace-nowrap transition-colors flex items-center gap-1 ${isRtl ? 'mr-auto' : 'ml-auto'} bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-zinc-700`}
          >
            <Settings className="w-4 h-4" />
            {isRtl ? 'إدارة' : 'Manage'}
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <Loader2 className="w-8 h-8 text-sky-600 dark:text-sky-400 animate-spin" />
          <p className="text-slate-500 dark:text-slate-400 font-medium">{t.loading}</p>
        </div>
      ) : filteredLectures.length === 0 && (lectureLoadState === 'error' || lectureLoadState === 'waiting-auth') ? (
        <LectureLoadFailure isRtl={isRtl} onRetry={onRetryLectures} />
      ) : filteredLectures.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center px-4 bg-white dark:bg-zinc-800 rounded-3xl border border-slate-200 dark:border-zinc-700 border-dashed">
          <div className="w-16 h-16 bg-slate-50 dark:bg-zinc-900 rounded-full flex items-center justify-center mb-4">
            <BookOpen className="w-8 h-8 text-slate-400 dark:text-slate-500" />
          </div>
          <h3 className="text-lg font-bold text-slate-900 dark:text-stone-100 mb-1">{t.noLectures}</h3>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between mb-4">
            <div className="text-sm font-medium text-slate-500 dark:text-slate-400">
              {filteredLectures.length} {t.navLectures}
            </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setIsSelectionMode(prev => !prev);
                if (isSelectionMode) setSelectedIds(new Set());
              }}
              className={`p-1.5 px-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                isSelectionMode
                  ? 'bg-sky-500 text-white shadow-sm'
                  : 'bg-slate-100 dark:bg-zinc-800/50 text-slate-600 dark:text-zinc-300 hover:bg-slate-200 dark:hover:bg-zinc-700'
              }`}
              title={isSelectionMode ? (isRtl ? 'إلغاء التحديد' : 'Done') : (isRtl ? 'تحديد متعدد' : 'Select')}
            >
              <CheckSquare className="w-3.5 h-3.5" />
              <span>{isSelectionMode ? (isRtl ? 'تم' : 'Done') : (isRtl ? 'تحديد' : 'Select')}</span>
            </button>
            <div className="flex items-center gap-1 bg-slate-100 dark:bg-zinc-800/50 p-1 rounded-xl">
              <button
                onClick={() => setGridColumns(1)}
                className={`p-1.5 rounded-lg transition-colors ${gridColumns === 1 ? 'bg-white dark:bg-zinc-700 shadow-sm text-sky-600 dark:text-sky-400' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}`}
                title="1 Column"
              >
                <List className="w-4 h-4" />
              </button>
              <button
                onClick={() => setGridColumns(2)}
                className={`p-1.5 rounded-lg transition-colors ${gridColumns === 2 ? 'bg-white dark:bg-zinc-700 shadow-sm text-sky-600 dark:text-sky-400' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}`}
                title="2 Columns"
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
              <button
                onClick={() => setGridColumns(3)}
                className={`p-1.5 rounded-lg transition-colors ${gridColumns === 3 ? 'bg-white dark:bg-zinc-700 shadow-sm text-sky-600 dark:text-sky-400' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}`}
                title="3 Columns"
              >
                <Grid className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
        <div className={`grid gap-2 sm:gap-4 md:gap-6 px-2 sm:px-0 ${
          gridColumns === 1 ? 'grid-cols-1' : 
          gridColumns === 2 ? 'grid-cols-2' : 
          'grid-cols-3'
        }`}>
          <AnimatePresence mode="popLayout">
            {filteredLectures.map((lecture) => (
              <motion.div
                key={lecture.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }} 
              >
                <LectureCard
                  lecture={lecture}
                  lang={lang}
                  user={user}
                  onEdit={onEdit}
                  onOpenMCQ={onOpenMCQ}
                  onOpenReader={onOpenReader}
                  onRemoveDownload={onRemoveDownload}
                  onShowPaywall={onShowPaywall}
                  isSelectionMode={isSelectionMode}
                  isSelected={selectedIds.has(lecture.id)}
                  onToggleSelect={handleToggleSelect}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </>
    )}
      <ManageLectureTabsModal
        isOpen={showTabsModal}
        onClose={() => setShowTabsModal(false)}
        lang={lang}
        allLectures={lectures}
      />

      {/* Batch Actions Floating Bar */}
      <AnimatePresence>
        {isSelectionMode && (
          <motion.div
            initial={{ y: 60, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 60, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed bottom-24 inset-x-4 sm:inset-x-auto sm:right-8 sm:left-8 max-w-2xl mx-auto z-40 bg-white/95 dark:bg-zinc-800/95 backdrop-blur-md rounded-2xl p-3 sm:p-4 shadow-2xl border border-sky-200 dark:border-sky-500/30 flex flex-wrap items-center justify-between gap-2.5"
            dir={isRtl ? 'rtl' : 'ltr'}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs sm:text-sm font-bold text-slate-800 dark:text-zinc-200">
                {isRtl ? `تم تحديد ${selectedIds.size} محاضرة` : `${selectedIds.size} selected`}
              </span>
              <button
                type="button"
                onClick={() => {
                  const visible = searchQuery ? lectures : (filteredLectures || []);
                  handleToggleSelectAll(visible);
                }}
                className="text-xs text-sky-600 dark:text-sky-400 hover:underline font-semibold px-1.5 py-0.5 rounded cursor-pointer"
              >
                {selectedIds.size > 0 && selectedIds.size === (searchQuery ? lectures.length : (filteredLectures?.length ?? 0))
                  ? (isRtl ? 'إلغاء التحديد' : 'Deselect all')
                  : (isRtl ? 'تحديد الكل' : 'Select all')}
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleBatchDownload(lectures.filter(l => selectedIds.has(l.id)))}
                disabled={selectedIds.size === 0 || isProcessingBatch}
                className="flex items-center gap-1.5 px-3 py-2 bg-sky-500 hover:bg-sky-600 active:scale-95 text-white text-xs sm:text-sm font-bold rounded-xl transition-all shadow-md shadow-sky-500/20 disabled:opacity-50 cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>{isRtl ? 'تنزيل المحدد' : 'Download'}</span>
              </button>

              <button
                type="button"
                onClick={() => handleBatchShareFiles(lectures.filter(l => selectedIds.has(l.id)))}
                disabled={selectedIds.size === 0 || isProcessingBatch}
                className="flex items-center gap-1.5 px-3 py-2 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 active:scale-95 text-white text-xs sm:text-sm font-bold rounded-xl transition-all shadow-md shadow-indigo-500/20 disabled:opacity-50 cursor-pointer"
                title={isRtl ? 'مشاركة الملفات مباشرة للتطبيقات (NotebookLM والملاحظات)' : 'Share uncompressed files to NotebookLM and Notes apps'}
              >
                <Share2 className="w-4 h-4" />
                <span>{isRtl ? 'مشاركة الملفات' : 'Share Files'}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setIsSelectionMode(false);
                  setSelectedIds(new Set());
                }}
                className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200 rounded-lg cursor-pointer"
                title={isRtl ? 'إلغاء' : 'Cancel'}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Batch Processing Toast */}
      <AnimatePresence>
        {batchActionStatus && (
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 20, opacity: 0 }}
            className="fixed top-6 inset-x-4 sm:inset-x-auto sm:right-1/2 sm:translate-x-1/2 z-50 bg-slate-900/90 dark:bg-zinc-800/95 text-white text-xs sm:text-sm font-semibold px-4 py-2.5 rounded-2xl shadow-xl backdrop-blur-md flex items-center gap-2.5 border border-white/10"
            dir={isRtl ? 'rtl' : 'ltr'}
          >
            {isProcessingBatch && <Loader2 className="w-4 h-4 animate-spin text-sky-400" />}
            <span>{batchActionStatus}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
