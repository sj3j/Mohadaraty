/**
 * The academic calendar, and the phase it puts the app in on any given day.
 *
 * Replaces the hand-flipped `app_settings/streak.vacationMode` boolean: whether
 * the competition is running is now a pure function of the date, so nobody has
 * to remember to flip anything and no scheduler has to fire for the app to
 * pause or resume correctly.
 *
 * Lives in shared/ for the same reason seasonReset.ts does - server.ts and
 * api/index.ts are divergent copies of the same Express app, and vercel.json
 * routes production /api/* to api/index.ts, so logic in only one of them
 * silently never runs in production. Deliberately free of any Firebase import
 * so the browser, both API surfaces and the tests all run the same code.
 */

export interface AcademicTerm {
  id: string;
  nameAr: string;
  nameEn: string;
  /** First study day. The season opens here. 'YYYY-MM-DD'. */
  startDate: string;
  /** Last study day. */
  endDate: string;
  /** Shown to students; does not affect whether the competition is running. */
  examsStart: string | null;
  /** Last day the competition is live. Falls back to endDate when absent. */
  examsEnd: string | null;
}

export interface AcademicCalendar {
  yearLabel: string;
  timezone: string;
  /** Chronological. */
  terms: AcademicTerm[];
  /**
   * When the final results are published. Opens the نجحت / دور ثاني question.
   *
   * Year-level rather than per-term: progression to the next stage happens once
   * a year, after the last term's exams. Unset means the question never shows -
   * the whole flow stays dormant until a master admin sets a date.
   */
  resultsDate?: string | null;
  /** When دور ثاني results are published. Opens the نجحت / تحميل / رسبت question. */
  resitResultsDate?: string | null;
  /**
   * Stages whose students get asked. Empty/absent means every stage.
   *
   * Exists because the question is only meaningful for a cohort that actually
   * sat exams last year. When a stage's roster is imported fresh, those
   * students have no result to report and must not be blocked by the question.
   */
  progressionStages?: string[] | null;
}

export type Phase = 'study' | 'exams' | 'break' | 'preseason';

export interface PhaseInfo {
  phase: Phase;
  /** Streaks are frozen and both leaderboards show the archived season. */
  isPaused: boolean;
  /** The term this date falls in, or - while paused - the one that just ended. */
  term: AcademicTerm | null;
  /** Last live day of the current term. */
  liveUntil: string | null;
  /** When the next season opens. Null past the end of the calendar. */
  nextStart: string | null;
}

/**
 * The University of Al-Safwa calendar for 2026-2027, used until a master admin
 * saves their own. Exams stay live: only breaks pause the competition, so a
 * term runs startDate -> examsEnd.
 *
 * Term 1's examsEnd is the day before العطلة الربيعية begins. Term 2 has no
 * published exam end date, so it gets the same 14-day window as term 1; it is
 * editable like every other field.
 */
export const DEFAULT_CALENDAR: AcademicCalendar = {
  yearLabel: '2026-2027',
  timezone: 'Asia/Baghdad',
  terms: [
    {
      id: 'term1_2026',
      nameAr: 'الفصل الدراسي الأول',
      nameEn: 'First Semester',
      startDate: '2026-09-20',
      endDate: '2026-12-31',
      examsStart: '2027-01-03',
      examsEnd: '2027-01-16',
    },
    {
      id: 'term2_2027',
      nameAr: 'الفصل الدراسي الثاني',
      nameEn: 'Second Semester',
      startDate: '2027-01-31',
      endDate: '2027-05-13',
      examsStart: '2027-05-16',
      examsEnd: '2027-05-29',
    },
  ],
};

// ---------------------------------------------------------------------------
// Date helpers. Anchored at noon UTC, the same idiom the streak code already
// uses, so a shift across a DST boundary can never move a date by a whole day.
// ---------------------------------------------------------------------------

/** Today in the calendar's timezone as 'YYYY-MM-DD'. */
export function baghdadToday(timezone = 'Asia/Baghdad', now = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: timezone });
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Calendar days from `from` to `to`. Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T12:00:00Z`).getTime();
  const b = new Date(`${to}T12:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Phase resolution
// ---------------------------------------------------------------------------

/** Last day a term's competition is live. */
export function termLiveEnd(term: AcademicTerm): string {
  return term.examsEnd || term.endDate;
}

