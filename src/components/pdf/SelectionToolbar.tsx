import { motion } from 'motion/react';
import { Copy, Languages, Search, Share2, Sparkles, StickyNote, X } from 'lucide-react';
import { HIGHLIGHT_COLORS, type HighlightColor } from '../../types/pdfAnnotation.types';

interface Props {
  isRtl: boolean;
  onPick: (color: HighlightColor) => void;
  onNote: () => void;
  onCopy: () => void;
  onTranslate: () => void;
  onSearchWeb: () => void;
  onShare: () => void;
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
 *
 * Suppressing the native menu IS possible - a WebView subclass overriding
 * startActionMode, installed from MainActivity - but it is native Java in an
 * Activity that is currently a bare BridgeActivity, and it re-opens the exact
 * tap-stealing bug above if the override is ever incomplete. The actions that
 * motivated a floating bar (translate, web search, share) are all reachable from
 * here instead, so the native route buys placement only.
 *
 * TWO ROWS, because there are now twelve controls. One row put the five colours
 * and seven actions inside 360dp, which is under the 44px minimum touch target.
 * Colours and in-app actions sit on the first row, "send this text elsewhere"
 * actions on the second.
 */
export default function SelectionToolbar({
  isRtl, onPick, onNote, onCopy, onTranslate, onSearchWeb, onShare, onDismiss, onAskSimosan,
}: Props) {
  const label = (ar: string, en: string) => (isRtl ? ar : en);

  return (
    <motion.div
      initial={{ y: '100%', opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: '100%', opacity: 0 }}
      transition={{ type: 'spring', damping: 30, stiffness: 380 }}
      dir={isRtl ? 'rtl' : 'ltr'}
      className="absolute inset-x-0 bottom-0 z-[5] border-t border-zinc-700 bg-zinc-900/95 backdrop-blur px-3 py-2.5 pb-[max(env(safe-area-inset-bottom),0.75rem)] shadow-[0_-8px_24px_rgba(0,0,0,0.35)] space-y-2"
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
          <button
            onClick={onNote}
            aria-label={label('إضافة ملاحظة', 'Add note')}
            className="w-10 h-10 rounded-full flex items-center justify-center text-white/90 hover:bg-white/10 active:scale-90 transition"
          >
            <StickyNote className="w-5 h-5" />
          </button>
          <button
            onClick={onDismiss}
            aria-label={label('إلغاء التحديد', 'Clear selection')}
            className="w-10 h-10 rounded-full flex items-center justify-center text-white/60 hover:bg-white/10 active:scale-90 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-white/10 pt-2">
        {onAskSimosan ? (
          <button
            onClick={onAskSimosan}
            aria-label={label('اسأل سيموسان', 'Ask Simosan')}
            className="h-10 px-3 rounded-full flex items-center gap-1.5 bg-gradient-to-br from-violet-500 to-sky-500 text-white text-xs font-black active:scale-90 transition shrink-0"
          >
            <Sparkles className="w-4 h-4" strokeWidth={2.5} />
            {label('سيموسان', 'Simosan')}
          </button>
        ) : <span />}

        <div className="flex items-center gap-1">
          <button
            onClick={onCopy}
            aria-label={label('نسخ', 'Copy')}
            className="w-10 h-10 rounded-full flex items-center justify-center text-white/90 hover:bg-white/10 active:scale-90 transition"
          >
            <Copy className="w-5 h-5" />
          </button>
          <button
            onClick={onTranslate}
            aria-label={label('ترجمة', 'Translate')}
            className="w-10 h-10 rounded-full flex items-center justify-center text-white/90 hover:bg-white/10 active:scale-90 transition"
          >
            <Languages className="w-5 h-5" />
          </button>
          <button
            onClick={onSearchWeb}
            aria-label={label('بحث في الويب', 'Search the web')}
            className="w-10 h-10 rounded-full flex items-center justify-center text-white/90 hover:bg-white/10 active:scale-90 transition"
          >
            <Search className="w-5 h-5" />
          </button>
          <button
            onClick={onShare}
            aria-label={label('مشاركة', 'Share')}
            className="w-10 h-10 rounded-full flex items-center justify-center text-white/90 hover:bg-white/10 active:scale-90 transition"
          >
            <Share2 className="w-5 h-5" />
          </button>
        </div>
      </div>
    </motion.div>
  );
}
