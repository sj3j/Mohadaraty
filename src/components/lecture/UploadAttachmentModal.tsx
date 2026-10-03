import React, { useState, useRef, useEffect } from 'react';
import {
  X,
  Upload,
  Image as ImageIcon,
  Loader2,
  CheckCircle2,
  AlertCircle,
  EyeOff,
  UserCheck,
  Sparkles,
  Info,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { UserProfile, Language, Lecture } from '../../types';
import { uploadAttachment } from '../../services/lectureAttachmentService';
import { LectureAttachment } from '../../types/lectureAttachment.types';

interface UploadAttachmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  lecture: Lecture;
  user: UserProfile;
  lang: Language;
  onAttachmentUploaded?: (attachment: LectureAttachment) => void;
}

interface StagedAttachment {
  id: string;
  file: File;
  previewUrl: string;
  title: string;
  progress?: number;
  status: 'pending' | 'uploading' | 'done' | 'error';
  error?: string;
}

export default function UploadAttachmentModal({
  isOpen,
  onClose,
  lecture,
  user,
  lang,
  onAttachmentUploaded,
}: UploadAttachmentModalProps) {
  const isRtl = lang === 'ar';
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [stagedFiles, setStagedFiles] = useState<StagedAttachment[]>([]);
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);

  const isStaff =
    user.role === 'admin' ||
    user.role === 'moderator' ||
    Boolean(user.isMasterAdmin);

  // Clean up object URLs on unmount
  useEffect(() => {
    return () => {
      stagedFiles.forEach((item) => {
        if (item.previewUrl) {
          try {
            URL.revokeObjectURL(item.previewUrl);
          } catch {}
        }
      });
    };
  }, [stagedFiles]);

  if (!isOpen) return null;

  const handleFilesChosen = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setGeneralError(null);

    const currentCount = stagedFiles.length;
    const remainingSlots = 5 - currentCount;

    if (remainingSlots <= 0) {
      setGeneralError(isRtl ? 'الحد الأقصى هو 5 صور في المرة الواحدة' : 'Maximum 5 images per upload');
      return;
    }

    const chosen = Array.from(files).slice(0, remainingSlots);
    const validImages = chosen.filter((f) => f.type.startsWith('image/'));

    if (validImages.length === 0) {
      setGeneralError(isRtl ? 'يرجى اختيار ملفات صور فقط (JPG, PNG, WebP)' : 'Please select image files only');
      return;
    }

    const newStaged: StagedAttachment[] = validImages.map((file) => ({
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      file,
      previewUrl: URL.createObjectURL(file),
      title: '',
      status: 'pending',
    }));

    setStagedFiles((prev) => [...prev, ...newStaged]);
  };

  const handleRemoveStaged = (id: string) => {
    setStagedFiles((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((item) => item.id !== id);
    });
  };

  const handleTitleChange = (id: string, title: string) => {
    setStagedFiles((prev) =>
      prev.map((item) => (item.id === id ? { ...item, title } : item))
    );
  };

  const handleUploadAll = async () => {
    if (stagedFiles.length === 0 || isSubmitting) return;
    setIsSubmitting(true);
    setGeneralError(null);

    let hasSuccess = false;

    for (const item of stagedFiles) {
      if (item.status === 'done') continue;

      setStagedFiles((prev) =>
        prev.map((it) => (it.id === item.id ? { ...it, status: 'uploading', progress: 0 } : it))
      );

      try {
        const uploaded = await uploadAttachment({
          lectureId: lecture.id,
          lectureTitle: lecture.title,
          stageId: lecture.stageId || user.stageId || '',
          subjectId: lecture.subjectId,
          file: item.file,
          title: item.title,
          isAnonymous,
          user,
          onProgress: (p) => {
            setStagedFiles((prev) =>
              prev.map((it) => (it.id === item.id ? { ...it, progress: p } : it))
            );
          },
        });

        hasSuccess = true;
        setStagedFiles((prev) =>
          prev.map((it) => (it.id === item.id ? { ...it, status: 'done', progress: 100 } : it))
        );

        onAttachmentUploaded?.(uploaded);
      } catch (err: any) {
        console.error('Failed to upload attachment:', err);
        setStagedFiles((prev) =>
          prev.map((it) =>
            it.id === item.id
              ? { ...it, status: 'error', error: err?.message || 'Upload failed' }
              : it
          )
        );
      }
    }

    setIsSubmitting(false);

    // If all succeeded, close after a brief delay
    const allDone = stagedFiles.every((s) => s.status === 'done');
    if (allDone || hasSuccess) {
      setTimeout(() => {
        onClose();
      }, 700);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm overflow-y-auto"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl sm:rounded-3xl shadow-2xl max-w-lg w-full overflow-hidden flex flex-col my-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-slate-100 dark:border-zinc-800">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-sky-100 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center">
              <ImageIcon className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base sm:text-lg font-bold text-slate-900 dark:text-stone-100">
                {isRtl ? 'إضافة مرفقات للمحاضرة' : 'Add Lecture Attachments'}
              </h3>
              <p className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400 truncate max-w-[240px] sm:max-w-xs">
                {lecture.title}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="p-1.5 rounded-xl hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-4 sm:p-6 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Staff vs Student Notice */}
          <div
            className={`p-3 rounded-xl sm:rounded-2xl border text-xs flex items-start gap-2.5 ${
              isStaff
                ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800/40 text-emerald-800 dark:text-emerald-300'
                : 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800/40 text-amber-800 dark:text-amber-300'
            }`}
          >
            <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div className="leading-relaxed">
              {isStaff ? (
                <span>{isRtl ? 'بصفتك ممثل مرحلة / مشرف، سيتم اعتماد المرفقات ونشرها للجميع فوراً.' : 'As a stage representative, your attachments are approved and published immediately.'}</span>
              ) : (
                <span>
                  {isRtl
                    ? 'سيتم مراجعة الصور واعتمادها من قبل ممثل مرحلتك قبل ظهورها لبقية الطلاب لضمان جودة المحتوى.'
                    : 'Your attachments will be reviewed and approved by your stage representative before being visible to other students.'}
                </span>
              )}
            </div>
          </div>

          {/* Drag & Drop Upload Zone */}
          {stagedFiles.length < 5 && (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                handleFilesChosen(e.dataTransfer.files);
              }}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-2xl p-5 sm:p-6 text-center transition-all cursor-pointer ${
                isDragging
                  ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/20 scale-[0.99]'
                  : 'border-slate-200 dark:border-zinc-700 hover:border-sky-400 dark:hover:border-sky-500 bg-slate-50/50 dark:bg-zinc-800/30'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => handleFilesChosen(e.target.files)}
              />
              <div className="w-12 h-12 rounded-2xl bg-sky-100 dark:bg-sky-900/40 text-sky-600 dark:text-sky-400 mx-auto flex items-center justify-center mb-2.5">
                <Upload className="w-6 h-6" />
              </div>
              <p className="text-sm font-bold text-slate-800 dark:text-stone-200 mb-1">
                {isRtl ? 'انقر لاختيار صور أو اسحبها هنا' : 'Click to select images or drag & drop'}
              </p>
              <p className="text-[11px] text-slate-400 dark:text-slate-500">
                {isRtl ? 'صور سبورة، مخططات، ملخصات (JPG, PNG, WebP) - حتى 5 صور' : 'Board photos, diagrams, notes (JPG, PNG, WebP) - up to 5'}
              </p>
            </div>
          )}

          {generalError && (
            <div className="p-3 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800/40 rounded-xl text-rose-700 dark:text-rose-300 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{generalError}</span>
            </div>
          )}

          {/* Staged Files List */}
          {stagedFiles.length > 0 && (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between text-xs font-bold text-slate-600 dark:text-slate-400">
                <span>{isRtl ? `الصور المختارة (${stagedFiles.length}/5)` : `Selected Images (${stagedFiles.length}/5)`}</span>
                <span className="text-[11px] font-normal text-slate-400">
                  {isRtl ? 'يتم ضغط الصور تلقائياً' : 'Auto-compressed'}
                </span>
              </div>

              <div className="space-y-2">
                {stagedFiles.map((item) => (
                  <div
                    key={item.id}
                    className="p-2 sm:p-2.5 rounded-xl border border-slate-100 dark:border-zinc-800 bg-slate-50/50 dark:bg-zinc-800/40 flex items-center gap-3"
                  >
                    <div className="w-14 h-14 rounded-lg overflow-hidden flex-shrink-0 border border-slate-200 dark:border-zinc-700 relative">
                      <img src={item.previewUrl} alt="" className="w-full h-full object-cover" />
                      {item.status === 'uploading' && (
                        <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                          <Loader2 className="w-4 h-4 text-white animate-spin" />
                        </div>
                      )}
                      {item.status === 'done' && (
                        <div className="absolute inset-0 bg-emerald-600/80 flex items-center justify-center">
                          <CheckCircle2 className="w-5 h-5 text-white" />
                        </div>
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <input
                        type="text"
                        placeholder={isRtl ? 'وصف أو عنوان للصورة (اختياري)...' : 'Optional caption or title...'}
                        value={item.title}
                        onChange={(e) => handleTitleChange(item.id, e.target.value)}
                        disabled={isSubmitting}
                        className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-800 dark:text-stone-200 focus:outline-none focus:ring-1 focus:ring-sky-500"
                      />
                      <div className="flex items-center justify-between mt-1 text-[10px] text-slate-400">
                        <span className="truncate max-w-[150px]">{item.file.name}</span>
                        <span>{(item.file.size / 1024).toFixed(0)} KB</span>
                      </div>
                    </div>

                    {!isSubmitting && item.status !== 'done' && (
                      <button
                        onClick={() => handleRemoveStaged(item.id)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors cursor-pointer"
                        title={isRtl ? 'حذف' : 'Remove'}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Anonymous Upload Toggle */}
          <div className="p-3 bg-slate-50 dark:bg-zinc-800/40 border border-slate-100 dark:border-zinc-800 rounded-xl flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 flex items-center justify-center">
                <EyeOff className="w-4 h-4" />
              </div>
              <div>
                <p className="text-xs font-bold text-slate-800 dark:text-stone-200">
                  {isRtl ? 'رفع بهوية غير معلنة (طالب مجهول)' : 'Upload Anonymously'}
                </p>
                <p className="text-[10px] text-slate-400">
                  {isRtl
                    ? 'يظهر المرفق كـ "طالب مجهول" لزملائك مع بقاء هويتك معلومة للإدارة'
                    : 'Hidden from peers, visible to admins for security'}
                </p>
              </div>
            </div>

            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={isAnonymous}
                onChange={(e) => setIsAnonymous(e.target.checked)}
                disabled={isSubmitting}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-slate-300 dark:bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-sky-600"></div>
            </label>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-4 sm:px-6 border-t border-slate-100 dark:border-zinc-800 flex items-center justify-between gap-3 bg-slate-50/50 dark:bg-zinc-800/30">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            {isRtl ? 'إلغاء' : 'Cancel'}
          </button>

          <button
            type="button"
            onClick={handleUploadAll}
            disabled={stagedFiles.length === 0 || isSubmitting}
            className="px-5 py-2.5 rounded-xl text-xs sm:text-sm font-bold bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-600 hover:to-blue-700 text-white shadow-lg shadow-sky-500/20 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none transition-all flex items-center gap-2 cursor-pointer"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{isRtl ? 'جارِ الضغط والرفع...' : 'Compressing & Uploading...'}</span>
              </>
            ) : (
              <>
                <Upload className="w-4 h-4" />
                <span>{isRtl ? `رفع المرفقات (${stagedFiles.length})` : `Upload (${stagedFiles.length})`}</span>
              </>
            )}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
