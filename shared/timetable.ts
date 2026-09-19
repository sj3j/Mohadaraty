/**
 * The parsed weekly timetable: types, the Gemini contract, and every pure
 * helper that turns a model's reading of a photographed grid into something
 * safe to show a student.
 *
 * Everything here is pure - no Firebase, no Gemini, no `src/` imports - which
 * is what lets `npm run test:timetable` run bare, with no emulator. The HTTP
 * side lives in shared/timetableApi.ts and the UI in src/components/timetable/.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 *
 * It never touches the `subjects` collection and no session type carries a
 * `subjectId`. The college timetable prints two subjects sharing one slot as
 * "Physiology I + Computer Science", and transcribing those lines verbatim into
 * `subjects` is the exact mistake CLAUDE.md's "the curriculum is not the
 * timetable" section exists to record - it took a reviewed split flow to undo.
 * A timetable cell stays a STRING here, forever. A field that does not exist
 * cannot be written by a later careless edit.
 */

import {
  FALLBACK_GROUP_CONFIG,
  isValidSubgroup,
  normalizeSubgroup,
  parseSubgroup,
  subgroupOptions,
  type GroupConfigLike,
} from './groups.js';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** 0 = Sunday .. 6 = Saturday, matching Date.getDay() exactly, so "is this
 *  today?" is `s.day === new Date().getDay()` with no offset table to get
 *  wrong. The Iraqi teaching week is Sunday..Thursday, i.e. 0..4. */
export type DayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type SessionKind = 'theory' | 'practical' | 'other';

export interface TimetableSession {
  /** Stable across edits: the React key, and what lets a re-parse diff against
   *  hand-corrected rows rather than replace them wholesale. */
  id: string;
  day: DayIndex;
  /** 24h "HH:MM", zero-padded. Chosen over minutes-since-midnight because it
   *  sorts lexicographically, is exactly what <input type="time"> emits and
   *  consumes, and is readable in the Firestore console during triage. */
  start: string;
  end: string;
  /** The cell's subject text VERBATIM, including a combined
   *  "Physiology I + Computer Science". Never split into `subjects`. */
  title: string;
  /** `title` split on "+" ONLY, present when that yields more than one part, so
   *  the agenda can draw two chips. Display only - see the module header. */
  titles?: string[];
  kind: SessionKind;
  /** WHO ATTENDS. `[]` means everyone in the stage; otherwise canonical
   *  subgroups ("A1", "C2"), never a bare group letter. See the note on
   *  normalizeParsedGroups for why `[]` rather than an expanded list. */
  groups: string[];
  location?: string;
  teacher?: string;
  note?: string;
  /** 'ai' until a human edits the row. Badges what was never reviewed. */
  source: 'ai' | 'human';
}

/** Shared by `timetableDrafts/{stageId}` and `timetables/{stageId}`. The two
 *  are separate documents on purpose - see the rules block in firestore.rules:
 *  the parse route writes only the draft, so a published week survives a failed
 *  re-parse by construction rather than by the failure handler being careful. */
export interface StageTimetableDoc {
  stageId: string;
  sessions: TimetableSession[];
  /** Which image these sessions came from. Compared against the live
   *  settings/weekly_schedule_{stageId}.photoUrl to warn staff that they are
   *  about to publish a week parsed from a superseded image. */
  sourcePhotoUrl?: string;
  weekLabel?: string;
  updatedAt?: any;
  updatedBy?: string;

  // Draft only.
  status?: 'parsing' | 'draft' | 'failed';
  startedAt?: any;
  parsedAt?: any;
  failureReason?: string;
  failureCount?: number;
  /** The image `failureCount` was accumulated against. Uploading a different
   *  one resets the retry cap, which is what its own error message promises. */
  failedPhotoUrl?: string;
  model?: string;
  /** Group labels the model read that this stage's groupConfig does not
   *  contain. Surfaced in the editor so a representative can tell a misread
   *  label from a real group missing out of their config. */
  droppedLabels?: string[];

