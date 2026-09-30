/**
 * Migrates existing single-document `userMCQStats/{userId}` into stage-scoped
 * `userStageMCQStats/{userId}_{stageId}` documents.
 *
 * Usage:
 *   npx tsx scripts/migrateMcqStatsToStages.ts              # dry run (default)
 *   npx tsx scripts/migrateMcqStatsToStages.ts --commit     # commit writes to Firestore
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import 'dotenv/config';

const argv = process.argv.slice(2);
const commit = argv.includes('--commit');

const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  console.error('.env is missing FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY.');
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

import { computeMcqRankScore } from '../src/types/mcq.types';

console.log('');
console.log('Target: project ' + FIREBASE_PROJECT_ID + (process.env.FIRESTORE_EMULATOR_HOST ? ' (EMULATOR)' : ' (LIVE)'));
console.log(commit ? 'Mode  : COMMIT - stage stats and legacy cleanups will be written' : 'Mode  : DRY RUN - nothing will be written');
console.log('');

async function main() {
  const [usersSnap, statsSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('userMCQStats').get(),
  ]);

  const userMap = new Map<string, any>();
  for (const d of usersSnap.docs) {
    userMap.set(d.id, d.data() || {});
  }

  console.log(`Loaded ${usersSnap.size} users and ${statsSnap.size} legacy MCQ stat rows.`);
  console.log('');

  let prepared = 0;
  let skippedNoStage = 0;
  let promotedStudentsCount = 0;
  let activeStudentsCount = 0;
  const stageDistribution = new Map<string, number>();

  const stageWrites: { docId: string; data: any }[] = [];
  const legacyCleanups: { docId: string; cleanScore: number | null }[] = [];

  for (const statDoc of statsSnap.docs) {
    const data = statDoc.data() || {};
    const userId = statDoc.id;
    const user = userMap.get(userId) || {};

    // All existing lecture stats belong to stage_3 unless explicitly tagged otherwise.
    // If user moved to stage_4, the historical stats still belong to stage_3.
    const stageId = data.stageId || 'stage_3';

    const docId = `${userId}_${stageId}`;
    const isActiveInStage = user.stageId === stageId && user.graduated !== true;

    if (isActiveInStage) {
      activeStudentsCount++;
    } else {
      promotedStudentsCount++;
    }

    stageDistribution.set(stageId, (stageDistribution.get(stageId) || 0) + 1);

    const correct = data.totalFirstAttemptCorrect || 0;
    const answered = data.totalFirstAttemptAnswered || 0;
    const cleanRankScore = computeMcqRankScore(correct, answered);

    const payload: Record<string, any> = {
      userId,
      stageId,
      isActiveInStage,
      totalFirstAttemptCorrect: correct,
      totalFirstAttemptAnswered: answered,
      lecturesAttempted: data.lecturesAttempted || 0,
      mcqLeaderboardScore: correct * 10,
      accuracy: answered > 0 ? (correct / answered) * 100 : 0,
      subjectStats: data.subjectStats || {},
      lastUpdated: data.lastUpdated || FieldValue.serverTimestamp(),
    };

    if (cleanRankScore !== null) {
      payload.mcqRankScore = cleanRankScore;
    }

    stageWrites.push({ docId, data: payload });
    legacyCleanups.push({ docId: userId, cleanScore: cleanRankScore });
    prepared++;
  }

  console.log(`Prepared ${prepared} stage stat records to write.`);
  console.log(`  Active in stage: ${activeStudentsCount}`);
  console.log(`  Historical / promoted to other stages: ${promotedStudentsCount}`);
  console.log('');
  console.log('Stage distribution:');
  for (const [st, count] of stageDistribution.entries()) {
    console.log(`  ${st}: ${count} rows`);
  }
  console.log('');

  // Sample comparison of top 5
  const sample = stageWrites
    .filter(w => w.data.mcqRankScore != null)
    .sort((a, b) => (b.data.mcqRankScore || 0) - (a.data.mcqRankScore || 0))
    .slice(0, 5);

  console.log('Sample top 5 recomputed scores:');
  for (const s of sample) {
    const d = s.data;
    const displayPts = Math.round((d.mcqRankScore || 0) / 100);
    console.log(`  User: ${d.userId} | stage: ${d.stageId} | active: ${d.isActiveInStage} | correct: ${d.totalFirstAttemptCorrect}/${d.totalFirstAttemptAnswered} | rankScore: ${d.mcqRankScore} -> UI: ${displayPts} pts`);
  }
  console.log('');

  if (!commit) {
    console.log('Dry run complete. Run with --commit to write to Firestore.');
    return;
  }

  console.log('Committing stage partitioned stats to userStageMCQStats...');
  let committedStages = 0;
  for (let i = 0; i < stageWrites.length; i += 400) {
    const batch = db.batch();
    const chunk = stageWrites.slice(i, i + 400);
    for (const w of chunk) {
      batch.set(db.collection('userStageMCQStats').doc(w.docId), w.data, { merge: true });
    }
    await batch.commit();
    committedStages += chunk.length;
    console.log(`Committed ${committedStages}/${stageWrites.length} userStageMCQStats rows...`);
  }

  console.log('Cleaning legacy mcqRankScore in userMCQStats...');
  let committedLegacy = 0;
  for (let i = 0; i < legacyCleanups.length; i += 400) {
    const batch = db.batch();
    const chunk = legacyCleanups.slice(i, i + 400);
    for (const w of chunk) {
      const ref = db.collection('userMCQStats').doc(w.docId);
      if (w.cleanScore !== null) {
        batch.update(ref, { mcqRankScore: w.cleanScore });
      } else {
        batch.update(ref, { mcqRankScore: FieldValue.delete() });
      }
    }
    await batch.commit();
    committedLegacy += chunk.length;
    console.log(`Cleaned ${committedLegacy}/${legacyCleanups.length} userMCQStats rows...`);
  }

  console.log('');
  console.log(`Successfully migrated ${committedStages} stage stat rows and cleaned ${committedLegacy} legacy rows!`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
