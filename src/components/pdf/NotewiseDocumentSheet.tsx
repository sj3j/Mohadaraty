import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  FileText, Share2, Download, Paperclip, Hash, Bookmark, Sparkles,
  Moon, Sun, X, ChevronRight, ChevronLeft, Globe,
} from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  lectureTitle: string;
  pageCount: number;
  currentPage: number;
  notesCount: number;
  attachmentsCount: number;
  isNightMode: boolean;
  isRtl: boolean;
  onToggleNightMode: () => void;
  onShare: () => void;
  onExportNotes: () => void;
  onExportPdf?: () => void;
  onOpenAttachments: () => void;
  onOpenNotes: () => void;
  onOpenTranslation?: () => void;
  onOpenSimosan?: () => void;
  onOpenPageJump: () => void;
  simosanAvailable?: boolean;
}

export const NotewiseDocumentSheet: React.FC<Props> = ({
  isOpen,
  onClose,
  lectureTitle,
  pageCount,
  currentPage,
  notesCount,
  attachmentsCount,
  isNightMode,
  isRtl,
  onToggleNightMode,
  onShare,
  onExportNotes,
  onExportPdf,
  onOpenAttachments,
  onOpenNotes,
  onOpenTranslation,
  onOpenSimosan,
  onOpenPageJump,
  simosanAvailable,
}) => {
  const ChevronIcon = isRtl ? ChevronLeft : ChevronRight;

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center pointer-events-auto">
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
          />

          {/* Sheet */}
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 28, stiffness: 300 }}
            className="relative w-full max-w-lg bg-white dark:bg-zinc-900 rounded-t-3xl shadow-2xl p-5 pb-8 border-t border-zinc-200 dark:border-zinc-800"
            style={{ paddingBottom: 'max(2rem, env(safe-area-inset-bottom, 2rem))' }}
          >
            {/* Grab handle */}
            <div className="w-10 h-1.5 bg-zinc-300 dark:bg-zinc-700 rounded-full mx-auto mb-4" />

            {/* Document Info Card */}
            <div className="flex items-center gap-3.5 p-3.5 bg-slate-50 dark:bg-zinc-800/60 rounded-2xl mb-5 border border-zinc-200/60 dark:border-zinc-800">
              <div className="w-12 h-14 bg-gradient-to-br from-indigo-500 to-indigo-700 rounded-xl flex items-center justify-center text-white shadow-md shadow-indigo-500/20 flex-shrink-0">
                <FileText className="w-6 h-6" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100 truncate">
                  {lectureTitle || (isRtl ? 'محاضرة بدون عنوان' : 'Untitled Lecture')}
                </h3>
                <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
                  {pageCount} {isRtl ? 'صفحة' : 'pages'} • {isRtl ? `الصفحة الحالية: ${currentPage}` : `Current page: ${currentPage}`}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200 hover:bg-slate-200/50 dark:hover:bg-zinc-700 transition-all"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 5 Quick Actions Grid */}
            <div className="grid grid-cols-5 gap-2 mb-5">
              <button
                type="button"
                onClick={() => { onClose(); onShare(); }}
                className="flex flex-col items-center justify-center p-2.5 rounded-2xl bg-slate-50 dark:bg-zinc-800/60 hover:bg-slate-100 dark:hover:bg-zinc-800 active:scale-95 transition-all group"
              >
                <div className="w-9 h-9 rounded-full bg-blue-500/10 dark:bg-blue-400/10 text-blue-600 dark:text-blue-400 flex items-center justify-center mb-1 group-hover:scale-105 transition-transform">
                  <Share2 className="w-4 h-4" />
                </div>
                <span className="text-[10px] font-medium text-slate-700 dark:text-zinc-300">
                  {isRtl ? 'مشاركة' : 'Share'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => { onClose(); onExportNotes(); }}
                className="flex flex-col items-center justify-center p-2.5 rounded-2xl bg-slate-50 dark:bg-zinc-800/60 hover:bg-slate-100 dark:hover:bg-zinc-800 active:scale-95 transition-all group"
              >
                <div className="w-9 h-9 rounded-full bg-emerald-500/10 dark:bg-emerald-400/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mb-1 group-hover:scale-105 transition-transform">
                  <Download className="w-4 h-4" />
                </div>
                <span className="text-[10px] font-medium text-slate-700 dark:text-zinc-300">
                  {isRtl ? 'تصدير' : 'Export'}
                </span>
              </button>

              {onOpenTranslation && (
                <button
                  type="button"
                  onClick={() => { onClose(); onOpenTranslation(); }}
                  className="flex flex-col items-center justify-center p-2.5 rounded-2xl bg-slate-50 dark:bg-zinc-800/60 hover:bg-slate-100 dark:hover:bg-zinc-800 active:scale-95 transition-all group"
                >
                  <div className="w-9 h-9 rounded-full bg-sky-500/10 dark:bg-sky-400/10 text-sky-600 dark:text-sky-400 flex items-center justify-center mb-1 group-hover:scale-105 transition-transform">
                    <Globe className="w-4 h-4" />
                  </div>
                  <span className="text-[10px] font-medium text-slate-700 dark:text-zinc-300">
                    {isRtl ? 'ترجمة' : 'Translate'}
                  </span>
                </button>
              )}

              <button
                type="button"
                onClick={() => { onClose(); onOpenAttachments(); }}
                className="flex flex-col items-center justify-center p-2.5 rounded-2xl bg-slate-50 dark:bg-zinc-800/60 hover:bg-slate-100 dark:hover:bg-zinc-800 active:scale-95 transition-all group relative"
              >
                <div className="w-9 h-9 rounded-full bg-violet-500/10 dark:bg-violet-400/10 text-violet-600 dark:text-violet-400 flex items-center justify-center mb-1 group-hover:scale-105 transition-transform">
                  <Paperclip className="w-4 h-4" />
                </div>
                {attachmentsCount > 0 && (
                  <span className="absolute top-2 right-2 px-1.5 py-0.2 bg-violet-600 text-white text-[10px] font-bold rounded-full">
                    {attachmentsCount}
                  </span>
                )}
                <span className="text-[10px] font-medium text-slate-700 dark:text-zinc-300">
                  {isRtl ? 'المرفقات' : 'Files'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => { onClose(); onOpenPageJump(); }}
                className="flex flex-col items-center justify-center p-2.5 rounded-2xl bg-slate-50 dark:bg-zinc-800/60 hover:bg-slate-100 dark:hover:bg-zinc-800 active:scale-95 transition-all group"
              >
                <div className="w-9 h-9 rounded-full bg-amber-500/10 dark:bg-amber-400/10 text-amber-600 dark:text-amber-400 flex items-center justify-center mb-1 group-hover:scale-105 transition-transform">
                  <Hash className="w-4 h-4" />
                </div>
                <span className="text-[10px] font-medium text-slate-700 dark:text-zinc-300">
                  {isRtl ? 'انتقال' : 'Jump'}
                </span>
              </button>
            </div>

            {/* Feature List Items */}
            <div className="space-y-1">
              {onOpenTranslation && (
                <button
                  type="button"
                  onClick={() => { onClose(); onOpenTranslation(); }}
                  className="w-full flex items-center justify-between p-3.5 rounded-2xl hover:bg-slate-100 dark:hover:bg-zinc-800/60 transition-all text-left rtl:text-right"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-sky-50 dark:bg-sky-950/40 text-sky-600 dark:text-sky-400 flex items-center justify-center">
                      <Globe className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-slate-900 dark:text-zinc-100">
                        {isRtl ? 'الترجمة الفورية للمصطلحات' : 'Instant Translation & Pronunciation'}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-zinc-400">
                        {isRtl ? 'ترجمة فورية مع نطق صوتي للمصطلحات الطبية' : 'Live translations and voice speech for lecture terms'}
                      </div>
                    </div>
                  </div>
                  <ChevronIcon className="w-4 h-4 text-slate-400 dark:text-zinc-500" />
                </button>
              )}
              <button
                type="button"
                onClick={() => { onClose(); onOpenNotes(); }}
                className="w-full flex items-center justify-between p-3.5 rounded-2xl hover:bg-slate-100 dark:hover:bg-zinc-800/60 transition-all text-left rtl:text-right"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
                    <Bookmark className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-slate-900 dark:text-zinc-100">
                      {isRtl ? 'الملاحظات والتظليلات' : 'Notes & Highlights'}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-zinc-400">
                      {notesCount} {isRtl ? 'عنصر محفوظ' : 'saved items'}
                    </div>
                  </div>
                </div>
                <ChevronIcon className="w-4 h-4 text-slate-400 dark:text-zinc-500" />
              </button>

              {onExportPdf && (
                <button
                  type="button"
                  onClick={() => { onClose(); onExportPdf(); }}
                  className="w-full flex items-center justify-between p-3.5 rounded-2xl hover:bg-slate-100 dark:hover:bg-zinc-800/60 transition-all text-left rtl:text-right"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
                      <Download className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-slate-900 dark:text-zinc-100">
                        {isRtl ? 'تصدير نسخة PDF مع الشروحات' : 'Export Annotated PDF'}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-zinc-400">
                        {isRtl ? 'تصدير مستند PDF كامل بجميع كتاباتك وملاحظاتك' : 'Export full PDF with all handwritten notes & highlights'}
                      </div>
                    </div>
                  </div>
                  <ChevronIcon className="w-4 h-4 text-slate-400 dark:text-zinc-500" />
                </button>
              )}

              {simosanAvailable && onOpenSimosan && (
                <button
                  type="button"
                  onClick={() => { onClose(); onOpenSimosan(); }}
                  className="w-full flex items-center justify-between p-3.5 rounded-2xl hover:bg-slate-100 dark:hover:bg-zinc-800/60 transition-all text-left rtl:text-right"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-amber-500/20 to-indigo-500/20 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
                      <Sparkles className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-1.5">
                        <span>{isRtl ? 'سيموسان الذكي' : 'Simosan AI'}</span>
                        <span className="px-1.5 py-0.5 text-[9px] font-bold rounded-md bg-indigo-100 dark:bg-indigo-900/60 text-indigo-600 dark:text-indigo-300">
                          AI
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-zinc-400">
                        {isRtl ? 'مساعدك الذكي لشرح وتلخيص المحاضرة' : 'Your lecture AI study companion'}
                      </div>
                    </div>
                  </div>
                  <ChevronIcon className="w-4 h-4 text-slate-400 dark:text-zinc-500" />
                </button>
              )}

              {/* Night Mode Switch Item */}
              <div className="flex items-center justify-between p-3.5 rounded-2xl hover:bg-slate-100 dark:hover:bg-zinc-800/60 transition-all">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 flex items-center justify-center">
                    {isNightMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-slate-900 dark:text-zinc-100">
                      {isRtl ? 'الوضع الليلي للقراءة' : 'Night Reading Mode'}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-zinc-400">
                      {isNightMode ? (isRtl ? 'مفعّل (مريح للعين)' : 'Active (Eye comfort)') : (isRtl ? 'غير مفعّل' : 'Disabled')}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onToggleNightMode}
                  className={`w-11 h-6 flex items-center rounded-full p-1 transition-colors ${
                    isNightMode ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-zinc-700'
                  }`}
                >
                  <div
                    className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform ${
                      isNightMode ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

export default NotewiseDocumentSheet;
