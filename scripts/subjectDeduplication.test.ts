import assert from 'node:assert/strict';
import {
  normalizeCanonicalSubjectTitle,
  cleanDisplaySubjectName,
  formatSubjectDoctor,
  buildCanonicalSubjects,
  type SubjectItem,
} from '../src/components/simosan/StudentSimosanView';
import type { StudentAttendanceRow } from '../shared/attendanceSchedule';
import type { AttendanceMine } from '../shared/attendance';

console.log('Testing Subject Deduplication and Attendance Aggregation...');

// -------------------------------------------------------------
// 1. Title Normalization & Suffix Cleaning
// -------------------------------------------------------------
{
  // Basic Arabic normalization
  assert.equal(normalizeCanonicalSubjectTitle('الكيمياء العضوية'), 'الكيمياء العضويه');
  assert.equal(normalizeCanonicalSubjectTitle('الكيمياء العضوية (نظري)'), 'الكيمياء العضويه');
  assert.equal(normalizeCanonicalSubjectTitle('الكيمياء العضوية - عملي'), 'الكيمياء العضويه');
  assert.equal(normalizeCanonicalSubjectTitle('الكيمياء العضوية عملي'), 'الكيمياء العضويه');
  assert.equal(normalizeCanonicalSubjectTitle('الكيمياء العضوية (مختبر)'), 'الكيمياء العضويه');

  // English normalization
  assert.equal(normalizeCanonicalSubjectTitle('Organic Chemistry'), 'organic chemistry');
  assert.equal(normalizeCanonicalSubjectTitle('Organic Chemistry (Theory)'), 'organic chemistry');
  assert.equal(normalizeCanonicalSubjectTitle('Organic Chemistry - Practical'), 'organic chemistry');
  assert.equal(normalizeCanonicalSubjectTitle('Organic Chemistry Lab'), 'organic chemistry');

  // Level numbers & Roman / Arabic numerals
  assert.equal(normalizeCanonicalSubjectTitle('الكيمياء العضوية 2'), 'الكيمياء العضويه 2');
  assert.equal(normalizeCanonicalSubjectTitle('الكيمياء العضوية ٢'), 'الكيمياء العضويه 2');
  assert.equal(normalizeCanonicalSubjectTitle('Organic Chemistry II'), 'organic chemistry 2');
  assert.equal(normalizeCanonicalSubjectTitle('Organic Chemistry - Lab II'), 'organic chemistry 2');

  // Distinct levels must NOT collide
  assert.notEqual(
    normalizeCanonicalSubjectTitle('Organic Chemistry I'),
    normalizeCanonicalSubjectTitle('Organic Chemistry II')
  );
  assert.notEqual(
    normalizeCanonicalSubjectTitle('الكيمياء العضوية ١'),
    normalizeCanonicalSubjectTitle('الكيمياء العضوية ٢')
  );

  console.log('✔ normalizeCanonicalSubjectTitle tests passed');
}

// -------------------------------------------------------------
// 2. Clean Display Subject Name
// -------------------------------------------------------------
{
  assert.equal(cleanDisplaySubjectName('الكيمياء العضوية (نظري)'), 'الكيمياء العضوية');
  assert.equal(cleanDisplaySubjectName('الكيمياء العضوية - عملي'), 'الكيمياء العضوية');
  assert.equal(cleanDisplaySubjectName('Organic Chemistry (Theory)'), 'Organic Chemistry');
  assert.equal(cleanDisplaySubjectName('Organic Chemistry - Lab'), 'Organic Chemistry');
  assert.equal(cleanDisplaySubjectName('الكيمياء الصيدلانية'), 'الكيمياء الصيدلانية');

  console.log('✔ cleanDisplaySubjectName tests passed');
}

// -------------------------------------------------------------
// 3. Format Subject Doctor (Context-Aware Multi-Doctor)
// -------------------------------------------------------------
{
  // Two different doctors
  assert.equal(
    formatSubjectDoctor('د. أحمد', 'د. سارة', true),
    'د. أحمد (نظري) • د. سارة (عملي)'
  );
  assert.equal(
    formatSubjectDoctor('Dr. Ahmad', 'Dr. Sarah', false),
    'Dr. Ahmad (Theory) • Dr. Sarah (Lab)'
  );

  // Single doctor for both
  assert.equal(formatSubjectDoctor('د. أحمد', 'د. أحمد', true), 'د. أحمد');

  // Doctor only known for theory or practical
  assert.equal(formatSubjectDoctor('د. أحمد', '', true), 'د. أحمد');
  assert.equal(formatSubjectDoctor('', 'د. سارة', true), 'د. سارة');
  assert.equal(formatSubjectDoctor('', '', true), '');

  console.log('✔ formatSubjectDoctor tests passed');
}

