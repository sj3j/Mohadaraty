/**
 * Resolving a student from what someone typed, shared by both API surfaces.
 *
 * server.ts and api/index.ts had already drifted on exactly this logic - the
 * production copy looked the existing users document up and then discarded its
 * id, minting the custom token under the raw typed string instead. That was
 * survivable while the typed string was always an email. It stops being
 * survivable once a student can type their NAME, so the resolution lives here
 * once and both routes call it.
 *
 * Server-only: imports bcrypt and node:crypto, so nothing in src/ may import
 * it. shared/rosterIdentity.ts holds the half the browser also needs.
 */
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { nameKeyFor, looksLikeLoginCode, loginCodeKeyFor } from './rosterIdentity.js';

export interface StudentRecord {
  /** The document id - also the auth uid and the token's `email` claim. */
  id: string;
  data: FirebaseFirestore.DocumentData;
}

export class LoginError extends Error {
  constructor(message: string, readonly status = 401, readonly code?: string) {
    super(message);
  }
}

/** The message every "we will not say which half was wrong" failure uses. */
export const BAD_CREDENTIALS = 'الباسورد أو الإيميل خطأ';

/**
 * Redirects a merged-away student document to the one that absorbed it.
 *
 * A merge deactivates the losing row rather than deleting it (shared/adminUsers.ts)
 * and stamps `mergedInto` with the surviving document id. Every lookup has to
 * follow that pointer, and resolveGoogleLogin has to follow it BEFORE it reads
 * `isActive` - otherwise the deactivated loser is found first and the student is
 * told their account is disabled, which undoes the very link the merge created.
 *
 * Exactly one hop. A chain would mean a survivor was itself later merged, which
 * the merge refuses to create; following one anyway would turn a corrupted pair
 * into an infinite loop at the login path of all places. A pointer at a missing
 * or self-referential document is ignored, leaving the original record to fail
 * on its own merits.
 */
export async function followMerge(
  db: FirebaseFirestore.Firestore,
  record: StudentRecord,
): Promise<StudentRecord> {
  const target = (record.data?.mergedInto || '').trim().toLowerCase();
  if (!target || target === record.id) return record;

  const doc = await db.collection('students').doc(target).get();
  if (!doc.exists) return record;
  return { id: doc.id, data: doc.data() || {} };
}

/**
 * The three hash schemes that coexist in this data, tried in order:
 * unsalted SHA-256 (written by the admin UI), bcrypt (written by the API
 * routes and signup approval), and plaintext (legacy rows that predate both).
 */
export async function passwordMatches(plain: string, stored?: string): Promise<boolean> {
  if (!stored) return false;
  if (crypto.createHash('sha256').update(plain).digest('hex') === stored) return true;
  try {
    if (await bcrypt.compare(plain, stored)) return true;
  } catch {
    // Not a bcrypt hash. Fall through.
  }
  return plain === stored;
}

const toRecords = (snap: FirebaseFirestore.QuerySnapshot): StudentRecord[] =>
  snap.docs.map(d => ({ id: d.id, data: d.data() }));

/**
 * Every student the typed identifier could mean.
 *
 * Three shapes, in the order they are tried:
 *   contains "@"     the document id, exactly as before
 *   code-shaped      loginCodeKey, e.g. "D4-01234"
 *   anything else    nameKey, the Arabic-folded name
 *
 * Both queries are single-field equality, so Firestore indexes them
 * automatically - no composite index to deploy.
 *
 * A code lookup that misses falls through to the name lookup rather than
 * failing: looksLikeLoginCode is a routing hint, not a validation.
 */
export async function findStudentCandidates(
  db: FirebaseFirestore.Firestore,
  identifier: string,
): Promise<StudentRecord[]> {
  const raw = (identifier || '').trim();
  if (!raw) return [];

  if (raw.includes('@')) {
    const doc = await db.collection('students').doc(raw.toLowerCase()).get();
    if (!doc.exists) return [];
    // The typed address may be the one a merge retired. Follow it, so a student
    // who still types their old email reaches the account that absorbed it.
    return [await followMerge(db, { id: doc.id, data: doc.data() || {} })];
  }

  if (looksLikeLoginCode(raw)) {
    const byCode = await db.collection('students')
      .where('loginCodeKey', '==', loginCodeKeyFor(raw)).limit(10).get();
    if (!byCode.empty) return toRecords(byCode);
  }

  const key = nameKeyFor(raw);
  if (!key) return [];
  const byName = await db.collection('students')
    .where('nameKey', '==', key).limit(10).get();
  return toRecords(byName);
}

