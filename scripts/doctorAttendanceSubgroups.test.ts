import assert from 'node:assert/strict';
import {
  getLectureDayName,
  formatLectureTime,
  isStudentInLectureAudience,
} from '../src/components/doctor/DoctorExcelTimetableView';
import type { LectureColumn, StudentAttendanceRow } from '../src/components/doctor/types';

console.log('Testing Doctor Attendance Subgroups & Timetable Helpers...');

// Test 1: getLectureDayName
{
  const lecWithDay: LectureColumn = {
    id: 'lec_1',
    number: 1,
    date: '2026-10-18',
    title: 'Pharmacology',
    mode: 'theoretical',
    day: 0, // Sunday
  };
  assert.equal(getLectureDayName(lecWithDay, true), 'الأحد');
  assert.equal(getLectureDayName(lecWithDay, false), 'Sun');

  const lecWithoutDay: LectureColumn = {
    id: 'lec_2',
    number: 2,
    date: '2026-10-19', // Monday
    title: 'Clinical Chemistry',
    mode: 'practical',
  };
  assert.equal(getLectureDayName(lecWithoutDay, true), 'الاثنين');
  assert.equal(getLectureDayName(lecWithoutDay, false), 'Mon');
}

// Test 2: formatLectureTime
{
  assert.equal(formatLectureTime('08:30', '10:30'), '08:30 - 10:30');
  assert.equal(formatLectureTime('08:30'), '08:30');
  assert.equal(formatLectureTime('', ''), '');
}

// Test 3: isStudentInLectureAudience
{
  // Universal lecture (empty audience = all stage attend)
  assert.equal(isStudentInLectureAudience('A1', []), true);
  assert.equal(isStudentInLectureAudience('B2', undefined), true);

  // Subgroup-specific practical lecture
  const audience = ['A1', 'A2'];
  assert.equal(isStudentInLectureAudience('A1', audience), true);
  assert.equal(isStudentInLectureAudience('A2', audience), true);
  assert.equal(isStudentInLectureAudience('B1', audience), false);
  assert.equal(isStudentInLectureAudience('', audience), false);
}

// Test 4: Dynamic Group and Subgroup extraction
{
  const mockStudents: StudentAttendanceRow[] = [
    { studentId: '1', name: 'Student 1', group: 'A1', examCode: '001', attendance: {} },
    { studentId: '2', name: 'Student 2', group: 'A2', examCode: '002', attendance: {} },
    { studentId: '3', name: 'Student 3', group: 'B1', examCode: '003', attendance: {} },
    { studentId: '4', name: 'Student 4', group: '', examCode: '004', attendance: {} },
  ];

  const groupsSet = new Set<string>();
  const subgroupsMap = new Map<string, Set<string>>();
  let unassigned = false;

  for (const s of mockStudents) {
    const sub = (s.group || '').trim();
    if (!sub) {
      unassigned = true;
      continue;
    }
    const match = sub.match(/^([A-Za-z]+)/);
    const mainGroup = match ? match[1].toUpperCase() : sub.charAt(0).toUpperCase();
    groupsSet.add(mainGroup);

    if (!subgroupsMap.has(mainGroup)) {
      subgroupsMap.set(mainGroup, new Set());
    }
    subgroupsMap.get(mainGroup)!.add(sub);
  }

  assert.deepEqual(Array.from(groupsSet).sort(), ['A', 'B']);
  assert.deepEqual(Array.from(subgroupsMap.get('A') || []).sort(), ['A1', 'A2']);
  assert.deepEqual(Array.from(subgroupsMap.get('B') || []).sort(), ['B1']);
  assert.equal(unassigned, true);
}

console.log('All Doctor Attendance Subgroups & Timetable tests passed successfully!');
