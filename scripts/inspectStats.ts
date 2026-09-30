import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import 'dotenv/config';

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

async function main() {
  const [legacySnap, stageSnap] = await Promise.all([
    db.collection('userMCQStats').get(),
    db.collection('userStageMCQStats').get(),
  ]);
  console.log(`Total legacy stat docs: ${legacySnap.size}`);
  console.log(`Total stage-scoped stat docs: ${stageSnap.size}`);

  const sampleStage = stageSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  sampleStage.sort((a: any, b: any) => (b.mcqRankScore ?? -1) - (a.mcqRankScore ?? -1));

  console.log('\nTop 15 userStageMCQStats docs by mcqRankScore:');
  for (const s of sampleStage.slice(0, 15) as any[]) {
    const displayScore = Math.round((s.mcqRankScore || 0) / 100);
    console.log(`Doc: ${s.id} | active: ${s.isActiveInStage} | rankScore: ${s.mcqRankScore} -> UI: ${displayScore} pts | correct: ${s.totalFirstAttemptCorrect}/${s.totalFirstAttemptAnswered} | accuracy: ${Math.round(s.accuracy)}%`);
  }

  // Check for any massive numbers (> 100000) in all userStageMCQStats docs
  console.log('\nChecking for any massive numbers (> 100000) in userStageMCQStats:');
  let massiveFoundStage = 0;
  for (const s of sampleStage as any[]) {
    for (const [k, v] of Object.entries(s)) {
      if (typeof v === 'number' && v > 100000) {
        console.log(`  Doc ${s.id}: field ${k} = ${v}`);
        massiveFoundStage++;
      }
    }
  }
  if (massiveFoundStage === 0) {
    console.log('  CLEAR! 0 massive numbers found in userStageMCQStats.');
  }

  // Check for any massive numbers (> 100000) in all legacy userMCQStats docs
  console.log('\nChecking for any massive numbers (> 100000) in legacy userMCQStats:');
  let massiveFoundLegacy = 0;
  for (const d of legacySnap.docs) {
    const s = d.data();
    for (const [k, v] of Object.entries(s)) {
      if (typeof v === 'number' && v > 100000) {
        console.log(`  User ${d.id}: field ${k} = ${v}`);
        massiveFoundLegacy++;
      }
    }
  }
  if (massiveFoundLegacy === 0) {
    console.log('  CLEAR! 0 massive numbers found in legacy userMCQStats.');
  }

  // Also inspect semesterArchives
  const archSnap = await db.collection('semesterArchives').get();
  console.log(`\nSemester archives count: ${archSnap.size}`);
  for (const d of archSnap.docs) {
    const data = d.data();
    console.log(`Archive: ${d.id} | topStudents: ${data.topStudents?.length} | topMcqStudents: ${data.topMcqStudents?.length}`);
    if (data.topMcqStudents?.length) {
      console.log('  First topMcqStudent:', data.topMcqStudents[0]);
    }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
