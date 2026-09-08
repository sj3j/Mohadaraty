import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, useMotionValue } from 'motion/react';
import { AlertTriangle, ArrowUp, BatteryLow, ListOrdered, Plus, Sparkles, WifiOff, X } from 'lucide-react';
import {
  AskError, askSimosan, fetchSimosanState, formatReset, parseCitations,
  watchLecture, watchMessages,
  type SimosanMessage, type SimosanState,
} from '../../services/simosanService';
import SimosanMarkdown from './SimosanMarkdown';

interface Props {
  isRtl: boolean;
  lectureId: string;
  /** Text the student had selected when they invoked Simosan, if any. */
  seedSelection?: string | null;
  onJumpToPage: (page: number) => void;
  onClose: () => void;
}

/**
 * Simosan — the AI tutor drawer.
 *
 * Structure, z-indices and animation are copied from NotesDrawer on purpose:
 * this is the reader's third overlay and it should feel like the other two.
 * Strings are inlined ar/en against `isRtl` rather than going through
 * TRANSLATIONS, which is the convention every component in this folder follows.
 *
 * The bot is never called Gemini anywhere a student can see.
 */
export default function SimosanDrawer({
  isRtl, lectureId, seedSelection, onJumpToPage, onClose,
}: Props) {
  const [state, setState] = useState<SimosanState | null>(null);
  const [threadId, setThreadId] = useState('');
  const [messages, setMessages] = useState<SimosanMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [selection, setSelection] = useState<string | null>(seedSelection || null);
  const [streaming, setStreaming] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AskError | null>(null);
  const [readOnly, setReadOnly] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /*
   * Phones get a bottom sheet; tablets and up keep the side drawer.
   *
   * This is a JS check rather than a CSS breakpoint because the two layouts
   * animate on different axes (y vs x) and Framer needs to know which before
   * it mounts. On a ~400px phone the side drawer is 384px wide, so narrowing
   * it would still leave a sliver of lecture - only a sheet actually shows the
   * slide and the tutor at once, which is the whole point of the change.
   */
  const [isPhone, setIsPhone] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const on = () => setIsPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  /** 'half' keeps the slide readable; 'full' is for tables and walkthroughs. */
  const [snap, setSnap] = useState<'half' | 'full'>('half');
  const sheetHeight = snap === 'full' ? '92vh' : '55vh';

  useEffect(() => { fetchSimosanState().then(setState); }, []);
  useEffect(() => watchLecture(lectureId, setThreadId), [lectureId]);
  useEffect(() => {
    if (!threadId) { setMessages([]); return; }
    return watchMessages(lectureId, threadId, setMessages);
  }, [lectureId, threadId]);

  // Keep the newest turn in view as it streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, pending]);

  useEffect(() => {
    if (seedSelection) setTimeout(() => inputRef.current?.focus(), 150);
  }, [seedSelection]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const questionCount = useMemo(
    () => messages.filter((m) => m.role === 'user').length,
    [messages],
  );
  const maxQuestions = state?.maxQuestionsPerChat ?? 25;
  const atCap = readOnly || questionCount >= maxQuestions;

  const energyPct = state && state.dailyBudget > 0
    ? Math.max(0, Math.min(100, Math.round((state.remaining / state.dailyBudget) * 100)))
    : 100;

  const send = useCallback(async (
    opts: { newThread?: boolean; walkthrough?: boolean; overrideText?: string } = {},
  ) => {
    const text = (opts.overrideText ?? draft).trim();
    if (!text || busy) return;

    setBusy(true);
    setError(null);
    setPending(text);
    setStreaming('');
    setDraft('');
    const usedSelection = selection;
    setSelection(null);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      await askSimosan(
        {
          lectureId,
          question: text,
          selection: usedSelection || undefined,
          newThread: opts.newThread,
          walkthrough: opts.walkthrough,
        },
        {
          onMeta: (meta) => {
            setThreadId(meta.threadId);
            setState((s) => (s ? { ...s, remaining: meta.remaining } : s));
          },
          onDelta: (d) => setStreaming((prev) => prev + d),
          onDone: (done) => {
            setState((s) => (s ? { ...s, remaining: done.remaining } : s));
            setReadOnly(done.isReadOnly);
            // The server commits both messages before emitting `done`, so the
            // Firestore listener already holds them - dropping the optimistic
            // copies here avoids rendering each turn twice.
            setStreaming('');
            setPending(null);
            if (done.offTopic) {
              setError(new AskError('internal'));
              setStreaming('');
            }
          },
        },
        ac.signal,
      );
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        setError(e instanceof AskError ? e : new AskError('internal'));
        setDraft(text);
        setSelection(usedSelection);
      }
      setPending(null);
      setStreaming('');
    } finally {
      setBusy(false);
      abortRef.current = null;
      fetchSimosanState().then((s) => s && setState(s));
    }
  }, [draft, busy, lectureId, selection]);

  const startNewChat = useCallback(() => {
    setReadOnly(false);
    setMessages([]);
    setThreadId('');
    setError(null);
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  return (
    <>
      {/*
        NO SCRIM, deliberately.

        A dimmed backdrop was hiding the lecture behind a modal - the thing
        students asked to have back. Without it the reader stays fully visible
        AND interactive: it can be scrolled and pinch-zoomed while the chat is
        open, which is what makes a page citation useful.

        Two consequences that had to be accepted: there is no tap-outside to
        dismiss, so the close button and Android back (useBackDismiss
        'pdfSimosan') are the only exits; and this element must stay a SIBLING
        of the PDF scroll container, never a child, or its transform would
        become the reader's containing block and break pinch-zoom.
      */}
      {isPhone ? (
        <motion.aside
          initial={{ y: '100%' }}
          animate={{ y: 0, height: sheetHeight }}
          exit={{ y: '100%' }}
          transition={{ type: 'spring', damping: 32, stiffness: 320 }}
          dir={isRtl ? 'rtl' : 'ltr'}
          className="fixed inset-x-0 bottom-0 z-[171] rounded-t-3xl bg-white dark:bg-zinc-900 border-t border-slate-200 dark:border-zinc-800 shadow-[0_-8px_32px_rgba(0,0,0,0.28)] flex flex-col"
        >
          {/*
            Drag lives on the HANDLE, not the panel. Dragging the panel would
            fight the message list for the same vertical gesture and make
            scrolling a coin toss.
          */}
          <motion.div
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={0.35}
            dragMomentum={false}
            onDragEnd={(_, info) => {
              if (info.offset.y < -40) setSnap('full');
              else if (info.offset.y > 40) {
                if (snap === 'half') onClose(); else setSnap('half');
              }
            }}
            onClick={() => setSnap((v) => (v === 'half' ? 'full' : 'half'))}
            className="shrink-0 pt-2.5 pb-1 flex items-center justify-center cursor-grab active:cursor-grabbing touch-none"
            aria-label={isRtl ? 'تغيير ارتفاع اللوحة' : 'Resize panel'}
          >
            <div className="w-10 h-1.5 rounded-full bg-slate-300 dark:bg-zinc-600" />
          </motion.div>
          {renderBody()}
        </motion.aside>
      ) : (
        <motion.aside
          initial={{ x: isRtl ? '-100%' : '100%' }}
          animate={{ x: 0 }}
          exit={{ x: isRtl ? '-100%' : '100%' }}
          transition={{ type: 'spring', damping: 32, stiffness: 320 }}
          dir={isRtl ? 'rtl' : 'ltr'}
          className={`fixed inset-y-0 ${isRtl ? 'start-0' : 'end-0'} z-[171] w-full max-w-sm bg-white dark:bg-zinc-900 shadow-2xl flex flex-col border-s border-slate-200 dark:border-zinc-800`}
        >
          {renderBody()}
        </motion.aside>
      )}
    </>
  );

  /**
   * Invoked as {renderBody()}, never mounted as <SheetBody />.
   *
   * A function declared inside the component body is a new function identity
   * on every render. Used as a JSX element that makes it a new component TYPE
   * each time, so React tears the subtree down and rebuilds it on every
   * keystroke - the textarea loses focus and the message list jumps to the top.
   * Calling it just splices the JSX in place.
   */
  function renderBody() {
    return (
      <>
        {/* header */}
        <div className="shrink-0 px-4 pb-3 pt-[max(env(safe-area-inset-top),0.75rem)] border-b border-slate-100 dark:border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-violet-500 to-sky-500 flex items-center justify-center shrink-0">
              <Sparkles className="w-4.5 h-4.5 text-white" strokeWidth={2.5} />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-black text-slate-900 dark:text-stone-100 leading-tight">
                {isRtl ? 'سيموسان' : 'Simosan'}
              </h2>
              <p className="text-[11px] font-bold text-slate-400 dark:text-slate-500">
                {isRtl ? `سؤال ${questionCount} من ${maxQuestions}` : `Question ${questionCount} of ${maxQuestions}`}
              </p>
            </div>
            <button
              onClick={onClose}
              aria-label={isRtl ? 'إغلاق' : 'Close'}
              className="w-9 h-9 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 active:scale-90 transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Energy. Shown as a proportion, never as raw tokens - and never as
              something that can be topped up, which would read as an in-app
              purchase in the store build. */}
          <div className="mt-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400">
                {isRtl ? 'طاقة اليوم' : "Today's energy"}
              </span>
              <span className="text-[11px] font-black text-slate-600 dark:text-slate-300">{energyPct}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-slate-100 dark:bg-zinc-800 overflow-hidden">
              <div
                className={`h-full rounded-full transition-[width] duration-500 ${
                  energyPct > 25 ? 'bg-gradient-to-r from-violet-500 to-sky-500' : 'bg-amber-500'
                }`}
                style={{ width: `${energyPct}%` }}
              />
            </div>
          </div>
        </div>

        {/* messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          <div className="flex items-start gap-2 rounded-2xl bg-slate-50 dark:bg-zinc-800/60 p-3">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <p className="text-[11px] font-bold text-slate-500 dark:text-slate-400 leading-relaxed" dir="auto">
              {isRtl
                ? 'سيموسان قد يخطئ. تأكّد دائماً من الصفحة المذكورة في المحاضرة.'
                : 'Simosan can be wrong. Always check the cited page in the lecture.'}
            </p>
          </div>

          {messages.length === 0 && !pending && (
            <div className="pt-6 text-center">
              <p className="text-sm font-bold text-slate-400 dark:text-slate-500 leading-relaxed" dir="auto">
                {isRtl
                  ? 'اسألني عن أي شيء في هذه المحاضرة.'
                  : 'Ask me anything about this lecture.'}
              </p>
            </div>
          )}

          {messages.map((m) => <Bubble key={m.id} m={m} isRtl={isRtl} onJumpToPage={onJumpToPage} />)}

          {pending && (
            <Bubble m={{ id: '_p', role: 'user', text: pending }} isRtl={isRtl} onJumpToPage={onJumpToPage} />
          )}
          {(streaming || busy) && (
            <Bubble
              m={{ id: '_s', role: 'model', text: streaming, pending: !streaming }}
              isRtl={isRtl}
              onJumpToPage={onJumpToPage}
            />
          )}

          {error && <ErrorNote error={error} isRtl={isRtl} state={state} />}
        </div>

        {/* composer */}
        <div className="shrink-0 border-t border-slate-100 dark:border-zinc-800 px-3 pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
          {/* A guided walkthrough is several billed turns, so it is offered
              explicitly rather than inferred - and only at the start of a
              thread, where it makes sense. The marker it sends is what makes
              chunking deterministic instead of a guess about wording. */}
          {!atCap && messages.length === 0 && !busy && (
            <button
              onClick={() => send({ walkthrough: true, overrideText: 'اشرح لي هذه المحاضرة بالكامل، جزءاً جزءاً.' })}
              className="w-full mb-2 h-10 rounded-2xl border-2 border-violet-200 dark:border-violet-800 text-violet-600 dark:text-violet-300 text-xs font-black flex items-center justify-center gap-2 active:scale-[0.98] transition"
            >
              <ListOrdered className="w-4 h-4" />
              {isRtl ? 'اشرح المحاضرة بأجزاء' : 'Explain the lecture in parts'}
            </button>
          )}

          {selection && (
            <div className="mb-2 rounded-xl bg-violet-50 dark:bg-violet-950/30 border-s-4 border-violet-400 px-3 py-2 flex items-start gap-2">
              <p className="flex-1 text-[11px] font-bold text-slate-600 dark:text-slate-300 line-clamp-2" dir="auto">
                {selection}
              </p>
              <button
                onClick={() => setSelection(null)}
                aria-label={isRtl ? 'إزالة التحديد' : 'Remove selection'}
                className="text-slate-400 shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {atCap ? (
            <button
              onClick={startNewChat}
              className="w-full h-11 rounded-2xl bg-slate-900 dark:bg-stone-100 text-white dark:text-zinc-900 text-sm font-black flex items-center justify-center gap-2 active:scale-[0.98] transition"
            >
              <Plus className="w-4 h-4" />
              {isRtl ? 'محادثة جديدة' : 'New chat'}
            </button>
          ) : (
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                }}
                rows={1}
                dir="auto"
                maxLength={2000}
                placeholder={isRtl ? 'اسأل عن المحاضرة…' : 'Ask about the lecture…'}
                className="flex-1 max-h-28 resize-none rounded-2xl bg-slate-100 dark:bg-zinc-800 px-4 py-2.5 text-sm font-bold text-slate-800 dark:text-stone-100 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-violet-400"
              />
              <button
                onClick={() => send()}
                disabled={!draft.trim() || busy}
                aria-label={isRtl ? 'إرسال' : 'Send'}
                className="w-10 h-10 shrink-0 rounded-full bg-gradient-to-br from-violet-500 to-sky-500 text-white flex items-center justify-center disabled:opacity-40 active:scale-90 transition"
              >
                <ArrowUp className="w-5 h-5" strokeWidth={2.5} />
              </button>
            </div>
          )}

          {atCap && (
            <p className="mt-2 text-center text-[11px] font-bold text-slate-400" dir="auto">
              {isRtl
                ? 'اكتملت هذه المحادثة. يمكنك قراءتها دائماً، وبدء محادثة جديدة عن نفس المحاضرة.'
                : 'This chat is complete. It stays readable, and you can start a new one on the same lecture.'}
            </p>
          )}
        </div>
      </>
    );
  }
}

