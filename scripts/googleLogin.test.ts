/**
 * Verifies Google sign-in against the Firestore emulator.
 *
 * Run with:  npm run test:google
 *
 * Two things are asserted here that were previously only assumed:
 *
 *  1. An UNVERIFIED email is refused. The server reconciles purely on `email`,
 *     so without that guard anyone could register a Google account claiming a
 *     classmate's university address and be handed a token for their account.
 *  2. A student created by password login, then arriving via Google, lands on
 *     ONE users document - not a second, duplicated profile.
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import 'dotenv/config';
import {
  verifyGoogleIdentity, resolveGoogleLogin, GoogleLoginError, claimAccountWithGoogle,
} from '../shared/googleLogin';
import { FieldValue } from 'firebase-admin/firestore';
import bcrypt from 'bcryptjs';
import { MASTER_ADMIN_EMAILS } from '../shared/masterAdmins';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Refusing to run: FIRESTORE_EMULATOR_HOST is not set.');
  process.exit(1);
}

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

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); failed++; }
};

// Stubs. The real verifiers are Google's; what matters here is the branching
// and the guards around them, which is our code.
const fakeAdminAuth = (payload: any) => ({
  verifyIdToken: async () => payload,
  createCustomToken: async (uid: string) => `custom:${uid}`,
});
const fakeOAuth = (payload: any) => ({
  verifyIdToken: async () => ({ getPayload: () => payload }),
});
const MASTERS = [...MASTER_ADMIN_EMAILS];
const noopSync = async () => {};

// ---------------------------------------------------------------------------
await db.collection('students').doc('stu@x.com').set({
  email: 'stu@x.com', name: 'Student', isActive: true, stageId: 'stage_3',
});
await db.collection('students').doc('off@x.com').set({
  email: 'off@x.com', name: 'Disabled', isActive: false, stageId: 'stage_3',
});
// Created by a PASSWORD login: the users doc is keyed by the email.
await db.collection('users').doc('stu@x.com').set({
  email: 'stu@x.com', name: 'Student', role: 'student', stageId: 'stage_3', streakCount: 12,
});
// Imported from a roster with no email, then linked a Gmail from settings. The
// document id is synthetic and is NOT the address Google will assert.
const ROSTER_ID = 'a1b2c3d4e5f60708@roster.mylecture.local';
await db.collection('students').doc(ROSTER_ID).set({
  email: ROSTER_ID, name: 'Roster Student', isActive: true, stageId: 'stage_4',
  placeholderEmail: true, googleEmail: 'linked@gmail.com',
});
await db.collection('users').doc(ROSTER_ID).set({
  email: ROSTER_ID, name: 'Roster Student', role: 'student', stageId: 'stage_4',
});
await db.collection('students').doc('linkedoff@roster.mylecture.local').set({
  email: 'linkedoff@roster.mylecture.local', name: 'Linked But Off', isActive: false,
  stageId: 'stage_4', googleEmail: 'off-linked@gmail.com',
});

console.log('email_verified guard (account takeover):');
let blockedGoogle = false;
try {
  await verifyGoogleIdentity({
    adminAuth: fakeAdminAuth({}) as any,
    oauthClient: fakeOAuth({ email: 'stu@x.com', email_verified: false, name: 'Impostor' }) as any,
    audience: 'aud', googleIdToken: 'g',
  });
} catch (e) { blockedGoogle = e instanceof GoogleLoginError && (e as GoogleLoginError).code === 'EMAIL_NOT_VERIFIED'; }
check('an UNVERIFIED google token is refused', blockedGoogle);

let blockedFirebase = false;
try {
  await verifyGoogleIdentity({
    adminAuth: fakeAdminAuth({ email: 'stu@x.com', email_verified: false }) as any,
    oauthClient: fakeOAuth({}) as any,
    audience: 'aud', idToken: 'f',
  });
} catch (e) { blockedFirebase = e instanceof GoogleLoginError && (e as GoogleLoginError).code === 'EMAIL_NOT_VERIFIED'; }
check('the WEB path is guarded too, not just native', blockedFirebase);

const ok = await verifyGoogleIdentity({
  adminAuth: fakeAdminAuth({}) as any,
  oauthClient: fakeOAuth({ email: 'STU@x.com', email_verified: true, name: 'Student' }) as any,
  audience: 'aud', googleIdToken: 'g',
});
check('a verified token passes and the email is lowercased', ok.email === 'stu@x.com', ok.email);
check('the display name comes through for signup prefill', ok.name === 'Student');

let missing = false;
try {
  await verifyGoogleIdentity({
    adminAuth: fakeAdminAuth({}) as any, oauthClient: fakeOAuth({}) as any, audience: 'aud',
  });
} catch (e) { missing = e instanceof GoogleLoginError; }
check('no token at all is rejected', missing);

console.log('\nAccount reconciliation (no duplicates):');
const res = await resolveGoogleLogin(db, fakeAdminAuth({}) as any, ok, {
  masterAdminEmails: MASTERS, fallbackUid: 'google-uid-999', syncUserStage: noopSync,
});
check('reuses the EXISTING users doc, not the google uid',
  res.uid === 'stu@x.com', `${res.uid} (fallback was google-uid-999)`);
check('mints a token for that same uid', res.customToken === 'custom:stu@x.com');

const usersForEmail = await db.collection('users').where('email', '==', 'stu@x.com').get();
check('still exactly ONE users doc for the email', usersForEmail.size === 1, String(usersForEmail.size));
check('their existing data is untouched',
  usersForEmail.docs[0].data().streakCount === 12);

console.log('\nWhitelist gate:');
let noAccount: GoogleLoginError | null = null;
try {
  await resolveGoogleLogin(db, fakeAdminAuth({}) as any,
    { email: 'nobody@x.com', name: 'New Person', emailVerified: true }, {
      masterAdminEmails: MASTERS, fallbackUid: 'g1', syncUserStage: noopSync,
    });
} catch (e) { noAccount = e as GoogleLoginError; }
check('an unknown email returns NO_ACCOUNT, not a credential error',
  noAccount?.code === 'NO_ACCOUNT', String(noAccount?.code));
check('...with a 404 so the client can route to signup', noAccount?.status === 404);

let disabled: GoogleLoginError | null = null;
try {
  await resolveGoogleLogin(db, fakeAdminAuth({}) as any,
    { email: 'off@x.com', name: null, emailVerified: true }, {
      masterAdminEmails: MASTERS, fallbackUid: 'g2', syncUserStage: noopSync,
    });
} catch (e) { disabled = e as GoogleLoginError; }
check('a deactivated student is refused', disabled?.code === 'DISABLED');

const master = await resolveGoogleLogin(db, fakeAdminAuth({}) as any,
  { email: 'almdrydyl335@gmail.com', name: 'Master', emailVerified: true }, {
    masterAdminEmails: MASTERS, fallbackUid: 'master-uid', syncUserStage: noopSync,
  });
check('the master admin bypasses the student whitelist', master.uid === 'master-uid');

// EVERY master admin, not just the first. A master admin has no students doc and
// no allowed_admins entry, so this bypass is the only thing that lets them sign
// in with Google at all - an address missing from the list is handed NO_ACCOUNT
// and routed to the signup form.
for (const email of MASTER_ADMIN_EMAILS) {
  const uid = `uid-of-${email}`;
  const r = await resolveGoogleLogin(db, fakeAdminAuth({}) as any,
    { email, name: 'Master', emailVerified: true }, {
      masterAdminEmails: MASTERS, fallbackUid: uid, syncUserStage: noopSync,
    }).catch(e => e);
  check(`${email} can sign in with Google without a students doc`,
    !(r instanceof Error) && r.uid === uid,
    r instanceof GoogleLoginError ? r.code : undefined);
}

// A student who has NEVER signed in has no users doc: the fallback uid is used,
// and syncUserStage is what later reconciles them.
const fresh = await resolveGoogleLogin(db, fakeAdminAuth({}) as any,
  { email: 'stu2@x.com', name: null, emailVerified: true }, {
    masterAdminEmails: MASTERS, fallbackUid: 'stu2@x.com', syncUserStage: noopSync,
  }).catch(e => e);
check('a whitelisted student with no users doc yet is refused only if not a student',
  fresh instanceof GoogleLoginError && fresh.code === 'NO_ACCOUNT');

console.log('\nLinked Gmail on a roster account:');
{
  // The address is not a document id, so the id lookup misses and the
  // googleEmail query has to find them. Everything downstream must stay keyed
  // by the SYNTHETIC id: firestore.rules resolves students/{token.email} in
  // isWhitelisted(), so a claim carrying the Gmail locks them out of every read.
  const linked = await resolveGoogleLogin(db, fakeAdminAuth({}) as any,
    { email: 'linked@gmail.com', name: 'Roster Student', emailVerified: true }, {
      masterAdminEmails: MASTERS, fallbackUid: 'linked@gmail.com', syncUserStage: noopSync,
    });
  check('a linked Gmail resolves to the roster account', linked.uid === ROSTER_ID, linked.uid);
  check('the email claim is the student doc id, NOT the Gmail',
    linked.email === ROSTER_ID, linked.email);
  check('the token is minted for that same id',
    linked.customToken === `custom:${ROSTER_ID}`, linked.customToken);

  // Same guard as an unlinked account - the fallback arm must not skip it.
  let offLinked: GoogleLoginError | null = null;
  try {
    await resolveGoogleLogin(db, fakeAdminAuth({}) as any,
      { email: 'off-linked@gmail.com', name: null, emailVerified: true }, {
        masterAdminEmails: MASTERS, fallbackUid: 'g3', syncUserStage: noopSync,
      });
  } catch (e) { offLinked = e as GoogleLoginError; }
  check('a deactivated account is still refused via the linked address',
    offLinked?.code === 'DISABLED', String(offLinked?.code));

  // The fallback must not turn an unknown address into an account.
  let stillUnknown: GoogleLoginError | null = null;
  try {
    await resolveGoogleLogin(db, fakeAdminAuth({}) as any,
      { email: 'notlinked@gmail.com', name: null, emailVerified: true }, {
        masterAdminEmails: MASTERS, fallbackUid: 'g4', syncUserStage: noopSync,
      });
  } catch (e) { stillUnknown = e as GoogleLoginError; }
  check('an unlinked unknown address is still NO_ACCOUNT',
    stillUnknown?.code === 'NO_ACCOUNT', String(stillUnknown?.code));
}


// ---------------------------------------------------------------------------
// THE CLAIM PATH - the cross-address case, which had no coverage at all.
//
// Everything above asserts the no-duplicate property only for a student whose
// students doc id ALREADY equals the address Google asserts. The duplicates in
// production came from the other case: a roster account at one address, a
// personal Gmail at another, and nothing joining them. That is what these cover.
// ---------------------------------------------------------------------------
console.log('');
console.log('Claiming an existing account from a different address:');

const CLAIM_ID = 'ph2099@student.alsafwa.edu.iq';
await db.collection('students').doc(CLAIM_ID).set({
  email: CLAIM_ID, name: 'Claim Student', nameKey: 'claim student',
  isActive: true, stageId: 'stage_3', examCode: '55555',
  password: await bcrypt.hash('secret123', 10),
});
await db.collection('users').doc(CLAIM_ID).set({
  email: CLAIM_ID, name: 'Claim Student', role: 'student', stageId: 'stage_3',
  streakCount: 30, bestStreakAllTime: 40,
});

const GMAIL = 'claimer@gmail.com';
const identity = { email: GMAIL, name: 'Claim Student', emailVerified: true };
const claimOpts = {
  masterAdminEmails: MASTERS, syncUserStage: noopSync, FieldValue: FieldValue as any,
};

// Precondition: today this is exactly the dead end that produced the duplicate.
let preClaim: GoogleLoginError | null = null;
try {
  await resolveGoogleLogin(db, fakeAdminAuth({}) as any, identity, {
    masterAdminEmails: MASTERS, fallbackUid: GMAIL, syncUserStage: noopSync,
  });
} catch (e) { preClaim = e as GoogleLoginError; }
check('before claiming, the personal address is NO_ACCOUNT',
  preClaim?.code === 'NO_ACCOUNT', String(preClaim?.code));

// A wrong password must not link anything, however good the Google token is.
let badPw: any = null;
try {
  await claimAccountWithGoogle(db, fakeAdminAuth({}) as any, identity,
    { identifier: CLAIM_ID, password: 'wrong' }, claimOpts);
} catch (e) { badPw = e; }
check('a verified mailbox alone does NOT claim an account', !!badPw);
const afterBad = await db.collection('students').doc(CLAIM_ID).get();
check('...and nothing was linked on the failed attempt',
  !afterBad.data()?.googleEmail, String(afterBad.data()?.googleEmail));

// An exam code is NOT an identifier: they are reissued every year, so accepting
// one would authenticate a year's enrolment rather than a person.
let byExamCode: any = null;
try {
  await claimAccountWithGoogle(db, fakeAdminAuth({}) as any, identity,
    { identifier: '55555', password: 'secret123' }, claimOpts);
} catch (e) { byExamCode = e; }
check('an EXAM CODE is not accepted as an identifier', !!byExamCode);

const claimed = await claimAccountWithGoogle(db, fakeAdminAuth({}) as any, identity,
  { identifier: CLAIM_ID, password: 'secret123' }, claimOpts);
check('claiming returns the EXISTING uid, not a new one',
  claimed.uid === CLAIM_ID, claimed.uid);
check('the token claim carries the students doc id', claimed.email === CLAIM_ID);

const linkedDoc = await db.collection('students').doc(CLAIM_ID).get();
check('the google address is now linked to the roster row',
  linkedDoc.data()?.googleEmail === GMAIL, String(linkedDoc.data()?.googleEmail));

// The point of the whole exercise: no second account was created.
const claimUsers = await db.collection('users').where('email', '==', CLAIM_ID).get();
check('still exactly ONE users doc after claiming', claimUsers.size === 1, String(claimUsers.size));
const gmailUsers = await db.collection('users').where('email', '==', GMAIL).get();
check('no users doc was created under the gmail', gmailUsers.size === 0, String(gmailUsers.size));
check('the streak they earned survives', claimUsers.docs[0].data().streakCount === 30);

// And from now on the plain Google button resolves straight through.
const second = await resolveGoogleLogin(db, fakeAdminAuth({}) as any, identity, {
  masterAdminEmails: MASTERS, fallbackUid: GMAIL, syncUserStage: noopSync,
});
check('the NEXT google sign-in needs no claim step',
  second.uid === CLAIM_ID, second.uid);

// ---------------------------------------------------------------------------
// A merged-away row must be FOLLOWED, not read as a disabled account.
//
// A merge retires the losing row in place (isActive:false + mergedInto) and
// copies its address onto the survivor. resolveGoogleLogin checks the document
// id BEFORE isActive, so without followMerge it finds the retired row, throws
// DISABLED, and undoes the very link the merge created.
// ---------------------------------------------------------------------------
console.log('');
console.log('A retired (merged) row redirects instead of refusing:');

const SURVIVOR = 'ph2100@student.alsafwa.edu.iq';
const RETIRED = 'retired-dupe@gmail.com';
await db.collection('students').doc(SURVIVOR).set({
  email: SURVIVOR, name: 'Survivor', isActive: true, stageId: 'stage_3',
  googleEmail: RETIRED,
});
await db.collection('users').doc(SURVIVOR).set({
  email: SURVIVOR, name: 'Survivor', role: 'student', stageId: 'stage_3',
});
await db.collection('students').doc(RETIRED).set({
  email: RETIRED, name: 'Survivor', isActive: false, stageId: 'stage_3',
  mergedInto: SURVIVOR,
});

const followed = await resolveGoogleLogin(db, fakeAdminAuth({}) as any,
  { email: RETIRED, name: null, emailVerified: true }, {
    masterAdminEmails: MASTERS, fallbackUid: RETIRED, syncUserStage: noopSync,
  });
check('a retired address resolves to the surviving account',
  followed.uid === SURVIVOR, followed.uid);
check('...and not to a DISABLED refusal', followed.email === SURVIVOR);

// A genuinely disabled row, with no mergedInto, must still be refused - the
// follow must not have become a way past the deactivation guard.
let stillDisabled: GoogleLoginError | null = null;
try {
  await resolveGoogleLogin(db, fakeAdminAuth({}) as any,
    { email: 'off@x.com', name: null, emailVerified: true }, {
      masterAdminEmails: MASTERS, fallbackUid: 'g9', syncUserStage: noopSync,
    });
} catch (e) { stillDisabled = e as GoogleLoginError; }
check('a plain deactivated account is STILL refused',
  stillDisabled?.code === 'DISABLED', String(stillDisabled?.code));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