function sortedTerms(cal: AcademicCalendar): AcademicTerm[] {
  return (cal.terms || []).slice().sort((a, b) => a.startDate.localeCompare(b.startDate));
}

/**
 * The last term of the year, or null when no terms are configured.
 *
 * The year-end wipe uses it to refuse to run until that term's season has been
 * archived - startNewSeason reads the very stats the wipe deletes, so wiping
 * first would file a year of empty leaderboard cards.
 */
export function finalTermOf(cal: AcademicCalendar): AcademicTerm | null {
  const terms = sortedTerms(cal);
  return terms.length > 0 ? terms[terms.length - 1] : null;
}

/**
 * What state is the app in on `today`?
 *
 * Both ends of the calendar pause: before the first term is the summer holiday
 * the year opens out of, after the last term is the one it closes into. A
 * calendar with NO terms at all is the one case that stays live - that means
 * nobody has configured it, and a missing config must not freeze the app.
 */
export function resolvePhase(cal: AcademicCalendar, today: string): PhaseInfo {
  const terms = sortedTerms(cal);

  // No calendar configured - fail open rather than freezing the whole app.
  if (terms.length === 0) {
    return { phase: 'preseason', isPaused: false, term: null, liveUntil: null, nextStart: null };
  }

  for (const term of terms) {
    const liveEnd = termLiveEnd(term);
    if (today >= term.startDate && today <= liveEnd) {
      return {
        phase: today <= term.endDate ? 'study' : 'exams',
        isPaused: false,
        term,
        liveUntil: liveEnd,
        nextStart: null,
      };
    }
  }

  const next = terms.find(t => t.startDate > today) || null;

  // The holiday before the academic year opens.
  if (today < terms[0].startDate) {
    return {
      phase: 'preseason',
      isPaused: true,
      term: null,
      liveUntil: null,
      nextStart: terms[0].startDate,
    };
  }

  // Between two terms, or past the end of the calendar.
  const ended = terms.filter(t => termLiveEnd(t) < today).pop() || null;
  return {
    phase: 'break',
    isPaused: true,
    term: ended,
    liveUntil: ended ? termLiveEnd(ended) : null,
    nextStart: next ? next.startDate : null,
  };
}

/** Does this day count toward a streak? */
export function isLiveDay(cal: AcademicCalendar, date: string): boolean {
  return !resolvePhase(cal, date).isPaused;
}

// ---------------------------------------------------------------------------
// End-of-year progression
// ---------------------------------------------------------------------------

/** Which end-of-year question, if any, students should be answering today. */
export type ProgressionGate = 'closed' | 'first_round' | 'resit_round';

/**
 * Opens the progression questions once results are out.
 *
 * `resit_round` deliberately implies the first round is open too: a student who
 * never answered the first question still gets asked it, they just skip ahead
 * to the three-way one. With no resultsDate set this is always `closed`, so the
 * feature ships dormant and turns itself on when the dates are filled in.
 */
export function progressionGate(cal: AcademicCalendar, today: string): ProgressionGate {
  if (!cal.resultsDate || today < cal.resultsDate) return 'closed';
  if (cal.resitResultsDate && today >= cal.resitResultsDate) return 'resit_round';
  return 'first_round';
}

/** Hard ceiling on the day-by-day walk, so a very stale date cannot spin. */
const MAX_WALK_DAYS = 400;

/**
 * Live days in the half-open range (from, to] - i.e. how many days of streak
 * the student is accountable for since they were last active. Paused days are
 * not counted, so a student active on the last study day before a break and
 * again on the first day of the new term is one day apart, not fifteen.
 *
 * With streaks zeroed at every season close this is mostly defence in depth,
 * but it is what stops a mass streak wipe for every student if the rollover
 * ever fails to run across a break.
 */
export function activeDaysBetween(cal: AcademicCalendar, from: string, to: string): number {
  const span = daysBetween(from, to);
  if (span <= 0) return 0;
  if (span > MAX_WALK_DAYS) return span;

  let count = 0;
  for (let i = 1; i <= span; i++) {
    if (isLiveDay(cal, addDays(from, i))) count++;
  }
  return count;
}

