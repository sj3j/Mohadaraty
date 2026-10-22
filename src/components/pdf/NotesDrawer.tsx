import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { AlertCircle, Download, Search, Trash2, X, Type } from 'lucide-react';
import { HIGHLIGHT_COLORS, type PdfAnnotation } from '../../types/pdfAnnotation.types';

interface Props {
  annotations: PdfAnnotation[];
  /** Ids that could not be located in the current PDF text. */
  orphanIds: Set<string>;
  isRtl: boolean;
  onGoTo: (a: PdfAnnotation) => void;
  onDelete: (id: string) => void;
  onExport: () => void;
  onDeleteAll: () => void;
  onClose: () => void;
}

export default function NotesDrawer({
  annotations, orphanIds, isRtl, onGoTo, onDelete, onExport, onDeleteAll, onClose,
}: Props) {
  const [query, setQuery] = useState('');

  const { located, orphaned } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (a: PdfAnnotation) =>
      !q ||
      (a.note ?? '').toLowerCase().includes(q) ||
      (a.text ?? '').toLowerCase().includes(q) ||
      (a.anchor?.exact ?? '').toLowerCase().includes(q);

    const rows = annotations.filter(match);
    return {
      located: rows.filter(a => !orphanIds.has(a.id)),
      orphaned: rows.filter(a => orphanIds.has(a.id)),
    };
  }, [annotations, orphanIds, query]);

  const byPage = useMemo(() => {
    const m = new Map<number, PdfAnnotation[]>();
    for (const a of located) {
      const list = m.get(a.page);
      if (list) list.push(a); else m.set(a.page, [a]);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [located]);

  const row = (a: PdfAnnotation, dim = false) => (
    <div
      key={a.id}
      className={`group flex items-start gap-3 p-3 rounded-xl hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors ${dim ? 'opacity-70' : ''}`}
    >
      <button onClick={() => onGoTo(a)} className="flex-1 min-w-0 text-start">
        <div className="flex items-center gap-2 mb-1">
          {a.kind === 'text' ? (
            <div className="w-5 h-5 rounded-md bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
              <Type className="w-3 h-3" />
            </div>
          ) : (
            <span
              className="w-3 h-3 rounded-full shrink-0 ring-1 ring-black/10"
              style={{ background: HIGHLIGHT_COLORS[a.color] }}
            />
          )}
          <span className="text-[11px] font-bold text-slate-400">
            {isRtl ? `صفحة ${a.page}` : `Page ${a.page}`}
          </span>
          {a.kind === 'text' && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400">
              {isRtl ? 'نص' : 'Text'}
            </span>
          )}
        </div>
        {a.anchor?.exact && (
          <p dir="auto" className="text-sm text-slate-700 dark:text-slate-300 line-clamp-2">
            {a.anchor.exact}
          </p>
        )}
        {(a.text || a.note) && (
          <p dir="auto" className={`mt-1 text-sm font-semibold line-clamp-3 ${a.kind === 'text' ? 'text-slate-900 dark:text-zinc-100' : 'text-sky-600 dark:text-sky-400'}`}>
            {a.text || a.note}
          </p>
        )}
      </button>
      <button
        onClick={() => onDelete(a.id)}
        aria-label={isRtl ? 'حذف' : 'Delete'}
        className="p-2 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 z-[170] bg-black/50 backdrop-blur-sm"
      />
      <motion.aside
        initial={{ x: isRtl ? '-100%' : '100%' }}
        animate={{ x: 0 }}
        exit={{ x: isRtl ? '-100%' : '100%' }}
        transition={{ type: 'spring', damping: 32, stiffness: 320 }}
        dir={isRtl ? 'rtl' : 'ltr'}
        className={`fixed inset-y-0 ${isRtl ? 'start-0' : 'end-0'} z-[171] w-full max-w-sm bg-white dark:bg-zinc-900 shadow-2xl flex flex-col`}
      >
        <header className="shrink-0 flex items-center justify-between px-4 pt-[max(env(safe-area-inset-top),0.75rem)] pb-3 border-b border-slate-200 dark:border-zinc-800">
          <h2 className="font-black text-lg text-slate-900 dark:text-stone-100">
            {isRtl ? 'ملاحظاتي' : 'My notes'}
          </h2>
          <div className="flex items-center gap-1">
            <button
              onClick={onExport}
              aria-label={isRtl ? 'تصدير' : 'Export'}
              className="p-2 rounded-full text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
            >
              <Download className="w-5 h-5" />
            </button>
            <button
              onClick={onClose}
              aria-label={isRtl ? 'إغلاق' : 'Close'}
              className="p-2 rounded-full text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </header>

        <div className="shrink-0 px-4 py-3">
          <div className="relative">
            <Search className="absolute top-1/2 -translate-y-1/2 start-3 w-4 h-4 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              dir="auto"
              placeholder={isRtl ? 'بحث في الملاحظات' : 'Search notes'}
              className="w-full ps-9 pe-3 py-2 rounded-xl bg-slate-100 dark:bg-zinc-800 text-sm text-slate-900 dark:text-stone-100 outline-none focus:ring-2 ring-sky-500"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {annotations.length === 0 && (
            <p className="text-center text-sm text-slate-400 mt-12 px-6">
              {isRtl
                ? 'لا توجد ملاحظات بعد. ظلّل أي نص في المحاضرة لتبدأ.'
                : 'No notes yet. Highlight any text in the lecture to start.'}
            </p>
          )}

          {byPage.map(([page, rows]) => (
            <section key={page} className="mb-2">
              <h3 className="px-3 pt-3 pb-1 text-[11px] font-black uppercase tracking-wider text-slate-400">
                {isRtl ? `صفحة ${page}` : `Page ${page}`}
              </h3>
              {rows.map(a => row(a))}
            </section>
          ))}

          {orphaned.length > 0 && (
            <section className="mt-4 mx-2 rounded-2xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900/40 p-2">
              <h3 className="flex items-center gap-2 px-2 py-2 text-[12px] font-bold text-amber-700 dark:text-amber-400">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {isRtl ? 'ملاحظات لم يُعثر على نصها' : "Notes we couldn't locate"}
              </h3>
              <p className="px-2 pb-2 text-[11px] text-amber-700/80 dark:text-amber-500/80">
                {isRtl
                  ? 'تغيّر ملف المحاضرة على الأرجح. ملاحظاتك محفوظة كما هي.'
                  : 'The lecture file likely changed. Your notes are kept intact.'}
              </p>
              {orphaned.map(a => row(a, true))}
            </section>
          )}
        </div>

        {annotations.length > 0 && (
          <footer className="shrink-0 border-t border-slate-200 dark:border-zinc-800 p-3 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
            <button
              onClick={onDeleteAll}
              className="w-full py-2.5 rounded-xl text-sm font-bold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
            >
              {isRtl ? 'حذف كل الملاحظات' : 'Delete all notes'}
            </button>
          </footer>
        )}
      </motion.aside>
    </>
  );
}
