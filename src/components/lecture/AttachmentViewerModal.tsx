import React, { useState, useEffect, useCallback } from 'react';
import {
  X,
  ChevronLeft,
  ChevronRight,
  Download,
  Trash2,
  ZoomIn,
  ZoomOut,
  RotateCw,
  User,
  Clock,
  ShieldCheck,
  EyeOff,
  Loader2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { LectureAttachment } from '../../types/lectureAttachment.types';
import { UserProfile, Language } from '../../types';
import { canManage } from '../../lib/permissions';

interface AttachmentViewerModalProps {
  isOpen: boolean;
  onClose: () => void;
  attachments: LectureAttachment[];
  initialIndex?: number;
  user: UserProfile | null;
  lang: Language;
  onDelete?: (attachment: LectureAttachment) => Promise<void>;
}

export default function AttachmentViewerModal({
  isOpen,
  onClose,
  attachments,
  initialIndex = 0,
  user,
  lang,
  onDelete,
}: AttachmentViewerModalProps) {
  const isRtl = lang === 'ar';
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);

  const [imageError, setImageError] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setCurrentIndex(Math.max(0, Math.min(initialIndex, attachments.length - 1)));
      setScale(1);
      setRotation(0);
      setShowConfirmDelete(false);
      setImageError(false);
    }
  }, [isOpen, initialIndex, attachments.length]);

  const current = attachments[currentIndex];

  const handleNext = useCallback(() => {
    if (currentIndex < attachments.length - 1) {
      setCurrentIndex((prev) => prev + 1);
      setScale(1);
      setRotation(0);
      setImageError(false);
    }
  }, [currentIndex, attachments.length]);

  const handlePrev = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex((prev) => prev - 1);
      setScale(1);
      setRotation(0);
      setImageError(false);
    }
  }, [currentIndex]);

  const handleToggleZoom = () => {
    setScale((s) => (s > 1 ? 1 : 2.5));
  };

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowRight') {
        if (isRtl) handlePrev();
        else handleNext();
      } else if (e.key === 'ArrowLeft') {
        if (isRtl) handleNext();
        else handlePrev();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isRtl, handleNext, handlePrev, onClose]);

  if (!isOpen || !current) return null;

  const isStaff =
    user?.role === 'admin' ||
    user?.role === 'moderator' ||
    Boolean(user?.isMasterAdmin) ||
    canManage(user, 'manageLectures');

  const canDeleteCurrent = Boolean(
    isStaff || (user && user.uid === current.uploadedBy)
  );

  const formattedDate = (() => {
    try {
      const time = current.createdAt?.toMillis
        ? current.createdAt.toMillis()
        : current.createdAt || Date.now();
      return new Date(time).toLocaleDateString(isRtl ? 'ar-IQ' : 'en-US', {
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return '';
    }
  })();

  const handleZoomIn = () => setScale((s) => Math.min(s + 0.35, 3.5));
  const handleZoomOut = () => setScale((s) => Math.max(s - 0.35, 0.7));
  const handleRotate = () => setRotation((r) => (r + 90) % 360);

  const handleDelete = async () => {
    if (!onDelete || !current) return;
    setIsDeleting(true);
    try {
      await onDelete(current);
      setShowConfirmDelete(false);
      if (attachments.length <= 1) {
        onClose();
      } else if (currentIndex >= attachments.length - 1) {
        setCurrentIndex((i) => Math.max(0, i - 1));
      }
    } catch (err) {
      console.error('Failed to delete attachment:', err);
    } finally {
      setIsDeleting(false);
    }
  };

  const displayName = current.isAnonymous
    ? isStaff
      ? `${current.uploaderName} (${isRtl ? 'مجهول للعامة' : 'Anonymous'})`
      : isRtl
      ? 'طالب (هوية غير معلنة)'
      : 'Anonymous Student'
    : current.uploaderName || (isRtl ? 'طالب' : 'Student');

  return (
    <AnimatePresence>
      <div
        className="fixed inset-0 z-50 bg-black/95 backdrop-blur-md flex flex-col select-none touch-none"
        dir={isRtl ? 'rtl' : 'ltr'}
      >
        {/* Top Header Controls */}
        <div className="flex items-center justify-between px-3 sm:px-6 py-3.5 bg-gradient-to-b from-black/80 to-transparent text-white z-20">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={onClose}
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 transition-all text-white cursor-pointer"
              title={isRtl ? 'إغلاق' : 'Close'}
            >
              <X className="w-5 h-5" />
            </button>

            <div className="min-w-0">
              <h4 className="text-sm sm:text-base font-bold text-white truncate max-w-[200px] sm:max-w-md">
                {current.title || (isRtl ? `مرفق صورة #${currentIndex + 1}` : `Image #${currentIndex + 1}`)}
              </h4>
              <div className="flex items-center gap-2 text-[11px] sm:text-xs text-white/70">
                <span className="flex items-center gap-1 font-medium">
                  {current.isAnonymous ? (
                    <EyeOff className="w-3 h-3 text-amber-400" />
                  ) : (
                    <User className="w-3 h-3 text-sky-400" />
                  )}
                  {displayName}
                </span>
                {formattedDate && (
                  <span className="flex items-center gap-1 opacity-75">
                    <Clock className="w-3 h-3" />
                    {formattedDate}
                  </span>
                )}
                {(current.subjectNameAr || current.subjectName) && (
                  <span className="px-1.5 py-0.5 rounded bg-emerald-500/30 text-emerald-200 text-[10px] font-bold">
                    {isRtl ? (current.subjectNameAr || current.subjectName) : (current.subjectName || current.subjectNameAr)}
                  </span>
                )}
                {current.lectureTitle && (
                  <span className="text-white/80 font-medium truncate max-w-[150px] sm:max-w-xs">
                    {current.lectureNumber ? `${isRtl ? 'محاضرة ' : 'Lec '}${current.lectureNumber}: ` : ''}
                    {current.lectureTitle}
                  </span>
                )}
                {current.status === 'pending' && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                    {isRtl ? 'بانتظار الموافقة' : 'Pending'}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Right Action Icons */}
          <div className="flex items-center gap-1 sm:gap-2">
            <button
              onClick={handleZoomOut}
              className="p-1.5 sm:p-2 rounded-xl bg-white/10 hover:bg-white/20 text-white transition-all flex cursor-pointer"
              title={isRtl ? 'تصغير' : 'Zoom Out'}
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <button
              onClick={handleZoomIn}
              className="p-1.5 sm:p-2 rounded-xl bg-white/10 hover:bg-white/20 text-white transition-all flex cursor-pointer"
              title={isRtl ? 'تكبير' : 'Zoom In'}
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <button
              onClick={handleRotate}
              className="p-1.5 sm:p-2 rounded-xl bg-white/10 hover:bg-white/20 text-white transition-all cursor-pointer"
              title={isRtl ? 'تدوير 90 درجة' : 'Rotate'}
            >
              <RotateCw className="w-4 h-4" />
            </button>

            <a
              href={current.url}
              target="_blank"
              rel="noopener noreferrer"
              download={current.title || 'lecture_attachment.jpg'}
              className="p-2 rounded-xl bg-white/10 hover:bg-white/20 text-white transition-all cursor-pointer flex items-center justify-center"
              title={isRtl ? 'تنزيل الصورة' : 'Download'}
            >
              <Download className="w-4 h-4" />
            </a>

            {canDeleteCurrent && (
              <button
                onClick={() => setShowConfirmDelete(true)}
                className="p-2 rounded-xl bg-rose-500/20 hover:bg-rose-500/40 text-rose-300 transition-all cursor-pointer"
                title={isRtl ? 'حذف المرفق' : 'Delete'}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Delete Confirmation Banner */}
        {showConfirmDelete && (
          <div className="bg-rose-900/90 text-white px-4 py-2.5 flex items-center justify-between gap-3 text-xs sm:text-sm z-30 animate-in fade-in">
            <span>{isRtl ? 'هل أنت متأكد من حذف هذه الصورة نهائياً؟' : 'Are you sure you want to permanently delete this attachment?'}</span>
            <div className="flex items-center gap-2">
              <button
                onClick={handleDelete}
                disabled={isDeleting}
                className="px-3 py-1 bg-white text-rose-900 font-bold rounded-lg hover:bg-rose-50 cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
              >
                {isDeleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {isRtl ? 'تأكيد الحذف' : 'Confirm'}
              </button>
              <button
                onClick={() => setShowConfirmDelete(false)}
                className="px-3 py-1 bg-white/20 hover:bg-white/30 text-white font-medium rounded-lg cursor-pointer"
              >
                {isRtl ? 'إلغاء' : 'Cancel'}
              </button>
            </div>
          </div>
        )}

        {/* Center Viewer Area */}
        <div className="flex-1 relative flex items-center justify-center overflow-hidden p-2 sm:p-6">
          {/* Navigation Arrows */}
          {attachments.length > 1 && (
            <>
              <button
                onClick={handlePrev}
                disabled={currentIndex === 0}
                className={`absolute ${isRtl ? 'right-2 sm:right-6' : 'left-2 sm:left-6'} z-20 p-2.5 sm:p-3 rounded-full bg-black/60 hover:bg-black/90 text-white border border-white/10 disabled:opacity-20 disabled:pointer-events-none transition-all shadow-xl cursor-pointer`}
              >
                {isRtl ? <ChevronRight className="w-5 h-5 sm:w-6 sm:h-6" /> : <ChevronLeft className="w-5 h-5 sm:w-6 sm:h-6" />}
              </button>

              <button
                onClick={handleNext}
                disabled={currentIndex === attachments.length - 1}
                className={`absolute ${isRtl ? 'left-2 sm:left-6' : 'right-2 sm:right-6'} z-20 p-2.5 sm:p-3 rounded-full bg-black/60 hover:bg-black/90 text-white border border-white/10 disabled:opacity-20 disabled:pointer-events-none transition-all shadow-xl cursor-pointer`}
              >
                {isRtl ? <ChevronLeft className="w-5 h-5 sm:w-6 sm:h-6" /> : <ChevronRight className="w-5 h-5 sm:w-6 sm:h-6" />}
              </button>
            </>
          )}

          {/* Active Image */}
          <div className="w-full h-full flex items-center justify-center">
            {imageError ? (
              <div className="text-center p-6 bg-white/5 rounded-2xl border border-white/10 max-w-xs text-white/80">
                <p className="text-sm font-bold mb-1">
                  {isRtl ? 'تعذر تحميل الصورة' : 'Could not load image'}
                </p>
                <p className="text-xs text-white/60 mb-3">
                  {isRtl ? 'يرجى التحقق من اتصال الإنترنت' : 'Please check your internet connection'}
                </p>
                <button
                  onClick={() => setImageError(false)}
                  className="px-3 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-600 text-white text-xs font-bold transition-all cursor-pointer"
                >
                  {isRtl ? 'إعادة المحاولة' : 'Retry'}
                </button>
              </div>
            ) : (
              <motion.img
                key={current.id}
                src={current.url}
                alt={current.title || 'Attachment'}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale }}
                transition={{ duration: 0.2 }}
                onDoubleClick={handleToggleZoom}
                onError={() => setImageError(true)}
                style={{
                  transform: `scale(${scale}) rotate(${rotation}deg)`,
                  maxHeight: '100%',
                  maxWidth: '100%',
                  objectFit: 'contain',
                }}
                className="rounded-lg shadow-2xl transition-transform duration-150 cursor-pointer"
              />
            )}
          </div>
        </div>

        {/* Bottom Thumbnail Strip */}
        {attachments.length > 1 && (
          <div className="py-3 px-4 bg-gradient-to-t from-black/90 to-transparent flex items-center justify-center gap-2 overflow-x-auto z-20 max-w-full">
            {attachments.map((item, idx) => (
              <button
                key={item.id}
                onClick={() => {
                  setCurrentIndex(idx);
                  setScale(1);
                  setRotation(0);
                }}
                className={`relative w-12 h-12 sm:w-16 sm:h-16 rounded-xl overflow-hidden flex-shrink-0 border-2 transition-all cursor-pointer ${
                  idx === currentIndex
                    ? 'border-sky-400 scale-105 shadow-lg shadow-sky-500/30'
                    : 'border-white/20 opacity-50 hover:opacity-100'
                }`}
              >
                <img src={item.url} alt="" className="w-full h-full object-cover" />
                {item.status === 'pending' && (
                  <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-amber-400" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </AnimatePresence>
  );
}
