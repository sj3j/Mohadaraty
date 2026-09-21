/**
 * Audits - and optionally repairs - the DENORMALISED stage copies.
 *
 *   npx tsx scripts/stageConsistency.ts              # report only
 *   npx tsx scripts/stageConsistency.ts --stage stage_3
 *   npx tsx scripts/stageConsistency.ts --commit     # re-file the stale rows
 *
 * DRY RUN IS THE DEFAULT. Nothing is written without --commit.
 *
 * `users/{uid}.stageId` is the authority. `userMCQStats/{uid}.stageId` is a copy
 * of it, kept because LeaderboardTab filters the MCQ board on
 * `where(stageId == ...)` and could not otherwise scope a board without reading
 * every user.
 *
 * A copy has to be written by EVERY path that moves a student, and one did not:
 * `shared/progressionSubmit.ts` wrote `users/` and `students/` and left the
 * stats row filed under the stage the student had just left. `stagePromotion.ts`
 * (the bulk path) always re-filed it, so the drift only affected students who
 * progressed through the self-service flow - and it is invisible in the console,
 * because every document involved looks perfectly healthy on its own.
 *
 * The symptom is specific and misleading: the student keeps their place on the
 * STREAK board, which reads `users/` directly, and disappears from the MCQ board
 * for the stage they are actually in. That reads as "the MCQ leaderboard is
 * broken for stage N", not as one stale field.
 *
 * Both directions are reported, because they are different failures:
 *   stale    the copy names a stage the student has left - they are missing
 *            from their real board AND padding their old one.
 *   missing  no copy at all - `mcqAnswerService` omits the field when the user
 *            document had no stage at the time, so they are on no board at all.
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import 'dotenv/config';

const argv = process.argv.slice(2);
const flag = (name: string, fallback = '') => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const commit = argv.includes('--commit');
const stageFilter = flag('stage');

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

console.log('');
console.log('Target: project ' + FIREBASE_PROJECT_ID + (process.env.FIRESTORE_EMULATOR_HOST ? ' (EMULATOR)' : ' (LIVE)'));
console.log(commit ? 'Mode  : COMMIT - stale copies will be re-filed' : 'Mode  : DRY RUN - nothing will be written');
console.log('');

async function main() {
  const [usersSnap, statsSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('userMCQStats').get(),
  ]);

  const stageOf = new Map<string, string>();
  for (const d of usersSnap.docs) {
    const st = (d.data() || {}).stageId;
    if (st) stageOf.set(d.id, st);
  }

  console.log('Loaded ' + usersSnap.size + ' users and ' + statsSnap.size + ' MCQ stat rows.');
  console.log('');

  const stale: any[] = [];
  const missing: any[] = [];
  const orphan: string[] = [];
  const boardCount = new Map<string, number>();

  for (const d of statsSnap.docs) {
    const data = d.data() || {};
    const real = stageOf.get(d.id);
    const copy = data.stageId || '';

    if (!real) { orphan.push(d.id); continue; }
    if (stageFilter && real !== stageFilter && copy !== stageFilter) continue;

    if (!copy) missing.push({ uid: d.id, real, data });
    else if (copy !== real) stale.push({ uid: d.id, real, copy, data });

    if (copy) boardCount.set(copy, (boardCount.get(copy) || 0) + 1);
  }

  const ranked = (x: any) => (x.data.mcqRankScore != null ? 'ranked' : 'unranked');

  console.log('== stale copies (student moved, stats row did not) ==');
  for (const x of stale.slice(0, 40)) {
    console.log('  ' + x.uid + '  is ' + x.real + ', filed under ' + x.copy + '  (' + ranked(x) + ')');
  }
  if (stale.length > 40) console.log('  ... and ' + (stale.length - 40) + ' more');
  console.log(stale.length === 0 ? '  none' : '  ' + stale.length + ' row(s)');
  console.log('');

  console.log('== missing copies (on no board at all) ==');
  for (const x of missing.slice(0, 40)) {
    console.log('  ' + x.uid + '  is ' + x.real + ', has no stageId  (' + ranked(x) + ')');
  }
  if (missing.length > 40) console.log('  ... and ' + (missing.length - 40) + ' more');
  console.log(missing.length === 0 ? '  none' : '  ' + missing.length + ' row(s)');
  console.log('');

  console.log('== rows per board, as the leaderboard currently sees them ==');
  for (const [k, v] of [...boardCount.entries()].sort()) console.log('  ' + k + ': ' + v);
  console.log('');

  if (orphan.length > 0) {
    console.log('== stats rows whose users doc is gone ==');
    console.log('  ' + orphan.length + ' row(s) - left alone; an account merge or purge owns these.');
    console.log('');
  }

  const fixes = [...stale, ...missing];
  if (fixes.length === 0) { console.log('Nothing to repair.'); return; }

  if (!commit) {
    console.log(fixes.length + ' row(s) would be re-filed. Re-run with --commit.');
    return;
  }

  // 400 well under the 500-op batch limit, matching scripts/streakAudit.ts.
  for (let i = 0; i < fixes.length; i += 400) {
    const batch = db.batch();
    for (const x of fixes.slice(i, i + 400)) {
      batch.set(db.collection('userMCQStats').doc(x.uid), {
        stageId: x.real,
        lastUpdated: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    await batch.commit();
  }
  console.log('Re-filed ' + fixes.length + ' row(s).');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
