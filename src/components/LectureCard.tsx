import React, { useState } from 'react';
import { FileText, Download, ExternalLink, Clock, Tag, X, Maximize2, Trash2, Loader2, Edit2, CloudDownload, CheckCircle2, CloudOff, Heart, CheckCircle, Youtube, ClipboardList, BookOpen, Highlighter } from 'lucide-react';
import { Lecture, CATEGORIES, Language, TRANSLATIONS, UserProfile } from '../types';
import { canManage } from '../lib/permissions';
import { motion, AnimatePresence } from 'motion/react';
import { doc, deleteDoc, setDoc, arrayUnion, arrayRemove } from 'firebase/firestore';
import { ref, deleteObject } from 'firebase/storage';
import { db, storage } from '../lib/firebase';
import { useOfflinePDF } from '../hooks/useOfflinePDF';
import { forceDownload, getYoutubeEmbedUrl } from '../lib/utils';
import { useMCQStatus } from '../hooks/useMCQStatus';
import { ConfirmShareDialog } from './ui/ConfirmShareDialog';

interface LectureCardProps {
  lecture: Lecture;
  lang: Language;
  user: UserProfile | null;
  onEdit?: (lecture: Lecture) => void;
  onRemoveDownload?: (lecture: Lecture) => void;
  onNavigateToChat?: () => void;
  onOpenMCQ?: (lecture: Lecture) => void;
  onOpenReader?: (lecture: Lecture) => void;
  key?: string;
}

