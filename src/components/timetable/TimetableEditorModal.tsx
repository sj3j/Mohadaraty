/**
 * Review and publish the AI-parsed weekly timetable.
 *
 * The human-in-the-loop half of the feature. Gemini reads a photographed grid;
 * nothing it produces reaches a student until someone here presses نشر.
 *
 * Two documents are in play and the split matters: the DRAFT is what this
 * screen edits and what /api/timetable/parse writes, while the PUBLISHED week
 * is written only by the publish button below. That is why a failed re-parse
 * cannot take a working timetable off students' screens.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Sparkles, Loader2, Plus, Image as ImageIcon, AlertTriangle,
  Send, EyeOff, CheckCircle2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useBackDismiss } from '../../hooks/useBackDismiss';
import { useStageContext } from '../../contexts/StageContext';
import TimetableSessionRow from './TimetableSessionRow';
import {
  publishTimetable, requestTimetableParse, saveDraftSessions,
  unpublishTimetable, watchDraftTimetable,
  TimetableUnavailableError,
} from '../../services/timetableService';
import {
  DAY_LABELS, groupSessionsByDay, mintSessionId, overlappingSessions,
  unlabelledPracticals, timeToMinutes,
  type DayIndex, type StageTimetableDoc, type TimetableSession,
} from '../../../shared/timetable';
import type { UserProfile } from '../../types';

interface TimetableEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  user: UserProfile | null;
  isRtl: boolean;
  /** The stage's master image, so it can be read while correcting. */
  photoUrl: string | null;
  /**
   * The published week, PASSED DOWN rather than watched here.
   *
   * WeeklyListScreen already holds a listener on timetables/{stageId}. A second
   * onSnapshot on the same document from this modal meant two overlapping
   * targets on one key, added and removed together every time the modal opened
   * - and under React StrictMode each of those cycles runs twice, synchronously.
   * That churn is what made the watch stream's pendingResponses go negative and
   * kill the SDK with an internal assertion. One listener per document.
   */
  published: StageTimetableDoc | null | undefined;
}

const ALL_DAYS: DayIndex[] = [0, 1, 2, 3, 4, 5, 6];