/* ------------------------------------------------------------------ */

interface BubbleProps {
  m: SimosanMessage;
  isRtl: boolean;
  onJumpToPage: (p: number) => void;
  /** React reserves `key`, but @types/react is not installed in this repo (see
   *  CLAUDE.md), so JSX has no idea it is special and checks it as an ordinary
   *  prop. Declared here only to keep `tsc --noEmit` honest. */
  key?: string;
}

function Bubble({ m, isRtl, onJumpToPage }: BubbleProps) {
  const mine = m.role === 'user';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm font-bold leading-relaxed ${
          mine
            ? 'bg-slate-900 dark:bg-stone-100 text-white dark:text-zinc-900'
            : 'bg-slate-100 dark:bg-zinc-800 text-slate-800 dark:text-stone-100'
        }`}
        dir="auto"
      >
        {m.pending ? (
          <span className="inline-flex gap-1 py-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-pulse"
                style={{ animationDelay: `${i * 160}ms` }}
              />
            ))}
          </span>
        ) : mine ? (
          // The student's own text is never markdown - rendering it as such
          // would let a stray asterisk silently restyle what they typed.
          parseCitations(m.text).map((part, i) =>
            'page' in part ? null : <span key={i} className="whitespace-pre-wrap">{part.text}</span>,
          )
        ) : (
          <SimosanMarkdown text={m.text} isRtl={isRtl} onJumpToPage={onJumpToPage} />
        )}
      </div>
    </div>
  );
}

function ErrorNote({
  error, isRtl, state,
}: { error: AskError; isRtl: boolean; state: SimosanState | null }) {
  const reset = error.detail.resetsInMs ?? state?.resetsInMs ?? 0;

  const { Icon, text } = (() => {
    switch (error.code) {
      case 'insufficient_energy':
        return {
          Icon: BatteryLow,
          text: isRtl
            ? `انتهت طاقتك لهذا اليوم. تتجدد بعد ${formatReset(reset, true)}.`
            : `You're out of energy for today. It refills in ${formatReset(reset, false)}.`,
        };
      case 'offline':
        return {
          Icon: WifiOff,
          text: isRtl
            ? 'لا يوجد اتصال بالإنترنت. سيموسان يحتاج اتصالاً للإجابة.'
            : 'No internet connection. Simosan needs one to answer.',
        };
      case 'disabled':
      case 'ceiling_reached':
      // A dead or exhausted API key reads to the student exactly like any other
      // outage. Naming the provider or the quota would tell them nothing they
      // can act on, and would put vendor and billing language on a study screen.
      case 'ai_unavailable':
        return {
          Icon: AlertTriangle,
          text: isRtl
            ? 'سيموسان غير متاح حالياً. حاول لاحقاً.'
            : 'Simosan is unavailable right now. Try again later.',
        };
      case 'not_subscribed':
        return {
          Icon: AlertTriangle,
          text: isRtl ? 'هذه الميزة تتطلب اشتراكاً فعالاً.' : 'This feature requires an active subscription.',
        };
      case 'pdf_too_large':
      case 'pdf_too_many_pages':
      case 'lecture_has_no_pdf':
        return {
          Icon: AlertTriangle,
          text: isRtl
            ? 'لا يمكن لسيموسان قراءة ملف هذه المحاضرة.'
            : 'Simosan cannot read this lecture file.',
        };
      default:
        return {
          Icon: AlertTriangle,
          text: isRtl
            ? 'تعذّر الحصول على إجابة. لم تُخصم أي طاقة.'
            : "Couldn't get an answer. No energy was used.",
        };
    }
  })();

  return (
    <div className="flex items-start gap-2 rounded-2xl bg-amber-50 dark:bg-amber-950/30 p-3">
      <Icon className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
      <p className="text-xs font-bold text-amber-800 dark:text-amber-200 leading-relaxed" dir="auto">
        {text}
      </p>
    </div>
  );
}
