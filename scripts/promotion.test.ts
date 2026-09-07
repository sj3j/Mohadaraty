/**
 * Verifies the stage promotion against the Firestore emulator.
 *
 * Run with:  npm run test:promotion
 *
 * This rewrites every student record for a whole cohort, so the guarantees are
 * asserted here before it is ever pointed at production - in particular that
 * BOTH `students.stageId` and `users.stageId` are written, without which
 * syncUserStage silently reverts the promotion at the student's next login.
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import 'dotenv/config';
import { planPromotion, applyPromotion } from '../shared/stagePromotion';
import { nextProgressionStep } from '../shared/progression';

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

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); failed++; }
};

// ---------------------------------------------------------------------------
// Seed. Covers every shape the real data has:
//  - a plain password-login student (users doc id == email)
//  - a Google-login student (users doc id != email) - the case a doc-id lookup
//    would miss entirely
//  - a student who has never signed in (no users doc at all)
//  - a student left out of the sheet, who must not be touched
//  - a student carrying tahmeelSubjects
// ---------------------------------------------------------------------------
const students = [
  { email: 'plain@x.com',   name: 'Plain',   subgroup: 'A1', uid: 'plain@x.com' },
  { email: 'google@x.com',  name: 'Google',  subgroup: 'B2', uid: 'g-oauth-uid-999' },
  { email: 'nologin@x.com', name: 'NoLogin', subgroup: 'C1', uid: null },
  { email: 'staying@x.com', name: 'Staying', subgroup: 'D4', uid: 'staying@x.com' },
  { email: 'tahmeel@x.com', name: 'Tahmeel', subgroup: 'A2', uid: 'tahmeel@x.com' },
];

for (const s of students) {
  await db.collection('students').doc(s.email).set({
    name: s.name, email: s.email, examCode: '1234', isActive: true,
    stageId: 'stage_3', subgroup: s.subgroup,
  });
  if (s.uid) {
    await db.collection('users').doc(s.uid).set({
      name: s.name, email: s.email, role: 'student',
      stageId: 'stage_3', group: s.subgroup,
      ...(s.email === 'tahmeel@x.com' ? { tahmeelSubjects: ['old_subject_id'] } : {}),
    });
  }
}

// Only some students have MCQ stats. Promotion must not invent docs for the rest.
await db.collection('userMCQStats').doc('plain@x.com').set({
  userId: 'plain@x.com', stageId: 'stage_3', totalFirstAttemptCorrect: 0, totalFirstAttemptAnswered: 0,
});

// stage_4 allows only A and B, with 2 subgroups each - so "C3" is invalid there.
await db.collection('stages').doc('stage_4').set({
  id: 'stage_4', nameEn: 'Fourth Stage', nameAr: 'المرحلة الرابعة', order: 4,
  groupConfig: { groups: [{ id: 'A', subgroupCount: 2 }, { id: 'B', subgroupCount: 2 }] },
});

const sheet = [
  { email: 'plain@x.com',   subgroup: 'B1' },
  { email: 'google@x.com',  subgroup: 'a2' },   // lower case, must normalise
  { email: 'nologin@x.com', subgroup: 'A1' },
  { email: 'tahmeel@x.com', subgroup: 'B2' },
  { email: 'ghost@x.com',   subgroup: 'A1' },   // not a student anywhere
  { email: 'plain@x.com',   subgroup: 'A1' },   // duplicate row
];

console.log('Seeded. Planning...\n');
const plan = await planPromotion(db, { from: 'stage_3', to: 'stage_4', rows: sheet });

console.log('Plan:');
check('four real students matched', plan.matched.length === 4, String(plan.matched.length));
check('an unknown email is reported, not written',
  plan.problems.some(p => p.kind === 'unknown_email' && p.email === 'ghost@x.com'));
check('a duplicate sheet row is reported',
  plan.problems.some(p => p.kind === 'duplicate_email_rows' && p.email === 'plain@x.com'));
check('the student left out of the sheet is listed as staying',
  plan.stayingBehind.length === 1 && plan.stayingBehind[0].email === 'staying@x.com',
  JSON.stringify(plan.stayingBehind));
check('the never-signed-in student is flagged',
  plan.neverSignedIn.length === 1 && plan.neverSignedIn[0] === 'nologin@x.com');
check('a carried subject is flagged before it is cleared',
  plan.matched.find(m => m.email === 'tahmeel@x.com')?.hadTahmeel === true);
check('lower-case group is normalised',
  plan.matched.find(m => m.email === 'google@x.com')?.subgroup === 'A2');
check('the google-login user doc is found by email, not by id',
  plan.matched.find(m => m.email === 'google@x.com')?.userIds[0] === 'g-oauth-uid-999',
  JSON.stringify(plan.matched.find(m => m.email === 'google@x.com')?.userIds));
check('only the student with stats is scheduled for a stats refile',
  plan.matched.find(m => m.email === 'plain@x.com')?.statsIds.length === 1 &&
  plan.matched.find(m => m.email === 'google@x.com')?.statsIds.length === 0);

// A group the destination stage does not allow must block that row.
const badPlan = await planPromotion(db, {
  from: 'stage_3', to: 'stage_4', rows: [{ email: 'plain@x.com', subgroup: 'C3' }],
});
check('a subgroup stage_4 does not allow is rejected',
  badPlan.matched.length === 0 && badPlan.problems[0]?.kind === 'invalid_subgroup',
  JSON.stringify(badPlan.problems));
check('a blank group is rejected',
  (await planPromotion(db, { from: 'stage_3', to: 'stage_4', rows: [{ email: 'plain@x.com', subgroup: '' }] }))
    .problems[0]?.kind === 'missing_subgroup');

// ---- the dry run must not have written anything --------------------------
const untouched = (await db.doc('students/plain@x.com').get()).data();
check('planning alone writes nothing',
  untouched?.stageId === 'stage_3' && untouched?.subgroup === 'A1',
  `${untouched?.stageId}/${untouched?.subgroup}`);

console.log('\nApplying...');
const result = await applyPromotion(db, FieldValue as any, plan, { progressionYear: '2026-2027' });
check('reports what it wrote', result.studentsUpdated === 4 && result.statsUpdated === 1,
  JSON.stringify(result));

console.log('\nAfter commit:');

// The whole point: BOTH copies move.
const plainStudent = (await db.doc('students/plain@x.com').get()).data();
const plainUser = (await db.doc('users/plain@x.com').get()).data();
check('students.stageId moved (syncUserStage reads this on every login)',
  plainStudent?.stageId === 'stage_4', String(plainStudent?.stageId));
check('users.stageId moved', plainUser?.stageId === 'stage_4', String(plainUser?.stageId));
check('students.subgroup got the new group', plainStudent?.subgroup === 'B1', String(plainStudent?.subgroup));
check('users.group got the new group too (this is what gates the app)',
  plainUser?.group === 'B1', String(plainUser?.group));
// Same rule as submitProgression: the number belongs to the year just finished,
// and leaving it in place makes setOwnExamCode refuse the new one for ever.
// The exam-code CSV importer refills these in bulk afterwards.
check('the exam number is cleared on both copies so the new one can be recorded',
  plainStudent?.examCode === '' && plainUser?.examCode === '',
  `${JSON.stringify(plainStudent?.examCode)}/${JSON.stringify(plainUser?.examCode)}`);
// Imported students must never be asked the end-of-year question: their stage
// came from the sheet, not from a result they reported. nextProgressionStep
// reads progressionYear/progressionState, so stamping only the legacy pair
// would have left them asked anyway.
check('progression is stamped on the LEGACY fields',
  plainUser?.hasCompletedProgression === true && plainUser?.lastProgressionYear === '2026-2027');
check('...and on the fields the gate actually reads',
  plainUser?.progressionYear === '2026-2027' && plainUser?.progressionState === 'completed',
  `${plainUser?.progressionYear}/${plainUser?.progressionState}`);
check('so an imported student is never asked',
  nextProgressionStep({
    gate: 'resit_round', yearLabel: '2026-2027', user: plainUser as any, stages: null,
  }) === 'none');

const googleUser = (await db.doc('users/g-oauth-uid-999').get()).data();
check('the google-login user doc was patched',
  googleUser?.stageId === 'stage_4' && googleUser?.group === 'A2',
  `${googleUser?.stageId}/${googleUser?.group}`);

const tahmeelUser = (await db.doc('users/tahmeel@x.com').get()).data();
check('tahmeelSubjects is cleared', (tahmeelUser?.tahmeelSubjects || []).length === 0,
  JSON.stringify(tahmeelUser?.tahmeelSubjects));

const noLoginStudent = (await db.doc('students/nologin@x.com').get()).data();
check('a never-signed-in student still gets their students record moved',
  noLoginStudent?.stageId === 'stage_4' && noLoginStudent?.subgroup === 'A1');
check('and no phantom users doc is created for them',
  !(await db.doc('users/nologin@x.com').get()).exists);

// The student absent from the sheet must be untouched in every respect.
const stayingStudent = (await db.doc('students/staying@x.com').get()).data();
const stayingUser = (await db.doc('users/staying@x.com').get()).data();
check('a student left out of the sheet keeps their stage',
  stayingStudent?.stageId === 'stage_3' && stayingUser?.stageId === 'stage_3');
check('and keeps their exam number - they did not move up a year',
  stayingStudent?.examCode === '1234', JSON.stringify(stayingStudent?.examCode));
check('and keeps their old group', stayingStudent?.subgroup === 'D4' && stayingUser?.group === 'D4');

check('mcq stats were refiled under the new stage',
  (await db.doc('userMCQStats/plain@x.com').get()).data()?.stageId === 'stage_4');
check('no empty stats doc was invented for a student without one',
  !(await db.doc('userMCQStats/g-oauth-uid-999').get()).exists);

// ---- re-running must be a no-op ------------------------------------------
console.log('\nRe-running (idempotency):');
const rerun = await planPromotion(db, { from: 'stage_3', to: 'stage_4', rows: sheet });
check('everyone now reads as already promoted',
  rerun.matched.length === 4 && rerun.matched.every(m => m.alreadyPromoted),
  `${rerun.matched.length} matched, ${rerun.matched.filter(m => m.alreadyPromoted).length} already`);
check('the student who stayed is still the only one left behind',
  rerun.stayingBehind.length === 1 && rerun.stayingBehind[0].email === 'staying@x.com');

await applyPromotion(db, FieldValue as any, rerun, { progressionYear: '2026-2027' });
const afterRerun = (await db.doc('students/plain@x.com').get()).data();
check('a second run changes nothing',
  afterRerun?.stageId === 'stage_4' && afterRerun?.subgroup === 'B1',
  `${afterRerun?.stageId}/${afterRerun?.subgroup}`);

console.log('\nRoster mode (no --from): the sheet defines the stage');
// Seeding a stage's roster has to reach students wherever they currently sit,
// including ones already moved on by the self-service progression flow.
await db.collection('students').doc('elsewhere@x.com').set({
  name: 'Elsewhere', email: 'elsewhere@x.com', examCode: '9', isActive: true,
  stageId: 'stage_1', subgroup: 'A1',
});
await db.collection('users').doc('elsewhere@x.com').set({
  name: 'Elsewhere', email: 'elsewhere@x.com', role: 'student', stageId: 'stage_1', group: 'A1',
});

const roster = await planPromotion(db, {
  to: 'stage_4',
  rows: [{ email: 'elsewhere@x.com', subgroup: 'B1' }],
});
check('a student from another stage is matched in roster mode',
  roster.matched.length === 1 && roster.matched[0].email === 'elsewhere@x.com',
  JSON.stringify(roster.problems));
check('roster mode lists only target-stage students missing from the sheet, not the whole database',
  roster.stayingBehind.every(x => x.email !== 'elsewhere@x.com'));

await applyPromotion(db, FieldValue as any, roster, { progressionYear: '2026-2027' });
check('roster mode moves them to the target stage',
  (await db.doc('students/elsewhere@x.com').get()).data()?.stageId === 'stage_4');
check('and mirrors it onto the user doc',
  (await db.doc('users/elsewhere@x.com').get()).data()?.stageId === 'stage_4');

// With --from, eligibility is restricted again.
const restricted = await planPromotion(db, {
  from: 'stage_3', to: 'stage_4',
  rows: [{ email: 'staying@x.com', subgroup: 'B1' }],
});
check('promotion mode still restricts to the source stage',
  restricted.matched.length === 1 && restricted.matched[0].email === 'staying@x.com');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
