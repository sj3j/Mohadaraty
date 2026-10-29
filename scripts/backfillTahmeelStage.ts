/**
 * Backfills tahmeelStageId for carry-over selections created before the source
 * stage was stored explicitly.
 *
 *   npx tsx scripts/backfillTahmeelStage.ts
 *   npx tsx scripts/backfillTahmeelStage.ts --commit
 *
 * Dry-run is the default. The immediately previous stage is derived from the
 * student's current stage, matching the one-stage carry-over policy.
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import 'dotenv/config';

const commit = process.argv.includes('--commit');
const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  console.error('Missing FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY.');
  process.exit(1);
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
const [stagesSnap, usersSnap, studentsSnap] = await Promise.all([
  db.collection('stages').orderBy('order', 'asc').get(),
  db.collection('users').get(),
  db.collection('students').get(),
]);
const stages = stagesSnap.docs.map(doc => ({ id: String(doc.data().id || doc.id), order: Number(doc.data().order) }));
const previousStage = (currentId: string) => {
  const current = stages.find(stage => stage.id === currentId);
  if (!current) return null;
  return stages.filter(stage => stage.order < current.order).sort((a, b) => b.order - a.order)[0]?.id || null;
};

const studentsById = new Map(studentsSnap.docs.map(doc => [doc.id.toLowerCase(), doc]));
const patches = new Map<string, { ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }>();
const inspect = (
  ref: FirebaseFirestore.DocumentReference,
  data: FirebaseFirestore.DocumentData,
  mirror?: FirebaseFirestore.QueryDocumentSnapshot,
) => {
  if (!Array.isArray(data.tahmeelSubjects) || data.tahmeelSubjects.length === 0) return;
  const source = previousStage(String(data.stageId || ''));
  if (!source) {
    console.warn(`Cannot resolve previous stage for ${ref.path} (current=${data.stageId || 'missing'})`);
    return;
  }
  if (!data.tahmeelStageId && !patches.has(ref.path)) {
    patches.set(ref.path, { ref, data: { tahmeelStageId: source } });
  }
  if (mirror) {
    const mirrorData = mirror.data();
    const mirrorSubjects = Array.isArray(mirrorData.tahmeelSubjects) ? mirrorData.tahmeelSubjects : [];
    const sameSubjects = mirrorSubjects.length === data.tahmeelSubjects.length
      && data.tahmeelSubjects.every((subjectId: string) => mirrorSubjects.includes(subjectId));
    if (!sameSubjects || mirrorData.tahmeelStageId !== source) {
      patches.set(mirror.ref.path, {
        ref: mirror.ref,
        data: { tahmeelSubjects: data.tahmeelSubjects, tahmeelStageId: source },
      });
    }
  }
};

usersSnap.docs.forEach(doc => {
  const data = doc.data();
  const email = String(data.email || (doc.id.includes('@') ? doc.id : '')).toLowerCase();
  inspect(doc.ref, data, studentsById.get(email));
});
studentsSnap.docs.forEach(doc => inspect(doc.ref, doc.data()));

console.log(`Project: ${FIREBASE_PROJECT_ID}`);
console.log(commit ? 'Mode: COMMIT' : 'Mode: DRY RUN');
console.log(`${patches.size} document(s) need tahmeelStageId.`);
for (const [path, patch] of [...patches.entries()].slice(0, 20)) {
  console.log(`  ${path} -> ${JSON.stringify(patch.data)}`);
}

if (!commit) {
  console.log('Nothing written. Re-run with --commit to apply.');
  process.exit(0);
}

let batch = db.batch();
let operations = 0;
let updated = 0;
for (const { ref, data } of patches.values()) {
  batch.set(ref, data, { merge: true });
  operations++;
  updated++;
  if (operations === 400) {
    await batch.commit();
    batch = db.batch();
    operations = 0;
  }
}
if (operations > 0) await batch.commit();
console.log(`Updated ${updated} document(s).`);
