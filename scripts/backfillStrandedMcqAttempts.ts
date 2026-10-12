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

export interface ReconciliationResult {
  scannedCompleted: number;
  provenAggregates: number;
  eligible: number;
  repaired: number;
  exact: number;
  preservedHigher: number;
  skippedBeforeAnnualReset: number;
  failed: number;
}

type ProvenAggregate = {
  userId: string;
  stageId: string;
  correct: number;
  total: number;
  lecturesAttempted: number;
  subjectStats: Record<string, { correct: number; total: number; lecturesAttempted: number }>;
};

function millis(value: any): number | null {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function isDeficient(existing: any, proven: ProvenAggregate): boolean {
  if (!existing) return true;
  if ((existing.totalFirstAttemptCorrect || 0) < proven.correct) return true;
  if ((existing.totalFirstAttemptAnswered || 0) < proven.total) return true;
  if ((existing.lecturesAttempted || 0) < proven.lecturesAttempted) return true;
  return Object.entries(proven.subjectStats).some(([subjectId, subject]) => {
    const current = existing.subjectStats?.[subjectId] || {};
    return (current.correct || 0) < subject.correct
      || (current.total || 0) < subject.total
      || (current.lecturesAttempted || 0) < subject.lecturesAttempted;
  });
}

/**
 * Reconstructs the minimum totals proven by completed first-attempt documents.
 * It only creates a missing stage row or raises a deficient field. Existing
 * higher totals are evidence we cannot safely reconstruct and are untouched.
 */
export async function reconcileCompletedMcqAttempts(
  db: Db,
  opts: { commit: boolean; academicYear?: string; annualResetAt?: any },
): Promise<ReconciliationResult> {
  const [answers, users, lectures, mcqs, stageRows] = await Promise.all([
    db.collectionGroup('lectures').get(),
    db.collection('users').get(),
    db.collection('lectures').get(),
    db.collection('mcqs').get(),
    db.collection('userStageMCQStats').get(),
  ]);
  const userById = new Map(users.docs.map(d => [d.id, d.data()]));
  const lectureById = new Map(lectures.docs.map(d => [d.id, d.data()]));
  const mcqById = new Map(mcqs.docs.map(d => [d.id, d.data()]));
  const existingById = new Map(stageRows.docs.map(d => [d.id, d.data()]));
  const resetAt = millis(opts.annualResetAt);
  const proven = new Map<string, ProvenAggregate>();
  let scannedCompleted = 0;
  let skippedBeforeAnnualReset = 0;

  for (const answer of answers.docs) {
    const parent = answer.ref.parent.parent;
    if (!parent || parent.parent.id !== 'userMCQAnswers') continue;
    const data = answer.data() || {};
    if (data.hasCompletedFirstAttempt !== true) continue;
    scannedCompleted++;
    const completedAt = millis(data.completedAt) ?? millis(data.createdAt)
      ?? millis(data.attempts?.[0]?.completedAt);
    if (resetAt !== null && (completedAt === null || completedAt <= resetAt)) {
      skippedBeforeAnnualReset++;
      continue;
    }

    const uid = parent.id;
    const lectureId = answer.id;
    const user = userById.get(uid) || {};
    const lecture = lectureById.get(lectureId) || {};
    const mcq = mcqById.get(lectureId) || {};
    const stageId = String(data.stageId || lecture.stageId || mcq.stageId || user.stageId || '');
    if (!stageId) continue;
    const locked = Object.values(data.lockedAnswers || {}) as any[];
    const total = Number(data.firstAttemptTotal ?? data.attempts?.[0]?.totalCount ?? locked.length);
    const correct = Number(data.firstAttemptCorrect
      ?? data.attempts?.[0]?.correctCount
      ?? locked.filter(value => value?.isCorrect === true).length);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(correct) || correct < 0) continue;
    const subjectId = String(data.subjectId || lecture.subjectId || mcq.subjectId || 'unknown');
    const key = `${uid}_${stageId}`;
    const item = proven.get(key) || {
      userId: uid, stageId, correct: 0, total: 0, lecturesAttempted: 0, subjectStats: {},
    };
    item.correct += correct;
    item.total += total;
    item.lecturesAttempted += 1;
    const subject = item.subjectStats[subjectId] || { correct: 0, total: 0, lecturesAttempted: 0 };
    subject.correct += correct;
    subject.total += total;
    subject.lecturesAttempted += 1;
    item.subjectStats[subjectId] = subject;
    proven.set(key, item);
  }

  const result: ReconciliationResult = {
    scannedCompleted,
    provenAggregates: proven.size,
    eligible: 0,
    repaired: 0,
    exact: 0,
    preservedHigher: 0,
    skippedBeforeAnnualReset,
    failed: 0,
  };

  for (const [docId, minimum] of proven) {
    const existing = existingById.get(docId);
    if (!isDeficient(existing, minimum)) {
      const isHigher = !!existing && (
        (existing.totalFirstAttemptCorrect || 0) > minimum.correct
        || (existing.totalFirstAttemptAnswered || 0) > minimum.total
        || (existing.lecturesAttempted || 0) > minimum.lecturesAttempted
      );
      if (isHigher) result.preservedHigher++;
      else result.exact++;
      continue;
    }
    result.eligible++;
    if (!opts.commit) continue;

    try {
      const repaired = await db.runTransaction(async tx => {
        const ref = db.collection('userStageMCQStats').doc(docId);
        const currentSnap = await tx.get(ref);
        const current = currentSnap.exists ? currentSnap.data() || {} : {};
        if (!isDeficient(currentSnap.exists ? current : null, minimum)) return false;
        const totalCorrect = Math.max(current.totalFirstAttemptCorrect || 0, minimum.correct);
        const totalAnswered = Math.max(current.totalFirstAttemptAnswered || 0, minimum.total);
        const lecturesAttempted = Math.max(current.lecturesAttempted || 0, minimum.lecturesAttempted);
        const subjectStats = { ...(current.subjectStats || {}) };
        for (const [subjectId, subject] of Object.entries(minimum.subjectStats)) {
          const old = subjectStats[subjectId] || {};
          subjectStats[subjectId] = {
            correct: Math.max(old.correct || 0, subject.correct),
            total: Math.max(old.total || 0, subject.total),
            lecturesAttempted: Math.max(old.lecturesAttempted || 0, subject.lecturesAttempted),
          };
        }
        const user = userById.get(minimum.userId) || {};
        tx.set(ref, {
          userId: minimum.userId,
          stageId: minimum.stageId,
          isActiveInStage: user.stageId === minimum.stageId && user.graduated !== true,
          totalFirstAttemptCorrect: totalCorrect,
          totalFirstAttemptAnswered: totalAnswered,
          lecturesAttempted,
          mcqLeaderboardScore: totalCorrect * 10,
          accuracy: (totalCorrect / Math.max(1, totalAnswered)) * 100,
          mcqRankScore: Math.round((totalCorrect * totalCorrect * 100) / Math.max(1, totalAnswered)),
          subjectStats,
          academicYear: current.academicYear || opts.academicYear || null,
          lastUpdated: FieldValue.serverTimestamp(),
          reconciledAt: FieldValue.serverTimestamp(),
          reconciledBy: 'reconcileCompletedMcqAttempts',
        }, { merge: true });
        return true;
      });
      if (repaired) result.repaired++;
    } catch (error) {
      result.failed++;
      console.error(`Failed to reconcile ${docId}:`, error instanceof Error ? error.message : error);
    }
  }
  return result;
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
  const [calendar, streakSettings] = await Promise.all([
    db.collection('app_settings').doc('academicCalendar').get(),
    db.collection('app_settings').doc('streak').get(),
  ]);
  const academicYear = calendar.data()?.yearLabel;
  const stranded = await backfillStrandedMcqAttempts(db, {
    commit,
    academicYear,
  });
  const reconciliation = await reconcileCompletedMcqAttempts(db, {
    commit,
    academicYear,
    annualResetAt: streakSettings.data()?.yearWipedAt,
  });
  console.log(JSON.stringify({
    mode: commit ? 'COMMIT' : 'DRY_RUN',
    stranded,
    reconciliation,
  }, null, 2));
  if (stranded.failed || reconciliation.failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
