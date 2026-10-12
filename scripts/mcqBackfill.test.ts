import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { backfillStrandedMcqAttempts, reconcileCompletedMcqAttempts } from './backfillStrandedMcqAttempts';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST is required');
initializeApp({ projectId: 'mylectures-rules-test' });
const db = getFirestore();
let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
};

await db.doc('users/u_backfill').set({ stageId: 'stage_3', graduated: false });
await db.doc('lectures/lecture_backfill').set({ stageId: 'stage_3', subjectId: 'pharmacology' });
const lockedAnswers = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
  `q${index + 1}`,
  { selected: 'A', isCorrect: index < 15, isLocked: true },
]));
await db.doc('userMCQAnswers/u_backfill/lectures/lecture_backfill').set({ lockedAnswers });

const dry = await backfillStrandedMcqAttempts(db, { commit: false, academicYear: '2026-2027' });
check('dry-run finds the stranded attempt', dry.eligible === 1 && dry.repaired === 0);
check('dry-run does not mutate it',
  (await db.doc('userMCQAnswers/u_backfill/lectures/lecture_backfill').get()).data()?.hasCompletedFirstAttempt !== true);

const first = await backfillStrandedMcqAttempts(db, { commit: true, academicYear: '2026-2027' });
check('commit repairs exactly one attempt', first.repaired === 1 && first.failed === 0);
const answer = (await db.doc('userMCQAnswers/u_backfill/lectures/lecture_backfill').get()).data() || {};
const stage = (await db.doc('userStageMCQStats/u_backfill_stage_3').get()).data() || {};
check('answer is finalized with its calculated result',
  answer.hasCompletedFirstAttempt === true && answer.firstAttemptCorrect === 15 && answer.firstAttemptTotal === 20);
check('stage leaderboard receives earned points',
  stage.totalFirstAttemptCorrect === 15 && stage.totalFirstAttemptAnswered === 20 && stage.mcqLeaderboardScore === 150);

const second = await backfillStrandedMcqAttempts(db, { commit: true, academicYear: '2026-2027' });
const stageAgain = (await db.doc('userStageMCQStats/u_backfill_stage_3').get()).data() || {};
check('rerun is idempotent', second.repaired === 0 && stageAgain.mcqLeaderboardScore === 150);

// Reconciliation raises only totals proven by completed first attempts.
await db.doc('users/u_reconcile').set({ stageId: 'stage_3', graduated: false });
await db.doc('users/u_missing').set({ stageId: 'stage_4', graduated: false });
await db.doc('users/u_higher').set({ stageId: 'stage_3', graduated: false });
for (const [lectureId, stageId, subjectId] of [
  ['rec_a', 'stage_3', 'pharmacology'],
  ['rec_b', 'stage_3', 'pharmacology'],
  ['rec_missing', 'stage_4', 'pathology'],
  ['rec_higher', 'stage_3', 'anatomy'],
] as const) {
  await db.doc(`lectures/${lectureId}`).set({ stageId, subjectId });
}
const completed = async (uid: string, lectureId: string, correct: number) => {
  await db.doc(`userMCQAnswers/${uid}/lectures/${lectureId}`).set({
    hasCompletedFirstAttempt: true,
    firstAttemptCorrect: correct,
    firstAttemptTotal: 20,
    completedAt: new Date().toISOString(),
  });
};
await completed('u_reconcile', 'rec_a', 10);
await completed('u_reconcile', 'rec_b', 8);
await completed('u_missing', 'rec_missing', 12);
await completed('u_higher', 'rec_higher', 5);
await db.doc('userStageMCQStats/u_reconcile_stage_3').set({
  userId: 'u_reconcile', stageId: 'stage_3', isActiveInStage: true,
  totalFirstAttemptCorrect: 5, totalFirstAttemptAnswered: 10, lecturesAttempted: 1,
  mcqLeaderboardScore: 50,
  subjectStats: { pharmacology: { correct: 5, total: 10, lecturesAttempted: 1 } },
});
await db.doc('userStageMCQStats/u_higher_stage_3').set({
  userId: 'u_higher', stageId: 'stage_3', isActiveInStage: true,
  totalFirstAttemptCorrect: 100, totalFirstAttemptAnswered: 100, lecturesAttempted: 10,
  mcqLeaderboardScore: 1000,
  subjectStats: { anatomy: { correct: 100, total: 100, lecturesAttempted: 10 } },
  sentinel: 'do-not-touch',
});

const reconcileDry = await reconcileCompletedMcqAttempts(db, { commit: false, academicYear: '2026-2027' });
check('reconciliation dry-run identifies missing and deficient rows', reconcileDry.eligible === 2);
check('reconciliation identifies and preserves higher legacy totals', reconcileDry.preservedHigher === 1);
const reconcileCommit = await reconcileCompletedMcqAttempts(db, { commit: true, academicYear: '2026-2027' });
check('reconciliation repairs the two proven deficiencies', reconcileCommit.repaired === 2 && reconcileCommit.failed === 0);
const reconciled = (await db.doc('userStageMCQStats/u_reconcile_stage_3').get()).data() || {};
check('reconciliation rebuilds cumulative points and subject totals',
  reconciled.totalFirstAttemptCorrect === 18
  && reconciled.totalFirstAttemptAnswered === 40
  && reconciled.mcqLeaderboardScore === 180
  && reconciled.subjectStats?.pharmacology?.correct === 18);
const missing = (await db.doc('userStageMCQStats/u_missing_stage_4').get()).data() || {};
check('reconciliation creates a missing active stage row',
  missing.mcqLeaderboardScore === 120 && missing.isActiveInStage === true);
const higher = (await db.doc('userStageMCQStats/u_higher_stage_3').get()).data() || {};
check('higher legacy aggregate remains byte-for-byte semantically untouched',
  higher.mcqLeaderboardScore === 1000 && higher.sentinel === 'do-not-touch' && higher.reconciledAt === undefined);
const reconcileAgain = await reconcileCompletedMcqAttempts(db, { commit: true, academicYear: '2026-2027' });
check('reconciliation rerun has zero eligible repairs', reconcileAgain.eligible === 0 && reconcileAgain.repaired === 0);

console.log(`\n${failed ? 'FAILED' : 'OK'} (${failed} failures)`);
process.exit(failed ? 1 : 0);
