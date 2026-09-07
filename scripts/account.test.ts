/**
 * Verifies login resolution and account self-service against the emulator.
 *
 * Run with:  npm run test:account
 *
 * These are the paths a roster student depends on: they have no email, so the
 * only ways in are their name and their login code, and the only way to stop
 * using the password printed on a sheet is POST /api/me/password. Every guard
 * here is one that, if it broke, would either lock a whole cohort out or let
 * one student reach another student's record.
 */
import 'dotenv/config';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import {
  findStudentCandidates, resolveStudentLogin, resolveSessionUid,
  studentForToken, passwordMatches, LoginError,
} from '../shared/studentLookup';
import {
  changeOwnPassword, setOwnExamCode, linkGoogleAccount, unlinkGoogleAccount,
  accountSummary, SelfServiceError,
} from '../shared/accountSelfService';
import { nameKeyFor, makeLoginCode, loginCodeKeyFor } from '../shared/rosterIdentity';
import { resetStudentPassword, assertStageAuthority, StudentAdminError } from '../shared/studentAdmin';
import {
  requestAccountDeletion, cancelAccountDeletion, reviewDeletionRequest,
  purgeAccount, DeletionError, DELETED_AUTHOR_AR,
} from '../shared/accountDeletion';

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
const FieldValue = (await import('firebase-admin/firestore')).FieldValue;

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); failed++; }
};
const sha = (p: string) => crypto.createHash('sha256').update(p).digest('hex');
const caught = async (fn: () => Promise<any>): Promise<any> => {
  try { await fn(); return null; } catch (e) { return e; }
};

// --- fixtures ---------------------------------------------------------------
// A roster student: synthetic id, no real mailbox, SHA-256 password from the
// admin UI importer, still on the generated password.
const ROSTER = 'aaaa1111bbbb2222@roster.mylecture.local';
await db.collection('students').doc(ROSTER).set({
  email: ROSTER, name: 'أحمد علي حسين', nameKey: nameKeyFor('أحمد علي حسين'),
  loginCode: 'D4-01234', loginCodeKey: 'D4-01234',
  password: sha('Genpass8'), placeholderEmail: true, mustChangePassword: true,
  examCode: '', subgroup: 'D4', isActive: true, stageId: 'stage_4',
});
await db.collection('users').doc(ROSTER).set({
  email: ROSTER, name: 'أحمد علي حسين', role: 'student', stageId: 'stage_4',
});

// An ordinary student with a real address and a bcrypt hash from the API route.
await db.collection('students').doc('real@gmail.com').set({
  email: 'real@gmail.com', name: 'Real Student', nameKey: nameKeyFor('Real Student'),
  password: await bcrypt.hash('realpass', 10), examCode: '5555',
  isActive: true, stageId: 'stage_3',
});

// Two students who genuinely share a name - the case the password has to break.
for (const [id, pw] of [['twin1@roster.mylecture.local', 'twinpwOne'],
                        ['twin2@roster.mylecture.local', 'twinpwTwo']] as const) {
  await db.collection('students').doc(id).set({
    email: id, name: 'فاطمة حسن', nameKey: nameKeyFor('فاطمة حسن'),
    loginCode: `A1-${id.startsWith('twin1') ? '11111' : '22222'}`,
    loginCodeKey: `A1-${id.startsWith('twin1') ? '11111' : '22222'}`,
    password: sha(pw), isActive: true, stageId: 'stage_4', examCode: '',
  });
}

await db.collection('students').doc('off@roster.mylecture.local').set({
  email: 'off@roster.mylecture.local', name: 'Disabled Person',
  nameKey: nameKeyFor('Disabled Person'), password: sha('offpass'),
  isActive: false, stageId: 'stage_4', examCode: '',
});

console.log('Password schemes:');
{
  check('SHA-256 from the admin UI matches', await passwordMatches('Genpass8', sha('Genpass8')));
  check('bcrypt from the API matches', await passwordMatches('x', await bcrypt.hash('x', 10)));
  check('legacy plaintext still matches', await passwordMatches('plain', 'plain'));
  check('a wrong password does not', !await passwordMatches('nope', sha('Genpass8')));
  check('a missing stored hash does not', !await passwordMatches('nope', undefined));
}

