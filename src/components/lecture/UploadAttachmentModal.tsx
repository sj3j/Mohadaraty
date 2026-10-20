import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Upload,
  Image as ImageIcon,
  FileText,
  Loader2,
  CheckCircle2,
  AlertCircle,
  EyeOff,
  UserCheck,
  Sparkles,
  Info,
  RefreshCw,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { UserProfile, Language, Lecture } from '../../types';
import { uploadAttachment } from '../../services/lectureAttachmentService';
import { LectureAttachment } from '../../types/lectureAttachment.types';
import { legacyCategoryLabel } from '../../lib/subjectDisplay';
import { canManageLectures } from '../../lib/permissions';
import { hasStageCapability } from '../../../shared/staffCapabilities';
import { loadPdfjs, PDFJS_DOC_OPTIONS, freshBytes } from '../../lib/pdfjs';

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
  fileType: 'image' | 'pdf';
  previewUrl: string;
  title: string;
  progress?: number;
  status: 'pending' | 'uploading' | 'done' | 'error';
  error?: string;
}

/**
 * Generate a fast page 1 preview for staged PDFs client-side.
 */
async function generateLocalPdfPreview(file: File): Promise<string | null> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({
      data: freshBytes(arrayBuffer),
      ...PDFJS_DOC_OPTIONS,
    }).promise;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 0.4 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      await page.render({ canvasContext: ctx, viewport: vp, canvas: null as any }).promise;
      const url = canvas.toDataURL('image/jpeg', 0.8);
      try { (doc as any)?.destroy?.(); } catch {}
      return url;
    }
    try { (doc as any)?.destroy?.(); } catch {}
  } catch (err) {
    console.warn('[UploadAttachmentModal] PDF local preview failed:', err);
  }
  return null;
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
  const [isFree, setIsFree] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  const resolvedStageId = (lecture.stageId || user.managedStageId || user.stageId || '').trim();
  const isStaff = hasStageCapability(user as any, 'manageLectures', resolvedStageId);

  // Clean up object URLs on unmount
  useEffect(() => {
    return () => {
      stagedFiles.forEach((item) => {
        if (item.previewUrl && item.previewUrl.startsWith('blob:')) {
          try {
            URL.revokeObjectURL(item.previewUrl);
          } catch {}
        }
      });
    };
  }, [stagedFiles]);

  if (!isOpen) return null;

  const handleFilesChosen = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setGeneralError(null);

    const currentCount = stagedFiles.length;
    const remainingSlots = 5 - currentCount;

    if (remainingSlots <= 0) {
      setGeneralError(isRtl ? 'الحد الأقصى هو 5 مرفقات في المرة الواحدة' : 'Maximum 5 files per upload');
      return;
    }

    const chosen = Array.from(files).slice(0, remainingSlots);
    const valid = chosen.filter(
      (f) => f.type.startsWith('image/') || f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
    );

    if (valid.length === 0) {
      setGeneralError(isRtl ? 'يرجى اختيار صور (JPG, PNG) أو ملفات PDF (ملخصات، ترجمات)' : 'Please select image files or PDF documents');
      return;
    }

    const newStaged: StagedAttachment[] = [];
    for (const file of valid) {
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      if (isPdf && file.size > 30 * 1024 * 1024) {
        setGeneralError(isRtl ? `الملف ${file.name} يتجاوز الحد الأقصى (30 ميغابايت)` : `File ${file.name} exceeds 30MB limit`);
        continue;
      }

      let previewUrl = '';
      if (isPdf) {
        previewUrl = (await generateLocalPdfPreview(file)) || '';
      } else {
        previewUrl = URL.createObjectURL(file);
      }

      newStaged.push({
        id: `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        file,
        fileType: isPdf ? 'pdf' : 'image',
        previewUrl,
        title: '',
        status: 'pending',
      });
    }

    setStagedFiles((prev) => [...prev, ...newStaged]);
  };

  const handleRemoveStaged = (id: string) => {
    setStagedFiles((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.previewUrl && target.previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter((item) => item.id !== id);
    });
  };

  const handleTitleChange = (id: string, title: string) => {
    setStagedFiles((prev) =>
      prev.map((item) => (item.id === id ? { ...item, title } : item))
    );
  };

  const uploadSingleItem = async (item: StagedAttachment): Promise<boolean> => {
    setStagedFiles((prev) =>
      prev.map((it) => (it.id === item.id ? { ...it, status: 'uploading', progress: 0, error: undefined } : it))
    );

    try {
      const subjectNameArResolved =
        lecture.subjectNameAr ||
        legacyCategoryLabel(lecture.subjectId || lecture.category || '', 'ar') ||
        lecture.subjectName ||
        '';
      const subjectNameEnResolved =
        lecture.subjectName ||
        legacyCategoryLabel(lecture.subjectId || lecture.category || '', 'en') ||
        lecture.subjectNameAr ||
        '';

      const uploaded = await uploadAttachment({
        lectureId: lecture.id,
        lectureTitle: lecture.title,
        lectureNumber: lecture.number,
        stageId: resolvedStageId,
        subjectId: lecture.subjectId,
        subjectName: subjectNameEnResolved,
        subjectNameAr: subjectNameArResolved,
        file: item.file,
        title: item.title,
        isAnonymous,
        isFree: isStaff ? isFree : false,
        user,
        onProgress: (p) => {
          setStagedFiles((prev) =>
            prev.map((it) => (it.id === item.id ? { ...it, progress: p } : it))
          );
        },
      });

      setStagedFiles((prev) =>
        prev.map((it) => (it.id === item.id ? { ...it, status: 'done', progress: 100 } : it))
      );

      onAttachmentUploaded?.(uploaded);
      return true;
    } catch (err: any) {
      console.error('[UploadAttachmentModal] Upload failed:', err);
      const errMsg = err?.message || (isRtl ? 'تعذر رفع الملف' : 'Upload failed');
      setStagedFiles((prev) =>
        prev.map((it) => (it.id === item.id ? { ...it, status: 'error', error: errMsg } : it))
      );
      return false;
    }
  };

  const handleUploadAll = async () => {
    const toUpload = stagedFiles.filter((it) => it.status !== 'done');
    if (toUpload.length === 0) return;

    setIsSubmitting(true);
    setGeneralError(null);

    let successes = 0;
    for (const item of toUpload) {
      const ok = await uploadSingleItem(item);
      if (ok) successes++;
    }

    setIsSubmitting(false);

    if (successes > 0) {
      setSuccessToast(
        isStaff
          ? isRtl
            ? `تم اعتماد ونشر ${successes} مرفق(ات) بنجاح!`
            : `Successfully published ${successes} attachment(s)!`
          : isRtl
          ? `تم إرسال ${successes} مرفق(ات) للمراجعة من قبل ممثل مرحلتك!`
          : `Sent ${successes} attachment(s) for review!`
      );
      setTimeout(() => {
        onClose();
      }, 1400);
    }
  };

  const handleRetryItem = (id: string) => {
    const item = stagedFiles.find((it) => it.id === id);
    if (item) {
      uploadSingleItem(item);
    }
  };

  const modalContent = (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm overflow-y-auto"
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
              <Upload className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base sm:text-lg font-bold text-slate-900 dark:text-stone-100">
                {isRtl ? 'إضافة مرفقات وملخصات للمحاضرة' : 'Add Attachments & Summaries'}
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
                    ? 'سيتم مراجعة المرفقات واعتمادها من قبل ممثل مرحلتك قبل ظهورها لبقية الطلاب لضمان جودة المحتوى.'
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
                accept="image/*,application/pdf"
                multiple
                className="hidden"
                onChange={(e) => handleFilesChosen(e.target.files)}
              />
              <div className="w-12 h-12 rounded-2xl bg-sky-100 dark:bg-sky-900/40 text-sky-600 dark:text-sky-400 mx-auto flex items-center justify-center mb-2.5">
                <Upload className="w-6 h-6" />
              </div>
              <p className="text-sm font-bold text-slate-800 dark:text-stone-200 mb-1">
                {isRtl ? 'انقر لاختيار صور أو ملفات PDF أو اسحبها هنا' : 'Click to select images or PDFs or drag & drop'}
              </p>
              <p className="text-[11px] text-slate-400 dark:text-slate-500">
                {isRtl ? 'صور سبورة، ملخصات، أو ملفات PDF مترجمة (حتى 30 ميغابايت) - 5 كحد أقصى' : 'Board photos, diagrams, summaries or translated PDFs (up to 30MB) - up to 5'}
              </p>
            </div>
          )}

          {successToast && (
            <div className="p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/40 rounded-xl text-emerald-700 dark:text-emerald-300 text-xs flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-emerald-500" />
              <span className="font-bold">{successToast}</span>
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
                <span>{isRtl ? `المرفقات المختارة (${stagedFiles.length}/5)` : `Selected Attachments (${stagedFiles.length}/5)`}</span>
                <span className="text-[11px] font-normal text-slate-400">
                  {isRtl ? 'ملخصات، ترجمات، وصور' : 'Summaries, translations, & photos'}
                </span>
              </div>

              <div className="space-y-2">
                {stagedFiles.map((item) => (
                  <div
                    key={item.id}
                    className={`p-2.5 rounded-xl border bg-slate-50/50 dark:bg-zinc-800/40 flex items-start gap-3 transition-colors ${
                      item.status === 'error'
                        ? 'border-rose-300 dark:border-rose-800/60 bg-rose-50/20'
                        : 'border-slate-100 dark:border-zinc-800'
                    }`}
                  >
                    <div className="w-14 h-14 rounded-lg overflow-hidden flex-shrink-0 border border-slate-200 dark:border-zinc-700 relative bg-slate-100 dark:bg-zinc-800 flex items-center justify-center">
                      {item.previewUrl ? (
                        <img src={item.previewUrl} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <FileText className="w-7 h-7 text-rose-500" />
                      )}

                      {item.fileType === 'pdf' && (
                        <span className="absolute top-1 right-1 px-1 py-0.2 rounded text-[7px] font-black uppercase bg-rose-600 text-white shadow-xs">
                          PDF
                        </span>
                      )}

                      {item.status === 'uploading' && (
                        <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center text-white">
                          <Loader2 className="w-4 h-4 text-white animate-spin mb-0.5" />
                          <span className="text-[9px] font-bold">{item.progress ?? 0}%</span>
                        </div>
                      )}
                      {item.status === 'done' && (
                        <div className="absolute inset-0 bg-emerald-600/80 flex items-center justify-center">
                          <CheckCircle2 className="w-5 h-5 text-white" />
                        </div>
                      )}
                      {item.status === 'error' && (
                        <div className="absolute inset-0 bg-rose-600/80 flex items-center justify-center">
                          <AlertCircle className="w-5 h-5 text-white" />
                        </div>
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <input
                        type="text"
                        placeholder={isRtl ? 'عنوان أو وصف للمرفق (مثال: ترجمة، ملخص)...' : 'Attachment title (e.g. Translation, Summary)...'}
                        value={item.title}
                        onChange={(e) => handleTitleChange(item.id, e.target.value)}
                        disabled={isSubmitting || item.status === 'done'}
                        className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-800 dark:text-stone-200 focus:outline-none focus:ring-1 focus:ring-sky-500"
                      />

                      {/* Quick Title Presets */}
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {[
                          isRtl ? 'ترجمة المحاضرة' : 'Lecture Translation',
                          isRtl ? 'تلخيص المحاضرة' : 'Lecture Summary',
                          isRtl ? 'ملاحظات وأسئلة' : 'Notes & Questions',
                        ].map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            onClick={() => handleTitleChange(item.id, preset)}
                            disabled={isSubmitting || item.status === 'done'}
                            className="text-[9px] px-2 py-0.5 rounded-md bg-slate-100 dark:bg-zinc-800 hover:bg-sky-100 dark:hover:bg-sky-900/40 text-slate-600 dark:text-stone-300 hover:text-sky-600 transition-colors cursor-pointer"
                          >
                            + {preset}
                          </button>
                        ))}
                      </div>

                      {item.status === 'error' && (
                        <p className="mt-1 text-[11px] text-rose-600 dark:text-rose-400 font-semibold flex items-center gap-1">
                          <AlertCircle className="w-3 h-3 flex-shrink-0" />
                          <span className="truncate">{item.error || (isRtl ? 'فشل الرفع' : 'Upload failed')}</span>
                        </p>
                      )}
                      <div className="flex items-center justify-between mt-1 text-[10px] text-slate-400">
                        <span className="truncate max-w-[150px]">{item.file.name}</span>
                        <span>{(item.file.size / (1024 * 1024)).toFixed(1)} MB</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1">
                      {!isSubmitting && item.status === 'error' && (
                        <button
                          type="button"
                          onClick={() => handleRetryItem(item.id)}
                          className="p-1.5 rounded-lg text-sky-600 hover:text-sky-700 hover:bg-sky-50 dark:hover:bg-sky-950/40 transition-colors cursor-pointer"
                          title={isRtl ? 'إعادة المحاولة' : 'Retry'}
                        >
                          <RefreshCw className="w-4 h-4" />
                        </button>
                      )}

                      {!isSubmitting && item.status !== 'done' && (
                        <button
                          type="button"
                          onClick={() => handleRemoveStaged(item.id)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors cursor-pointer"
                          title={isRtl ? 'حذف' : 'Remove'}
                        >
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>
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

          {/* Admin Free Attachment Toggle */}
          {isStaff && (
            <div className="p-3 bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200/70 dark:border-emerald-800/40 rounded-xl flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/50 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
                  <Sparkles className="w-4 h-4" />
                </div>
                <div>
                  <p className="text-xs font-bold text-slate-800 dark:text-stone-200 flex items-center gap-1.5">
                    <span>{isRtl ? 'مرفق مجاني لجميع الطلاب' : 'Free for all students'}</span>
                    <span className="text-[9px] px-1.5 py-0.2 rounded font-black bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300">
                      {isRtl ? 'مجاني' : 'FREE'}
                    </span>
                  </p>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400">
                    {isRtl
                      ? 'يمكن للطلاب غير المشتركين فتح وقراءة هذا المرفق مجاناً بدون حجب'
                      : 'Non-subscribers can view and read this attachment without paywall'}
                  </p>
                </div>
              </div>

              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={isFree}
                  onChange={(e) => setIsFree(e.target.checked)}
                  disabled={isSubmitting}
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-slate-300 dark:bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-600"></div>
              </label>
            </div>
          )}
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
                <span>{isRtl ? 'جارِ المعالجة والرفع...' : 'Processing & Uploading...'}</span>
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

  return typeof document !== 'undefined' ? createPortal(modalContent, document.body) : modalContent;
}