  // Published only.
  publishedAt?: any;
  publishedBy?: string;
  version?: number;
}

/** Local extras on top of McqFailureReason (shared/mcqGeneration.ts), which
 *  classifyFailure() is imported from rather than copied. */
export type TimetableFailureReason =
  | 'no_image'
  | 'image_unreachable'
  | 'image_too_large'
  | 'invalid_response';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Hard cap on a parsed week. A real stage runs 30-60 sessions; anything past
 *  this is a misread grid duplicating rows, and the excess is truncated rather
 *  than stored. Enforced here because the response schema cannot carry it. */
export const MAX_TIMETABLE_SESSIONS = 200;

/** Smaller than MCQ's 20MB PDF cap: this is one photo, and a phone camera shot
 *  of a printed sheet is well under 8MB even before the model sees it. */
export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

/** What `fetch` may hand us as the image's content-type. Anything else is
 *  refused rather than guessed at - Gemini rejects an inlineData part whose
 *  mimeType does not match the bytes. */
export const ALLOWED_IMAGE_MIME = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
];

export const DAY_LABELS: { ar: string; en: string }[] = [
  { ar: 'الأحد', en: 'Sunday' },
  { ar: 'الاثنين', en: 'Monday' },
  { ar: 'الثلاثاء', en: 'Tuesday' },
  { ar: 'الأربعاء', en: 'Wednesday' },
  { ar: 'الخميس', en: 'Thursday' },
  { ar: 'الجمعة', en: 'Friday' },
  { ar: 'السبت', en: 'Saturday' },
];

/** The order days are shown in. Sunday..Thursday is the teaching week; Friday
 *  and Saturday trail it and are rendered only when something was parsed into
 *  them. Matching DayIndex means this is just 0..6. */
export const TEACHING_DAYS: DayIndex[] = [0, 1, 2, 3, 4];

/* ------------------------------------------------------------------ *
 * Digits, days and times
 * ------------------------------------------------------------------ */

/** Arabic-Indic (U+0660..) and extended/Persian (U+06F0..) digits to ASCII.
 *  A printed Iraqi timetable mixes both with ASCII freely, and every numeric
 *  parse below would otherwise fail on a perfectly legible cell. */
export function toAsciiDigits(raw: string): string {
  return (raw || '').replace(/[٠-٩۰-۹]/g, (d) => {
    const code = d.charCodeAt(0);
    const base = code >= 0x06F0 ? 0x06F0 : 0x0660;
    return String(code - base);
  });
}

const DAY_ALIASES: Record<string, DayIndex> = {
  sunday: 0, sun: 0, 'الاحد': 0, 'الأحد': 0, 'احد': 0, 'أحد': 0,
  monday: 1, mon: 1, 'الاثنين': 1, 'الأثنين': 1, 'الإثنين': 1, 'اثنين': 1, 'الاثنين ': 1,
  tuesday: 2, tue: 2, tues: 2, 'الثلاثاء': 2, 'ثلاثاء': 2,
  wednesday: 3, wed: 3, 'الاربعاء': 3, 'الأربعاء': 3, 'اربعاء': 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, 'الخميس': 4, 'خميس': 4,
  friday: 5, fri: 5, 'الجمعة': 5, 'الجمعه': 5, 'جمعة': 5,
  saturday: 6, sat: 6, 'السبت': 6, 'سبت': 6,
};

/** A day name in either script, or a stringified index, to DayIndex.
 *  Returns null for anything unrecognised - the caller drops that row rather
 *  than guessing, because a session filed under the wrong day is worse than a
 *  session that is missing and visibly so in the editor. */
