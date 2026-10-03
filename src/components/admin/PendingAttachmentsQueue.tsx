import React, { useState, useEffect, useCallback } from 'react';
import {
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Eye,
  AlertTriangle,
  User,
  EyeOff,
  Check,
  RefreshCw,
  FileQuestion,
  PartyPopper,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { UserProfile, Language } from '../../types';
import { LectureAttachment } from '../../types/lectureAttachment.types';
import {
  getPendingAttachmentsForStage,
  approveAttachment,
  rejectAttachment,
} from '../../services/lectureAttachmentService';
import AttachmentViewerModal from '../lecture/AttachmentViewerModal';

interface Props {
  user: UserProfile;
  stageId: string;
  lang: Language;
}

export default function PendingAttachmentsQueue({ user, stageId, lang }: Props) {
  const isRtl = lang === 'ar';

  const [items, setItems] = useState<LectureAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingId, setProcessingId] = useState<string | null>(null);

  // Reject modal
  const [rejectingItem, setRejectingItem] = useState<LectureAttachment | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [viewerItem, setViewerItem] = useState<LectureAttachment | null>(null);

  const load = useCallback(async () => {
    if (!stageId) return;
    setLoading(true);
    try {
      const list = await getPendingAttachmentsForStage(stageId);
      setItems(list);
    } catch (err) {
      console.error('Failed to load pending attachments:', err);
    } finally {
      setLoading(false);
    }
  }, [stageId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleApprove = async (attachment: LectureAttachment) => {
    setProcessingId(attachment.id);
    try {
      await approveAttachment(attachment, user);
      setItems((prev) => prev.filter((it) => it.id !== attachment.id));
    } catch (err) {
      console.error('Failed to approve attachment:', err);
    } finally {
      setProcessingId(null);
    }
  };

  const handleConfirmReject = async () => {
    if (!rejectingItem) return;
    setProcessingId(rejectingItem.id);
    try {
      await rejectAttachment(rejectingItem, rejectReason.trim(), user);
      setItems((prev) => prev.filter((it) => it.id !== rejectingItem.id));
      setRejectingItem(null);
      setRejectReason('');
    } catch (err) {
      console.error('Failed to reject attachment:', err);
    } finally {
      setProcessingId(null);
    }
  };

  return (
    <div className="space-y-4" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Header Bar */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base sm:text-lg font-black text-slate-900 dark:text-stone-100 flex items-center gap-2">
            <span>{isRtl ? 'مراجعة مرفقات الطلاب المعلقة' : 'Pending Student Attachments'}</span>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800/40">
              {items.length}
            </span>
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {isRtl
              ? 'راجع الصور التي رفعها الطلاب قبل نشرها وإتاحتها للجميع.'
              : 'Review student-uploaded images before making them public.'}
          </p>
        </div>

        <button
          onClick={load}
          disabled={loading}
          className="p-2 rounded-xl border border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-slate-300 transition-colors cursor-pointer"
          title={isRtl ? 'تحديث' : 'Refresh'}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="py-12 flex flex-col items-center justify-center gap-2 text-slate-400">
          <Loader2 className="w-6 h-6 animate-spin text-sky-500" />
          <span className="text-xs">{isRtl ? 'جارِ جلب المرفقات المعلقة...' : 'Loading pending attachments...'}</span>
        </div>
      )}

      {/* Empty State: All Reviewed */}
      {!loading && items.length === 0 && (
        <div className="p-8 text-center bg-slate-50 dark:bg-zinc-800/40 rounded-2xl border border-slate-100 dark:border-zinc-800">
          <div className="w-12 h-12 rounded-2xl bg-emerald-100 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 mx-auto flex items-center justify-center mb-3">
            <CheckCircle2 className="w-6 h-6" />
          </div>
          <h4 className="text-sm font-bold text-slate-800 dark:text-stone-200 mb-1">
            {isRtl ? 'رائع! لا توجد مرفقات معلقة' : 'All caught up! No pending attachments'}
          </h4>
          <p className="text-xs text-slate-400 max-w-sm mx-auto">
            {isRtl
              ? 'تمت مراجعة واعتماد جميع صور ومرفقات الطلاب لهذه المرحلة بنجاح.'
              : 'All student submissions for this stage have been reviewed.'}
          </p>
        </div>
      )}

      {/* List of Pending Items */}
      {!loading && items.length > 0 && (
        <div className="space-y-3">
          {items.map((item) => {
            const isBusy = processingId === item.id;
            return (
              <div
                key={item.id}
                className="p-3 sm:p-4 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                {/* Image and Details */}
                <div className="flex items-start gap-3 min-w-0">
                  <div
                    onClick={() => setViewerItem(item)}
                    className="relative w-16 h-16 sm:w-20 sm:h-20 rounded-xl overflow-hidden flex-shrink-0 border border-slate-200 dark:border-zinc-700 bg-slate-100 dark:bg-zinc-800 cursor-pointer group"
                  >
                    <img src={item.url} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white">
                      <Eye className="w-5 h-5" />
                    </div>
                  </div>

                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-sm text-slate-900 dark:text-stone-100 truncate">
                        {item.title || (isRtl ? 'مرفق صورة بدون عنوان' : 'Untitled image')}
                      </span>
                      {item.isAnonymous && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 flex items-center gap-1">
                          <EyeOff className="w-3 h-3" />
                          {isRtl ? 'طلب رفعه كمجهول' : 'Requested anon'}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <span className="flex items-center gap-1 font-medium text-slate-700 dark:text-stone-300">
                        <User className="w-3.5 h-3.5 text-sky-500" />
                        {item.uploaderName}
                      </span>
                      <span>•</span>
                      <span>{(item.size / 1024).toFixed(0)} KB</span>
                    </div>

                    <p className="text-[11px] text-slate-500 dark:text-slate-400 font-medium truncate flex items-center gap-1">
                      <span className="text-slate-400">{isRtl ? 'المحاضرة:' : 'Lecture:'}</span>
                      <span className="font-bold text-slate-700 dark:text-stone-300">
                        {item.lectureTitle || item.lectureId}
                      </span>
                    </p>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 sm:self-center justify-end border-t sm:border-t-0 pt-2 sm:pt-0 border-slate-100 dark:border-zinc-800">
                  <button
                    onClick={() => setViewerItem(item)}
                    className="px-3 py-1.5 rounded-xl border border-slate-200 dark:border-zinc-700 text-xs font-bold text-slate-700 dark:text-stone-300 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors flex items-center gap-1 cursor-pointer"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>{isRtl ? 'معاينة' : 'Preview'}</span>
                  </button>

                  <button
                    onClick={() => handleApprove(item)}
                    disabled={isBusy}
                    className="px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-xs font-bold transition-all shadow-sm flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" strokeWidth={3} />}
                    <span>{isRtl ? 'قبول ونشر' : 'Approve'}</span>
                  </button>

                  <button
                    onClick={() => setRejectingItem(item)}
                    disabled={isBusy}
                    className="px-3.5 py-1.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 hover:bg-rose-100 transition-colors text-xs font-bold flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                    <span>{isRtl ? 'رفض' : 'Reject'}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Reject Modal */}
      {rejectingItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/60 backdrop-blur-sm">
          <div className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl p-5 max-w-sm w-full space-y-4 shadow-2xl">
            <div className="flex items-center gap-2 text-rose-600">
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              <h4 className="text-sm font-bold text-slate-900 dark:text-stone-100">
                {isRtl ? 'رفض المرفق وحذفه' : 'Reject & Delete Attachment'}
              </h4>
            </div>

            <p className="text-xs text-slate-500 dark:text-slate-400">
              {isRtl
                ? 'سيتم حذف الصورة من السيرفر نهائياً وتنبيه الطالب بنتيجة المراجعة.'
                : 'The image will be permanently deleted and the student will be notified.'}
            </p>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700 dark:text-stone-300">
                {isRtl ? 'سبب الرفض:' : 'Rejection Reason:'}
              </label>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {[
                  isRtl ? 'الصورة غير واضحة' : 'Blurry image',
                  isRtl ? 'محتوى مكرر' : 'Duplicate content',
                  isRtl ? 'غير متعلق بالمحاضرة' : 'Not relevant',
                ].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setRejectReason(preset)}
                    className="text-[10px] px-2 py-1 rounded-lg bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-stone-300"
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder={isRtl ? 'اكتب سبباً للمراجعة...' : 'Enter reason...'}
                className="w-full text-xs px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-800 dark:text-stone-200 focus:outline-none focus:ring-1 focus:ring-rose-500"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setRejectingItem(null)}
                className="px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-xl"
              >
                {isRtl ? 'إلغاء' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={handleConfirmReject}
                className="px-4 py-1.5 rounded-xl text-xs font-bold bg-rose-600 text-white hover:bg-rose-700 shadow-sm"
              >
                {isRtl ? 'تأكيد الرفض' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Viewer Modal */}
      {viewerItem && (
        <AttachmentViewerModal
          isOpen={viewerItem !== null}
          onClose={() => setViewerItem(null)}
          attachments={[viewerItem]}
          initialIndex={0}
          user={user}
          lang={lang}
        />
      )}
    </div>
  );
}
