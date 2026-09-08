import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';
import 'dotenv/config';

// Pins each stage representative to the stage they manage, and marks the master admin.
//
// WHY THIS EXISTS
// The multi-stage role model is already built (src/lib/permissions.ts,
// src/contexts/StageContext.tsx) but it keys off two fields that no production
// account carries yet:
//
//   users/{uid}.managedStageId  - the stage a representative/moderator is locked to
//   users/{uid}.isMasterAdmin   - the only role that may switch stages
//
// Without managedStageId, effectiveStageId falls back to currentAppStage, which is
// localStorage on the client - so every representative silently operates on whichever
// stage the picker happens to hold. And firestore.rules canWriteStage() treats an empty
// managedStageId as "may write to ANY stage". Assigning these fields is therefore a
// prerequisite for closing that fallback; run this BEFORE deploying the tightened rules,
// or every representative is locked out at once.
//
// Credentials: pass a service account JSON path, or leave it out to use
// FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY from .env
// (the same vars server.ts authenticates with).
//
// Usage: node scripts/assignStageRepresentatives.mjs [serviceAccountKey.json] [--apply]
//
// Dry run is the DEFAULT. Nothing is written until you pass --apply.

// Must stay identical to DEFAULT_STAGES in src/contexts/StageContext.tsx and
// scripts/migrateToStages.js.
const STAGE_IDS = ['stage_1', 'stage_2', 'stage_3', 'stage_4', 'stage_5'];

// ---------------------------------------------------------------------------
// FILL THIS IN. One email per stage, lowercase.
//
// Leave a stage as null to skip it - the script reports it as unassigned rather
// than guessing. An email that has no users doc is reported, not created: a
// representative must sign in once before they can be pinned to a stage.
// ---------------------------------------------------------------------------
const REPRESENTATIVES = {
  stage_1: null,
  stage_2: null,
  stage_3: null,
  stage_4: null,
  stage_5: null,
};

// The accounts that may switch stages and reach the master-only surfaces
// (streak system, MCQ bank, admin log, subscriptions). The list is
// shared/masterAdmins.ts; firestore.rules repeats it as a break-glass fallback.
// This is a .mjs script and cannot import the .ts module, so it re-states the
// addresses and `npm run test:masters` fails if they drift.
const MASTER_ADMIN_EMAILS = [
  'almdrydyl335@gmail.com',
  'dra016go@gmail.com',
  'jempe.kn@gmail.com',
];

// Admin accounts that are NOT in REPRESENTATIVES and NOT the master admin.
// 'report'  - list them and do nothing (default; safe)
// 'demote'  - set role to 'moderator', stripping student/grade access
const SURPLUS_ADMIN_POLICY = 'report';

/** Every users doc matching an email, keyed by doc id. Email is not the doc id
 *  for accounts created through the normal login path, so this scans rather
 *  than gets - the collection is ~420 docs, so one read pass is cheap. */