/**
 * Is `from` on the far side of the academic year's opening boundary?
 *
 * The counterpart to activeDaysBetween's rule that paused days are not misses.
 * That rule is right within the year - a student active on the last live day
 * before العطلة الربيعية and again on the first day of term 2 kept their
 * streak, which is the defence in depth pinned by scripts/calendar.test.ts
 * against a rollover that failed to run. `preseason` looks identical to that
 * function and is not: every day before terms[0].startDate is paused, so it
 * reports a gap of ONE from any of them - last June included - and
 * record-activity increments a streak belonging to no season on this calendar.
 *
 * Nothing else catches it. closableTerm() can never return the FIRST term of
 * the year, because no term precedes it, so startNewSeason never fires at the
 * year's open and the stale counters are never zeroed. That is how a student
 * read 2 on the first day of term 1 with every other student on 1.
 *
 * Scoped to the year's opening boundary only, never to a term boundary inside
 * it: closing term 1 IS a closable term, so the rollover zeroes those counters
 * properly and the break bridging above must survive.
 *
 * Deliberately not folded into activeDaysBetween, whose result also sizes the
 * freeze-token gap walk inside a term.
 */
export function startsFreshSeason(
  cal: AcademicCalendar,
  from: string | null | undefined,
  to: string,
): boolean {
  if (!from) return false;
  const terms = sortedTerms(cal);
  // An unconfigured calendar has no opening boundary to be outside of, and
  // failing open here keeps a missing config from wiping everyone's streak -
  // the same call resolvePhase makes.
  if (terms.length === 0) return false;
  const yearOpens = terms[0].startDate;
  return from < yearOpens && to >= yearOpens;
}

/**
 * The term whose season is over but has not been archived yet, or null.
 *
 * This is the rollover's idempotency key: once `seasonClosedFor` holds a term's
 * id, that term can never be archived twice. It also makes a late run
 * self-healing, because the term is still returned however long after the
 * boundary the rollover finally fires.
 */
export function closableTerm(
  cal: AcademicCalendar,
  today: string,
  seasonClosedFor?: string | null,
): AcademicTerm | null {
  const ended = sortedTerms(cal).filter(t => termLiveEnd(t) < today);
  const last = ended[ended.length - 1];
  if (!last || last.id === seasonClosedFor) return null;
  return last;
}

/** The name a closed term is archived under, e.g. 'الفصل الدراسي الأول 2026-2027'. */
export function seasonNameFor(cal: AcademicCalendar, term: AcademicTerm): string {
  return `${term.nameAr} ${cal.yearLabel}`.trim();
}

// ---------------------------------------------------------------------------
// Validation, used by the settings modal before it saves
// ---------------------------------------------------------------------------

/** Returns a list of problems; empty means the calendar is safe to save. */
export function validateCalendar(cal: AcademicCalendar): string[] {
  const errors: string[] = [];
  const terms = cal.terms || [];

  if (terms.length === 0) errors.push('EMPTY');

  terms.forEach((term, i) => {
    const where = `${i + 1}`;
    if (!term.startDate || !term.endDate) {
      errors.push(`TERM_${where}_DATES_REQUIRED`);
      return;
    }
    if (term.endDate < term.startDate) errors.push(`TERM_${where}_END_BEFORE_START`);
    if (term.examsStart && term.examsStart <= term.endDate) errors.push(`TERM_${where}_EXAMS_BEFORE_END`);
    if (term.examsEnd && term.examsEnd < (term.examsStart || term.endDate)) {
      errors.push(`TERM_${where}_EXAMS_END_BEFORE_START`);
    }
  });

  const ordered = sortedTerms(cal);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].startDate <= termLiveEnd(ordered[i - 1])) {
      errors.push(`TERM_${i + 1}_OVERLAPS_PREVIOUS`);
    }
  }

  // No constraint tying resultsDate to THIS calendar's terms. Progression runs
  // on the results of the year just FINISHED, so the date normally falls before
  // the new year's first term - the earlier rule that it must follow the last
  // exam made the only case that matters impossible to enter.
  if (cal.resitResultsDate && !cal.resultsDate) {
    errors.push('RESIT_WITHOUT_RESULTS');
  }
  if (cal.resitResultsDate && cal.resultsDate && cal.resitResultsDate <= cal.resultsDate) {
    errors.push('RESIT_NOT_AFTER_RESULTS');
  }

  return errors;
}
