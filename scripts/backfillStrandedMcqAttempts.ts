/**
 * Repairs first attempts whose 20+ answers were locked but whose final
 * transaction failed before hasCompletedFirstAttempt was set.
 *
 * Dry-run (default): npm run mcq:backfill-stranded
 * Commit:            npm run mcq:backfill-stranded -- --commit
 */
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { pathToFileURL } from 'node:url';
import 'dotenv/config';

type Db = FirebaseFirestore.Firestore;

export interface BackfillResult {
  scanned: number;
  eligible: number;
  repaired: number;
  skippedCompleted: number;
  failed: number;
}

function aggregate(existing: any, subjectId: string, correct: number, total: number) {
  const totalCorrect = (existing?.totalFirstAttemptCorrect || 0) + correct;
  const totalAnswered = (existing?.totalFirstAttemptAnswered || 0) + total;
  const subjectStats = { ...(existing?.subjectStats || {}) };
  const previous = subjectStats[subjectId] || {};
  subjectStats[subjectId] = {
    correct: (previous.correct || 0) + correct,
    total: (previous.total || 0) + total,
    lecturesAttempted: (previous.lecturesAttempted || 0) + 1,
  };
  return {
    totalFirstAttemptCorrect: totalCorrect,
    totalFirstAttemptAnswered: totalAnswered,
    lecturesAttempted: (existing?.lecturesAttempted || 0) + 1,
    mcqLeaderboardScore: totalCorrect * 10,
    accuracy: (totalCorrect / Math.max(1, totalAnswered)) * 100,
    mcqRankScore: Math.round((totalCorrect * totalCorrect * 100) / totalAnswered),
    subjectStats,
    lastUpdated: FieldValue.serverTimestamp(),
  };
}

export async function backfillStrandedMcqAttempts(
  db: Db,
  opts: { commit: boolean; minimumLockedAnswers?: number; academicYear?: string },
): Promise<BackfillResult> {
  const minimum = opts.minimumLockedAnswers ?? 20;
  const allLectures = await db.collectionGroup('lectures').get();
  const candidates = allLectures.docs.filter(answer => {
    const parent = answer.ref.parent.parent;
    if (!parent || parent.parent.id !== 'userMCQAnswers') return false;
    const data = answer.data() || {};
    return data.hasCompletedFirstAttempt !== true
      && Object.keys(data.lockedAnswers || {}).length >= minimum;
  });

  const result: BackfillResult = {
    scanned: allLectures.size,
    eligible: candidates.length,
    repaired: 0,
    skippedCompleted: 0,
    failed: 0,
  };
  if (!opts.commit) return result;

  for (const candidate of candidates) {
    try {
      const repaired = await db.runTransaction(async tx => {
        const answer = await tx.get(candidate.ref);
        const answerData = answer.data() || {};
        if (!answer.exists || answerData.hasCompletedFirstAttempt === true) return false;

        const uid = candidate.ref.parent.parent!.id;
        const lectureId = candidate.id;
        const userRef = db.collection('users').doc(uid);
        const lectureRef = db.collection('lectures').doc(lectureId);
        const mcqRef = db.collection('mcqs').doc(lectureId);
        const legacyRef = db.collection('userMCQStats').doc(uid);

        // Read phase. Do not put a tx.set/tx.update above these gets.
        const user = await tx.get(userRef);
        const lecture = await tx.get(lectureRef);
        const mcq = await tx.get(mcqRef);
        const legacy = await tx.get(legacyRef);
        const stageId = String(
          answerData.stageId || lecture.data()?.stageId || mcq.data()?.stageId || user.data()?.stageId || '',
        );
        if (!stageId) throw new Error(`Cannot determine stage for ${candidate.ref.path}`);
        const stageRef = db.collection('userStageMCQStats').doc(`${uid}_${stageId}`);
        const stage = await tx.get(stageRef);

        const locked = answerData.lockedAnswers || {};
        const entries = Object.entries(locked) as Array<[string, any]>;
        if (entries.length < minimum) return false;
        const correct = entries.filter(([, value]) => value?.isCorrect === true).length;
        const total = entries.length;
        const subjectId = String(
          answerData.subjectId || lecture.data()?.subjectId || mcq.data()?.subjectId || 'unknown',
        );
        const completedAt = new Date().toISOString();
        const attempt = {
          attemptNumber: 1,
          startedAt: answerData.createdAt || completedAt,
          completedAt,
          answers: Object.fromEntries(entries.map(([id, value]) => [id, { ...value, isFirstAttempt: true }])),
          score: (correct / total) * 100,
          correctCount: correct,
          totalCount: total,
        };

        // Write phase.
        tx.set(stageRef, {
          userId: uid,
          stageId,
          isActiveInStage: user.data()?.stageId === stageId && user.data()?.graduated !== true,
          ...(opts.academicYear ? { academicYear: opts.academicYear } : {}),
          ...aggregate(stage.exists ? stage.data() : null, subjectId, correct, total),
        }, { merge: true });
        tx.set(legacyRef, {
          userId: uid,
          stageId,
          ...aggregate(legacy.exists ? legacy.data() : null, subjectId, correct, total),
        }, { merge: true });
        tx.set(candidate.ref, {
          lectureId,
          userId: uid,
          subjectId,
          attempts: [attempt],
          firstAttemptScore: attempt.score,
          firstAttemptCorrect: correct,
          firstAttemptTotal: total,
          hasCompletedFirstAttempt: true,
          totalAttempts: 1,
          completedAt: FieldValue.serverTimestamp(),
          repairedBy: 'backfillStrandedMcqAttempts',
          repairedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return true;
      });
      if (repaired) result.repaired++;
      else result.skippedCompleted++;
    } catch (error) {
      result.failed++;
      console.error(`Failed ${candidate.ref.path}:`, error instanceof Error ? error.message : error);
    }
  }
  return result;
}

async function main() {
  const commit = process.argv.includes('--commit');
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) throw new Error('Firebase Admin credentials are missing');
  if (!getApps().length) initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), projectId });
  const db = getFirestore();
  const calendar = await db.collection('app_settings').doc('academicCalendar').get();
  const result = await backfillStrandedMcqAttempts(db, {
    commit,
    academicYear: calendar.data()?.yearLabel,
  });
  console.log(JSON.stringify({ mode: commit ? 'COMMIT' : 'DRY_RUN', ...result }, null, 2));
  if (result.failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
