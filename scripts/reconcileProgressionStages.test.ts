/** Run with npm run test:progression-reconcile (Firestore emulator). */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  commitProgressionStageIncident,
  inspectProgressionStageIncident,
} from './reconcileProgressionStages.js';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('Refusing to run without FIRESTORE_EMULATOR_HOST.');
}

initializeApp({ projectId: 'mylectures-rules-test' });
const db = getFirestore();

const seedCandidate = async (uid: string, withStats: boolean) => {
  await db.doc(`users/${uid}`).set({
    email: '', role: 'student', stageId: 'stage_4',
    progressionYear: '2026-2027', progressionState: 'completed',
    tahmeelSubjects: [],
  });
  await db.doc(`students/${uid}`).set({
    email: uid, isActive: true, stageId: 'stage_3', subgroup: 'B2',
  });
  if (withStats) await db.doc(`userMCQStats/${uid}`).set({ stageId: 'stage_3', score: 10 });
};

await seedCandidate('repair-one@student.test', true);
await seedCandidate('repair-no-stats@student.test', false);
await db.doc('users/pending@student.test').set({
  email: 'pending@student.test', role: 'student', stageId: 'stage_3',
  pendingStageId: 'stage_4', pendingProgressionYear: '2026-2027',
});
await db.doc('students/pending@student.test').set({
  email: 'pending@student.test', isActive: true, stageId: 'stage_3',
});
await db.doc('users/ph12292').set({ email: 'ph12292', role: 'student', stageId: 'stage_3' });
await db.doc('students/ph12292').set({ email: 'ph12292', isActive: true, stageId: 'stage_4' });

const inspection = await inspectProgressionStageIncident(db);
assert.deepEqual(inspection.candidates.map(row => row.uid), [
  'repair-no-stats@student.test',
  'repair-one@student.test',
]);
assert.deepEqual(inspection.pending, ['pending@student.test']);
assert.deepEqual(inspection.inverse, ['ph12292']);

await assert.rejects(() => commitProgressionStageIncident(db, 28, inspection));
assert.equal((await db.doc('students/repair-one@student.test').get()).data()?.stageId, 'stage_3');

const repaired = await commitProgressionStageIncident(db, 2, inspection);
assert.deepEqual(repaired, { repaired: 2, skippedChanged: 0, skippedInvalid: 0 });
const repairedUser = (await db.doc('users/repair-one@student.test').get()).data() || {};
const repairedRoster = (await db.doc('students/repair-one@student.test').get()).data() || {};
const repairedStats = (await db.doc('userMCQStats/repair-one@student.test').get()).data() || {};
assert.equal(repairedUser.email, 'repair-one@student.test');
assert.equal(repairedRoster.stageId, 'stage_4');
assert.equal(repairedRoster.subgroup, undefined);
assert.equal(repairedStats.stageId, 'stage_4');
assert.equal((await db.doc('userMCQStats/repair-no-stats@student.test').get()).exists, false);
assert.equal((await db.doc('students/pending@student.test').get()).data()?.stageId, 'stage_3');
assert.equal((await db.doc('users/ph12292').get()).data()?.stageId, 'stage_3');

const after = await inspectProgressionStageIncident(db);
assert.equal(after.candidates.length, 0);
assert.deepEqual(await commitProgressionStageIncident(db, 0, after), {
  repaired: 0, skippedChanged: 0, skippedInvalid: 0,
});

console.log('PASS progression incident dry-run, count guard, exclusions, repair, and idempotency');
