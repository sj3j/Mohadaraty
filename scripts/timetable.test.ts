/**
 * Pins the pure half of the AI-parsed weekly timetable.
 *
 * Run with:  npm run test:timetable
 *
 * No emulator and no network: every function under test lives in
 * shared/timetable.ts precisely so this can run bare. What it guards:
 *
 *   - The response schema carries no minItems/maxItems. That single key
 *     reappearing makes Gemini reject EVERY parse with 400 before reading the
 *     image, and the symptom looks nothing like the cause.
 *   - No session object ever grows a `subjectId`. A timetable cell that reads
 *     "Physiology I + Computer Science" must stay a string; turning one into a
 *     subject is the mistake that needed a reviewed split flow to undo.
 *   - The afternoon time heuristic, which is the most likely source of a
 *     silently-wrong agenda.
 *   - The fail-open audience rule: an unlabelled practical is shown to
 *     everyone, not to nobody.
 */
import {
  TIMETABLE_RESPONSE_SCHEMA,
  MAX_TIMETABLE_SESSIONS,
  audiencesIntersect,
  groupSessionsByDay,
  minutesToTime,
  normalizeDay,
  normalizeParsedGroups,
  normalizeTime,
  overlappingSessions,
  sessionsForStudent,
  splitCombinedTitle,
  timeToMinutes,
  toAsciiDigits,
  unlabelledPracticals,
  validateTimetable,
  type TimetableSession,
} from '../shared/timetable';
import type { GroupConfigLike } from '../shared/groups';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); failed++; }
};

const CONFIG_ABCD: GroupConfigLike = {
  groups: ['A', 'B', 'C', 'D'].map(id => ({ id, subgroupCount: 4 })),
};
/** Two groups of two. Deliberately NOT a single group: with only A configured,
 *  "A" is the whole stage and the full-cover collapse correctly returns the
 *  universal [], which would mask whether expansion read the config at all. */
const CONFIG_AB2: GroupConfigLike = {
  groups: [{ id: 'A', subgroupCount: 2 }, { id: 'B', subgroupCount: 2 }],
};

const session = (over: Partial<TimetableSession> = {}): TimetableSession => ({
  id: 's1', day: 0, start: '08:30', end: '10:30',
  title: 'Physiology I', kind: 'theory', groups: [], source: 'ai',
  ...over,
});

/* ------------------------------------------------------------------ *
 * 1. The schema contract
 * ------------------------------------------------------------------ */
console.log('\nResponse schema');
{
  const serialised = JSON.stringify(TIMETABLE_RESPONSE_SCHEMA);
  check('carries no minItems', !serialised.includes('minItems'),
    'minItems in a schema this nested makes Gemini 400 every call');
  check('carries no maxItems', !serialised.includes('maxItems'),
    'maxItems in a schema this nested makes Gemini 400 every call');
  check('day is a named enum, not an integer',
    (TIMETABLE_RESPONSE_SCHEMA as any).properties.sessions.items.properties.day.type === 'string');
  check('requires the six load-bearing fields',
    JSON.stringify((TIMETABLE_RESPONSE_SCHEMA as any).properties.sessions.items.required)
      === JSON.stringify(['day', 'start', 'end', 'title', 'kind', 'groups']));
}

/* ------------------------------------------------------------------ *
 * 2. The subject hazard, asserted structurally
 * ------------------------------------------------------------------ */
console.log('\nSubjects are never invented');
{
  const parsed = {
    sessions: [
      { day: 'sunday', start: '08:30', end: '10:30', kind: 'theory', groups: [],
        title: 'Physiology I + Computer Science' },
    ],
  };
  const out = validateTimetable(parsed, CONFIG_ABCD);
  const keys = Object.keys(out.sessions[0] || {});
  check('no subjectId on an emitted session', !keys.includes('subjectId'), keys.join(','));
  check('no category on an emitted session', !keys.includes('category'), keys.join(','));
  check('a combined cell keeps its title verbatim',
    out.sessions[0]?.title === 'Physiology I + Computer Science');
  check('a combined cell exposes its parts for display only',
    JSON.stringify(out.sessions[0]?.titles) === JSON.stringify(['Physiology I', 'Computer Science']));
  check('schema itself never mentions subjectId',
    !JSON.stringify(TIMETABLE_RESPONSE_SCHEMA).includes('subjectId'));
}

/* ------------------------------------------------------------------ *
 * 3. Times
 * ------------------------------------------------------------------ */
