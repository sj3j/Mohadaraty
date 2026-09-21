/**
 * Google sign-in, shared by both API surfaces.
 *
 * Accepts either kind of token:
 *
 *   idToken       a FIREBASE token, from the web popup path
 *                 (iss: securetoken.google.com/<project>, aud: <projectId>)
 *   googleIdToken a raw GOOGLE OAuth token, from the native plugin
 *                 (iss: accounts.google.com, aud: <oauth client id>)
 *
 * They are NOT interchangeable. `admin.auth().verifyIdToken()` rejects a Google
 * token outright on `aud`/`iss`, so the native path is verified with
 * google-auth-library instead.
 *
 * The native path deliberately never creates a client-side Firebase identity.
 * The old web flow signs in with a popup (minting a Firebase account under the
 * Google uid), signs out, then signs in again with a custom token under a
 * DIFFERENT uid - orphaning the first account forever. Sending the raw Google
 * token straight here means only one identity is ever created.
 */

import {
  StudentRecord,
  LoginError,
  followMerge,
  resolveStudentLogin,
  resolveSessionUid,
} from './studentLookup.js';
import { linkGoogleToStudent, FieldValueLike } from './accountSelfService.js';

export interface GoogleIdentity {
  email: string;
  name: string | null;
  emailVerified: boolean;
  /**
   * The uid of the throwaway Firebase account the WEB popup created, when the
   * caller sent a Firebase token. Absent on the native path, which never mints
   * one. See discardPopupIdentity.
   */
  popupUid?: string;
}

export class GoogleLoginError extends Error {
  constructor(message: string, readonly status = 401, readonly code?: string) {
    super(message);
  }
}

/** Verifies whichever token was supplied and returns the identity it asserts. */
export async function verifyGoogleIdentity(opts: {
  adminAuth: { verifyIdToken(t: string): Promise<any> };
  oauthClient: { verifyIdToken(o: { idToken: string; audience: string | string[] }): Promise<any> };
  audience: string;
  idToken?: string;
  googleIdToken?: string;
}): Promise<GoogleIdentity> {
  const { adminAuth, oauthClient, audience, idToken, googleIdToken } = opts;

  let email: string | undefined;
  let name: string | null = null;
  let emailVerified = false;
  let popupUid: string | undefined;

  if (googleIdToken) {
    const ticket = await oauthClient.verifyIdToken({ idToken: googleIdToken, audience });
    const payload = ticket.getPayload?.() ?? ticket.payload ?? ticket;
    email = payload?.email;
    name = payload?.name ?? null;
    emailVerified = payload?.email_verified === true;
  } else if (idToken) {
    const decoded = await adminAuth.verifyIdToken(idToken);
    email = decoded?.email;
    name = decoded?.name ?? null;
    emailVerified = decoded?.email_verified === true;
    popupUid = decoded?.uid;
  } else {
    throw new GoogleLoginError('Missing idToken', 400);
  }

  if (!email) throw new GoogleLoginError('No email associated.', 400);

  // THE account-takeover guard. Google will issue an ID token for an account
  // whose email is not verified, and this server reconciles purely on `email` -
  // so without this check anyone could register a Google account claiming a
  // classmate's university address and be handed a token for THEIR account.
  if (!emailVerified) {
    throw new GoogleLoginError('Email is not verified with Google.', 401, 'EMAIL_NOT_VERIFIED');
  }

  return { email: email.toLowerCase().trim(), name, emailVerified, popupUid };
}

/**
 * Deletes the Firebase account the web popup created on its way to a token.
 *
 * src/lib/googleSignIn.ts runs signInWithPopup on a throwaway secondary app so
 * the current session is never disturbed - but deleting that app does not delete
 * the Auth USER it created, which is project-wide. Every web Google sign-in
 * therefore left a third Auth record per student: the roster uid, the
 * custom-token session, and this orphan. It holds no data, so nothing breaks
 * while it exists; it is simply a growing set of accounts that are not accounts.
 *
 * TWO GUARDS, both load-bearing. A master admin's Google uid IS their real
 * account - they have no students document and resolveGoogleLogin issues their
 * token under the uid of whichever users doc carries their address - so deleting
 * "the popup account" unconditionally would delete a live administrator. Never
 * touch the uid the session is being issued for, and never touch a uid that owns
 * a users document.
 *
 * Best effort: a failure here must never fail the sign-in it follows.
 */
