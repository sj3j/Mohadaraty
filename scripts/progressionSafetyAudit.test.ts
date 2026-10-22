import assert from 'node:assert';
import {
  nextProgressionStep,
  progressionOutcome,
  resolveProgressionUiState,
  hasActivePendingProgression,
  completedProgressionFields,
  carriedProgressionFields,
  StageLike,
} from '../shared/progression';

console.log('=== Running Progression & Yearly Promotion Safety Audit ===\n');

const stages: StageLike[] = [
  { id: 'stage_1', order: 1, nameAr: 'المرحلة الأولى', nameEn: 'First Stage' },
  { id: 'stage_2', order: 2, nameAr: 'المرحلة الثانية', nameEn: 'Second Stage' },
  { id: 'stage_3', order: 3, nameAr: 'المرحلة الثالثة', nameEn: 'Third Stage' },
  { id: 'stage_4', order: 4, nameAr: 'المرحلة الرابعة', nameEn: 'Fourth Stage' },
  { id: 'stage_5', order: 5, nameAr: 'المرحلة الخامسة', nameEn: 'Fifth Stage' },
];

const yearLabel = '2026-2027';

// 1. Verification of Role-based Progression Inquiries
console.log('1. Checking Role-based Inquiries under open gate...');

// Standard student
const studentStep = nextProgressionStep({
  gate: 'first_round',
  yearLabel,
  user: { role: 'student', stageId: 'stage_3' },
});
assert.strictEqual(studentStep, 'first', 'Standard student must be asked first round');
console.log('  PASS: Standard student receives progression question');

// Stage representative (holds role 'admin')
const repStep = nextProgressionStep({
  gate: 'first_round',
  yearLabel,
  user: { role: 'admin', stageId: 'stage_3' },
});
assert.strictEqual(repStep, 'first', 'Stage representative must be asked first round to advance stages');
console.log('  PASS: Stage representative receives progression question');

// Moderator (holds role 'moderator')
const modStep = nextProgressionStep({
  gate: 'first_round',
  yearLabel,
  user: { role: 'moderator', stageId: 'stage_3' },
});
assert.strictEqual(modStep, 'first', 'Moderator must be asked first round');
console.log('  PASS: Moderator receives progression question');

// Master admin (identified by flag or role)
const masterAdminStep1 = nextProgressionStep({
  gate: 'first_round',
  yearLabel,
  user: { role: 'admin', isMasterAdmin: true, stageId: 'stage_3' },
});
assert.strictEqual(masterAdminStep1, 'none', 'Master admin must NEVER be asked progression');

const masterAdminStep2 = nextProgressionStep({
  gate: 'first_round',
  yearLabel,
  user: { role: 'master_admin', stageId: 'stage_3' },
});
assert.strictEqual(masterAdminStep2, 'none', 'Role master_admin must NEVER be asked progression');
console.log('  PASS: Master admin is excluded from progression');

// Doctor / Lecturer
const doctorStep = nextProgressionStep({
  gate: 'first_round',
  yearLabel,
  user: { role: 'doctor', stageId: 'stage_4' },
});
assert.strictEqual(doctorStep, 'none', 'Doctor/lecturer must NEVER be asked student progression');
console.log('  PASS: Doctor/Lecturer is completely excluded from progression questions');

// Observer
const observerStep = nextProgressionStep({
  gate: 'first_round',
  yearLabel,
  user: { role: 'observer', stageId: 'stage_4' },
});
assert.strictEqual(observerStep, 'none', 'Observer must NEVER be asked progression');
console.log('  PASS: Observer is excluded from progression questions');


// 2. Verification of Student Promotion Outcomes
console.log('\n2. Checking Student Promotion Outcomes & Advancements...');

// Student passes Stage 3 -> Advances to Stage 4
const promotionOutcome = progressionOutcome({
  round: 'first',
  answer: 'passed',
  user: { role: 'student', stageId: 'stage_3' },
  stages,
});
assert.strictEqual(promotionOutcome.promoted, true, 'Student passing must be promoted');
assert.strictEqual(promotionOutcome.stageId, 'stage_4', 'Student in stage 3 must move to stage 4');
assert.strictEqual(promotionOutcome.graduated, false, 'Student in stage 3 is not yet graduated');
assert.strictEqual(promotionOutcome.progressionState, 'completed', 'Progression state must be completed');
console.log('  PASS: Student successfully advances from Stage 3 to Stage 4');