console.log('\nnormalizeTime');
{
  const cases: [unknown, string | null][] = [
    ['8:30', '08:30'],
    ['08:30', '08:30'],
    ['08.30', '08:30'],
    ['0830', '08:30'],
    ['830', '08:30'],
    ['8', '08:00'],
    ['2', '14:00'],          // the afternoon heuristic
    ['3', '15:00'],
    ['1:30', '13:30'],
    ['5', '17:00'],
    // Guard 1: it stops at 5, so an implausible hour is never invented.
    ['6', '06:00'],
    ['7', '07:00'],
    // Guard 2: a zero-padded hour is 24h convention and is left alone. Without
    // this, an explicit "07:00" silently became 19:00.
    ['07:00', '07:00'],
    ['01:30', '01:30'],
    ['0130', '01:30'],
    ['12', '12:00'],
    ['1:15 pm', '13:15'],
    ['12:30 PM', '12:30'],
    ['12:30 am', '00:30'],
    ['9:00 AM', '09:00'],
    ['١٠:٤٥', '10:45'],   // ١٠:٤٥
    ['١٢ م', '12:00'],         // ١٢ م
    ['٨:٣٠', '08:30'],         // ٨:٣٠
    ['lunch', null],
    ['', null],
    [null, null],
    ['25:00', null],
    ['10:75', null],
  ];
  for (const [input, want] of cases) {
    const got = normalizeTime(input);
    check(`${JSON.stringify(input)} -> ${want}`, got === want, `got ${got}`);
  }
  check('toAsciiDigits handles Persian digits', toAsciiDigits('۱۲') === '12');
  check('timeToMinutes("13:45") === 825', timeToMinutes('13:45') === 825);
  check('timeToMinutes rejects non-canonical', timeToMinutes('8:30') === -1);
  check('minutesToTime(825) === "13:45"', minutesToTime(825) === '13:45');
}

/* ------------------------------------------------------------------ *
 * 4. Days
 * ------------------------------------------------------------------ */
console.log('\nnormalizeDay');
{
  const cases: [unknown, number | null][] = [
    ['sunday', 0], ['Sunday', 0], ['SUN', 0],
    ['monday', 1], ['thursday', 4], ['Thursday', 4],
    ['الأحد', 0],          // الأحد
    ['الاحد', 0],          // الاحد
    ['الإثنين', 1], // الإثنين
    ['الخميس', 4],    // الخميس
    ['الجمعة', 5],    // الجمعة
    [3, 3], ['4', 4],
    ['nonsense', null], ['', null], [null, null], [9, null],
  ];
  for (const [input, want] of cases) {
    const got = normalizeDay(input);
    check(`${JSON.stringify(input)} -> ${want}`, got === want, `got ${got}`);
  }
}

/* ------------------------------------------------------------------ *
 * 5. Groups
 * ------------------------------------------------------------------ */
console.log('\nnormalizeParsedGroups');
{
  const g = (raw: unknown, config = CONFIG_ABCD) => normalizeParsedGroups(raw, 'practical', config);

  check('["A"] expands to that stage\'s subgroups',
    JSON.stringify(g(['A']).groups) === JSON.stringify(['A1', 'A2', 'A3', 'A4']));
  check('expansion follows the stage config, not a constant',
    JSON.stringify(g(['A'], CONFIG_AB2).groups) === JSON.stringify(['A1', 'A2']));
  check('a group that IS the whole stage collapses to universal',
    g(['A'], { groups: [{ id: 'A', subgroupCount: 2 }] }).groups.length === 0);
  check('a group the config lacks is dropped, not kept',
    g(['E']).groups.length === 0 && g(['E']).dropped.includes('E'));
  check('a subgroup past the config is dropped',
    g(['A5']).groups.length === 0 && g(['A5']).dropped.includes('A5'));
  check('lowercase is normalised', JSON.stringify(g(['a1']).groups) === JSON.stringify(['A1']));
  check('Arabic letter + Arabic-Indic digit',
    JSON.stringify(g(['أ١']).groups) === JSON.stringify(['A1']));   // أ١
  check('"مجموعة A" strips its prefix',
    JSON.stringify(g(['مجموعة A']).groups)
      === JSON.stringify(['A1', 'A2', 'A3', 'A4']));
  check('"A-1" and "A/1" are one subgroup',
    JSON.stringify(g(['A-1']).groups) === JSON.stringify(['A1'])
    && JSON.stringify(g(['A/1']).groups) === JSON.stringify(['A1']));
  check('a range expands', JSON.stringify(g(['A1-A3']).groups) === JSON.stringify(['A1', 'A2', 'A3']));
  check('a short range expands', JSON.stringify(g(['A1-3']).groups) === JSON.stringify(['A1', 'A2', 'A3']));
  check('full cover collapses to universal', g(['A', 'B', 'C', 'D']).groups.length === 0);
  check('partial cover does NOT collapse', g(['A', 'B']).groups.length === 8);
  check('"الكل" is universal', g(['الكل']).groups.length === 0);
  check('"All" is universal', g(['All']).groups.length === 0);
  check('universal wins over a specific label',
    g(['A1', 'الكل']).groups.length === 0);
  check('[] stays universal', g([]).groups.length === 0);
  check('a non-array audience fails open to universal', g('A1' as any).groups.length === 0);
  check('duplicates collapse', JSON.stringify(g(['A1', 'A1', 'a1']).groups) === JSON.stringify(['A1']));
  check('output is sorted', JSON.stringify(g(['C2', 'A3', 'A1']).groups)
    === JSON.stringify(['A1', 'A3', 'C2']));
}

