import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Pencil,
  Highlighter,
  Baseline,
  Type,
  Eraser,
  NotebookPen,
  Undo2,
  Redo2,
  ChevronDown,
  Sparkles,
} from 'lucide-react';
import type { DrawingTool, StrokeWidth } from '../../types/pdfDrawing.types';

export const PALETTE_COLORS = [
  // Highlighting & Pen tints
  { id: 'yellow', hex: '#fde68a', label: 'أصفر' },
  { id: 'green', hex: '#bbf7d0', label: 'أخضر' },
  { id: 'blue', hex: '#bfdbfe', label: 'أزرق' },
  { id: 'pink', hex: '#fbcfe8', label: 'وردي' },
  { id: 'orange', hex: '#fed7aa', label: 'برتقالي' },
  // Solid pen inks
  { id: 'charcoal', hex: '#1e293b', label: 'أسود' },
  { id: 'indigo', hex: '#4f46e5', label: 'كحلي' },
  { id: 'crimson', hex: '#ef4444', label: 'أحمر' },
  { id: 'emerald', hex: '#059669', label: 'زمردي' },
  { id: 'amber', hex: '#d97706', label: 'عسلي' },
];

interface Props {
  isVisible: boolean;
  activeTool: DrawingTool;
  activeColor: string;
  activeWidth: StrokeWidth;
  canUndo: boolean;
  canRedo: boolean;
  onSelectTool: (tool: DrawingTool) => void;
  onChangeColor: (color: string) => void;
  onChangeWidth: (width: StrokeWidth) => void;
  onUndo: () => void;
  onRedo: () => void;
  onAddNote: () => void;
  onOpenSimosan?: () => void;
  onCloseDock: () => void;
  isRtl: boolean;
  simosanAvailable?: boolean;
}

