import React, { useEffect, useState } from 'react';
import { FileText, Download, Clock, Tag, X, Trash2, Loader2, Edit2, CloudDownload, CheckCircle2, CloudOff, CheckCircle, Youtube, ClipboardList, BookOpen, Share2, ChevronRight } from 'lucide-react';
import { Lecture, CATEGORIES, Language, TRANSLATIONS, UserProfile } from '../types';
import { canManage } from '../lib/permissions';
import { motion, AnimatePresence } from 'motion/react';
import { doc, deleteDoc, setDoc, arrayUnion, arrayRemove } from 'firebase/firestore';
import { ref, deleteObject } from 'firebase/storage';
import { db, storage } from '../lib/firebase';
import { useOfflinePDF, readStoredPdf } from '../hooks/useOfflinePDF';
import { forceDownload, getYoutubeEmbedUrl } from '../lib/utils';
import { useMCQStatus } from '../hooks/useMCQStatus';
import { shareFile } from '../lib/shareFile';

interface LectureCardProps {
  lecture: Lecture;
  lang: Language;
  user: UserProfile | null;
  onEdit?: (lecture: Lecture) => void;
  onRemoveDownload?: (lecture: Lecture) => void;
  onOpenMCQ?: (lecture: Lecture) => void;
  onOpenReader?: (lecture: Lecture) => void;
  key?: string;
}

