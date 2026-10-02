/**
 * Pure scheduling engine for homework & exam deadlines.
 *
 * Supports:
 * 1. Saturday-anchored academic weeks (where the teaching week starts Saturday: +0 days).
 * 2. Auto-matching timetable sessions by subject and lecture kind.
 * 3. Exact per-group deadline resolution to the start time of the group's lecture.
 * 4. Safe fallback to the earliest scheduled lecture if a student has no group assigned.
 */

import type { DayIndex, TimetableSession } from '../../shared/timetable';
import { DAY_LABELS } from '../../shared/timetable';
import type { Homework, HomeworkGroupDeadline } from '../types';

/* ------------------------------------------------------------------ *
 * Date and Week Utilities (Saturday Anchored)
 * ------------------------------------------------------------------ */

/**
 * Returns the day offset from Saturday (0..6).
 *
 * Saturday (6)  -> 0
 * Sunday (0)    -> 1
 * Monday (1)    -> 2
 * Tuesday (2)   -> 3
 * Wednesday (3) -> 4
 * Thursday (4)  -> 5
 * Friday (5)    -> 6
 */
export function dayOffsetFromSaturday(day: DayIndex): number {
  return (day + 1) % 7;
}

/**
 * Normalizes a date to local midnight (00:00:00.000).
 */
export function toMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/**
 * Formats a Date as "YYYY-MM-DD" in local time.
 */
export function formatDateIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Safely parses "YYYY-MM-DD" into a local Date at midnight,
 * preventing UTC timezone offset shifting.
 */
export function parseDateIso(isoStr: string): Date {
  const parts = isoStr.split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    return toMidnight(new Date());
  }
  return new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
}

/**
 * Computes the Saturday that starts the week containing `date`.
 */
export function getSaturdayOfWeek(date: Date): Date {
  const clean = toMidnight(date);
  const daysSinceSaturday = (clean.getDay() + 1) % 7;
  clean.setDate(clean.getDate() - daysSinceSaturday);
  return clean;
}

export interface WeekOption {
  saturdayDate: string; // "YYYY-MM-DD"
  endDate: string;      // "YYYY-MM-DD" (Friday)
  labelAr: string;
  labelEn: string;
  dateRangeAr: string;
  dateRangeEn: string;
}

const ARABIC_MONTHS = [
  'كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران',
  'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'
];

const ENGLISH_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

export function formatFriendlyDate(date: Date, lang: 'ar' | 'en'): string {
  const day = date.getDate();
  const month = lang === 'ar' ? ARABIC_MONTHS[date.getMonth()] : ENGLISH_MONTHS[date.getMonth()];
  return `${day} ${month}`;
}

/**
 * Generates options for upcoming academic weeks starting on Saturday.
 */
export function getUpcomingWeeks(count: number = 4, referenceDate: Date = new Date()): WeekOption[] {
  const baseSaturday = getSaturdayOfWeek(referenceDate);
  const options: WeekOption[] = [];

  const labels = [
    { ar: 'الأسبوع الحالي', en: 'This Week' },
    { ar: 'الأسبوع القادم', en: 'Next Week' },
    { ar: 'بعد أسبوعين', en: 'In 2 Weeks' },
    { ar: 'بعد 3 أسابيع', en: 'In 3 Weeks' },
  ];

  for (let i = 0; i < count; i++) {
    const sat = new Date(baseSaturday);
    sat.setDate(sat.getDate() + i * 7);

    const fri = new Date(sat);
    fri.setDate(fri.getDate() + 6);

    const label = labels[i] || {
      ar: `أسبوع (${formatFriendlyDate(sat, 'ar')})`,
      en: `Week of (${formatFriendlyDate(sat, 'en')})`,
    };

    options.push({
      saturdayDate: formatDateIso(sat),
      endDate: formatDateIso(fri),
      labelAr: label.ar,
      labelEn: label.en,
      dateRangeAr: `${formatFriendlyDate(sat, 'ar')} - ${formatFriendlyDate(fri, 'ar')}`,
      dateRangeEn: `${formatFriendlyDate(sat, 'en')} - ${formatFriendlyDate(fri, 'en')}`,
    });
  }

  return options;
}

/* ------------------------------------------------------------------ *
 * Timetable Session Matching
 * ------------------------------------------------------------------ */

/**
 * Normalizes text for lenient fuzzy matching (removes accents, tatweel, diacritics).
 */
/**
 * Normalizes text and extracts words, stripping Arabic definite article "ال".
 */
