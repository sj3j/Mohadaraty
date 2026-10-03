import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Image as ImageIcon,
  Plus,
  X,
  ExternalLink,
  User,
  EyeOff,
  Clock,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Lecture, UserProfile } from '../../types';
import { LectureAttachment } from '../../types/lectureAttachment.types';
import {
  getLectureAttachments,
  deleteAttachment,
} from '../../services/lectureAttachmentService';
import AttachmentViewerModal from '../lecture/AttachmentViewerModal';
import UploadAttachmentModal from '../lecture/UploadAttachmentModal';

interface Props {
  lecture: Lecture;
  user: UserProfile | null;
  isRtl: boolean;
  isOpen: boolean;
  onClose: () => void;
  onCountChange?: (count: number) => void;
}

export default function PdfAttachmentsDrawer({
  lecture,
  user,
  isRtl,
  isOpen,
  onClose,
  onCountChange,
}: Props) {
  const [attachments, setAttachments] = useState<LectureAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [isUploadOpen, setIsUploadOpen] = useState(false);

  const isStaff =
    user?.role === 'admin' ||
    user?.role === 'moderator' ||
    Boolean(user?.isMasterAdmin);

  const load = useCallback(async () => {
    try {
      const items = await getLectureAttachments(lecture.id, user);
      setAttachments(items);
      const approvedCount = items.filter((a) => a.status === 'approved').length;
      onCountChange?.(approvedCount);
    } catch (err) {
      console.error('Failed to load attachments in drawer:', err);
    } finally {
      setLoading(false);
    }
  }, [lecture.id, user, onCountChange]);

  useEffect(() => {
    if (isOpen) {
      load();
    }
  }, [isOpen, load]);

  const approvedList = attachments.filter((a) => a.status === 'approved');
  // Normal students see approved attachments plus their own pending uploads while studying
  const displayList = isStaff
    ? attachments
    : attachments.filter((a) => a.status === 'approved' || (user && a.uploadedBy === user.uid));

  const handleDelete = async (att: LectureAttachment) => {
    await deleteAttachment(att);
    await load();
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 z-[170] bg-black/60 backdrop-blur-sm"
      />

      {/* Drawer Container */}
      <motion.aside
        initial={{ x: isRtl ? '-100%' : '100%' }}
        animate={{ x: 0 }}
        exit={{ x: isRtl ? '-100%' : '100%' }}
        transition={{ type: 'spring', damping: 30, stiffness: 300 }}
        dir={isRtl ? 'rtl' : 'ltr'}
        className={`fixed inset-y-0 ${
          isRtl ? 'start-0' : 'end-0'
        } z-[171] w-full max-w-sm sm:max-w-md bg-white dark:bg-zinc-900 shadow-2xl flex flex-col`}
      >
        {/* Header */}
        <header className="shrink-0 flex items-center justify-between px-4 pt-[max(env(safe-area-inset-top),0.75rem)] pb-3 border-b border-slate-200 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-sky-100 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400">
              <ImageIcon className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-black text-base text-slate-900 dark:text-stone-100">
                {isRtl ? 'مرفقات المحاضرة' : 'Lecture Attachments'}
              </h2>
              <p className="text-[10px] text-slate-400">
                {isRtl ? `${approvedList.length} صورة متاحة` : `${approvedList.length} images available`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {user && (
              <button
                onClick={() => setIsUploadOpen(true)}
                aria-label={isRtl ? 'إضافة صورة' : 'Add Image'}
                className="p-2 rounded-full text-sky-600 dark:text-sky-400 hover:bg-sky-50 dark:hover:bg-zinc-800 transition-colors"
                title={isRtl ? 'إضافة مرفق جديد' : 'Upload attachment'}
              >
                <Plus className="w-5 h-5" strokeWidth={2.5} />
              </button>
            )}
            <button
              onClick={onClose}
              aria-label={isRtl ? 'إغلاق' : 'Close'}
              className="p-2 rounded-full text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </header>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {loading && (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin text-sky-500" />
              <span className="text-xs">{isRtl ? 'جارِ تحميل المرفقات...' : 'Loading attachments...'}</span>
            </div>
          )}

          {!loading && displayList.length === 0 && (
            <div className="text-center py-16 px-4">
              <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-zinc-800 text-slate-400 mx-auto flex items-center justify-center mb-3">
                <ImageIcon className="w-6 h-6" />
              </div>
              <p className="text-sm font-bold text-slate-700 dark:text-stone-300 mb-1">
                {isRtl ? 'لا توجد مرفقات لهذه المحاضرة' : 'No attachments for this lecture'}
              </p>
              <p className="text-xs text-slate-400 mb-4 max-w-xs mx-auto">
                {isRtl
                  ? 'يمكنك إضافة صور السبورة أو الملاحظات لدراستها ومشاركتها مع زملائك.'
                  : 'You can upload whiteboard photos or handwritten notes to review alongside the PDF.'}
              </p>
              {user && (
                <button
                  onClick={() => setIsUploadOpen(true)}
                  className="px-4 py-2 bg-sky-500 hover:bg-sky-600 text-white font-bold rounded-xl text-xs shadow-md shadow-sky-500/20 active:scale-95 transition-all"
                >
                  {isRtl ? 'إضافة أول صورة' : 'Add First Image'}
                </button>
              )}
            </div>
          )}

          {!loading && displayList.length > 0 && (
            <div className="grid grid-cols-2 gap-2.5">
              {displayList.map((item, index) => {
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
                    onClick={() => setViewerIndex(index)}
                    className="group relative rounded-xl overflow-hidden border border-slate-200 dark:border-zinc-800 bg-slate-100 dark:bg-zinc-800/80 aspect-square cursor-pointer hover:shadow-lg hover:border-sky-400 dark:hover:border-sky-500 transition-all select-none"
                  >
                    <img
                      src={item.url}
                      alt={item.title || 'Attachment'}
                      loading="lazy"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                    />

                    {/* Pending review badge */}
                    {item.status === 'pending' && (
                      <div className="absolute top-2 start-2 z-10 px-2 py-0.5 rounded-full text-[9px] font-bold bg-amber-500 text-white shadow-sm flex items-center gap-1">
                        <Clock className="w-2.5 h-2.5" />
                        <span>{isRtl ? 'قيد المراجعة' : 'Pending'}</span>
                      </div>
                    )}

                    {/* Info Overlay */}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent flex flex-col justify-end p-2 text-white">
                      {item.title && (
                        <p className="text-[11px] font-bold truncate text-white leading-tight mb-0.5">
                          {item.title}
                        </p>
                      )}
                      <div className="flex items-center justify-between text-[9px] text-white/80">
                        <span className="flex items-center gap-1 truncate max-w-[90px]">
                          {item.isAnonymous ? (
                            <EyeOff className="w-2.5 h-2.5 text-amber-300 flex-shrink-0" />
                          ) : (
                            <User className="w-2.5 h-2.5 text-sky-300 flex-shrink-0" />
                          )}
                          <span className="truncate">{displayName}</span>
                        </span>
                        <ExternalLink className="w-3 h-3 opacity-80" />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </motion.aside>

      {/* Lightbox / Viewer Modal */}
      {viewerIndex !== null && (
        <AttachmentViewerModal
          isOpen={viewerIndex !== null}
          onClose={() => setViewerIndex(null)}
          attachments={displayList}
          initialIndex={viewerIndex}
          user={user}
          lang={isRtl ? 'ar' : 'en'}
          onDelete={handleDelete}
        />
      )}

      {/* Upload Modal */}
      {isUploadOpen && user && (
        <UploadAttachmentModal
          isOpen={isUploadOpen}
          onClose={() => setIsUploadOpen(false)}
          lecture={lecture}
          user={user}
          lang={isRtl ? 'ar' : 'en'}
          onAttachmentUploaded={() => {
            load();
          }}
        />
      )}
    </>
  );
}
