/**
 * Irreversibly deletes one account by uid.
 *
 *   npx tsx scripts/purgeUser.ts --uid <uid>                 # dry run
 *   npx tsx scripts/purgeUser.ts --uid <uid> --commit
 *
 * DRY RUN IS THE DEFAULT. Nothing is written without --commit.
 *
 * Reuses purgeAccount() from shared/accountDeletion.ts so this behaves exactly
 * like the in-app deletion queue, minus the request/review workflow - this is for
 * an admin removing a duplicate account, not a student exercising erasure.
 *
 * WHY --student-id DEFAULTS TO EMPTY
 *
 * purgeAccount's FIRST step strips the password and sets isActive:false on
 * students/{studentId}. That is correct when the account being deleted owns that
 * roster row. It is catastrophic when it does not.
 *
 * This project has two identity spaces: roster students authenticate with a
 * custom token whose uid IS their college email, while Google sign-ins get an
 * opaque uid. The same human can hold BOTH, linked only by examCode. Deleting
 * the Google duplicate while passing the roster id would disable the roster row
 * that the SURVIVING account signs in with, locking the student out permanently.
 *
 * So the roster row is left alone unless --student-id is passed explicitly.
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import 'dotenv/config';
import { purgeAccount } from '../shared/accountDeletion';

const argv = process.argv.slice(2);
const flag = (name: string, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name: string) => argv.includes(`--${name}`);

const uid = flag('uid');
const studentId = flag('student-id'); // deliberately empty unless asked for
const commit = has('commit');

if (!uid) {
  console.error('Usage: npx tsx scripts/purgeUser.ts --uid <uid> [--student-id <email>] [--commit]');
  process.exit(1);
}

const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  console.error('.env is missing FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY.');
  process.exit(1);
}
initializeApp({
  credential: cert({
    projectId: FIREBASE_PROJECT_ID,
    clientEmail: FIREBASE_CLIENT_EMAIL,
    privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
  projectId: FIREBASE_PROJECT_ID,
});
const db = getFirestore();
const auth = getAuth();

async function main() {
  console.log(`\nTarget : project ${FIREBASE_PROJECT_ID}${process.env.FIRESTORE_EMULATOR_HOST ? ' (EMULATOR)' : ' (LIVE)'}`);
  console.log(`Mode   : ${commit ? 'COMMIT - the account will be destroyed' : 'DRY RUN - nothing will be written'}`);
  console.log(`uid    : ${uid}`);
  console.log(`student: ${studentId || '(none - roster row left untouched)'}\n`);

  // ---- show exactly what is about to go -----------------------------------
  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) {
    console.log('users/%s does not exist. Nothing to delete there.', uid);
  } else {
    const d = userSnap.data()!;
    console.log('users/%s', uid);
    console.log(`  name       : ${d.name}`);
    console.log(`  email      : ${d.email || '(none)'}`);
    console.log(`  role       : ${d.role}`);
    console.log(`  stageId    : ${d.stageId}`);
    console.log(`  examCode   : ${d.examCode || '(none)'}`);
    console.log(`  streak     : ${d.streakCount ?? 0} / best ${d.bestStreakAllTime ?? 0}`);
  }

  let authUser: any = null;
  try {
    authUser = await auth.getUser(uid);
    console.log(`\nauth user  : exists (customAuth=${!!authUser.customClaims}, providers=${authUser.providerData.map((p: any) => p.providerId).join(',') || 'none'})`);
  } catch {
    console.log('\nauth user  : not found');
  }

  // purgeAccount deletes users/{uid} but Firestore leaves subcollections
  // behind, so anything under it becomes unreachable rather than deleted.
  const subcollections = await db.collection('users').doc(uid).listCollections();
  console.log(`\nsubcollections under users/${uid}: ${subcollections.length ? subcollections.map(c => c.id).join(', ') : '(none)'}`);
  for (const sub of subcollections) {
    const docs = await sub.get();
    for (const d of docs.docs) {
      console.log(`  ${sub.id}/${d.id}  ${JSON.stringify(d.data()).slice(0, 120)}`);
    }
  }

  if (studentId) {
    console.log(`\n!! --student-id was passed: students/${studentId} will be DISABLED`);
    console.log('   (password stripped, isActive:false). Make sure no other account signs in with it.');
  }

  if (!commit) {
    console.log('\nDry run - re-run with --commit to apply.\n');
    return;
  }

  // ---- delete --------------------------------------------------------------
  // Subcollections first: purgeAccount removes the parent doc, after which these
  // are orphaned and much harder to find.
  for (const sub of subcollections) {
    const docs = await sub.get();
    if (docs.empty) continue;
    const batch = db.batch();
    docs.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    console.log(`deleted ${docs.size} doc(s) from users/${uid}/${sub.id}`);
  }

  const { steps } = await purgeAccount(db, auth, FieldValue as any, { uid, studentId });
  console.log('\npurgeAccount steps:');
  steps.forEach(s => console.log(`  ${s}`));

  // ---- verify --------------------------------------------------------------
  const after = await db.collection('users').doc(uid).get();
  console.log(`\nusers/${uid} exists after: ${after.exists}`);
  let authAfter = 'deleted';
  try { await auth.getUser(uid); authAfter = 'STILL EXISTS'; } catch { /* expected */ }
  console.log(`auth user after       : ${authAfter}`);

  console.log('\nDone.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