/* ------------------------------------------------------------------ *
 * 6. Titles — the + rule, and only the + rule
 * ------------------------------------------------------------------ */
console.log('\nsplitCombinedTitle');
{
  check('"+" splits',
    JSON.stringify(splitCombinedTitle('Physiology I + Computer Science'))
      === JSON.stringify(['Physiology I', 'Computer Science']));
  check('"and" does NOT split',
    splitCombinedTitle('Pharmaceutical and Cosmetic Preparations').length === 1);
  check('Arabic "و" does NOT split',
    splitCombinedTitle('المستحضرات الصيدلانية والتجميلية').length === 1);
  check('a plain title is one part', splitCombinedTitle('Biochemistry II').length === 1);
  check('empty yields nothing', splitCombinedTitle('').length === 0);
}

/* ------------------------------------------------------------------ *
 * 7. validateTimetable
 * ------------------------------------------------------------------ */
console.log('\nvalidateTimetable');
{
  const row = (over: any = {}) => ({
    day: 'sunday', start: '08:30', end: '10:30',
    title: 'Physiology I', kind: 'theory', groups: [], ...over,
  });

  const mixed = validateTimetable({ sessions: [row(), row({ day: 'nope' }), row({ day: 'monday' })] }, CONFIG_ABCD);
  check('keeps the good rows and drops only the bad one',
    mixed.ok && mixed.sessions.length === 2 && mixed.dropped === 1,
    `ok=${mixed.ok} kept=${mixed.sessions.length} dropped=${mixed.dropped}`);

  const allBad = validateTimetable({ sessions: [row({ day: 'nope' })] }, CONFIG_ABCD);
  check('fails when nothing survives', !allBad.ok && !!allBad.reason);

  const mostlyBad = validateTimetable(
    { sessions: [row(), row({ day: 'x' }), row({ day: 'x' })] }, CONFIG_ABCD);
  check('fails when more than half the sheet is unreadable', !mostlyBad.ok, mostlyBad.reason);

  check('a missing sessions array fails', !validateTimetable({}, CONFIG_ABCD).ok);
  check('a null parse fails', !validateTimetable(null, CONFIG_ABCD).ok);

  const repaired = validateTimetable({ sessions: [row({ end: '07:00' })] }, CONFIG_ABCD);
  check('end <= start is repaired to a one-hour slot',
    repaired.sessions[0]?.end === '09:30', repaired.sessions[0]?.end);
  const noEnd = validateTimetable({ sessions: [row({ end: undefined })] }, CONFIG_ABCD);
  check('a missing end is repaired, not dropped', noEnd.ok && noEnd.sessions[0]?.end === '09:30');

  const badKind = validateTimetable({ sessions: [row({ kind: 'lecture' })] }, CONFIG_ABCD);
  check('an unknown kind falls back to "other"', badKind.sessions[0]?.kind === 'other');

  const noTitle = validateTimetable({ sessions: [row({ title: '   ' })] }, CONFIG_ABCD);
  check('an empty title drops the row', !noTitle.ok && noTitle.dropped === 1);

  const many = validateTimetable(
    { sessions: Array.from({ length: MAX_TIMETABLE_SESSIONS + 25 }, () => row()) }, CONFIG_ABCD);
  check('truncates at the cap', many.sessions.length === MAX_TIMETABLE_SESSIONS);
  check('truncation is counted apart from drops',
    many.truncated === 25 && many.dropped === 0 && many.ok,
    `truncated=${many.truncated} dropped=${many.dropped}`);

  const labels = validateTimetable({ sessions: [row({ groups: ['E1', 'A1'] })] }, CONFIG_ABCD);
  check('dropped labels are surfaced for the editor',
    labels.droppedLabels.includes('E1') && labels.sessions[0].groups.join() === 'A1');

  check('every emitted session gets an id', mixed.sessions.every(s => !!s.id));
  check('ids are unique', new Set(mixed.sessions.map(s => s.id)).size === mixed.sessions.length);
  check('every emitted session is marked ai-sourced', mixed.sessions.every(s => s.source === 'ai'));

  const trimmed = validateTimetable({ sessions: [row({ title: '  Physiology   I  ' })] }, CONFIG_ABCD);
  check('title whitespace is collapsed', trimmed.sessions[0]?.title === 'Physiology I');
  const long = validateTimetable({ sessions: [row({ title: 'x'.repeat(400) })] }, CONFIG_ABCD);
  check('an absurd title is capped', long.sessions[0]?.title.length === 200);

  const extras = validateTimetable(
    { sessions: [row({ location: 'Hall 2', teacher: 'Dr. A' })] }, CONFIG_ABCD);
  check('location and teacher survive',
    extras.sessions[0]?.location === 'Hall 2' && extras.sessions[0]?.teacher === 'Dr. A');
  check('an absent location is omitted, not empty-stringed',
    !Object.prototype.hasOwnProperty.call(mixed.sessions[0], 'location'));
}