console.log('\nIdentifier resolution:');
{
  check('an email finds the doc by id',
    (await findStudentCandidates(db, 'real@gmail.com'))[0]?.id === 'real@gmail.com');
  check('an email is case-insensitive',
    (await findStudentCandidates(db, 'REAL@Gmail.com'))[0]?.id === 'real@gmail.com');
  check('a login code finds the roster student',
    (await findStudentCandidates(db, 'D4-01234'))[0]?.id === ROSTER);
  check('a login code is case-insensitive',
    (await findStudentCandidates(db, 'd4-01234'))[0]?.id === ROSTER);
  check('a name finds the roster student',
    (await findStudentCandidates(db, 'أحمد علي حسين'))[0]?.id === ROSTER);
  // The whole reason nameKey exists rather than matching on `name`.
  check('a differently-spelled name still finds them',
    (await findStudentCandidates(db, 'احمد علي حسين'))[0]?.id === ROSTER);
  check('extra whitespace does not matter',
    (await findStudentCandidates(db, '  أحمد   علي حسين '))[0]?.id === ROSTER);
  check('a shared name returns BOTH candidates',
    (await findStudentCandidates(db, 'فاطمة حسن')).length === 2);
  check('an unknown identifier returns nothing',
    (await findStudentCandidates(db, 'nobody at all')).length === 0);
  check('empty returns nothing', (await findStudentCandidates(db, '   ')).length === 0);
}

console.log('\nLogin:');
{
  check('roster student signs in by name',
    (await resolveStudentLogin(db, 'احمد علي حسين', 'Genpass8')).id === ROSTER);
  check('roster student signs in by code',
    (await resolveStudentLogin(db, 'D4-01234', 'Genpass8')).id === ROSTER);
  check('ordinary student signs in by email',
    (await resolveStudentLogin(db, 'real@gmail.com', 'realpass')).id === 'real@gmail.com');

  const wrong = await caught(() => resolveStudentLogin(db, 'real@gmail.com', 'bad'));
  check('a wrong password is 401', wrong?.status === 401);
  const unknown = await caught(() => resolveStudentLogin(db, 'ghost@x.com', 'any'));
  check('an unknown account is 401, not 404', unknown?.status === 401);
  const disabled = await caught(() => resolveStudentLogin(db, 'Disabled Person', 'offpass'));
  check('a deactivated account is 403', disabled?.status === 403, String(disabled?.status));

  // Shared name: the password is the disambiguator, and each twin must land on
  // their OWN document - crossing them would be an account takeover.
  check('twin one gets their own record',
    (await resolveStudentLogin(db, 'فاطمة حسن', 'twinpwOne')).id === 'twin1@roster.mylecture.local');
  check('twin two gets their own record',
    (await resolveStudentLogin(db, 'فاطمة حسن', 'twinpwTwo')).id === 'twin2@roster.mylecture.local');
  const noTwin = await caught(() => resolveStudentLogin(db, 'فاطمة حسن', 'neither'));
  check('a wrong password on a shared name is 401', noTwin?.status === 401);

  // Both twins on the same password is the one case we refuse rather than guess.
  await db.collection('students').doc('twin2@roster.mylecture.local')
    .update({ password: sha('twinpwOne') });
  const tie = await caught(() => resolveStudentLogin(db, 'فاطمة حسن', 'twinpwOne'));
  check('an unbreakable tie is 409, never a guess', tie?.status === 409, String(tie?.status));
  check('...with a code the client can message on', tie?.code === 'AMBIGUOUS_IDENTIFIER');
  await db.collection('students').doc('twin2@roster.mylecture.local')
    .update({ password: sha('twinpwTwo') });
  check('a code still separates the tied twins',
    (await resolveStudentLogin(db, 'A1-11111', 'twinpwOne')).id === 'twin1@roster.mylecture.local');
}

