import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { backfillStrandedMcqAttempts } from './backfillStrandedMcqAttempts';

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

console.log(`\n${failed ? 'FAILED' : 'OK'} (${failed} failures)`);
process.exit(failed ? 1 : 0);
