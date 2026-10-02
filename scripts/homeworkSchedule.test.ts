/**
 * Unit tests for Homework Scheduling Engine (Dual-mode, Saturday-anchored).
 * Run with: npx tsx scripts/homeworkSchedule.test.ts
 */

import {
  dayOffsetFromSaturday,
  getSaturdayOfWeek,
  formatDateIso,
  parseDateIso,
  getUpcomingWeeks,
  normalizeText,
  matchTimetableSessions,
  computeGroupDeadlines,
  resolveStudentDeadline,
  sanitizeForFirestore,
} from '../src/lib/homeworkSchedule';
import type { TimetableSession } from '../shared/timetable';
import type { Homework } from '../src/types';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
    failed++;
  }
}

console.log('--- 1. Day Offsets from Saturday ---');
{
  check('Saturday (6) offset is 0', dayOffsetFromSaturday(6) === 0);
  check('Sunday (0) offset is 1', dayOffsetFromSaturday(0) === 1);
  check('Monday (1) offset is 2', dayOffsetFromSaturday(1) === 2);
  check('Tuesday (2) offset is 3', dayOffsetFromSaturday(2) === 3);
  check('Wednesday (3) offset is 4', dayOffsetFromSaturday(3) === 4);
  check('Thursday (4) offset is 5', dayOffsetFromSaturday(4) === 5);
  check('Friday (5) offset is 6', dayOffsetFromSaturday(5) === 6);
}

console.log('\n--- 2. Saturday Week Anchoring ---');
{
  // 2025-10-11 is a Saturday
  const sat = new Date(2025, 9, 11); // Oct 11, 2025
  const sun = new Date(2025, 9, 12); // Oct 12, 2025
  const wed = new Date(2025, 9, 15); // Oct 15, 2025
  const fri = new Date(2025, 9, 17); // Oct 17, 2025
  const nextSat = new Date(2025, 9, 18); // Oct 18, 2025

  check('Saturday resolves to itself', formatDateIso(getSaturdayOfWeek(sat)) === '2025-10-11');
  check('Sunday resolves to preceding Saturday', formatDateIso(getSaturdayOfWeek(sun)) === '2025-10-11');
  check('Wednesday resolves to preceding Saturday', formatDateIso(getSaturdayOfWeek(wed)) === '2025-10-11');
  check('Friday resolves to preceding Saturday', formatDateIso(getSaturdayOfWeek(fri)) === '2025-10-11');
  check('Next Saturday starts a new week', formatDateIso(getSaturdayOfWeek(nextSat)) === '2025-10-18');
}

console.log('\n--- 3. Upcoming Weeks Generator ---');
{
  const refDate = new Date(2025, 9, 14); // Tuesday Oct 14, 2025
  const weeks = getUpcomingWeeks(4, refDate);

  check('Generates 4 weeks', weeks.length === 4);
  check('First week starts on Saturday Oct 11', weeks[0].saturdayDate === '2025-10-11');
  check('First week ends on Friday Oct 17', weeks[0].endDate === '2025-10-17');
  check('Second week starts on Saturday Oct 18', weeks[1].saturdayDate === '2025-10-18');
  check('First week label is Arabic "الأسبوع الحالي"', weeks[0].labelAr === 'الأسبوع الحالي');
}

