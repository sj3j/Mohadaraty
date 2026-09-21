/**
 * Verifies self-service signup against the Firestore emulator.
 *
 * Run with:  npm run test:signup
 *
 * The load-bearing assertion is that a PENDING request creates no usable
 * account: login is gated on students/{email}, so the queue is only a queue and
 * approval is what actually grants access.
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import 'dotenv/config';
import {
  createSignupRequest, reviewSignupRequest, SignupError,
  normalizeNamePart, composeFullName, findNameDuplicates,
} from '../shared/signupRequest';
import { nameKeyFor } from '../shared/rosterIdentity';

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

const hash = async (p: string) => `hashed:${p}`;
const base = {
  firstName: 'منتظر', fatherName: 'نهاد', grandfatherName: 'حسين',
  password: 'secret123', stageId: 'stage_3', subgroup: 'A1', examCode: '4471',
};

await db.collection('stages').doc('stage_3').set({
  id: 'stage_3', nameAr: 'المرحلة الثالثة', nameEn: 'Third', order: 3,
  groupConfig: { groups: [{ id: 'A', subgroupCount: 2 }, { id: 'B', subgroupCount: 2 }] },
});
await db.collection('students').doc('already@x.com').set({
  email: 'already@x.com', name: 'Existing', isActive: true, stageId: 'stage_3',
});

console.log('Name handling:');
check('tatweel is stripped', normalizeNamePart('محمـــد') === 'محمد', normalizeNamePart('محمـــد'));
check('zero-width joiners are stripped',
  normalizeNamePart('عبد‌الله') === 'عبدالله', normalizeNamePart('عبد‌الله'));
check('three parts compose into a full name',
  composeFullName({ ...base, email: 'a@x.com' } as any) === 'منتظر نهاد حسين');

let blank = false;
try { composeFullName({ ...base, grandfatherName: '  ', email: 'a@x.com' } as any); }
catch (e) { blank = e instanceof SignupError && (e as SignupError).code === 'NAME_INCOMPLETE'; }
check('a blank third part is rejected', blank);

let invisibleOnly = false;
try { composeFullName({ ...base, fatherName: '‌‍', email: 'a@x.com' } as any); }
catch (e) { invisibleOnly = e instanceof SignupError; }
check('a field of only invisible characters counts as blank', invisibleOnly);

console.log('\nRequest validation:');
const ok = await createSignupRequest(db, FieldValue as any, hash, { ...base, email: 'New@X.com' } as any);
check('email is lowercased', ok.email === 'new@x.com', ok.email);
const stored = (await db.doc('signup_requests/new@x.com').get()).data();
check('status is pending', stored?.status === 'pending');
check('password is HASHED, never stored in the clear',
  stored?.passwordHash === 'hashed:secret123' && stored?.password === undefined);
check('no expireAt on a pending row - a TTL would silently delete it',
  stored?.expireAt === undefined, String(stored?.expireAt));
check('full name composed from the three fields', stored?.fullName === 'منتظر نهاد حسين');

const guard = async (input: any, code: string, label: string) => {
  let got: string | undefined;
  try { await createSignupRequest(db, FieldValue as any, hash, input); }
  catch (e) { got = (e as SignupError).code; }
  check(label, got === code, `got ${got}`);
};

await guard({ ...base, email: 'bad', }, 'BAD_EMAIL', 'a malformed email is rejected');
await guard({ ...base, email: 'p@x.com', password: '123' }, 'WEAK_PASSWORD', 'a short password is rejected');
await guard({ ...base, email: 'p@x.com', subgroup: 'C9' }, 'BAD_SUBGROUP', 'a subgroup this stage does not have is rejected');
await guard({ ...base, email: 'p@x.com', stageId: 'stage_nope' }, 'BAD_STAGE', 'an unknown stage is rejected');
await guard({ ...base, email: 'p@x.com', examCode: '' }, 'EXAM_CODE_REQUIRED', 'a blank exam code with no opt-out is rejected');
await guard({ ...base, email: 'already@x.com' }, 'ALREADY_STUDENT', 'an existing student is told to log in');
await guard({ ...base, email: 'new@x.com' }, 'ALREADY_PENDING', 'a second request while pending is refused');

const noCode = await createSignupRequest(db, FieldValue as any, hash,
  { ...base, email: 'nocode@x.com', examCode: '', noExamCode: true } as any);
check('"I have no exam code yet" is accepted', noCode.noExamCode === true && noCode.examCode === null);

console.log('\nApproval is what grants access:');
check('a PENDING request creates no student record - so login is impossible',
  !(await db.doc('students/new@x.com').get()).exists);

let wrongStage = false;
try {
  await reviewSignupRequest(db, FieldValue as any, {
    email: 'new@x.com', approve: true, reviewerUid: 'rep2',
    reviewerStageId: 'stage_4', isMasterAdmin: false,
  });
} catch (e) { wrongStage = (e as SignupError).code === 'WRONG_STAGE'; }
check('a representative cannot approve another stage request', wrongStage);

await reviewSignupRequest(db, FieldValue as any, {
  email: 'new@x.com', approve: true, reviewerUid: 'rep1',
  reviewerStageId: 'stage_3', isMasterAdmin: false,
});
const student = (await db.doc('students/new@x.com').get()).data();
check('approval creates the student record', !!student);
check('...carrying the hash, so their chosen password works',
  student?.password === 'hashed:secret123');
check('...active, so login is now possible', student?.isActive === true);
check('...on the right stage and subgroup',
  student?.stageId === 'stage_3' && student?.subgroup === 'A1');
check('...with the full three-part name', student?.name === 'منتظر نهاد حسين');

const approved = (await db.doc('signup_requests/new@x.com').get()).data();
check('the request is marked approved', approved?.status === 'approved');
check('and NOW gets an expireAt for the TTL to purge', !!approved?.expireAt);

let twice = false;
try {
  await reviewSignupRequest(db, FieldValue as any, {
    email: 'new@x.com', approve: true, reviewerUid: 'rep1', isMasterAdmin: true,
  });
} catch (e) { twice = (e as SignupError).code === 'ALREADY_REVIEWED'; }
check('a request cannot be reviewed twice', twice);

console.log('\nRejection does not lock the email out:');
await createSignupRequest(db, FieldValue as any, hash, { ...base, email: 'rej@x.com' } as any);
await reviewSignupRequest(db, FieldValue as any, {
  email: 'rej@x.com', approve: false, reviewerUid: 'rep1', isMasterAdmin: true, reason: 'not enrolled',
});
const rejected = (await db.doc('signup_requests/rej@x.com').get()).data();
check('rejected, with the reason kept', rejected?.status === 'rejected' && rejected?.rejectionReason === 'not enrolled');
check('no student record was created', !(await db.doc('students/rej@x.com').get()).exists);

const reapply = await createSignupRequest(db, FieldValue as any, hash,
  { ...base, email: 'rej@x.com', subgroup: 'B2' } as any);
check('a REJECTED applicant can correct their details and re-apply',
  reapply.subgroup === 'B2');
check('and the row is pending again, with expireAt cleared',
  (await db.doc('signup_requests/rej@x.com').get()).data()?.status === 'pending' &&
  (await db.doc('signup_requests/rej@x.com').get()).data()?.expireAt === undefined);


// ---------------------------------------------------------------------------
// DUPLICATE DETECTION - and, just as importantly, what it must NOT key on.
//
// The signup form is where the second account was actually created: a student
// with a roster account pressed Google with a personal address, was told there
// was no account, and filled this form. The block lives at REVIEW rather than
// at request, because a student stopped here has nowhere to go, and a dead end
// is what produced the duplicates in the first place.
// ---------------------------------------------------------------------------
console.log('');
console.log('Duplicate detection:');

const DUP_NAME = 'منتظر نهاد حسين';
await db.collection('students').doc('roster-dup@x.com').set({
  email: 'roster-dup@x.com', name: DUP_NAME, nameKey: nameKeyFor(DUP_NAME),
  isActive: true, stageId: 'stage_3', examCode: '4471',
});

const flagged = await createSignupRequest(db, FieldValue as any, hash,
  { ...base, email: 'dup@x.com' } as any);
check('a namesake does NOT block the request', flagged.email === 'dup@x.com');
const flaggedDoc = await db.doc('signup_requests/dup@x.com').get();
check('...it is recorded for the reviewer instead',
  (flaggedDoc.data()?.possibleDuplicateOf || []).includes('roster-dup@x.com'),
  JSON.stringify(flaggedDoc.data()?.possibleDuplicateOf));

let dupBlocked: SignupError | null = null;
try {
  await reviewSignupRequest(db, FieldValue as any, {
    email: 'dup@x.com', approve: true, reviewerUid: 'rep', isMasterAdmin: true,
  });
} catch (e) { dupBlocked = e as SignupError; }
check('approving a namesake is refused',
  dupBlocked?.code === 'DUPLICATE_NAME_IN_STAGE', String(dupBlocked?.code));
check('and no student record was created by the refusal',
  !(await db.doc('students/dup@x.com').get()).exists);

// Two students in one cohort really can share a three-part name, so the
// override has to exist - as a decision the reviewer makes, not a default.
await reviewSignupRequest(db, FieldValue as any, {
  email: 'dup@x.com', approve: true, reviewerUid: 'rep', isMasterAdmin: true, force: true,
});
check('force: true approves a genuine namesake',
  (await db.doc('students/dup@x.com').get()).exists);

// The same name in ANOTHER stage is a different person's problem entirely.
await db.collection('stages').doc('stage_4').set({
  id: 'stage_4', nameAr: 'الرابعة', nameEn: 'Fourth', order: 4,
  groupConfig: { groups: [{ id: 'A', subgroupCount: 2 }, { id: 'B', subgroupCount: 2 }] },
});
const otherStage = await findNameDuplicates(db, DUP_NAME, 'stage_4');
check('a namesake in a DIFFERENT stage is not a duplicate',
  otherStage.length === 0, JSON.stringify(otherStage));

// A row a merge already retired is resolved, not a duplicate to report again.
await db.collection('students').doc('retired-dup@x.com').set({
  email: 'retired-dup@x.com', name: DUP_NAME, nameKey: nameKeyFor(DUP_NAME),
  isActive: false, stageId: 'stage_4', mergedInto: 'roster-dup@x.com',
});
const afterRetire = await findNameDuplicates(db, DUP_NAME, 'stage_4');
check('a retired (merged) row is not reported as a duplicate',
  afterRetire.length === 0, JSON.stringify(afterRetire));

// THE RULE THIS DESIGN EXISTS TO PROTECT. Exam codes are reissued every year,
// so they identify a year's enrolment rather than a person: matching on one
// would refuse a genuine new student whose freshly issued code collides with a
// stale one, and miss a real duplicate whose code has rolled over.
await db.collection('students').doc('samecode@x.com').set({
  email: 'samecode@x.com', name: 'شخص آخر تماما', nameKey: nameKeyFor('شخص آخر تماما'),
  isActive: true, stageId: 'stage_3', examCode: '4471',
});
const sameCode = await createSignupRequest(db, FieldValue as any, hash,
  { ...base, firstName: 'كرار', fatherName: 'سعد', grandfatherName: 'جبار',
    email: 'samecode-new@x.com', examCode: '4471' } as any);
check('a shared EXAM CODE does not flag a request', sameCode.email === 'samecode-new@x.com');
const sameCodeDoc = await db.doc('signup_requests/samecode-new@x.com').get();
check('...and nothing was recorded against it',
  (sameCodeDoc.data()?.possibleDuplicateOf || []).length === 0,
  JSON.stringify(sameCodeDoc.data()?.possibleDuplicateOf));
await reviewSignupRequest(db, FieldValue as any, {
  email: 'samecode-new@x.com', approve: true, reviewerUid: 'rep', isMasterAdmin: true,
});
check('...and a shared EXAM CODE never blocks approval',
  (await db.doc('students/samecode-new@x.com').get()).exists);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
