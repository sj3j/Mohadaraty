import React, { useState, useEffect, useCallback } from 'react';
import {
  Image as ImageIcon,
  FileText,
  BookOpen,
  Plus,
  Clock,
  User,
  EyeOff,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Trash2,
  AlertTriangle,
  Sparkles,
  Lock,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Lecture, UserProfile, Language } from '../../types';
import { LectureAttachment } from '../../types/lectureAttachment.types';
import {
  getLectureAttachments,
  approveAttachment,
  rejectAttachment,
  deleteAttachment,
  getStudentApprovedCourseAttachmentsCount,
  toggleAttachmentFreeStatus,
} from '../../services/lectureAttachmentService';
import { hasSubscriptionAccess } from '../../../shared/subscriptionAccess';
import { canManageLectures } from '../../lib/permissions';
import { usePdfThumbnail } from '../../hooks/usePdfThumbnail';
import AttachmentViewerModal from './AttachmentViewerModal';
import UploadAttachmentModal from './UploadAttachmentModal';

interface LectureAttachmentsSectionProps {
  lecture: Lecture;
  user: UserProfile | null;
  lang: Language;
  onAttachmentsCountChanged?: (count: number) => void;
  onShowPaywall?: () => void;
  onOpenReader?: (lecture: Lecture) => void;
}

/**
 * Thumbnail item in the attachments gallery grid.
 * Dynamically handles both images and multi-page PDF summaries/translations.
 */
