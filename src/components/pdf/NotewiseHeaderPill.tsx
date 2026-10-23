import React from 'react';
import { ArrowLeft, ArrowRight, Eye, Edit3, Grid, MoreHorizontal, Search, Sparkles, Globe } from 'lucide-react';

interface Props {
  isRtl: boolean;
  isAnnotationMode: boolean;
  onToggleMode: () => void;
  onBack: () => void;
  onOpenOverview: () => void;
  onOpenSearch: () => void;
  onOpenTranslation?: () => void;
  onOpenDocSheet: () => void;
  onOpenSimosan?: () => void;
  simosanAvailable?: boolean;
}

export const NotewiseHeaderPill: React.FC<Props> = ({
  isRtl,
  isAnnotationMode,
  onToggleMode,
  onBack,
  onOpenOverview,
  onOpenSearch,
  onOpenTranslation,
  onOpenDocSheet,
  onOpenSimosan,
  simosanAvailable,
}) => {
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;

  return (
    <div
      className="fixed top-0 left-0 right-0 z-40 flex items-center justify-between px-2 sm:px-4 pt-3 pb-2 pointer-events-none"
      style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top, 0.75rem))' }}
    >
      {/* Left Capsule: Back, Overview, Search, Translate */}
      <div className="flex items-center bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md shadow-lg shadow-black/5 dark:shadow-black/20 rounded-full px-1 sm:px-1.5 py-0.5 sm:py-1 border border-zinc-200/80 dark:border-zinc-800 pointer-events-auto transition-transform active:scale-[0.99]">
        <button
          type="button"
          onClick={onBack}
          aria-label={isRtl ? 'رجوع' : 'Back'}
          className="w-8 h-8 sm:w-9 sm:h-9 md:w-10 md:h-10 flex items-center justify-center rounded-full text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 active:scale-95 transition-all"
        >
          <BackIcon className="w-4 h-4 sm:w-5 sm:h-5" />
        </button>

        <div className="w-[1px] h-4 sm:h-5 bg-zinc-200 dark:bg-zinc-800 mx-0.5" />

        <button
          type="button"
          onClick={onOpenOverview}
          aria-label={isRtl ? 'صفحات المستند' : 'Pages overview'}
          className="w-8 h-8 sm:w-9 sm:h-9 md:w-10 md:h-10 flex items-center justify-center rounded-full text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 active:scale-95 transition-all"
        >
          <Grid className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
        </button>

        <button
          type="button"
          onClick={onOpenSearch}
          aria-label={isRtl ? 'بحث في المحاضرة' : 'Search in lecture'}
          className="w-8 h-8 sm:w-9 sm:h-9 md:w-10 md:h-10 flex items-center justify-center rounded-full text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 active:scale-95 transition-all"
        >
          <Search className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
        </button>

        {onOpenTranslation && (
          <button
            type="button"
            onClick={onOpenTranslation}
            aria-label={isRtl ? 'الترجمة الفورية' : 'Instant translation'}
            className="w-8 h-8 sm:w-9 sm:h-9 md:w-10 md:h-10 flex items-center justify-center rounded-full text-sky-600 dark:text-sky-400 hover:bg-slate-100 dark:hover:bg-zinc-800 active:scale-95 transition-all"
          >
            <Globe className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-sky-600 dark:text-sky-400" />
          </button>
        )}
      </div>

      {/* Right Capsule: Simosan AI, View/Edit Mode Toggle, More Options */}
      <div className="flex items-center gap-0.5 sm:gap-1.5 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md shadow-lg shadow-black/5 dark:shadow-black/20 rounded-full px-1 sm:px-1.5 py-0.5 sm:py-1 border border-zinc-200/80 dark:border-zinc-800 pointer-events-auto transition-transform active:scale-[0.99] touch-manipulation" style={{ touchAction: 'manipulation' }}>
        {simosanAvailable && onOpenSimosan && (
          <button
            type="button"
            onClick={onOpenSimosan}
            aria-label="Simosan AI"
            style={{ touchAction: 'manipulation' }}
            className="w-8 h-8 sm:w-9 sm:h-9 md:w-10 md:h-10 flex items-center justify-center rounded-full bg-gradient-to-tr from-amber-500/10 to-indigo-500/10 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 active:scale-95 transition-all relative group touch-manipulation"
          >
            <Sparkles className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-indigo-600 dark:text-indigo-400 group-hover:scale-110 transition-transform" />
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-400 ring-2 ring-white dark:ring-zinc-900" />
          </button>
        )}

        <button
          type="button"
          onClick={onToggleMode}
          aria-label={isAnnotationMode ? 'وضع القراءة' : 'وضع التدوين والتظليل'}
          style={{ touchAction: 'manipulation' }}
          className={`w-8 h-8 sm:w-9 sm:h-9 md:w-10 md:h-10 flex items-center justify-center rounded-full transition-all touch-manipulation ${
            isAnnotationMode
              ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
              : 'text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800'
          }`}
          title={isAnnotationMode ? 'تبديل لوضع القراءة' : 'تبديل لوضع التدوين'}
        >
          {isAnnotationMode ? (
            <Edit3 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          ) : (
            <div className="w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 flex items-center justify-center pointer-events-none">
              <Eye className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
            </div>
          )}
        </button>

        <div className="w-[1px] h-4 sm:h-5 bg-zinc-200 dark:bg-zinc-800 mx-0.5" />

        <button
          type="button"
          onClick={onOpenDocSheet}
          aria-label={isRtl ? 'المزيد من الخيارات' : 'More options'}
          style={{ touchAction: 'manipulation' }}
          className="w-8 h-8 sm:w-9 sm:h-9 md:w-10 md:h-10 flex items-center justify-center rounded-full text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 active:scale-95 transition-all touch-manipulation"
        >
          <MoreHorizontal className="w-4 h-4 sm:w-5 sm:h-5" />
        </button>
      </div>
    </div>
  );
};

export default NotewiseHeaderPill;