console.log('\nSession uid:');
{
  const student = await resolveStudentLogin(db, 'D4-01234', 'Genpass8');
  const s1 = await resolveSessionUid(db, student, async () => {});
  check('reuses the existing users doc', s1.uid === ROSTER, s1.uid);
  // The load-bearing invariant: firestore.rules resolves students/{token.email}.
  check('the email claim is the student doc id', s1.emailClaim === ROSTER, s1.emailClaim);

  const fresh = await resolveStudentLogin(db, 'real@gmail.com', 'realpass');
  const s2 = await resolveSessionUid(db, fresh, async () => {});
  check('with no users doc, the uid falls back to the student id',
    s2.uid === 'real@gmail.com', s2.uid);
}

console.log('\nstudentForToken:');
{
  check('resolves by the email claim',
    (await studentForToken(db, { uid: 'x', email: ROSTER })).id === ROSTER);
  check('resolves by uid when the claim is absent',
    (await studentForToken(db, { uid: ROSTER })).id === ROSTER);
  const none = await caught(() => studentForToken(db, { uid: 'nobody', email: 'no@x.com' }));
  check('an unrelated session is 404', none?.status === 404);
}

console.log('\nChange password:');
{
  const tooShort = await caught(() => changeOwnPassword(db, { uid: ROSTER, email: ROSTER },
    { currentPassword: 'Genpass8', newPassword: 'abc' }));
  check('a short password is refused', tooShort?.code === 'TOO_SHORT');

  const wrongCurrent = await caught(() => changeOwnPassword(db, { uid: ROSTER, email: ROSTER },
    { currentPassword: 'notit', newPassword: 'brandnew1' }));
  check('a wrong current password is 401', wrongCurrent?.status === 401);

  const same = await caught(() => changeOwnPassword(db, { uid: ROSTER, email: ROSTER },
    { currentPassword: 'Genpass8', newPassword: 'Genpass8' }));
  check('reusing the same password is refused', same?.code === 'UNCHANGED');

  await changeOwnPassword(db, { uid: ROSTER, email: ROSTER },
    { currentPassword: 'Genpass8', newPassword: 'brandnew1' });
  const after = (await db.collection('students').doc(ROSTER).get()).data()!;
  check('the new hash is bcrypt, not SHA-256', after.password.startsWith('$2'), after.password.slice(0, 4));
  check('the forced-change flag is cleared', after.mustChangePassword === false);
  check('the old password no longer works',
    (await caught(() => resolveStudentLogin(db, 'D4-01234', 'Genpass8')))?.status === 401);
  check('the new password works',
    (await resolveStudentLogin(db, 'D4-01234', 'brandnew1')).id === ROSTER);
}

console.log('\nExam code:');
{
  const bad = await caught(() => setOwnExamCode(db, { uid: ROSTER, email: ROSTER },
    { examCode: 'ABC' }));
  check('letters are refused', bad?.code === 'INVALID_EXAM_CODE');
  const empty = await caught(() => setOwnExamCode(db, { uid: ROSTER, email: ROSTER },
    { examCode: '' }));
  check('empty is refused', empty?.code === 'INVALID_EXAM_CODE');

  await setOwnExamCode(db, { uid: ROSTER, email: ROSTER }, { examCode: '1023' });
  check('written to the student doc',
    (await db.collection('students').doc(ROSTER).get()).data()!.examCode === '1023');
  // App.tsx prefers students over users; leaving them apart shows one and
  // matches on the other.
  check('mirrored onto the users doc',
    (await db.collection('users').doc(ROSTER).get()).data()!.examCode === '1023');

  const again = await caught(() => setOwnExamCode(db, { uid: ROSTER, email: ROSTER },
    { examCode: '9999' }));
  check('overwriting an existing code is refused', again?.code === 'ALREADY_SET');

  // What a promotion leaves behind. submitProgression blanks both copies to ''
  // precisely so the student can record next year's number; if ALREADY_SET
  // still fired on an empty string, the prompt would ask for something that
  // could never be saved.
  await db.collection('students').doc(ROSTER).update({ examCode: '' });
  await setOwnExamCode(db, { uid: ROSTER, email: ROSTER }, { examCode: '2024' });
  check('a code cleared by a promotion can be set again',
    (await db.collection('students').doc(ROSTER).get()).data()!.examCode === '2024');
}