function AttachmentGridCard({
  item,
  index,
  isLocked,
  onClick,
  onOpenPdf,
  onToggleFree,
  isRtl,
  isStaff,
}: {
  item: LectureAttachment;
  index: number;
  isLocked?: boolean;
  onClick: () => void;
  onOpenPdf?: (item: LectureAttachment) => void;
  onToggleFree?: (item: LectureAttachment) => void;
  isRtl: boolean;
  isStaff: boolean;
}) {
  const isPdf = item.fileType === 'pdf' || item.url.toLowerCase().includes('.pdf');
  const { thumbnail, isLoading } = usePdfThumbnail(item.id, item.url, isPdf);

  const displayName = item.isAnonymous
    ? isStaff
      ? `${item.uploaderName} (${isRtl ? 'مجهول' : 'anon'})`
      : isRtl
      ? 'طالب (مجهول)'
      : 'Anonymous'
    : item.uploaderName || (isRtl ? 'طالب' : 'Student');

  const handleItemClick = () => {
    if (isLocked) {
      onClick();
      return;
    }
    if (isPdf && onOpenPdf) {
      onOpenPdf(item);
    } else {
      onClick();
    }
  };

  return (
    <div
      onClick={handleItemClick}
      className={`group relative rounded-xl sm:rounded-2xl overflow-hidden border ${
        isLocked
          ? 'border-amber-200/80 dark:border-amber-900/40 hover:border-amber-400 dark:hover:border-amber-500 shadow-xs hover:shadow-md'
          : item.isFree
          ? 'border-emerald-200/80 dark:border-emerald-900/40 hover:border-emerald-400 dark:hover:border-emerald-500 hover:shadow-lg'
          : 'border-slate-200 dark:border-zinc-700/80 hover:border-sky-300 dark:hover:border-sky-500 hover:shadow-lg'
      } bg-slate-50 dark:bg-zinc-800 aspect-[4/3] cursor-pointer transition-all select-none flex items-center justify-center`}
    >
      {/* Media thumbnail with 75% blur when locked */}
      <div className={`w-full h-full relative overflow-hidden ${isLocked ? 'filter blur-[7px] opacity-80 scale-105 pointer-events-none select-none' : ''}`}>
        {isPdf ? (
          thumbnail ? (
            <img
              src={thumbnail}
              alt={item.title || 'PDF Attachment'}
              loading="lazy"
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            />
          ) : isLoading ? (
            <div className="w-full h-full bg-slate-100 dark:bg-zinc-800/80 animate-pulse flex flex-col items-center justify-center p-2">
              <FileText className="w-7 h-7 text-slate-300 dark:text-zinc-600 mb-1" />
              <div className="w-10 h-1 bg-slate-300 dark:bg-zinc-600 rounded-full" />
            </div>
          ) : (
            <div className="w-full h-full bg-slate-100 dark:bg-zinc-800 flex flex-col items-center justify-center p-2 text-rose-500 text-center">
              <FileText className="w-8 h-8 mb-1 text-rose-500" />
              <span className="text-[10px] font-bold text-slate-700 dark:text-stone-300 truncate max-w-full px-1">
                {item.title || 'PDF'}
              </span>
            </div>
          )
        ) : (
          <img
            src={item.url}
            alt={item.title || 'Attachment'}
            loading="lazy"
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        )}
      </div>

      {/* Center Lock Badge overlay when locked */}
      {isLocked && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <div className="p-2 sm:p-2.5 rounded-full bg-slate-900/65 dark:bg-black/70 text-amber-300 backdrop-blur-md border border-white/20 shadow-lg group-hover:scale-110 transition-transform">
            <Lock className="w-4 h-4 sm:w-5 sm:h-5 stroke-[2.5]" />
          </div>
        </div>
      )}

      {/* Top Badges Row */}
      <div className="absolute top-1.5 inset-x-1.5 flex items-center justify-between pointer-events-none z-20">
        {/* Free Badge / Staff Toggle */}
        {isStaff && onToggleFree ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleFree(item);
            }}
            className={`pointer-events-auto px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-wider flex items-center gap-1 transition-all cursor-pointer shadow-sm ${
              item.isFree
                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                : 'bg-black/60 text-amber-300 hover:bg-black/80 border border-white/20'
            }`}
            title={isRtl ? (item.isFree ? 'انقر لجعله للمشتركين' : 'انقر لجعله مجاناً للجميع') : (item.isFree ? 'Click to make PRO' : 'Click to make Free')}
          >
            {item.isFree ? (
              <>
                <Sparkles className="w-2.5 h-2.5" />
                <span>{isRtl ? 'مجاني' : 'FREE'}</span>
              </>
            ) : (
              <>
                <Lock className="w-2.5 h-2.5" />
                <span>{isRtl ? 'خاص' : 'PRO'}</span>
              </>
            )}
          </button>
        ) : item.isFree ? (
          <div className="px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-wider bg-emerald-600 text-white shadow-xs flex items-center gap-1">
            <Sparkles className="w-2.5 h-2.5" />
            <span>{isRtl ? 'مجاني' : 'FREE'}</span>
          </div>
        ) : (
          <div />
        )}

        {/* PDF Document Badge */}
        {isPdf && (
          <div className="px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-wider bg-rose-600 text-white shadow-xs flex items-center gap-1">
            <BookOpen className="w-2.5 h-2.5" />
            <span>PDF</span>
          </div>
        )}
      </div>

      {/* Gradient overlay for metadata - kept crisp and legible */}
      <div
        className={`absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent ${
          isLocked ? 'opacity-95' : 'opacity-90 sm:opacity-0 group-hover:opacity-100'
        } transition-opacity flex flex-col justify-end p-2 text-white z-20`}
      >
        {item.title && (
          <p className="text-[11px] font-bold truncate text-white leading-tight mb-0.5">
            {item.title}
          </p>
        )}
        <div className="flex items-center justify-between text-[9px] text-white/80">
          <span className="flex items-center gap-1 truncate max-w-[80px]">
            {item.isAnonymous ? (
              <EyeOff className="w-2.5 h-2.5 text-amber-300 flex-shrink-0" />
            ) : (
              <User className="w-2.5 h-2.5 text-sky-300 flex-shrink-0" />
            )}
            <span className="truncate">{displayName}</span>
          </span>
          <div className="flex items-center gap-1 font-semibold text-sky-300">
            {isLocked ? (
              <span className="flex items-center gap-1 text-amber-300 font-bold">
                <Lock className="w-2.5 h-2.5" />
                <span>{isRtl ? 'للمشتركين' : 'PRO'}</span>
              </span>
            ) : item.isFree ? (
              <span className="flex items-center gap-1 text-emerald-300 font-bold">
                <span>{isRtl ? 'مجاني' : 'Free'}</span>
                {isPdf ? <BookOpen className="w-3 h-3" /> : <ExternalLink className="w-3 h-3 opacity-80" />}
              </span>
            ) : isPdf ? (
              <>
                <BookOpen className="w-3 h-3" />
                <span>{isRtl ? 'قراءة' : 'Read'}</span>
              </>
            ) : (
              <ExternalLink className="w-3 h-3 opacity-70" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Thumbnail for pending items in the moderation review strip.
 */
function PendingItemThumbnail({ item }: { item: LectureAttachment }) {
  const isPdf = item.fileType === 'pdf' || item.url.toLowerCase().includes('.pdf');
  const { thumbnail } = usePdfThumbnail(item.id, item.url, isPdf);

  if (isPdf) {
    return (
      <div className="w-12 h-12 rounded-lg overflow-hidden flex-shrink-0 border border-slate-200 dark:border-zinc-700 relative bg-slate-100 dark:bg-zinc-800 flex items-center justify-center">
        {thumbnail ? (
          <img src={thumbnail} alt="" className="w-full h-full object-cover" />
        ) : (
          <FileText className="w-6 h-6 text-rose-500" />
        )}
        <span className="absolute top-0.5 right-0.5 px-1 py-0.2 rounded text-[7px] font-black bg-rose-600 text-white">
          PDF
        </span>
      </div>
    );
  }

  return (
    <img
      src={item.url}
      alt=""
      className="w-12 h-12 rounded-lg object-cover flex-shrink-0 border border-slate-200 dark:border-zinc-700"
    />
  );
}

export default function LectureAttachmentsSection({
  lecture,
  user,
  lang,
  onAttachmentsCountChanged,
  onShowPaywall,
  onOpenReader,
}: LectureAttachmentsSectionProps) {
  const isRtl = lang === 'ar';

  const [attachments, setAttachments] = useState<LectureAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [approvedUploadsCount, setApprovedUploadsCount] = useState<number>(0);

  // Rejection modal state
  const [rejectingItem, setRejectingItem] = useState<LectureAttachment | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [isProcessingAction, setIsProcessingAction] = useState(false);
  const [pendingFreeMap, setPendingFreeMap] = useState<Record<string, boolean>>({});

  const isStaff = canManageLectures(user);

  const courseKey = lecture.subjectId || lecture.category;
  const isSubscribed = hasSubscriptionAccess(user);
  const isUnlocked = isStaff || isSubscribed || approvedUploadsCount >= 5;

  const loadAttachments = useCallback(async () => {
    try {
      const items = await getLectureAttachments(lecture.id, user);
      setAttachments(items);
      onAttachmentsCountChanged?.(
        items.filter((a) => a.status === 'approved').length
      );
      if (user?.uid && courseKey) {
        const count = await getStudentApprovedCourseAttachmentsCount(user.uid, courseKey);
        setApprovedUploadsCount(count);
      }
    } catch (err) {
      console.error('Failed to load attachments:', err);
    } finally {
      setLoading(false);
    }
  }, [lecture.id, user, courseKey, onAttachmentsCountChanged]);

  useEffect(() => {
    loadAttachments();
  }, [loadAttachments]);

  const approvedList = attachments.filter((a) => a.status === 'approved');
  const pendingList = attachments.filter((a) => a.status === 'pending');

  const handleApprove = async (attachment: LectureAttachment) => {
    if (!user || !isStaff) return;
    setIsProcessingAction(true);
    try {
      const isFree = Boolean(pendingFreeMap[attachment.id]);
      await approveAttachment(attachment, user, isFree);
      await loadAttachments();
    } catch (err) {
      console.error('Failed to approve attachment:', err);
    } finally {
      setIsProcessingAction(false);
    }
  };

  const handleToggleFree = async (attachment: LectureAttachment) => {
    if (!user || !isStaff) return;
    const newFree = !attachment.isFree;
    try {
      await toggleAttachmentFreeStatus(attachment.id, newFree);
      setAttachments((prev) =>
        prev.map((a) => (a.id === attachment.id ? { ...a, isFree: newFree } : a))
      );
    } catch (err) {
      console.error('Failed to toggle attachment free status:', err);
    }
  };

  const handleConfirmReject = async () => {
    if (!rejectingItem || !user || !isStaff) return;
    setIsProcessingAction(true);
    try {
      await rejectAttachment(rejectingItem, rejectReason.trim(), user);
      setRejectingItem(null);
      setRejectReason('');
      await loadAttachments();
    } catch (err) {
      console.error('Failed to reject attachment:', err);
    } finally {
      setIsProcessingAction(false);
    }
  };

  const handleDeleteAttachment = async (attachment: LectureAttachment) => {
    await deleteAttachment(attachment);
    await loadAttachments();
  };

  const handleOpenPdfAttachment = (attachment: LectureAttachment) => {
    if (onOpenReader) {
      onOpenReader({
        ...lecture,
        id: `att_${attachment.id}`,
        title: attachment.title || `${lecture.title} (${isRtl ? 'ملخص / ترجمة' : 'Summary / Translation'})`,
        pdfUrl: attachment.url,
      });
    } else {
      window.open(attachment.url, '_blank');
    }
  };

  return (
    <div className="space-y-3.5 pt-2">
      {/* Section Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-sky-100 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400">
            <BookOpen className="w-4 h-4" />
          </div>
          <div className="flex items-center gap-2">
            <h4 className="text-xs sm:text-sm font-bold text-slate-800 dark:text-stone-200">
              {isRtl ? 'مرفقات وملخصات المحاضرة' : 'Attachments & Summaries'}
            </h4>
            {!isUnlocked && (
              <span className="px-1.5 py-0.5 rounded-full text-[9px] font-black bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300 flex items-center gap-1">
                <Lock className="w-2.5 h-2.5" />
                <span>{isRtl ? 'للمشتركين' : 'PRO'}</span>
              </span>
            )}
            <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-slate-400">
              {approvedList.length}
            </span>
          </div>
        </div>

        {user && (
          <button
            onClick={() => setIsUploadOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-sky-50 dark:bg-sky-950/40 text-sky-600 dark:text-sky-400 hover:bg-sky-100 dark:hover:bg-sky-900/50 text-xs font-bold transition-all active:scale-95 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
            <span>{isRtl ? 'إضافة ملخص / مرفق' : 'Add Attachment'}</span>
          </button>
        )}
      </div>

      {/* Staff Pending Moderation Banner */}
      {isStaff && pendingList.length > 0 && (
        <div className="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/40 rounded-2xl space-y-2">
          <div className="flex items-center justify-between text-xs font-bold text-amber-800 dark:text-amber-300">
            <span className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              {isRtl
                ? `مرفقات بانتظار موافقتك (${pendingList.length})`
                : `Pending your approval (${pendingList.length})`}
            </span>
            <span className="text-[10px] font-normal opacity-80">
              {isRtl ? 'مرئية لك فقط حتى يتم قبولها' : 'Visible only to staff until approved'}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {pendingList.map((item) => (
              <div
                key={item.id}
                className="bg-white dark:bg-zinc-900 p-2.5 rounded-xl border border-amber-200/60 dark:border-amber-900/40 flex items-center justify-between gap-3 shadow-sm"
              >
                <div
                  className="flex items-center gap-2.5 min-w-0 cursor-pointer"
                  onClick={() => {
                    const isPdf = item.fileType === 'pdf' || item.url.toLowerCase().includes('.pdf');
                    if (isPdf) {
                      handleOpenPdfAttachment(item);
                    } else {
                      const idx = attachments.findIndex((a) => a.id === item.id);
                      if (idx !== -1) setViewerIndex(idx);
                    }
                  }}
                >
                  <PendingItemThumbnail item={item} />
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-slate-800 dark:text-stone-200 truncate">
                      {item.title || (isRtl ? 'مرفق بدون عنوان' : 'Untitled attachment')}
                    </p>
                    <p className="text-[10px] text-slate-400 truncate">
                      {item.uploaderName} {item.isAnonymous ? `(${isRtl ? 'مجهول' : 'anon'})` : ''}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() =>
                      setPendingFreeMap((prev) => ({
                        ...prev,
                        [item.id]: !prev[item.id],
                      }))
                    }
                    className={`px-2 py-1 rounded-lg text-[10px] font-bold border transition-all cursor-pointer flex items-center gap-1 ${
                      pendingFreeMap[item.id]
                        ? 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 shadow-xs'
                        : 'bg-slate-50 dark:bg-zinc-800 border-slate-200 dark:border-zinc-700 text-slate-500 dark:text-slate-400'
                    }`}
                    title={isRtl ? 'تحديد: هل المرفق مجاني للجميع أم للمشتركين فقط' : 'Toggle Free or PRO'}
                  >
                    {pendingFreeMap[item.id] ? (
                      <>
                        <Sparkles className="w-3 h-3 text-emerald-500" />
                        <span>{isRtl ? 'مجاني' : 'FREE'}</span>
                      </>
                    ) : (
                      <>
                        <Lock className="w-3 h-3 text-amber-500" />
                        <span>{isRtl ? 'للمشتركين' : 'PRO'}</span>
                      </>
                    )}
                  </button>

                  <button
                    onClick={() => handleApprove(item)}
                    disabled={isProcessingAction}
                    className="p-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 transition-colors cursor-pointer"
                    title={isRtl ? 'قبول ونشر' : 'Approve'}
                  >
                    <CheckCircle2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setRejectingItem(item)}
                    disabled={isProcessingAction}
                    className="p-1.5 rounded-lg bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 hover:bg-rose-100 transition-colors cursor-pointer"
                    title={isRtl ? 'رفض' : 'Reject'}
                  >
                    <XCircle className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Student's Own Pending Uploads Banner (Reassurance & Tracking) */}
      {!isStaff && pendingList.length > 0 && (
        <div className="p-3 bg-amber-50 dark:bg-amber-950/25 border border-amber-200/80 dark:border-amber-900/40 rounded-2xl space-y-2">
          <div className="flex items-center justify-between text-xs font-bold text-amber-800 dark:text-amber-300">
            <span className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
              {isRtl
                ? `مرفقاتك بانتظار موافقة الممثل (${pendingList.length})`
                : `Your submissions pending review (${pendingList.length})`}
            </span>
            <span className="text-[10px] font-medium text-amber-700/80 dark:text-amber-400/80">
              {isRtl ? 'ستظهر لزملائك فور اعتمادها' : 'Visible to peers once approved'}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {pendingList.map((item) => (
              <div
                key={item.id}
                className="bg-white dark:bg-zinc-900 p-2 rounded-xl border border-amber-200/60 dark:border-amber-900/40 flex items-center justify-between gap-2.5 shadow-sm"
              >
                <div
                  className="flex items-center gap-2 min-w-0 cursor-pointer"
                  onClick={() => {
                    const isPdf = item.fileType === 'pdf' || item.url.toLowerCase().includes('.pdf');
                    if (isPdf) {
                      handleOpenPdfAttachment(item);
                    } else {
                      const idx = attachments.findIndex((a) => a.id === item.id);
                      if (idx !== -1) setViewerIndex(idx);
                    }
                  }}
                >
                  <PendingItemThumbnail item={item} />
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-slate-800 dark:text-stone-200 truncate">
                      {item.title || (isRtl ? 'مرفقك قيد التدقيق' : 'Pending upload')}
                    </p>
                    <span className="inline-flex items-center px-1.5 py-0.2 rounded text-[9px] font-bold bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
                      {isRtl ? 'قيد المراجعة' : 'In review'}
                    </span>
                  </div>
                </div>

                <button
                  onClick={() => handleDeleteAttachment(item)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors cursor-pointer"
                  title={isRtl ? 'إلغاء وحذف' : 'Cancel & delete'}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Loading Skeleton */}
      {loading && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 py-2">
          {[1, 2, 3].map((n) => (
            <div
              key={n}
              className="h-28 rounded-xl bg-slate-100 dark:bg-zinc-800 animate-pulse"
            />
          ))}
        </div>
      )}

      {/* Empty State */}
      {!loading && approvedList.length === 0 && pendingList.length === 0 && (
        <div className="p-5 text-center bg-slate-50 dark:bg-zinc-800/30 rounded-2xl border border-slate-100 dark:border-zinc-800/80">
          <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-zinc-800 text-slate-400 mx-auto flex items-center justify-center mb-2">
            <BookOpen className="w-5 h-5" />
          </div>
          <p className="text-xs font-bold text-slate-700 dark:text-stone-300 mb-0.5">
            {isRtl ? 'لا توجد مرفقات أو ملخصات مضافة بعد' : 'No attachments or summaries yet'}
          </p>
          <p className="text-[11px] text-slate-400 mb-3 max-w-sm mx-auto">
            {isRtl
              ? 'شارك صور السبورة، ملخصاتك، أو ملفات الترجمة (PDF) لتساعد زملاءك في دراسة هذه المحاضرة'
              : 'Share whiteboard photos, summaries, or translated PDFs to help your peers'}
          </p>
          {user && (
            <button
              onClick={() => setIsUploadOpen(true)}
              className="px-3.5 py-1.5 rounded-xl bg-sky-500 hover:bg-sky-600 text-white text-xs font-bold transition-all shadow-sm cursor-pointer"
            >
              {isRtl ? 'رفع أول مرفق / ملخص' : 'Upload First Attachment'}
            </button>
          )}
        </div>
      )}

      {/* Approved Attachments Gallery Grid (with 75% blur & floating CTA for non-subscribers) */}
      {!loading && approvedList.length > 0 && (
        <div className="relative space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 sm:gap-2.5">
            {approvedList.map((item, index) => {
              const itemIsLocked = !item.isFree && !isUnlocked;
              return (
                <AttachmentGridCard
                  key={item.id}
                  item={item}
                  index={index}
                  isLocked={itemIsLocked}
                  onToggleFree={isStaff ? handleToggleFree : undefined}
                  onClick={() => {
                    if (itemIsLocked) {
                      onShowPaywall?.();
                      return;
                    }
                    const idx = attachments.findIndex((a) => a.id === item.id);
                    if (idx !== -1) setViewerIndex(idx);
                  }}
                  onOpenPdf={(pdfItem) => {
                    if (itemIsLocked) {
                      onShowPaywall?.();
                      return;
                    }
                    handleOpenPdfAttachment(pdfItem);
                  }}
                  isRtl={isRtl}
                  isStaff={isStaff}
                />
              );
            })}
          </div>

          {/* Floating Subtle Unlock CTA for non-subscribers (only if there are locked items) */}
          {!isUnlocked && approvedList.some((item) => !item.isFree) && (
            <div className="sticky bottom-2 z-30 flex justify-center pt-2 pb-1 pointer-events-none">
              <button
                type="button"
                onClick={onShowPaywall}
                className="pointer-events-auto inline-flex items-center gap-2 px-4 py-2 rounded-full bg-slate-900/90 dark:bg-stone-100/95 text-white dark:text-zinc-900 shadow-xl shadow-black/25 hover:scale-105 active:scale-95 transition-all text-xs font-bold border border-white/20 dark:border-zinc-800 cursor-pointer backdrop-blur-md"
              >
                <div className="p-1 rounded-full bg-amber-400 text-slate-950">
                  <Lock className="w-3 h-3" />
                </div>
                <span>
                  {isRtl ? 'اشترك لفتح جميع المرفقات بالكامل' : 'Subscribe to unlock all attachments'}
                </span>
                <span className="text-[10px] text-amber-300 dark:text-amber-600 font-extrabold flex items-center gap-0.5">
                  <Sparkles className="w-3 h-3" />
                  {isRtl ? 'ترقية' : 'Upgrade'}
                </span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Reject Reason Modal */}
      {rejectingItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/60 backdrop-blur-sm"
          dir={isRtl ? 'rtl' : 'ltr'}
        >
          <div className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl p-5 max-w-sm w-full space-y-4 shadow-2xl">
            <div className="flex items-center gap-2.5 text-rose-600 dark:text-rose-400">
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              <h4 className="text-sm font-bold text-slate-900 dark:text-stone-100">
                {isRtl ? 'رفض المرفق وإشعار الطالب' : 'Reject Attachment'}
              </h4>
            </div>

            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              {isRtl
                ? 'سيتم حذف المرفق نهائياً وإرسال إشعار فوري للطالب بالسبب لتوضيح عدم قبوله.'
                : 'The attachment will be permanently deleted and the student will be notified.'}
            </p>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700 dark:text-stone-300">
                {isRtl ? 'سبب الرفض (اختياري):' : 'Rejection Reason (optional):'}
              </label>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {[
                  isRtl ? 'الملف غير واضح أو مشوش' : 'File is blurry/corrupt',
                  isRtl ? 'مكرر وموجود مسبقاً' : 'Duplicate attachment',
                  isRtl ? 'غير متعلق بالمحاضرة' : 'Not related to lecture',
                ].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setRejectReason(preset)}
                    className="text-[10px] px-2 py-1 rounded-lg bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-600 dark:text-slate-300 transition-colors"
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder={isRtl ? 'اكتب سبباً أو اختر من الأعلى...' : 'Enter reason or select preset...'}
                className="w-full text-xs px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-800 dark:text-stone-200 focus:outline-none focus:ring-2 focus:ring-rose-500"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setRejectingItem(null)}
                disabled={isProcessingAction}
                className="px-3 py-1.5 rounded-xl text-xs font-semibold text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-800"
              >
                {isRtl ? 'إلغاء' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={handleConfirmReject}
                disabled={isProcessingAction}
                className="px-4 py-1.5 rounded-xl text-xs font-bold bg-rose-600 hover:bg-rose-700 text-white flex items-center gap-1.5 shadow-sm"
              >
                {isProcessingAction && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {isRtl ? 'تأكيد الرفض والحذف' : 'Confirm Reject'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Upload Modal */}
      {isUploadOpen && user && (
        <UploadAttachmentModal
          isOpen={isUploadOpen}
          onClose={() => setIsUploadOpen(false)}
          lecture={lecture}
          user={user}
          lang={lang}
          onAttachmentUploaded={() => {
            loadAttachments();
          }}
        />
      )}

      {/* Fullscreen Lightbox Viewer */}
      {viewerIndex !== null && (
        <AttachmentViewerModal
          isOpen={viewerIndex !== null}
          onClose={() => setViewerIndex(null)}
          attachments={attachments}
          initialIndex={viewerIndex}
          user={user}
          lang={lang}
          onDelete={handleDeleteAttachment}
          onOpenReader={handleOpenPdfAttachment}
        />
      )}
    </div>
  );
}
