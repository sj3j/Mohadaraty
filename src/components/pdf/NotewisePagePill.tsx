import React from 'react';
import { Moon, Sun } from 'lucide-react';

interface Props {
  currentPage: number;
  pageCount: number;
  scalePercent: number;
  isNightMode: boolean;
  isAnnotationMode?: boolean;
  onToggleNightMode: () => void;
  onOpenPageJump: () => void;
}

export const NotewisePagePill: React.FC<Props> = ({
  currentPage,
  pageCount,
  scalePercent,
  isNightMode,
  isAnnotationMode,
  onToggleNightMode,
  onOpenPageJump,
}) => {
  return (
    <div
      className={`fixed left-4 sm:left-5 z-40 pointer-events-none transition-all duration-200 ${
        isAnnotationMode ? 'bottom-20 sm:bottom-20' : 'bottom-5'
      }`}
      style={{
        bottom: isAnnotationMode
          ? 'max(4.75rem, calc(env(safe-area-inset-bottom, 1.25rem) + 3.75rem))'
          : 'max(1.25rem, env(safe-area-inset-bottom, 1.25rem))',
      }}
    >
      <div className="flex items-center gap-1.5 sm:gap-2 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md shadow-lg shadow-black/5 dark:shadow-black/20 rounded-full px-2.5 sm:px-3 py-1 sm:py-1.5 border border-zinc-200/80 dark:border-zinc-800 pointer-events-auto">
        {/* Page counter button */}
        <button
          type="button"
          onClick={onOpenPageJump}
          className="flex items-center gap-1 text-xs font-semibold text-slate-800 dark:text-zinc-100 hover:text-indigo-600 dark:hover:text-indigo-400 active:scale-95 transition-all"
        >
          <span>{currentPage}</span>
          <span className="text-slate-400 dark:text-zinc-500 font-normal">/</span>
          <span className="text-slate-500 dark:text-zinc-400 font-normal">{pageCount || 1}</span>
        </button>

        <div className="w-[1px] h-3.5 bg-zinc-200 dark:bg-zinc-800" />

        {/* Zoom percentage */}
        <span className="text-[10px] sm:text-[11px] font-medium text-slate-500 dark:text-zinc-400 min-w-[30px] sm:min-w-[34px] text-center select-none">
          {scalePercent}%
        </span>

        <div className="w-[1px] h-3.5 bg-zinc-200 dark:bg-zinc-800" />

        {/* Night / Inverted Reading Mode Toggle */}
        <button
          type="button"
          onClick={onToggleNightMode}
          aria-label={isNightMode ? 'الوضع النهاري' : 'الوضع الليلي'}
          className={`w-6 h-6 flex items-center justify-center rounded-full transition-all active:scale-90 ${
            isNightMode
              ? 'text-amber-400 hover:bg-zinc-800'
              : 'text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800'
          }`}
          title={isNightMode ? 'الوضع النهاري' : 'الوضع الليلي'}
        >
          {isNightMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
};

export default NotewisePagePill;
