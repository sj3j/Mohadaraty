/**
 * Server-side student profile initialization. A purchase or account action can
 * create users/{uid} before the client first-login initializer runs. That
 * initializer sees an existing document and leaves the profile incomplete, so
 * stage-scoped Firestore reads fail even though students/{id} is correct.
 */
import { carriedProgressionFields } from './progression.js';

export interface StudentProfileSource {
  studentId: string;
  stageId?: string | null;
}

const FRESH_STREAK_FIELDS = {
  streakCount: 0,
  longestStreak: 0,
  bestStreakAllTime: 0,
  freezeTokens: 3,
  lastActiveDate: null,
};

function needsFill(key: string, current: unknown, replacement: unknown): boolean {
  if (current === undefined) return true;
  if (replacement === null || replacement === '') return false;
  return (current === null || current === '') &&
    ['email', 'role', 'name', 'originalName', 'stageId', 'group', 'examCode'].includes(key);
}

/** Only absent fields are filled. A populated but different stage is left for review. */
export function studentProfilePatch(
  studentId: string,
  student: FirebaseFirestore.DocumentData,
  current: FirebaseFirestore.DocumentData | null,
  createdAt: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue,
): Record<string, unknown> {
  if (student.isActive === false || student.mergedInto || !student.stageId ||
      (student.role && student.role !== 'student')) return {};
  if (current?.stageId && current.stageId !== student.stageId) return {};
  if (current?.email && String(current.email).toLowerCase() !== studentId.toLowerCase()) return {};
  if (current?.role && current.role !== 'student') return {};

  const initial: Record<string, unknown> = {
    email: studentId,
    role: 'student',
    name: student.name || 'Student',
    originalName: student.name || 'Student',
    examCode: student.examCode || '',
    stageId: student.stageId,
    ...(student.subgroup ? { group: student.subgroup } : {}),
    ...carriedProgressionFields(student),
    createdAt,
    favorites: [],
    studied: [],
    completedWeeklyTasks: [],
    ...FRESH_STREAK_FIELDS,
    notificationPreferences: { lectures: true, announcements: true },
  };
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(initial)) {
    if (value !== undefined && (!current || needsFill(key, current[key], value))) patch[key] = value;
  }
  return patch;
}

/** Read and write in one transaction so progression or a profile edit wins races. */
export async function reconcileStudentProfile(
  db: FirebaseFirestore.Firestore,
  uid: string,
  studentId: string,
  serverTimestamp: () => FirebaseFirestore.FieldValue,
): Promise<'created' | 'repaired' | 'unchanged' | 'conflict'> {
  return db.runTransaction(async transaction => {
    const studentRef = db.collection('students').doc(studentId);
    const userRef = db.collection('users').doc(uid);
    const studentSnap = await transaction.get(studentRef);
    const userSnap = await transaction.get(userRef);
    const student = studentSnap.data();
    if (!studentSnap.exists || !student || student.isActive === false || student.mergedInto || !student.stageId ||
        (student.role && student.role !== 'student')) {
      return 'conflict';
    }
    const current = userSnap.exists ? userSnap.data() || {} : null;
    if (current?.stageId && current.stageId !== student.stageId) return 'conflict';
    if (current?.email && String(current.email).toLowerCase() !== studentId.toLowerCase()) return 'conflict';
    if (current?.role && current.role !== 'student') return 'conflict';

    const patch = studentProfilePatch(
      studentId, student, current,
      userSnap.exists ? userSnap.createTime || serverTimestamp() : serverTimestamp(),
    );
    if (Object.keys(patch).length === 0) return 'unchanged';
    transaction.set(userRef, patch, { merge: true });
    return userSnap.exists ? 'repaired' : 'created';
  });
}
