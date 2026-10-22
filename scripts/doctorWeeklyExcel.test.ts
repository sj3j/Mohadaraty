import assert from 'node:assert/strict';
import { 
  buildWeeklyColumns, 
  calculateStudentWeeklyCellInfo, 
  calculateStudentWeeklyStats,
  isStudentInLectureAudience 
} from '../src/components/doctor/DoctorExcelTimetableView';
import type { LectureColumn, StudentAttendanceRow } from '../src/components/doctor/types';

let failed = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL  ${name}`, error);
  }
};

console.log('--- Running Doctor Weekly Excel Tests ---');

// Mock occurrences across 2 weeks for 4 groups: A, B, C, D
// In Iraqi academic calendar, teaching week starts Saturday and ends Friday
// Week 1: Saturday 2026-09-19 to Friday 2026-09-25
// Week 2: Saturday 2026-09-26 to Friday 2026-10-02
const mockLectures: LectureColumn[] = [
  // Week 1
  {
    id: 'occ-w1-c',
    number: 1,
    date: '2026-09-19', // Saturday
    title: 'Clinical Pharmacy 1',
    mode: 'theoretical',
    time: '10:30',
    endTime: '12:30',
    day: 6,
    audienceGroups: ['C1', 'C2', 'C3', 'C4'],
  },
  {
    id: 'occ-w1-d',
    number: 2,
    date: '2026-09-20', // Sunday
    title: 'Clinical Pharmacy 1',
    mode: 'theoretical',
    time: '08:30',
    endTime: '10:30',
    day: 0,
    audienceGroups: ['D1', 'D2', 'D3', 'D4'],
  },
  {
    id: 'occ-w1-b',
    number: 3,
    date: '2026-09-20', // Sunday
    title: 'Clinical Pharmacy 1',
    mode: 'theoretical',
    time: '10:30',
    endTime: '12:30',
    day: 0,
    audienceGroups: ['B1', 'B2', 'B3', 'B4'],
  },
  {
    id: 'occ-w1-a',
    number: 4,
    date: '2026-09-20', // Sunday
    title: 'Clinical Pharmacy 1',
    mode: 'theoretical',
    time: '12:30',
    endTime: '14:30',
    day: 0,
    audienceGroups: ['A1', 'A2', 'A3', 'A4'],
  },

  // Week 2
  {
    id: 'occ-w2-c',
    number: 5,
    date: '2026-09-26', // Saturday
    title: 'Clinical Pharmacy 1',
    mode: 'theoretical',
    time: '10:30',
    endTime: '12:30',
    day: 6,
    audienceGroups: ['C1', 'C2', 'C3', 'C4'],
  },
  {
    id: 'occ-w2-d',
    number: 6,
    date: '2026-09-27', // Sunday
    title: 'Clinical Pharmacy 1',
    mode: 'theoretical',
    time: '08:30',
    endTime: '10:30',
    day: 0,
    audienceGroups: ['D1', 'D2', 'D3', 'D4'],
  },
  {
    id: 'occ-w2-b',
    number: 7,
    date: '2026-09-27', // Sunday
    title: 'Clinical Pharmacy 1',
    mode: 'theoretical',
    time: '10:30',
    endTime: '12:30',
    day: 0,
    audienceGroups: ['B1', 'B2', 'B3', 'B4'],
  },
  {
    id: 'occ-w2-a',
    number: 8,
    date: '2026-09-27', // Sunday
    title: 'Clinical Pharmacy 1',
    mode: 'theoretical',
    time: '12:30',
    endTime: '14:30',
    day: 0,
    audienceGroups: ['A1', 'A2', 'A3', 'A4'],
  },
];

test('buildWeeklyColumns correctly aggregates 8 raw occurrences into 2 weekly columns', () => {
  const weeklyColumns = buildWeeklyColumns(mockLectures, true);
  assert.equal(weeklyColumns.length, 2);
  assert.equal(weeklyColumns[0].titleAr, 'الأسبوع 1');
  assert.equal(weeklyColumns[0].weekNumber, 1);
  assert.equal(weeklyColumns[0].occurrences.length, 4);

  assert.equal(weeklyColumns[1].titleAr, 'الأسبوع 2');
  assert.equal(weeklyColumns[1].weekNumber, 2);
  assert.equal(weeklyColumns[1].occurrences.length, 4);
});

test('isStudentInLectureAudience handles exact and prefix matches', () => {
  assert.equal(isStudentInLectureAudience('A3', ['A1', 'A2', 'A3', 'A4']), true);
  assert.equal(isStudentInLectureAudience('A3', ['B1', 'B2', 'B3', 'B4']), false);
  assert.equal(isStudentInLectureAudience('A3', ['A']), true);
  assert.equal(isStudentInLectureAudience('A', ['A1', 'A2']), true);
  assert.equal(isStudentInLectureAudience('D2', ['D1', 'D2', 'D3', 'D4']), true);
});

test('calculateStudentWeeklyCellInfo detects native regular attendance', () => {
  const weeklyColumns = buildWeeklyColumns(mockLectures, true);
  const studentA: StudentAttendanceRow = {
    studentId: 'std-1',
    name: 'أبرار حمود',
    group: 'A3',
    examCode: '30001',
    attendance: {
      'occ-w1-a': 'present', // Attended native session for A
    },
  };

  const cellW1 = calculateStudentWeeklyCellInfo(studentA, weeklyColumns[0], true);
  assert.equal(cellW1.status, 'present');
  assert.equal(cellW1.isCompensation, false);
  assert.equal(cellW1.attendedDate, '2026-09-20');
  assert.equal(cellW1.attendedTime, '12:30');
});

test('calculateStudentWeeklyCellInfo detects compensation (تعويض) when student attends another group', () => {
  const weeklyColumns = buildWeeklyColumns(mockLectures, true);
  const studentA: StudentAttendanceRow = {
    studentId: 'std-1',
    name: 'أبرار حمود',
    group: 'A3',
    examCode: '30001',
    attendance: {
      // Missed group A's session, but attended group D's session instead!
      'occ-w1-d': 'present',
    },
  };

  const cellW1 = calculateStudentWeeklyCellInfo(studentA, weeklyColumns[0], true);
  assert.equal(cellW1.status, 'present');
  assert.equal(cellW1.isCompensation, true);
  assert.equal(cellW1.attendedDate, '2026-09-20');
  assert.equal(cellW1.attendedTime, '08:30');
  assert.match(cellW1.attendedGroup || '', /D/);
});

test('calculateStudentWeeklyCellInfo marks absent when scheduled session was absent', () => {
  const weeklyColumns = buildWeeklyColumns(mockLectures, true);
  const studentB: StudentAttendanceRow = {
    studentId: 'std-2',
    name: 'أحمد رعد',
    group: 'B1',
    examCode: '30004',
    attendance: {
      'occ-w1-b': 'absent',
    },
  };

  const cellW1 = calculateStudentWeeklyCellInfo(studentB, weeklyColumns[0], true);
  assert.equal(cellW1.status, 'absent');
  assert.equal(cellW1.isCompensation, false);
});

test('calculateStudentWeeklyStats computes present, compensation, absent and rates accurately', () => {
  const weeklyColumns = buildWeeklyColumns(mockLectures, true);
  const studentMixed: StudentAttendanceRow = {
    studentId: 'std-3',
    name: 'أحمد حسين',
    group: 'C3',
    examCode: '30003',
    attendance: {
      'occ-w1-a': 'present', // Week 1: attended group A (Compensation!)
      'occ-w2-c': 'present', // Week 2: attended group C (Regular!)
    },
  };

  const stats = calculateStudentWeeklyStats(studentMixed, weeklyColumns, true);
  assert.equal(stats.present, 2);
  assert.equal(stats.compensation, 1);
  assert.equal(stats.absent, 0);
  assert.equal(stats.attendanceRate, 100);
});

test('multi-session in single week splits into (م1) and (م2)', () => {
  const multiLectures: LectureColumn[] = [
    {
      id: 'occ-w1-a1',
      number: 1,
      date: '2026-09-20',
      title: 'Pathology',
      mode: 'theoretical',
      time: '08:30',
      audienceGroups: ['A1', 'A2'],
    },
    {
      id: 'occ-w1-a2',
      number: 2,
      date: '2026-09-22',
      title: 'Pathology',
      mode: 'theoretical',
      time: '10:30',
      audienceGroups: ['A1', 'A2'],
    },
  ];

  const columns = buildWeeklyColumns(multiLectures, true);
  assert.equal(columns.length, 2);
  assert.equal(columns[0].titleAr, 'الأسبوع 1 (م1)');
  assert.equal(columns[1].titleAr, 'الأسبوع 1 (م2)');
});

if (failed > 0) {
  console.error(`\n❌ ${failed} tests failed!`);
  process.exit(1);
} else {
  console.log('\n✅ All Doctor Weekly Excel tests passed successfully!');
}