// Representative passes Stage 3 -> Advances to Stage 4
const repOutcome = progressionOutcome({
  round: 'first',
  answer: 'passed',
  user: { role: 'admin', stageId: 'stage_3' },
  stages,
});
assert.strictEqual(repOutcome.promoted, true, 'Representative passing must be promoted');
assert.strictEqual(repOutcome.stageId, 'stage_4', 'Representative in stage 3 must move to stage 4');
console.log('  PASS: Representative successfully advances from Stage 3 to Stage 4');

// Student in final stage (Stage 5) passes -> Graduates
const graduationOutcome = progressionOutcome({
  round: 'first',
  answer: 'passed',
  user: { role: 'student', stageId: 'stage_5' },
  stages,
});
assert.strictEqual(graduationOutcome.promoted, false, 'Graduating student cannot be promoted further');
assert.strictEqual(graduationOutcome.graduated, true, 'Passing stage 5 marks student as graduated');
assert.strictEqual(graduationOutcome.stageId, 'stage_5', 'Graduated student retains stage 5 access');
console.log('  PASS: Final stage student graduates properly');

// Resit round: tahmeel outcome
const tahmeelOutcome = progressionOutcome({
  round: 'resit',
  answer: 'tahmeel',
  user: { role: 'student', stageId: 'stage_2' },
  stages,
  tahmeelSubjects: ['biochem_1', 'anatomy_2'],
});
assert.strictEqual(tahmeelOutcome.promoted, true, 'Tahmeel moves student to next stage with carrying subjects');
assert.strictEqual(tahmeelOutcome.stageId, 'stage_3', 'Tahmeel moves student from stage 2 to stage 3');
assert.deepStrictEqual(tahmeelOutcome.tahmeelSubjects, ['biochem_1', 'anatomy_2'], 'Tahmeel subjects preserved');
console.log('  PASS: Tahmeel correctly advances student to Stage 3 with carried subjects');


// 3. Verification of Batch Stage Promotion Fields
console.log('\n3. Checking Batch Yearly Promotion Fields...');
const batchFields = completedProgressionFields(yearLabel);
assert.strictEqual(batchFields.hasCompletedProgression, true);
assert.strictEqual(batchFields.progressionYear, yearLabel);
assert.strictEqual(batchFields.progressionState, 'completed');

const carried = carriedProgressionFields(batchFields);
assert.strictEqual(carried.progressionYear, yearLabel);
assert.strictEqual(carried.progressionState, 'completed');
console.log('  PASS: Batch promotion stamping & user doc carryover remain intact');


// 4. Verification of UI State Resolution
console.log('\n4. Checking UI State Resolution...');

// Student gets openRound
const studentUi = resolveProgressionUiState({
  gate: 'first_round',
  yearLabel,
  user: { role: 'student', stageId: 'stage_3' },
  stages: ['stage_3', 'stage_4'],
});
assert.strictEqual(studentUi.openRound, 'first', 'Student UI state must expose openRound: first');
console.log('  PASS: Student UI receives openRound: first');

// Doctor gets null openRound
const doctorUi = resolveProgressionUiState({
  gate: 'first_round',
  yearLabel,
  user: { role: 'doctor', stageId: 'stage_4' },
  stages: ['stage_3', 'stage_4'],
});
assert.strictEqual(doctorUi.openRound, null, 'Doctor UI state must NEVER have an openRound');
assert.strictEqual(doctorUi.hasActivePendingAccess, false, 'Doctor must not have active pending access');
console.log('  PASS: Doctor UI receives openRound: null and hasActivePendingAccess: false');

// Active pending progression check
assert.strictEqual(hasActivePendingProgression({ role: 'student', stageId: 'stage_3', pendingStageId: 'stage_4', pendingProgressionYear: yearLabel }, yearLabel), true);
assert.strictEqual(hasActivePendingProgression({ role: 'doctor', stageId: 'stage_3', pendingStageId: 'stage_4', pendingProgressionYear: yearLabel }, yearLabel), false);
console.log('  PASS: hasActivePendingProgression safely excludes doctors while allowing students');

console.log('\n✅ ALL PROGRESSION AND YEARLY PROMOTION SAFETY AUDITS PASSED WITH ZERO ERRORS!\n');