export async function discardPopupIdentity(
  db: FirebaseFirestore.Firestore,
  adminAuth: { deleteUser(uid: string): Promise<void> },
  identity: GoogleIdentity,
  targetUid: string,
): Promise<boolean> {
  const popupUid = identity.popupUid;
  if (!popupUid || popupUid === targetUid) return false;

  try {
    const userDoc = await db.collection('users').doc(popupUid).get();
    if (userDoc.exists) return false;
    await adminAuth.deleteUser(popupUid);
    return true;
  } catch (error) {
    console.error('Discarding the popup identity failed (ignored):', error);
    return false;
  }
}

export interface GoogleLoginResult {
  customToken: string;
  uid: string;
  email: string;
}

/**
 * Whitelist check + `users`-by-email reconciliation + custom token.
 *
 * Reconciling on the email is what makes a student who signs in with Google land
 * on the SAME profile they use with a password, whatever uid that document
 * happens to be keyed by (password logins key by email, Google logins by the
 * Google uid, and both shapes exist in the data).
 */
export async function resolveGoogleLogin(
  db: FirebaseFirestore.Firestore,
  adminAuth: { createCustomToken(uid: string, claims?: object): Promise<string> },
  identity: GoogleIdentity,
  opts: {
    masterAdminEmails: string[];
    fallbackUid: string;
    syncUserStage: (uid: string, source: any) => Promise<void>;
  },
): Promise<GoogleLoginResult> {
  const emailLower = identity.email;
  let stageSource: { stageId?: string | null; managedStageId?: string | null } = {};

  // The string this account is keyed by everywhere else: the students document
  // id, the auth uid, and the token's `email` claim.
  //
  // For every account that predates roster import this is just the address -
  // the document id IS the email - so all the paths below leave it alone and
  // behave exactly as they always have. It only diverges for a student who was
  // imported without an email and later linked a Gmail from settings: their
  // document is keyed by a synthetic id, and the claim has to keep carrying
  // that id, because firestore.rules resolves students/{token.email} in
  // isWhitelisted(). Handing out the real Gmail there would fail every read
  // that student is entitled to.
  let identityKey = emailLower;

  if (!opts.masterAdminEmails.includes(emailLower)) {
    const adminDoc = await db.collection('allowed_admins').doc(emailLower).get();
    if (adminDoc.exists) {
      stageSource = { managedStageId: adminDoc.data()?.managedStageId };
    } else {
      let studentId: string | null = null;
      let studentData: FirebaseFirestore.DocumentData | undefined;

      const studentDoc = await db.collection('students').doc(emailLower).get();
      if (studentDoc.exists) {
        // Follow a merge BEFORE reading isActive. A merge retires the losing row
        // in place (isActive:false + mergedInto) and copies its address onto the
        // survivor as googleEmail; reading isActive first would find the retired
        // row here, throw DISABLED, and undo the link the merge just created.
        const resolved = await followMerge(
          db, { id: studentDoc.id, data: studentDoc.data() || {} });
        studentId = resolved.id;
        studentData = resolved.data;
        if (resolved.id !== studentDoc.id) identityKey = resolved.id;
      } else {
        // Not a document id - but it may be an address someone linked to a
        // roster account. Checked only after the id lookup misses, so the
        // common path costs no extra read.
        const linked = await db.collection('students')
          .where('googleEmail', '==', emailLower).limit(1).get();
        if (!linked.empty) {
          studentId = linked.docs[0].id;
          studentData = linked.docs[0].data();
          identityKey = studentId;
        }
      }

      if (!studentId) {
        // Distinguishable from a wrong password: they have just proved they own
        // this mailbox, so telling them there is no account is safe - and the
        // app routes them to signup instead of a dead end blaming a password
        // they never set.
        throw new GoogleLoginError('No account for this email.', 404, 'NO_ACCOUNT');
      }
      if (studentData?.isActive === false) {
        throw new GoogleLoginError('الحساب معطل', 401, 'DISABLED');
      }
      stageSource = { stageId: studentData?.stageId };
    }
  }

  let targetUid = identityKey === emailLower ? opts.fallbackUid : identityKey;
  const usersQuery = await db.collection('users').where('email', '==', identityKey).limit(1).get();
  if (!usersQuery.empty) {
    targetUid = usersQuery.docs[0].id;
    await opts.syncUserStage(targetUid, stageSource);
  }

  const customToken = await adminAuth.createCustomToken(targetUid, { email: identityKey });
  return { customToken, uid: targetUid, email: identityKey };
}

