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
  if (staff.isMasterAdmin) return;
  if (staff.isSupport) {
    if (staff.permissions?.manageStudents === true) return;
    throw new StudentAdminError(
      'Your support account is not granted student management.', 403, 'NOT_GRANTED');
  }
  if (!staff.managedStageId) {
    throw new StudentAdminError('You are not assigned to a stage.', 403, 'NO_STAGE');
  }
  if (targetStageId !== staff.managedStageId) {
    throw new StudentAdminError(
      'You may only act on students in your own stage.', 403, 'WRONG_STAGE');
  }
}

export interface ResetResult {
  /** Plaintext, returned exactly once. Never stored, never logged. */
  password: string;
  name: string;
  loginCode: string;
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
