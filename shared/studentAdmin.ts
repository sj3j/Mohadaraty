/**
 * Administrative actions on a student, shared by both API surfaces.
 *
 * These run with the Admin SDK and therefore bypass firestore.rules entirely,
 * so the stage boundary the rules enforce has to be re-enforced here by hand.
 * `callerStage(req)` is the only trustworthy source of the caller's stage - a
 * stageId from the request body is whatever the caller decided to send.
 */
import bcrypt from 'bcryptjs';
import { generatePassword } from './rosterIdentity.js';
import { hasStageCapability, hasStaffCapability } from './staffCapabilities.js';
import { GroupConfigLike, FALLBACK_GROUP_CONFIG, isValidSubgroup, normalizeSubgroup } from './groups.js';
import { completedProgressionFields } from './progression.js';
import { loadCalendar } from './seasonRollover.js';

export class StudentAdminError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string) {
    super(message);
  }
}

/** The shape verifyAdmin attaches to the request as `req.staff`. */
export interface CallerStage {
  isMasterAdmin: boolean;
  /** Cross-stage without being the master admin. */
  isSupport?: boolean;
  role?: string;
  managedStageId?: string | null;
  permissions?: Record<string, boolean>;
  staffDisabled?: boolean;
}

/** Whether a caller may manage students at all. Stage scope is separate. */
export function assertStudentManagement(staff: CallerStage): void {
  if (!hasStaffCapability(staff, 'manageStudents')) {
    throw new StudentAdminError(
      'Your account is not granted student management.', 403, 'NOT_GRANTED');
  }
}

/** Master/support callers with the capability are intentionally cross-stage. */
export function hasGlobalStudentScope(staff: CallerStage): boolean {
  assertStudentManagement(staff);
  return staff.isMasterAdmin === true || staff.role === 'master_admin' || staff.role === 'support';
}

/**
 * Refuses a caller acting outside the stage they manage.
 *
 * A master admin acts anywhere. A representative with no managedStageId
 * manages nothing and acts nowhere - the same stance firestore.rules takes,
 * deliberately without an unassigned fallback.
 *
 * This is the shared choke point for both API surfaces, so the support arm
 * here covers server.ts and api/index.ts at once. It is checked BEFORE the
 * managedStageId comparison, and that ordering is the whole point: a support
 * account promoted from a representative still carries managedStageId, so
 * falling through would let them act on their old stage and nothing else -
 * which reads as "the role does not work" rather than as an authorisation bug.
 *
 * The capability is required, not assumed: this module resets passwords and
 * writes the students whitelist, which holds hashes.
 */
export function assertStageAuthority(staff: CallerStage, targetStageId?: string | null): void {
  assertStudentManagement(staff);
  if (hasStageCapability(staff, 'manageStudents', targetStageId)) return;
  if (!staff.managedStageId) {
    throw new StudentAdminError('You are not assigned to a stage.', 403, 'NO_STAGE');
  }
  throw new StudentAdminError(
    'You may only act on students in your own stage.', 403, 'WRONG_STAGE');
}

export interface ResetResult {
  /** Plaintext, returned exactly once. Never stored, never logged. */
  password: string;
  name: string;
  loginCode: string;
}

export interface TahmeelUpdateResult {
  studentEmail: string;
  stageId: string;
  tahmeelStageId: string | null;
  tahmeelSubjects: string[];
  usersUpdated: number;
}

