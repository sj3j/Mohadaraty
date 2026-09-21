/**
 * The three things a student may change about their own account, shared by
 * both API surfaces.
 *
 * All of it has to run server-side with the Admin SDK. `students` is
 * admin-write-only (firestore.rules), and the self-edit branch on `users`
 * explicitly freezes examCode - which is deliberate, and not something to
 * loosen just to save a round trip. Anything reachable from here is therefore
 * gated on verifyAuth and scoped to the caller's OWN student document, never a
 * document id taken from the request body.
 *
 * FieldValue is injected rather than imported, matching shared/seasonReset.ts
 * and shared/progressionSubmit.ts.
 */
import bcrypt from 'bcryptjs';
import { StudentRecord, studentForToken, passwordMatches } from './studentLookup.js';

export class SelfServiceError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string) {
    super(message);
  }
}

export interface FieldValueLike {
  serverTimestamp(): any;
  delete(): any;
}

export interface AuthToken {
  uid: string;
  email?: string;
}

/** Matches the minimum SignupScreen already enforces on a chosen password. */
export const MIN_PASSWORD_LENGTH = 6;

/**
 * Exam codes are the university's own numbering - digits only. The exam-code
 * CSV importer already assumes that (it auto-swaps columns when the first one
 * is all digits), so accepting anything else here would let a student create a
 * value that importer could never match them on.
 */
const EXAM_CODE_RE = /^\d{1,12}$/;

/**
 * Changes the caller's password.
 *
 * The current password is required even on the forced first change: the
 * student typed it moments ago, and requiring it means an unlocked phone left
 * on a desk cannot be used to lock its owner out of their own account.
 *
 * Hashes with bcrypt, unlike the admin UI's unsalted SHA-256 - the server can
 * afford it, and every password that passes through here is upgraded on the
 * way past. /api/login still accepts both, so nothing breaks for rows that
 * have not been through it yet.
 */
export async function changeOwnPassword(
  db: FirebaseFirestore.Firestore,
  token: AuthToken,
  input: { currentPassword?: string; newPassword?: string },
): Promise<{ studentId: string }> {
  const current = (input.currentPassword || '').trim();
  const next = (input.newPassword || '').trim();

  if (!current || !next) {
    throw new SelfServiceError('كلمة المرور الحالية والجديدة مطلوبتان.', 400, 'MISSING_FIELDS');
  }
  if (next.length < MIN_PASSWORD_LENGTH) {
    throw new SelfServiceError(
      'كلمة المرور يجب أن تكون ' + MIN_PASSWORD_LENGTH + ' أحرف على الأقل.', 400, 'TOO_SHORT');
  }
  if (next === current) {
    throw new SelfServiceError('كلمة المرور الجديدة مطابقة للحالية.', 400, 'UNCHANGED');
  }

  const student = await studentForToken(db, token);
  if (!await passwordMatches(current, student.data.password)) {
    throw new SelfServiceError('كلمة المرور الحالية غير صحيحة.', 401, 'WRONG_PASSWORD');
  }

  await db.collection('students').doc(student.id).update({
    password: await bcrypt.hash(next, 10),
    mustChangePassword: false,
  });

  return { studentId: student.id };
}

/**
 * Records the exam code the student typed into the in-app prompt.
 *
 * Refuses to overwrite a code that is already set: the admin's CSV import is
 * the authority, and a student should not be able to replace a number the
 * university assigned them. Clearing one stays an admin action.
 *
 * Writes both copies - App.tsx reads `students` first and falls back to
 * `users`, so leaving them apart would show one value and match on another.
 */
export async function setOwnExamCode(
  db: FirebaseFirestore.Firestore,
  token: AuthToken,
  input: { examCode?: string },
): Promise<{ studentId: string; examCode: string }> {
  const examCode = (input.examCode || '').trim();
  if (!EXAM_CODE_RE.test(examCode)) {
    throw new SelfServiceError('الرقم الامتحاني يجب أن يتكون من أرقام فقط.', 400, 'INVALID_EXAM_CODE');
  }

  const student = await studentForToken(db, token);
  if ((student.data.examCode || '').trim()) {
    throw new SelfServiceError('الرقم الامتحاني مسجّل بالفعل. تواصل مع الإدارة لتغييره.', 409, 'ALREADY_SET');
  }

  await db.collection('students').doc(student.id).update({ examCode });
  if (token.uid) {
    await db.collection('users').doc(token.uid).set({ examCode }, { merge: true });
  }

  return { studentId: student.id, examCode };
}