console.log('\n--- 4. Timetable Session Matching ---');
{
  const mockSessions: TimetableSession[] = [
    {
      id: 's1',
      day: 1, // Monday
      start: '08:30',
      end: '10:30',
      title: 'الكيمياء الصيدلانية عملي',
      kind: 'practical',
      groups: ['A1', 'A2'],
      source: 'human',
    },
    {
      id: 's2',
      day: 3, // Wednesday
      start: '10:30',
      end: '12:30',
      title: 'الكيمياء الصيدلانية عملي',
      kind: 'practical',
      groups: ['B1', 'B2'],
      source: 'human',
    },
    {
      id: 's3',
      day: 0, // Sunday
      start: '09:00',
      end: '11:00',
      title: 'الكيمياء الصيدلانية',
      kind: 'theory',
      groups: [],
      source: 'human',
    },
    {
      id: 's4',
      day: 2, // Tuesday
      start: '08:30',
      end: '10:30',
      title: 'Pharmacology Lab',
      kind: 'practical',
      groups: ['A1'],
      source: 'human',
    },
  ];

  const matchedPractical = matchTimetableSessions(
    mockSessions,
    'pharmaceutical_chemistry',
    'كيمياء صيدلانية',
    'Pharmaceutical Chemistry',
    'practical'
  );
  check('Matches 2 practical sessions for chemistry', matchedPractical.length === 2);
  check('Includes session with groups A1, A2', matchedPractical.some(s => s.groups.includes('A1')));
  check('Includes session with groups B1, B2', matchedPractical.some(s => s.groups.includes('B1')));

  const matchedTheory = matchTimetableSessions(
    mockSessions,
    'pharmaceutical_chemistry',
    'كيمياء صيدلانية',
    'Pharmaceutical Chemistry',
    'theoretical'
  );
  check('Matches 1 theoretical session', matchedTheory.length === 1);
  check('Theory session has title "الكيمياء الصيدلانية"', matchedTheory[0].title === 'الكيمياء الصيدلانية');
}

console.log('\n--- 5. Group Deadlines Computation ---');
{
  const saturdayStr = '2025-10-11';
  const mockSessions: TimetableSession[] = [
    {
      id: 's1',
      day: 1, // Monday (Offset 2 from Sat Oct 11 -> Oct 13)
      start: '08:30',
      end: '10:30',
      title: 'الكيمياء الصيدلانية عملي',
      kind: 'practical',
      groups: ['A1', 'A2'],
      source: 'human',
    },
    {
      id: 's2',
      day: 3, // Wednesday (Offset 4 from Sat Oct 11 -> Oct 15)
      start: '10:30',
      end: '12:30',
      title: 'الكيمياء الصيدلانية عملي',
      kind: 'practical',
      groups: ['B1', 'B2'],
      source: 'human',
    },
  ];

  const comp = computeGroupDeadlines(mockSessions, saturdayStr);

  check('Computed deadlines for 4 subgroups', comp.totalGroups === 4);
  check('Group A1 is scheduled', comp.groupDeadlines['A1'] !== undefined);
  check('Group A1 day is Monday ("الاثنين")', comp.groupDeadlines['A1'].dayNameAr === 'الاثنين');
  check('Group A1 time is 08:30', comp.groupDeadlines['A1'].time === '08:30');

  const a1Date = new Date(comp.groupDeadlines['A1'].dueDate);
  check('Group A1 date is Oct 13, 2025 at 08:30',
    a1Date.getFullYear() === 2025 &&
    a1Date.getMonth() === 9 &&
    a1Date.getDate() === 13 &&
    a1Date.getHours() === 8 &&
    a1Date.getMinutes() === 30
  );

  const b1Date = new Date(comp.groupDeadlines['B1'].dueDate);
  check('Group B1 date is Oct 15, 2025 at 10:30',
    b1Date.getFullYear() === 2025 &&
    b1Date.getMonth() === 9 &&
    b1Date.getDate() === 15 &&
    b1Date.getHours() === 10 &&
    b1Date.getMinutes() === 30
  );

  check('Earliest date matches A1 date', comp.earliestDate?.getTime() === a1Date.getTime());
  check('Latest date matches B1 date', comp.latestDate?.getTime() === b1Date.getTime());
}

