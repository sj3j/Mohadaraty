import { motion } from 'motion/react';
import { Copy, Sparkles, StickyNote, X } from 'lucide-react';
import { HIGHLIGHT_COLORS, type HighlightColor } from '../../types/pdfAnnotation.types';

interface Props {
  isRtl: boolean;
  onPick: (color: HighlightColor) => void;
  onNote: () => void;
  onCopy: () => void;
  onDismiss: () => void;
  /** Omitted when the student has no Simosan access, or the lecture has no
   *  readable PDF - the action is hidden rather than shown and refused. */
  onAskSimosan?: () => void;
}

const ORDER: HighlightColor[] = ['yellow', 'green', 'blue', 'pink', 'orange'];

/**
 * The highlight bar shown while text is selected.
 *
 * DOCKED at the bottom rather than floating over the selection, and that is not
 * a style choice. Both platforms draw their own selection menu right at the
 * selected text - Android's ActionMode bar (Copy / Share / Select All) and iOS's
 * callout - and neither can be suppressed from inside a WebView. A floating
 * toolbar lands underneath the native one and swallows taps: on Android the tap
 * that should pick a colour hits "Select All" instead. Docking it keeps both
 * menus visible and reachable, and puts the controls in the same place every
 * time rather than wherever the text happened to be.
 */
export default function SelectionToolbar({
  isRtl, onPick, onNote, onCopy, onDismiss, onAskSimosan,
}: Props) {
  return (
    <motion.div
      initial={{ y: '100%', opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: '100%', opacity: 0 }}
      transition={{ type: 'spring', damping: 30, stiffness: 380 }}
      dir={isRtl ? 'rtl' : 'ltr'}
      className="absolute inset-x-0 bottom-0 z-[5] border-t border-zinc-700 bg-zinc-900/95 backdrop-blur px-3 py-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] shadow-[0_-8px_24px_rgba(0,0,0,0.35)]"
      // Never let a press here collapse the selection before the handler runs.
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => e.preventDefault()}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {ORDER.map((c) => (
            <button
              key={c}
              onClick={() => onPick(c)}
              aria-label={c}
              className="w-10 h-10 rounded-full ring-2 ring-white/25 active:scale-90 transition-transform"
              style={{ background: HIGHLIGHT_COLORS[c] }}
            />
          ))}
        </div>

        <div className="flex items-center gap-1">
          {onAskSimosan && (
            <button
              onClick={onAskSimosan}
              aria-label={isRtl ? 'اسأل سيموسان' : 'Ask Simosan'}
              className="h-10 px-3 rounded-full flex items-center gap-1.5 bg-gradient-to-br from-violet-500 to-sky-500 text-white text-xs font-black active:scale-90 transition"
            >
              <Sparkles className="w-4 h-4" strokeWidth={2.5} />
              {isRtl ? 'سيموسان' : 'Simosan'}
            </button>
          )}
          <button
            onClick={onNote}
            aria-label={isRtl ? 'إضافة ملاحظة' : 'Add note'}
            className="w-10 h-10 rounded-full flex items-center justify-center text-white/90 hover:bg-white/10 active:scale-90 transition"
          >
            <StickyNote className="w-5 h-5" />
          </button>
          <button
            onClick={onCopy}
            aria-label={isRtl ? 'نسخ' : 'Copy'}
            className="w-10 h-10 rounded-full flex items-center justify-center text-white/90 hover:bg-white/10 active:scale-90 transition"
          >
            <Copy className="w-5 h-5" />
          </button>
          <button
            onClick={onDismiss}
            aria-label={isRtl ? 'إلغاء التحديد' : 'Clear selection'}
            className="w-10 h-10 rounded-full flex items-center justify-center text-white/60 hover:bg-white/10 active:scale-90 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>
    </motion.div>
  );
}
