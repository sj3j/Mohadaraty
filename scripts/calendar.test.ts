/**
 * Verifies the academic calendar phase resolver.
 *
 * Run with:  npm run test:calendar
 *
 * Pure functions only - no emulator, no Firebase. This is what decides whether
 * every student's streak counts today, so each boundary in the real 2026-2027
 * calendar is pinned down explicitly rather than assumed.
 */
import {
  DEFAULT_CALENDAR,
  resolvePhase,
  activeDaysBetween,
  startsFreshSeason,
  closableTerm,
  seasonNameFor,
  validateCalendar,
  termLiveEnd,
  addDays,
  daysBetween,
  progressionGate,
  AcademicCalendar,
} from '../shared/academicCalendar';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); failed++; }
};

const cal = DEFAULT_CALENDAR;
const at = (d: string) => resolvePhase(cal, d);

console.log('Date helpers:');
check('addDays crosses a month boundary', addDays('2026-12-31', 1) === '2027-01-01', addDays('2026-12-31', 1));
check('addDays goes backwards', addDays('2027-01-01', -1) === '2026-12-31', addDays('2027-01-01', -1));
check('daysBetween counts forward', daysBetween('2027-01-16', '2027-01-31') === 15, String(daysBetween('2027-01-16', '2027-01-31')));
check('daysBetween is negative backwards', daysBetween('2027-01-31', '2027-01-16') === -15);

console.log('\nPhase boundaries:');

// The summer holiday the year opens out of. The 2025-2026 season has been
// archived, so this period is paused until the new year starts.
check('2026-08-25 (today, before the calendar starts) is PAUSED',
  at('2026-08-25').isPaused === true && at('2026-08-25').phase === 'preseason', at('2026-08-25').phase);
check('preseason points at the first term start',
  at('2026-08-25').nextStart === '2026-09-20', String(at('2026-08-25').nextStart));
check('preseason names no term - nothing has run yet this year',
  at('2026-08-25').term === null);

// A calendar with no terms at all means nobody configured one. That must fail
// OPEN, or a missing config would freeze the whole app.
check('an unconfigured calendar stays live',
  resolvePhase({ ...cal, terms: [] }, '2026-08-25').isPaused === false);

// ---- term 1 --------------------------------------------------------------
check('2026-09-19 (day before term 1) is still preseason and paused',
  at('2026-09-19').phase === 'preseason' && at('2026-09-19').isPaused === true);
check('2026-09-20 (term 1 starts) is study', at('2026-09-20').phase === 'study' && !at('2026-09-20').isPaused);
check('2026-11-01 mid-term is study', at('2026-11-01').phase === 'study');
check('2026-12-31 (last study day) is study', at('2026-12-31').phase === 'study', at('2026-12-31').phase);

// The two-day gap between end of study and start of exams stays live.
check('2027-01-01 (gap before exams) is live', at('2027-01-01').isPaused === false, at('2027-01-01').phase);
check('2027-01-02 (gap before exams) is live', at('2027-01-02').isPaused === false);

check('2027-01-03 (exams start) is exams and LIVE',
  at('2027-01-03').phase === 'exams' && at('2027-01-03').isPaused === false, at('2027-01-03').phase);
check('2027-01-16 (last exam day) is still live', at('2027-01-16').isPaused === false);
check('term 1 lives until 2027-01-16', at('2027-01-03').liveUntil === '2027-01-16', String(at('2027-01-03').liveUntil));

// ---- العطلة الربيعية ------------------------------------------------------
check('2027-01-17 (break starts) is PAUSED',
  at('2027-01-17').phase === 'break' && at('2027-01-17').isPaused === true, at('2027-01-17').phase);
check('break names the term that just ended', at('2027-01-17').term?.id === 'term1_2026', String(at('2027-01-17').term?.id));
check('break says when the new season opens',
  at('2027-01-17').nextStart === '2027-01-31', String(at('2027-01-17').nextStart));
check('2027-01-30 (last break day) is still paused', at('2027-01-30').isPaused === true);

// ---- term 2 --------------------------------------------------------------
check('2027-01-31 (term 2 starts) is study and live',
  at('2027-01-31').phase === 'study' && at('2027-01-31').isPaused === false, at('2027-01-31').phase);
check('term 2 is the active term', at('2027-01-31').term?.id === 'term2_2027');
check('2027-05-13 (last study day) is study', at('2027-05-13').phase === 'study');
check('2027-05-16 (term 2 exams) is exams and live',
  at('2027-05-16').phase === 'exams' && at('2027-05-16').isPaused === false);
check('2027-05-29 (last exam day) is live', at('2027-05-29').isPaused === false);

// ---- summer --------------------------------------------------------------
check('2027-05-30 (summer) is PAUSED', at('2027-05-30').isPaused === true, at('2027-05-30').phase);
check('summer has no next season until next year is added',
  at('2027-05-30').nextStart === null, String(at('2027-05-30').nextStart));