export function normalizeDay(raw: unknown): DayIndex | null {
  if (typeof raw === 'number' && raw >= 0 && raw <= 6) return raw as DayIndex;
  const value = toAsciiDigits(String(raw == null ? '' : raw))
    .trim()
    .toLowerCase()
    // Arabic diacritics and the tatweel, which a scan can pick up.
    .replace(/[ً-ْـ]/g, '');
  if (!value) return null;
  if (/^[0-6]$/.test(value)) return Number(value) as DayIndex;
  if (Object.prototype.hasOwnProperty.call(DAY_ALIASES, value)) return DAY_ALIASES[value];
  // "day: thursday (week 5)" and similar - take the first alias that appears.
  for (const key of Object.keys(DAY_ALIASES)) {
    if (key.length >= 3 && value.includes(key)) return DAY_ALIASES[key];
  }
  return null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Any printed time to canonical 24h "HH:MM", or null.
 *
 * Handles "8:30", "08.30", "0830", "8", "1:15 pm", "١٠:٤٥", "١٢ م".
 *
 * THE AFTERNOON HEURISTIC, and its two guards. An hour of 1..5 with no meridiem
 * marker is read as afternoon ("2" -> "14:00", "1:30" -> "13:30"). The teaching
 * day runs 08:00-17:00, so a cell printing "2" means two in the afternoon;
 * reading it as 02:00 would sort the session to the top of the day and put it
 * hours from where it belongs.
 *
 *   - It stops at 5, matching what TIMETABLE_PROMPT tells the model. 6 and 7 are
 *     not plausible in either direction, so shifting them would invent an
 *     evening class rather than resolve an ambiguity.
 *   - A ZERO-PADDED hour is left alone: "07:00" is written in 24h convention and
 *     means seven in the morning, while a bare "7:00" is the ambiguous form.
 *     Without this guard an explicit "07:00" silently became 19:00.
 *
 * This is the single most likely source of a silently-wrong agenda in the whole
 * feature, which is why both guards are pinned in scripts/timetable.test.ts -
 * and why the editor shows every time in a native picker a human can correct.
 */
export function normalizeTime(raw: unknown): string | null {
  if (raw == null) return null;
  let value = toAsciiDigits(String(raw)).trim().toLowerCase();
  if (!value) return null;

  // Meridiem, in either script. `ص` (صباحاً) and `م` (مساءً) are only read when
  // they stand alone next to the digits, so a subject name never triggers one.
  let meridiem: 'am' | 'pm' | null = null;
  if (/\b(a\.?m\.?)\b/.test(value) || /(^|[\s\d])ص(\s|$)/.test(value)) meridiem = 'am';
  if (/\b(p\.?m\.?)\b/.test(value) || /(^|[\s\d])م(\s|$)/.test(value)) meridiem = 'pm';

  // Keep only the numeric skeleton: digits and the separator.
  value = value.replace(/[^\d:.]/g, '');
  if (!value) return null;

  let hour: number;
  let minute = 0;
  /** Was the hour written "07" rather than "7"? See the heuristic note above. */
  let padded = false;

  const sep = value.match(/^(\d{1,2})[:.](\d{1,2})$/);
  if (sep) {
    hour = Number(sep[1]);
    minute = Number(sep[2]);
    padded = sep[1].length === 2 && sep[1][0] === '0';
  } else if (/^\d{3,4}$/.test(value)) {
    // "0830" / "830"
    const head = value.slice(0, value.length - 2);
    hour = Number(head);
    minute = Number(value.slice(-2));
    padded = head.length === 2 && head[0] === '0';
  } else if (/^\d{1,2}$/.test(value)) {
    hour = Number(value);
    padded = value.length === 2 && value[0] === '0';
  } else {
    return null;
  }

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (minute < 0 || minute > 59) return null;

  if (meridiem === 'pm' && hour < 12) hour += 12;
  else if (meridiem === 'am' && hour === 12) hour = 0;
  else if (!meridiem && !padded && hour >= 1 && hour <= 5) hour += 12;

  if (hour < 0 || hour > 23) return null;
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** "13:45" -> 825. Returns -1 for anything that is not canonical, so a caller
 *  comparing two times never silently treats garbage as midnight. */
export function timeToMinutes(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return -1;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function minutesToTime(total: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(total)));
  return `${pad2(Math.floor(clamped / 60))}:${pad2(clamped % 60)}`;
}

/* ------------------------------------------------------------------ *
 * Titles
 * ------------------------------------------------------------------ */

/**
 * `'A + B'` -> `['A', 'B']`. A title with no `+` yields a single part.
 *
 * Mirrors splitSubjectName in src/lib/subjectSplit.ts, declared locally because
 * shared/ never imports from src/ (same arrangement as GroupConfigLike in
 * shared/groups.ts). ONLY `+` splits: `and` and `و` do not, because
 * "Pharmaceutical and Cosmetic Preparations" is one subject whose name happens
 * to read as a conjunction. Both halves of that rule are pinned by
 * scripts/timetable.test.ts, and separately by npm run test:subjects.
 *
 * This is presentation only. Nothing downstream turns a part into a subject.
 */
export function splitCombinedTitle(title: string): string[] {
  return (title || '').split('+').map(part => part.trim()).filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Groups
 * ------------------------------------------------------------------ */

const ARABIC_GROUP_LETTERS: Record<string, string> = {
  'ا': 'A', 'أ': 'A', 'إ': 'A', 'آ': 'A',
  'ب': 'B', 'ج': 'C', 'د': 'D', 'ه': 'E', 'هـ': 'E',
};

/** Everyone, however it is printed. Matched after the label is uppercased and
 *  stripped, so these are the canonical forms only. */
const UNIVERSAL_LABELS = ['ALL', '*', 'الكل', 'جميع', 'الجميع', 'كل الشعب', 'جميع الشعب', 'EVERYONE'];

function cleanGroupLabel(raw: unknown): string {
  let value = toAsciiDigits(String(raw == null ? '' : raw)).trim();
  value = value.replace(/[ً-ْـ]/g, '');      // diacritics, tatweel
  value = value.replace(/^(?:مجموعة|شعبة|قسم|group|grp|sec(?:tion)?)\s*/i, '');
  value = value.toUpperCase().trim();
  // A single Arabic group letter, alone or leading a number: "أ" / "أ1".
  value = value.replace(/^([ء-ي])(?=$|[\s\-/\d])/, (_m, ch) => ARABIC_GROUP_LETTERS[ch] || ch);
  // "A / 1", "A-1", "A 1" -> "A1". Ranges keep their dash (two digits around it).
  value = value.replace(/^([A-Z])\s*[/\s]\s*(\d+)$/, '$1$2');
  value = value.replace(/^([A-Z])-(\d+)$/, '$1$2');
  return value.trim();
}

const sortSubgroups = (list: string[]): string[] =>
  list.slice().sort((a, b) => {
    const pa = parseSubgroup(a);
    const pb = parseSubgroup(b);
    if (!pa || !pb) return a.localeCompare(b);
    return pa.group === pb.group ? pa.index - pb.index : pa.group.localeCompare(pb.group);
  });

/**
 * The model's group labels to canonical subgroups for THIS stage.
 *
 * Returns an object rather than a `{ok}|{err}` union: tsconfig.json sets no
 * strictNullChecks, so discriminated-union narrowing is unreliable here (the
 * same reason shared/mcqApi.ts:185 casts instead of narrowing).
 *
 * `[]` MEANS EVERYONE, and that is deliberately not the same as listing every
 * subgroup. Expanding a theory session to A1..D4 would freeze the group
 * structure at parse time: add a group E to stages/{id}.groupConfig next
 * semester and every theory session silently stops applying to E's students,
 * producing an EMPTY agenda - which reads as "no lectures this week", not as a
 * bug. `[]` has no such coupling.
 *
 * A label the stage's config does not contain is dropped, not kept: a session
 * addressed to a subgroup nobody is in is invisible either way, and `dropped`
 * is surfaced in the editor so the representative can see whether the model
 * misread the sheet or their groupConfig is missing a real group.
 */
export function normalizeParsedGroups(
  raw: unknown,
  _kind: string,
  config: GroupConfigLike,
): { groups: string[]; dropped: string[] } {
  const cfg = config && Array.isArray(config.groups) && config.groups.length
    ? config : FALLBACK_GROUP_CONFIG;

  // Not an array at all - the model emitted a bare string, or nothing. An
  // unreadable audience is shown to everyone rather than to nobody; see the
  // fail-open note on sessionsForStudent.
  if (!Array.isArray(raw)) return { groups: [], dropped: [] };

  const kept: string[] = [];
  const dropped: string[] = [];

  for (const entry of raw) {
    const label = cleanGroupLabel(entry);
    if (!label) continue;

    if (UNIVERSAL_LABELS.includes(label)) {
      // Everyone wins outright: one "الكل" among specific labels still means
      // the whole stage attends.
      return { groups: [], dropped: [] };
    }

    // A whole group: expand to its subgroups using THIS stage's config.
    if (/^[A-Z]$/.test(label)) {
      const group = cfg.groups.find(g => String(g.id).toUpperCase() === label);
      if (!group) { dropped.push(label); continue; }
      for (let i = 1; i <= group.subgroupCount; i++) kept.push(`${label}${i}`);
      continue;
    }

    // A range: "A1-A3", "A1-3".
    const range = /^([A-Z])(\d+)\s*[-–—]\s*([A-Z]?)(\d+)$/.exec(label);
    if (range) {
      const letter = range[1];
      const tail = range[3];
      if (tail && tail !== letter) { dropped.push(label); continue; }
      const from = Number(range[2]);
      const to = Number(range[4]);
      if (from > to) { dropped.push(label); continue; }
      let any = false;
      for (let i = from; i <= to; i++) {
        const candidate = `${letter}${i}`;
        if (isValidSubgroup(cfg, candidate)) { kept.push(candidate); any = true; }
      }
      if (!any) dropped.push(label);
      continue;
    }

    // A single subgroup.
    const single = normalizeSubgroup(label);
    if (single && isValidSubgroup(cfg, single)) kept.push(single);
    else dropped.push(label);
  }

  const unique = sortSubgroups(Array.from(new Set(kept)));

  // Full-cover collapse. A theory row printed "A, B, C, D" names the whole
  // stage, and storing it as the universal `[]` is what keeps it correct when
  // the group structure changes later. Applied to practicals too: one that
  // genuinely covers every subgroup IS universal.
  const everything = sortSubgroups(subgroupOptions(cfg));
  if (unique.length === everything.length && unique.join(',') === everything.join(',')) {
    return { groups: [], dropped: Array.from(new Set(dropped)) };
  }

  return { groups: unique, dropped: Array.from(new Set(dropped)) };
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

const KINDS: SessionKind[] = ['theory', 'practical', 'other'];

let idCounter = 0;
/** Ids are ours, never the model's - the same rule the MCQ pipeline applies to
 *  question ids. A model-supplied id could collide or carry an injection. */
export function mintSessionId(day: number, start: string): string {
  idCounter = (idCounter + 1) % 100000;
  return `s_${day}_${(start || '').replace(':', '')}_${Date.now().toString(36)}_${idCounter}`;
}

export interface TimetableValidation {
  ok: boolean;
  sessions: TimetableSession[];
  /** Rows that could not be repaired into a session. */
  dropped: number;
  /** Rows discarded for exceeding MAX_TIMETABLE_SESSIONS, kept separate from
   *  `dropped` so truncating a huge parse cannot trip the half-dropped check. */
  truncated: number;
  droppedLabels: string[];
  reason?: string;
}

/**
 * The model's JSON to sessions we are willing to store.
 *
 * Repairs or drops PER ROW, never discarding a whole parse because one cell was
 * unreadable - a 40-session week with two bad rows is still worth reviewing.
 *
 * This is also where the counts live that TIMETABLE_RESPONSE_SCHEMA deliberately
 * cannot carry: minItems/maxItems in a schema this deeply nested makes Gemini
 * reject every call with 400 INVALID_ARGUMENT before reading any input (see the
 * schema comment below, and PITFALLS.md).
 */
export function validateTimetable(parsed: any, config: GroupConfigLike): TimetableValidation {
  const rowsRaw = parsed && Array.isArray(parsed.sessions) ? parsed.sessions : null;
  if (!rowsRaw) {
    return { ok: false, sessions: [], dropped: 0, truncated: 0, droppedLabels: [], reason: 'no sessions array' };
  }

  // Truncate BEFORE validating, so the excess is not counted as failed rows.
  const rows = rowsRaw.slice(0, MAX_TIMETABLE_SESSIONS);
  const truncated = rowsRaw.length - rows.length;

  const sessions: TimetableSession[] = [];
  const droppedLabels = new Set<string>();
  let dropped = 0;

  for (const row of rows) {
    if (!row || typeof row !== 'object') { dropped++; continue; }

    const day = normalizeDay(row.day);
    if (day === null) { dropped++; continue; }

    const start = normalizeTime(row.start);
    if (!start) { dropped++; continue; }

    const title = String(row.title == null ? '' : row.title)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    if (!title) { dropped++; continue; }

    // An end that is missing, unparseable or not after the start is repaired to
    // a one-hour slot rather than dropping an otherwise good session.
    let end = normalizeTime(row.end);
    if (!end || timeToMinutes(end) <= timeToMinutes(start)) {
      end = minutesToTime(timeToMinutes(start) + 60);
    }

    const kind: SessionKind = KINDS.includes(row.kind) ? row.kind : 'other';
    const { groups, dropped: bad } = normalizeParsedGroups(row.groups, kind, config);
    bad.forEach(label => droppedLabels.add(label));

    const parts = splitCombinedTitle(title);

    const session: TimetableSession = {
      id: mintSessionId(day, start),
      day,
      start,
      end,
      title,
      kind,
      groups,
      source: 'ai',
    };
    if (parts.length > 1) session.titles = parts;

    const location = String(row.location == null ? '' : row.location).trim().slice(0, 120);
    if (location) session.location = location;
    const teacher = String(row.teacher == null ? '' : row.teacher).trim().slice(0, 120);
    if (teacher) session.teacher = teacher;

    sessions.push(session);
  }

  const labels = Array.from(droppedLabels);

  if (!sessions.length) {
    return { ok: false, sessions, dropped, truncated, droppedLabels: labels, reason: 'no readable sessions' };
  }
  // More than half the sheet unreadable is a mis-read grid, not a few bad
  // cells. Failing loudly beats handing a representative a hollowed-out week
  // that looks plausible until a student notices their lab is missing.
  if (dropped > sessions.length) {
    return {
      ok: false, sessions, dropped, truncated, droppedLabels: labels,
      reason: `dropped ${dropped} of ${dropped + sessions.length} rows`,
    };
  }

  return { ok: true, sessions, dropped, truncated, droppedLabels: labels };
}

/* ------------------------------------------------------------------ *
 * Reading a timetable
 * ------------------------------------------------------------------ */

/**
 * The sessions one student should see.
 *
 * FAIL OPEN, deliberately. A session with an empty `groups` is shown to
 * everyone, and that covers two different cases: a genuine stage-wide lecture,
 * and a practical whose group label the model could not read. Showing one lab
 * too many costs a student a glance; hiding the one lab that was theirs costs
 * them the lab. The editor badges the second case in amber so a human fixes it,
 * but until they do, students see it.
 *
 * A student with no `group` set sees everything, for the same reason.
 */
export function sessionsForStudent(
  sessions: TimetableSession[],
  subgroup?: string | null,
): TimetableSession[] {
  const list = Array.isArray(sessions) ? sessions : [];
  const mine = normalizeSubgroup(subgroup);
  if (!mine) return list.slice();
  return list.filter(s => !s.groups || s.groups.length === 0 || s.groups.includes(mine));
}

/** Sessions bucketed by day and ordered within it, ready to render. Days with
 *  nothing in them are omitted; the teaching week leads, Fri/Sat trail. */
export function groupSessionsByDay(
  sessions: TimetableSession[],
): { day: DayIndex; sessions: TimetableSession[] }[] {
  const buckets = new Map<DayIndex, TimetableSession[]>();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!buckets.has(s.day)) buckets.set(s.day, []);
    buckets.get(s.day)!.push(s);
  }
  const order: DayIndex[] = [0, 1, 2, 3, 4, 5, 6];
  return order
    .filter(d => buckets.has(d))
    .map(day => ({
      day,
      sessions: buckets.get(day)!.slice().sort((a, b) =>
        timeToMinutes(a.start) - timeToMinutes(b.start) || a.title.localeCompare(b.title)),
    }));
}

/** Do two sessions address any student in common? `[]` is everyone, so it
 *  intersects with everything including another `[]`. */
export function audiencesIntersect(a: TimetableSession, b: TimetableSession): boolean {
  if (!a.groups?.length || !b.groups?.length) return true;
  return a.groups.some(g => b.groups.includes(g));
}

/**
 * Pairs of sessions one student would have to attend at once. Drives the
 * editor's amber overlap badge - a real timetable has none, so a pair here is
 * either a misparse or a genuine clash the representative needs to see.
 */
export function overlappingSessions(sessions: TimetableSession[]): [string, string][] {
  const clashes: [string, string][] = [];
  const byDay = groupSessionsByDay(sessions);
  for (const { sessions: day } of byDay) {
    for (let i = 0; i < day.length; i++) {
      for (let j = i + 1; j < day.length; j++) {
        const a = day[i];
        const b = day[j];
        if (timeToMinutes(b.start) >= timeToMinutes(a.end)) continue;  // sorted: no later pair can overlap a
        if (audiencesIntersect(a, b)) clashes.push([a.id, b.id]);
      }
    }
  }
  return clashes;
}

/** A practical nobody was assigned to. Shown to everyone (see
 *  sessionsForStudent) but badged in the editor, because it is the one shape
 *  the parse gets wrong that looks completely normal on screen. */
export function unlabelledPracticals(sessions: TimetableSession[]): TimetableSession[] {
  return (Array.isArray(sessions) ? sessions : [])
    .filter(s => s.kind === 'practical' && (!s.groups || s.groups.length === 0));
}

/* ------------------------------------------------------------------ *
 * The Gemini contract
 * ------------------------------------------------------------------ */

/**
 * NO minItems/maxItems ANYWHERE IN HERE, and none may be added.
 *
 * This schema is array-of-objects-containing-arrays - `sessions[] -> object ->
 * groups[]` - which is the exact nesting that made Gemini answer EVERY MCQ
 * generate call with 400 INVALID_ARGUMENT before reading a byte of input
 * (shared/mcqGeneration.ts, PITFALLS.md "Gemini / external LLM API quirks").
 * The bounds are accepted on a shallower schema, which is what makes them look
 * innocent here. Counts are asked for in the prompt and enforced by
 * validateTimetable(); scripts/timetable.test.ts fails if either key reappears.
 *
 * `day` is a named enum rather than an integer on purpose: it takes "is 0
 * Sunday or Monday?" out of the model's job entirely, and enums are the one
 * constraint this schema shape honours reliably. normalizeDay maps it back.
 */
export const TIMETABLE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    weekLabel: { type: 'string' },
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          day: {
            type: 'string',
            enum: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
          },
          start: { type: 'string' },
          end: { type: 'string' },
          title: { type: 'string' },
          kind: { type: 'string', enum: ['theory', 'practical', 'other'] },
          groups: { type: 'array', items: { type: 'string' } },
          location: { type: 'string' },
          teacher: { type: 'string' },
        },
        required: ['day', 'start', 'end', 'title', 'kind', 'groups'],
      },
    },
  },
  required: ['sessions'],
} as const;

