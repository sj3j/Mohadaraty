/**
 * One-time repair for the confirmed 2026-2027 Stage 3 -> Stage 4 progression
 * incident caused by blank users.email values.
 *
 * Dry run (default):
 *   npx tsx scripts/reconcileProgressionStages.ts
 *
 * Commit only after the dry run reports the reviewed count:
 *   npx tsx scripts/reconcileProgressionStages.ts --commit --expected-count 28
 */
import 'dotenv/config';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { pathToFileURL } from 'node:url';

export const INCIDENT_YEAR = '2026-2027';
export const INCIDENT_FROM_STAGE = 'stage_3';
export const INCIDENT_TO_STAGE = 'stage_4';

export interface ProgressionRepairCandidate {
  uid: string;
  studentId: string;
  hasLegacyStats: boolean;
}

export interface ProgressionRepairInspection {
  candidates: ProgressionRepairCandidate[];
  pending: string[];
  inverse: string[];
  missingDirectRoster: string[];
  ineligibleDirectRoster: string[];
}

const clean = (value: unknown): string => String(value || '').toLowerCase().trim();

/** Read-only incident inspection. Exported so the emulator suite tests the exact CLI logic. */
export async function inspectProgressionStageIncident(
  db: FirebaseFirestore.Firestore,
): Promise<ProgressionRepairInspection> {
  const [users, students, stats] = await Promise.all([
    db.collection('users').get(),
    db.collection('students').get(),
    db.collection('userMCQStats').select().get(),
  ]);
  const studentsById = new Map(students.docs.map(doc => [doc.id, doc]));
  const statsIds = new Set(stats.docs.map(doc => doc.id));
  const result: ProgressionRepairInspection = {
    candidates: [], pending: [], inverse: [],
    missingDirectRoster: [], ineligibleDirectRoster: [],
  };

  for (const userDoc of users.docs) {
    const user = userDoc.data() || {};
    const roster = studentsById.get(userDoc.id);
    const rosterData = roster?.data() || {};

    if (user.stageId === INCIDENT_FROM_STAGE &&
        user.pendingStageId === INCIDENT_TO_STAGE &&
        user.pendingProgressionYear === INCIDENT_YEAR) {
      result.pending.push(userDoc.id);
    }
    if (user.stageId === INCIDENT_FROM_STAGE && rosterData.stageId === INCIDENT_TO_STAGE) {
      result.inverse.push(userDoc.id);
    }

    const incidentSignature = user.stageId === INCIDENT_TO_STAGE &&
      user.progressionState === 'completed' &&
      user.progressionYear === INCIDENT_YEAR &&
      clean(user.email) === '';
    if (!incidentSignature) continue;
    if (!roster) {
      result.missingDirectRoster.push(userDoc.id);
      continue;
    }
    if (rosterData.stageId !== INCIDENT_FROM_STAGE || rosterData.isActive === false || rosterData.mergedInto) {
      result.ineligibleDirectRoster.push(userDoc.id);
      continue;
    }
    result.candidates.push({
      uid: userDoc.id,
      studentId: roster.id,
      hasLegacyStats: statsIds.has(userDoc.id),
    });
  }

  for (const values of [
    result.candidates,
    result.pending,
    result.inverse,
    result.missingDirectRoster,
    result.ineligibleDirectRoster,
  ]) {
    values.sort((a: any, b: any) => String(a.uid || a).localeCompare(String(b.uid || b)));
  }
  return result;
}

export interface ProgressionRepairResult {
  repaired: number;
  skippedChanged: number;
  skippedInvalid: number;
}

/**
 * Re-read each candidate transactionally. A concurrent admin edit wins and is
 * reported instead of being overwritten by the repair.
 */
export async function commitProgressionStageIncident(
  db: FirebaseFirestore.Firestore,
  expectedCount: number,
  inspection?: ProgressionRepairInspection,
): Promise<ProgressionRepairResult> {
  const reviewed = inspection || await inspectProgressionStageIncident(db);
  if (!Number.isInteger(expectedCount) || expectedCount < 0 || expectedCount !== reviewed.candidates.length) {
    throw new Error(
      `Commit requires --expected-count ${reviewed.candidates.length} for the current dry-run result.`,
    );
  }

  const result: ProgressionRepairResult = { repaired: 0, skippedChanged: 0, skippedInvalid: 0 };
  for (const candidate of reviewed.candidates) {
    const outcome = await db.runTransaction(async transaction => {
      const userRef = db.collection('users').doc(candidate.uid);
      const studentRef = db.collection('students').doc(candidate.studentId);
      const statsRef = db.collection('userMCQStats').doc(candidate.uid);
      const [userSnap, studentSnap, statsSnap] = await Promise.all([
        transaction.get(userRef),
        transaction.get(studentRef),
        transaction.get(statsRef),
      ]);
      if (!userSnap.exists || !studentSnap.exists) return 'skippedInvalid' as const;

      const user = userSnap.data() || {};
      const student = studentSnap.data() || {};
      const stillEligible = user.stageId === INCIDENT_TO_STAGE &&
        user.progressionState === 'completed' &&
        user.progressionYear === INCIDENT_YEAR &&
        clean(user.email) === '' &&
        studentSnap.id === userSnap.id &&
        student.stageId === INCIDENT_FROM_STAGE &&
        student.isActive !== false &&
        !student.mergedInto;
      if (!stillEligible) return 'skippedChanged' as const;

      transaction.update(studentRef, {
        stageId: INCIDENT_TO_STAGE,
        subgroup: FieldValue.delete(),
        tahmeelSubjects: Array.isArray(user.tahmeelSubjects) ? user.tahmeelSubjects : [],
        tahmeelStageId: user.tahmeelStageId || FieldValue.delete(),
      });
      transaction.update(userRef, { email: candidate.studentId });
      if (statsSnap.exists) {
        transaction.update(statsRef, {
          stageId: INCIDENT_TO_STAGE,
          lastUpdated: FieldValue.serverTimestamp(),
        });
      }
      return 'repaired' as const;
    });
    result[outcome]++;
  }
  return result;
}

function printInspection(project: string, commit: boolean, inspection: ProgressionRepairInspection) {
  console.log(JSON.stringify({
    project,
    mode: commit ? 'commit' : 'dry-run',
    incident: {
      year: INCIDENT_YEAR,
      from: INCIDENT_FROM_STAGE,
      to: INCIDENT_TO_STAGE,
    },
    eligible: inspection.candidates.length,
    candidates: inspection.candidates.map(candidate => candidate.uid),
    pendingExcluded: inspection.pending,
    inverseReportOnly: inspection.inverse,
    missingDirectRoster: inspection.missingDirectRoster,
    ineligibleDirectRoster: inspection.ineligibleDirectRoster,
  }, null, 2));
}

async function main() {
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    throw new Error('Firebase Admin credentials are required.');
  }
  if (getApps().length === 0) {
    initializeApp({
      credential: cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
      projectId: FIREBASE_PROJECT_ID,
    });
  }
  const db = getFirestore();
  const commit = process.argv.includes('--commit');
  const expectedIndex = process.argv.indexOf('--expected-count');
  const expectedCount = expectedIndex >= 0 ? Number(process.argv[expectedIndex + 1]) : Number.NaN;
  const inspection = await inspectProgressionStageIncident(db);
  printInspection(FIREBASE_PROJECT_ID, commit, inspection);
  if (!commit) return;
  const result = await commitProgressionStageIncident(db, expectedCount, inspection);
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main().then(() => process.exit(0)).catch(error => {
    console.error(error);
    process.exit(1);
  });
}