export default React.memo(function LectureCard({ lecture, lang, user, onEdit, onRemoveDownload, onNavigateToChat, onOpenMCQ, onOpenReader }: LectureCardProps) {
  const t = TRANSLATIONS[lang];
  const isRtl = lang === 'ar';
  const [showPreview, setShowPreview] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  
  const handleShareToChat = async () => {
    if (!user) return;
    try {
      const { addDoc, collection, serverTimestamp } = await import('firebase/firestore');
      await addDoc(collection(db, 'chat_messages'), {
        text: '',
        senderName: user.name,
        senderEmail: user.email,
        senderId: user.uid,
        senderAvatar: user.photoUrl || user.name.charAt(0).toUpperCase(),
        timestamp: serverTimestamp(),
        createdAt: Date.now(),
        reactions: { like: [], heart: [], thanks: [] },
        isAnonymous: false,
        originalSenderName: user.name,
        embeddedItem: {
          type: 'lecture',
          id: lecture.id,
          title: lecture.title,
          subtitle: `محاضرة ${lecture.number || ''} ${lecture.category}`,
          link: lecture.pdfUrl
        }
      });
      if (onNavigateToChat) {
         onNavigateToChat();
      }
    } catch (err) {
      console.error(err);
      alert('Error sharing to chat');
    }
  };

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
        whileHover={{ y: -4, transition: { duration: 0.2 } }}
        transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
        className="group bg-white dark:bg-zinc-800 rounded-xl sm:rounded-2xl border border-slate-200 dark:border-zinc-700 p-2.5 sm:p-5 hover:shadow-xl hover:shadow-slate-200 dark:hover:shadow-none hover:border-sky-200 dark:hover:border-sky-500/50 transition-all duration-300 flex flex-col h-full"
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
              <CheckCircle2 className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-emerald-500" />
              <span className="truncate text-emerald-600 dark:text-emerald-400">{isRtl ? ` ${lecture.uploaderName}` : ` ${lecture.uploaderName}`}</span>
            </div>
          )}
        </div>

        <div className="mt-3 sm:mt-6 flex flex-wrap gap-1 sm:gap-2">
          {isDownloaded && offlineUrl ? (
            <button
               onClick={(e) => {
                 e.preventDefault();
                 // The reader already prefers the downloaded bytes, so it IS the
                 // offline view - and it keeps highlights and notes available
                 // without a connection. window.open stays as the fallback for
                 // any surface that has not been given a reader handler.
                 if (onOpenReader) onOpenReader(lecture);
                 else window.open(offlineUrl, '_blank');
               }}
               className="flex-1 inline-flex items-center justify-center gap-1 sm:gap-2 px-2 py-1.5 sm:px-4 sm:py-2.5 bg-emerald-600 dark:bg-emerald-500 text-white dark:text-zinc-900 rounded-lg sm:rounded-xl hover:bg-emerald-700 dark:hover:bg-emerald-600 transition-colors text-[11px] sm:text-sm font-semibold min-w-0 sm:min-w-[100px]"
            >
              <FileText className="w-3 h-3 sm:w-4 sm:h-4" />
              {isRtl ? 'عرض بلا إنترنت' : 'Offline View'}
            </button>
          ) : (
            <button
              onClick={() => setShowPreview(true)}
              className="flex-1 inline-flex items-center justify-center gap-1 sm:gap-2 px-2 py-1.5 sm:px-4 sm:py-2.5 bg-slate-900 dark:bg-stone-100 text-white dark:text-zinc-900 rounded-lg sm:rounded-xl hover:bg-slate-800 dark:hover:bg-white transition-colors text-[11px] sm:text-sm font-semibold min-w-0 sm:min-w-[100px]"
            >
              <Maximize2 className="w-3 h-3 sm:w-4 sm:h-4" />
              {t.view}
            </button>
          )}

          {user && (
            <>
              <button
                onClick={handleToggleStudied}
                className={`inline-flex items-center justify-center p-1.5 sm:p-2.5 rounded-lg sm:rounded-xl transition-colors ${isStudied ? 'bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/50' : 'bg-slate-100 dark:bg-zinc-800 text-slate-400 dark:text-slate-500 hover:bg-slate-200 dark:hover:bg-zinc-700 hover:text-green-500'}`}
                title={isStudied ? t.unmarkStudied : t.markStudied}
              >
                <CheckCircle2 className={`w-3.5 h-3.5 sm:w-5 sm:h-5 ${isStudied ? 'fill-current' : ''}`} />
              </button>
            </>
          )}

          <button
            onClick={(e) => {
              e.preventDefault();
              forceDownload(lecture.pdfUrl, lecture.title + '.pdf');
            }}
            className="inline-flex items-center justify-center p-1.5 sm:p-2.5 bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-slate-400 rounded-lg sm:rounded-xl hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
            title={t.download}
          >
            <Download className="w-3.5 h-3.5 sm:w-5 sm:h-5" />
          </button>
          {user && (
            <button
              onClick={() => setIsShareDialogOpen(true)}
              className="inline-flex items-center justify-center p-1.5 sm:p-2.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 rounded-lg sm:rounded-xl hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors"
              title={isRtl ? 'مشاركة في المحادثة' : 'Share to Chat'}
            >
              <svg className="w-3.5 h-3.5 sm:w-5 sm:h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>
            </button>
          )}

          {user && (!lecture.version || lecture.version === 'original') && (
            <button
              onClick={() => onOpenMCQ && onOpenMCQ(lecture)}
              className={`inline-flex items-center justify-center p-1.5 sm:px-3 sm:py-2.5 bg-white dark:bg-zinc-800 border-2 rounded-lg sm:rounded-xl transition-all gap-1.5 ${
                mcqStatusItem.status === 'generating' 
                  ? 'border-blue-200 dark:border-blue-800 animate-pulse bg-blue-50/50 dark:bg-blue-900/10 text-blue-500'
                  : mcqStatusItem.status === 'failed'
                  ? 'border-red-200 dark:border-red-900/50 hover:bg-red-50 dark:hover:bg-red-900/30 text-red-500 hover:rotate-1'
                  : 'border-blue-100 dark:border-blue-900/50 hover:bg-blue-50 dark:hover:bg-blue-900/30 text-blue-600 dark:text-blue-400'
              }`}
            >
              {mcqStatusItem.status === 'not_generated' && (
                <>
                   <ClipboardList className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                   <span className="text-[10px] sm:text-xs font-bold leading-none">{isRtl ? 'ابدأ MCQ' : 'Start MCQ'}</span>
                </>
              )}
              {mcqStatusItem.status === 'ready_new' && (
                <>
                   <ClipboardList className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                   <span className="text-[10px] sm:text-xs font-bold leading-none">{isRtl ? 'ابدأ MCQ' : 'Start MCQ'}</span>
                </>
              )}
              {mcqStatusItem.status === 'generating' && (
                <>
                   <Loader2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 animate-spin" />
                   <span className="text-[10px] sm:text-xs font-bold leading-none">{isRtl ? 'توليد...' : 'Gen...'}</span>
                </>
              )}
              {mcqStatusItem.status === 'failed' && (
                <>
                   <X className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                   <span className="text-[10px] sm:text-xs font-bold leading-none">{isRtl ? 'فشل التوليد' : 'Failed'}</span>
                </>
              )}
              {mcqStatusItem.status === 'ready_retake' && (
                <>
                   <span className={`text-[10px] sm:text-xs font-bold leading-none ${
                     (mcqStatusItem.score || 0) >= 75 ? 'text-emerald-500' :
                     (mcqStatusItem.score || 0) >= 60 ? 'text-amber-500' : 'text-red-500'
                   }`}>
                     ✅ {isRtl ? 'إعادة' : 'Retake'} ({mcqStatusItem.correct}/{mcqStatusItem.total})
                   </span>
                </>
              )}
            </button>
          )}

          {/* Translated lectures get their own entry point rather than sharing the
              one above. That button's whole label is driven by AI generation
              status, which is meaningless here - a translated lecture never has
              AI questions, so it would permanently read "Start MCQ" and generate
              nothing. This opens the same overlay, which shows the question bank
              only. Without it a translated lecture has no route to the bank at
              all, which is the gap that made a pair's shared questions
              unreachable from the translated half. */}
          {user && lecture.version === 'translated' && (
            <button
              onClick={() => onOpenMCQ && onOpenMCQ(lecture)}
              className="inline-flex items-center justify-center p-1.5 sm:px-3 sm:py-2.5 bg-white dark:bg-zinc-800 border-2 border-violet-100 dark:border-violet-900/50 rounded-lg sm:rounded-xl hover:bg-violet-50 dark:hover:bg-violet-900/30 text-violet-600 dark:text-violet-400 transition-all gap-1.5"
              title={isRtl ? 'بنك الأسئلة' : 'Question Bank'}
            >
              <ClipboardList className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              <span className="text-[10px] sm:text-xs font-bold leading-none">{isRtl ? 'بنك الأسئلة' : 'Question Bank'}</span>
            </button>
          )}

          {canManage(user, 'manageLectures') && (
            <>
              <button
                onClick={() => onEdit?.(lecture)}
                className="inline-flex items-center justify-center p-1.5 sm:p-2.5 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-lg sm:rounded-xl hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
                title={t.editLecture}
              >
                <Edit2 className="w-3.5 h-3.5 sm:w-5 sm:h-5" />
              </button>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="inline-flex items-center justify-center p-1.5 sm:p-2.5 bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg sm:rounded-xl hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors"
                title={t.deleteLecture}
              >
                <Trash2 className="w-3.5 h-3.5 sm:w-5 sm:h-5" />
              </button>
            </>
          )}
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

      {/* PDF / Video Preview Modal */}
      <AnimatePresence>
        {showPreview && (
          <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 md:p-8">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowPreview(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-5xl h-full bg-[#F5F7FA] dark:bg-zinc-950 rounded-[24px] overflow-hidden flex flex-col shadow-2xl border border-slate-200 dark:border-zinc-800"
              dir={isRtl ? 'rtl' : 'ltr'}
            >
              {/* Hero Header */}
              <div className={`p-6 md:p-8 shrink-0 relative overflow-hidden bg-gradient-to-br ${lecture.type === 'theoretical' ? 'from-blue-600 to-[#2196F3]' : 'from-emerald-500 to-teal-400'}`}>
                <div className="absolute top-0 right-0 p-4 z-20">
                  <button
                    onClick={() => setShowPreview(false)}
                    className="p-2 bg-white/20 hover:bg-white/30 text-white rounded-full backdrop-blur-sm transition-all"
                  >
                    <X className="w-6 h-6" />
                  </button>
                </div>
                
                <div className="relative z-10 flex flex-col justify-end min-h-[120px]">
                  <div className="flex items-center gap-3 mb-3 text-white/90">
                    <span className="text-xs font-bold px-3 py-1 bg-white/20 rounded-full backdrop-blur-sm">
                      {categoryLabel}
                    </span>
                    {lecture.number && (
                      <span className="text-xs font-bold px-3 py-1 bg-white/20 rounded-full backdrop-blur-sm">
                        {isRtl ? 'محاضرة' : 'Lecture'} {lecture.number}
                      </span>
                    )}
                  </div>
                  <h2 className="text-2xl md:text-3xl font-black text-white leading-tight">
                    {lecture.title}
                  </h2>
                </div>
              </div>
              
              <div className="flex-1 overflow-y-auto p-4 md:p-6 flex flex-col gap-4">
                
                {/* PDF/Video Container */}
                <div id={`lecture-container-${lecture.id}`} className="w-full bg-white dark:bg-zinc-900 rounded-[16px] shadow-[0_2px_12px_rgba(0,0,0,0.06)] overflow-hidden flex flex-col min-h-[60vh] border border-slate-100 dark:border-zinc-800 relative">
                  {lecture.youtubeUrl && (
                    <div className="w-full aspect-video bg-black shrink-0 relative">
                       <iframe
                        src={getYoutubeEmbedUrl(lecture.youtubeUrl)}
                        className="w-full h-full border-none absolute inset-0"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                        title={lecture.title}
                      />
                    </div>
                  )}
                  {/iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '') ? (
                    <div className="w-full flex-1 bg-slate-50 dark:bg-zinc-800 flex flex-col items-center justify-center p-6 text-center">
                       <FileText className="w-16 h-16 text-sky-500 mb-4 opacity-80" />
                       <h3 className="text-xl font-bold text-slate-800 dark:text-slate-200 mb-2">{lecture.title}</h3>
                       <p className="text-sm text-slate-500 dark:text-slate-400 mb-6 max-w-sm">
                         {isRtl ? 'اقرأ المحاضرة داخل التطبيق مع إمكانية التظليل وإضافة الملاحظات' : 'Read this lecture in the app, with highlighting and notes.'}
                       </p>
                       {onOpenReader && (
                         <button
                           onClick={(e) => { e.preventDefault(); setShowPreview(false); onOpenReader(lecture); }}
                           className="px-6 py-3 bg-sky-500 hover:bg-sky-600 active:scale-95 text-white font-bold rounded-xl shadow-lg transition-all flex items-center gap-2"
                         >
                           <BookOpen className="w-5 h-5" />
                           {isRtl ? 'اقرأ داخل التطبيق' : 'Read in app'}
                         </button>
                       )}
                       {/* Escape hatch while the reader is new: if a file will not
                           open in it, the student is not stranded. */}
                       <a
                         href={lecture.pdfUrl}
                         target="_blank"
                         rel="noopener noreferrer"
                         className="mt-4 text-xs font-bold text-slate-400 hover:text-sky-500 underline flex items-center gap-1.5 transition-colors"
                       >
                         <ExternalLink className="w-3.5 h-3.5" />
                         {isRtl ? 'فتح في المتصفح بدلاً من ذلك' : 'Open in browser instead'}
                       </a>
                    </div>
                  ) : (
                    <iframe
                      src={`${lecture.pdfUrl}#toolbar=0`}
                      className="w-full flex-1 border-none bg-slate-50 dark:bg-zinc-800 relative z-10"
                      title={lecture.title}
                    />
                  )}
                </div>

                {/* Description & Actions */}
                <div className="bg-white dark:bg-zinc-900 rounded-[16px] shadow-[0_2px_12px_rgba(0,0,0,0.06)] p-6 space-y-4 border border-slate-100 dark:border-zinc-800">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="text-lg font-bold text-slate-800 dark:text-slate-200">
                      {isRtl ? 'تفاصيل المحاضرة' : 'Lecture Details'}
                    </h3>
                     <div className="flex items-center flex-wrap gap-2">
                       {isDownloaded ? (
                         <button
                           onClick={async () => {
                             await removePDF();
                             if (onRemoveDownload) onRemoveDownload(lecture);
                           }}
                           className="inline-flex items-center justify-center px-4 py-2 border-2 border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 rounded-full font-bold hover:bg-red-50 dark:hover:bg-red-900/30 hover:text-red-600 dark:hover:text-red-400 hover:border-red-200 transition-colors group"
                         >
                           <CheckCircle2 className="w-4 h-4 group-hover:hidden" />
                           <CloudOff className="w-4 h-4 hidden group-hover:block" />
                           <span className="hidden sm:inline mx-1">{isRtl ? 'حذف من التنزيلات' : 'Remove Download'}</span>
                         </button>
                       ) : (
                         <button
                           onClick={downloadPDF}
                           disabled={isDownloading}
                           className="inline-flex items-center justify-center px-4 py-2 border-2 border-sky-200 bg-sky-50 dark:border-sky-800 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400 rounded-full font-bold hover:bg-sky-100 dark:hover:bg-sky-900/50 transition-colors disabled:opacity-100 relative overflow-hidden"
                         >
                           {isDownloading ? (
                             <div className="flex items-center gap-2">
                               <div className="relative w-4 h-4 flex items-center justify-center">
                                 <svg className="w-full h-full transform -rotate-90" viewBox="0 0 36 36">
                                   <path className="text-sky-200 dark:text-sky-800/50" strokeWidth="4" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                                   <path className="text-sky-600 dark:text-sky-400 transition-all duration-300" strokeDasharray={`${downloadProgress}, 100`} strokeWidth="4" strokeLinecap="round" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                                 </svg>
                                 <span className="absolute text-[6px] font-bold leading-none">{downloadProgress}</span>
                               </div>
                               <span className="hidden sm:inline text-xs">{isRtl ? 'جاري التحميل' : 'Downloading'}</span>
                             </div>
                           ) : (
                             <>
                               <CloudDownload className="w-4 h-4" />
                               <span className="hidden sm:inline mx-1">{isRtl ? 'حفظ للمشاهدة بدون إنترنت' : 'Save Offline'}</span>
                             </>
                           )}
                         </button>
                       )}
                       <button
                         onClick={async (e) => {
                           e.preventDefault();
                           try {
                             if (!document.fullscreenElement && !(document as any).webkitFullscreenElement) {
                               const container = document.getElementById(`lecture-container-${lecture.id}`) as any;
                               if (container) {
                                 if (container.requestFullscreen) await container.requestFullscreen();
                                 else if (container.webkitRequestFullscreen) await container.webkitRequestFullscreen();
                                 else if (container.msRequestFullscreen) await container.msRequestFullscreen();
                               } else {
                                 const docEl = document.documentElement as any;
                                 if (docEl.requestFullscreen) await docEl.requestFullscreen();
                                 else if (docEl.webkitRequestFullscreen) await docEl.webkitRequestFullscreen();
                               }
                               
                               if (window.screen && window.screen.orientation && (window.screen.orientation as any).lock) {
                                 await (window.screen.orientation as any).lock('landscape').catch(() => console.warn('Rotation lock failed'));
                               }
                             } else {
                               if (window.screen && window.screen.orientation && (window.screen.orientation as any).unlock) {
                                  (window.screen.orientation as any).unlock();
                               }
                               if (document.exitFullscreen) await document.exitFullscreen();
                               else if ((document as any).webkitExitFullscreen) await ((document as any).webkitExitFullscreen)();
                             }
                           } catch (err) {
                             console.warn("Fullscreen/Rotation not supported: ", err);
                           }
                         }}
                         className="border border-slate-300 dark:border-zinc-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-zinc-800 px-4 py-2 rounded-full font-bold flex items-center gap-2 transition-colors"
                       >
                         <Maximize2 className="w-4 h-4" />
                         <span className="hidden sm:inline">{isRtl ? 'ملء وتدوير' : 'Fullscreen / Rotate'}</span>
                       </button>
                      {onOpenReader && (
                        <button
                          onClick={(e) => { e.preventDefault(); setShowPreview(false); onOpenReader(lecture); }}
                          className="border border-sky-300 dark:border-sky-800 bg-sky-50 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300 hover:bg-sky-100 dark:hover:bg-sky-900/50 px-4 py-2 rounded-full font-bold flex items-center gap-2 transition-colors"
                        >
                          <Highlighter className="w-4 h-4" />
                          <span className="hidden sm:inline">{isRtl ? 'تظليل وملاحظات' : 'Highlight & notes'}</span>
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          window.open(lecture.pdfUrl, '_blank');
                        }}
                        className="border border-slate-300 dark:border-zinc-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-zinc-800 px-4 py-2 rounded-full font-bold flex items-center gap-2 transition-colors"
                      >
                        <FileText className="w-4 h-4" />
                        <span className="hidden sm:inline">{isRtl ? 'فتح في المتصفح' : 'Open in Browser'}</span>
                      </button>
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          forceDownload(lecture.pdfUrl, lecture.title + '.pdf');
                        }}
                        className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-full font-bold flex items-center gap-2 transition-colors"
                      >
                        <Download className="w-4 h-4" />
                        {t.download}
                      </button>
                    </div>
                  </div>
                  {lecture.description && (
                    <p className="text-slate-600 dark:text-slate-400 text-sm leading-relaxed whitespace-pre-wrap">
                      {lecture.description}
                    </p>
                  )}
                </div>

              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <ConfirmShareDialog
        isOpen={isShareDialogOpen}
        onClose={() => setIsShareDialogOpen(false)}
        onConfirm={handleShareToChat}
        itemName={isRtl ? 'هذه المحاضرة' : 'this lecture'}
        lang={lang}
      />
    </>
  );
});