check('summer names term 2 as the season that ended', at('2027-05-30').term?.id === 'term2_2027');

console.log('\nStreak gap protection:');

// The assertion this whole mechanism exists for: a student active on the last
// live day before the break and again on the first day of the new term is ONE
// day apart, so their streak survives even if the rollover never ran.
check('a break costs no streak days (2027-01-16 -> 2027-01-31 == 1)',
  activeDaysBetween(cal, '2027-01-16', '2027-01-31') === 1,
  String(activeDaysBetween(cal, '2027-01-16', '2027-01-31')));
check('consecutive live days count as 1', activeDaysBetween(cal, '2026-11-01', '2026-11-02') === 1);

// ---- the year's opening boundary -----------------------------------------
// The bug this pins: every preseason day is PAUSED, so activeDaysBetween reads
// a gap of exactly ONE from any of them into day 1 of term 1 - from last June
// as readily as from yesterday. record-activity then took its `daysDiff === 1`
// arm and incremented a counter belonging to no season on this calendar, while
// closableTerm() can never close a first term so startNewSeason never zeroed
// it. One student opened day 1 on 2 with every other student on 1.
check('the whole preseason still reads as a one-day gap (the trap)',
  activeDaysBetween(cal, '2026-06-01', '2026-09-20') === 1,
  String(activeDaysBetween(cal, '2026-06-01', '2026-09-20')));
check('...so a June lastActiveDate starts a FRESH season on day 1',
  startsFreshSeason(cal, '2026-06-01', '2026-09-20') === true);
check('the day before term 1 does too',
  startsFreshSeason(cal, '2026-09-19', '2026-09-20') === true);
check('no prior activity is not a boundary crossing',
  startsFreshSeason(cal, null, '2026-09-20') === false);
check('day 1 -> day 2 is an ordinary continuation',
  startsFreshSeason(cal, '2026-09-20', '2026-09-21') === false);
check('a mid-term gap is not a boundary crossing',
  startsFreshSeason(cal, '2026-11-01', '2026-11-05') === false);
check('study -> exams inside one term is not either',
  startsFreshSeason(cal, '2026-12-31', '2027-01-03') === false);

// Scoped to the YEAR's open, never a term boundary inside it: closing term 1 IS
// a closable term, so the rollover zeroes those counters properly and the break
// bridging asserted just above has to survive.
check('the mid-year break still bridges - it is a closable season',
  startsFreshSeason(cal, '2027-01-16', '2027-01-31') === false);
check('an unconfigured calendar fails open rather than wiping streaks',
  startsFreshSeason({ ...cal, terms: [] }, '2026-06-01', '2026-09-20') === false);
check('a genuinely missed live day counts', activeDaysBetween(cal, '2026-11-01', '2026-11-03') === 2,
  String(activeDaysBetween(cal, '2026-11-01', '2026-11-03')));
check('exams days still count (they are live)',
  activeDaysBetween(cal, '2027-01-03', '2027-01-06') === 3,
  String(activeDaysBetween(cal, '2027-01-03', '2027-01-06')));
check('the whole break counts as zero',
  activeDaysBetween(cal, '2027-01-17', '2027-01-30') === 0,
  String(activeDaysBetween(cal, '2027-01-17', '2027-01-30')));
check('same day is zero', activeDaysBetween(cal, '2026-11-01', '2026-11-01') === 0);
check('a backwards range is zero', activeDaysBetween(cal, '2026-11-05', '2026-11-01') === 0);

// record-activity resolves the phase against the day being CREDITED, not
// wall-clock today. Just after midnight the grace period still credits
// yesterday, so on the first morning of term the credited day is the last day
// of the break. Gating on today instead would write a break day into
// lastActiveDate, which reads as a missed day on the next visit.
console.log('\nGrace-period boundary (the day credited, not today):');
check('00:30 on the first day of term credits the last break day, which is paused',
  at('2027-01-30').isPaused === true);
check('later the same day credits the term day, which is live',
  at('2027-01-31').isPaused === false);
check('gating on the wrong date would cost a day',
  activeDaysBetween(cal, '2027-01-30', '2027-02-01') === 2,
  String(activeDaysBetween(cal, '2027-01-30', '2027-02-01')));
check('gating on the right date does not',
  activeDaysBetween(cal, '2027-01-31', '2027-02-01') === 1,
  String(activeDaysBetween(cal, '2027-01-31', '2027-02-01')));

console.log('\nSeason close (rollover idempotency):');
check('nothing to close mid-term', closableTerm(cal, '2026-11-01', null) === null);
check('nothing to close on the last live day', closableTerm(cal, '2027-01-16', null) === null);
check('term 1 is closable on the first break day',
  closableTerm(cal, '2027-01-17', null)?.id === 'term1_2026',
  String(closableTerm(cal, '2027-01-17', null)?.id));
check('term 1 is NOT closable twice',
  closableTerm(cal, '2027-01-17', 'term1_2026') === null);