async function indexUsersByEmail(db) {
  const snapshot = await db.collection('users').get();
  const byEmail = new Map();
  for (const doc of snapshot.docs) {
    const email = (doc.data().email || '').toLowerCase();
    if (!email) continue;
    if (!byEmail.has(email)) byEmail.set(email, []);
    byEmail.get(email).push(doc);
  }
  return byEmail;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const serviceAccountPath = args.find((a) => !a.startsWith('--')) || null;

  for (const [stageId, email] of Object.entries(REPRESENTATIVES)) {
    if (!STAGE_IDS.includes(stageId)) {
      console.error(`Unknown stage "${stageId}" in REPRESENTATIVES. Expected one of: ${STAGE_IDS.join(', ')}`);
      process.exit(1);
    }
    if (email !== null && typeof email !== 'string') {
      console.error(`REPRESENTATIVES.${stageId} must be an email string or null.`);
      process.exit(1);
    }
  }

  const assigned = Object.entries(REPRESENTATIVES).filter(([, e]) => e);
  if (assigned.length === 0) {
    console.error('REPRESENTATIVES is empty - fill in at least one stage before running.');
    console.error('Edit the map at the top of scripts/assignStageRepresentatives.mjs.');
    process.exit(1);
  }

  // One email must not represent two stages: managedStageId is a single field, so
  // the second assignment would silently overwrite the first.
  const seen = new Map();
  for (const [stageId, email] of assigned) {
    const key = email.toLowerCase();
    if (seen.has(key)) {
      console.error(`${email} is listed for both ${seen.get(key)} and ${stageId}. One account can manage only one stage.`);
      process.exit(1);
    }
    seen.set(key, stageId);
  }

  let credential;
  if (serviceAccountPath) {
    credential = cert(JSON.parse(readFileSync(serviceAccountPath, 'utf8')));
  } else {
    const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
    if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
      console.error('No service account path given and .env is missing FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY.');
      process.exit(1);
    }
    credential = cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });
    console.log(`Authenticating as ${FIREBASE_CLIENT_EMAIL} (project ${FIREBASE_PROJECT_ID}).`);
  }

  initializeApp({ credential });
  const db = getFirestore();

  console.log(apply ? '\nAPPLYING changes.\n' : '\nDRY RUN - nothing will be written. Re-run with --apply to commit.\n');

  const byEmail = await indexUsersByEmail(db);
  const claimedUids = new Set();
  let writes = 0;
  let problems = 0;

  console.log('Stage representatives');
  console.log('---------------------');

  for (const stageId of STAGE_IDS) {
    const email = REPRESENTATIVES[stageId];
    if (!email) {
      console.log(`  ${stageId}  (unassigned - no representative given)`);
      continue;
    }

    const key = email.toLowerCase();
    const docs = byEmail.get(key) || [];

    if (docs.length === 0) {
      console.log(`  ${stageId}  ${email}  NOT FOUND - they must sign in once before being pinned`);
      problems++;
      continue;
    }

    // Duplicate docs happen when api/index.ts mints a token against the email as
    // the uid instead of resolving the real one. Pin every copy: whichever the
    // client ends up reading must carry the same stage.
    if (docs.length > 1) {
      console.log(`  ${stageId}  ${email}  ${docs.length} user docs share this email - pinning all of them`);
      console.log(`             ids: ${docs.map((d) => d.id).join(', ')}`);
      problems++;
    }

    for (const doc of docs) {
      claimedUids.add(doc.id);
      const data = doc.data();
      const patch = {};

      if (data.managedStageId !== stageId) patch.managedStageId = stageId;
      // A representative is role 'admin' (see src/lib/permissions.ts:38). A doc
      // that is still 'student' would pass no staff check at all.
      if (data.role !== 'admin') patch.role = 'admin';

      if (Object.keys(patch).length === 0) {
        console.log(`  ${stageId}  ${email}  already correct`);
        continue;
      }

      const summary = Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', ');
      console.log(`  ${stageId}  ${email}  ${apply ? 'setting' : 'would set'} ${summary}  (${doc.id})`);
      if (apply) {
        await doc.ref.update(patch);
        writes++;
      }

      // allowed_admins is the other source myManagedStage() and syncUserStage read.
      // Keep it in step or a login will overwrite the users doc from a stale value.
      const allowedRef = db.collection('allowed_admins').doc(key);
      const allowed = await allowedRef.get();
      if (allowed.exists && allowed.data().managedStageId !== stageId) {
        console.log(`             ${apply ? 'syncing' : 'would sync'} allowed_admins/${key}.managedStageId=${stageId}`);
        if (apply) {
          await allowedRef.update({ managedStageId: stageId });
          writes++;
        }
      }
    }
  }

  console.log('\nMaster admin');
  console.log('------------');
  for (const masterEmail of MASTER_ADMIN_EMAILS) {
    const masterDocs = byEmail.get(masterEmail.toLowerCase()) || [];
    if (masterDocs.length === 0) {
      // Not a hard failure any more: a master admin who has never signed in has
      // no users doc yet, and the email arm in firestore.rules still lets them
      // in. It is reported so a MISSING primary account is still visible.
      console.log(`  ${masterEmail}  no users doc yet - rules still admit them by email`);
      continue;
    }
    for (const doc of masterDocs) {
      claimedUids.add(doc.id);
      if (doc.data().isMasterAdmin === true) {
        console.log(`  ${masterEmail}  already set  (${doc.id})`);
        continue;
      }
      console.log(`  ${masterEmail}  ${apply ? 'setting' : 'would set'} isMasterAdmin=true  (${doc.id})`);
      if (apply) {
        await doc.ref.update({ isMasterAdmin: true });
        writes++;
      }
    }
  }

  console.log('\nSurplus staff accounts');
  console.log('----------------------');
  const staff = await db.collection('users').where('role', '==', 'admin').get();
  let surplus = 0;
  for (const doc of staff.docs) {
    if (claimedUids.has(doc.id)) continue;
    surplus++;
    const email = doc.data().email || '(no email)';
    if (SURPLUS_ADMIN_POLICY === 'demote') {
      console.log(`  ${email}  ${apply ? 'demoting' : 'would demote'} to moderator  (${doc.id})`);
      if (apply) {
        await doc.ref.update({ role: 'moderator' });
        writes++;
      }
    } else {
      console.log(`  ${email}  role=admin, no stage assigned  (${doc.id})`);
    }
  }
  if (surplus === 0) {
    console.log('  none');
  } else if (SURPLUS_ADMIN_POLICY !== 'demote') {
    console.log(`\n  ${surplus} account(s) above keep role=admin with no managedStageId.`);
    console.log('  Once the tightened rules ship they can write nothing. Either add them to');
    console.log("  REPRESENTATIVES, or set SURPLUS_ADMIN_POLICY = 'demote'.");
  }

  console.log(`\n${apply ? `Done. ${writes} write(s).` : 'Dry run complete. Re-run with --apply to commit.'}`);
  if (problems > 0) {
    console.log(`${problems} item(s) need attention above.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Assignment failed:', err);
  process.exit(1);
});