/**
 * Attaches a real Gmail to a roster account so the student can use Google
 * sign-in from then on.
 *
 * The caller must already have proved ownership of the mailbox - the route
 * runs verifyGoogleIdentity first, which rejects an unverified email. That is
 * the whole security model here: without it, anyone could claim a classmate's
 * address and Google login would hand them that classmate's account.
 *
 * The student document is NOT renamed. Its id is the auth uid, the token's
 * email claim and the key every allowed_admins lookup uses; moving it would
 * orphan all three at once. The address goes in a field, and
 * resolveGoogleLogin queries that field when the address is not itself an id.
 */
export async function linkGoogleAccount(
  db: FirebaseFirestore.Firestore,
  token: AuthToken,
  identity: { email: string },
  FieldValue: FieldValueLike,
): Promise<{ studentId: string; googleEmail: string; alreadyOwned: boolean }> {
  const student = await studentForToken(db, token);
  return linkGoogleToStudent(db, student, identity, FieldValue);
}

/**
 * The link itself, against a student document the caller has already resolved.
 *
 * Split out of linkGoogleAccount so the sign-in-time claim path
 * (shared/googleLogin.ts claimAccountWithGoogle) can reuse the conflict guards
 * verbatim. That path has no session to read a token from - it proves ownership
 * with the roster password instead - so it cannot go through studentForToken,
 * and a second copy of these four guards is exactly how two surfaces drift.
 */
export async function linkGoogleToStudent(
  db: FirebaseFirestore.Firestore,
  student: StudentRecord,
  identity: { email: string },
  FieldValue: FieldValueLike,
): Promise<{ studentId: string; googleEmail: string; alreadyOwned: boolean }> {
  const email = identity.email.toLowerCase().trim();

  // Their own document id already IS this address - they can sign in with
  // Google today. Report success rather than a confusing conflict.
  if (student.id === email) {
    return { studentId: student.id, googleEmail: email, alreadyOwned: true };
  }
  if ((student.data.googleEmail || '').toLowerCase() === email) {
    return { studentId: student.id, googleEmail: email, alreadyOwned: true };
  }

  const conflictDoc = await db.collection('students').doc(email).get();
  // A row this student's own merge retired is not a conflict - it is them. Any
  // other existing document at that address is somebody else's.
  if (conflictDoc.exists &&
      (conflictDoc.data()?.mergedInto || '').toLowerCase() !== student.id.toLowerCase()) {
    throw new SelfServiceError('هذا البريد مرتبط بحساب آخر.', 409, 'EMAIL_TAKEN');
  }

  const conflictLinked = await db.collection('students')
    .where('googleEmail', '==', email).limit(1).get();
  if (!conflictLinked.empty && conflictLinked.docs[0].id !== student.id) {
    throw new SelfServiceError('هذا البريد مرتبط بحساب آخر.', 409, 'EMAIL_TAKEN');
  }

  // A staff address must not become a student's alternate login: allowed_admins
  // is keyed by address and grants a role on sight.
  const staffDoc = await db.collection('allowed_admins').doc(email).get();
  if (staffDoc.exists) {
    throw new SelfServiceError('هذا البريد مرتبط بحساب آخر.', 409, 'EMAIL_TAKEN');
  }

  await db.collection('students').doc(student.id).update({
    googleEmail: email,
    googleLinkedAt: FieldValue.serverTimestamp(),
  });

  return { studentId: student.id, googleEmail: email, alreadyOwned: false };
}

/**
 * Detaches a linked Gmail.
 *
 * Refuses when the account has no password, which would leave the student with
 * no way back in at all.
 */
export async function unlinkGoogleAccount(
  db: FirebaseFirestore.Firestore,
  token: AuthToken,
  FieldValue: FieldValueLike,
): Promise<{ studentId: string }> {
  const student = await studentForToken(db, token);

  if (!(student.data.googleEmail || '').trim()) {
    throw new SelfServiceError('لا يوجد حساب Google مرتبط.', 400, 'NOT_LINKED');
  }
  if (!(student.data.password || '').trim()) {
    throw new SelfServiceError(
      'لا يمكن فصل حساب Google قبل تعيين كلمة مرور.', 400, 'NO_PASSWORD');
  }

  await db.collection('students').doc(student.id).update({
    googleEmail: FieldValue.delete(),
    googleLinkedAt: FieldValue.delete(),
  });

  return { studentId: student.id };
}

/** Shape the settings page needs to render, without exposing the hash. */
export function accountSummary(student: StudentRecord) {
  return {
    studentId: student.id,
    name: student.data.name || '',
    loginCode: student.data.loginCode || null,
    googleEmail: student.data.googleEmail || null,
    placeholderEmail: student.data.placeholderEmail === true,
    mustChangePassword: student.data.mustChangePassword === true,
    examCode: student.data.examCode || '',
  };
}