console.log('\nLink Google:');
{
  await db.collection('allowed_admins').doc('rep@gmail.com').set({
    email: 'rep@gmail.com', role: 'admin', managedStageId: 'stage_4',
  });

  const taken = await caught(() => linkGoogleAccount(db, { uid: ROSTER, email: ROSTER },
    { email: 'real@gmail.com' }, FieldValue));
  check('an address that is another student doc id is refused', taken?.code === 'EMAIL_TAKEN');

  const staff = await caught(() => linkGoogleAccount(db, { uid: ROSTER, email: ROSTER },
    { email: 'rep@gmail.com' }, FieldValue));
  check('a staff address is refused', staff?.code === 'EMAIL_TAKEN');

  const linked = await linkGoogleAccount(db, { uid: ROSTER, email: ROSTER },
    { email: 'Ahmed.Ali@Gmail.com' }, FieldValue);
  check('a fresh address links', linked.googleEmail === 'ahmed.ali@gmail.com');
  check('stored lowercased on the student doc',
    (await db.collection('students').doc(ROSTER).get()).data()!.googleEmail === 'ahmed.ali@gmail.com');
  // Renaming the document would orphan the auth uid, the users doc and every
  // allowed_admins reference at once.
  check('the document was NOT renamed',
    (await db.collection('students').doc(ROSTER).get()).exists);

  check('relinking the same address is a no-op success',
    (await linkGoogleAccount(db, { uid: ROSTER, email: ROSTER },
      { email: 'ahmed.ali@gmail.com' }, FieldValue)).alreadyOwned);

  const stolen = await caught(() => linkGoogleAccount(db,
    { uid: 'twin1@roster.mylecture.local', email: 'twin1@roster.mylecture.local' },
    { email: 'ahmed.ali@gmail.com' }, FieldValue));
  check('another student cannot link the same address', stolen?.code === 'EMAIL_TAKEN');

  // A session opened through Google carries the real address as its claim.
  check('the linked address resolves back to the roster account',
    (await studentForToken(db, { uid: ROSTER, email: 'ahmed.ali@gmail.com' })).id === ROSTER);

  const summary = accountSummary(await studentForToken(db, { uid: ROSTER, email: ROSTER }));
  check('the summary exposes the login code', summary.loginCode === 'D4-01234');
  check('the summary exposes the linked address', summary.googleEmail === 'ahmed.ali@gmail.com');
  check('the summary never carries the hash', !('password' in summary));

  await unlinkGoogleAccount(db, { uid: ROSTER, email: ROSTER }, FieldValue);
  check('unlinking removes the field',
    (await db.collection('students').doc(ROSTER).get()).data()!.googleEmail === undefined);
  const notLinked = await caught(() => unlinkGoogleAccount(db, { uid: ROSTER, email: ROSTER }, FieldValue));
  check('unlinking twice is refused', notLinked?.code === 'NOT_LINKED');
}

