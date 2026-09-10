import { motion } from 'motion/react';
import { ChevronDown, ChevronUp, List, Loader2, Search, X } from 'lucide-react';
import type { SearchMatch } from '../../lib/pdfSearch';

interface Props {
  isRtl: boolean;
  query: string;
  onQueryChange: (q: string) => void;
  indexing: boolean;
  /** Pages whose text has been pulled so far, out of the document's total. */
  indexed: number;
  total: number;
  matches: SearchMatch[];
  activeIndex: number;
  listOpen: boolean;
  onToggleList: () => void;
  onPrev: () => void;
  onNext: () => void;
  onPick: (i: number) => void;
  onClose: () => void;
}

/**
 * Find-in-PDF.
 *
 * Docked under the reader header rather than floating, for the same reason
 * SelectionToolbar is: a floating panel over the page competes with the native
 * text selection menu. It also has to stay clear of the bottom, where the
 * selection toolbar appears.
 *
 * The results list is collapsed by default. On a phone an always-open list
 * covers most of the page, and the common case - type, hit next, next, next -
 * never needs it.
 */
export default function PdfSearchPanel({
  isRtl, query, onQueryChange, indexing, indexed, total,
  matches, activeIndex, listOpen, onToggleList, onPrev, onNext, onPick, onClose,
}: Props) {
  const label = (ar: string, en: string) => (isRtl ? ar : en);
  const has = matches.length > 0;

  return (
    <motion.div
      initial={{ y: -12, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: -12, opacity: 0 }}
      dir={isRtl ? 'rtl' : 'ltr'}
      // Covers the reader header, so it has to reproduce that header's own
      // safe-area inset - the reader is `fixed inset-0` and carries none of
      // App.tsx's padded root, so top-0 here really is the system clock.
      className="absolute inset-x-0 top-0 z-[7] pt-[max(env(safe-area-inset-top),0.5rem)] border-b border-slate-200 dark:border-zinc-700 bg-white/95 dark:bg-zinc-900/95 backdrop-blur shadow-lg"
    >
      <div className="flex items-center gap-1.5 px-2 py-2">
        <Search className="w-4 h-4 shrink-0 text-slate-400" />

        <input
          autoFocus
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (e.shiftKey) onPrev(); else onNext();
          }}
          placeholder={label('بحث في المحاضرة', 'Search this lecture')}
          className="flex-1 min-w-0 bg-transparent text-sm font-bold text-slate-800 dark:text-slate-100 placeholder:text-slate-400 placeholder:font-normal outline-none"
        />

        {indexing && (
          <span className="flex items-center gap-1 text-[11px] font-bold text-slate-400 shrink-0">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {total ? `${indexed}/${total}` : null}
          </span>
        )}

        {!indexing && query.trim().length > 0 && (
          <span className="text-[11px] font-black text-slate-400 shrink-0 tabular-nums">
            {has ? `${activeIndex + 1}/${matches.length}` : label('لا نتائج', 'No results')}
          </span>
        )}

        <button
          onClick={onPrev}
          disabled={!has}
          aria-label={label('السابق', 'Previous match')}
          className="w-8 h-8 rounded-full flex items-center justify-center text-slate-500 dark:text-slate-300 disabled:opacity-30 hover:bg-slate-100 dark:hover:bg-zinc-800 transition"
        >
          <ChevronUp className="w-4 h-4" />
        </button>
        <button
          onClick={onNext}
          disabled={!has}
          aria-label={label('التالي', 'Next match')}
          className="w-8 h-8 rounded-full flex items-center justify-center text-slate-500 dark:text-slate-300 disabled:opacity-30 hover:bg-slate-100 dark:hover:bg-zinc-800 transition"
        >
          <ChevronDown className="w-4 h-4" />
        </button>
        <button
          onClick={onToggleList}
          disabled={!has}
          aria-label={label('كل النتائج', 'All results')}
          aria-pressed={listOpen}
          className={`w-8 h-8 rounded-full flex items-center justify-center disabled:opacity-30 transition ${
            listOpen
              ? 'bg-sky-500 text-white'
              : 'text-slate-500 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-zinc-800'
          }`}
        >
          <List className="w-4 h-4" />
        </button>
        <button
          onClick={onClose}
          aria-label={label('إغلاق البحث', 'Close search')}
          className="w-8 h-8 rounded-full flex items-center justify-center text-slate-500 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {listOpen && has && (
        <ul className="max-h-[38vh] overflow-y-auto border-t border-slate-200 dark:border-zinc-700">
          {matches.map((m, i) => (
            <li key={`${m.pageNumber}-${m.start}`}>
              <button
                onClick={() => onPick(i)}
                className={`w-full text-start px-3 py-2 flex items-start gap-2 border-b border-slate-100 dark:border-zinc-800 transition ${
                  i === activeIndex ? 'bg-sky-50 dark:bg-sky-500/10' : 'hover:bg-slate-50 dark:hover:bg-zinc-800/60'
                }`}
              >
                <span className="shrink-0 mt-0.5 text-[10px] font-black text-slate-400 tabular-nums">
                  {m.pageNumber}
                </span>
                <span className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed break-words">
                  {m.snippet.slice(0, m.snippetStart)}
                  <mark className="bg-sky-200 dark:bg-sky-500/40 text-inherit rounded px-0.5">
                    {m.snippet.slice(m.snippetStart, m.snippetEnd)}
                  </mark>
                  {m.snippet.slice(m.snippetEnd)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </motion.div>
  );
}
