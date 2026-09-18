import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { readFileSync } from 'fs';
import 'dotenv/config';

// Deletes every announcement, so the feed restarts on the new schema.
//
// WHY THIS EXISTS
//
// The composer stores attachments as `attachments: [{id, kind, url, name, size,
// mime}]`. Posts written before it stored a single file across four mutually
// exclusive top-level fields (`type`, `imageUrl`, `videoUrl`, `fileUrl`). The
// reader was deliberately NOT given a fallback for the old shape - the decision
// was a clean break rather than a compatibility shim - so an old post would
// render its text and silently lose its media.
//
// Rather than leave those posts half-broken, this clears them out. Confirmed as
// safe for this database: the surviving announcements belong to a cohort that
// has since moved up a stage, and none of them are worth carrying forward.
//
// WHAT IT TOUCHES
//
//   - every document in `announcements` (optionally only one stage's)
//   - the `votes` subcollection under each, if any poll ballots exist
//   - the Storage objects those posts referenced, under `announcements/`
//
// It does NOT touch lectures, records, homeworks, or anything else.
//
// SAFETY
//
// Dry run by default: it prints what it would delete and exits without writing.
// Pass --confirm to actually delete. There is no undo.
//
// Credentials: pass a service account JSON path, or rely on
// FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY in .env -
// the same variables server.ts authenticates with.
//
// Usage:
//   node scripts/resetAnnouncements.js                          # dry run, all stages
//   node scripts/resetAnnouncements.js --stage stage_3          # dry run, one stage
//   node scripts/resetAnnouncements.js --confirm                # DELETES
//   node scripts/resetAnnouncements.js ./key.json --confirm     # DELETES
//   node scripts/resetAnnouncements.js --confirm --keep-files   # docs only

const args = process.argv.slice(2);
const confirmed = args.includes('--confirm');
const keepFiles = args.includes('--keep-files');
const stageIndex = args.indexOf('--stage');
const onlyStage = stageIndex !== -1 ? args[stageIndex + 1] : null;
const serviceAccountPath = args.find(a => a.endsWith('.json')) || null;

// The bucket the app itself uses, read from the same config the client reads.
//
// Deliberately NOT `FIREBASE_PROJECT_ID + '.appspot.com'`, which is the guess
// server.ts falls back to: this project's bucket is
// mylectures-app.firebasestorage.app, the newer naming Firebase gives buckets
// created after late 2024, and the .appspot.com guess resolves to nothing.
function resolveBucket() {
  if (process.env.FIREBASE_STORAGE_BUCKET) return process.env.FIREBASE_STORAGE_BUCKET;
  try {
    const config = JSON.parse(readFileSync(new URL('../firebase-applet-config.json', import.meta.url), 'utf8'));
    if (config.storageBucket) return config.storageBucket;
  } catch {
    /* fall through */
  }
  return null;
}

function buildCredential() {
  if (serviceAccountPath) {
    return cert(JSON.parse(readFileSync(serviceAccountPath, 'utf8')));
  }
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    console.error('No service account path given and .env is missing FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY.');
    process.exit(1);
  }
  console.log(`Authenticating as ${FIREBASE_CLIENT_EMAIL} (project ${FIREBASE_PROJECT_ID}).`);
  return cert({
    projectId: FIREBASE_PROJECT_ID,
    clientEmail: FIREBASE_CLIENT_EMAIL,
    privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });
}

/** Storage object path for a URL this app wrote, or null if it is not ours. */
function objectPathFor(url) {
  if (typeof url !== 'string') return null;
  // New-schema attachments record their own path; prefer it over parsing.
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('firebasestorage.googleapis.com')) return null;
    const match = parsed.pathname.match(/\/o\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

/** Every Storage object one announcement points at, new schema and old. */
function storagePathsOf(data) {
  const paths = new Set();

  for (const attachment of data.attachments ?? []) {
    if (attachment?.path) paths.add(attachment.path);
    else {
      const derived = objectPathFor(attachment?.url);
      if (derived) paths.add(derived);
    }
  }
  // Legacy single-attachment fields. Still read here even though the app no
  // longer writes them - these are exactly the posts being cleaned up.
  for (const legacy of [data.imageUrl, data.videoUrl, data.fileUrl, data.photo_url]) {
    const derived = objectPathFor(legacy);
    if (derived) paths.add(derived);
  }
  return [...paths];
}

async function main() {
  const storageBucket = resolveBucket();
  initializeApp({ credential: buildCredential(), ...(storageBucket ? { storageBucket } : {}) });
  const db = getFirestore();

  // Resolved once, and only if it will actually be used. Calling
  // getStorage().bucket() on an app with no configured bucket throws, and doing
  // it unconditionally meant a run could die on a post that had no files at all.
  let bucket = null;
  if (!keepFiles && storageBucket) bucket = getStorage().bucket();
  if (!keepFiles && !bucket) {
    console.warn('No storage bucket resolved - documents will be deleted but their files will be left in place.');
  }

  const snapshot = await db.collection('announcements').get();
  const targets = snapshot.docs.filter(d => !onlyStage || d.data().stageId === onlyStage);

  console.log(`\nAnnouncements in database: ${snapshot.size}`);
  if (onlyStage) console.log(`Filtered to stage "${onlyStage}": ${targets.length}`);

  if (targets.length === 0) {
    console.log('\nNothing to delete.');
    return;
  }

  let fileCount = 0;
  let voteCount = 0;
  let deleted = 0;
  let skipped = 0;
  console.log('');

  for (const docSnap of targets) {
    const data = docSnap.data();
    const files = keepFiles ? [] : storagePathsOf(data);
    fileCount += files.length;

    const votes = await docSnap.ref.collection('votes').get();
    voteCount += votes.size;

    const preview = (data.text || data.content || '').replace(/\s+/g, ' ').slice(0, 60);
    console.log(`  ${docSnap.id}  [${data.stageId ?? 'no stage'}]  ${preview || '(no text)'}`);
    if (files.length) console.log(`      files: ${files.length}`);
    if (votes.size) console.log(`      votes: ${votes.size}`);

    if (!confirmed) continue;

    try {
    // Ballots first: deleting the parent would orphan the subcollection, which
    // Firestore keeps and which a later post reusing the id would inherit.
    for (const vote of votes.docs) await vote.ref.delete();

    // Storage failures never block the document delete. An orphaned object
    // costs pennies and can be swept later; a half-deleted announcement that
    // stopped the run partway through is a much worse state to be left in.
    if (bucket) {
      for (const path of files) {
        try {
          await bucket.file(path).delete();
        } catch (error) {
          // A missing object is fine - the point is that it is gone.
          if (error.code !== 404) console.warn(`      could not delete ${path}: ${error.message}`);
        }
      }
    }

      await docSnap.ref.delete();
      deleted++;
    } catch (error) {
      // One unhappy document must not strand the other nineteen. Report it and
      // keep going; the script is safe to re-run over whatever is left.
      console.warn(`      SKIPPED ${docSnap.id}: ${error.message}`);
      skipped++;
    }
  }

  console.log('');
  if (confirmed) {
    console.log(`Deleted ${deleted} announcement(s), ${voteCount} ballot(s), ${fileCount} file(s).`);
    if (skipped) console.log(`${skipped} could not be deleted - re-run to retry them.`);
  } else {
    console.log(`DRY RUN - nothing was deleted.`);
    console.log(`Would delete ${targets.length} announcement(s), ${voteCount} ballot(s), ${fileCount} file(s).`);
    console.log(`Re-run with --confirm to proceed.`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