/**
 * Links a verified Google identity onto an EXISTING roster account, then signs
 * them into it. The other half of NO_ACCOUNT.
 *
 * Why this exists: a staff-created account is a `students/{id}` document with a
 * hashed password. Its Auth record is materialised by signInWithCustomToken with
 * uid = that document id and NO `email` property at all, so Firebase cannot see
 * that a Google identity and a roster identity are the same person - and
 * `auth/account-exists-with-different-credential` is unreachable here. The join
 * has to be made in our own data. resolveGoogleLogin already reads it
 * (students.googleEmail); nothing could WRITE it without first being signed in,
 * which is precisely what the student in this state cannot do. So Google
 * sign-in threw NO_ACCOUNT, the app offered signup, and the second account was
 * born.
 *
 * Two independent proofs are required and neither alone is sufficient:
 *
 *   the mailbox   verifyGoogleIdentity, run by the caller, which refuses a
 *                 token whose email Google has not verified. Without it anyone
 *                 could claim a classmate's address.
 *   the account   the roster password, checked by resolveStudentLogin. Without
 *                 it proving ownership of any mailbox would attach it to any
 *                 account that could be named.
 *
 * `examCode` is deliberately not accepted as an identifier: it is reissued every
 * year, so it identifies a year's enrolment, never a person. resolveStudentLogin
 * takes email, login code or folded name and has never taken it.
 */
export async function claimAccountWithGoogle(
  db: FirebaseFirestore.Firestore,
  adminAuth: { createCustomToken(uid: string, claims?: object): Promise<string> },
  identity: GoogleIdentity,
  input: { identifier?: string; password?: string },
  opts: {
    masterAdminEmails: string[];
    syncUserStage: (uid: string, source: any) => Promise<void>;
    FieldValue: FieldValueLike;
  },
): Promise<GoogleLoginResult & { alreadyOwned: boolean }> {
  const identifier = (input.identifier || '').trim();
  const password = (input.password || '').trim();
  if (!identifier || !password) {
    throw new GoogleLoginError('أدخل بيانات حسابك الحالي وكلمة المرور.', 400, 'MISSING_FIELDS');
  }

  // A master admin has no students document at all - resolveGoogleLogin bypasses
  // the whitelist for them - so there is nothing here to claim, and letting the
  // attempt through would only report BAD_CREDENTIALS against a row that cannot
  // exist. Send them back to the ordinary Google button, which already works.
  if (opts.masterAdminEmails.includes(identity.email)) {
    throw new GoogleLoginError('هذا الحساب يسجّل الدخول عبر Google مباشرة.', 409, 'NOT_CLAIMABLE');
  }

  // Throws BAD_CREDENTIALS / DISABLED / AMBIGUOUS_IDENTIFIER on its own terms.
  const resolved: StudentRecord = await resolveStudentLogin(db, identifier, password);
  const student = await followMerge(db, resolved);

  // Same conflict guards as the settings-page link, by construction.
  const link = await linkGoogleToStudent(db, student, identity, opts.FieldValue);

  const { uid, emailClaim } = await resolveSessionUid(
    db, student, (u, source) => opts.syncUserStage(u, source));

  const customToken = await adminAuth.createCustomToken(uid, { email: emailClaim });
  return { customToken, uid, email: emailClaim, alreadyOwned: link.alreadyOwned };
}

/**
 * Re-raises the errors the claim path borrows from other modules as this
 * module's own, so a route only has to catch GoogleLoginError.
 *
 * LoginError and SelfServiceError both already carry `status` and `code`, and
 * both are structurally identical to GoogleLoginError - they are separate
 * classes only because they live in separate modules.
 */
export function asGoogleLoginError(error: any): GoogleLoginError {
  if (error instanceof GoogleLoginError) return error;
  if (error instanceof LoginError) {
    return new GoogleLoginError(error.message, error.status, error.code);
  }
  if (error && typeof error.status === 'number' && typeof error.message === 'string') {
    return new GoogleLoginError(error.message, error.status, error.code);
  }
  return new GoogleLoginError('Internal server error', 500);
}