/**
 * Identifier + password -> the one student it means.
 *
 * The single-candidate branch is byte-for-byte the old email flow (disabled is
 * reported before the password is even checked), so no existing login changes
 * behaviour. Only a name or code can produce several candidates, and there the
 * password is what disambiguates - so it has to be checked first, and a tie is
 * refused outright rather than guessed at.
 */
export async function resolveStudentLogin(
  db: FirebaseFirestore.Firestore,
  identifier: string,
  password: string,
): Promise<StudentRecord> {
  const candidates = await findStudentCandidates(db, identifier);
  if (candidates.length === 0) throw new LoginError(BAD_CREDENTIALS, 401);

  if (candidates.length === 1) {
    const only = candidates[0];
    if (!only.data.isActive) throw new LoginError('تم تعطيل حسابك', 403, 'DISABLED');
    if (!await passwordMatches(password, only.data.password)) {
      throw new LoginError(BAD_CREDENTIALS, 401);
    }
    return only;
  }

  const matched: StudentRecord[] = [];
  for (const candidate of candidates) {
    if (await passwordMatches(password, candidate.data.password)) matched.push(candidate);
  }

  if (matched.length === 0) throw new LoginError(BAD_CREDENTIALS, 401);
  if (matched.length > 1) {
    throw new LoginError(
      'يوجد أكثر من طالب بهذا الاسم. سجّل الدخول برمز الدخول أو تواصل مع الإدارة.',
      409, 'AMBIGUOUS_IDENTIFIER',
    );
  }
  if (!matched[0].data.isActive) throw new LoginError('تم تعطيل حسابك', 403, 'DISABLED');
  return matched[0];
}

/**
 * The uid to mint the token under, and the claim to put inside it.
 *
 * `email` is always the student document id, never whatever address the person
 * typed or linked: firestore.rules resolves students/{token.email} in
 * isWhitelisted(), so a claim carrying anything else fails every read that
 * student is entitled to.
 *
 * The uid prefers an existing users document so a second identity is never
 * created for someone who already has a profile - the bug that produced the
 * duplicate accounts the admin merge tool exists to clean up.
 */
export async function resolveSessionUid(
  db: FirebaseFirestore.Firestore,
  student: StudentRecord,
  syncUserStage: (uid: string, source: any) => Promise<void>,
): Promise<{ uid: string; emailClaim: string }> {
  let uid = student.id;
  const usersQuery = await db.collection('users')
    .where('email', '==', student.id).limit(1).get();
  if (!usersQuery.empty) {
    uid = usersQuery.docs[0].id;
    await syncUserStage(uid, { stageId: student.data.stageId });
  }
  return { uid, emailClaim: student.id };
}

/**
 * The student document behind an already-authenticated request, for /api/me/*.
 *
 * Mirrors isWhitelisted() in firestore.rules - email claim, then uid - with a
 * third arm for a linked Gmail, because a session opened through Google before
 * the claim was normalised carries the real address rather than the doc id.
 */
export async function studentForToken(
  db: FirebaseFirestore.Firestore,
  token: { uid?: string; email?: string },
): Promise<StudentRecord> {
  const email = (token.email || '').toLowerCase().trim();

  for (const id of [email, token.uid]) {
    if (!id) continue;
    const doc = await db.collection('students').doc(id).get();
    if (doc.exists) return followMerge(db, { id: doc.id, data: doc.data() || {} });
  }

  if (email) {
    const linked = await db.collection('students')
      .where('googleEmail', '==', email).limit(1).get();
    if (!linked.empty) {
      return followMerge(db, { id: linked.docs[0].id, data: linked.docs[0].data() });
    }
  }

  throw new LoginError('لا يوجد حساب طالب مرتبط بهذه الجلسة.', 404, 'NO_STUDENT');
}