check('a late rollover still closes term 1',
  closableTerm(cal, '2027-01-29', null)?.id === 'term1_2026');
check('term 1 stays closed once term 2 is running',
  closableTerm(cal, '2027-03-01', 'term1_2026') === null);
check('term 2 is closable in the summer',
  closableTerm(cal, '2027-05-30', 'term1_2026')?.id === 'term2_2027',
  String(closableTerm(cal, '2027-05-30', 'term1_2026')?.id));
check('season name reads as a semester + year',
  seasonNameFor(cal, cal.terms[0]) === 'الفصل الدراسي الأول 2026-2027',
  seasonNameFor(cal, cal.terms[0]));
check('termLiveEnd falls back to endDate when exams are absent',
  termLiveEnd({ ...cal.terms[0], examsEnd: null }) === '2026-12-31');

console.log('\nProgression gate (end-of-year questions):');
// Dormant until a master admin sets the dates - that is what makes this safe to
// ship before anyone has decided when results come out.
check('no results date means nobody is ever asked',
  progressionGate(cal, '2027-07-01') === 'closed', progressionGate(cal, '2027-07-01'));

const withResults: AcademicCalendar = { ...cal, resultsDate: '2027-06-15' };
check('closed the day before results', progressionGate(withResults, '2027-06-14') === 'closed');
check('first round opens ON the results date',
  progressionGate(withResults, '2027-06-15') === 'first_round');
check('and stays open after it', progressionGate(withResults, '2027-07-20') === 'first_round');
check('a resit date alone does nothing without results',
  progressionGate({ ...cal, resitResultsDate: '2027-08-20' }, '2027-09-01') === 'closed');

const withResit: AcademicCalendar = { ...withResults, resitResultsDate: '2027-08-20' };
check('still the first round between the two dates',
  progressionGate(withResit, '2027-08-19') === 'first_round');
check('resit round opens ON the resit date',
  progressionGate(withResit, '2027-08-20') === 'resit_round');
check('during term nothing is asked - results are in the future',
  progressionGate(withResit, '2026-11-01') === 'closed');

console.log('\nValidation:');
check('the default calendar is valid', validateCalendar(cal).length === 0, validateCalendar(cal).join(','));
check('an empty calendar is rejected',
  validateCalendar({ ...cal, terms: [] }).includes('EMPTY'));
check('end before start is rejected',
  validateCalendar({ ...cal, terms: [{ ...cal.terms[0], endDate: '2026-09-01' }] })
    .some(e => e.endsWith('END_BEFORE_START')));
check('overlapping terms are rejected',
  validateCalendar({ ...cal, terms: [cal.terms[0], { ...cal.terms[1], startDate: '2027-01-10' }] })
    .some(e => e.endsWith('OVERLAPS_PREVIOUS')));
// Progression runs on the year just FINISHED, so the results date normally
// falls BEFORE this calendar's first term. The old rule forbade exactly that
// and made the only real case impossible to enter.
check('a results date before the new year starts is allowed',
  validateCalendar({ ...cal, resultsDate: '2026-08-29' }).length === 0,
  validateCalendar({ ...cal, resultsDate: '2026-08-29' }).join(','));
check('a resit date without a results date is rejected',
  validateCalendar({ ...cal, resitResultsDate: '2027-08-20' }).includes('RESIT_WITHOUT_RESULTS'));
check('resit results before the first results are rejected',
  validateCalendar({ ...cal, resultsDate: '2027-06-15', resitResultsDate: '2027-06-01' })
    .includes('RESIT_NOT_AFTER_RESULTS'));
check('a sane results pair validates',
  validateCalendar({ ...cal, resultsDate: '2027-06-15', resitResultsDate: '2027-08-20' }).length === 0);
check('exams starting before study ends is rejected',
  validateCalendar({ ...cal, terms: [{ ...cal.terms[0], examsStart: '2026-12-01' }] })
    .some(e => e.endsWith('EXAMS_BEFORE_END')));

// A calendar with a mid-term break (an Eid holiday, say) must pause too - the
// resolver has no special case for "the gap between semesters".
console.log('\nAd-hoc mid-year break:');
const withEid: AcademicCalendar = {
  ...cal,
  terms: [
    { ...cal.terms[0], endDate: '2026-11-10', examsStart: null, examsEnd: null },
    { ...cal.terms[0], id: 'term1b', startDate: '2026-11-15', endDate: '2026-12-31',
      examsStart: '2027-01-03', examsEnd: '2027-01-16' },
  ],
};
check('a mid-year gap pauses', resolvePhase(withEid, '2026-11-12').isPaused === true);
check('and resumes after it', resolvePhase(withEid, '2026-11-15').isPaused === false);
check('the gap costs no streak days', activeDaysBetween(withEid, '2026-11-10', '2026-11-15') === 1,
  String(activeDaysBetween(withEid, '2026-11-10', '2026-11-15')));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
