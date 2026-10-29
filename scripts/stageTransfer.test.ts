/**
 * Comprehensive integration test suite for Individual Student Stage Transfer.
 *
 * Verifies all invariant rules against the Firestore emulator:
 *  1. Atomicity: Both students/{email} and all linked users/{uid} documents are updated.
 *  2. Optimistic Concurrency: expectedCurrentStageId mismatch triggers rollback.
 *  3. Subgroup Validation: targetSubgroup is validated against target stage's groupConfig.
 *  4. Leaderboard Isolation: userMCQStats and userStageMCQStats are updated; past stats are deactivated.
 *  5. Staff Vacating: stage-specific reps/moderators vacate their seat upon leaving; support/masterAdmin never vacated.
 *  6. Tahmeel Semantics: 'clear' vs 'preserve' correctly applied to users.tahmeelSubjects.
 *  7. Academic Preservation: degrees/{uid}/exams/* are untouched.
 *  8. Audit Logging: adminLogs record is written.
 *
 * Run with:
 *   npx -y firebase-tools@13 emulators:exec --only firestore --project mylectures-rules-test "npx tsx scripts/stageTransfer.test.ts"
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import 'dotenv/config';
import { transferStudentStage, updateStudentTahmeel } from '../shared/studentAdmin';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Refusing to run: FIRESTORE_EMULATOR_HOST is not set.');
  process.exit(1);
}

const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
initializeApp({
  credential: cert({
    projectId: FIREBASE_PROJECT_ID,
    clientEmail: FIREBASE_CLIENT_EMAIL,
    privateKey: FIREBASE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
  }),
  projectId: FIREBASE_PROJECT_ID,
});
const db = getFirestore();

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
    failed++;
  }
};

const masterStaff = {
  isMasterAdmin: true,
  role: 'master_admin',
};
const masterActor = {
  uid: 'master_uid',
  email: 'master@example.edu',
  name: 'Master Admin',
};

async function runTests() {
  console.log('\n--- Setting up Stage Transfer Integration Tests ---');

  await db.collection('app_settings').doc('academicCalendar').set({
    yearLabel: '2026-2027',
    timezone: 'Asia/Baghdad',
    terms: [],
  });

  // Seed stages
  await db.collection('stages').doc('stage_1').set({
    id: 'stage_1',
    nameEn: 'First Stage',
    nameAr: 'المرحلة الأولى',
    order: 1,
    groupConfig: {
      groups: [
        { id: 'A', subgroupCount: 2 },
        { id: 'B', subgroupCount: 2 },
      ],
    },
  });

  await db.collection('stages').doc('stage_2').set({
    id: 'stage_2',
    nameEn: 'Second Stage',
    nameAr: 'المرحلة الثانية',
    order: 2,
    groupConfig: {
      groups: [
        { id: 'A', subgroupCount: 2 },
        { id: 'B', subgroupCount: 2 },
      ],
    },
  });

  await db.collection('stages').doc('stage_3').set({
    id: 'stage_3',
    nameEn: 'Third Stage',
    nameAr: 'المرحلة الثالثة',
    order: 3,
    groupConfig: {
      groups: [
        { id: 'A', subgroupCount: 2 },
      ],
    },
  });

  // -------------------------------------------------------------------------
  // TEST 1: Basic Transfer + Subgroup + Multi-account sync + MCQ Stats Repoint
  // -------------------------------------------------------------------------
  console.log('\n[Test 1] Standard Student Stage Transfer:');
  const s1Email = 'alice@univ.edu';
  const s1UidPassword = 'alice@univ.edu';
  const s1UidGoogle = 'google-oauth-alice-123';

  await db.collection('students').doc(s1Email).set({
    name: 'Alice Al-Zuhairi',
    email: s1Email,
    stageId: 'stage_1',
    subgroup: 'A1',
    isActive: true,
    pendingStageId: 'stage_2',
    pendingProgressionYear: '2025-2026',
    graduated: true,
  });

  await db.collection('users').doc(s1UidPassword).set({
    name: 'Alice Al-Zuhairi',
    email: s1Email,
    role: 'student',
    stageId: 'stage_1',
    group: 'A1',
    tahmeelSubjects: ['math_101'],
    pendingStageId: 'stage_2',
    pendingProgressionYear: '2025-2026',
    graduated: true,
  });

  await db.collection('users').doc(s1UidGoogle).set({
    name: 'Alice Al-Zuhairi',
    email: s1Email,
    role: 'student',
    stageId: 'stage_1',
    group: 'A1',
  });

  // MCQ Stats
  await db.collection('userMCQStats').doc(s1UidPassword).set({
    userId: s1UidPassword,
    stageId: 'stage_1',
    totalFirstAttemptAnswered: 50,
    totalFirstAttemptCorrect: 45,
  });

  await db.collection('userStageMCQStats').doc(`${s1UidPassword}_stage_1`).set({
    userId: s1UidPassword,
    stageId: 'stage_1',
    isActiveInStage: true,
    totalAnswered: 50,
  });

  // Also seed a pre-existing inactive stat doc for stage_2 to test re-activation
  await db.collection('userStageMCQStats').doc(`${s1UidPassword}_stage_2`).set({
    userId: s1UidPassword,
    stageId: 'stage_2',
    isActiveInStage: false,
    totalAnswered: 10,
  });

  // Degrees subcollection
  await db.collection('degrees').doc(s1UidPassword).collection('exams').doc('exam_1').set({
    degree: 95,
    subjectId: 'anatomy_1',
  });

  const res1 = await transferStudentStage(db, FieldValue as any, {
    studentEmail: s1Email,
    targetStageId: 'stage_2',
    expectedCurrentStageId: 'stage_1',
    targetSubgroup: 'b2', // Test lowercase normalization
    transferType: 'manual_promotion',
    tahmeelHandling: 'clear',
    staff: masterStaff,
    actor: masterActor,
    reason: 'Passed all exams in First Stage',
  });

  check('res1 returns previousStageId stage_1', res1.previousStageId === 'stage_1');
  check('res1 returns targetStageId stage_2', res1.targetStageId === 'stage_2');
  check('res1 returns targetSubgroup B2', res1.targetSubgroup === 'B2');
  check('res1 reports usersUpdated 2', res1.usersUpdated === 2);

  const s1Doc = await db.collection('students').doc(s1Email).get();
  check('students doc stageId updated to stage_2', s1Doc.data()?.stageId === 'stage_2');
  check('students doc subgroup normalized to B2', s1Doc.data()?.subgroup === 'B2');
  check('students progression is completed for the active year',
    s1Doc.data()?.progressionYear === '2026-2027' && s1Doc.data()?.progressionState === 'completed');
  check('students pending progression and graduation are cleared',
    s1Doc.data()?.pendingStageId === undefined && s1Doc.data()?.pendingProgressionYear === undefined && s1Doc.data()?.graduated === false);

  const u1PassDoc = await db.collection('users').doc(s1UidPassword).get();
  check('user doc (password) stageId is stage_2', u1PassDoc.data()?.stageId === 'stage_2');
  check('user doc (password) group is B2', u1PassDoc.data()?.group === 'B2');
  check('user doc (password) tahmeelSubjects cleared', Array.isArray(u1PassDoc.data()?.tahmeelSubjects) && u1PassDoc.data()?.tahmeelSubjects.length === 0);
  check('user doc tahmeelStageId cleared on the next move', !u1PassDoc.data()?.tahmeelStageId);
  check('user progression is completed and stale pending access is cleared',
    u1PassDoc.data()?.progressionYear === '2026-2027'
      && u1PassDoc.data()?.progressionState === 'completed'
      && u1PassDoc.data()?.pendingStageId === undefined
      && u1PassDoc.data()?.pendingProgressionYear === undefined
      && u1PassDoc.data()?.graduated === false);

  const u1GDoc = await db.collection('users').doc(s1UidGoogle).get();
  check('user doc (google) stageId is stage_2', u1GDoc.data()?.stageId === 'stage_2');
  check('user doc (google) group is B2', u1GDoc.data()?.group === 'B2');

  const mcqStatsDoc = await db.collection('userMCQStats').doc(s1UidPassword).get();
  check('userMCQStats.stageId updated to stage_2', mcqStatsDoc.data()?.stageId === 'stage_2');

  const oldStageStats = await db.collection('userStageMCQStats').doc(`${s1UidPassword}_stage_1`).get();
  check('userStageMCQStats old stage isActiveInStage is false', oldStageStats.data()?.isActiveInStage === false);

  const newStageStats = await db.collection('userStageMCQStats').doc(`${s1UidPassword}_stage_2`).get();
  check('userStageMCQStats new stage isActiveInStage is true', newStageStats.data()?.isActiveInStage === true);

  const degreeDoc = await db.collection('degrees').doc(s1UidPassword).collection('exams').doc('exam_1').get();
  check('degrees subcollection completely intact', degreeDoc.exists && degreeDoc.data()?.degree === 95);

  // -------------------------------------------------------------------------
  // TEST 2: Optimistic Concurrency Failure (expectedCurrentStageId mismatch)
  // -------------------------------------------------------------------------
  console.log('\n[Test 2] Optimistic Concurrency Conflict Detection:');
  try {
    await transferStudentStage(db, FieldValue as any, {
      studentEmail: s1Email,
      targetStageId: 'stage_3',
      expectedCurrentStageId: 'stage_1', // But student is now in stage_2!
      staff: masterStaff,
      actor: masterActor,
    });
    check('expected concurrency failure to throw', false, 'Did not throw');
  } catch (err: any) {
    check('concurrency conflict caught with STAGE_CONFLICT', err.code === 'STAGE_CONFLICT');
  }

  // -------------------------------------------------------------------------
  // TEST 3: Invalid Subgroup Rejected Against groupConfig
  // -------------------------------------------------------------------------
  console.log('\n[Test 3] Subgroup Validation:');
  try {
    await transferStudentStage(db, FieldValue as any, {
      studentEmail: s1Email,
      targetStageId: 'stage_3', // stage_3 only allows A1, A2
      expectedCurrentStageId: 'stage_2',
      targetSubgroup: 'B1',      // Invalid in stage_3!
      staff: masterStaff,
      actor: masterActor,
    });
    check('expected invalid subgroup to throw', false, 'Did not throw');
  } catch (err: any) {
    check('invalid subgroup caught with INVALID_SUBGROUP', err.code === 'INVALID_SUBGROUP');
  }

  // -------------------------------------------------------------------------
  // TEST 4: Stage Representative Seat Vacated on Transfer
  // -------------------------------------------------------------------------
  console.log('\n[Test 4] Stage Representative Vacating:');
  const repEmail = 'rep@univ.edu';
  await db.collection('students').doc(repEmail).set({
    name: 'Stage Rep Bob',
    email: repEmail,
    stageId: 'stage_1',
    subgroup: 'A1',
    isActive: true,
  });

  await db.collection('users').doc(repEmail).set({
    name: 'Stage Rep Bob',
    email: repEmail,
    role: 'admin',
    managedStageId: 'stage_1',
    stageId: 'stage_1',
    group: 'A1',
  });

  await db.collection('allowed_admins').doc(repEmail).set({
    email: repEmail,
    role: 'admin',
    managedStageId: 'stage_1',
  });

  const resRep = await transferStudentStage(db, FieldValue as any, {
    studentEmail: repEmail,
    targetStageId: 'stage_2',
    expectedCurrentStageId: 'stage_1',
    transferType: 'correction',
    staff: masterStaff,
    actor: masterActor,
    reason: 'Transferred out of representative stage',
  });

  check('resRep reports wasStaffVacated true', resRep.wasStaffVacated === true);
  check('resRep reports vacatedRole admin', resRep.vacatedRole === 'admin');

  const repUserDoc = await db.collection('users').doc(repEmail).get();
  check('rep role demoted to student', repUserDoc.data()?.role === 'student');
  check('rep managedStageId cleared', !repUserDoc.data()?.managedStageId);

  const repAllowedDoc = await db.collection('allowed_admins').doc(repEmail).get();
  check('rep allowed_admins doc is deleted', !repAllowedDoc.exists);

  // -------------------------------------------------------------------------
  // TEST 5: Global Roles (Support & Master Admin) Protected from Demotion
  // -------------------------------------------------------------------------
  console.log('\n[Test 5] Global Staff Protection (Support & Master Admin):');
  const supEmail = 'support-person@univ.edu';
  await db.collection('students').doc(supEmail).set({
    name: 'Support Person',
    email: supEmail,
    stageId: 'stage_1',
    subgroup: 'A1',
    isActive: true,
  });

  await db.collection('users').doc(supEmail).set({
    name: 'Support Person',
    email: supEmail,
    role: 'support',
    stageId: 'stage_1',
    group: 'A1',
  });

  await db.collection('allowed_admins').doc(supEmail).set({
    email: supEmail,
    role: 'support',
  });

  const resSup = await transferStudentStage(db, FieldValue as any, {
    studentEmail: supEmail,
    targetStageId: 'stage_2',
    expectedCurrentStageId: 'stage_1',
    staff: masterStaff,
    actor: masterActor,
  });

  check('support staff role NOT vacated', resSup.wasStaffVacated === false);

  const supUserDoc = await db.collection('users').doc(supEmail).get();
  check('support staff keeps support role', supUserDoc.data()?.role === 'support');

  const supAllowedDoc = await db.collection('allowed_admins').doc(supEmail).get();
  check('support staff remains in allowed_admins', supAllowedDoc.exists);

  // -------------------------------------------------------------------------
  // TEST 6: Tahmeel Preservation Option
  // -------------------------------------------------------------------------
  console.log('\n[Test 6] Tahmeel Preservation:');
  const tahEmail = 'tahmeel-student@univ.edu';
  await db.collection('students').doc(tahEmail).set({
    name: 'Tahmeel Student',
    email: tahEmail,
    stageId: 'stage_1',
    subgroup: 'A1',
    isActive: true,
    tahmeelSubjects: ['pathology_2', 'biochem_1'],
  });

  await db.collection('users').doc(tahEmail).set({
    name: 'Tahmeel Student',
    email: tahEmail,
    role: 'student',
    stageId: 'stage_1',
    group: 'A1',
    tahmeelSubjects: ['pathology_2', 'biochem_1'],
  });
  for (const subjectId of ['pathology_2', 'biochem_1']) {
    await db.collection('subjects').doc(`stage_1__${subjectId}`).set({
      id: subjectId,
      stageId: 'stage_1',
      isActive: true,
    });
  }

  await transferStudentStage(db, FieldValue as any, {
    studentEmail: tahEmail,
    targetStageId: 'stage_2',
    expectedCurrentStageId: 'stage_1',
    transferType: 'manual_promotion',
    tahmeelHandling: 'preserve',
    staff: masterStaff,
    actor: masterActor,
  });

  const tahUserDoc = await db.collection('users').doc(tahEmail).get();
  const tahSubjects = tahUserDoc.data()?.tahmeelSubjects;
  check('tahmeelSubjects preserved when requested', Array.isArray(tahSubjects) && tahSubjects.includes('pathology_2') && tahSubjects.includes('biochem_1'));
  check('preserved subjects retain the source stage', tahUserDoc.data()?.tahmeelStageId === 'stage_1');
  check('roster copy retains the source stage',
    (await db.collection('students').doc(tahEmail).get()).data()?.tahmeelStageId === 'stage_1');

  console.log('\n[Test 6b] Support Tahmeel Correction:');
  const corrected = await updateStudentTahmeel(
    db, FieldValue as any, tahEmail, ['biochem_1'], masterStaff,
  );
  check('support correction returns the immediately previous stage',
    corrected.tahmeelStageId === 'stage_1');
  check('support correction replaces the user selection',
    JSON.stringify((await db.collection('users').doc(tahEmail).get()).data()?.tahmeelSubjects) === JSON.stringify(['biochem_1']));
  check('support correction replaces the roster selection',
    JSON.stringify((await db.collection('students').doc(tahEmail).get()).data()?.tahmeelSubjects) === JSON.stringify(['biochem_1']));

  let invalidTahmeelCode = '';
  try {
    await updateStudentTahmeel(db, FieldValue as any, tahEmail, ['stage_2_subject'], masterStaff);
  } catch (error: any) { invalidTahmeelCode = error.code; }
  check('support cannot select a subject outside the previous stage',
    invalidTahmeelCode === 'INVALID_TAHMEEL_SUBJECTS', invalidTahmeelCode);

  let representativeTahmeelCode = '';
  try {
    await updateStudentTahmeel(db, FieldValue as any, tahEmail, [], {
      isMasterAdmin: false, role: 'admin', managedStageId: 'stage_2', permissions: { manageStudents: true },
    });
  } catch (error: any) { representativeTahmeelCode = error.code; }
  check('representative cannot edit carried subjects',
    representativeTahmeelCode === 'GLOBAL_SCOPE_REQUIRED', representativeTahmeelCode);

  // -------------------------------------------------------------------------
  // TEST 7: Authorization and input validation
  // -------------------------------------------------------------------------
  console.log('\n[Test 7] Authorization and Validation:');
  for (const [label, staff, expectedCode] of [
    ['representative', { isMasterAdmin: false, role: 'admin', managedStageId: 'stage_2', permissions: { manageStudents: true } }, 'INSUFFICIENT_PERMISSIONS'],
    ['disabled support', { isMasterAdmin: false, role: 'support', staffDisabled: true, permissions: { manageStudents: true } }, 'NOT_GRANTED'],
    ['ungranted support', { isMasterAdmin: false, role: 'support', permissions: {} }, 'NOT_GRANTED'],
  ] as const) {
    let code = '';
    try {
      await transferStudentStage(db, FieldValue as any, {
        studentEmail: s1Email,
        targetStageId: 'stage_3',
        expectedCurrentStageId: 'stage_2',
        staff: staff as any,
        actor: masterActor,
      });
    } catch (error: any) { code = error.code; }
    check(`${label} cannot perform a cross-stage transfer`, code === expectedCode, code);
  }

  let invalidTypeCode = '';
  try {
    await transferStudentStage(db, FieldValue as any, {
      studentEmail: s1Email,
      targetStageId: 'stage_3',
      expectedCurrentStageId: 'stage_2',
      transferType: 'invented' as any,
      staff: masterStaff,
      actor: masterActor,
    });
  } catch (error: any) { invalidTypeCode = error.code; }
  check('unknown transfer types are rejected', invalidTypeCode === 'INVALID_TRANSFER_TYPE', invalidTypeCode);

  let longReasonCode = '';
  try {
    await transferStudentStage(db, FieldValue as any, {
      studentEmail: s1Email,
      targetStageId: 'stage_3',
      expectedCurrentStageId: 'stage_2',
      reason: 'x'.repeat(501),
      staff: masterStaff,
      actor: masterActor,
    });
  } catch (error: any) { longReasonCode = error.code; }
  check('oversized administrative reasons are rejected', longReasonCode === 'INVALID_INPUT', longReasonCode);

  let missingExpectedCode = '';
  try {
    await transferStudentStage(db, FieldValue as any, {
      studentEmail: s1Email,
      targetStageId: 'stage_3',
      expectedCurrentStageId: undefined as any,
      staff: masterStaff,
      actor: masterActor,
    });
  } catch (error: any) { missingExpectedCode = error.code; }
  check('the expected-stage concurrency precondition is required',
    missingExpectedCode === 'MISSING_EXPECTED_CURRENT_STAGE_ID', missingExpectedCode);

  let sameStageCode = '';
  try {
    await transferStudentStage(db, FieldValue as any, {
      studentEmail: s1Email,
      targetStageId: 'stage_2',
      expectedCurrentStageId: 'stage_2',
      staff: masterStaff,
      actor: masterActor,
    });
  } catch (error: any) { sameStageCode = error.code; }
  check('same-stage transfers are rejected', sameStageCode === 'ALREADY_IN_STAGE', sameStageCode);

  let invalidHandlingCode = '';
  try {
    await transferStudentStage(db, FieldValue as any, {
      studentEmail: s1Email,
      targetStageId: 'stage_3',
      expectedCurrentStageId: 'stage_2',
      tahmeelHandling: 'invented' as any,
      staff: masterStaff,
      actor: masterActor,
    });
  } catch (error: any) { invalidHandlingCode = error.code; }
  check('unknown tahmeel handling is rejected',
    invalidHandlingCode === 'INVALID_TAHMEEL_HANDLING', invalidHandlingCode);

  const malformedTahmeelEmail = 'malformed-tahmeel@univ.edu';
  await db.collection('students').doc(malformedTahmeelEmail).set({
    name: 'Malformed Tahmeel', email: malformedTahmeelEmail, stageId: 'stage_1',
    tahmeelSubjects: ['pathology_2', 42], isActive: true,
  });
  let malformedSubjectCode = '';
  try {
    await transferStudentStage(db, FieldValue as any, {
      studentEmail: malformedTahmeelEmail,
      targetStageId: 'stage_2',
      expectedCurrentStageId: 'stage_1',
      transferType: 'manual_promotion',
      tahmeelHandling: 'preserve',
      staff: masterStaff,
      actor: masterActor,
    });
  } catch (error: any) { malformedSubjectCode = error.code; }
  check('malformed carried-subject values are rejected',
    malformedSubjectCode === 'INVALID_TAHMEEL_SUBJECTS', malformedSubjectCode);

  const supportManagedEmail = 'support-managed@univ.edu';
  await db.collection('students').doc(supportManagedEmail).set({
    name: 'Support Managed', email: supportManagedEmail, stageId: 'stage_1', isActive: true,
  });
  const supportTransfer = await transferStudentStage(db, FieldValue as any, {
    studentEmail: supportManagedEmail,
    targetStageId: 'stage_2',
    expectedCurrentStageId: 'stage_1',
    staff: {
      isMasterAdmin: false,
      role: 'support',
      permissions: { manageStudents: true },
      staffDisabled: false,
    },
    actor: { uid: 'support-uid', email: 'support@example.edu', name: 'Support Agent' },
  });
  check('enabled support with explicit manageStudents can transfer globally',
    supportTransfer.targetStageId === 'stage_2');

  // -------------------------------------------------------------------------
  // TEST 8: Retired alias resolution and never-signed-in roster stamping
  // -------------------------------------------------------------------------
  console.log('\n[Test 8] Canonical Identity Resolution:');
  const canonicalEmail = 'canonical@univ.edu';
  const retiredEmail = 'retired@univ.edu';
  await db.collection('students').doc(canonicalEmail).set({
    name: 'Canonical Student', email: canonicalEmail, googleEmail: 'linked@gmail.com',
    stageId: 'stage_1', subgroup: 'A1', isActive: true,
  });
  await db.collection('students').doc(retiredEmail).set({
    name: 'Retired Alias', email: retiredEmail, stageId: 'stage_1',
    isActive: false, mergedInto: canonicalEmail,
  });
  await db.collection('users').doc('google-linked-uid').set({
    name: 'Canonical Student', email: 'linked@gmail.com', role: 'student', stageId: 'stage_1',
  });
  const aliasResult = await transferStudentStage(db, FieldValue as any, {
    studentEmail: retiredEmail,
    targetStageId: 'stage_2',
    expectedCurrentStageId: 'stage_1',
    staff: masterStaff,
    actor: masterActor,
  });
  check('retired alias resolves to the canonical roster id', aliasResult.email === canonicalEmail, aliasResult.email);
  check('canonical roster moves while the retired historical row remains retired',
    (await db.doc(`students/${canonicalEmail}`).get()).data()?.stageId === 'stage_2'
      && (await db.doc(`students/${retiredEmail}`).get()).data()?.mergedInto === canonicalEmail);
  check('Google-linked login account follows the canonical transfer',
    (await db.doc('users/google-linked-uid').get()).data()?.stageId === 'stage_2');

  const unsignedEmail = 'never-signed-in@univ.edu';
  await db.collection('students').doc(unsignedEmail).set({
    name: 'Never Signed In', email: unsignedEmail, stageId: 'stage_1', isActive: true,
  });
  const unsignedResult = await transferStudentStage(db, FieldValue as any, {
    studentEmail: unsignedEmail,
    targetStageId: 'stage_2',
    expectedCurrentStageId: 'stage_1',
    staff: masterStaff,
    actor: masterActor,
  });
  const unsignedDoc = (await db.doc(`students/${unsignedEmail}`).get()).data();
  check('never-signed-in student transfer updates only the roster', unsignedResult.usersUpdated === 0);
  check('never-signed-in roster carries the completed progression stamp to first login',
    unsignedDoc?.progressionYear === '2026-2027' && unsignedDoc?.progressionState === 'completed');

  // -------------------------------------------------------------------------
  // TEST 9: Retention resets destination attempt and archives it
  // -------------------------------------------------------------------------
  console.log('\n[Test 9] Retention Stats Policy:');
  const retainedEmail = 'retained@univ.edu';
  const retainedUid = 'retained-uid';
  await db.collection('students').doc(retainedEmail).set({
    name: 'Retained Student', email: retainedEmail, stageId: 'stage_2', isActive: true,
  });
  await db.collection('users').doc(retainedUid).set({
    name: 'Retained Student', email: retainedEmail, role: 'student', stageId: 'stage_2',
  });
  await db.collection('userStageMCQStats').doc(`${retainedUid}_stage_1`).set({
    userId: retainedUid, stageId: 'stage_1', isActiveInStage: false,
    totalFirstAttemptCorrect: 12, totalFirstAttemptAnswered: 20,
    lecturesAttempted: 4, mcqLeaderboardScore: 120, subjectStats: { anatomy: { correct: 12 } },
  });
  await db.collection('userMCQStats').doc(retainedUid).set({
    userId: retainedUid, stageId: 'stage_2', totalFirstAttemptCorrect: 50,
    totalFirstAttemptAnswered: 60, mcqLeaderboardScore: 500,
  });
  await db.doc(`users/${retainedUid}/stageHistory/2026-2027_stage_1`).set({
    yearLabel: '2026-2027', stageId: 'stage_1', reason: 'earlier_attempt',
    mcqLeaderboardScore: 999,
  });
  await transferStudentStage(db, FieldValue as any, {
    studentEmail: retainedEmail,
    targetStageId: 'stage_1',
    expectedCurrentStageId: 'stage_2',
    transferType: 'retention',
    staff: masterStaff,
    actor: masterActor,
  });
  const resetDestination = (await db.doc(`userStageMCQStats/${retainedUid}_stage_1`).get()).data();
  const resetLegacy = (await db.doc(`userMCQStats/${retainedUid}`).get()).data();
  const retainedHistories = await db.collection(`users/${retainedUid}/stageHistory`).get();
  check('retention archives the old destination attempt before resetting it',
    retainedHistories.docs.some(doc => doc.data()?.mcqLeaderboardScore === 120
      && doc.data()?.reason === 'retention_restart'));
  check('retention does not overwrite an earlier destination-stage archive',
    retainedHistories.docs.some(doc => doc.data()?.mcqLeaderboardScore === 999
      && doc.data()?.reason === 'earlier_attempt'));
  check('retention activates a clean destination stage aggregate',
    resetDestination?.isActiveInStage === true
      && resetDestination?.totalFirstAttemptCorrect === 0
      && resetDestination?.mcqLeaderboardScore === 0);
  check('retention also resets the legacy aggregate and repoints its stage',
    resetLegacy?.stageId === 'stage_1'
      && resetLegacy?.totalFirstAttemptCorrect === 0
      && resetLegacy?.mcqLeaderboardScore === 0);

  // -------------------------------------------------------------------------
  // TEST 10: Audit Log Verification
  // -------------------------------------------------------------------------
  console.log('\n[Test 10] Admin Audit Logging:');
  const auditQuery = await db.collection('adminLogs')
    .where('action', '==', 'TRANSFER_STUDENT_STAGE')
    .get();

  check('adminLogs records created for transfers', auditQuery.size >= 4);
  const auditData = auditQuery.docs[0]?.data();
  check('audit log uses the schema consumed by AdminLogsScreen',
    typeof auditData?.adminId === 'string'
      && typeof auditData?.adminName === 'string'
      && typeof auditData?.adminEmail === 'string'
      && typeof auditData?.details === 'string'
      && typeof auditData?.targetId === 'string'
      && typeof auditData?.stageId === 'string'
      && !!auditData?.timestamp,
    JSON.stringify(auditData));

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('Test suite failed with unhandled error:', err);
  process.exit(1);
});
