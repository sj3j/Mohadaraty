import React, { useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Play, Clock, MapPin, Users, Layers, Filter } from 'lucide-react';
import type { LectureColumn } from './types';
import { STAGE_NAME_MAP } from './useDoctorCrossStageTimetable';

interface Props {
  lectures: LectureColumn[];
  serverDate: string;
  selectedLectureId: string;
  isRtl: boolean;
  onSelect: (id: string) => void;
  onStart: (id: string) => void;
  offline?: boolean;
}

const addDays = (date: string, days: number) => {
  const result = new Date(`${date}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
};

const sunday = (date: string) => addDays(date, -new Date(`${date}T12:00:00Z`).getUTCDay());

export default function DoctorTimetableView({
  lectures,
  serverDate,
  selectedLectureId,
  isRtl,
  onSelect,
  onStart,
  offline,
}: Props) {
  const [view, setView] = useState<'today' | 'week'>('today');
  const [anchor, setAnchor] = useState(serverDate || new Date().toISOString().slice(0, 10));

  // Filters: Mode & Stage
  const [modeFilter, setModeFilter] = useState<'all' | 'theoretical' | 'practical'>('all');
  const [stageFilter, setStageFilter] = useState<string>('all');

  // Extract unique stages present in this doctor's lectures
  const stagesPresent = useMemo(() => {
    const stageIds = Array.from(new Set(lectures.map(l => l.stageId).filter(Boolean))) as string[];
    return stageIds.sort().map(id => ({
      id,
      name: STAGE_NAME_MAP[id]?.ar || id,
    }));
  }, [lectures]);

  // Apply filters
  const filteredLectures = useMemo(() => {
    return lectures.filter(item => {
      if (modeFilter !== 'all' && item.mode !== modeFilter) return false;
      if (stageFilter !== 'all' && item.stageId !== stageFilter) return false;
      return true;
    });
  }, [lectures, modeFilter, stageFilter]);

  // Dates for the current view
  const dates = useMemo(() => {
    return view === 'today'
      ? [anchor]
      : Array.from({ length: 7 }, (_, i) => addDays(sunday(anchor), i));
  }, [anchor, view]);

  const labels = new Intl.DateTimeFormat(isRtl ? 'ar-IQ' : 'en-GB', {
    timeZone: 'Asia/Baghdad',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  const fullDateLabels = new Intl.DateTimeFormat(isRtl ? 'ar-IQ' : 'en-GB', {
    timeZone: 'Asia/Baghdad',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Calculate lecture counts
  const theoCount = lectures.filter(l => l.mode === 'theoretical').length;
  const pracCount = lectures.filter(l => l.mode === 'practical').length;

  return (
    <section className="space-y-4" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Top Header Card */}
      <div className="rounded-3xl border border-slate-200/80 bg-white p-4 sm:p-5 shadow-xs dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          {/* Title & Info */}
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-teal-50 text-teal-600 dark:bg-teal-950/50 dark:text-teal-400 border border-teal-200/60 dark:border-teal-800/60">
              <CalendarDays className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-black text-slate-900 dark:text-zinc-100">
                  {isRtl ? 'الجدول التدريسي الشامل' : 'Lecturer Timetable'}
                </h2>
                {offline && (
                  <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[10px] font-bold text-amber-900 dark:bg-amber-950/60 dark:text-amber-300">
                    {isRtl ? 'نسخة محفوظة' : 'Cached offline'}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5 flex items-center gap-2 flex-wrap">
                <span>
                  {isRtl
                    ? `إجمالي ${lectures.length} محاضرة (${theoCount} نظري · ${pracCount} عملي)`
                    : `Total ${lectures.length} lectures (${theoCount} Theo · ${pracCount} Lab)`}
                </span>
                {stagesPresent.length > 1 && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-black bg-purple-50 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300">
                    <Layers className="h-3 w-3" />
                    {isRtl ? `${stagesPresent.length} مراحل دراسية` : `${stagesPresent.length} stages`}
                  </span>
                )}
              </p>
            </div>
          </div>

          {/* Navigation & View Toggle */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Today / Week View Switcher */}
            <div className="flex items-center p-1 rounded-2xl bg-slate-100 dark:bg-zinc-800 border border-slate-200/60 dark:border-zinc-700/60">
              <button
                onClick={() => setView('today')}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-black transition-all cursor-pointer ${
                  view === 'today'
                    ? 'bg-teal-600 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-100'
                }`}
              >
                {isRtl ? 'اليوم' : 'Today'}
              </button>
              <button
                onClick={() => setView('week')}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-black transition-all cursor-pointer ${
                  view === 'week'
                    ? 'bg-teal-600 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-100'
                }`}
              >
                {isRtl ? 'الأسبوع' : 'Week'}
              </button>
            </div>

            {/* Date Anchors */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => setAnchor(addDays(anchor, view === 'today' ? -1 : -7))}
                className="rounded-xl border border-slate-200 p-2 hover:bg-slate-50 dark:border-zinc-700 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                title={isRtl ? 'السابق' : 'Previous'}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                onClick={() => setAnchor(serverDate || new Date().toISOString().slice(0, 10))}
                className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-black hover:bg-slate-50 dark:border-zinc-700 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                {isRtl ? 'اليوم الحالي' : 'Now'}
              </button>
              <button
                onClick={() => setAnchor(addDays(anchor, view === 'today' ? 1 : 7))}
                className="rounded-xl border border-slate-200 p-2 hover:bg-slate-50 dark:border-zinc-700 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                title={isRtl ? 'التالي' : 'Next'}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Filter Controls Bar */}
        <div className="mt-4 pt-3.5 border-t border-slate-100 dark:border-zinc-800/80 flex flex-wrap items-center justify-between gap-3">
          {/* Mode Filters */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] font-bold text-slate-400 dark:text-zinc-500 me-1">
              {isRtl ? 'النمط:' : 'Mode:'}
            </span>
            <button
              onClick={() => setModeFilter('all')}
              className={`px-3 py-1 rounded-xl text-xs font-black transition-all cursor-pointer ${
                modeFilter === 'all'
                  ? 'bg-slate-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-zinc-800 dark:text-zinc-400'
              }`}
            >
              {isRtl ? 'الكل (نظري + عملي)' : 'All (Theory + Lab)'}
            </button>
            <button
              onClick={() => setModeFilter('theoretical')}
              className={`px-3 py-1 rounded-xl text-xs font-black transition-all cursor-pointer ${
                modeFilter === 'theoretical'
                  ? 'bg-sky-600 text-white'
                  : 'bg-sky-50 text-sky-700 hover:bg-sky-100 dark:bg-sky-950/40 dark:text-sky-300'
              }`}
            >
              {isRtl ? 'نظري فقط' : 'Theory only'}
            </button>
            <button
              onClick={() => setModeFilter('practical')}
              className={`px-3 py-1 rounded-xl text-xs font-black transition-all cursor-pointer ${
                modeFilter === 'practical'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300'
              }`}
            >
              {isRtl ? 'عملي فقط' : 'Lab only'}
            </button>
          </div>

          {/* Stage Filters (if doctor has multiple stages) */}
          {stagesPresent.length > 1 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] font-bold text-slate-400 dark:text-zinc-500 me-1">
                {isRtl ? 'المرحلة:' : 'Stage:'}
              </span>
              <button
                onClick={() => setStageFilter('all')}
                className={`px-2.5 py-1 rounded-xl text-xs font-black transition-all cursor-pointer ${
                  stageFilter === 'all'
                    ? 'bg-purple-600 text-white'
                    : 'bg-purple-50 text-purple-700 hover:bg-purple-100 dark:bg-purple-950/40 dark:text-purple-300'
                }`}
              >
                {isRtl ? 'جميع المراحل' : 'All Stages'}
              </button>
              {stagesPresent.map(stage => (
                <button
                  key={stage.id}
                  onClick={() => setStageFilter(stage.id)}
                  className={`px-2.5 py-1 rounded-xl text-xs font-black transition-all cursor-pointer ${
                    stageFilter === stage.id
                      ? 'bg-purple-600 text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-zinc-800 dark:text-zinc-300'
                  }`}
                >
                  {stage.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Timetable Grid View */}
      <div className={view === 'week' ? 'grid gap-3.5 lg:grid-cols-7' : 'grid gap-3.5'}>
        {dates.map(date => {
          const dayLectures = filteredLectures
            .filter(item => item.date === date)
            .sort((a, b) => (a.time || '').localeCompare(b.time || ''));

          return (
            <div
              key={date}
              className={`rounded-3xl border bg-white p-3.5 sm:p-4 shadow-xs dark:bg-zinc-900 transition-all ${
                date === serverDate
                  ? 'border-teal-500/80 ring-2 ring-teal-500/20 dark:border-teal-500/60'
                  : 'border-slate-200/80 dark:border-zinc-800'
              }`}
            >
              {/* Day Header */}
              <div className="mb-3.5 pb-2.5 border-b border-slate-100 dark:border-zinc-800/80 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-black text-slate-900 dark:text-zinc-100">
                    {view === 'today'
                      ? fullDateLabels.format(new Date(`${date}T12:00:00Z`))
                      : labels.format(new Date(`${date}T12:00:00Z`))}
                  </h3>
                  {date === serverDate && (
                    <span className="text-[10px] font-black text-teal-600 dark:text-teal-400">
                      {isRtl ? '• اليوم الحالي' : '• Today'}
                    </span>
                  )}
                </div>
                {dayLectures.length > 0 && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-slate-100 text-slate-700 dark:bg-zinc-800 dark:text-zinc-300">
                    {dayLectures.length}
                  </span>
                )}
              </div>

              {/* Lecture Cards List */}
              <div className="space-y-2.5">
                {dayLectures.map(item => {
                  const isSelected = item.id === selectedLectureId;
                  const isPractical = item.mode === 'practical';

                  return (
                    <div
                      key={item.id}
                      onClick={() => onSelect(item.id)}
                      className={`group relative rounded-2xl border p-3.5 text-start transition-all cursor-pointer ${
                        isSelected
                          ? 'border-teal-500 bg-teal-50/70 shadow-sm dark:bg-teal-950/30 dark:border-teal-500'
                          : 'border-slate-200 bg-white hover:border-slate-300 hover:shadow-xs dark:border-zinc-800 dark:bg-zinc-900/90 dark:hover:border-zinc-700'
                      }`}
                    >
                      {/* Top Badges: Stage and Mode */}
                      <div className="flex items-center justify-between gap-1.5 mb-2">
                        {/* Stage Badge */}
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-black bg-purple-50 text-purple-700 border border-purple-200/60 dark:bg-purple-950/50 dark:text-purple-300 dark:border-purple-800/60">
                          {item.stageName || (item.stageId ? STAGE_NAME_MAP[item.stageId]?.ar : '') || (isRtl ? 'مرحلة' : 'Stage')}
                        </span>

                        {/* Mode Badge (Theory or Practical) */}
                        <span
                          className={`px-2 py-0.5 rounded-md text-[10px] font-black border ${
                            isPractical
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200/80 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800/80'
                              : 'bg-sky-50 text-sky-700 border-sky-200/80 dark:bg-sky-950/50 dark:text-sky-300 dark:border-sky-800/80'
                          }`}
                        >
                          {isPractical ? (isRtl ? 'عملي' : 'Lab') : (isRtl ? 'نظري' : 'Theory')}
                        </span>
                      </div>

                      {/* Title */}
                      <h4 className="font-black text-xs sm:text-sm text-slate-900 dark:text-zinc-100 leading-snug line-clamp-2 mb-2">
                        {item.title}
                      </h4>

                      {/* Metadata rows */}
                      <div className="space-y-1 text-[11px] text-slate-500 dark:text-zinc-400">
                        {/* Time */}
                        <div className="flex items-center gap-1.5" dir="ltr">
                          <Clock className="h-3 w-3 text-slate-400 shrink-0" />
                          <span className="font-bold text-slate-700 dark:text-zinc-300">
                            {item.time || ''}{item.endTime ? ` – ${item.endTime}` : ''}
                          </span>
                        </div>

                        {/* Location */}
                        <div className="flex items-center gap-1.5">
                          <MapPin className="h-3 w-3 text-slate-400 shrink-0" />
                          <span className="truncate">
                            {item.location || (isRtl ? 'القاعة غير محددة' : 'Room not set')}
                          </span>
                        </div>

                        {/* Audience Groups */}
                        <div className="flex items-center gap-1.5">
                          <Users className="h-3 w-3 text-slate-400 shrink-0" />
                          <span className="truncate">
                            {item.audienceGroups?.length
                              ? item.audienceGroups.join(', ')
                              : (isRtl ? 'جميع الشعب' : 'All Groups')}
                          </span>
                        </div>
                      </div>

                      {/* Card Footer: Status & Start Button */}
                      <div className="mt-3 pt-2.5 border-t border-slate-100 dark:border-zinc-800 flex items-center justify-between">
                        <span className="text-[10px] font-bold text-slate-400 dark:text-zinc-500">
                          {isRtl ? 'مجدولة' : 'Scheduled'}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onStart(item.id);
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-[11px] font-black transition-colors shadow-xs cursor-pointer"
                          title={isRtl ? 'بدء جلسة الحضور' : 'Start attendance'}
                        >
                          <Play className="h-3 w-3 fill-current" />
                          <span>{isRtl ? 'الحضور' : 'Attendance'}</span>
                        </button>
                      </div>
                    </div>
                  );
                })}

                {/* Empty State for the day */}
                {dayLectures.length === 0 && (
                  <div className="py-8 text-center text-xs text-slate-400 dark:text-zinc-500">
                    <p>{isRtl ? 'لا توجد محاضرات مجدولة' : 'No lectures scheduled'}</p>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