export function tokenizeAndNormalize(text: string): string[] {
  if (!text) return [];
  const cleaned = text
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // Arabic diacritics & tatweel
    .replace(/[أإآء]/g, 'ا')
    .replace(/[ى]/g, 'ي')
    .replace(/[ة]/g, 'ه')
    .replace(/[^a-z0-9\u0600-\u06FF\s_]/g, ' ');

  return cleaned
    .split(/[\s_]+/)
    .map(w => w.trim())
    .filter(w => w.length > 1)
    .map(w => {
      if (w.startsWith('ال') && w.length >= 4) {
        return w.slice(2);
      }
      return w;
    });
}

/**
 * Normalizes text to a clean space-separated string of words.
 */
export function normalizeText(text: string): string {
  return tokenizeAndNormalize(text).join(' ');
}

/**
 * Finds timetable sessions that match the subject and lecture type.
 */
export function matchTimetableSessions(
  sessions: TimetableSession[],
  subjectSlugOrId: string,
  subjectNameAr?: string,
  subjectNameEn?: string,
  type?: 'theoretical' | 'practical' | 'both'
): TimetableSession[] {
  if (!Array.isArray(sessions) || sessions.length === 0) return [];

  const queryTokens = new Set([
    ...tokenizeAndNormalize(subjectSlugOrId),
    ...tokenizeAndNormalize(subjectNameAr || ''),
    ...tokenizeAndNormalize(subjectNameEn || ''),
  ]);

  const targetKind = type === 'theoretical' ? 'theory' : type === 'practical' ? 'practical' : null;

  const scoreSession = (session: TimetableSession, checkKind: boolean): number => {
    if (checkKind && targetKind && session.kind !== targetKind) {
      return 0;
    }

    const sessionTokens = new Set([
      ...tokenizeAndNormalize(session.title),
      ...(session.titles || []).flatMap(tokenizeAndNormalize),
    ]);

    let matchCount = 0;
    for (const q of queryTokens) {
      if (sessionTokens.has(q)) {
        matchCount++;
      } else {
        for (const st of sessionTokens) {
          if (st.includes(q) || q.includes(st)) {
            matchCount += 0.5;
            break;
          }
        }
      }
    }
    return matchCount;
  };

  // First pass: match with kind filter
  const scored = sessions
    .map(s => ({ session: s, score: scoreSession(s, true) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length > 0) {
    return scored.map(item => item.session);
  }

  // Second pass: if no sessions matched with strict kind, match without kind filter
  if (targetKind) {
    const scoredNoKind = sessions
      .map(s => ({ session: s, score: scoreSession(s, false) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);

    return scoredNoKind.map(item => item.session);
  }

  return [];
}

/* ------------------------------------------------------------------ *
 * Group Deadline Calculations
 * ------------------------------------------------------------------ */

export interface GroupDeadlineComputation {
  groupDeadlines: Record<string, HomeworkGroupDeadline>;
  earliestDate: Date | null;
  latestDate: Date | null;
  totalGroups: number;
  distinctDaysCount: number;
  dateRangeStrAr: string;
  dateRangeStrEn: string;
}

/**
 * Calculates exact date & time deadlines for each group from matching sessions
 * anchored to the Saturday of the selected week.
 */
export function computeGroupDeadlines(
  sessions: TimetableSession[],
  saturdayDateStr: string
): GroupDeadlineComputation {
  const sat = parseDateIso(saturdayDateStr);
  const groupDeadlines: Record<string, HomeworkGroupDeadline> = {};

  let earliest: Date | null = null;
  let latest: Date | null = null;
  const distinctDays = new Set<number>();

  for (const session of sessions) {
    const offset = dayOffsetFromSaturday(session.day);
    distinctDays.add(session.day);

    const [hours, minutes] = (session.start || '08:30').split(':').map(Number);
    const sessionDate = new Date(
      sat.getFullYear(),
      sat.getMonth(),
      sat.getDate() + offset,
      isNaN(hours) ? 8 : hours,
      isNaN(minutes) ? 30 : minutes,
      0,
      0
    );

    if (!earliest || sessionDate < earliest) earliest = sessionDate;
    if (!latest || sessionDate > latest) latest = sessionDate;

    const dayInfo = DAY_LABELS[session.day] || { ar: 'غير محدد', en: 'Unknown' };

    // If session has specific groups e.g. ["A1", "A2"]
    if (Array.isArray(session.groups) && session.groups.length > 0) {
      for (const grp of session.groups) {
        const item: HomeworkGroupDeadline = {
          group: grp,
          dueDate: sessionDate,
          dayNameAr: dayInfo.ar,
          dayNameEn: dayInfo.en,
          time: session.start,
        };
        if (session.title) item.sessionTitle = session.title;
        if (session.location) item.location = session.location;
        groupDeadlines[grp] = item;
      }
    } else {
      // Universal session for all groups
      const item: HomeworkGroupDeadline = {
        group: '*',
        dueDate: sessionDate,
        dayNameAr: dayInfo.ar,
        dayNameEn: dayInfo.en,
        time: session.start,
      };
      if (session.title) item.sessionTitle = session.title;
      if (session.location) item.location = session.location;
      groupDeadlines['*'] = item;
    }
  }

  const dateRangeStrAr = earliest && latest
    ? `${DAY_LABELS[earliest.getDay() as DayIndex]?.ar || ''} ${formatFriendlyDate(earliest, 'ar')} - ${DAY_LABELS[latest.getDay() as DayIndex]?.ar || ''} ${formatFriendlyDate(latest, 'ar')}`
    : '';

  const dateRangeStrEn = earliest && latest
    ? `${DAY_LABELS[earliest.getDay() as DayIndex]?.en || ''} ${formatFriendlyDate(earliest, 'en')} - ${DAY_LABELS[latest.getDay() as DayIndex]?.en || ''} ${formatFriendlyDate(latest, 'en')}`
    : '';

  return {
    groupDeadlines,
    earliestDate: earliest,
    latestDate: latest,
    totalGroups: Object.keys(groupDeadlines).filter(k => k !== '*').length,
    distinctDaysCount: distinctDays.size,
    dateRangeStrAr,
    dateRangeStrEn,
  };
}

/* ------------------------------------------------------------------ *
 * Student Deadline Resolution
 * ------------------------------------------------------------------ */

export interface StudentDeadlineResolution {
  effectiveDate: Date | null;
  isGroupSpecific: boolean;
  groupLabel?: string;
  time?: string;
  dayNameAr?: string;
  dayNameEn?: string;
  fallbackReason?: 'no_group' | 'group_not_scheduled' | 'fixed';
}

function coerceToDate(val: any): Date | null {
  if (!val) return null;
  if (val instanceof Date) return val;
  if (typeof val.toDate === 'function') return val.toDate();
  if (typeof val.toMillis === 'function') return new Date(val.toMillis());
  const parsed = new Date(val);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Resolves the personal deadline a student sees for a given homework.
 */
export function resolveStudentDeadline(
  homework: Homework,
  studentGroup?: string | null
): StudentDeadlineResolution {
  const normGroup = (studentGroup || '').trim();

  // Mode 1: Timetable per-group
  if (homework.deadlineMode === 'timetable' && homework.groupDeadlines) {
    // 1. Direct group match
    if (normGroup && homework.groupDeadlines[normGroup]) {
      const g = homework.groupDeadlines[normGroup];
      return {
        effectiveDate: coerceToDate(g.dueDate),
        isGroupSpecific: true,
        groupLabel: normGroup,
        time: g.time,
        dayNameAr: g.dayNameAr,
        dayNameEn: g.dayNameEn,
      };
    }

    // 2. Universal session ("*")
    if (homework.groupDeadlines['*']) {
      const g = homework.groupDeadlines['*'];
      return {
        effectiveDate: coerceToDate(g.dueDate),
        isGroupSpecific: false,
        time: g.time,
        dayNameAr: g.dayNameAr,
        dayNameEn: g.dayNameEn,
      };
    }

    // 3. Fallback to earliest deadline
    const fallbackDate = coerceToDate(homework.earliestDeadline) || coerceToDate(homework.dueDate);
    return {
      effectiveDate: fallbackDate,
      isGroupSpecific: false,
      fallbackReason: normGroup ? 'group_not_scheduled' : 'no_group',
    };
  }

  // Mode 2: Fixed general deadline
  const fixedDate = coerceToDate(homework.dueDate);
  return {
    effectiveDate: fixedDate,
    isGroupSpecific: false,
    fallbackReason: 'fixed',
  };
}

function isPlainObject(val: any): boolean {
  if (val === null || typeof val !== 'object') return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively strips undefined fields from an object so Firestore setDoc/addDoc never rejects it.
 * Preserves Date, FieldValue (e.g. serverTimestamp, deleteField), Timestamp, and primitives.
 */
export function sanitizeForFirestore<T>(data: T): T {
  if (data === null || data === undefined) return data;
  if (Array.isArray(data)) {
    return data
      .map(sanitizeForFirestore)
      .filter(v => v !== undefined) as any;
  }
  if (isPlainObject(data)) {
    const clean: any = {};
    for (const [k, v] of Object.entries(data as any)) {
      if (v !== undefined) {
        clean[k] = sanitizeForFirestore(v);
      }
    }
    return clean;
  }
  return data;
}


