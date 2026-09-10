import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { addDoc, collection, doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { Paperclip, BarChart3, Send, Loader2, X, Link as LinkIcon, BookOpen, Check, AlertCircle, Pencil } from 'lucide-react';
import { db, storage } from '../../lib/firebase';
import { blocksToPlainText, isBlocksEmpty, plainTextToBlocks, safeUrl } from '../../lib/richText';
import { loadDraft, saveDraft, clearDraft, isDraftEmpty, type DraftPoll } from '../../lib/announcementDraft';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MIN_POLL_OPTIONS,
  type Announcement,
  type Attachment,
  type AttachmentKind,
  type RichBlock,
} from '../../types/announcement.types';
import type { Language, Lecture, UserProfile } from '../../types';
import AttachmentTray, { type StagedFile } from './AttachmentTray';
import PollBuilder, { emptyPoll } from './PollBuilder';

/**
 * The docked announcement composer.
 *
 * Pinned to the bottom and grows upward as it fills, the way a chat composer
 * does, rather than opening as a centred modal. Two constraints shape the
 * geometry:
 *
 *   - It never covers the status bar. The expanded panel caps at
 *     100dvh minus env(safe-area-inset-top), because index.html sets
 *     viewport-fit=cover and the WebView paints under the system clock.
 *   - The soft keyboard is handled by `dvh` plus adjustResize in the Android
 *     manifest, matching ChatScreen. That is the one keyboard-adjacent layout
 *     in this app with production mileage, so it is copied rather than reinvented.
 *
 * Tiptap is behind React.lazy: only staff mount this component at all, so the
 * editor bundle never reaches a student's device.
 */

const ComposerEditor = React.lazy(() => import('./ComposerEditor'));

const kindOf = (file: File): AttachmentKind =>
  file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file';

/** Firebase Storage rejects most non-ASCII object names; the display name is
 *  preserved separately on the attachment record. */
const safeName = (name: string) => name.replace(/[^a-zA-Z0-9.\-_]/g, '_');

interface Props {
  user: UserProfile | null;
  stageId: string;
  lang: Language;
  lectures: Lecture[];
  /** Non-null when an existing post is being edited. */
  editing: Announcement | null;
  onCancelEdit: () => void;
  /** True when the mirror bot is live for this stage. Drives whether the
   *  Telegram toggle is offered at all - a switch that provably does nothing is
   *  worse than no switch. */
  telegramEnabled?: boolean;
}