console.log('\nAdmin password reset:');
{
  const MASTER = { isMasterAdmin: true };
  const REP_4 = { isMasterAdmin: false, managedStageId: 'stage_4' };
  const REP_3 = { isMasterAdmin: false, managedStageId: 'stage_3' };
  const UNASSIGNED = { isMasterAdmin: false, managedStageId: null };

  // The Admin SDK bypasses firestore.rules, so this boundary is the only thing
  // standing between a representative and another cohort's credentials.
  check('a rep on another stage is refused',
    (await caught(() => resetStudentPassword(db, ROSTER, REP_3)))?.code === 'WRONG_STAGE');
  check('an unassigned admin is refused',
    (await caught(() => resetStudentPassword(db, ROSTER, UNASSIGNED)))?.code === 'NO_STAGE');
  check('a missing student is 404',
    (await caught(() => resetStudentPassword(db, 'ghost@x.com', MASTER)))?.status === 404);

  const before = (await db.collection('students').doc(ROSTER).get()).data()!.password;
  const out = await resetStudentPassword(db, ROSTER, REP_4);

  check('returns a plaintext password', typeof out.password === 'string' && out.password.length === 8, out.password);
  check('returns the name for the panel', out.name === 'أحمد علي حسين', out.name);
  const after = (await db.collection('students').doc(ROSTER).get()).data()!;
  check('stores bcrypt, not the plaintext', after.password.startsWith('$2') && after.password !== out.password);
  check('the stored hash actually changed', after.password !== before);
  check('forces a change at next sign-in', after.mustChangePassword === true);
  check('the new password signs in', (await resolveStudentLogin(db, 'D4-01234', out.password)).id === ROSTER);
  check('the previous password no longer works',
    (await caught(() => resolveStudentLogin(db, 'D4-01234', 'brandnew1')))?.status === 401);

  // Two resets must never collide - the second is what the student is holding.
  const second = await resetStudentPassword(db, ROSTER, MASTER);
  check('a master admin may reset on any stage', typeof second.password === 'string');
  check('each reset issues a different password', second.password !== out.password);

  // The signature is (db, studentId, staff) - there is deliberately no slot for
  // a caller-supplied password, so a representative can never set one they
  // already know on someone else's account.
  check('the caller cannot choose the password', resetStudentPassword.length === 3);

  let threw = false;
  try { assertStageAuthority(REP_4, 'stage_4'); } catch { threw = true; }
  check('a rep on their own stage passes the guard', !threw);
}

