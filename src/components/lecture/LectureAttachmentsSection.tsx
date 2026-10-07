import React, { useState, useEffect, useCallback } from 'react';
import {
  Image as ImageIcon,
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
} from '../../services/lectureAttachmentService';
import { hasSubscriptionAccess } from '../../../shared/subscriptionAccess';
import { canManage } from '../../lib/permissions';
import AttachmentViewerModal from './AttachmentViewerModal';
import UploadAttachmentModal from './UploadAttachmentModal';

interface LectureAttachmentsSectionProps {
  lecture: Lecture;
  user: UserProfile | null;
  lang: Language;
  onAttachmentsCountChanged?: (count: number) => void;
  onShowPaywall?: () => void;
}

export default function LectureAttachmentsSection({
  lecture,
  user,
  lang,
  onAttachmentsCountChanged,
  onShowPaywall,
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

  const isStaff =
    user?.role === 'admin' ||
    user?.role === 'moderator' ||
    Boolean(user?.isMasterAdmin) ||
    canManage(user, 'manageLectures');

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
      await approveAttachment(attachment, user);
      await loadAttachments();
    } catch (err) {
      console.error('Failed to approve attachment:', err);
    } finally {
      setIsProcessingAction(false);
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

  return (
    <div className="space-y-3.5 pt-2">
      {/* Section Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-sky-100 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400">
            <ImageIcon className="w-4 h-4" />
          </div>
          <div className="flex items-center gap-2">
            <h4 className="text-xs sm:text-sm font-bold text-slate-800 dark:text-stone-200">
              {isRtl ? 'مرفقات وصور المحاضرة' : 'Lecture Attachments'}
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
            <span>{isRtl ? 'إضافة صورة' : 'Add Image'}</span>
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
                    const idx = attachments.findIndex((a) => a.id === item.id);
                    if (idx !== -1) setViewerIndex(idx);
                  }}
                >
                  <img
                    src={item.url}
                    alt=""
                    className="w-12 h-12 rounded-lg object-cover flex-shrink-0 border border-slate-200 dark:border-zinc-700"
                  />
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
                    const idx = attachments.findIndex((a) => a.id === item.id);
                    if (idx !== -1) setViewerIndex(idx);
                  }}
                >
                  <img
                    src={item.url}
                    alt=""
                    className="w-10 h-10 rounded-lg object-cover flex-shrink-0 border border-slate-200 dark:border-zinc-700"
                  />
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
            <ImageIcon className="w-5 h-5" />
          </div>
          <p className="text-xs font-bold text-slate-700 dark:text-stone-300 mb-0.5">
            {isRtl ? 'لا توجد صور أو مرفقات مضافة بعد' : 'No attachments yet'}
          </p>
          <p className="text-[11px] text-slate-400 mb-3">
            {isRtl
              ? 'شارك صور السبورة أو ملاحظاتك المفيدة لتساعد زملاءك في دراسة هذه المحاضرة'
              : 'Share whiteboard snapshots or notes to help your peers'}
          </p>
          {user && (
            <button
              onClick={() => setIsUploadOpen(true)}
              className="px-3.5 py-1.5 rounded-xl bg-sky-500 hover:bg-sky-600 text-white text-xs font-bold transition-all shadow-sm cursor-pointer"
            >
              {isRtl ? 'رفع أول صورة للمحاضرة' : 'Upload First Image'}
            </button>
          )}
        </div>
      )}

      {/* Approved Attachments Gallery Grid / Locked Paywall Blur View */}
      {!loading && approvedList.length > 0 && (
        !isUnlocked ? (
          <div className="relative rounded-2xl sm:rounded-3xl overflow-hidden border border-amber-200/70 dark:border-amber-900/40 p-1 sm:p-1.5 bg-gradient-to-b from-amber-50/40 to-slate-50 dark:from-zinc-900/80 dark:to-zinc-950/90 shadow-sm">
            {/* The blurred background grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 sm:gap-2.5 filter blur-md sm:blur-lg opacity-35 dark:opacity-25 select-none pointer-events-none scale-102 transition-all">
              {approvedList.slice(0, 4).map((item) => (
                <div key={item.id} className="aspect-[4/3] rounded-xl overflow-hidden bg-slate-200 dark:bg-zinc-800">
                  <img src={item.url} alt="" className="w-full h-full object-cover" />
                </div>
              ))}
            </div>

            {/* Frosted Glass Overlay with Lock & Contributor Challenge */}
            <div className="absolute inset-0 flex flex-col items-center justify-center p-3 sm:p-5 text-center backdrop-blur-xs bg-white/75 dark:bg-zinc-900/85 rounded-2xl z-10 space-y-2.5 sm:space-y-3">
              <div className="inline-flex p-2.5 sm:p-3 rounded-2xl bg-gradient-to-tr from-amber-500 to-yellow-400 text-white shadow-lg shadow-amber-500/25">
                <Lock className="w-5 h-5 sm:w-6 sm:h-6 stroke-[2.5]" />
              </div>

              <div className="max-w-md space-y-0.5 sm:space-y-1">
                <div className="flex items-center justify-center gap-1.5 flex-wrap">
                  <h5 className="text-sm sm:text-base font-black text-slate-900 dark:text-stone-100">
                    {isRtl ? 'ملحقات وصور المحاضرة' : 'Lecture Attachments'}
                  </h5>
                  <span className="px-2 py-0.5 rounded-full text-[9px] font-black bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300">
                    {isRtl ? 'ميزة حصرية للمشتركين' : 'PRO Only'}
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {isRtl
                    ? `تتوفر ${approvedList.length} صور وملحقات مفيدة لهذه المحاضرة.`
                    : `${approvedList.length} photos and study attachments available for this lecture.`}
                </p>
              </div>

              {/* Community Contributor Progress Bar (Unlock via 5 approved uploads) */}
              <div className="w-full max-w-xs bg-slate-50/90 dark:bg-zinc-800/90 rounded-2xl p-2.5 sm:p-3 border border-slate-200/80 dark:border-zinc-700/60 shadow-xs space-y-1.5">
                <div className="flex items-center justify-between text-xs font-bold">
                  <span className="text-slate-800 dark:text-stone-200 flex items-center gap-1">
                    <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                    <span>{isRtl ? 'افتح ملحقات المادة مجاناً' : 'Unlock Course Free'}</span>
                  </span>
                  <span className="text-amber-600 dark:text-amber-400 font-black">
                    {approvedUploadsCount} / 5 {isRtl ? 'معتمد' : 'approved'}
                  </span>
                </div>

                {/* Progress bar */}
                <div className="w-full h-2 bg-slate-200 dark:bg-zinc-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-amber-500 to-yellow-400 rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(100, (approvedUploadsCount / 5) * 100)}%` }}
                  />
                </div>

                <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-tight text-start">
                  {isRtl
                    ? `ارفع 5 ملحقات معتمدة لفتح ملحقات مادة ${lecture.subjectNameAr || 'هذه المادة'} مجاناً (متبقي: ${Math.max(0, 5 - approvedUploadsCount)})`
                    : `Upload 5 approved attachments to unlock all attachments for this course for free (${Math.max(0, 5 - approvedUploadsCount)} left)`}
                </p>
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-2 flex-wrap justify-center pt-0.5">
                <button
                  onClick={() => onShowPaywall?.()}
                  className="inline-flex items-center gap-1.5 px-3.5 sm:px-4 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-600 hover:to-yellow-600 text-white text-xs font-black shadow-md shadow-amber-500/20 active:scale-95 transition-all cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>{isRtl ? 'الاشتراك لفتح جميع الملحقات' : 'Subscribe to Unlock'}</span>
                </button>

                {user && (
                  <button
                    onClick={() => setIsUploadOpen(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white hover:bg-slate-100 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-slate-700 dark:text-stone-300 border border-slate-200 dark:border-zinc-700 text-xs font-bold active:scale-95 transition-all cursor-pointer shadow-xs"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>{isRtl ? 'مشاركة صورة (+1)' : 'Contribute photo'}</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 sm:gap-2.5">
            {approvedList.map((item, index) => {
              const displayName = item.isAnonymous
                ? isStaff
                  ? `${item.uploaderName} (${isRtl ? 'مجهول' : 'anon'})`
                  : isRtl
                  ? 'طالب (مجهول)'
                  : 'Anonymous'
                : item.uploaderName || (isRtl ? 'طالب' : 'Student');

              return (
                <div
                  key={item.id}
                  onClick={() => {
                    const idx = attachments.findIndex((a) => a.id === item.id);
                    if (idx !== -1) setViewerIndex(idx);
                  }}
                  className="group relative rounded-xl sm:rounded-2xl overflow-hidden border border-slate-200 dark:border-zinc-700/80 bg-slate-50 dark:bg-zinc-800 aspect-[4/3] cursor-pointer hover:shadow-lg hover:border-sky-300 dark:hover:border-sky-500 transition-all select-none"
                >
                  <img
                    src={item.url}
                    alt={item.title || 'Attachment'}
                    loading="lazy"
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />

                  {/* Gradient overlay on hover */}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-90 sm:opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-2 text-white">
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
                      <ExternalLink className="w-3 h-3 opacity-70" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )
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
                ? 'سيتم حذف الصورة نهائياً وإرسال إشعار فوري للطالب بالسبب لتوضيح عدم قبولها.'
                : 'The image will be permanently deleted and the student will be notified.'}
            </p>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700 dark:text-stone-300">
                {isRtl ? 'سبب الرفض (اختياري):' : 'Rejection Reason (optional):'}
              </label>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {[
                  isRtl ? 'الصورة غير واضحة أو مشوشة' : 'Image is blurry',
                  isRtl ? 'مكررة وموجودة مسبقاً' : 'Duplicate attachment',
                  isRtl ? 'غير متعلقة بالمحاضرة' : 'Not related to lecture',
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
        />
      )}
    </div>
  );
}
