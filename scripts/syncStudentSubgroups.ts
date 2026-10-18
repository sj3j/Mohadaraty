/**
 * Synchronizes students.subgroup from users.group in Firestore.
 * 
 * Usage:
 *   npx tsx scripts/syncStudentSubgroups.ts                     # Dry run across all stages
 *   npx tsx scripts/syncStudentSubgroups.ts --commit            # Commit updates to Firestore
 *   npx tsx scripts/syncStudentSubgroups.ts --stage stage_4     # Only stage 4 dry run
 *   npx tsx scripts/syncStudentSubgroups.ts --stage stage_4 --commit
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import 'dotenv/config';

const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  console.error('\nMissing Firebase Admin environment variables in .env');
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

const argv = process.argv.slice(2);
const flag = (name: string, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const hasFlag = (name: string) => argv.includes(`--${name}`);

const commit = hasFlag('commit');
const stageFilter = flag('stage');

async function main() {
  console.log(`\n=== Student Subgroups Sync ===`);
  console.log(`  Mode: ${commit ? 'COMMIT (LIVE WRITES)' : 'DRY RUN (NO WRITES)'}`);
  if (stageFilter) console.log(`  Target Stage: ${stageFilter}`);

  console.log('\nLoading users with assigned groups...');
  const usersSnap = await db.collection('users').get();
  console.log(`Total users in system: ${usersSnap.size}`);

  const userGroupByEmail = new Map<string, string>();
  const userGroupByUid = new Map<string, string>();

  usersSnap.docs.forEach((doc) => {
    const data = doc.data();
    const group = (data.group || data.subgroup || '').trim();
    if (!group) return;

    if (data.email) {
      userGroupByEmail.set(data.email.trim().toLowerCase(), group);
    }
    userGroupByUid.set(doc.id, group);
  });
  console.log(`Users with valid group: ${userGroupByEmail.size} (by email), ${userGroupByUid.size} (by uid)`);

  let studentsQuery: FirebaseFirestore.Query = db.collection('students');
  if (stageFilter) {
    studentsQuery = studentsQuery.where('stageId', '==', stageFilter);
  }

  const studentsSnap = await studentsQuery.get();
  console.log(`Total student documents to check: ${studentsSnap.size}`);

  const updates: Array<{
    ref: FirebaseFirestore.DocumentReference;
    id: string;
    name: string;
    stageId: string;
    currentSubgroup: string;
    newSubgroup: string;
  }> = [];

  const statsByStage: Record<
    string,
    {
      total: number;
      alreadySet: number;
      toUpdate: number;
      unresolved: number;
      groupBreakdown: Record<string, number>;
    }
  > = {};

  studentsSnap.docs.forEach((doc) => {
    const data = doc.data();
    const stageId = data.stageId || 'unknown';
    const currentSubgroup = (data.subgroup || data.group || '').trim();
    const email = (data.email || doc.id || '').trim().toLowerCase();
    const name = String(data.name || '').trim();

    statsByStage[stageId] = statsByStage[stageId] || {
      total: 0,
      alreadySet: 0,
      toUpdate: 0,
      unresolved: 0,
      groupBreakdown: {},
    };
    statsByStage[stageId].total++;

    if (currentSubgroup) {
      statsByStage[stageId].alreadySet++;
      const mainGroup = currentSubgroup.charAt(0).toUpperCase();
      statsByStage[stageId].groupBreakdown[mainGroup] =
        (statsByStage[stageId].groupBreakdown[mainGroup] || 0) + 1;
      return;
    }

    // Look for matching user
    const resolvedGroup = userGroupByEmail.get(email) || userGroupByUid.get(doc.id) || '';

    if (resolvedGroup) {
      statsByStage[stageId].toUpdate++;
      const mainGroup = resolvedGroup.charAt(0).toUpperCase();
      statsByStage[stageId].groupBreakdown[mainGroup] =
        (statsByStage[stageId].groupBreakdown[mainGroup] || 0) + 1;

      updates.push({
        ref: doc.ref,
        id: doc.id,
        name,
        stageId,
        currentSubgroup,
        newSubgroup: resolvedGroup,
      });
    } else {
      statsByStage[stageId].unresolved++;
    }
  });

  console.log('\n--- Summary by Stage ---');
  for (const [st, stat] of Object.entries(statsByStage).sort()) {
    console.log(`\nStage: ${st}`);
    console.log(`  Total: ${stat.total}`);
    console.log(`  Already had subgroup: ${stat.alreadySet}`);
    console.log(`  To be updated from users: ${stat.toUpdate}`);
    console.log(`  Unresolved (no user group found): ${stat.unresolved}`);
    console.log(`  Resulting groups: ${JSON.stringify(stat.groupBreakdown)}`);
  }

  console.log(`\nTotal updates queued: ${updates.length}`);

  if (updates.length > 0) {
    console.log('\nSample updates (first 5):');
    updates.slice(0, 5).forEach((u, i) => {
      console.log(`  ${i + 1}. [${u.stageId}] ${u.name} (${u.id}) -> subgroup: "${u.newSubgroup}"`);
    });
  }

  if (!commit) {
    console.log('\n[DRY RUN] No writes performed. Run with --commit to apply changes.');
    return;
  }

  console.log('\nApplying updates in batches...');
  const BATCH_SIZE = 400;
  let batch = db.batch();
  let count = 0;
  let batchesCommitted = 0;

  for (const item of updates) {
    batch.update(item.ref, {
      subgroup: item.newSubgroup,
      updatedAt: new Date().toISOString(),
    });
    count++;

    if (count % BATCH_SIZE === 0) {
      await batch.commit();
      batchesCommitted++;
      console.log(`  Committed batch ${batchesCommitted} (${count} / ${updates.length})...`);
      batch = db.batch();
    }
  }

  if (count % BATCH_SIZE !== 0) {
    await batch.commit();
    batchesCommitted++;
    console.log(`  Committed final batch ${batchesCommitted} (${count} / ${updates.length}).`);
  }

  console.log(`\n✓ Successfully synced ${count} students across ${batchesCommitted} batch(es)!`);
}

main().catch((err) => {
  console.error('\nFatal error during sync:', err);
  process.exit(1);
});
