/**
 * Dry run: npx tsx scripts/repairSparseStudentProfiles.ts
 * Repair:  npx tsx scripts/repairSparseStudentProfiles.ts --commit --expected-count 15
 *
 * Only active, unmerged students with a known stage and one matching users
 * document whose stage is absent are eligible. Populated stage disagreements
 * are deliberately excluded. Each repair checks that both source documents
 * remain unchanged before filling missing profile fields.
 */
import 'dotenv/config';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { studentProfilePatch } from '../shared/studentProfile.js';

const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  throw new Error('Firebase Admin credentials are required.');
}
initializeApp({
  credential: cert({
    projectId: FIREBASE_PROJECT_ID,
    clientEmail: FIREBASE_CLIENT_EMAIL,
    privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
  projectId: FIREBASE_PROJECT_ID,
});
const db = getFirestore();
const commit = process.argv.includes('--commit');
const expectedCount = process.argv.includes('--expected-count')
  ? Number(process.argv[process.argv.indexOf('--expected-count') + 1]) : null;
const onlyEmail = process.argv.includes('--email')
  ? process.argv[process.argv.indexOf('--email') + 1]?.toLowerCase() : null;

async function main() {
  const [students, users, stages] = await Promise.all([
    db.collection('students').select('stageId', 'isActive', 'mergedInto', 'role').get(),
    db.collection('users').select('stageId', 'email', 'role').get(),
    db.collection('stages').get(),
  ]);
  const knownStages = new Set(stages.docs.map(stage => stage.id));
  const usersById = new Map(users.docs.map(user => [user.id, user]));
  const usersByEmail = new Map<string, typeof users.docs>();
  for (const user of users.docs) {
    const email = user.data().email;
    if (typeof email !== 'string' || !email) continue;
    const key = email.toLowerCase();
    usersByEmail.set(key, [...(usersByEmail.get(key) || []), user]);
  }

  const candidates: { studentId: string; uid: string; stageId: string; studentUpdate: string; userUpdate: string }[] = [];
  let stageDisagreements = 0;
  let ambiguous = 0;
  for (const student of students.docs) {
    if (onlyEmail && student.id.toLowerCase() !== onlyEmail) continue;
    const data = student.data();
    if (data.isActive === false || data.mergedInto ||
        (data.role && data.role !== 'student') || !knownStages.has(data.stageId)) continue;
    const matches = [...(usersByEmail.get(student.id.toLowerCase()) || [])];
    const direct = usersById.get(student.id);
    if (direct && !matches.some(user => user.id === direct.id)) matches.push(direct);
    if (matches.length > 1) { ambiguous++; continue; }
    if (matches.length !== 1) continue;
    const user = matches[0];
    if (user.data().stageId) {
      if (user.data().stageId !== data.stageId) stageDisagreements++;
      continue;
    }
    if (user.data().email && user.data().email.toLowerCase() !== student.id.toLowerCase()) continue;
    if (user.data().role && user.data().role !== 'student') continue;
    candidates.push({
      studentId: student.id,
      uid: user.id,
      stageId: data.stageId,
      studentUpdate: student.updateTime.toDate().toISOString(),
      userUpdate: user.updateTime.toDate().toISOString(),
    });
  }

  console.log(JSON.stringify({
    project: FIREBASE_PROJECT_ID,
    mode: commit ? 'commit' : 'dry-run',
    eligible: candidates.length,
    stageDisagreementsExcluded: stageDisagreements,
    ambiguousExcluded: ambiguous,
    ...(onlyEmail ? { requestedStudentEligible: candidates.some(row => row.studentId.toLowerCase() === onlyEmail) } : {}),
  }));
  if (!commit) return;
  if (!Number.isInteger(expectedCount) || expectedCount !== candidates.length) {
    throw new Error(`Commit requires --expected-count ${candidates.length} for this dry-run result.`);
  }

  const result = { repaired: 0, skippedChanged: 0, skippedInvalid: 0 };
  for (const candidate of candidates) {
    const outcome = await db.runTransaction(async transaction => {
      const studentRef = db.collection('students').doc(candidate.studentId);
      const userRef = db.collection('users').doc(candidate.uid);
      const stageRef = db.collection('stages').doc(candidate.stageId);
      const [student, user, stage] = await Promise.all([
        transaction.get(studentRef), transaction.get(userRef), transaction.get(stageRef),
      ]);
      if (!student.exists || !user.exists || !stage.exists) return 'skippedInvalid';
      if (student.updateTime.toDate().toISOString() !== candidate.studentUpdate ||
          user.updateTime.toDate().toISOString() !== candidate.userUpdate) return 'skippedChanged';
      const studentData = student.data() || {};
      const userData = user.data() || {};
      if (studentData.isActive === false || studentData.mergedInto ||
          (studentData.role && studentData.role !== 'student') ||
          studentData.stageId !== stage.id || userData.stageId ||
          (userData.email && userData.email.toLowerCase() !== candidate.studentId.toLowerCase()) ||
          (userData.role && userData.role !== 'student')) return 'skippedInvalid';
      const patch = studentProfilePatch(candidate.studentId, studentData, userData,
        user.createTime || FieldValue.serverTimestamp());
      if (!patch.stageId) return 'skippedInvalid';
      transaction.set(userRef, patch, { merge: true });
      return 'repaired';
    });
    result[outcome]++;
  }
  console.log(JSON.stringify(result));
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