export default function TimetableEditorModal({
  isOpen, onClose, user, isRtl, photoUrl, published,
}: TimetableEditorModalProps) {
  const { effectiveStageId, groupConfig } = useStageContext();

  const [draft, setDraft] = useState<StageTimetableDoc | null | undefined>(undefined);
  const [sessions, setSessions] = useState<TimetableSession[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [showImage, setShowImage] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useBackDismiss(isOpen, onClose, 'timetableEditor');

  /* Keep the local list in step with the draft, but only while the user is not
   * mid-edit: a re-render from our own debounced save must not clobber what is
   * being typed. `dirty` is the guard. */
  const dirty = useRef(false);
  const saveTimer = useRef<any>(null);

  useEffect(() => {
    if (!isOpen || !effectiveStageId) return;
    const unsubDraft = watchDraftTimetable(effectiveStageId, (doc) => {
      setDraft(doc);
      if (!dirty.current) setSessions(doc?.sessions || []);
    });
    return () => { unsubDraft(); };
  }, [isOpen, effectiveStageId]);

  // Debounced autosave. Never awaited on mount: an unacknowledged Firestore
  // write does not settle while offline.
  useEffect(() => {
    if (!dirty.current || !effectiveStageId || !user) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveDraftSessions(effectiveStageId, sessions, user.uid)
        .catch(err => console.error('[timetable] draft save failed', err));
    }, 800);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [sessions, effectiveStageId, user]);

  const edit = (next: TimetableSession[]) => { dirty.current = true; setSessions(next); };

  const clashIds = useMemo(() => {
    const set = new Set<string>();
    overlappingSessions(sessions).forEach(([a, b]) => { set.add(a); set.add(b); });
    return set;
  }, [sessions]);

  const warnings = useMemo(() => {
    const unlabelled = unlabelledPracticals(sessions).length;
    const badTimes = sessions.filter(
      s => !s.end || timeToMinutes(s.end) <= timeToMinutes(s.start),
    ).length;
    return unlabelled + badTimes + clashIds.size;
  }, [sessions, clashIds]);

  const unreviewed = sessions.filter(s => s.source === 'ai').length;

  const byDay = useMemo(() => groupSessionsByDay(sessions), [sessions]);
  const daysToRender = ALL_DAYS.filter(d => d <= 4 || byDay.some(g => g.day === d));

  const draftDiffers = useMemo(() => {
    if (!published) return false;
    return JSON.stringify(published.sessions || []) !== JSON.stringify(sessions);
  }, [published, sessions]);

  const staleImage = !!(draft?.sourcePhotoUrl && photoUrl && draft.sourcePhotoUrl !== photoUrl);

  const handleParse = async () => {
    if (!effectiveStageId) return;
    setIsParsing(true);
    setMessage(null);
    try {
      const result = await requestTimetableParse(effectiveStageId);
      dirty.current = false;
      const extra = [
        result.dropped
          ? (isRtl ? `، تعذّرت قراءة ${result.dropped}` : `, ${result.dropped} unreadable`)
          : '',
        result.droppedLabels?.length
          ? (isRtl
            ? `، تم تجاهل: ${result.droppedLabels.join('، ')}`
            : `, ignored: ${result.droppedLabels.join(', ')}`)
          : '',
      ].join('');
      setMessage({
        kind: 'ok',
        text: isRtl
          ? `تمت قراءة ${result.count} محاضرة${extra}. راجعها قبل النشر.`
          : `Read ${result.count} sessions${extra}. Review before publishing.`,
      });
    } catch (err: any) {
      const provider = err instanceof TimetableUnavailableError;
      const code = err?.message;
      setMessage({
        kind: 'err',
        text: provider
          ? (isRtl
            ? 'خدمة التحليل غير متاحة حالياً. حاول لاحقاً.'
            : 'Parsing is unavailable right now. Try again later.')
          : code === 'no_image'
            ? (isRtl ? 'ارفع صورة الجدول أولاً.' : 'Upload the timetable image first.')
            : code === 'already_parsing'
              ? (isRtl ? 'التحليل جارٍ بالفعل.' : 'A parse is already running.')
              : code === 'too_many_failures'
                ? (isRtl
                  ? 'فشل التحليل ثلاث مرات. عدّل الجدول يدوياً أو ارفع صورة أوضح.'
                  : 'Parsing failed three times. Edit by hand or upload a clearer image.')
                : (isRtl ? 'تعذّر تحليل الصورة.' : 'Could not parse the image.'),
      });
    } finally {
      setIsParsing(false);
    }
  };

  const handlePublish = async () => {
    if (!effectiveStageId || !user) return;
    setIsPublishing(true);
    setMessage(null);
    try {
      // Flush anything the debounce still owes before the batch reads it.
      if (saveTimer.current) clearTimeout(saveTimer.current);
      await saveDraftSessions(effectiveStageId, sessions, user.uid);
      await publishTimetable(
        effectiveStageId,
        { ...(draft || { stageId: effectiveStageId, sessions: [] }), sessions },
        user.uid,
        published?.version,
      );
      dirty.current = false;
      setMessage({ kind: 'ok', text: isRtl ? 'تم نشر الجدول للطلاب.' : 'Published to students.' });
    } catch (err) {
      console.error('[timetable] publish failed', err);
      setMessage({ kind: 'err', text: isRtl ? 'تعذّر النشر.' : 'Could not publish.' });
    } finally {
      setIsPublishing(false);
    }
  };

  const handleUnpublish = async () => {
    if (!effectiveStageId) return;
    try {
      await unpublishTimetable(effectiveStageId);
      setMessage({
        kind: 'ok',
        text: isRtl
          ? 'أُلغي النشر. سيعود الطلاب لصورة الجدول.'
          : 'Unpublished. Students see the image again.',
      });
    } catch (err) {
      console.error('[timetable] unpublish failed', err);
    }
  };

  const addSession = (day: DayIndex) => {
    edit([...sessions, {
      id: mintSessionId(day, '08:30'),
      day, start: '08:30', end: '10:30',
      title: '', kind: 'theory', groups: [], source: 'human',
    }]);
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[120] bg-slate-50 dark:bg-zinc-900 flex flex-col"
        dir={isRtl ? 'rtl' : 'ltr'}
      >
        {/* Fixed to the viewport, so it repeats the safe-area inset itself -
            App.tsx's padded root is not this element's offset parent. */}
        <div
          className="flex items-center justify-between gap-2 px-4 py-3 bg-white dark:bg-zinc-800 border-b border-slate-200 dark:border-zinc-700 shrink-0"
          style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}
        >
          <h2 className="text-base font-bold text-slate-900 dark:text-stone-100 truncate">
            {isRtl ? 'مراجعة الجدول الأسبوعي' : 'Review weekly timetable'}
          </h2>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-700 transition-colors shrink-0"
            aria-label={isRtl ? 'إغلاق' : 'Close'}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-zinc-800 border-b border-slate-200 dark:border-zinc-700 overflow-x-auto shrink-0">
          <button
            onClick={handleParse}
            disabled={isParsing || !photoUrl}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-500 text-white text-sm font-bold disabled:opacity-50 shrink-0"
          >
            {isParsing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {sessions.length
              ? (isRtl ? 'إعادة التحليل' : 'Re-parse')
              : (isRtl ? 'تحليل الصورة' : 'Parse image')}
          </button>

          {photoUrl && (
            <button
              onClick={() => setShowImage(v => !v)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-zinc-700 text-slate-700 dark:text-slate-200 text-sm font-bold shrink-0"
            >
              <ImageIcon className="w-4 h-4" />
              {showImage
                ? (isRtl ? 'إخفاء الصورة' : 'Hide image')
                : (isRtl ? 'الصورة الأصلية' : 'Original image')}
            </button>
          )}

          <div className="flex-1" />

          {warnings > 0 && (
            <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 text-xs font-bold shrink-0">
              <AlertTriangle className="w-3.5 h-3.5" />
              {warnings}
            </span>
          )}
          {unreviewed > 0 && (
            <span className="px-2 py-1 rounded-lg bg-slate-200 dark:bg-zinc-700 text-slate-600 dark:text-slate-300 text-xs font-bold shrink-0">
              {isRtl ? `${unreviewed} لم تُراجع` : `${unreviewed} unreviewed`}
            </span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {message && (
            <div className={`mb-3 px-3 py-2 rounded-xl text-sm font-medium ${
              message.kind === 'ok'
                ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                : 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300'
            }`}>
              {message.text}
            </div>
          )}

          {draft?.status === 'failed' && draft.failureReason && (
            <div className="mb-3 px-3 py-2 rounded-xl bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-xs">
              {isRtl ? 'آخر محاولة فشلت: ' : 'Last attempt failed: '}{draft.failureReason}
            </div>
          )}

          {staleImage && (
            <div className="mb-3 px-3 py-2 rounded-xl bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 text-xs font-bold">
              {isRtl
                ? 'رُفعت صورة جدول أحدث من التي حُلّلت. أعد التحليل.'
                : 'A newer timetable image was uploaded than the one parsed. Re-parse.'}
            </div>
          )}

          {!!draft?.droppedLabels?.length && (
            <div className="mb-3 px-3 py-2 rounded-xl bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-slate-300 text-xs">
              {isRtl
                ? 'تم تجاهل شعب غير موجودة في إعدادات المرحلة: '
                : 'Ignored group labels not in this stage config: '}
              <span dir="ltr">{draft.droppedLabels.join(', ')}</span>
            </div>
          )}

          {showImage && photoUrl && (
            <img
              src={photoUrl}
              alt="Original timetable"
              referrerPolicy="no-referrer"
              className="w-full h-auto rounded-2xl mb-4 border border-slate-200 dark:border-zinc-700"
            />
          )}

          {daysToRender.map(day => {
            const daySessions = byDay.find(g => g.day === day)?.sessions || [];
            return (
              <div key={day} className="mb-5">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-bold text-slate-700 dark:text-stone-200">
                    {isRtl ? DAY_LABELS[day].ar : DAY_LABELS[day].en}
                  </h3>
                  <button
                    onClick={() => addSession(day)}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-100 dark:bg-zinc-700 text-slate-600 dark:text-slate-300 text-xs font-bold"
                  >
                    <Plus className="w-3 h-3" />
                    {isRtl ? 'إضافة' : 'Add'}
                  </button>
                </div>

                {daySessions.length === 0 ? (
                  <p className="text-xs text-slate-400 dark:text-slate-500 px-1">
                    {isRtl ? 'لا توجد محاضرات' : 'No sessions'}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {daySessions.map(s => (
                      <TimetableSessionRow
                        key={s.id}
                        session={s}
                        config={groupConfig}
                        isRtl={isRtl}
                        clashes={clashIds.has(s.id)}
                        onChange={(next) => edit(sessions.map(x => (x.id === s.id ? next : x)))}
                        onDelete={() => edit(sessions.filter(x => x.id !== s.id))}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div
          className="flex items-center gap-2 px-4 py-3 bg-white dark:bg-zinc-800 border-t border-slate-200 dark:border-zinc-700 shrink-0"
          style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
        >
          {published && (
            <button
              onClick={handleUnpublish}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-100 dark:bg-zinc-700 text-slate-600 dark:text-slate-300 text-sm font-bold"
            >
              <EyeOff className="w-4 h-4" />
              {isRtl ? 'إلغاء النشر' : 'Unpublish'}
            </button>
          )}
          <button
            onClick={handlePublish}
            disabled={isPublishing || sessions.length === 0}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-500 text-white text-sm font-bold disabled:opacity-50"
          >
            {isPublishing
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : published && !draftDiffers
                ? <CheckCircle2 className="w-4 h-4" />
                : <Send className="w-4 h-4" />}
            {published && !draftDiffers
              ? (isRtl ? 'منشور ومطابق' : 'Published and current')
              : published
                ? (isRtl ? 'نشر التعديلات' : 'Publish changes')
                : (isRtl ? 'نشر للطلاب' : 'Publish to students')}
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
