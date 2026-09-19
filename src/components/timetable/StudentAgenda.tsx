/**
 * The student's own week, replacing the master timetable image in the
 * "جدول المحاضرات" card on واجبات الأسبوع.
 *
 * Shows universal sessions plus only this student's subgroup's practicals - see
 * sessionsForStudent, which fails OPEN: a session whose audience could not be
 * read is shown to everyone rather than to nobody.
 *
 * The original image is always one tap away. That button is not a courtesy: the
 * sessions below were transcribed from that image by a model, and a student who
 * thinks something is wrong needs to be able to check rather than be told.
 */
import React, { useMemo } from 'react';
import { Clock, MapPin, User, Image as ImageIcon, CalendarDays } from 'lucide-react';
import {
  DAY_LABELS,
  groupSessionsByDay,
  sessionsForStudent,
  type TimetableSession,
} from '../../../shared/timetable';

interface StudentAgendaProps {
  sessions: TimetableSession[];
  /** The viewer's subgroup ("C2"), from users.group. Absent shows everything. */
  subgroup?: string | null;
  isRtl: boolean;
  weekLabel?: string;
  /** Opens the original image in the card's existing lightbox. Absent when no
   *  image was ever uploaded, which is possible: a draft can be hand-built. */
  onViewOriginal?: () => void;
}

const KIND_STYLES: Record<string, { chip: string; bar: string; ar: string; en: string }> = {
  theory: {
    chip: 'bg-sky-50 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
    bar: 'bg-sky-400 dark:bg-sky-500',
    ar: 'نظري', en: 'Theory',
  },
  practical: {
    chip: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    bar: 'bg-emerald-400 dark:bg-emerald-500',
    ar: 'عملي', en: 'Practical',
  },
  other: {
    chip: 'bg-slate-100 text-slate-600 dark:bg-zinc-700 dark:text-slate-300',
    bar: 'bg-slate-300 dark:bg-zinc-600',
    ar: 'أخرى', en: 'Other',
  },
};

export default function StudentAgenda({
  sessions, subgroup, isRtl, weekLabel, onViewOriginal,
}: StudentAgendaProps) {
  const today = new Date().getDay();

  const days = useMemo(
    () => groupSessionsByDay(sessionsForStudent(sessions, subgroup)),
    [sessions, subgroup],
  );

  return (
    <div className="w-full">
      <div className="flex items-center justify-between gap-2 mb-3 px-1">
        <div className="flex items-center gap-2 min-w-0">
          {subgroup ? (
            <span className="px-2 py-0.5 rounded-lg bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300 text-xs font-bold shrink-0">
              {isRtl ? `شعبتك ${subgroup}` : `Group ${subgroup}`}
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded-lg bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 text-xs font-bold shrink-0">
              {isRtl ? 'كل الشعب' : 'All groups'}
            </span>
          )}
          {weekLabel && (
            <span className="text-xs text-slate-500 dark:text-slate-400 truncate">{weekLabel}</span>
          )}
        </div>
        {onViewOriginal && (
          <button
            onClick={onViewOriginal}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-zinc-700 hover:bg-slate-200 dark:hover:bg-zinc-600 transition-colors shrink-0"
          >
            <ImageIcon className="w-3.5 h-3.5" />
            {isRtl ? 'الجدول الأصلي' : 'Original'}
          </button>
        )}
      </div>

      {days.length === 0 ? (
        <div className="text-center p-8 text-slate-400 dark:text-slate-500">
          <CalendarDays className="w-10 h-10 mx-auto mb-2 opacity-50" />
          <p className="text-sm">
            {isRtl ? 'لا توجد محاضرات لشعبتك هذا الأسبوع' : 'No lectures for your group this week'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {days.map(({ day, sessions: daySessions }) => (
            <div key={day}>
              <div className="flex items-center gap-2 mb-2 px-1">
                <h3 className="text-sm font-bold text-slate-700 dark:text-stone-200">
                  {isRtl ? DAY_LABELS[day].ar : DAY_LABELS[day].en}
                </h3>
                {day === today && (
                  <span className="px-1.5 py-0.5 rounded-md bg-sky-500 text-white text-[10px] font-bold">
                    {isRtl ? 'اليوم' : 'Today'}
                  </span>
                )}
              </div>

              <div className="space-y-2">
                {daySessions.map((s) => {
                  const style = KIND_STYLES[s.kind] || KIND_STYLES.other;
                  return (
                    <div
                      key={s.id}
                      className="flex items-stretch gap-3 bg-slate-50 dark:bg-zinc-900 rounded-2xl p-3 border border-slate-100 dark:border-zinc-800"
                    >
                      <div className={`w-1 rounded-full shrink-0 ${style.bar}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            {/* A combined cell keeps its printed form; `titles`
                                only splits it for display. Nothing here turns a
                                half into a subject. */}
                            <p className="font-bold text-sm text-slate-900 dark:text-stone-100 leading-snug break-words">
                              {s.titles && s.titles.length > 1 ? s.titles.join(' + ') : s.title}
                            </p>
                            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                              {/* dir=ltr: an RTL container reverses "08:30 - 10:30". */}
                              <span
                                dir="ltr"
                                className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 font-medium"
                              >
                                <Clock className="w-3 h-3" />
                                {s.start} – {s.end}
                              </span>
                              {s.location && (
                                <span className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 truncate">
                                  <MapPin className="w-3 h-3 shrink-0" />
                                  {s.location}
                                </span>
                              )}
                              {s.teacher && (
                                <span className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 truncate">
                                  <User className="w-3 h-3 shrink-0" />
                                  {s.teacher}
                                </span>
                              )}
                            </div>
                          </div>
                          <span className={`px-2 py-0.5 rounded-lg text-[11px] font-bold shrink-0 ${style.chip}`}>
                            {isRtl ? style.ar : style.en}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