export default function Composer({ user, stageId, lang, lectures, editing, onCancelEdit, telegramEnabled }: Props) {
  const isRtl = lang === 'ar';

  const [blocks, setBlocks] = useState<RichBlock[]>([]);
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [keptAttachments, setKeptAttachments] = useState<Attachment[]>([]);
  const [poll, setPoll] = useState<DraftPoll | null>(null);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkTitle, setLinkTitle] = useState('');
  const [selectedLectures, setSelectedLectures] = useState<string[]>([]);
  // Intent, not capability: the composer says whether this post SHOULD reach
  // the channel, and the bot decides whether one is configured. Defaults on,
  // matching the "automatic with a per-post opt-out" behaviour that was chosen
  // over opt-in - staff forget to tick, and a stale channel is the failure.
  const [mirrorToTelegram, setMirrorToTelegram] = useState(true);

  const [expanded, setExpanded] = useState(false);
  const [showExtras, setShowExtras] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [draftLoaded, setDraftLoaded] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  // Read by the unmount cleanup, which must see the latest values without
  // re-registering the effect on every keystroke.
  const latest = useRef({ blocks, staged, poll, linkUrl, linkTitle, selectedLectures, editing });
  latest.current = { blocks, staged, poll, linkUrl, linkTitle, selectedLectures, editing };

  const reset = useCallback(() => {
    setBlocks([]);
    setStaged([]);
    setKeptAttachments([]);
    setPoll(null);
    setLinkUrl('');
    setLinkTitle('');
    setSelectedLectures([]);
    setMirrorToTelegram(true);
    setExpanded(false);
    setShowExtras(false);
    setError(null);
    setEditorKey(k => k + 1);
  }, []);

  /* ---- draft: restore on mount, persist on change and on unmount ---- */

  useEffect(() => {
    let alive = true;
    setDraftLoaded(false);
    loadDraft(stageId).then(draft => {
      if (!alive) return;
      if (draft && !editing) {
        setBlocks(draft.blocks);
        setStaged(draft.files.map(file => ({ file })));
        setPoll(draft.poll);
        setLinkUrl(draft.linkUrl);
        setLinkTitle(draft.linkTitle);
        setSelectedLectures(draft.selectedLectures);
        setEditorKey(k => k + 1);
      }
      setDraftLoaded(true);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageId]);

  useEffect(() => {
    if (!draftLoaded || editing) return;
    const snapshot = {
      blocks, poll, linkUrl, linkTitle, selectedLectures,
      files: staged.map(s => s.file),
    };
    const t = setTimeout(() => {
      if (isDraftEmpty(snapshot)) clearDraft(stageId);
      else saveDraft(stageId, snapshot);
    }, 600);
    return () => clearTimeout(t);
  }, [blocks, poll, linkUrl, linkTitle, selectedLectures, staged, stageId, draftLoaded, editing]);

  // Leaving the screen mid-sentence is one stray tap on a docked composer, so
  // the draft is flushed synchronously on the way out - the same guarantee
  // NoteEditorSheet gives PDF notes.
  useEffect(() => () => {
    const l = latest.current;
    if (l.editing) return;
    const snapshot = {
      blocks: l.blocks, poll: l.poll, linkUrl: l.linkUrl, linkTitle: l.linkTitle,
      selectedLectures: l.selectedLectures, files: l.staged.map(s => s.file),
    };
    if (!isDraftEmpty(snapshot)) saveDraft(stageId, snapshot);
  }, [stageId]);

  /* ---- edit mode ---- */

  useEffect(() => {
    if (!editing) return;
    setBlocks(editing.richBlocks?.length ? editing.richBlocks : plainTextToBlocks(editing.text ?? ''));
    setKeptAttachments(editing.attachments ?? []);
    setStaged([]);
    setPoll(editing.poll
      ? { question: editing.poll.question, options: editing.poll.options, allowsMultiple: editing.poll.allowsMultiple }
      : null);
    setLinkUrl(editing.linkUrl ?? '');
    setLinkTitle(editing.linkTitle ?? '');
    setSelectedLectures(editing.embeddedLectures ?? []);
    setMirrorToTelegram((editing as any).telegramMirror?.enabled !== false);
    setExpanded(true);
    setEditorKey(k => k + 1);
  }, [editing]);

  /* ---- attachments ---- */

  const addFiles = (list: FileList | null) => {
    if (!list?.length) return;
    const room = MAX_ATTACHMENTS - staged.length - keptAttachments.length;
    if (room <= 0) {
      setError(isRtl ? `الحد الأقصى ${MAX_ATTACHMENTS} مرفقات` : `Maximum ${MAX_ATTACHMENTS} attachments`);
      return;
    }

    const accepted: StagedFile[] = [];
    for (const file of Array.from(list).slice(0, room)) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(isRtl
          ? `«${file.name}» أكبر من 50 ميجابايت`
          : `"${file.name}" is larger than 50MB`);
        continue;
      }
      accepted.push({ file });
    }
    if (accepted.length) {
      setStaged(prev => [...prev, ...accepted]);
      setExpanded(true);
      setError(null);
    }
  };

  const uploadAll = async (): Promise<Attachment[]> => {
    const out: Attachment[] = [];

    for (let i = 0; i < staged.length; i++) {
      const { file } = staged[i];
      const path = `announcements/${stageId}/${Date.now()}_${safeName(file.name)}`;
      const task = uploadBytesResumable(ref(storage, path), file);

      const url = await new Promise<string>((resolve, reject) => {
        task.on(
          'state_changed',
          snap => {
            const progress = (snap.bytesTransferred / snap.totalBytes) * 100;
            setStaged(prev => prev.map((s, idx) => (idx === i ? { ...s, progress } : s)));
          },
          reject,
          async () => {
            try { resolve(await getDownloadURL(task.snapshot.ref)); }
            catch (err) { reject(err); }
          },
        );
      });

      out.push({
        id: `${Date.now()}_${i}`,
        kind: kindOf(file),
        url,
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        path,
      });
    }
    return out;
  };

  /* ---- submit ---- */

  const pollIsValid = !poll || (
    poll.question.trim().length > 0 &&
    poll.options.filter(o => o.text.trim()).length >= MIN_POLL_OPTIONS
  );

  const hasContent =
    !isBlocksEmpty(blocks) || staged.length > 0 || keptAttachments.length > 0 ||
    !!poll || !!linkUrl.trim() || selectedLectures.length > 0;

  const submit = async () => {
    if (!hasContent) {
      setError(isRtl ? 'أضف نصاً أو مرفقاً أو استطلاعاً' : 'Add text, an attachment or a poll');
      return;
    }
    if (!pollIsValid) {
      setError(isRtl ? 'الاستطلاع يحتاج سؤالاً وخيارين على الأقل' : 'A poll needs a question and at least two options');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const uploaded = await uploadAll();
      const plain = blocksToPlainText(blocks);

      const payload: Record<string, unknown> = {
        // Kept plain and in sync with the blocks: functions/index.js builds the
        // push-notification body from `text || content`, and the unread badge
        // and share-to-chat both read it too. None of them know about blocks.
        text: plain,
        content: plain,
        richBlocks: blocks,
        attachments: [...keptAttachments, ...uploaded],
        embeddedLectures: selectedLectures,
        linkUrl: safeUrl(linkUrl),
        linkTitle: linkTitle.trim() || null,
        stageId,
      };

      // Only ever the `enabled` flag from here. Every other field under
      // telegramMirror (chatId, messageIds, appliedHash) is bot-owned
      // bookkeeping, and a client write would desynchronise the mirror - so an
      // edit merges the flag in rather than replacing the map.
      if (editing) payload['telegramMirror.enabled'] = mirrorToTelegram;
      else payload.telegramMirror = { enabled: mirrorToTelegram };

      if (poll) {
        const options = poll.options.filter(o => o.text.trim());
        payload.poll = {
          question: poll.question.trim(),
          options,
          allowsMultiple: poll.allowsMultiple,
          // Seeded, never client-updated afterwards: tallyPollVotes owns these.
          counts: editing?.poll?.counts ?? Object.fromEntries(options.map(o => [o.id, 0])),
          totalVoters: editing?.poll?.totalVoters ?? 0,
        };
      }

      if (editing) {
        await updateDoc(doc(db, 'announcements', editing.id), { ...payload, updatedAt: serverTimestamp() });
        onCancelEdit();
      } else {
        await addDoc(collection(db, 'announcements'), {
          ...payload,
          createdBy: user?.uid,
          authorName: user?.name,
          createdAt: serverTimestamp(),
        });
        await clearDraft(stageId);
      }

      reset();
    } catch (err) {
      console.error('Error saving announcement:', err);
      setError(isRtl ? 'تعذّر حفظ التبليغ' : 'Could not save the announcement');
    } finally {
      setBusy(false);
    }
  };

  const cancelEdit = () => { onCancelEdit(); reset(); };

  const toggleLecture = (id: string) =>
    setSelectedLectures(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));

  const attachmentCount = staged.length + keptAttachments.length;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[60] bg-white dark:bg-zinc-900 border-t border-slate-200 dark:border-zinc-800 shadow-[0_-8px_30px_rgba(0,0,0,0.08)] dark:shadow-[0_-8px_30px_rgba(0,0,0,0.4)]"
      dir={isRtl ? 'rtl' : 'ltr'}
      style={{
        // Never taller than the viewport minus the status-bar inset, so the
        // expanded composer stops short of the system clock instead of under it.
        maxHeight: 'calc(100dvh - env(safe-area-inset-top) - 0.5rem)',
      }}
    >
      <div className="max-w-xl mx-auto flex flex-col min-h-0 px-3 pt-2 pb-[max(env(safe-area-inset-bottom),0.5rem)]">
        {editing && (
          <div className="flex items-center gap-2 mb-2 px-2 py-1.5 rounded-xl bg-sky-50 dark:bg-sky-900/20 border border-sky-100 dark:border-sky-900/40">
            <Pencil className="w-3.5 h-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
            <span className="flex-1 min-w-0 text-xs font-bold text-sky-700 dark:text-sky-300 truncate">
              {isRtl ? 'تعديل التبليغ' : 'Editing announcement'}
            </span>
            <button
              type="button"
              onClick={cancelEdit}
              aria-label={isRtl ? 'إلغاء التعديل' : 'Cancel editing'}
              className="p-1 rounded-lg text-sky-600 dark:text-sky-400 hover:bg-sky-100 dark:hover:bg-sky-900/40"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-1.5 mb-2 px-2.5 py-2 rounded-xl bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400 text-xs font-bold">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span className="flex-1">{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label={isRtl ? 'إخفاء' : 'Dismiss'}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <div className="overflow-y-auto aesthetic-scrollbar min-h-0 space-y-2">
          {keptAttachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {keptAttachments.map(a => (
                <span key={a.id} className="flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-100 dark:bg-zinc-800 text-[11px] font-bold text-slate-600 dark:text-slate-300 max-w-[160px]">
                  <span className="truncate" dir="auto">{a.name}</span>
                  <button
                    type="button"
                    onClick={() => setKeptAttachments(prev => prev.filter(x => x.id !== a.id))}
                    aria-label={isRtl ? 'إزالة' : 'Remove'}
                    className="shrink-0 text-slate-400 hover:text-rose-500"
                  >
                    <X className="w-3 h-3" strokeWidth={3} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <AttachmentTray
            staged={staged}
            busy={busy}
            isRtl={isRtl}
            onRemove={i => setStaged(prev => prev.filter((_, idx) => idx !== i))}
          />

          {poll && (
            <PollBuilder poll={poll} onChange={setPoll} onRemove={() => setPoll(null)} isRtl={isRtl} />
          )}

          <AnimatePresence initial={false}>
            {showExtras && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden space-y-2"
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    value={linkUrl}
                    onChange={e => setLinkUrl(e.target.value)}
                    dir="ltr"
                    inputMode="url"
                    placeholder={isRtl ? 'رابط خارجي (اختياري)' : 'External link (optional)'}
                    className="w-full px-3 py-2 text-sm text-left bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl outline-none focus:border-sky-500 text-slate-900 dark:text-stone-100"
                  />
                  <input
                    value={linkTitle}
                    onChange={e => setLinkTitle(e.target.value)}
                    dir="auto"
                    placeholder={isRtl ? 'عنوان الرابط (اختياري)' : 'Link title (optional)'}
                    className="w-full px-3 py-2 text-sm bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl outline-none focus:border-sky-500 text-slate-900 dark:text-stone-100"
                  />
                </div>

                {lectures.length > 0 && (
                  <div className="max-h-32 overflow-y-auto aesthetic-scrollbar rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950 p-1.5 space-y-0.5">
                    {lectures.map(lecture => (
                      <button
                        key={lecture.id}
                        type="button"
                        onClick={() => toggleLecture(lecture.id)}
                        className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-start transition-colors ${
                          selectedLectures.includes(lecture.id)
                            ? 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300'
                            : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-zinc-800'
                        }`}
                      >
                        <span className="text-xs font-bold truncate" dir="auto">{lecture.title}</span>
                        {selectedLectures.includes(lecture.id) && <Check className="w-3.5 h-3.5 shrink-0" />}
                      </button>
                    ))}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {expanded && (
            <Suspense
              fallback={
                <div className="flex items-center gap-2 py-3 text-slate-400 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {isRtl ? 'جارٍ تحميل المحرر...' : 'Loading editor...'}
                </div>
              }
            >
              <ComposerEditor
                key={editorKey}
                initialBlocks={blocks}
                onChange={setBlocks}
                isRtl={isRtl}
                placeholder={isRtl ? 'اكتب التبليغ هنا...' : 'Write your announcement...'}
              />
            </Suspense>
          )}
        </div>

        <div className="flex items-center gap-1 pt-2">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={e => { addFiles(e.target.files); if (fileRef.current) fileRef.current.value = ''; }}
          />

          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy || attachmentCount >= MAX_ATTACHMENTS}
            aria-label={isRtl ? 'إرفاق ملف' : 'Attach file'}
            title={isRtl ? 'إرفاق ملف' : 'Attach file'}
            className="relative w-10 h-10 shrink-0 rounded-full text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-40 flex items-center justify-center transition-colors"
          >
            <Paperclip className="w-5 h-5" strokeWidth={2.5} />
            {attachmentCount > 0 && (
              <span className="absolute -top-0.5 -end-0.5 min-w-4 h-4 px-1 rounded-full bg-sky-600 text-white text-[10px] font-black flex items-center justify-center">
                {attachmentCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => { setPoll(p => (p ? null : emptyPoll())); setExpanded(true); }}
            disabled={busy}
            aria-label={isRtl ? 'استطلاع' : 'Poll'}
            aria-pressed={!!poll}
            title={isRtl ? 'استطلاع' : 'Poll'}
            className={`w-10 h-10 shrink-0 rounded-full flex items-center justify-center transition-colors disabled:opacity-40 ${
              poll ? 'bg-sky-100 dark:bg-sky-900/40 text-sky-600 dark:text-sky-400'
                   : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800'
            }`}
          >
            <BarChart3 className="w-5 h-5" strokeWidth={2.5} />
          </button>

          <button
            type="button"
            onClick={() => { setShowExtras(v => !v); setExpanded(true); }}
            disabled={busy}
            aria-label={isRtl ? 'رابط ومحاضرات' : 'Link and lectures'}
            aria-pressed={showExtras}
            title={isRtl ? 'رابط ومحاضرات' : 'Link and lectures'}
            className={`w-10 h-10 shrink-0 rounded-full flex items-center justify-center transition-colors disabled:opacity-40 ${
              showExtras || linkUrl || selectedLectures.length
                ? 'bg-sky-100 dark:bg-sky-900/40 text-sky-600 dark:text-sky-400'
                : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800'
            }`}
          >
            {selectedLectures.length ? <BookOpen className="w-5 h-5" strokeWidth={2.5} /> : <LinkIcon className="w-5 h-5" strokeWidth={2.5} />}
          </button>

          {/* Offered only where the mirror is actually live for this stage.
              Lit means "this post also goes to the channel", which is the
              default - tapping it keeps the post inside the app. */}
          {telegramEnabled && (
            <button
              type="button"
              onClick={() => setMirrorToTelegram(v => !v)}
              disabled={busy}
              aria-label={isRtl ? 'نشر في قناة تيليجرام' : 'Post to the Telegram channel'}
              aria-pressed={mirrorToTelegram}
              title={mirrorToTelegram
                ? (isRtl ? 'سيُنشر في قناة تيليجرام' : 'Will post to the Telegram channel')
                : (isRtl ? 'داخل التطبيق فقط' : 'App only')}
              className={`w-10 h-10 shrink-0 rounded-full flex items-center justify-center transition-colors disabled:opacity-40 ${
                mirrorToTelegram
                  ? 'bg-cyan-100 dark:bg-cyan-900/40 text-cyan-600 dark:text-cyan-400'
                  : 'text-slate-400 dark:text-slate-600 hover:bg-slate-100 dark:hover:bg-zinc-800'
              }`}
            >
              <Send className={`w-[18px] h-[18px] ${isRtl ? 'rotate-180' : ''}`} strokeWidth={2.5} />
            </button>
          )}

          {!expanded && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="flex-1 min-w-0 text-start px-3 py-2.5 text-sm text-slate-400 dark:text-slate-500 font-medium truncate"
            >
              {isBlocksEmpty(blocks)
                ? (isRtl ? 'اكتب التبليغ هنا...' : 'Write your announcement...')
                : blocksToPlainText(blocks)}
            </button>
          )}
          {expanded && <div className="flex-1" />}

          <button
            type="button"
            onClick={submit}
            disabled={busy || !hasContent}
            aria-label={editing ? (isRtl ? 'حفظ التعديلات' : 'Save changes') : (isRtl ? 'نشر' : 'Publish')}
            className="w-10 h-10 shrink-0 rounded-full bg-sky-600 hover:bg-sky-700 text-white flex items-center justify-center transition-colors disabled:opacity-40 disabled:pointer-events-none"
          >
            {busy ? <Loader2 className="w-5 h-5 animate-spin" />
                  : editing ? <Check className="w-5 h-5" strokeWidth={2.5} />
                  : <Send className={`w-5 h-5 ${isRtl ? 'rotate-180' : ''}`} strokeWidth={2.5} />}
          </button>
        </div>
      </div>
    </div>
  );
}
