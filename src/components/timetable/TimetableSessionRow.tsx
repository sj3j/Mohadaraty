/**
 * One editable session in the review list.
 *
 * A form row, not a draggable card. A representative correcting a misparse is
 * usually doing it on a phone, in RTL, with the original image open beside it -
 * a time picker and a text field beat a drag target at every one of those.
 */
import React from 'react';
import { Trash2, AlertTriangle } from 'lucide-react';
import SubgroupChips from './SubgroupChips';
import type { GroupConfigLike } from '../../../shared/groups';
import type { SessionKind, TimetableSession } from '../../../shared/timetable';

interface TimetableSessionRowProps {
  session: TimetableSession;
  onChange: (next: TimetableSession) => void;
  onDelete: () => void;
  config: GroupConfigLike;
  isRtl: boolean;
  /** Overlaps for a shared audience, computed across the whole week. */
  clashes: boolean;
  /** Declared because @types/react is not installed, so JSX gives `key`
   *  no special handling and it resolves as an ordinary prop. Same
   *  workaround as LectureCardProps. */
  key?: string;
}

const KINDS: { id: SessionKind; ar: string; en: string }[] = [
  { id: 'theory', ar: 'نظري', en: 'Theory' },
  { id: 'practical', ar: 'عملي', en: 'Practical' },
  { id: 'other', ar: 'أخرى', en: 'Other' },
];

export default function TimetableSessionRow({
  session, onChange, onDelete, config, isRtl, clashes,
}: TimetableSessionRowProps) {
  // Any edit makes the row a human's, so the badge stops calling it unreviewed
  // and a future re-parse knows not to overwrite it.
  const patch = (fields: Partial<TimetableSession>) =>
    onChange({ ...session, ...fields, source: 'human' });

  const unlabelledPractical = session.kind === 'practical' && session.groups.length === 0;
  const badTimes = !session.end || session.end <= session.start;

  return (
    <div className="bg-slate-50 dark:bg-zinc-900 rounded-2xl p-3 border border-slate-200 dark:border-zinc-800">
      <div className="flex items-center gap-2 mb-2">
        {/* dir=ltr on the time inputs: the native picker lays out HH:MM, and an
            inherited RTL direction reverses the pair on some Android builds. */}
        <input
          type="time"
          dir="ltr"
          value={session.start}
          onChange={(e) => patch({ start: e.target.value })}
          className="px-2 py-1.5 rounded-lg bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-sm text-slate-900 dark:text-stone-100 w-[104px]"
        />
        <span className="text-slate-400 text-sm">–</span>
        <input
          type="time"
          dir="ltr"
          value={session.end}
          onChange={(e) => patch({ end: e.target.value })}
          className={`px-2 py-1.5 rounded-lg bg-white dark:bg-zinc-800 border text-sm text-slate-900 dark:text-stone-100 w-[104px] ${
            badTimes ? 'border-amber-400 dark:border-amber-500' : 'border-slate-200 dark:border-zinc-700'
          }`}
        />
        <div className="flex-1" />
        {session.source === 'ai' && (
          <span className="px-1.5 py-0.5 rounded-md bg-slate-200 dark:bg-zinc-700 text-slate-500 dark:text-slate-400 text-[10px] font-bold">
            {isRtl ? 'لم تُراجع' : 'Unreviewed'}
          </span>
        )}
        <button
          type="button"
          onClick={onDelete}
          className="p-1.5 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
          aria-label={isRtl ? 'حذف' : 'Delete'}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      <input
        type="text"
        value={session.title}
        onChange={(e) => patch({ title: e.target.value })}
        placeholder={isRtl ? 'اسم المادة' : 'Subject'}
        className="w-full px-2 py-1.5 mb-2 rounded-lg bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-sm font-bold text-slate-900 dark:text-stone-100"
      />

      <div className="flex items-center gap-1 mb-2">
        {KINDS.map(k => (
          <button
            key={k.id}
            type="button"
            onClick={() => patch({ kind: k.id })}
            className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-colors ${
              session.kind === k.id
                ? 'bg-sky-500 text-white'
                : 'bg-slate-100 dark:bg-zinc-700 text-slate-600 dark:text-slate-300'
            }`}
          >
            {isRtl ? k.ar : k.en}
          </button>
        ))}
      </div>

      <SubgroupChips
        value={session.groups}
        onChange={(groups) => patch({ groups })}
        config={config}
        isRtl={isRtl}
      />

      <div className="flex items-center gap-2 mt-2 flex-wrap">
        <input
          type="text"
          value={session.location || ''}
          onChange={(e) => patch({ location: e.target.value })}
          placeholder={isRtl ? 'القاعة' : 'Room'}
          className="flex-1 min-w-[100px] px-2 py-1 rounded-lg bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-xs text-slate-700 dark:text-stone-200"
        />
        <input
          type="text"
          value={session.teacher || ''}
          onChange={(e) => patch({ teacher: e.target.value })}
          placeholder={isRtl ? 'التدريسي' : 'Teacher'}
          className="flex-1 min-w-[100px] px-2 py-1 rounded-lg bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-xs text-slate-700 dark:text-stone-200"
        />
      </div>

      {(unlabelledPractical || badTimes || clashes || (session.titles && session.titles.length > 1)) && (
        <div className="flex flex-col gap-1 mt-2">
          {unlabelledPractical && (
            <p className="flex items-center gap-1.5 text-[11px] font-bold text-amber-600 dark:text-amber-400">
              <AlertTriangle className="w-3 h-3 shrink-0" />
              {isRtl
                ? 'عملي بلا شعبة — سيظهر لكل الطلاب حتى تحدد شعبته'
                : 'Practical with no group — shown to every student until you set one'}
            </p>
          )}
          {badTimes && (
            <p className="flex items-center gap-1.5 text-[11px] font-bold text-amber-600 dark:text-amber-400">
              <AlertTriangle className="w-3 h-3 shrink-0" />
              {isRtl ? 'وقت النهاية ليس بعد البداية' : 'End time is not after the start'}
            </p>
          )}
          {clashes && (
            <p className="flex items-center gap-1.5 text-[11px] font-bold text-amber-600 dark:text-amber-400">
              <AlertTriangle className="w-3 h-3 shrink-0" />
              {isRtl ? 'يتعارض مع محاضرة أخرى لنفس الشعبة' : 'Overlaps another session for the same group'}
            </p>
          )}
          {/* Neutral, never an error: two subjects sharing one slot is exactly
              how the college prints a shared period. */}
          {session.titles && session.titles.length > 1 && (
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              {isRtl ? 'مادتان في نفس الوقت' : 'Two subjects in one slot'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