console.log('\n--- 6. Student Deadline Resolution ---');
{
  const mockHomework: Homework = {
    id: 'hw1',
    subject: 'pharmaceutical_chemistry',
    type: 'practical',
    lectures: [],
    createdAt: new Date(),
    dueDate: new Date(2025, 9, 13, 8, 30),
    earliestDeadline: new Date(2025, 9, 13, 8, 30),
    latestDeadline: new Date(2025, 9, 15, 10, 30),
    deadlineMode: 'timetable',
    targetWeekStart: '2025-10-11',
    groupDeadlines: {
      A1: {
        group: 'A1',
        dueDate: new Date(2025, 9, 13, 8, 30),
        dayNameAr: 'الاثنين',
        dayNameEn: 'Monday',
        time: '08:30',
      },
      B1: {
        group: 'B1',
        dueDate: new Date(2025, 9, 15, 10, 30),
        dayNameAr: 'الأربعاء',
        dayNameEn: 'Wednesday',
        time: '10:30',
      },
    },
  };

  // Student in group A1
  const resA1 = resolveStudentDeadline(mockHomework, 'A1');
  check('Student in A1 gets group-specific deadline', resA1.isGroupSpecific === true);
  check('Student in A1 time is 08:30', resA1.time === '08:30');
  check('Student in A1 day is Monday', resA1.dayNameAr === 'الاثنين');

  // Student in group B1
  const resB1 = resolveStudentDeadline(mockHomework, 'B1');
  check('Student in B1 gets Wednesday 10:30', resB1.isGroupSpecific === true && resB1.time === '10:30');

  // Student with no group
  const resNoGroup = resolveStudentDeadline(mockHomework, null);
  check('Student with no group is not group-specific', resNoGroup.isGroupSpecific === false);
  check('Student with no group fallbackReason is "no_group"', resNoGroup.fallbackReason === 'no_group');
  check('Student with no group gets earliest deadline (Oct 13 08:30)',
    resNoGroup.effectiveDate?.getTime() === new Date(2025, 9, 13, 8, 30).getTime()
  );

  // Student in group C1 (not scheduled)
  const resUnscheduled = resolveStudentDeadline(mockHomework, 'C1');
  check('Unscheduled student gets earliest deadline', resUnscheduled.isGroupSpecific === false);
  check('Unscheduled student fallbackReason is "group_not_scheduled"', resUnscheduled.fallbackReason === 'group_not_scheduled');

  // Fixed homework
  const fixedHw: Homework = {
    id: 'hw2',
    subject: 'pharmacology',
    type: 'theoretical',
    lectures: [],
    createdAt: new Date(),
    dueDate: new Date(2025, 9, 20, 23, 59),
    deadlineMode: 'fixed',
  };
  const resFixed = resolveStudentDeadline(fixedHw, 'A1');
  check('Fixed homework resolves to dueDate', resFixed.effectiveDate?.getTime() === new Date(2025, 9, 20, 23, 59).getTime());
  check('Fixed homework is not group-specific', resFixed.isGroupSpecific === false);
}

console.log('\n--- 7. Firestore Sanitizer ---');
{
  class MockFieldValue {
    _methodName = 'FieldValue.delete';
  }

  const raw = {
    subject: 'pharmacology',
    note: null,
    targetWeekStart: undefined,
    fieldVal: new MockFieldValue(),
    date: new Date(2025, 9, 13),
    groupDeadlines: {
      A1: {
        group: 'A1',
        time: '08:30',
        location: undefined,
        sessionTitle: undefined,
      },
      A2: {
        group: 'A2',
        time: '10:30',
        location: 'Hall B',
      },
    },
    list: [1, undefined, 3],
  };

  const cleaned: any = sanitizeForFirestore(raw);

  check('Preserves valid primitive fields', cleaned.subject === 'pharmacology');
  check('Preserves null fields', cleaned.note === null);
  check('Strips top-level undefined fields', !('targetWeekStart' in cleaned));
  check('Preserves custom FieldValue instances', cleaned.fieldVal instanceof MockFieldValue && cleaned.fieldVal._methodName === 'FieldValue.delete');
  check('Preserves Date instances', cleaned.date instanceof Date && cleaned.date.getTime() === raw.date.getTime());
  check('Strips nested undefined fields (location)', !('location' in cleaned.groupDeadlines.A1));
  check('Strips nested undefined fields (sessionTitle)', !('sessionTitle' in cleaned.groupDeadlines.A1));
  check('Preserves nested valid fields', cleaned.groupDeadlines.A2.location === 'Hall B');
  check('Cleans undefined in arrays', Array.isArray(cleaned.list) && cleaned.list.length === 2 && cleaned.list[0] === 1 && cleaned.list[1] === 3);
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
