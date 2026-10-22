import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Bookmark, ChevronDown, Check } from 'lucide-react';
import type { PdfAnnotation } from '../../types/pdfAnnotation.types';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  pageCount: number;
  currentPage: number;
  annotations: PdfAnnotation[];
  isRtl: boolean;
  onSelectPage: (page: number) => void;
  onToggleBookmark?: (page: number) => void;
  bookmarkedPages?: Set<number>;
}

export const NotewiseOverviewModal: React.FC<Props> = ({
  isOpen,
  onClose,
  pageCount,
  currentPage,
  annotations,
  isRtl,
  onSelectPage,
  onToggleBookmark,
  bookmarkedPages = new Set(),
}) => {
  const [filter, setFilter] = useState<'all' | 'bookmarks' | 'annotated'>('all');
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);

  // Pages with annotations
  const pagesWithAnnotations = useMemo(() => {
    const set = new Set<number>();
    for (const a of annotations) {
      if (a.page) set.add(a.page);
    }
    return set;
  }, [annotations]);

  // Filtered page list
  const visiblePages = useMemo(() => {
    const pages: number[] = [];
    for (let i = 1; i <= pageCount; i++) {
      if (filter === 'bookmarks' && !bookmarkedPages.has(i)) continue;
      if (filter === 'annotated' && !pagesWithAnnotations.has(i)) continue;
      pages.push(i);
    }
    return pages;
  }, [pageCount, filter, bookmarkedPages, pagesWithAnnotations]);

  const filterLabels = {
    all: isRtl ? 'جميع الصفحات' : 'All pages',
    bookmarks: isRtl ? 'الإشارات المرجعية' : 'Bookmarks',
    annotated: isRtl ? 'الصفحات ذات الملاحظات' : 'Annotated',
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex flex-col bg-slate-100/95 dark:bg-zinc-950/95 backdrop-blur-xl pointer-events-auto"
        >
          {/* Top Bar */}
          <div
            className="flex items-center justify-between px-5 py-4 border-b border-zinc-200/80 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-md"
            style={{ paddingTop: 'max(1rem, env(safe-area-inset-top, 1rem))' }}
          >
            {/* Filter Dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setFilterMenuOpen(!filterMenuOpen)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-xs font-semibold text-slate-800 dark:text-zinc-200 transition-all active:scale-95"
              >
                <span>{filterLabels[filter]}</span>
                <span className="text-slate-400 dark:text-zinc-500">({visiblePages.length})</span>
                <ChevronDown className="w-3.5 h-3.5 text-slate-500 dark:text-zinc-400" />
              </button>

              <AnimatePresence>
                {filterMenuOpen && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: -4 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: -4 }}
                    className="absolute top-full mt-1.5 left-0 z-50 min-w-[180px] bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-zinc-200 dark:border-zinc-800 p-1.5"
                  >
                    {(['all', 'bookmarks', 'annotated'] as const).map((key) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => {
                          setFilter(key);
                          setFilterMenuOpen(false);
                        }}
                        className="w-full flex items-center justify-between px-3 py-2 text-xs rounded-xl hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-800 dark:text-zinc-200 transition-colors"
                      >
                        <span>{filterLabels[key]}</span>
                        {filter === key && <Check className="w-3.5 h-3.5 text-indigo-600" />}
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Close Button */}
            <button
              type="button"
              onClick={onClose}
              aria-label={isRtl ? 'إغلاق' : 'Close'}
              className="w-9 h-9 rounded-full bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-zinc-700 active:scale-95 transition-all"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* 3-Column Thumbnails Grid */}
          <div className="flex-1 overflow-y-auto p-5 overscroll-contain">
            {visiblePages.length === 0 ? (
              <div className="h-64 flex flex-col items-center justify-center text-slate-400 dark:text-zinc-600">
                <Bookmark className="w-8 h-8 stroke-1 mb-2" />
                <p className="text-xs">
                  {isRtl ? 'لا توجد صفحات مطابقة لهذا الفلتر' : 'No pages match this filter'}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-4 max-w-2xl mx-auto pb-10">
                {visiblePages.map((pageNum) => {
                  const isCurrent = pageNum === currentPage;
                  const isBookmarked = bookmarkedPages.has(pageNum);
                  const hasAnnotation = pagesWithAnnotations.has(pageNum);

                  return (
                    <div
                      key={pageNum}
                      className="flex flex-col items-center group cursor-pointer"
                      onClick={() => {
                        onSelectPage(pageNum);
                        onClose();
                      }}
                    >
                      {/* Page Card */}
                      <div
                        className={`relative w-full aspect-[3/4] bg-white dark:bg-zinc-900 rounded-xl shadow-sm hover:shadow-md transition-all flex flex-col items-center justify-center border ${
                          isCurrent
                            ? 'ring-2 ring-indigo-600 border-indigo-600 shadow-indigo-600/20'
                            : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700'
                        }`}
                      >
                        {/* Bookmark Ribbon Button */}
                        {onToggleBookmark && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleBookmark(pageNum);
                            }}
                            className={`absolute top-2 right-2 w-6 h-6 rounded-full flex items-center justify-center transition-all ${
                              isBookmarked
                                ? 'text-amber-500 fill-amber-500 scale-105'
                                : 'text-slate-300 hover:text-slate-500 dark:text-zinc-600'
                            }`}
                          >
                            <Bookmark className={`w-3.5 h-3.5 ${isBookmarked ? 'fill-amber-500' : ''}`} />
                          </button>
                        )}

                        {/* Annotation indicator dot */}
                        {hasAnnotation && (
                          <span className="absolute bottom-2 left-2 w-2 h-2 rounded-full bg-indigo-500" />
                        )}

                        {/* Page Preview Thumbnail Placeholder / Skeleton */}
                        <div className="w-3/4 h-2/3 border border-dashed border-zinc-200 dark:border-zinc-800 rounded flex flex-col items-center justify-center text-[10px] text-slate-400 dark:text-zinc-500 select-none">
                          <span className="font-semibold">{pageNum}</span>
                        </div>
                      </div>

                      {/* Page label below card */}
                      <span className={`text-[11px] font-medium mt-1.5 transition-colors ${
                        isCurrent
                          ? 'text-indigo-600 dark:text-indigo-400 font-bold'
                          : 'text-slate-600 dark:text-zinc-400'
                      }`}>
                        {pageNum}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default NotewiseOverviewModal;
