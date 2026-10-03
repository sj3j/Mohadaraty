import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { computeMcqRankScore } from '../src/types/mcq.types.js';
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

async function run() {
  const commit = process.argv.includes('--commit');
  console.log(`Running backfill with commit=${commit}`);

  // 1. Fetch all lectures
  const lecturesSnap = await db.collection('lectures').get();
  const lectureMap = new Map<string, any>();
  lecturesSnap.forEach(d => lectureMap.set(d.id, d.data()));

  // 2. Fetch all users
  const usersSnap = await db.collection('users').get();
  const userMap = new Map<string, any>();
  usersSnap.forEach(d => userMap.set(d.id, d.data()));

  // 3. Scan all userMCQAnswers
  const allAns = await db.collectionGroup('lectures').get();

  // (userId, stageId) -> aggregated stats
  const stageStatsMap = new Map<string, {
    userId: string;
    stageId: string;
    totalCorrect: number;
    totalAnswered: number;
    lectures: Set<string>;
    subjectStats: Record<string, { correct: number; total: number; lecturesAttempted: number }>;
  }>();

  for (const d of allAns.docs) {
    const pathParts = d.ref.path.split('/');
    if (pathParts[0] === 'userMCQAnswers') {
      const userId = pathParts[1];
      const lectureId = d.id;
      const lecData = lectureMap.get(lectureId);
      const stageId = lecData?.stageId || 'stage_3';
      const subjectId = lecData?.subjectId || lecData?.category || 'general';

      const data = d.data();
      const locked = data.lockedAnswers || {};
      let correctInDoc = 0;
      let answeredInDoc = 0;

      // Count from lockedAnswers or from firstAttempt
      if (Object.keys(locked).length > 0) {
        for (const q of Object.values(locked) as any[]) {
          answeredInDoc++;
          if (q.isCorrect) correctInDoc++;
        }
      } else if (data.firstAttemptTotal) {
        answeredInDoc = data.firstAttemptTotal || 0;
        correctInDoc = data.firstAttemptCorrect || 0;
      }

      if (answeredInDoc > 0) {
        const key = `${userId}_${stageId}`;
        if (!stageStatsMap.has(key)) {
          stageStatsMap.set(key, {
            userId,
            stageId,
            totalCorrect: 0,
            totalAnswered: 0,
            lectures: new Set(),
            subjectStats: {},
          });
        }
        const curr = stageStatsMap.get(key)!;
        curr.totalCorrect += correctInDoc;
        curr.totalAnswered += answeredInDoc;
        curr.lectures.add(lectureId);

        if (!curr.subjectStats[subjectId]) {
          curr.subjectStats[subjectId] = { correct: 0, total: 0, lecturesAttempted: 0 };
        }
        curr.subjectStats[subjectId].correct += correctInDoc;
        curr.subjectStats[subjectId].total += answeredInDoc;
        curr.subjectStats[subjectId].lecturesAttempted++;
      }
    }
  }

  console.log(`Found ${stageStatsMap.size} user-stage pairs with answers.`);
  
  // Group by stageId to report
  const byStage: Record<string, number> = {};
  for (const item of stageStatsMap.values()) {
    byStage[item.stageId] = (byStage[item.stageId] || 0) + 1;
  }
  console.log('Breakdown by stageId:', byStage);

  const batch = db.batch();
  let writeCount = 0;

  for (const [key, item] of stageStatsMap.entries()) {
    const user = userMap.get(item.userId) || {};
    const isActiveInStage = user.stageId === item.stageId && user.graduated !== true;
    const rankScore = computeMcqRankScore(item.totalCorrect, item.totalAnswered);

    const docRef = db.collection('userStageMCQStats').doc(key);
    const payload: Record<string, any> = {
      userId: item.userId,
      stageId: item.stageId,
      isActiveInStage,
      totalFirstAttemptCorrect: item.totalCorrect,
      totalFirstAttemptAnswered: item.totalAnswered,
      lecturesAttempted: item.lectures.size,
      mcqLeaderboardScore: item.totalCorrect * 10,
      accuracy: item.totalAnswered > 0 ? (item.totalCorrect / item.totalAnswered) * 100 : 0,
      subjectStats: item.subjectStats,
      lastUpdated: FieldValue.serverTimestamp(),
    };
    if (rankScore !== null) {
      payload.mcqRankScore = rankScore;
    }

    if (item.stageId === 'stage_4') {
      console.log(`[STAGE 4 WRITE] ${key}: user=${user.name || item.userId}, active=${isActiveInStage}, correct=${item.totalCorrect}/${item.totalAnswered}, rankScore=${rankScore}`);
    }

    batch.set(docRef, payload, { merge: true });
    writeCount++;

    // If active in stage, also ensure userMCQStats has stageId set
    if (isActiveInStage) {
      const legacyRef = db.collection('userMCQStats').doc(item.userId);
      batch.set(legacyRef, {
        stageId: item.stageId,
        ...(rankScore !== null && { mcqRankScore: rankScore }),
      }, { merge: true });
    }
  }

  if (commit) {
    await batch.commit();
    console.log(`Successfully committed ${writeCount} records!`);
  } else {
    console.log(`Dry run complete. Use --commit to apply.`);
  }
}
run();
