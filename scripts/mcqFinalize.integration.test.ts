import fs from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST is required');
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
  configurable: true,
});

const { finalizeFirstAttempt } = await import('../src/services/mcqAnswerService');
const env = await initializeTestEnvironment({
  projectId: 'mylectures-rules-test',
  firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
});
await env.withSecurityRulesDisabled(async ctx => {
  await setDoc(doc(ctx.firestore(), 'users/finalize_uid'), {
    role: 'student', email: 'finalize@example.com', stageId: 'stage_3', graduated: false,
  });
});
const studentDb = env.authenticatedContext('finalize_uid', {
  email: 'finalize@example.com', email_verified: true,
}).firestore();
let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
};
const answers = (correct: number) => Object.fromEntries(Array.from({ length: 20 }, (_, i) => [
  `q${i + 1}`, { selected: 'A', isCorrect: i < correct },
]));

await finalizeFirstAttempt(
  'finalize_uid', 'lecture_success', 'pharmacology', answers(15), 20, 'stage_3',
  { firestore: studentDb as any },
);
let stats = (await getDoc(doc(studentDb, 'userStageMCQStats/finalize_uid_stage_3'))).data() || {};
check('successful transaction commits first-attempt points',
  stats.totalFirstAttemptCorrect === 15 && stats.mcqLeaderboardScore === 150);

await finalizeFirstAttempt(
  'finalize_uid', 'lecture_success', 'pharmacology', answers(20), 20, 'stage_3',
  { firestore: studentDb as any },
);
stats = (await getDoc(doc(studentDb, 'userStageMCQStats/finalize_uid_stage_3'))).data() || {};
check('duplicate finalization is accepted without double scoring',
  stats.totalFirstAttemptCorrect === 15 && stats.totalFirstAttemptAnswered === 20);

const queued: any[] = [];
const retry = await finalizeFirstAttempt(
  'finalize_uid', 'lecture_retry', 'pharmacology', answers(10), 20, 'stage_3',
  {
    firestore: studentDb as any,
    enqueue: (_type, payload) => queued.push(payload),
    runTransaction: async () => { throw Object.assign(new Error('offline'), { code: 'unavailable' }); },
  },
);
check('retryable network failure queues the first attempt', retry.offline === true && queued.length === 1);

await finalizeFirstAttempt(
  queued[0].userId, queued[0].lectureId, queued[0].subjectId,
  queued[0].answers, queued[0].totalQuestions, queued[0].lectureStageId,
  { firestore: studentDb as any },
);
await finalizeFirstAttempt(
  queued[0].userId, queued[0].lectureId, queued[0].subjectId,
  queued[0].answers, queued[0].totalQuestions, queued[0].lectureStageId,
  { firestore: studentDb as any },
);
stats = (await getDoc(doc(studentDb, 'userStageMCQStats/finalize_uid_stage_3'))).data() || {};
check('queued retry commits once and a repeated retry does not double score',
  stats.totalFirstAttemptCorrect === 25
  && stats.totalFirstAttemptAnswered === 40
  && stats.mcqLeaderboardScore === 250);

await env.cleanup();
console.log(`\n${failed ? 'FAILED' : 'OK'} (${failed} failures)`);
process.exit(failed ? 1 : 0);