/**
 * Kept server-side, like MCQ's prompts and for the same reason: a route that
 * forwards a caller-supplied prompt to Gemini on our key is an open-ended text
 * generator wearing a timetable costume.
 */
export const TIMETABLE_PROMPT = `You are reading a photograph or scan of a college weekly
timetable (جدول المحاضرات الأسبوعي) for ONE academic stage of a pharmacy college in Iraq.
The sheet mixes Arabic and English, often inside the same cell. Transcribe it into structured
sessions. Do not summarise, do not translate, do not correct what is printed, and do not invent
a session that is not on the sheet.

1. DAYS. Column or row headers name days in Arabic or English: الأحد/Sunday, الاثنين or
   الإثنين/Monday, الثلاثاء/Tuesday, الأربعاء/Wednesday, الخميس/Thursday, الجمعة/Friday,
   السبت/Saturday. Emit the lowercase English name in "day". If you cannot tell which day a
   cell belongs to, skip that cell rather than guessing.

2. TIMES. "start" and "end" MUST be 24-hour "HH:MM" with a leading zero: "08:30", "13:00".
   Convert Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) to ASCII first. The teaching day runs roughly
   08:00-17:00, so an hour printed as 1, 2, 3, 4 or 5 with no AM/PM marker is the afternoon:
   emit "13:00", "14:00", "15:00", "16:00", "17:00". If a cell shows only one time, treat it
   as the start and set "end" one hour later.

3. TITLE. Copy the subject text of the cell VERBATIM, in the script it is printed in. If two
   subjects share the slot, the sheet prints them joined by "+", for example
   "Physiology I + Computer Science" - keep that exactly, as ONE title. Never split it, never
   expand an abbreviation, and never substitute a subject name you believe is the correct one.
   Remove ONLY the group label, the room and the words نظري / عملي, which have their own fields.

4. KIND. "theory"    for نظري, theoretical, محاضرة نظرية.
         "practical" for عملي, practical, lab, مختبر.
         "other"     for anything else: استراحة, امتحان, seminar, a free slot.
   If a cell names no type but carries a group label, it is "practical".
   If it names no type and carries no group label, it is "theory".

5. GROUPS - who attends. List the labels EXACTLY as printed. Do NOT expand them:
     a whole group          -> ["A"]         (printed A, أ, Group A, مجموعة A)
     one subgroup           -> ["A1"]        (printed A1, A-1, A/1, أ١)
     several                -> ["A1","A2"] or ["A","B"]
     a range printed A1-A3  -> ["A1","A2","A3"]
     the whole stage, or no label at all, or الكل / جميع الشعب / All -> []  (empty array)
   Emit [] rather than guessing. The server expands a bare letter into its subgroups using
   this stage's own configuration - that is not your job.

6. MERGED CELLS. A cell spanning several DAY columns is one session repeated: emit one object
   per day it covers. A cell spanning several TIME rows is one session: use the full spanned
   range for "start" and "end". A cell spanning several GROUP columns is one object whose
   "groups" lists all of them.

7. LOCATION / TEACHER. Put a hall, lab or teacher name in "location" / "teacher". Omit the
   field when the cell prints none. Never fold either into "title".

8. Emit EVERY teaching cell on the sheet. Skip empty cells, break rows, and the header rows
   themselves. If the sheet prints a week label (الأسبوع الخامس, or a week-beginning date),
   put it in "weekLabel".`;