export const NotewiseAnnotationDock: React.FC<Props> = ({
  isVisible,
  activeTool,
  activeColor,
  activeWidth,
  canUndo,
  canRedo,
  onSelectTool,
  onChangeColor,
  onChangeWidth,
  onUndo,
  onRedo,
  onAddNote,
  onOpenSimosan,
  onCloseDock,
  isRtl,
  simosanAvailable,
}) => {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [widthPickerOpen, setWidthPickerOpen] = useState(false);

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 350 }}
          className="fixed bottom-3 sm:bottom-5 inset-x-0 mx-auto z-40 pointer-events-auto w-[min(98vw,560px)] px-1 sm:px-2 flex flex-col items-center"
          style={{ bottom: 'max(0.75rem, env(safe-area-inset-bottom, 0.75rem))' }}
        >
          <div className="flex flex-col items-center w-full">
            {/* Popovers row: Color Palette & Width Picker */}
            <div className="mb-2 flex items-center justify-center gap-1.5 max-w-full">
              <AnimatePresence>
                {paletteOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.95 }}
                    className="flex items-center gap-1 sm:gap-1.5 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md p-1.5 sm:p-2 rounded-2xl shadow-xl border border-zinc-200/80 dark:border-zinc-800 max-w-[94vw] overflow-x-auto hide-scrollbar"
                  >
                    {PALETTE_COLORS.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          onChangeColor(c.hex);
                          setPaletteOpen(false);
                        }}
                        aria-label={c.label}
                        className={`w-5 h-5 sm:w-6 sm:h-6 rounded-full border transition-all shrink-0 ${
                          activeColor.toLowerCase() === c.hex.toLowerCase()
                            ? 'scale-110 ring-2 ring-indigo-500 ring-offset-2 dark:ring-offset-zinc-900 border-white'
                            : 'border-white/40 hover:scale-105 opacity-85'
                        }`}
                        style={{ backgroundColor: c.hex }}
                      />
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {widthPickerOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.95 }}
                    className="flex items-center gap-1 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md p-1 sm:p-1.5 rounded-2xl shadow-xl border border-zinc-200/80 dark:border-zinc-800"
                  >
                    {(['thin', 'medium', 'thick'] as StrokeWidth[]).map((w) => (
                      <button
                        key={w}
                        type="button"
                        onClick={() => {
                          onChangeWidth(w);
                          setWidthPickerOpen(false);
                        }}
                        className={`px-2 py-1 rounded-xl text-xs flex items-center gap-1 transition-all ${
                          activeWidth === w
                            ? 'bg-indigo-600 text-white font-semibold'
                            : 'text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800'
                        }`}
                      >
                        <span
                          className={`rounded-full ${
                            activeWidth === w ? 'bg-white' : 'bg-slate-500 dark:bg-zinc-400'
                          }`}
                          style={{
                            width: w === 'thin' ? 4 : w === 'medium' ? 7 : 10,
                            height: w === 'thin' ? 4 : w === 'medium' ? 7 : 10,
                          }}
                        />
                        <span className="text-[10px] sm:text-[11px]">
                          {w === 'thin'
                            ? isRtl
                              ? 'رفيع'
                              : 'Thin'
                            : w === 'medium'
                            ? isRtl
                              ? 'متوسط'
                              : 'Medium'
                            : isRtl
                            ? 'عريض'
                            : 'Thick'}
                        </span>
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Main Dock Bar */}
            <div
              className="flex items-center justify-between sm:justify-center gap-0.5 sm:gap-1 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md shadow-2xl shadow-black/15 rounded-full px-1.5 sm:px-2.5 py-1 sm:py-1.5 border border-zinc-200/80 dark:border-zinc-800 w-full max-w-full overflow-x-auto hide-scrollbar touch-manipulation"
              style={{ touchAction: 'manipulation' }}
            >
              {/* Pencil (Drawing / الرسم) */}
              <button
                type="button"
                onClick={() => {
                  if (activeTool === 'pencil') {
                    setWidthPickerOpen(!widthPickerOpen);
                    setPaletteOpen(false);
                  } else {
                    onSelectTool('pencil');
                  }
                }}
                title={isRtl ? 'قلم الرصاص / رسم' : 'Pencil / Pen'}
                style={{ touchAction: 'manipulation' }}
                className={`flex items-center justify-center p-1.5 sm:px-2.5 sm:py-1.5 rounded-full text-xs font-medium transition-all shrink-0 active:scale-95 touch-manipulation ${
                  activeTool === 'pencil'
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                    : 'text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800'
                }`}
              >
                <Pencil className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                <span className="hidden md:inline ms-1">{isRtl ? 'قلم' : 'Pen'}</span>
              </button>

              {/* Free Highlighter (تظليل حر) */}
              <button
                type="button"
                onClick={() => {
                  if (activeTool === 'free_highlighter') {
                    setWidthPickerOpen(!widthPickerOpen);
                    setPaletteOpen(false);
                  } else {
                    onSelectTool('free_highlighter');
                  }
                }}
                title={isRtl ? 'تظليل حر للمخططات والصفحات' : 'Freehand Highlighter'}
                style={{ touchAction: 'manipulation' }}
                className={`flex items-center justify-center p-1.5 sm:px-2.5 sm:py-1.5 rounded-full text-xs font-medium transition-all shrink-0 active:scale-95 touch-manipulation ${
                  activeTool === 'free_highlighter'
                    ? 'bg-amber-500 text-white shadow-md shadow-amber-500/30'
                    : 'text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800'
                }`}
              >
                <Highlighter className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                <span className="hidden md:inline ms-1">{isRtl ? 'تظليل حر' : 'Free'}</span>
              </button>

              {/* Text Highlight Tool (تظليل نصوص) */}
              <button
                type="button"
                onClick={() => onSelectTool('text_highlight')}
                title={isRtl ? 'تظليل النصوص والمحتوى' : 'Text Highlight'}
                style={{ touchAction: 'manipulation' }}
                className={`flex items-center justify-center p-1.5 sm:px-2.5 sm:py-1.5 rounded-full text-xs font-medium transition-all shrink-0 active:scale-95 touch-manipulation ${
                  activeTool === 'text_highlight'
                    ? 'bg-amber-600 text-white shadow-md shadow-amber-600/30'
                    : 'text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800'
                }`}
              >
                <Baseline className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                <span className="hidden md:inline ms-1">{isRtl ? 'تظليل نص' : 'Highlight'}</span>
              </button>

              {/* Text Tool (كتابة نص وملاحظات) */}
              <button
                type="button"
                onClick={() => onSelectTool('text')}
                title={isRtl ? 'إضافة نص وملاحظات' : 'Text Box'}
                style={{ touchAction: 'manipulation' }}
                className={`flex items-center justify-center p-1.5 sm:px-2.5 sm:py-1.5 rounded-full text-xs font-medium transition-all shrink-0 active:scale-95 touch-manipulation ${
                  activeTool === 'text'
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                    : 'text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800'
                }`}
              >
                <Type className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                <span className="hidden md:inline ms-1">{isRtl ? 'نص' : 'Text'}</span>
              </button>

              {/* Eraser (ممحاة) */}
              <button
                type="button"
                onClick={() => onSelectTool('eraser')}
                title={isRtl ? 'الممحاة' : 'Eraser'}
                style={{ touchAction: 'manipulation' }}
                className={`flex items-center justify-center p-1.5 sm:px-2.5 sm:py-1.5 rounded-full text-xs font-medium transition-all shrink-0 active:scale-95 touch-manipulation ${
                  activeTool === 'eraser'
                    ? 'bg-rose-500 text-white shadow-md shadow-rose-500/30'
                    : 'text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800'
                }`}
              >
                <Eraser className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                <span className="hidden md:inline ms-1">{isRtl ? 'ممحاة' : 'Eraser'}</span>
              </button>

              {/* Color swatch & trigger */}
              {(activeTool === 'pencil' || activeTool === 'free_highlighter' || activeTool === 'text' || activeTool === 'text_highlight') && (
                <button
                  type="button"
                  onClick={() => {
                    setPaletteOpen(!paletteOpen);
                    setWidthPickerOpen(false);
                  }}
                  title={isRtl ? 'اختيار اللون' : 'Pick Color'}
                  style={{ backgroundColor: activeColor, touchAction: 'manipulation' }}
                  className="w-5 h-5 sm:w-6 sm:h-6 rounded-full border border-zinc-300 dark:border-zinc-600 shadow-sm flex items-center justify-center hover:scale-105 active:scale-95 transition-transform shrink-0 touch-manipulation"
                />
              )}

              <div className="w-[1px] h-3.5 sm:h-4 bg-zinc-200 dark:bg-zinc-800 mx-0.5 shrink-0" />

              {/* Add Note Button */}
              <button
                type="button"
                onClick={onAddNote}
                title={isRtl ? 'إضافة ملاحظة' : 'Add Note'}
                style={{ touchAction: 'manipulation' }}
                className="flex items-center justify-center p-1.5 sm:px-2.5 sm:py-1.5 rounded-full hover:bg-slate-100 dark:hover:bg-zinc-800 active:scale-95 transition-all text-xs font-medium text-slate-700 dark:text-zinc-300 shrink-0 touch-manipulation"
              >
                <NotebookPen className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-indigo-600 dark:text-indigo-400" />
                <span className="hidden md:inline ms-1">{isRtl ? 'ملاحظة' : 'Note'}</span>
              </button>

              <div className="w-[1px] h-3.5 sm:h-4 bg-zinc-200 dark:bg-zinc-800 mx-0.5 shrink-0" />

              {/* Undo / Redo */}
              <button
                type="button"
                onClick={onUndo}
                disabled={!canUndo}
                title={isRtl ? 'تراجع' : 'Undo'}
                style={{ touchAction: 'manipulation' }}
                className="w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-30 disabled:pointer-events-none active:scale-95 transition-all shrink-0 touch-manipulation"
              >
                <Undo2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              </button>
              <button
                type="button"
                onClick={onRedo}
                disabled={!canRedo}
                title={isRtl ? 'إعادة' : 'Redo'}
                style={{ touchAction: 'manipulation' }}
                className="w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-30 disabled:pointer-events-none active:scale-95 transition-all shrink-0 touch-manipulation"
              >
                <Redo2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              </button>

              {/* Simosan AI Quick Access */}
              {simosanAvailable && onOpenSimosan && (
                <>
                  <div className="w-[1px] h-3.5 sm:h-4 bg-zinc-200 dark:bg-zinc-800 mx-0.5 shrink-0" />
                  <button
                    type="button"
                    onClick={onOpenSimosan}
                    title={isRtl ? 'سيموسان الذكي' : 'Simosan AI'}
                    style={{ touchAction: 'manipulation' }}
                    className="flex items-center justify-center p-1.5 sm:px-2.5 sm:py-1.5 rounded-full bg-gradient-to-r from-amber-500/10 to-indigo-500/10 hover:from-amber-500/20 hover:to-indigo-500/20 text-indigo-600 dark:text-indigo-400 active:scale-95 transition-all text-xs font-semibold shrink-0 touch-manipulation"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                    <span className="hidden md:inline ms-1">{isRtl ? 'سيموسان' : 'Simosan'}</span>
                  </button>
                </>
              )}

              <div className="w-[1px] h-3.5 sm:h-4 bg-zinc-200 dark:bg-zinc-800 mx-0.5 shrink-0" />

              {/* Dismiss / Collapse Dock */}
              <button
                type="button"
                onClick={onCloseDock}
                title={isRtl ? 'إغلاق الشريط' : 'Close bar'}
                style={{ touchAction: 'manipulation' }}
                className="w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 active:scale-90 transition-all shrink-0 touch-manipulation"
              >
                <ChevronDown className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default NotewiseAnnotationDock;
