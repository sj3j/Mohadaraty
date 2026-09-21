/**
 * The automated season rollover: the one piece of the calendar system that writes.
 *
 * Pausing and resuming do NOT live here - those are derived from the date by
 * resolvePhase(), on every client and on every request, so the app behaves
 * correctly whether or not this ever runs. What this adds is the archive: when
 * a term's season is over, it captures both leaderboards into every student's
 * profile and zeroes them for the next term.
 *
 * Idempotent per term via `app_settings/streak.seasonClosedFor`, so it is safe
 * to call from a daily cron, from the admin's manual button, and twice in the
 * same minute. Also self-healing: a term stays closable however long after the
 * boundary the rollover finally fires.
 *
 * Shared by server.ts and api/index.ts for the usual reason - vercel.json routes
 * production /api/* to api/index.ts, so anything defined in only one of them
 * silently never runs where it matters.
 */
import {
  AcademicCalendar,
  DEFAULT_CALENDAR,
  PhaseInfo,
  baghdadToday,
  closableTerm,
  resolvePhase,
  seasonNameFor,
  seasonOpeningDay,
} from './academicCalendar.js';
import { openSeason, startNewSeason } from './seasonReset.js';

export interface RolloverResult {
  today: string;
  phase: PhaseInfo['phase'];
  isPaused: boolean;
  activeTermId: string | null;
  /** Term id archived by this run, or null when there was nothing to close. */
  archived: string | null;
  /** Term id whose season this run opened, or null when nothing needed it. */
  opened?: string | null;
  /** Accounts whose pre-term streak state the open pass cleared. */
  openCleared?: number;
  /** Accounts the open pass clamped to 1 because they had already been
   *  credited for the opening day. */
  openBridged?: number;
  seasonId?: string;
  streakArchived?: number;
  mcqArchived?: number;
}

/** The saved calendar, or the built-in default when nobody has saved one yet. */
export async function loadCalendar(db: FirebaseFirestore.Firestore): Promise<AcademicCalendar> {
  const snap = await db.collection('app_settings').doc('academicCalendar').get();
  if (!snap.exists) return DEFAULT_CALENDAR;

  const data = snap.data() as Partial<AcademicCalendar> | undefined;
  if (!data || !Array.isArray(data.terms) || data.terms.length === 0) return DEFAULT_CALENDAR;

  return {
    yearLabel: data.yearLabel || DEFAULT_CALENDAR.yearLabel,
    timezone: data.timezone || DEFAULT_CALENDAR.timezone,
    terms: data.terms,
    resultsDate: data.resultsDate ?? null,
    resitResultsDate: data.resitResultsDate ?? null,
    progressionStages: data.progressionStages ?? null,
  };
}

/**
 * Is the competition paused? Used by record-activity.
 *
 * `forDate` must be the day being CREDITED, not wall-clock today. The streak
 * grace period means that just after midnight the day credited is still
 * yesterday; gating on today instead would let a request at 00:30 on the first
 * day of term write a break day into lastActiveDate, which then reads as a
 * missed day on the next visit and burns a freeze shield for nothing.
 */
export async function resolveCurrentPhase(
  db: FirebaseFirestore.Firestore,
  forDate?: string,
): Promise<{ calendar: AcademicCalendar; phase: PhaseInfo }> {
  const calendar = await loadCalendar(db);
  const date = forDate || baghdadToday(calendar.timezone);
  return { calendar, phase: resolvePhase(calendar, date) };
}

/**
 * Writes the derived phase onto app_settings/streak.
 *
 * Nothing reads this to decide whether streaks count - that is always
 * recomputed from the dates - but keeping vacationMode in step means any
 * surface still reading the old flag behaves correctly too.
 *
 * Every path that ends a season calls this afterwards, so the pause state is
 * recomputed from the calendar rather than being the archive's decision.
 */
export async function syncPhaseMirror(
  db: FirebaseFirestore.Firestore,
  FieldValue: { serverTimestamp(): any; delete(): any },
  phase?: PhaseInfo,
): Promise<PhaseInfo> {
  const resolved = phase || (await resolveCurrentPhase(db)).phase;
  await db.collection('app_settings').doc('streak').set({
    vacationMode: resolved.isPaused,
    currentPhase: resolved.phase,
    activeTermId: resolved.term?.id ?? null,
    phaseSyncedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return resolved;
}

export async function runSeasonRollover(
  db: FirebaseFirestore.Firestore,
  FieldValue: { serverTimestamp(): any; delete(): any },
  opts: { performedBy: string },
): Promise<RolloverResult> {
  const calendar = await loadCalendar(db);
  const today = baghdadToday(calendar.timezone);
  const phase = resolvePhase(calendar, today);

  const settingsRef = db.collection('app_settings').doc('streak');
  const settingsSnap = await settingsRef.get();
  const seasonClosedFor = settingsSnap.exists ? settingsSnap.data()?.seasonClosedFor : null;
  const seasonOpenedFor = settingsSnap.exists ? settingsSnap.data()?.seasonOpenedFor : null;

  const term = closableTerm(calendar, today, seasonClosedFor);

  let archived: RolloverResult['archived'] = null;
  let reset: { seasonId: string; streakArchived: number; mcqArchived: number } | null = null;

  if (term) {
    reset = await startNewSeason(db, FieldValue, {
      seasonName: seasonNameFor(calendar, term),
      performedBy: opts.performedBy,
      closedTermId: term.id,
    });
    archived = term.id;
  }

  // Open the running term AFTER closing whatever ended, so a close in the same
  // pass has already zeroed everyone and this finds nothing left to do.
  //
  // This is the half that never existed. closableTerm() can only return a term
  // that has ENDED, so the first term of a calendar is never closed and its
  // season was never started either - stale counters from before the academic
  // year simply carried into day 1, where the paused preseason reads as a
  // one-day gap and increments them.
  let opened: string | null = null;
  let openCleared = 0;
  let openBridged = 0;
  const yearOpens = seasonOpeningDay(calendar);
  // The stamp must not hide a SAME-DAY second pass. A repair run by hand before
  // the fixed build reached production stamps the term while production is
  // still minting bridged rows - and the bridge can only be created on the
  // year's opening day, so on that one day a year this re-runs regardless of
  // the stamp. Costs one extra users scan annually; buys "the cron repairs this
  // even if the operator did it in the wrong order" as a property of the code
  // rather than of the runbook.
  const mustReopen = seasonOpenedFor !== phase.term?.id || today === yearOpens;
  if (phase.term && !phase.isPaused && mustReopen) {
    const openResult = await openSeason(db, FieldValue, {
      termId: phase.term.id,
      termStart: phase.term.startDate,
      yearOpens,
      // Safe as the plain calendar date ONLY because the cron is scheduled at
      // 01:00 UTC = 04:00 Baghdad (vercel.json), which is outside the 2-hour
      // grace window - so the day being credited and the calendar day agree.
      // Move that schedule earlier and this has to become the effective date,
      // the way scripts/streakAudit.ts computes it.
      creditedDay: today,
      performedBy: opts.performedBy,
    });
    opened = openResult.termId;
    openCleared = openResult.cleared;
    openBridged = openResult.bridged;
  }

  await syncPhaseMirror(db, FieldValue, phase);

  return {
    today,
    phase: phase.phase,
    isPaused: phase.isPaused,
    activeTermId: phase.term?.id ?? null,
    archived,
    opened,
    openCleared,
    openBridged,
    ...(reset || {}),
  };
}
