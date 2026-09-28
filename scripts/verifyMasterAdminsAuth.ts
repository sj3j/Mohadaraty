/**
 * Pre-Flight Safety Verification: Admin Lockout Prevention
 *
 * Checks all designated master admin accounts in Firebase Auth to ensure their
 * emails are verified (`emailVerified === true`) before security rules enforce it.
 *
 * Usage:
 *   npx tsx scripts/verifyMasterAdminsAuth.ts           # Dry-run audit
 *   npx tsx scripts/verifyMasterAdminsAuth.ts --commit  # Ensure emailVerified: true & custom claims
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import 'dotenv/config';
import { MASTER_ADMIN_EMAILS } from '../shared/masterAdmins';

const commit = process.argv.includes('--commit');

const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  console.error('Missing FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY in .env');
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

const auth = getAuth();

async function main() {
  console.log(`\n=== Master Admin Auth Pre-Flight Verification ===`);
  console.log(`Mode: ${commit ? 'COMMIT (will update accounts if needed)' : 'AUDIT (read-only)'}\n`);

  let allVerified = true;

  for (const email of MASTER_ADMIN_EMAILS) {
    try {
      const user = await auth.getUserByEmail(email);
      console.log(`[FOUND] ${email}`);
      console.log(`  UID:            ${user.uid}`);
      console.log(`  Email Verified: ${user.emailVerified ? 'YES' : 'NO'}`);
      console.log(`  Custom Claims:  ${JSON.stringify(user.customClaims || {})}`);

      if (!user.emailVerified) {
        allVerified = false;
        if (commit) {
          await auth.updateUser(user.uid, { emailVerified: true });
          console.log(`  -> [UPDATED] emailVerified set to true for ${email}`);
        } else {
          console.warn(`  -> [ACTION REQUIRED] Run with --commit to set emailVerified: true`);
        }
      }

      if (commit && user.customClaims?.role !== 'master_admin') {
        await auth.setCustomUserClaims(user.uid, {
          ...(user.customClaims || {}),
          role: 'master_admin',
        });
        console.log(`  -> [UPDATED] custom claim role set to 'master_admin' for ${email}`);
      }
    } catch (err: any) {
      if (err.code === 'auth/user-not-found') {
        console.warn(`[NOT FOUND] No Firebase Auth account exists for ${email}`);
      } else {
        console.error(`[ERROR] Failed to query ${email}:`, err.message);
      }
      allVerified = false;
    }
    console.log('');
  }

  if (allVerified) {
    console.log('✓ All master admin accounts are verified and safe for rule deployment.\n');
  } else if (!commit) {
    console.warn('⚠️  Some accounts require verification. Run with --commit before deploying rules.\n');
  }
}

main().catch((err) => {
  console.error('Pre-flight check failed:', err);
  process.exit(1);
});