export default React.memo(function LectureCard({ lecture, lang, user, onEdit, onRemoveDownload, onOpenMCQ, onOpenReader }: LectureCardProps) {
  const t = TRANSLATIONS[lang];
  const isRtl = lang === 'ar';
  const [showPreview, setShowPreview] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [shareToast, setShareToast] = useState<string | null>(null);
  
  /**
   * Hand the lecture's actual PDF to the OS share sheet.
   *
   * This replaces a button that posted the lecture into the group chat. Bytes
   * come from the offline copy when the student has already downloaded it, so
   * the share works with no connection at all; otherwise they are fetched.
   */
  const handleShare = async () => {
    if (isSharing) return;
    setIsSharing(true);
    try {
      const stored = await readStoredPdf(lecture.pdfUrl).catch(() => null);
      const result = await shareFile({
        url: lecture.pdfUrl,
        // The number disambiguates the two dozen lectures a subject can carry;
        // a bare title arrives in WhatsApp as one of several identical files.
        name: lecture.number ? `${lecture.title} - ${lecture.number}` : lecture.title,
        extension: 'pdf',
        mimeType: 'application/pdf',
        title: lecture.title,
        bytes: stored,
      });
      // 'shared' needs no toast - the chooser was the feedback - and neither
      // does 'cancelled', which is the student changing their mind.
      if (result === 'downloaded') {
        setShareToast(isRtl ? 'تم تنزيل الملف' : 'File downloaded');
      } else if (result === 'failed') {
        setShareToast(isRtl ? 'تعذّرت المشاركة' : 'Could not share');
      }
    } finally {
      setIsSharing(false);
    }
  };

  // Self-clearing, keyed on the message: a second toast restarts the timer
  // instead of being cut short by the first one's pending timeout.
  useEffect(() => {
    if (!shareToast) return;
    const t = setTimeout(() => setShareToast(null), 1800);
    return () => clearTimeout(t);
  }, [shareToast]);

  const categoryData = CATEGORIES.find(c => c.value === lecture.category);
  // subjectName is denormalised at upload time so the badge reads correctly for
  // curriculum subjects, which have no legacy CATEGORIES entry to look up.
  const categoryLabel = lecture.subjectName
    || (categoryData ? t[categoryData.labelKey] : lecture.category)
    || '';
  const date = lecture.createdAt?.toDate ? lecture.createdAt.toDate().toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-US') : t.recently;

  const { isDownloaded, isDownloading, downloadProgress, offlineUrl, downloadPDF, removePDF } = useOfflinePDF(
    lecture.pdfUrl,
    lecture.id,
    // Snapshotted with the bytes so the Downloads tab can still list this
    // lecture when the Firestore listener returns nothing offline.
    {
      id: lecture.id,
      title: lecture.title,
      pdfUrl: lecture.pdfUrl,
      subjectId: lecture.subjectId ?? null,
      stageId: lecture.stageId ?? null,
      number: lecture.number ?? null,
      type: lecture.type ?? null,
    },
  );

  const isStudied = user?.studied?.includes(lecture.id) || false;
  const mcqStatusItem = useMCQStatus(lecture.id, user);

  const handleToggleStudied = async () => {
    if (!user) return;
    try {
      const userRef = doc(db, 'users', user.uid);
      if (isStudied) {
        await setDoc(userRef, { studied: arrayRemove(lecture.id) }, { merge: true });
      } else {
        await setDoc(userRef, { studied: arrayUnion(lecture.id) }, { merge: true });
      }
    } catch (error) {
      console.error('Error toggling studied:', error);
    }
  };

  const handleDelete = async () => {
    if (!canManage(user, 'manageLectures')) return;
    
    setIsDeleting(true);
    try {
      // 1. Delete from Firestore
      await deleteDoc(doc(db, 'lectures', lecture.id));
      
      // 2. Try to delete from Storage (don't fail if it doesn't exist)
      try {
        const fileRef = ref(storage, lecture.pdfUrl);
        await deleteObject(fileRef);
      } catch (storageError) {
        console.warn('Could not delete file from storage:', storageError);
      }
    } catch (error) {
      console.error('Error deleting lecture:', error);
      alert(t.errorUnknown);
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  return (
    <>
      <motion.div
        layout
        whileHover={{ y: -3, transition: { duration: 0.2 } }}
        whileTap={{ scale: 0.985 }}
        transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
        onClick={() => setShowPreview(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setShowPreview(true);
          }
        }}
        className="group bg-white dark:bg-zinc-800 rounded-xl sm:rounded-2xl border border-slate-200 dark:border-zinc-700 p-2.5 sm:p-5 hover:shadow-xl hover:shadow-slate-200 dark:hover:shadow-none hover:border-sky-200 dark:hover:border-sky-500/50 transition-all duration-300 flex flex-col h-full cursor-pointer select-none"
        dir={isRtl ? 'rtl' : 'ltr'}
      >
        <div className="flex justify-between items-start mb-2 sm:mb-4">
          <div className={ `p-1.5 sm:p-3 rounded-lg sm:rounded-xl ${lecture.type === 'theoretical' ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400'}` }>
            <FileText className="w-4 h-4 sm:w-6 sm:h-6" />
          </div>
          <div className="flex flex-col sm:flex-row items-end gap-1 sm:gap-2 flex-wrap justify-end">
            <span className={ `text-[9px] sm:text-xs font-bold px-1.5 py-0.5 sm:px-2.5 sm:py-1 rounded-full uppercase tracking-wider ${lecture.type === 'theoretical' ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300' : 'bg-sky-100 dark:bg-sky-900/50 text-sky-700 dark:text-sky-300'}` }>
              {lecture.type === 'theoretical' ? t.theoretical : t.practical}
            </span>
            {lecture.number && (
              <span className="text-[9px] sm:text-xs font-bold px-1.5 py-0.5 sm:px-2.5 sm:py-1 rounded-full uppercase tracking-wider bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300">
                {isRtl ? 'محاضرة' : 'Lecture'} {lecture.number}
              </span>
            )}
            {lecture.version === 'translated' && (
              <span className="text-[9px] sm:text-xs font-bold px-1.5 py-0.5 sm:px-2.5 sm:py-1 rounded-full uppercase tracking-wider bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300">
                {t.translated}
              </span>
            )}
            {isDownloaded && (
              <span 
                className="text-[9px] sm:text-xs font-bold px-1.5 py-0.5 sm:px-2.5 sm:py-1 rounded-full uppercase tracking-wider bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 flex items-center gap-1"
                title={isRtl ? 'محفوظة على جهازك' : 'Downloaded'}
              >
                <CheckCircle2 className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
                {isRtl ? 'محفوظة' : 'Saved'}
              </span>
            )}
            {lecture.youtubeUrl && (
              <a 
                href={lecture.youtubeUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-[9px] sm:text-xs font-bold px-1.5 py-0.5 sm:px-2.5 sm:py-1 rounded-full uppercase tracking-wider bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300 flex items-center gap-1 hover:bg-red-200 dark:hover:bg-red-900/70 transition-colors"
              >
                <Youtube className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
                {t.youtubeTag}
              </a>
            )}
            {isStudied && (
              <span className="text-[9px] sm:text-xs font-bold px-1.5 py-0.5 sm:px-2.5 sm:py-1 rounded-full uppercase tracking-wider bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300 flex items-center gap-1">
                <CheckCircle className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
                {t.studied}
              </span>
            )}
          </div>
        </div>

        <h3 className="text-[13px] sm:text-lg font-bold text-slate-900 dark:text-stone-100 mb-1 sm:mb-2 group-hover:text-sky-600 dark:group-hover:text-sky-400 transition-colors line-clamp-2 leading-tight sm:leading-normal">
          {lecture.title}
        </h3>
        
        <p className="text-[11px] sm:text-sm text-slate-500 dark:text-slate-400 mb-2 sm:mb-4 line-clamp-2 sm:line-clamp-3 flex-grow">
          {lecture.description || ''}
        </p>

        <div className="space-y-1 sm:space-y-3 pt-2 sm:pt-4 border-t border-slate-100 dark:border-zinc-700">
          <div className="flex items-center gap-1 sm:gap-2 text-[10px] sm:text-xs text-slate-400 dark:text-slate-500">
            <Tag className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
            <span className="truncate">{categoryLabel}</span>
          </div>
          <div className="flex items-center gap-1 sm:gap-2 text-[10px] sm:text-xs text-slate-400 dark:text-slate-500">
            <Clock className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
            <span className="truncate">{date}</span>
          </div>
          {lecture.uploaderName && (
            <div className="flex items-center gap-1 sm:gap-2 text-[10px] sm:text-xs text-slate-400 dark:text-slate-500 font-medium">
              <CheckCircle2 className="w-3.5 h-3.5 sm:w-3.5 sm:h-3.5 text-emerald-500" />
              <span className="truncate text-emerald-600 dark:text-emerald-400">{isRtl ? ` ${lecture.uploaderName}` : ` ${lecture.uploaderName}`}</span>
            </div>
          )}
        </div>

        {/* Clean Outer Card Actions */}
        <div className="mt-3 sm:mt-5 pt-2.5 sm:pt-3 border-t border-slate-100 dark:border-zinc-700/60 flex items-center justify-between gap-1.5 sm:gap-2">
          <div className="flex items-center gap-1 sm:gap-1.5 flex-wrap">
            {/* Studied Toggle */}
            {user && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleToggleStudied();
                }}
                className={`inline-flex items-center justify-center p-1.5 sm:p-2 rounded-lg sm:rounded-xl transition-colors ${isStudied ? 'bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/50' : 'bg-slate-100 dark:bg-zinc-800 text-slate-400 dark:text-slate-500 hover:bg-slate-200 dark:hover:bg-zinc-700 hover:text-green-500'}`}
                title={isStudied ? t.unmarkStudied : t.markStudied}
              >
                <CheckCircle2 className={`w-3.5 h-3.5 sm:w-4 sm:h-4 ${isStudied ? 'fill-current' : ''}`} />
              </button>
            )}

            {/* MCQ Action */}
            {user && (!lecture.version || lecture.version === 'original') && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (onOpenMCQ) onOpenMCQ(lecture);
                }}
                className={`inline-flex items-center justify-center p-1.5 sm:px-2.5 sm:py-1.5 bg-white dark:bg-zinc-800 border rounded-lg sm:rounded-xl transition-all gap-1 ${
                  mcqStatusItem.status === 'generating' 
                    ? 'border-blue-200 dark:border-blue-800 animate-pulse bg-blue-50/50 dark:bg-blue-900/10 text-blue-500'
                    : mcqStatusItem.status === 'failed'
                    ? 'border-red-200 dark:border-red-900/50 hover:bg-red-50 dark:hover:bg-red-900/30 text-red-500 hover:rotate-1'
                    : 'border-blue-100 dark:border-blue-900/50 hover:bg-blue-50 dark:hover:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                }`}
                title={isRtl ? 'اختبار MCQ' : 'MCQ Quiz'}
              >
                {mcqStatusItem.status === 'not_generated' && (
                  <>
                     <ClipboardList className="w-3.5 h-3.5" />
                     <span className="text-[10px] sm:text-xs font-bold leading-none">{isRtl ? 'ابدأ MCQ' : 'Start MCQ'}</span>
                  </>
                )}
                {mcqStatusItem.status === 'ready_new' && (
                  <>
                     <ClipboardList className="w-3.5 h-3.5" />
                     <span className="text-[10px] sm:text-xs font-bold leading-none">{isRtl ? 'ابدأ MCQ' : 'Start MCQ'}</span>
                  </>
                )}
                {mcqStatusItem.status === 'generating' && (
                  <>
                     <Loader2 className="w-3.5 h-3.5 animate-spin" />
                     <span className="text-[10px] sm:text-xs font-bold leading-none">{isRtl ? 'توليد...' : 'Gen...'}</span>
                  </>
                )}
                {mcqStatusItem.status === 'failed' && (
                  <>
                     <X className="w-3.5 h-3.5" />
                     <span className="text-[10px] sm:text-xs font-bold leading-none">{isRtl ? 'فشل التوليد' : 'Failed'}</span>
                  </>
                )}
                {mcqStatusItem.status === 'ready_retake' && (
                  <span className={`text-[10px] sm:text-xs font-bold leading-none ${
                    (mcqStatusItem.score || 0) >= 75 ? 'text-emerald-500' :
                    (mcqStatusItem.score || 0) >= 60 ? 'text-amber-500' : 'text-red-500'
                  }`}>
                    ✅ {isRtl ? 'إعادة' : 'Retake'} ({mcqStatusItem.correct}/{mcqStatusItem.total})
                  </span>
                )}
              </button>
            )}

            {/* Translated question bank */}
            {user && lecture.version === 'translated' && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (onOpenMCQ) onOpenMCQ(lecture);
                }}
                className="inline-flex items-center justify-center p-1.5 sm:px-2.5 sm:py-1.5 bg-white dark:bg-zinc-800 border border-violet-100 dark:border-violet-900/50 rounded-lg sm:rounded-xl hover:bg-violet-50 dark:hover:bg-violet-900/30 text-violet-600 dark:text-violet-400 transition-all gap-1"
                title={isRtl ? 'بنك الأسئلة' : 'Question Bank'}
              >
                <ClipboardList className="w-3.5 h-3.5" />
                <span className="text-[10px] sm:text-xs font-bold leading-none">{isRtl ? 'بنك الأسئلة' : 'Question Bank'}</span>
              </button>
            )}

            {/* Share file */}
            {user && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleShare();
                }}
                disabled={isSharing}
                className="inline-flex items-center justify-center p-1.5 sm:p-2 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 rounded-lg sm:rounded-xl hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors disabled:opacity-60"
                title={isRtl ? 'مشاركة الملف' : 'Share file'}
              >
                {isSharing
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Share2 className="w-3.5 h-3.5" />}
              </button>
            )}

            {/* Admin Management Actions */}
            {canManage(user, 'manageLectures') && (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit?.(lecture);
                  }}
                  className="inline-flex items-center justify-center p-1.5 sm:p-2 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-lg sm:rounded-xl hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
                  title={t.editLecture}
                >
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowDeleteConfirm(true);
                  }}
                  className="inline-flex items-center justify-center p-1.5 sm:p-2 bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg sm:rounded-xl hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors"
                  title={t.deleteLecture}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>

          {/* Details / Open Indicator */}
          <div className="text-[11px] sm:text-xs font-bold text-sky-600 dark:text-sky-400 flex items-center gap-0.5 group-hover:gap-1.5 transition-all">
            <span>{isDownloaded ? (isRtl ? 'فتح' : 'Open') : (isRtl ? 'تفاصيل' : 'Details')}</span>
            <ChevronRight className={`w-3.5 h-3.5 transition-transform ${isRtl ? 'rotate-180 group-hover:-translate-x-0.5' : 'group-hover:translate-x-0.5'}`} />
          </div>
        </div>
      </motion.div>

      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {showDeleteConfirm && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowDeleteConfirm(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-md bg-white dark:bg-zinc-800 rounded-3xl shadow-2xl overflow-hidden p-6 border border-slate-200 dark:border-zinc-700"
              dir={isRtl ? 'rtl' : 'ltr'}
            >
              <h3 className="text-xl font-bold text-slate-900 dark:text-stone-100 mb-2">{t.deleteLecture}</h3>
              <p className="text-slate-500 dark:text-slate-400 mb-6">{t.confirmDeleteLecture}</p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  disabled={isDeleting}
                  className="flex-1 px-4 py-3 bg-slate-100 dark:bg-zinc-700 text-slate-700 dark:text-stone-100 rounded-xl font-bold hover:bg-slate-200 dark:hover:bg-zinc-600 transition-colors"
                >
                  {t.close}
                </button>
                <button
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="flex-1 px-4 py-3 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 transition-colors flex items-center justify-center gap-2"
                >
                  {isDeleting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Trash2 className="w-5 h-5" />}
                  {t.delete}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Modern Lecture Details Sliding Bottom Sheet Modal */}
      <AnimatePresence>
        {showPreview && (
          <div className="fixed inset-0 z-[150] flex items-end sm:items-center justify-center sm:p-4">
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowPreview(false)}
              className="absolute inset-0 bg-black/65 backdrop-blur-sm"
            />

            {/* Bottom Sheet Modal Container */}
            <motion.div
              initial={{ opacity: 0, y: '100%' }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: '100%' }}
              transition={{ type: 'spring', damping: 28, stiffness: 300 }}
              className="relative w-full max-w-xl max-h-[90vh] bg-white dark:bg-zinc-900 rounded-t-[32px] sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden border border-slate-200/80 dark:border-zinc-800 z-10"
              dir={isRtl ? 'rtl' : 'ltr'}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Grab handle for bottom sheet on mobile */}
              <div className="w-12 h-1.5 bg-slate-200 dark:bg-zinc-700 rounded-full mx-auto mt-3 mb-1 shrink-0 sm:hidden" />

              {/* Sheet Header */}
              <div className="px-5 sm:px-6 pt-3 pb-4 border-b border-slate-100 dark:border-zinc-800/80 flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  {/* Badges row */}
                  <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap mb-2">
                    <span className={`text-[10px] sm:text-xs font-bold px-2.5 py-0.5 rounded-full ${lecture.type === 'theoretical' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' : 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300'}`}>
                      {lecture.type === 'theoretical' ? t.theoretical : t.practical}
                    </span>
                    {categoryLabel && (
                      <span className="text-[10px] sm:text-xs font-bold px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-slate-300 truncate max-w-[150px]">
                        {categoryLabel}
                      </span>
                    )}
                    {lecture.number && (
                      <span className="text-[10px] sm:text-xs font-bold px-2.5 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300">
                        {isRtl ? 'محاضرة' : 'Lecture'} {lecture.number}
                      </span>
                    )}
                    {lecture.version === 'translated' && (
                      <span className="text-[10px] sm:text-xs font-bold px-2.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
                        {t.translated}
                      </span>
                    )}
                  </div>

                  {/* Title */}
                  <h2 className="text-lg sm:text-xl font-black text-slate-900 dark:text-stone-100 leading-snug line-clamp-2">
                    {lecture.title}
                  </h2>

                  {/* Metadata Row */}
                  <div className="flex items-center gap-3 mt-2 text-[11px] sm:text-xs text-slate-400 dark:text-slate-500 flex-wrap">
                    <div className="flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />
                      <span>{date}</span>
                    </div>
                    {lecture.uploaderName && (
                      <div className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>{lecture.uploaderName}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-1 font-semibold">
                      {isDownloaded ? (
                        <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          {isRtl ? 'محفوظة على جهازك' : 'Downloaded offline'}
                        </span>
                      ) : (
                        <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1">
                          <CloudDownload className="w-3.5 h-3.5" />
                          {isRtl ? 'غير منزلة' : 'Not downloaded'}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Close Button */}
                <button
                  onClick={() => setShowPreview(false)}
                  className="p-2 text-slate-400 hover:text-slate-600 dark:text-zinc-400 dark:hover:text-stone-100 bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 rounded-full transition-colors shrink-0"
                  aria-label="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Scrollable Content */}
              <div className="flex-1 overflow-y-auto px-5 sm:px-6 py-4 space-y-4">
                
                {/* Embedded YouTube Player (if video URL exists) */}
                {lecture.youtubeUrl && (
                  <div className="w-full aspect-video rounded-2xl overflow-hidden bg-black shadow-md relative border border-slate-200 dark:border-zinc-800">
                    <iframe
                      src={getYoutubeEmbedUrl(lecture.youtubeUrl)}
                      className="w-full h-full border-none"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                      title={lecture.title}
                    />
                  </div>
                )}

                {/* Description Box (if description exists) */}
                {lecture.description && (
                  <div className="p-4 rounded-2xl bg-slate-50 dark:bg-zinc-800/60 border border-slate-100 dark:border-zinc-800 text-slate-700 dark:text-slate-300 text-sm leading-relaxed whitespace-pre-wrap">
                    {lecture.description}
                  </div>
                )}

                {/* Primary Hero Action Card: Download-First Flow */}
                <div className="p-5 sm:p-6 rounded-2xl bg-gradient-to-br from-slate-50 to-slate-100/70 dark:from-zinc-800/70 dark:to-zinc-800/30 border border-slate-200/80 dark:border-zinc-700/60 shadow-sm flex flex-col items-center text-center">
                  
                  {isDownloading ? (
                    // State 1: Downloading in progress
                    <div className="w-full flex flex-col items-center py-2 space-y-3">
                      <div className="relative w-14 h-14 flex items-center justify-center">
                        <svg className="w-full h-full transform -rotate-90" viewBox="0 0 36 36">
                          <path
                            className="text-slate-200 dark:text-zinc-700"
                            strokeWidth="3.5"
                            stroke="currentColor"
                            fill="none"
                            d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                          />
                          <path
                            className="text-sky-600 dark:text-sky-400 transition-all duration-300"
                            strokeDasharray={`${downloadProgress}, 100`}
                            strokeWidth="3.5"
                            strokeLinecap="round"
                            fill="none"
                            d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                          />
                        </svg>
                        <span className="absolute text-xs font-black text-slate-800 dark:text-stone-100">
                          {downloadProgress}%
                        </span>
                      </div>
                      <div className="w-full max-w-xs bg-slate-200 dark:bg-zinc-700 h-2 rounded-full overflow-hidden">
                        <div
                          className="bg-sky-500 h-full transition-all duration-300 rounded-full"
                          style={{ width: `${downloadProgress}%` }}
                        />
                      </div>
                      <p className="text-xs sm:text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin text-sky-500" />
                        {isRtl ? 'جاري تنزيل ملف المحاضرة...' : 'Downloading lecture file...'}
                      </p>
                    </div>
                  ) : isDownloaded ? (
                    // State 2: Downloaded -> Read in App
                    <div className="w-full flex flex-col items-center space-y-3">
                      <div className="w-12 h-12 rounded-2xl bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
                        <BookOpen className="w-6 h-6" />
                      </div>
                      <div>
                        <h4 className="text-base sm:text-lg font-bold text-slate-900 dark:text-stone-100">
                          {isRtl ? 'المحاضرة جاهزة للقراءة' : 'Lecture Ready to Read'}
                        </h4>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm">
                          {isRtl
                            ? 'المحاضرة محفوظة على جهازك ويمكنك قراءتها وتظليلها وإضافة الملاحظات داخل التطبيق حتى بدون اتصال بالإنترنت'
                            : 'Saved locally. You can read, highlight, and take notes inside the app even offline.'}
                        </p>
                      </div>
                      
                      <button
                        onClick={() => {
                          setShowPreview(false);
                          if (onOpenReader) onOpenReader(lecture);
                        }}
                        className="w-full py-3.5 px-6 bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-600 hover:to-blue-700 active:scale-[0.99] text-white font-bold rounded-xl shadow-lg shadow-sky-500/25 transition-all flex items-center justify-center gap-2.5 text-sm sm:text-base cursor-pointer"
                      >
                        <BookOpen className="w-5 h-5" />
                        <span>{isRtl ? 'قراءة المحاضرة داخل التطبيق' : 'Read Lecture in App'}</span>
                      </button>

                      <button
                        onClick={async () => {
                          await removePDF();
                          if (onRemoveDownload) onRemoveDownload(lecture);
                        }}
                        className="text-xs font-semibold text-rose-500 dark:text-rose-400 hover:text-rose-600 hover:underline flex items-center gap-1.5 pt-1 transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>{isRtl ? 'حذف من التنزيلات لتحرير المساحة' : 'Remove from downloads'}</span>
                      </button>
                    </div>
                  ) : (
                    // State 3: Not Downloaded -> Download First
                    <div className="w-full flex flex-col items-center space-y-3">
                      <div className="w-12 h-12 rounded-2xl bg-sky-100 dark:bg-sky-900/40 text-sky-600 dark:text-sky-400 flex items-center justify-center">
                        <CloudDownload className="w-6 h-6" />
                      </div>
                      <div>
                        <h4 className="text-base sm:text-lg font-bold text-slate-900 dark:text-stone-100">
                          {isRtl ? 'تنزيل المحاضرة' : 'Download Lecture'}
                        </h4>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm">
                          {isRtl
                            ? 'قم بتنزيل المحاضرة لفتحها داخل قارئ التطبيق مع إمكانية التظليل والملاحظات'
                            : 'Download the lecture to open it in the in-app reader with highlights & notes'}
                        </p>
                      </div>

                      <button
                        onClick={downloadPDF}
                        disabled={isDownloading}
                        className="w-full py-3.5 px-6 bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-600 hover:to-blue-700 active:scale-[0.99] text-white font-bold rounded-xl shadow-lg shadow-sky-500/25 transition-all flex items-center justify-center gap-2.5 text-sm sm:text-base cursor-pointer"
                      >
                        <Download className="w-5 h-5" />
                        <span>{isRtl ? 'تنزيل المحاضرة للقراءة' : 'Download to Read'}</span>
                      </button>
                    </div>
                  )}
                </div>

                {/* Secondary Actions Bar */}
                <div className="p-2 sm:p-2.5 rounded-2xl bg-slate-50 dark:bg-zinc-800/40 border border-slate-100 dark:border-zinc-800 flex items-center justify-around gap-1.5 sm:gap-2">
                  
                  {/* Mark as Studied */}
                  {user && (
                    <button
                      onClick={handleToggleStudied}
                      className={`flex-1 flex flex-col items-center justify-center py-2 px-1 rounded-xl transition-all cursor-pointer ${isStudied ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-700/50'}`}
                      title={isStudied ? t.unmarkStudied : t.markStudied}
                    >
                      <CheckCircle2 className={`w-4 h-4 sm:w-5 sm:h-5 mb-1 ${isStudied ? 'fill-current' : ''}`} />
                      <span className="text-[10px] font-bold">{isStudied ? t.studied : (isRtl ? 'تمت دراستها؟' : 'Mark studied')}</span>
                    </button>
                  )}

                  {/* MCQ Button */}
                  {user && (!lecture.version || lecture.version === 'original') && (
                    <button
                      onClick={() => {
                        setShowPreview(false);
                        if (onOpenMCQ) onOpenMCQ(lecture);
                      }}
                      className="flex-1 flex flex-col items-center justify-center py-2 px-1 rounded-xl text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all cursor-pointer"
                    >
                      <ClipboardList className="w-4 h-4 sm:w-5 sm:h-5 mb-1" />
                      <span className="text-[10px] font-bold">
                        {mcqStatusItem.status === 'ready_retake'
                          ? `${isRtl ? 'إعادة' : 'Retake'} (${mcqStatusItem.correct}/${mcqStatusItem.total})`
                          : (isRtl ? 'اختبار MCQ' : 'Start MCQ')}
                      </span>
                    </button>
                  )}

                  {/* Translated question bank */}
                  {user && lecture.version === 'translated' && (
                    <button
                      onClick={() => {
                        setShowPreview(false);
                        if (onOpenMCQ) onOpenMCQ(lecture);
                      }}
                      className="flex-1 flex flex-col items-center justify-center py-2 px-1 rounded-xl text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-all cursor-pointer"
                    >
                      <ClipboardList className="w-4 h-4 sm:w-5 sm:h-5 mb-1" />
                      <span className="text-[10px] font-bold">{isRtl ? 'بنك الأسئلة' : 'Question Bank'}</span>
                    </button>
                  )}

                  {/* Share button */}
                  {user && (
                    <button
                      onClick={handleShare}
                      disabled={isSharing}
                      className="flex-1 flex flex-col items-center justify-center py-2 px-1 rounded-xl text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-all disabled:opacity-50 cursor-pointer"
                    >
                      {isSharing ? <Loader2 className="w-4 h-4 sm:w-5 sm:h-5 mb-1 animate-spin" /> : <Share2 className="w-4 h-4 sm:w-5 sm:h-5 mb-1" />}
                      <span className="text-[10px] font-bold">{isRtl ? 'مشاركة' : 'Share'}</span>
                    </button>
                  )}

                  {/* Admin Edit */}
                  {canManage(user, 'manageLectures') && (
                    <button
                      onClick={() => {
                        setShowPreview(false);
                        onEdit?.(lecture);
                      }}
                      className="flex-1 flex flex-col items-center justify-center py-2 px-1 rounded-xl text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all cursor-pointer"
                    >
                      <Edit2 className="w-4 h-4 sm:w-5 sm:h-5 mb-1" />
                      <span className="text-[10px] font-bold">{isRtl ? 'تعديل' : 'Edit'}</span>
                    </button>
                  )}

                  {/* Admin Delete */}
                  {canManage(user, 'manageLectures') && (
                    <button
                      onClick={() => setShowDeleteConfirm(true)}
                      className="flex-1 flex flex-col items-center justify-center py-2 px-1 rounded-xl text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-all cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4 sm:w-5 sm:h-5 mb-1" />
                      <span className="text-[10px] font-bold">{t.delete}</span>
                    </button>
                  )}

                </div>

              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {shareToast && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="fixed bottom-28 left-1/2 -translate-x-1/2 z-[220] px-4 py-2 rounded-full bg-slate-900/90 dark:bg-stone-100/90 text-white dark:text-zinc-900 text-sm font-bold shadow-lg pointer-events-none"
          >
            {shareToast}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
});
