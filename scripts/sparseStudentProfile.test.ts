/** Run with npm run test:sparse-students (Firestore emulator). */
import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, doc, getDocs, query, where } from 'firebase/firestore';
import { resolveSessionUid } from '../shared/studentLookup.js';
import { resolveGoogleLogin, claimAccountWithGoogle } from '../shared/googleLogin.js';
import { reconcileStudentProfile } from '../shared/studentProfile.js';
import { completedProgressionFields } from '../shared/progression.js';
import bcrypt from 'bcryptjs';

const projectId = 'mylectures-rules-test';
initializeApp({ projectId });
const db = getFirestore();
const env = await initializeTestEnvironment({
  projectId,
  firestore: {
    rules: fs.readFileSync('firestore.rules', 'utf8'),
    host: '127.0.0.1',
    port: 8080,
  },
});
const reconcile = (uid: string, source: { studentId: string }) =>
  reconcileStudentProfile(db, uid, source.studentId, () => FieldValue.serverTimestamp()).then(() => {});
const fakeAuth = { createCustomToken: async (uid: string) => `token-for:${uid}` };

try {
  await db.doc('stages/stage_3').set({ nameEn: 'Third Stage' });
  await db.doc('stages/stage_4').set({ nameEn: 'Fourth Stage' });
  await db.doc('lectures/sparse_stage_4').set({ title: 'Stage Four', stageId: 'stage_4', createdAt: FieldValue.serverTimestamp() });
  await db.doc('lectures/sparse_stage_3').set({ title: 'Stage Three', stageId: 'stage_3', createdAt: FieldValue.serverTimestamp() });

  // Individual manual-add shape: the roster is correct, but an IAP link created
  // an incomplete users document before the client could initialize it.
  const sparseId = 'sparse@student.test';
  await db.doc(`students/${sparseId}`).set({
    email: sparseId, name: 'Sparse Student', isActive: true,
    stageId: 'stage_4', subgroup: 'D3', examCode: '1234',
    password: await bcrypt.hash('secret123', 10),
    ...completedProgressionFields('2026-2027'),
  });
  await db.doc(`users/${sparseId}`).set({ group: 'D3', rcAppUserId: 'purchase-link', streakCount: 11 });
  const student = await db.doc(`students/${sparseId}`).get();
  const session = await resolveSessionUid(db,
    { id: sparseId, data: student.data() || {} }, reconcile);
  assert.equal(session.uid, sparseId);
  assert.equal(session.emailClaim, sparseId);
  const repaired = (await db.doc(`users/${sparseId}`).get()).data() || {};
  assert.equal(repaired.stageId, 'stage_4');
  assert.equal(repaired.email, sparseId);
  assert.equal(repaired.role, 'student');
  assert.equal(repaired.name, 'Sparse Student');
  assert.equal(repaired.group, 'D3');
  assert.equal(repaired.rcAppUserId, 'purchase-link');
  assert.equal(repaired.streakCount, 11);
  assert.equal(repaired.progressionState, 'completed');

  const signedIn = env.authenticatedContext(sparseId, { email: sparseId }).firestore();
  await assertSucceeds(getDocs(query(collection(signedIn, 'lectures'), where('stageId', '==', 'stage_4'))));
  await assertFails(getDocs(query(collection(signedIn, 'lectures'), where('stageId', '==', 'stage_3'))));

  // Google must choose the same sparse document ID, even when its fallback UID
  // differs and the users.email query cannot see the document.
  const googleId = 'google@student.test';
  await db.doc(`students/${googleId}`).set({ email: googleId, name: 'Google Student', isActive: true, stageId: 'stage_4' });
  await db.doc(`users/${googleId}`).set({ rcAppUserId: 'google-link' });
  const google = await resolveGoogleLogin(db, fakeAuth, {
    email: googleId, name: 'Google Student', emailVerified: true,
  }, {
    masterAdminEmails: [], fallbackUid: 'wrong-uid',
    syncUserStage: (uid, source) => 'studentId' in source ? reconcile(uid, source) : Promise.resolve(),
  });
  assert.equal(google.uid, googleId);
  assert.equal(google.email, googleId);
  assert.equal((await db.doc(`users/${googleId}`).get()).data()?.stageId, 'stage_4');
  assert.equal((await db.doc('users/wrong-uid').get()).exists, false);

  // Claiming a roster account with a second Google address keeps its UID and
  // repairs the same sparse document after proving the roster password.
  const claimed = await claimAccountWithGoogle(db, fakeAuth, {
    email: 'personal@gmail.test', name: 'Sparse Student', emailVerified: true,
  }, { identifier: sparseId, password: 'secret123' }, {
    masterAdminEmails: [],
    syncUserStage: (uid, source) => 'studentId' in source ? reconcile(uid, source) : Promise.resolve(),
    FieldValue: FieldValue as any,
  });
  assert.equal(claimed.uid, sparseId);
  assert.equal(claimed.email, sparseId);

  // Roster import shape: no users document exists yet. Server initialization
  // creates a complete one before a token is issued.
  const importedId = 'imported@roster.mylecture.local';
  await db.doc(`students/${importedId}`).set({
    email: importedId, name: 'Imported Student', isActive: true,
    stageId: 'stage_4', subgroup: 'D4',
    ...completedProgressionFields('2026-2027'),
  });
  const imported = await db.doc(`students/${importedId}`).get();
  const importedSession = await resolveSessionUid(db,
    { id: importedId, data: imported.data() || {} }, reconcile);
  assert.equal(importedSession.uid, importedId);
  const importedUser = (await db.doc(`users/${importedId}`).get()).data() || {};
  assert.equal(importedUser.stageId, 'stage_4');
  assert.equal(importedUser.group, 'D4');
  assert.equal(importedUser.progressionState, 'completed');

  // A complete profile is not rewritten, and a populated disagreement is not
  // guessed from the roster. Existing personalization and stage survive.
  const completeId = 'complete@student.test';
  await db.doc(`students/${completeId}`).set({ email: completeId, name: 'Roster Name', isActive: true, stageId: 'stage_4' });
  await db.doc(`users/${completeId}`).set({
    email: completeId, role: 'student', name: 'Chosen Name', originalName: 'Roster Name',
    stageId: 'stage_4', group: 'A1', favorites: ['one'], streakCount: 8,
  });
  const before = await db.doc(`users/${completeId}`).get();
  assert.equal(await reconcileStudentProfile(db, completeId, completeId, () => FieldValue.serverTimestamp()), 'repaired');
  const after = (await db.doc(`users/${completeId}`).get()).data() || {};
  assert.equal(after.name, 'Chosen Name');
  assert.equal(after.group, 'A1');
  assert.deepEqual(after.favorites, ['one']);
  assert.equal(after.streakCount, 8);
  assert.equal(after.stageId, 'stage_4');
  assert.ok(before.exists);
  assert.equal(await reconcileStudentProfile(db, completeId, completeId, () => FieldValue.serverTimestamp()), 'unchanged');
  await db.doc(`users/${completeId}`).update({ stageId: 'stage_3' });
  assert.equal(await reconcileStudentProfile(db, completeId, completeId, () => FieldValue.serverTimestamp()), 'conflict');
  assert.equal((await db.doc(`users/${completeId}`).get()).data()?.stageId, 'stage_3');

  console.log('PASS sparse student profile, manual and import creation, Google and claim, stage rules, and conflict preservation');
} finally {
  await env.cleanup();
}
