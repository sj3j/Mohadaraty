import React from 'react';
import { Language, CourseId, COURSE_IDS, COURSE_LABELS } from '../types';
import { useStageContext } from '../contexts/StageContext';
import { BookMarked } from 'lucide-react';

interface CourseTabsProps {
  lang: Language;
  /** Optional per-course counts rendered under each label. */
  counts?: Partial<Record<CourseId, number>>;
  className?: string;
  showTahmeel?: boolean;
  tahmeelActive?: boolean;
  tahmeelCount?: number;
  onTahmeelActiveChange?: (active: boolean) => void;
}

/**
 * Segmented switch between the stage's two courses.
 *
 * Backed by StageContext rather than local state, so Subject Browser and Records
 * always agree - a control in only one of them would strand the other course's
 * content with no way to reach it.
 */
export default function CourseTabs({
  lang, counts, className = '', showTahmeel = false, tahmeelActive = false,
  tahmeelCount, onTahmeelActiveChange,
}: CourseTabsProps) {
  const isRtl = lang === 'ar';
  const { activeCourseId, setActiveCourseId } = useStageContext();

  return (
    <div
      role="tablist"
      aria-label={isRtl ? 'الكورس' : 'Course'}
      className={`flex gap-1 p-1 bg-slate-100 dark:bg-zinc-800/80 rounded-2xl ${className}`}
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      {COURSE_IDS.map(id => {
        const isActive = !tahmeelActive && activeCourseId === id;
        const count = counts?.[id];
        return (
          <button
            key={id}
            role="tab"
            aria-selected={isActive}
            onClick={() => {
              setActiveCourseId(id);
              onTahmeelActiveChange?.(false);
            }}
            className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-bold transition-all ${
              isActive
                ? 'bg-white dark:bg-zinc-900 text-sky-600 dark:text-sky-400 shadow-sm'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
            }`}
          >
            {isRtl ? COURSE_LABELS[id].ar : COURSE_LABELS[id].en}
            {typeof count === 'number' && (
              // Its own pill, and pinned LTR: a bare number sitting against an
              // Arabic label reads as part of the label rather than as a count.
              <span
                dir="ltr"
                className={`ms-2 inline-block min-w-[1.25rem] px-1.5 py-0.5 rounded-full text-[11px] font-black tabular-nums ${
                  isActive
                    ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300'
                    : 'bg-slate-200 text-slate-600 dark:bg-zinc-700 dark:text-slate-300'
                }`}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
      {showTahmeel && (
        <button
          role="tab"
          aria-selected={tahmeelActive}
          onClick={() => onTahmeelActiveChange?.(true)}
          className={`flex-1 px-3 py-2.5 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-1.5 ${
            tahmeelActive
              ? 'bg-white dark:bg-zinc-900 text-amber-600 dark:text-amber-400 shadow-sm'
              : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
          }`}
        >
          <BookMarked className="w-4 h-4 shrink-0" />
          <span>{isRtl ? 'مواد التحميل' : 'Carry-over'}</span>
          {typeof tahmeelCount === 'number' && (
            <span dir="ltr" className="min-w-[1.25rem] px-1.5 py-0.5 rounded-full text-[11px] font-black bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
              {tahmeelCount}
            </span>
          )}
        </button>
      )}
    </div>
  );
}