/* ------------------------------------------------------------------ *
 * 8. Reading it back — the fail-open rule
 * ------------------------------------------------------------------ */
console.log('\nsessionsForStudent');
{
  const theory = session({ id: 't', groups: [], kind: 'theory' });
  const mine = session({ id: 'm', groups: ['C1', 'C2'], kind: 'practical' });
  const theirs = session({ id: 'o', groups: ['A1'], kind: 'practical' });
  const unlabelled = session({ id: 'u', groups: [], kind: 'practical' });
  const all = [theory, mine, theirs, unlabelled];

  const forC2 = sessionsForStudent(all, 'C2').map(s => s.id);
  check('universal theory is visible', forC2.includes('t'));
  check('own subgroup practical is visible', forC2.includes('m'));
  check('another subgroup practical is hidden', !forC2.includes('o'));
  check('an UNLABELLED practical is visible to everyone (fail open)', forC2.includes('u'),
    'hiding it would cost a student the lab; showing it costs a glance');
  check('a lowercase stored group still matches',
    sessionsForStudent(all, 'c2').map(s => s.id).includes('m'));
  check('no group set sees everything', sessionsForStudent(all, null).length === 4);
  check('an unparseable group sees everything', sessionsForStudent(all, 'xx').length === 4);
  check('unlabelledPracticals badges exactly the one row',
    unlabelledPracticals(all).length === 1 && unlabelledPracticals(all)[0].id === 'u');
}

console.log('\ngroupSessionsByDay / overlaps');
{
  const a = session({ id: 'a', day: 1, start: '10:30', end: '12:30' });
  const b = session({ id: 'b', day: 1, start: '08:30', end: '10:30' });
  const c = session({ id: 'c', day: 0, start: '09:00', end: '10:00' });
  const grouped = groupSessionsByDay([a, b, c]);
  check('days are ordered from Sunday', grouped[0].day === 0 && grouped[1].day === 1);
  check('empty days are omitted', grouped.length === 2);
  check('sessions are ordered within a day',
    grouped[1].sessions.map(s => s.id).join() === 'b,a');

  check('abutting sessions do not overlap', overlappingSessions([a, b]).length === 0);
  const clash = session({ id: 'x', day: 1, start: '11:00', end: '12:00', groups: ['A1'] });
  check('a universal session clashes with a specific one',
    overlappingSessions([a, clash]).length === 1);
  const other = session({ id: 'y', day: 1, start: '11:00', end: '12:00', groups: ['B1'] });
  check('two disjoint audiences at one time do not clash',
    overlappingSessions([clash, other]).length === 0);
  check('audiencesIntersect treats [] as everyone',
    audiencesIntersect(session({ groups: [] }), session({ groups: ['A1'] })));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
