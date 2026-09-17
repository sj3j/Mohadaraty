/**
 * Irreversibly deletes the retired group chat's data.
 *
 *   npm run purge:chat              # dry run - counts only, nothing is written
 *   npm run purge:chat -- --commit  # destroys it
 *
 * DRY RUN IS THE DEFAULT, the same contract as scripts/purgeUser.ts.
 *
 * The chat feature was removed from the app, its Cloud Functions and its
 * security rules. None of that deletes a single document: the collections stay
 * in Firestore, billable and readable by the Admin SDK, until something empties
 * them. This is that something.
 *
 * WHY THE SUBCOLLECTION SWEEP IS NOT OPTIONAL
 *
 * Deleting a document in Firestore does NOT delete its subcollections - they
 * survive as orphans, reachable by collection-group query and invisible in the
 * console. Every anonymous message carried its real sender at
 * `chat_messages/{id}/private/sender`, so deleting the parents alone would
 * leave the identities behind: the single most sensitive thing in the whole
 * feature, and the one thing a careless purge keeps. `private_chats` is the
 * same shape one level deeper.
 *
 * WHAT IS *NOT* TOUCHED
 *
 *   users/*        - `blockedUsers` stays (Settings still lists and unblocks
 *                    them) and so do the orphaned `notificationPreferences.chat`
 *                    and `permissions.manageChat` booleans, which nothing reads
 *                    any more. Rewriting 400+ accounts to drop two ignored
 *                    fields is more risk than leaving them.
 *   content_reports- moderation history, and reports are the record of WHY
 *                    someone was actioned. Kept deliberately.
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, type Firestore, type CollectionReference } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import 'dotenv/config';

const argv = process.argv.slice(2);
const has = (name: string) => argv.includes(`--${name}`);
const commit = has('commit');

/** Firestore refuses a batch over 500; yearWipe.ts settled on 400. */
const BATCH = 400;

/** Top-level collections emptied whole. */
const COLLECTIONS = [
  'chat_messages',
  'chat_archive',
  'chat_settings',
  'chat_presence',
  'chat_typing',
  'inbox_sessions',
  'private_chats',
] as const;

/** Cloud Storage prefixes removed. The bundle is the output of the deleted
 *  /api/admin/create-chat-bundle route. */
const STORAGE_PREFIXES = ['chat_attachments/', 'bundles/chat-bundle.bundle'] as const;

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
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${FIREBASE_PROJECT_ID}.appspot.com`,
});
const db: Firestore = getFirestore();

/**
 * Delete a document and everything beneath it, depth first.
 *
 * `recursiveDelete()` exists on the Admin SDK and would be shorter, but it
 * reports nothing - and on a destructive one-shot the count IS the check that
 * the dry run was telling the truth.
 */
async function deleteTree(ref: FirebaseFirestore.DocumentReference, apply: boolean): Promise<number> {
  let n = 0;
  for (const sub of await ref.listCollections()) {
    n += await emptyCollection(sub, apply);
  }
  if (apply) await ref.delete();
  return n + 1;
}

async function emptyCollection(coll: CollectionReference, apply: boolean): Promise<number> {
  let n = 0;
  while (true) {
    // Ids only: the payloads are never read, and a chat with attachments is
    // large enough that pulling every field would be pure waste.
    const snap = await coll.limit(BATCH).select().get();
    if (snap.empty) return n;

    for (const doc of snap.docs) n += await deleteTree(doc.ref, apply);

    // Without --commit nothing was deleted, so the same page comes back
    // forever. One page is enough to report the shape.
    if (!apply) return n;
  }
}

async function countTree(coll: CollectionReference): Promise<number> {
  const agg = await coll.count().get();
  return agg.data().count;
}

async function main() {
  const live = !process.env.FIRESTORE_EMULATOR_HOST;
  console.log(`\nTarget : project ${FIREBASE_PROJECT_ID}${live ? ' (LIVE)' : ' (EMULATOR)'}`);
  console.log(`Mode   : ${commit ? 'COMMIT - the chat data will be destroyed' : 'DRY RUN - nothing will be written'}\n`);

  let total = 0;
  for (const name of COLLECTIONS) {
    const coll = db.collection(name);
    const top = await countTree(coll);
    if (top === 0) {
      console.log(`  ${name.padEnd(16)} empty`);
      continue;
    }

    if (!commit) {
      // Sample one document's subcollections so the dry run says whether there
      // is anything underneath, without walking every parent.
      const probe = await coll.limit(1).get();
      const subs = probe.empty ? [] : await probe.docs[0].ref.listCollections();
      const note = subs.length ? `  (+ subcollections: ${subs.map(s => s.id).join(', ')})` : '';
      console.log(`  ${name.padEnd(16)} ${top} document(s)${note}`);
      total += top;
      continue;
    }

    const deleted = await emptyCollection(coll, true);
    console.log(`  ${name.padEnd(16)} deleted ${deleted} document(s) including subcollections`);
    total += deleted;
  }

  console.log(`\n  ${commit ? 'deleted' : 'would delete'} ${total} Firestore document(s)`);

  // ---- Cloud Storage ------------------------------------------------------
  console.log('\nCloud Storage:');
  const bucket = getStorage().bucket();
  for (const prefix of STORAGE_PREFIXES) {
    try {
      const [files] = await bucket.getFiles({ prefix });
      if (files.length === 0) {
        console.log(`  ${prefix.padEnd(30)} nothing`);
        continue;
      }
      if (!commit) {
        console.log(`  ${prefix.padEnd(30)} ${files.length} object(s)`);
        continue;
      }
      // Sequential rather than Promise.all: a few thousand parallel deletes
      // against one bucket is how you earn a 429.
      for (const f of files) await f.delete().catch(e => console.warn(`    ! ${f.name}: ${e.message}`));
      console.log(`  ${prefix.padEnd(30)} deleted ${files.length} object(s)`);
    } catch (e: any) {
      console.warn(`  ${prefix.padEnd(30)} could not list: ${e.message}`);
    }
  }

  if (!commit) {
    console.log('\nDRY RUN - nothing was written. Re-run with --commit to destroy it.');
    console.log('Firestore counts above are exact; subcollections are only sampled,');
    console.log('so the committed total will be higher.\n');
  } else {
    console.log('\nDone. This cannot be undone.\n');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
