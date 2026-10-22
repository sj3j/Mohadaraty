import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Sparkles, Highlighter, NotebookPen, Copy, Globe, Share2, ChevronDown } from 'lucide-react';
import { HIGHLIGHT_COLORS, type HighlightColor } from '../../types/pdfAnnotation.types';

interface Props {
  position: { x: number; y: number } | null;
  selectedText: string;
  isRtl: boolean;
  onAskSimosan?: (text: string) => void;
  onHighlight: (color: HighlightColor) => void;
  onAddNote: () => void;
  onCopy: () => void;
  onTranslate: () => void;
  onShare: () => void;
  simosanAvailable?: boolean;
}

export const NotewiseSelectionCapsule: React.FC<Props> = ({
  position,
  selectedText,
  isRtl,
  onAskSimosan,
  onHighlight,
  onAddNote,
  onCopy,
  onTranslate,
  onShare,
  simosanAvailable,
}) => {
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [selectedColor, setSelectedColor] = useState<HighlightColor>('yellow');

  if (!position) return null;

  // Keep menu within screen viewport boundaries
  const clampX = Math.max(160, Math.min(window.innerWidth - 160, position.x));
  const topPos = Math.max(70, position.y - 56);

  return (
    <div
      className="fixed z-50 pointer-events-auto transition-all"
      style={{
        left: `${clampX}px`,
        top: `${topPos}px`,
        transform: 'translate(-50%, -100%)',
      }}
    >
      <div className="flex flex-col items-center">
        {/* Main Floating Capsule */}
        <div className="flex items-center gap-0.5 bg-zinc-900/95 dark:bg-zinc-800/95 backdrop-blur-md text-white shadow-xl shadow-black/25 rounded-full px-2 py-1.5 border border-zinc-700/50">
          {/* Simosan AI Action (replaces Notewise Magic Select) */}
          {simosanAvailable && onAskSimosan && (
            <>
              <button
                type="button"
                onClick={() => onAskSimosan(selectedText)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gradient-to-r from-amber-500/20 to-indigo-500/20 hover:from-amber-500/30 hover:to-indigo-500/30 text-amber-300 font-semibold text-xs active:scale-95 transition-all group"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-300 group-hover:rotate-12 transition-transform" />
                <span>{isRtl ? 'سيموسان' : 'Simosan AI'}</span>
              </button>
              <div className="w-[1px] h-4 bg-zinc-700 mx-1" />
            </>
          )}

          {/* Highlight Tool with Color Picker Toggle */}
          <div className="relative">
            <button
              type="button"
              onClick={() => onHighlight(selectedColor)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-full hover:bg-zinc-800 dark:hover:bg-zinc-700 text-xs text-zinc-200 active:scale-95 transition-all"
            >
              <span
                className="w-3 h-3 rounded-full border border-white/20"
                style={{ backgroundColor: HIGHLIGHT_COLORS[selectedColor] || '#fde68a' }}
              />
              <span className="text-xs">{isRtl ? 'تظليل' : 'Highlight'}</span>
              <span
                role="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowColorPicker(!showColorPicker);
                }}
                className="p-0.5 hover:text-white"
              >
                <ChevronDown className="w-3 h-3" />
              </span>
            </button>

            {/* Color Palette Popover */}
            <AnimatePresence>
              {showColorPicker && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9, y: 4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9, y: 4 }}
                  className="absolute bottom-full mb-2 left-0 flex items-center gap-1.5 bg-zinc-900/95 dark:bg-zinc-800/95 backdrop-blur-md p-1.5 rounded-full shadow-xl border border-zinc-700/60"
                >
                  {(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => {
                        setSelectedColor(c);
                        onHighlight(c);
                        setShowColorPicker(false);
                      }}
                      className="w-5 h-5 rounded-full border border-white/30 hover:scale-115 active:scale-95 transition-transform"
                      style={{ backgroundColor: HIGHLIGHT_COLORS[c] }}
                    />
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="w-[1px] h-4 bg-zinc-700 mx-0.5" />

          {/* Add Note Button */}
          <button
            type="button"
            onClick={onAddNote}
            title={isRtl ? 'إضافة ملاحظة' : 'Add Note'}
            className="p-1.5 rounded-full hover:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-300 hover:text-white active:scale-95 transition-all"
          >
            <NotebookPen className="w-4 h-4" />
          </button>

          {/* Copy Button */}
          <button
            type="button"
            onClick={onCopy}
            title={isRtl ? 'نسخ' : 'Copy'}
            className="p-1.5 rounded-full hover:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-300 hover:text-white active:scale-95 transition-all"
          >
            <Copy className="w-4 h-4" />
          </button>

          {/* Translate Button */}
          <button
            type="button"
            onClick={onTranslate}
            title={isRtl ? 'ترجمة' : 'Translate'}
            className="p-1.5 rounded-full hover:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-300 hover:text-white active:scale-95 transition-all"
          >
            <Globe className="w-4 h-4" />
          </button>

          {/* Share Button */}
          <button
            type="button"
            onClick={onShare}
            title={isRtl ? 'مشاركة' : 'Share'}
            className="p-1.5 rounded-full hover:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-300 hover:text-white active:scale-95 transition-all"
          >
            <Share2 className="w-4 h-4" />
          </button>
        </div>

        {/* Pointer tip */}
        <div className="w-2 h-2 bg-zinc-900/95 dark:bg-zinc-800/95 rotate-45 -mt-1 shadow-sm" />
      </div>
    </div>
  );
};

export default NotewiseSelectionCapsule;