console.log('\nAccount deletion requests:');
{
  const DEL = 'delete.me@roster.mylecture.local';
  const DEL_UID = 'del_uid';

  await db.collection('students').doc(DEL).set({
    email: DEL, name: 'To Be Deleted', nameKey: nameKeyFor('To Be Deleted'),
    loginCode: 'C1-55555', loginCodeKey: 'C1-55555', googleEmail: 'del@gmail.com',
    password: sha('delpass'), isActive: true, stageId: 'stage_4', examCode: '7777',
  });
  await db.collection('users').doc(DEL_UID).set({
    email: DEL, name: 'To Be Deleted', role: 'student', stageId: 'stage_4',
  });
  await db.collection('fcm_tokens').doc(DEL_UID).set({ token: 'abc' });
  await db.collection('userMCQStats').doc(DEL_UID).set({ score: 10 });
  await db.collection('userMCQAnswers').doc(DEL_UID).collection('lectures').doc('l1').set({ a: 1 });
  await db.collection('chat_messages').doc('m1').set({
    senderId: DEL_UID, senderName: 'To Be Deleted', senderEmail: DEL, text: 'hello',
  });
  await db.collection('chat_messages').doc('m2').set({
    senderId: 'someone_else', senderName: 'Other', text: 'reply',
  });
  // The academic record that must SURVIVE - deleting it would destroy a
  // university result, which is the whole reason this is not a full wipe.
  await db.collection('degrees').doc(DEL).collection('exams').doc('e1').set({ score: 88 });

  const fakeAuth = { deleted: [] as string[], async deleteUser(uid: string) { this.deleted.push(uid); } };

  check('a request is created pending',
    (await requestAccountDeletion(db, FieldValue, {
      uid: DEL_UID, studentId: DEL, name: 'To Be Deleted', stageId: 'stage_4',
    })).uid === DEL_UID);
  check('...and is readable as pending',
    (await db.collection('deletion_requests').doc(DEL_UID).get()).data()!.status === 'pending');
  check('asking twice is refused rather than queued twice',
    (await caught(() => requestAccountDeletion(db, FieldValue, {
      uid: DEL_UID, studentId: DEL, name: 'x', stageId: 'stage_4',
    })))?.code === 'ALREADY_PENDING');

  check('a rep on another stage cannot approve',
    (await caught(() => reviewDeletionRequest(db, fakeAuth, FieldValue, {
      uid: DEL_UID, approve: true, reviewerUid: 'rep',
      staff: { isMasterAdmin: false, managedStageId: 'stage_3' },
    })))?.code === 'WRONG_STAGE');
  check('an unassigned admin cannot approve',
    (await caught(() => reviewDeletionRequest(db, fakeAuth, FieldValue, {
      uid: DEL_UID, approve: true, reviewerUid: 'rep',
      staff: { isMasterAdmin: false, managedStageId: null },
    })))?.code === 'NO_STAGE');
  check('nothing was deleted by a refused review', fakeAuth.deleted.length === 0);

  await cancelAccountDeletion(db, DEL_UID);
  check('a withdrawn request is gone',
    !(await db.collection('deletion_requests').doc(DEL_UID).get()).exists);
  await requestAccountDeletion(db, FieldValue, {
    uid: DEL_UID, studentId: DEL, name: 'To Be Deleted', stageId: 'stage_4',
  });

  const result = await reviewDeletionRequest(db, fakeAuth, FieldValue, {
    uid: DEL_UID, approve: true, reviewerUid: 'rep_uid',
    staff: { isMasterAdmin: false, managedStageId: 'stage_4' },
  });
  check('the rep for that stage CAN approve', result.status === 'approved');

  const gone = (await db.collection('students').doc(DEL).get()).data()!;
  check('the sign-in identity is deleted', fakeAuth.deleted.includes(DEL_UID));
  check('the profile is deleted', !(await db.collection('users').doc(DEL_UID).get()).exists);
  check('the push token is deleted', !(await db.collection('fcm_tokens').doc(DEL_UID).get()).exists);
  check('quiz stats are deleted', !(await db.collection('userMCQStats').doc(DEL_UID).get()).exists);
  check('quiz answers are purged',
    (await db.collection('userMCQAnswers').doc(DEL_UID).collection('lectures').get()).empty);

  // The credential kill is what makes the account unusable even if a later
  // step had failed.
  check('the roster record is deactivated', gone.isActive === false);
  check('the password is stripped', gone.password === undefined);
  check('the login code is stripped', gone.loginCode === undefined);
  check('the linked Google account is stripped', gone.googleEmail === undefined);
  check('it can no longer be found by name', gone.nameKey === undefined);
  check('the deletion is stamped', gone.deletedByRequest === true);
  check('the old password no longer signs in',
    (await caught(() => resolveStudentLogin(db, DEL, 'delpass'))) !== null);

  // Retained, and disclosed as retained in the privacy policy.
  check('the name is KEPT as an enrolment record', gone.name === 'To Be Deleted');
  check('the exam number is KEPT', gone.examCode === '7777');
  check('grades are KEPT',
    (await db.collection('degrees').doc(DEL).collection('exams').doc('e1').get()).exists);

  const m1 = (await db.collection('chat_messages').doc('m1').get()).data()!;
  check('their chat messages survive', m1.text === 'hello');
  check('...but the author is anonymised', m1.senderName === DELETED_AUTHOR_AR);
  check('...and the sender id is cleared', m1.senderId === undefined);
  check('...and the sender email is cleared', m1.senderEmail === undefined);
  const m2 = (await db.collection('chat_messages').doc('m2').get()).data()!;
  check('another student message is untouched', m2.senderName === 'Other');

  check('the request is marked approved',
    (await db.collection('deletion_requests').doc(DEL_UID).get()).data()!.status === 'approved');
  check('re-reviewing it is refused',
    (await caught(() => reviewDeletionRequest(db, fakeAuth, FieldValue, {
      uid: DEL_UID, approve: true, reviewerUid: 'rep_uid',
      staff: { isMasterAdmin: true },
    })))?.code === 'ALREADY_REVIEWED');

  // Purging is idempotent - a retry after a partial failure must not throw.
  const again = await purgeAccount(db, fakeAuth, FieldValue, { uid: DEL_UID, studentId: DEL });
  check('a second purge is harmless', Array.isArray(again.steps));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
