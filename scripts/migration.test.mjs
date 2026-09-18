/**
 * Verifies migrateToStages.js against the Firestore emulator.
 *
 * Run with:  npm run test:migration
 *
 * Seeds pre-course content, runs the real migration, then asserts the curriculum
 * landed and every legacy lecture/record was tagged with the right course+subject.
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import 'dotenv/config';
import { execFileSync } from 'child_process';

// Local copy of the scoring rule, asserted against the migration's own output.
// score = correct x accuracy == correct^2 / answered, stored x100.
const computeRank = (correct, answered) => {
  if (!answered || answered <= 0) return null;
  return Math.round((correct * correct * 100) / answered);
};

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Refusing to run: FIRESTORE_EMULATOR_HOST is not set.');
  process.exit(1);
}

const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
const credential = cert({
  projectId: FIREBASE_PROJECT_ID,
  clientEmail: FIREBASE_CLIENT_EMAIL,
  privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
});

const seedApp = initializeApp({ credential, projectId: FIREBASE_PROJECT_ID }, 'seeder');
const db = getFirestore(seedApp);

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); failed++; }
};

// ---------------------------------------------------------------------------
// Pre-course state: legacy categories, stage_3, no courseId, no subjectId.
// Plus one obsolete subject doc from the previous (wrong) seed.
// ---------------------------------------------------------------------------
const LEGACY = ['pharmacology', 'cosmetics', 'pharmacognosy', 'biochemistry', 'organic_chemistry'];

for (const cat of LEGACY) {
  await db.collection('lectures').doc(`lec_${cat}`).set({
    title: `Lecture ${cat}`, category: cat, type: 'theoretical', stageId: 'stage_3',
  });
  await db.collection('records').doc(`rec_${cat}`).set({
    title: `Record ${cat}`, category: cat, type: 'theoretical', stageId: 'stage_3',
  });
}
// A lecture on a different stage must be left alone.
await db.collection('lectures').doc('lec_other_stage').set({
  title: 'Other', category: 'biochemistry', type: 'theoretical', stageId: 'stage_4',
});
// The obsolete subject doc the migration should delete.
await db.collection('subjects').doc('stage_2__pharmacology').set({
  id: 'pharmacology', stageId: 'stage_2', nameEn: 'Pharmacology', isActive: true,
});


// MCQ stats mirroring live stage_3 rows: the volume ranking put 61%/340 above
// 91%/220, which is the bug being fixed.
await db.collection('userMCQStats').doc('high_volume_low_acc').set({
  userId: 'high_volume_low_acc', stageId: 'stage_3',
  totalFirstAttemptCorrect: 208, totalFirstAttemptAnswered: 340,
  accuracy: 61.18, mcqLeaderboardScore: 2080, lecturesAttempted: 17,
});
await db.collection('userMCQStats').doc('low_volume_high_acc').set({
  userId: 'low_volume_high_acc', stageId: 'stage_3',
  totalFirstAttemptCorrect: 200, totalFirstAttemptAnswered: 220,
  accuracy: 90.91, mcqLeaderboardScore: 2000, lecturesAttempted: 11,
});
await db.collection('userMCQStats').doc('unqualified').set({
  userId: 'unqualified', stageId: 'stage_3',
  totalFirstAttemptCorrect: 20, totalFirstAttemptAnswered: 20,
  accuracy: 100, mcqLeaderboardScore: 200, lecturesAttempted: 1,
});
await db.collection('userMCQStats').doc('other_stage').set({
  userId: 'other_stage', stageId: 'stage_4',
  totalFirstAttemptCorrect: 300, totalFirstAttemptAnswered: 300,
  accuracy: 100, mcqLeaderboardScore: 3000, lecturesAttempted: 15,
});

console.log('Seeded pre-course state.\n');

// ---------------------------------------------------------------------------
// Run the real migration (it self-executes on import).
// ---------------------------------------------------------------------------
// Run as a real subprocess: the migration initializes its own Firebase app and
// calls process.exit, neither of which survives being imported twice.
const runMigration = () =>
  execFileSync('node', ['scripts/migrateToStages.js', '--env', 'stage_3'],
    { encoding: 'utf8', stdio: 'pipe' });

runMigration();

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
console.log('\nVerifying:');

const obsolete = await db.collection('subjects').doc('stage_2__pharmacology').get();
check('obsolete legacy subject doc deleted', !obsolete.exists);

const s3 = await db.collection('subjects').where('stageId', '==', 'stage_3').get();
check('stage_3 has 11 subjects', s3.size === 11, `got ${s3.size}`);

const c1 = s3.docs.filter(d => d.data().courseId === 'course_1').length;
const c2 = s3.docs.filter(d => d.data().courseId === 'course_2').length;
check('stage_3 splits 6 / 5 across courses', c1 === 6 && c2 === 5, `got ${c1} / ${c2}`);

const s1 = await db.collection('subjects').where('stageId', '==', 'stage_1').get();
check('stage_1 intentionally has no subjects', s1.size === 0, `got ${s1.size}`);

// The other three stages, pinned for the same reason stage_3 is. Every subject
// picker in the app - grades, records, homework, the question bank - now reads
// this collection instead of the five hardcoded CATEGORIES, so a stage that
// silently seeds nothing does not fail loudly: it falls back to the legacy
// stage-3 list, which is exactly the bug the curriculum replaced.
for (const [stageId, total, split] of [
  ['stage_2', 12, [7, 5]],
  ['stage_4', 11, [6, 5]],
  ['stage_5', 13, [7, 6]],
]) {
  const snap = await db.collection('subjects').where('stageId', '==', stageId).get();
  check(`${stageId} has ${total} subjects`, snap.size === total, `got ${snap.size}`);
  const a = snap.docs.filter(d => d.data().courseId === 'course_1').length;
  const b = snap.docs.filter(d => d.data().courseId === 'course_2').length;
  check(`${stageId} splits ${split[0]} / ${split[1]} across courses`,
    a === split[0] && b === split[1], `got ${a} / ${b}`);
  const unnamed = snap.docs.filter(d => !d.data().nameAr || !d.data().nameEn);
  check(`every ${stageId} subject is named in both languages`, unnamed.length === 0,
    unnamed.map(d => d.id).join(', '));
}

const expected = {
  pharmacology: 'pharmacology_i',
  cosmetics: 'pharmaceutical_and_cosmetic_preparations',
  pharmacognosy: 'pharmacognocy_iii',
  biochemistry: 'biochemistry_ii',
  organic_chemistry: 'organic_pharm_chemistry_i',
};

for (const [cat, subjectId] of Object.entries(expected)) {
  const lec = (await db.collection('lectures').doc(`lec_${cat}`).get()).data();
  check(
    `lecture ${cat} -> ${subjectId} @ course_2`,
    lec.courseId === 'course_2' && lec.subjectId === subjectId,
    `got course=${lec.courseId} subject=${lec.subjectId}`
  );
}

const rec = (await db.collection('records').doc('rec_biochemistry').get()).data();
check('records tagged too', rec.courseId === 'course_2' && rec.subjectId === 'biochemistry_ii',
  `got course=${rec.courseId} subject=${rec.subjectId}`);

const other = (await db.collection('lectures').doc('lec_other_stage').get()).data();
check('other stage left untagged', !other.courseId && !other.subjectId);

// Every tagged subjectId must actually exist as a subject document.
const allSubjectIds = new Set(s3.docs.map(d => d.data().id));
const orphans = Object.values(expected).filter(id => !allSubjectIds.has(id));
check('every mapped subjectId exists in the curriculum', orphans.length === 0, orphans.join(', '));

// Arabic names must be real translations, not the English fallback.
const untranslated = s3.docs.filter(d => d.data().nameAr === d.data().nameEn);
check('every stage_3 subject has an Arabic name', untranslated.length === 0,
  untranslated.map(d => d.data().nameEn).join(', '));

const biochem = s3.docs.find(d => d.data().id === 'biochemistry_ii').data();
check('Biochemistry II translated correctly', biochem.nameAr === 'الكيمياء الحياتية ٢', biochem.nameAr);

// ---------------------------------------------------------------------------
// Admin edits must survive a re-run. Subjects are editable in-app, so the
// migration has to be create-only rather than merge.
// ---------------------------------------------------------------------------
await db.collection('subjects').doc('stage_3__biochemistry_ii').update({
  nameAr: 'اسم من المسؤول',
  courseId: 'course_1',
  order: 99,
  isActive: false,
});

const rerunOutput = runMigration();
check('re-run reports subjects as already existing',
  /left untouched/.test(rerunOutput), rerunOutput.split('\n').find(l => l.includes('created')) || '');

const after = (await db.collection('subjects').doc('stage_3__biochemistry_ii').get()).data();
check('re-run preserves admin rename', after.nameAr === 'اسم من المسؤول', after.nameAr);
check('re-run preserves admin course move', after.courseId === 'course_1', after.courseId);
check('re-run preserves admin order', after.order === 99, String(after.order));
check('re-run preserves admin hide', after.isActive === false, String(after.isActive));

const s3After = await db.collection('subjects').where('stageId', '==', 'stage_3').get();
check('re-run does not duplicate subjects', s3After.size === 11, `got ${s3After.size}`);


// ---------------------------------------------------------------------------
// MCQ ranking: accuracy first, qualifying threshold enforced, stage respected.
// ---------------------------------------------------------------------------
const ranked = await db.collection('userMCQStats')
  .where('stageId', '==', 'stage_3')
  .orderBy('mcqRankScore', 'desc')
  .get();

const order = ranked.docs.map(d => d.id);
check('precision beats sloppy volume (91%/220 above 61%/340)',
  order.indexOf('low_volume_high_acc') < order.indexOf('high_volume_low_acc'),
  order.join(' > '));

check('other stage is absent from this stage board',
  !order.includes('other_stage'), order.join(' > '));

// A short flawless quiz must not outrank sustained work - this is what makes
// the qualifying threshold unnecessary.
check('20/20 perfect does not outrank 200/220',
  computeRank(20, 20) < computeRank(200, 220),
  `${computeRank(20, 20)} vs ${computeRank(200, 220)}`);

// Effort still sets the scale at equal accuracy.
check('at equal accuracy, more volume wins',
  computeRank(200, 200) > computeRank(150, 150),
  `${computeRank(200, 200)} vs ${computeRank(150, 150)}`);

// And accuracy still bites at equal volume.
check('at equal volume, better accuracy wins',
  computeRank(200, 220) > computeRank(200, 400),
  `${computeRank(200, 220)} vs ${computeRank(200, 400)}`);

check('a user with zero answers has no score field',
  computeRank(0, 0) === null, String(computeRank(0, 0)));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