// -------------------------------------------------------------
// 4. Merge Duplicate Subjects (The Core User Issue)
// -------------------------------------------------------------
{
  // Student rows having:
  // - Organic chemistry theory (taught by Dr. Ahmad)
  // - Organic chemistry lab (taught by Dr. Sarah)
  // - Second organic chemistry theory lecture in the same week (taught by Dr. Ahmad)
  const rows: StudentAttendanceRow[] = [
    {
      weekStart: '2026-10-18',
      state: 'confirmed',
      occurrence: {
        id: 'occ_theory_1',
        stageId: 'stage_2',
        lectureDate: '2026-10-18',
        startTime: '08:30',
        endTime: '10:30',
        title: 'الكيمياء العضوية',
        timetableSessionId: 'slot_theory_sun',
        teacher: 'د. أحمد',
        mode: 'theory',
      },
    },
    {
      weekStart: '2026-10-18',
      state: 'none',
      occurrence: {
        id: 'occ_lab_1',
        stageId: 'stage_2',
        lectureDate: '2026-10-20',
        startTime: '10:30',
        endTime: '12:30',
        title: 'الكيمياء العضوية عملي',
        timetableSessionId: 'slot_lab_tue',
        teacher: 'د. سارة',
        mode: 'practical',
      },
    },
    {
      weekStart: '2026-10-18',
      state: 'absent',
      occurrence: {
        id: 'occ_theory_2',
        stageId: 'stage_2',
        lectureDate: '2026-10-22',
        startTime: '08:30',
        endTime: '10:30',
        title: 'الكيمياء العضوية',
        timetableSessionId: 'slot_theory_thu',
        teacher: 'د. أحمد',
        mode: 'theory',
      },
    },
  ];

  const mine: AttendanceMine = {
    term: {
      id: 'term_1',
      name: 'Fall 2026',
      startDate: '2026-10-18',
      endDate: '2027-01-31',
    },
    subjects: [
      {
        id: 'stage_2__organic_chemistry',
        nameAr: 'الكيمياء العضوية',
        nameEn: 'Organic Chemistry',
        type: 'both',
        timetableSessionIds: ['slot_theory_sun', 'slot_theory_thu'],
      },
    ],
    occurrences: [],
    sessions: [],
    records: [],
  };

  const subjects: SubjectItem[] = buildCanonicalSubjects(rows, mine, true);

  // Must merge into EXACTLY ONE subject
  assert.equal(subjects.length, 1, `Expected 1 subject card, got ${subjects.length}`);

  const subject = subjects[0];
  assert.equal(subject.nameAr, 'الكيمياء العضوية');
  assert.equal(subject.hasTheory, true);
  assert.equal(subject.hasPractical, true);
  assert.equal(subject.theoryWeeks.length, 2, 'Should have 2 theory sessions');
  assert.equal(subject.practicalWeeks.length, 1, 'Should have 1 practical session');

  // Verify multi-doctor display
  assert.equal(subject.theoryDoctor, 'د. أحمد');
  assert.equal(subject.practicalDoctor, 'د. سارة');
  assert.equal(subject.doctorName, 'د. أحمد (نظري) • د. سارة (عملي)');

  // Verify chronological ordering and session annotations for multiple sessions in week 1
  assert.equal(subject.theoryWeeks[0].occurrenceId, 'occ_theory_1');
  assert.equal(subject.theoryWeeks[0].title, 'الأسبوع 1 (الجلسة 1)');
  assert.equal(subject.theoryWeeks[1].occurrenceId, 'occ_theory_2');
  assert.equal(subject.theoryWeeks[1].title, 'الأسبوع 1 (الجلسة 2)');

  assert.equal(subject.practicalWeeks[0].occurrenceId, 'occ_lab_1');
  assert.equal(subject.practicalWeeks[0].title, 'الأسبوع 1');

  console.log('✔ Core subject merge & deduplication tests passed');
}

// -------------------------------------------------------------
// 5. Theory-Only & Practical-Only Subjects
// -------------------------------------------------------------
{
  const theoryOnlyRows: StudentAttendanceRow[] = [
    {
      weekStart: '2026-10-18',
      state: 'confirmed',
      occurrence: {
        id: 'occ_ethics',
        stageId: 'stage_2',
        lectureDate: '2026-10-18',
        startTime: '12:30',
        endTime: '13:30',
        title: 'أخلاقيات مهنة الصيدلة',
        timetableSessionId: 'slot_ethics',
        teacher: 'د. علي',
        mode: 'theory',
      },
    },
  ];

  const subjectsTheory = buildCanonicalSubjects(theoryOnlyRows, null, true);
  assert.equal(subjectsTheory.length, 1);
  assert.equal(subjectsTheory[0].hasTheory, true);
  assert.equal(subjectsTheory[0].hasPractical, false);
  assert.equal(subjectsTheory[0].doctorName, 'د. علي');

  const labOnlyRows: StudentAttendanceRow[] = [
    {
      weekStart: '2026-10-18',
      state: 'confirmed',
      occurrence: {
        id: 'occ_comp_lab',
        stageId: 'stage_2',
        lectureDate: '2026-10-19',
        startTime: '10:30',
        endTime: '12:30',
        title: 'مختبر الحاسوب',
        timetableSessionId: 'slot_comp_lab',
        teacher: 'م. مريم',
        mode: 'practical',
      },
    },
  ];

  const subjectsLab = buildCanonicalSubjects(labOnlyRows, null, true);
  assert.equal(subjectsLab.length, 1);
  assert.equal(subjectsLab[0].hasTheory, false);
  assert.equal(subjectsLab[0].hasPractical, true);
  assert.equal(subjectsLab[0].doctorName, 'م. مريم');

  console.log('✔ Theory-only and practical-only subject tests passed');
}

console.log('All Subject Deduplication and Merging Tests Passed Successfully!');