/** Replaces the carried-subject selection for one student. */
export async function updateStudentTahmeel(
  db: FirebaseFirestore.Firestore,
  FieldValue: { delete(): any; serverTimestamp(): any },
  studentEmail: string,
  requestedSubjects: unknown,
  staff: CallerStage,
): Promise<TahmeelUpdateResult> {
  if (!hasGlobalStudentScope(staff)) {
    throw new StudentAdminError('Only Support or a master administrator may edit carried subjects.', 403, 'GLOBAL_SCOPE_REQUIRED');
  }

  const email = String(studentEmail || '').toLowerCase().trim();
  if (!email) throw new StudentAdminError('Student email is required.', 400, 'MISSING_ID');
  if (!Array.isArray(requestedSubjects)) {
    throw new StudentAdminError('tahmeelSubjects must be an array.', 400, 'INVALID_TAHMEEL_SUBJECTS');
  }
  const subjects = Array.from(new Set(requestedSubjects.map(value => String(value).trim()).filter(Boolean)));
  if (subjects.length > 20 || subjects.some(value => value.length > 100)) {
    throw new StudentAdminError('Invalid carried subjects.', 400, 'INVALID_TAHMEEL_SUBJECTS');
  }

  const studentRef = db.collection('students').doc(email);
  const studentSnap = await studentRef.get();
  if (!studentSnap.exists) throw new StudentAdminError('Student not found.', 404, 'NOT_FOUND');
  const stageId = String(studentSnap.data()?.stageId || '');
  if (!stageId) throw new StudentAdminError('Student has no current stage.', 409, 'MISSING_STAGE');

  const stagesSnap = await db.collection('stages').orderBy('order', 'asc').get();
  const stages = stagesSnap.docs.map(doc => ({ id: String(doc.data().id || doc.id), order: Number(doc.data().order) }));
  const current = stages.find(stage => stage.id === stageId);
  if (!current || !Number.isFinite(current.order)) {
    throw new StudentAdminError('Student stage is not recognised.', 409, 'INVALID_STAGE');
  }
  const previous = stages
    .filter(stage => Number.isFinite(stage.order) && stage.order < current.order)
    .sort((a, b) => b.order - a.order)[0];
  if (subjects.length > 0 && !previous) {
    throw new StudentAdminError('The first stage has no previous-stage subjects.', 400, 'NO_PREVIOUS_STAGE');
  }

  if (subjects.length > 0) {
    const validSnap = await db.collection('subjects').where('stageId', '==', previous!.id).get();
    const valid = new Set(validSnap.docs
      .filter(doc => doc.data()?.isActive !== false)
      .map(doc => String(doc.data()?.id || doc.id.replace(`${previous!.id}__`, ''))));
    const unknown = subjects.filter(subject => !valid.has(subject));
    if (unknown.length) {
      throw new StudentAdminError(`Invalid carried subjects: ${unknown.join(', ')}`, 400, 'INVALID_TAHMEEL_SUBJECTS');
    }
  }

  const userMap = new Map<string, FirebaseFirestore.DocumentSnapshot>();
  const directUser = await db.collection('users').doc(email).get();
  if (directUser.exists) userMap.set(directUser.id, directUser);
  const usersByEmail = await db.collection('users').where('email', '==', email).get();
  usersByEmail.docs.forEach(doc => userMap.set(doc.id, doc));

  const patch = {
    tahmeelSubjects: subjects,
    tahmeelStageId: subjects.length > 0 ? previous!.id : FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const batch = db.batch();
  batch.set(studentRef, patch, { merge: true });
  userMap.forEach(doc => batch.set(doc.ref, patch, { merge: true }));
  await batch.commit();

  return {
    studentEmail: email,
    stageId,
    tahmeelStageId: subjects.length > 0 ? previous!.id : null,
    tahmeelSubjects: subjects,
    usersUpdated: userMap.size,
  };
}

/**
 * Issues a replacement password for one student.
 *
 * Passwords are stored hashed, so a student who loses the slip they were handed
 * cannot be told it again - only given a new one. The replacement is generated
 * here rather than accepted from the caller, so a representative cannot set a
 * password they choose (and therefore already know) on someone else's account,
 * and `mustChangePassword` makes it as short-lived as an imported one.
 *
 * bcrypt, not the SHA-256 the browser importer uses: this runs on a server.
 */
export async function resetStudentPassword(
  db: FirebaseFirestore.Firestore,
  studentId: string,
  staff: CallerStage,
): Promise<ResetResult> {
  const id = (studentId || '').toLowerCase().trim();
  if (!id) throw new StudentAdminError('Student id is required.', 400, 'MISSING_ID');

  const ref = db.collection('students').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new StudentAdminError('Student not found.', 404, 'NOT_FOUND');

  const data = snap.data() || {};
  assertStageAuthority(staff, data.stageId);

  const password = generatePassword();
  await ref.update({
    password: await bcrypt.hash(password, 10),
    mustChangePassword: true,
  });

  return { password, name: data.name || '', loginCode: data.loginCode || '' };
}

export type StageTransferType = 'correction' | 'manual_promotion' | 'retention';
export type TahmeelHandling = 'clear' | 'preserve';

export interface TransferActor {
  uid: string;
  email: string;
  name: string;
}

export interface TransferStudentOptions {
  studentEmail: string;
  targetStageId: string;
  expectedCurrentStageId: string;
  targetSubgroup?: string | null;
  transferType?: StageTransferType;
  tahmeelHandling?: TahmeelHandling;
  staff: CallerStage;
  actor: TransferActor;
  reason?: string;
}

export interface TransferStudentResult {
  email: string;
  previousStageId: string;
  targetStageId: string;
  targetSubgroup: string | null;
  transferType: StageTransferType;
  rosterUpdated: number;
  usersUpdated: number;
  statsUpdated: number;
  rolesVacated: number;
  wasStaffVacated: boolean;
  vacatedRole: string | null;
}

const TRANSFER_TYPES: readonly StageTransferType[] = ['correction', 'manual_promotion', 'retention'];
const TAHMEEL_HANDLING: readonly TahmeelHandling[] = ['clear', 'preserve'];

const normalString = (value: unknown, field: string, max: number, required = false): string => {
  if (value == null || value === '') {
    if (required) throw new StudentAdminError(`${field} is required.`, 400, `MISSING_${field.toUpperCase()}`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new StudentAdminError(`${field} must be a string.`, 400, 'INVALID_INPUT');
  }
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > max) {
    throw new StudentAdminError(`${field} is invalid.`, 400, 'INVALID_INPUT');
  }
  return normalized;
};

const historyFromStats = (
  stats: FirebaseFirestore.DocumentData,
  yearLabel: string,
  stageId: string,
  reason: string,
  timestamp: any,
) => ({
  yearLabel,
  stageId,
  totalFirstAttemptCorrect: stats.totalFirstAttemptCorrect || 0,
  totalFirstAttemptAnswered: stats.totalFirstAttemptAnswered || 0,
  lecturesAttempted: stats.lecturesAttempted || 0,
  mcqLeaderboardScore: stats.mcqLeaderboardScore || 0,
  scoreModel: 'correct_x10_v1',
  mcqRankScore: stats.mcqRankScore ?? null,
  accuracy: stats.accuracy || 0,
  subjectStats: stats.subjectStats || {},
  reason,
  archivedAt: timestamp,
});

/**
 * Concurrency-safe, transactional transfer of an individual student to another stage.
 *
 * Enforces:
 * 1. Global student management authorization (Master Admin or Support).
 * 2. Precondition check on expectedCurrentStageId to prevent clobbering concurrent changes.
 * 3. Validation of targetSubgroup against target stage's groupConfig.
 * 4. Atomic updates across `students/{email}` (whitelist authority) and all `users` docs.
 * 5. Preservation of global roles (Master Admin / Support) while safely vacating stage-scoped
 *    seats (representative/moderator for the departing stage).
 * 6. Academic progression and carried subjects (tahmeel) semantics tailored to the transfer type.
 * 7. Active MCQ leaderboard isolation (marking previous stage stats inactive, activating destination).
 * 8. Immutable audit entry in `adminLogs`.
 */
export async function transferStudentStage(
  db: FirebaseFirestore.Firestore,
  FieldValue: { serverTimestamp(): any; delete(): any },
  opts: TransferStudentOptions,
): Promise<TransferStudentResult> {
  const {
    studentEmail,
    targetStageId,
    expectedCurrentStageId,
    targetSubgroup,
    transferType = 'correction',
    tahmeelHandling = 'clear',
    staff,
    actor,
    reason,
  } = opts;

  if (!hasGlobalStudentScope(staff)) {
    throw new StudentAdminError(
      'Only master administrators or authorized support staff can transfer students across stages.',
      403,
      'INSUFFICIENT_PERMISSIONS',
    );
  }

  const requestedEmail = normalString(studentEmail, 'studentEmail', 320, true).toLowerCase();
  const destinationId = normalString(targetStageId, 'targetStageId', 100, true);
  if (expectedCurrentStageId == null || expectedCurrentStageId === '') {
    throw new StudentAdminError(
      'expectedCurrentStageId is required.', 400, 'MISSING_EXPECTED_CURRENT_STAGE_ID');
  }
  const expectedStage = normalString(expectedCurrentStageId, 'expectedCurrentStageId', 100, true);
  const note = normalString(reason, 'reason', 500);
  if (!TRANSFER_TYPES.includes(transferType)) {
    throw new StudentAdminError('Unknown transfer type.', 400, 'INVALID_TRANSFER_TYPE');
  }
  if (!TAHMEEL_HANDLING.includes(tahmeelHandling)) {
    throw new StudentAdminError('Unknown tahmeel handling.', 400, 'INVALID_TAHMEEL_HANDLING');
  }
  if (targetSubgroup != null && typeof targetSubgroup !== 'string') {
    throw new StudentAdminError('targetSubgroup must be a string or null.', 400, 'INVALID_SUBGROUP');
  }
  if (!actor || !normalString(actor.uid, 'actorUid', 256, true)) {
    throw new StudentAdminError('Verified actor identity is required.', 403, 'MISSING_ACTOR');
  }

  // Resolve a merged-away roster id before entering the transaction. The
  // transaction re-reads the pointer, so a concurrent merge becomes a conflict
  // rather than moving the wrong student.
  const requestedRef = db.collection('students').doc(requestedEmail);
  const requestedPre = await requestedRef.get();
  if (!requestedPre.exists) {
    throw new StudentAdminError('Student record not found in roster.', 404, 'STUDENT_NOT_FOUND');
  }
  const mergedInto = String(requestedPre.data()?.mergedInto || '').toLowerCase().trim();
  const canonicalEmail = mergedInto || requestedEmail;
  const studentRef = db.collection('students').doc(canonicalEmail);
  const calendar = await loadCalendar(db);
  const auditRef = db.collection('adminLogs').doc();

  return await db.runTransaction(async (tx) => {
    const requestedSnap = requestedEmail === canonicalEmail ? null : await tx.get(requestedRef);
    const studentSnap = await tx.get(studentRef);
    if (!studentSnap.exists) {
      throw new StudentAdminError('Student record not found in roster.', 404, 'STUDENT_NOT_FOUND');
    }
    if (requestedSnap && String(requestedSnap.data()?.mergedInto || '').toLowerCase().trim() !== canonicalEmail) {
      throw new StudentAdminError('Student identity changed during transfer.', 409, 'STAGE_CONFLICT');
    }
    const studentData = studentSnap.data() || {};
    const previousStageId = String(studentData.stageId || '');

    if (previousStageId !== expectedStage) {
      throw new StudentAdminError(
        `Student is now in "${previousStageId}" instead of "${expectedStage}". Refresh and try again.`,
        409,
        'STAGE_CONFLICT',
      );
    }

    if (!previousStageId) {
      throw new StudentAdminError('Student has no current stage.', 409, 'MISSING_CURRENT_STAGE');
    }
    if (previousStageId === destinationId) {
      throw new StudentAdminError(
        'Student is already enrolled in the target stage.',
        409,
        'ALREADY_IN_STAGE',
      );
    }

    const [targetStageSnap, previousStageSnap, retiredAliasesSnap] = await Promise.all([
      tx.get(db.collection('stages').doc(destinationId)),
      tx.get(db.collection('stages').doc(previousStageId)),
      tx.get(db.collection('students').where('mergedInto', '==', canonicalEmail)),
    ]);
    if (!targetStageSnap.exists) {
      throw new StudentAdminError('Target stage does not exist.', 404, 'STAGE_NOT_FOUND');
    }
    if (!previousStageSnap.exists) {
      throw new StudentAdminError('Current stage does not exist.', 409, 'CURRENT_STAGE_NOT_FOUND');
    }

    const groupConfig: GroupConfigLike = targetStageSnap.data()?.groupConfig || FALLBACK_GROUP_CONFIG;
    let resolvedSubgroup: string | null = null;
    if (targetSubgroup?.trim()) {
      const normalized = normalizeSubgroup(targetSubgroup);
      if (!normalized || !isValidSubgroup(groupConfig, normalized)) {
        throw new StudentAdminError(
          `"${targetSubgroup}" is not a valid subgroup for ${destinationId}.`,
          400,
          'INVALID_SUBGROUP',
        );
      }
      resolvedSubgroup = normalized;
    }

    const aliases = new Set<string>([canonicalEmail, requestedEmail]);
    const addAlias = (value: unknown) => {
      const alias = typeof value === 'string' ? value.toLowerCase().trim() : '';
      if (alias) aliases.add(alias);
    };
    addAlias(studentData.googleEmail);
    for (const aliasDoc of retiredAliasesSnap.docs) {
      aliases.add(aliasDoc.id.toLowerCase());
      addAlias(aliasDoc.data()?.googleEmail);
    }

    const userDocMap = new Map<string, FirebaseFirestore.DocumentSnapshot>();
    for (const alias of aliases) {
      const [directUser, usersByEmail] = await Promise.all([
        tx.get(db.collection('users').doc(alias)),
        tx.get(db.collection('users').where('email', '==', alias)),
      ]);
      if (directUser.exists) userDocMap.set(directUser.id, directUser);
      for (const doc of usersByEmail.docs) userDocMap.set(doc.id, doc);
    }
    const userSnaps = Array.from(userDocMap.values());
    if (userSnaps.length > 50) {
      throw new StudentAdminError('Too many linked accounts; merge duplicates first.', 409, 'TOO_MANY_LINKED_ACCOUNTS');
    }

    const allowedAdminSnaps: FirebaseFirestore.DocumentSnapshot[] = [];
    for (const alias of aliases) {
      const snap = await tx.get(db.collection('allowed_admins').doc(alias));
      if (snap.exists) allowedAdminSnaps.push(snap);
    }

    let finalTahmeel: string[] = [];
    if (tahmeelHandling === 'preserve') {
      const previousOrder = Number(previousStageSnap.data()?.order);
      const targetOrder = Number(targetStageSnap.data()?.order);
      if (transferType !== 'manual_promotion' || !Number.isFinite(previousOrder)
          || !Number.isFinite(targetOrder) || targetOrder <= previousOrder) {
        throw new StudentAdminError(
          'Carried subjects may only be preserved during an upward manual promotion.',
          400,
          'INVALID_TAHMEEL_PRESERVATION',
        );
      }
      const requestedSubjects = new Set<string>();
      const tahmeelOwners = [studentData, ...userSnaps.map(snap => snap.data() || {})];
      for (const owner of tahmeelOwners) {
        const values = owner.tahmeelSubjects;
        if (Array.isArray(values)) {
          for (const value of values) {
            if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) {
              throw new StudentAdminError(
                'Carried subjects contain an invalid value.', 400, 'INVALID_TAHMEEL_SUBJECTS');
            }
            requestedSubjects.add(value.trim());
          }
        }
      }
      if (requestedSubjects.size > 20) {
        throw new StudentAdminError('Too many carried subjects.', 400, 'INVALID_TAHMEEL_SUBJECTS');
      }
      const sourceSubjects = await tx.get(db.collection('subjects').where('stageId', '==', previousStageId));
      const validSubjects = new Set(sourceSubjects.docs
        .filter(doc => doc.data()?.isActive !== false)
        .map(doc => String(doc.data()?.id || doc.id.replace(`${previousStageId}__`, ''))));
      const unknown = Array.from(requestedSubjects).filter(subject => !validSubjects.has(subject));
      if (unknown.length) {
        throw new StudentAdminError(
          `Invalid carried subjects for ${previousStageId}: ${unknown.join(', ')}`,
          400,
          'INVALID_TAHMEEL_SUBJECTS',
        );
      }
      finalTahmeel = Array.from(requestedSubjects);
    }

    const statReads = [] as Array<{
      user: FirebaseFirestore.DocumentSnapshot;
      previous: FirebaseFirestore.DocumentSnapshot;
      target: FirebaseFirestore.DocumentSnapshot;
      legacy: FirebaseFirestore.DocumentSnapshot;
      previousHistory: FirebaseFirestore.DocumentSnapshot;
      targetHistory: FirebaseFirestore.DocumentSnapshot;
    }>;
    for (const userSnap of userSnaps) {
      const [previous, target, legacy, previousHistory, targetHistory] = await Promise.all([
        tx.get(db.collection('userStageMCQStats').doc(`${userSnap.id}_${previousStageId}`)),
        tx.get(db.collection('userStageMCQStats').doc(`${userSnap.id}_${destinationId}`)),
        tx.get(db.collection('userMCQStats').doc(userSnap.id)),
        tx.get(db.collection('users').doc(userSnap.id).collection('stageHistory').doc(`${calendar.yearLabel}_${previousStageId}`)),
        tx.get(db.collection('users').doc(userSnap.id).collection('stageHistory').doc(`${calendar.yearLabel}_${destinationId}`)),
      ]);
      statReads.push({ user: userSnap, previous, target, legacy, previousHistory, targetHistory });
    }

    let rolesVacated = 0;
    let vacatedRole: string | null = null;
    for (const uSnap of userSnaps) {
      const uData = uSnap.data() || {};
      const isMaster = uData.isMasterAdmin === true;
      const isGlobalSupport = uData.role === 'support';
      const isStageStaff = (uData.role === 'admin' || uData.role === 'moderator') &&
                           uData.managedStageId === previousStageId;

      if (!isMaster && !isGlobalSupport && isStageStaff) {
        rolesVacated++;
        vacatedRole = uData.role;
      }
    }
    for (const allowedAdminSnap of allowedAdminSnaps) {
      const allowedData = allowedAdminSnap.data() || {};
      if ((!allowedData.role || allowedData.role === 'admin' || allowedData.role === 'moderator') &&
          allowedData.managedStageId === previousStageId) {
        rolesVacated++;
        vacatedRole = allowedData.role;
      }
    }

    const studentPatch: Record<string, any> = {
      stageId: destinationId,
      subgroup: resolvedSubgroup || FieldValue.delete(),
      tahmeelSubjects: finalTahmeel,
      tahmeelStageId: finalTahmeel.length > 0 ? previousStageId : FieldValue.delete(),
      pendingStageId: FieldValue.delete(),
      pendingProgressionYear: FieldValue.delete(),
      pendingProgressionSetAt: FieldValue.delete(),
      graduated: false,
      ...completedProgressionFields(calendar.yearLabel),
      progressionAnsweredAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.set(studentRef, studentPatch, { merge: true });

    let usersUpdated = 0;
    for (const uSnap of userSnaps) {
      const uData = uSnap.data() || {};
      const userPatch: Record<string, any> = {
        stageId: destinationId,
        group: resolvedSubgroup || FieldValue.delete(),
        tahmeelSubjects: finalTahmeel,
        tahmeelStageId: finalTahmeel.length > 0 ? previousStageId : FieldValue.delete(),
        pendingStageId: FieldValue.delete(),
        pendingProgressionYear: FieldValue.delete(),
        pendingProgressionSetAt: FieldValue.delete(),
        graduated: false,
        ...completedProgressionFields(calendar.yearLabel),
        progressionAnsweredAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      const isMaster = uData.isMasterAdmin === true;
      const isGlobalSupport = uData.role === 'support';
      const isStageStaff = (uData.role === 'admin' || uData.role === 'moderator') &&
                           uData.managedStageId === previousStageId;

      if (!isMaster && !isGlobalSupport && isStageStaff) {
        userPatch.role = 'student';
        userPatch.managedStageId = FieldValue.delete();
        userPatch.permissions = FieldValue.delete();
      }

      tx.set(uSnap.ref, userPatch, { merge: true });
      usersUpdated++;
    }

    for (const allowedAdminSnap of allowedAdminSnaps) {
      const allowedData = allowedAdminSnap.data() || {};
      if ((!allowedData.role || allowedData.role === 'admin' || allowedData.role === 'moderator') &&
          allowedData.managedStageId === previousStageId) {
        tx.delete(allowedAdminSnap.ref);
      }
    }

    let statsUpdated = 0;
    for (const stats of statReads) {
      if (stats.previous.exists) {
        const previousData = stats.previous.data() || {};
        const previousHistoryRef = stats.previousHistory.exists
          ? stats.user.ref.collection('stageHistory')
            .doc(`${calendar.yearLabel}_${previousStageId}_transfer_${auditRef.id}`)
          : stats.previousHistory.ref;
        tx.set(previousHistoryRef, historyFromStats(
          previousData, calendar.yearLabel, previousStageId, `manual_transfer_${transferType}`,
          FieldValue.serverTimestamp()));
        statsUpdated++;
        tx.set(stats.previous.ref, {
          isActiveInStage: false,
          lastUpdated: FieldValue.serverTimestamp(),
        }, { merge: true });
        statsUpdated++;
      }

      if (stats.target.exists) {
        if (transferType === 'retention') {
          const targetHistoryRef = stats.targetHistory.exists
            ? stats.user.ref.collection('stageHistory')
              .doc(`${calendar.yearLabel}_${destinationId}_retention_${auditRef.id}`)
            : stats.targetHistory.ref;
          tx.set(targetHistoryRef, historyFromStats(
            stats.target.data() || {}, calendar.yearLabel, destinationId, 'retention_restart',
            FieldValue.serverTimestamp()));
          statsUpdated++;
          tx.set(stats.target.ref, {
            totalFirstAttemptCorrect: 0,
            totalFirstAttemptAnswered: 0,
            lecturesAttempted: 0,
            mcqLeaderboardScore: 0,
            accuracy: 0,
            mcqRankScore: FieldValue.delete(),
            subjectStats: {},
            academicYear: FieldValue.delete(),
            isActiveInStage: true,
            lastUpdated: FieldValue.serverTimestamp(),
          }, { merge: true });
        } else {
          tx.set(stats.target.ref, {
            isActiveInStage: true,
            lastUpdated: FieldValue.serverTimestamp(),
          }, { merge: true });
        }
        statsUpdated++;
      } else if (transferType === 'retention') {
        tx.set(stats.target.ref, {
          userId: stats.user.id,
          stageId: destinationId,
          totalFirstAttemptCorrect: 0,
          totalFirstAttemptAnswered: 0,
          lecturesAttempted: 0,
          mcqLeaderboardScore: 0,
          accuracy: 0,
          subjectStats: {},
          isActiveInStage: true,
          lastUpdated: FieldValue.serverTimestamp(),
        });
        statsUpdated++;
      }

      if (stats.legacy.exists) {
        const legacyPatch: Record<string, any> = {
          stageId: destinationId,
          lastUpdated: FieldValue.serverTimestamp(),
        };
        if (transferType === 'retention') {
          Object.assign(legacyPatch, {
            totalFirstAttemptCorrect: 0,
            totalFirstAttemptAnswered: 0,
            lecturesAttempted: 0,
            mcqLeaderboardScore: 0,
            accuracy: 0,
            mcqRankScore: FieldValue.delete(),
            subjectStats: {},
          });
        }
        tx.update(stats.legacy.ref, legacyPatch);
        statsUpdated++;
      }
    }

    const detailText = `Transferred ${canonicalEmail} from ${previousStageId} to ${destinationId}`
      + ` (${transferType}${note ? `: ${note}` : ''})`;
    tx.set(auditRef, {
      adminId: actor.uid,
      adminName: normalString(actor.name, 'actorName', 200) || normalString(actor.email, 'actorEmail', 320) || actor.uid,
      adminEmail: normalString(actor.email, 'actorEmail', 320).toLowerCase(),
      action: 'TRANSFER_STUDENT_STAGE',
      details: detailText,
      targetId: canonicalEmail,
      stageId: destinationId,
      timestamp: FieldValue.serverTimestamp(),
      metadata: {
        studentEmail: canonicalEmail,
        studentName: studentData.name || null,
        previousStageId,
        targetStageId: destinationId,
        previousSubgroup: studentData.subgroup || null,
        targetSubgroup: resolvedSubgroup,
        transferType,
        tahmeelHandling,
        rolesVacated,
        vacatedRole,
        reason: note || null,
      },
    });

    return {
      email: canonicalEmail,
      previousStageId,
      targetStageId: destinationId,
      targetSubgroup: resolvedSubgroup,
      transferType,
      rosterUpdated: 1,
      usersUpdated,
      statsUpdated,
      rolesVacated,
      wasStaffVacated: rolesVacated > 0,
      vacatedRole,
    };
  });
}
