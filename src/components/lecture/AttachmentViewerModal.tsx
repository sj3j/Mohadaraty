import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
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
  EyeOff,
  Loader2,
  Maximize2,
} from 'lucide-react';
import { AnimatePresence } from 'motion/react';
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
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [imageError, setImageError] = useState(false);

  // Gesture and viewport references
  const viewerAreaRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const posStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const pinchStartDistRef = useRef<number>(0);
  const pinchStartScaleRef = useRef<number>(1);
  const pinchStartPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const pinchCenterRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Reset viewport state when opening or switching index
  useEffect(() => {
    if (isOpen) {
      setCurrentIndex(Math.max(0, Math.min(initialIndex, attachments.length - 1)));
      setScale(1);
      setPosition({ x: 0, y: 0 });
      setRotation(0);
      setShowConfirmDelete(false);
      setImageError(false);
    }
  }, [isOpen, initialIndex, attachments.length]);

  const current = attachments[currentIndex];

  // Boundary clamping so the image is freely exploreable but doesn't get lost off-screen
  const clampPosition = useCallback((pos: { x: number; y: number }, targetScale: number) => {
    if (targetScale <= 1) return { x: 0, y: 0 };
    const area = viewerAreaRef.current;
    const w = area?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 800);
    const h = area?.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 600);
    const maxPanX = Math.max(0, ((w * targetScale) - w) / 2 + 100);
    const maxPanY = Math.max(0, ((h * targetScale) - h) / 2 + 100);
    return {
      x: Math.min(maxPanX, Math.max(-maxPanX, pos.x)),
      y: Math.min(maxPanY, Math.max(-maxPanY, pos.y)),
    };
  }, []);

  const handleResetZoom = useCallback(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
    setRotation(0);
  }, []);

  const handleZoomIn = useCallback(() => {
    setScale((s) => Math.min(+(s + 0.4).toFixed(2), 5));
  }, []);

  const handleZoomOut = useCallback(() => {
    setScale((s) => {
      const next = Math.max(+(s - 0.4).toFixed(2), 1);
      if (next === 1) {
        setPosition({ x: 0, y: 0 });
      } else {
        setPosition((pos) => clampPosition(pos, next));
      }
      return next;
    });
  }, [clampPosition]);

  const handleRotate = useCallback(() => {
    setRotation((r) => (r + 90) % 360);
  }, []);

  const handleToggleZoom = useCallback((clientX?: number, clientY?: number) => {
    if (scale > 1) {
      setScale(1);
      setPosition({ x: 0, y: 0 });
    } else {
      const targetScale = 2.5;
      const area = viewerAreaRef.current;
      if (area && clientX !== undefined && clientY !== undefined) {
        const rect = area.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const dx = clientX - centerX;
        const dy = clientY - centerY;
        const targetX = -dx * (targetScale - 1);
        const targetY = -dy * (targetScale - 1);
        setScale(targetScale);
        setPosition(clampPosition({ x: targetX, y: targetY }, targetScale));
      } else {
        setScale(targetScale);
        setPosition({ x: 0, y: 0 });
      }
    }
  }, [scale, clampPosition]);

  const handleNext = useCallback(() => {
    if (currentIndex < attachments.length - 1) {
      setCurrentIndex((prev) => prev + 1);
      setScale(1);
      setPosition({ x: 0, y: 0 });
      setRotation(0);
      setImageError(false);
    }
  }, [currentIndex, attachments.length]);

  const handlePrev = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex((prev) => prev - 1);
      setScale(1);
      setPosition({ x: 0, y: 0 });
      setRotation(0);
      setImageError(false);
    }
  }, [currentIndex]);

  // Mouse wheel focal zoom (centered on cursor)
  useEffect(() => {
    const area = viewerAreaRef.current;
    if (!area || !isOpen) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = area.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const mouseX = e.clientX - centerX;
      const mouseY = e.clientY - centerY;

      const factor = e.deltaY < 0 ? 1.15 : 0.85;

      setScale((prevScale) => {
        const nextScale = Math.min(5, Math.max(1, +(prevScale * factor).toFixed(2)));
        if (nextScale <= 1) {
          setPosition({ x: 0, y: 0 });
          return 1;
        }

        setPosition((prevPos) => {
          const ratio = nextScale / prevScale;
          const nextX = mouseX - (mouseX - prevPos.x) * ratio;
          const nextY = mouseY - (mouseY - prevPos.y) * ratio;
          return clampPosition({ x: nextX, y: nextY }, nextScale);
        });

        return nextScale;
      });
    };

    area.addEventListener('wheel', handleWheel, { passive: false });
    return () => area.removeEventListener('wheel', handleWheel);
  }, [isOpen, clampPosition]);

  // Pointer drag and multi-touch pinch
  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    (e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size === 1) {
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      posStartRef.current = { ...position };
      if (scale > 1) {
        setIsDragging(true);
      }
    } else if (pointersRef.current.size === 2) {
      const pts = Array.from(pointersRef.current.values());
      pinchStartDistRef.current = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchStartScaleRef.current = scale;
      pinchStartPosRef.current = { ...position };
      pinchCenterRef.current = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2,
      };
      setIsDragging(true);
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size === 1 && scale > 1) {
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      const targetPos = {
        x: posStartRef.current.x + dx,
        y: posStartRef.current.y + dy,
      };
      setPosition(clampPosition(targetPos, scale));
    } else if (pointersRef.current.size === 2 && pinchStartDistRef.current > 0) {
      const pts = Array.from(pointersRef.current.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const ratio = dist / pinchStartDistRef.current;
      const newScale = Math.min(5, Math.max(1, +(pinchStartScaleRef.current * ratio).toFixed(2)));
      setScale(newScale);

      const currentCenter = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2,
      };
      const dx = currentCenter.x - pinchCenterRef.current.x;
      const dy = currentCenter.y - pinchCenterRef.current.y;
      setPosition(clampPosition({
        x: pinchStartPosRef.current.x + dx,
        y: pinchStartPosRef.current.y + dy,
      }, newScale));
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    try {
      (e.currentTarget as HTMLElement)?.releasePointerCapture?.(e.pointerId);
    } catch {}
    pointersRef.current.delete(e.pointerId);

    if (pointersRef.current.size === 0) {
      setIsDragging(false);
      if (scale <= 1) {
        setPosition({ x: 0, y: 0 });
      } else {
        setPosition((pos) => clampPosition(pos, scale));
      }
    } else if (pointersRef.current.size === 1) {
      const remaining = Array.from(pointersRef.current.values())[0];
      dragStartRef.current = { x: remaining.x, y: remaining.y };
      posStartRef.current = { ...position };
    }
  };

  // Keyboard navigation & shortcuts
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
      } else if (e.key === '+' || e.key === '=') {
        handleZoomIn();
      } else if (e.key === '-' || e.key === '_') {
        handleZoomOut();
      } else if (e.key === '0' || e.key.toLowerCase() === 'r') {
        handleResetZoom();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isRtl, handleNext, handlePrev, handleZoomIn, handleZoomOut, handleResetZoom, onClose]);

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

  const modalContent = (
    <AnimatePresence>
      <div
        className="fixed inset-0 z-[220] bg-black/95 backdrop-blur-md flex flex-col select-none touch-none"
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
              disabled={scale <= 1}
              className="p-1.5 sm:p-2 rounded-xl bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:pointer-events-none text-white transition-all flex cursor-pointer"
              title={isRtl ? 'تصغير (-)' : 'Zoom Out (-)'}
            >
              <ZoomOut className="w-4 h-4" />
            </button>

            {/* Quick Zoom level reset pill */}
            <button
              onClick={handleResetZoom}
              className={`px-2 py-1 sm:px-2.5 sm:py-1 rounded-xl text-xs font-mono font-bold transition-all flex items-center gap-1 cursor-pointer ${
                scale > 1 || rotation !== 0
                  ? 'bg-sky-500 text-white shadow-md shadow-sky-500/30 hover:bg-sky-600'
                  : 'bg-white/10 hover:bg-white/20 text-white/80'
              }`}
              title={isRtl ? 'إعادة ضبط الحجم (100%)' : 'Reset Zoom (100%)'}
            >
              <Maximize2 className="w-3.5 h-3.5" />
              <span>{Math.round(scale * 100)}%</span>
            </button>

            <button
              onClick={handleZoomIn}
              disabled={scale >= 5}
              className="p-1.5 sm:p-2 rounded-xl bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:pointer-events-none text-white transition-all flex cursor-pointer"
              title={isRtl ? 'تكبير (+)' : 'Zoom In (+)'}
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
        <div
          ref={viewerAreaRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className="flex-1 relative flex items-center justify-center overflow-hidden p-2 sm:p-6 touch-none"
          style={{
            cursor: scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'zoom-in',
          }}
        >
          {/* Navigation Arrows */}
          {attachments.length > 1 && (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handlePrev();
                }}
                disabled={currentIndex === 0}
                className={`absolute ${isRtl ? 'right-2 sm:right-6' : 'left-2 sm:left-6'} z-20 p-2.5 sm:p-3 rounded-full bg-black/60 hover:bg-black/90 text-white border border-white/10 disabled:opacity-20 disabled:pointer-events-none transition-all shadow-xl cursor-pointer`}
              >
                {isRtl ? <ChevronRight className="w-5 h-5 sm:w-6 sm:h-6" /> : <ChevronLeft className="w-5 h-5 sm:w-6 sm:h-6" />}
              </button>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleNext();
                }}
                disabled={currentIndex === attachments.length - 1}
                className={`absolute ${isRtl ? 'left-2 sm:left-6' : 'right-2 sm:right-6'} z-20 p-2.5 sm:p-3 rounded-full bg-black/60 hover:bg-black/90 text-white border border-white/10 disabled:opacity-20 disabled:pointer-events-none transition-all shadow-xl cursor-pointer`}
              >
                {isRtl ? <ChevronLeft className="w-5 h-5 sm:w-6 sm:h-6" /> : <ChevronRight className="w-5 h-5 sm:w-6 sm:h-6" />}
              </button>
            </>
          )}

          {/* Active Image Container with Free Zoom & Pan */}
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
              <div
                style={{
                  transform: `translate3d(${position.x}px, ${position.y}px, 0) scale(${scale}) rotate(${rotation}deg)`,
                  transformOrigin: 'center center',
                  willChange: 'transform',
                  transition: isDragging ? 'none' : 'transform 0.15s cubic-bezier(0.2, 0, 0.2, 1)',
                }}
                className="max-w-full max-h-full flex items-center justify-center select-none"
                onDoubleClick={(e) => handleToggleZoom(e.clientX, e.clientY)}
              >
                <img
                  key={current.id}
                  src={current.url}
                  alt={current.title || 'Attachment'}
                  draggable={false}
                  onError={() => setImageError(true)}
                  className="max-w-full max-h-full object-contain rounded-lg shadow-2xl pointer-events-none select-none"
                />
              </div>
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
                  setPosition({ x: 0, y: 0 });
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

  return typeof document !== 'undefined' ? createPortal(modalContent, document.body) : modalContent;
}
