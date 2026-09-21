/**
 * Finds - and optionally repairs - students who hold more than one account.
 *
 *   npx tsx scripts/duplicateAccounts.ts                  # report only
 *   npx tsx scripts/duplicateAccounts.ts --only names     # one pass
 *   npx tsx scripts/duplicateAccounts.ts --stage stage_3  # one stage
 *   npx tsx scripts/duplicateAccounts.ts --commit         # merge passes A-C
 *
 * DRY RUN IS THE DEFAULT. Nothing is written without --commit.
 *
 * Why this exists: a staff-created account is a `students/{id}` document whose
 * Auth record is materialised by signInWithCustomToken with uid = that document
 * id and NO email property at all. Firebase therefore cannot see that it and a
 * Google identity are the same person. Until the claim step shipped, a student
 * who pressed "Continue with Google" with an address we did not have on file
 * was told there was no account and handed the signup form - so the second
 * account was not an accident, it was the path the app offered.
 *
 * FOUR PASSES, and the split between them is the whole design.
 *
 *   A. multi     several users docs resolving to ONE students doc. Exact.
 *   B. orphan    a users doc whose email matches no students doc id. Exact.
 *   C. linked    a students row whose googleEmail is another row's id. Exact.
 *   D. names     the same folded name twice in one stage. A JUDGEMENT, never
 *                merged by this script at any flag.
 *
 * A-C are structural: each is a join on a value the system itself wrote, so a
 * match is a fact. D is the shape the signup funnel actually produced, and it
 * has no structural key at all - the two rows share nothing but the human
 * behind them. It is reported for a representative who knows the cohort to
 * settle in إدارة الطلاب, on the same reasoning as SplitSubjectDialog: deciding
 * which records belong to whom is not a mechanical transform.
 *
 * NOT KEYED ON examCode, at any point. Exam codes are reissued every year, so a
 * code identifies a year's enrolment rather than a person. Matching on it would
 * fail in both directions - missing a real duplicate whose code has rolled over,
 * and fusing two different students who happen to hold the same stale number.
 * It is printed as context and never compared.
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue } from 'firebase-admin/firestore';
import { mergeUserAccounts } from '../shared/adminUsers.js';
import { nameKeyFor } from '../shared/rosterIdentity.js';
import 'dotenv/config';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name: string, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name: string) => argv.includes(`--${name}`);

const commit = has('commit');
const stageFilter = flag('stage');
const only = flag('only'); // multi | orphan | linked | names
const runs = (pass: string) => !only || only === pass;

// ---------------------------------------------------------------------------
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

console.log(`\nTarget: project ${FIREBASE_PROJECT_ID}${process.env.FIRESTORE_EMULATOR_HOST ? ' (EMULATOR)' : ' (LIVE)'}`);
console.log(commit ? 'Mode  : COMMIT - structural passes will be merged\n' : 'Mode  : DRY RUN - nothing will be written\n');

interface Row { id: string; data: any }
interface UserRow { uid: string; data: any }

const lower = (v?: string | null) => (v || '').toLowerCase().trim();

/**
 * The account that survives: the OLDEST students document.
 *
 * The roster row is created by staff before term; the row that duplicated it
 * was created by a self-signup afterwards. Age is therefore the one ordering
 * that reflects which of the two the institution actually issued - and unlike
 * activity, it cannot be changed by the student.
 */
function pickWinner(rows: Row[]): Row {
  const millis = (r: Row) => {
    const c = r.data?.createdAt;
    if (!c) return Number.MAX_SAFE_INTEGER; // undated rows lose to any dated one
    if (typeof c.toMillis === 'function') return c.toMillis();
    const parsed = Date.parse(c);
    return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
  };
  return [...rows].sort((a, b) => millis(a) - millis(b))[0];
}

/** The users doc to keep for a students row: the one already keyed to its id. */
function pickKeeperUid(studentId: string, users: UserRow[]): UserRow {
  return users.find(u => lower(u.data.email) === studentId || u.uid === studentId) || users[0];
}

function describe(r: Row): string {
  const d = r.data || {};
  return `${r.id}  [${d.stageId || '-'}] ${d.name || '(no name)'}`
    + `  code=${d.examCode || '-'}  login=${d.loginCode || '-'}`
    + `  active=${d.isActive !== false}`;
}

async function runMerge(
  label: string,
  keepUid: string, deleteUid: string,
  keepStudentId: string | null, deleteStudentId: string | null,
): Promise<void> {
  if (!commit) {
    console.log(`     would merge: keep ${keepUid} <- delete ${deleteUid}`);
    if (deleteStudentId) console.log(`                  retire students/${deleteStudentId} -> ${keepStudentId}`);
    return;
  }
  const report = await mergeUserAccounts(db, auth, keepUid, deleteUid, {
    keepStudentId, deleteStudentId,
    FieldValue: FieldValue as any,
    reason: `script:duplicateAccounts:${label}`,
  });
  console.log(`     merged (${report.merged ? 'ok' : 'nothing to do'})`
    + `${report.linkedGoogleEmail ? `, linked ${report.linkedGoogleEmail}` : ''}`);
}

async function main() {
  // Loaded once: every pass needs the whole of both collections, and the joins
  // below are all many-to-many.
  const studentsSnap = stageFilter
    ? await db.collection('students').where('stageId', '==', stageFilter).get()
    : await db.collection('students').get();
  const usersSnap = await db.collection('users').get();

  const students: Row[] = studentsSnap.docs.map(d => ({ id: lower(d.id), data: d.data() || {} }));
  const users: UserRow[] = usersSnap.docs.map(d => ({ uid: d.id, data: d.data() || {} }));

  const studentById = new Map(students.map(r => [r.id, r]));
  // A row a previous merge already retired is not a duplicate - it is the
  // resolved half of one, and re-merging it would fold a dead row into its own
  // successor.
  const live = students.filter(r => !lower(r.data.mergedInto));

  console.log(`Loaded ${students.length} students (${live.length} live) and ${users.length} users`
    + `${stageFilter ? ` for ${stageFilter}` : ''}.\n`);

  // Every alias that should resolve to a given students row.
  const aliasesOf = (r: Row): string[] => {
    const out = new Set<string>([r.id]);
    if (lower(r.data.email)) out.add(lower(r.data.email));
    if (lower(r.data.googleEmail)) out.add(lower(r.data.googleEmail));
    return [...out];
  };

  const usersByEmail = new Map<string, UserRow[]>();
  for (const u of users) {
    const key = lower(u.data.email) || lower(u.uid);
    if (!key) continue;
    if (!usersByEmail.has(key)) usersByEmail.set(key, []);
    usersByEmail.get(key)!.push(u);
  }

  let findings = 0;

  // -------------------------------------------------------------------------
  // PASS A - several users docs for one students row
  // -------------------------------------------------------------------------
  if (runs('multi')) {
    console.log('== A. multiple users docs for one student ==');
    let hits = 0;
    for (const r of live) {
      const seen = new Set<string>();
      const matched: UserRow[] = [];
      for (const alias of aliasesOf(r)) {
        for (const u of usersByEmail.get(alias) || []) {
          if (seen.has(u.uid)) continue;
          seen.add(u.uid);
          matched.push(u);
        }
      }
      if (matched.length < 2) continue;

      hits++; findings++;
      console.log(`  ${describe(r)}`);
      const keeper = pickKeeperUid(r.id, matched);
      for (const u of matched) {
        const tag = u.uid === keeper.uid ? 'KEEP  ' : 'merge ';
        console.log(`     ${tag}${u.uid}  streak=${u.data.streakCount || 0}`
          + ` best=${u.data.bestStreakAllTime || 0} sub=${u.data.isSubscribed === true}`);
      }
      for (const u of matched) {
        if (u.uid === keeper.uid) continue;
        await runMerge('multi', keeper.uid, u.uid, r.id, null);
      }
    }
    console.log(hits === 0 ? '  none\n' : `  ${hits} student(s)\n`);
  }

  // -------------------------------------------------------------------------
  // PASS B - users docs matching no students row
  //
  // The old web popup minted a Firebase account under the Google uid, signed
  // out of it and left it behind. They hold no student record, so they are not
  // duplicates of anything by themselves - reported, never merged, because
  // there is nothing to merge them INTO without guessing.
  // -------------------------------------------------------------------------
  if (runs('orphan')) {
    console.log('== B. users docs with no students row ==');
    const knownAliases = new Set<string>();
    for (const r of students) aliasesOf(r).forEach(a => knownAliases.add(a));

    let hits = 0;
    for (const u of users) {
      const key = lower(u.data.email) || lower(u.uid);
      if (!key || knownAliases.has(key)) continue;
      // Staff and master admins legitimately have no students row.
      const role = u.data.role || 'student';
      if (role !== 'student') continue;
      if (stageFilter && u.data.stageId !== stageFilter) continue;

      hits++; findings++;
      console.log(`  ${u.uid}  email=${u.data.email || '-'}  [${u.data.stageId || '-'}]`
        + `  streak=${u.data.streakCount || 0}  name=${u.data.name || '-'}`);
    }
    console.log(hits === 0 ? '  none\n' : `  ${hits} orphan(s) - review by hand\n`);
  }

  // -------------------------------------------------------------------------
  // PASS C - a linked googleEmail that is itself another students row
  //
  // Exact: the student linked the address themselves, and a separate row exists
  // at it. Both halves are certain, so this one merges.
  // -------------------------------------------------------------------------
  if (runs('linked')) {
    console.log('== C. linked address that is also its own students row ==');
    let hits = 0;
    for (const r of live) {
      const linked = lower(r.data.googleEmail);
      if (!linked || linked === r.id) continue;
      const other = studentById.get(linked);
      if (!other || lower(other.data.mergedInto)) continue;

      hits++; findings++;
      console.log(`  ${describe(r)}`);
      console.log(`     also   ${describe(other)}`);

      const winner = pickWinner([r, other]);
      const loser = winner.id === r.id ? other : r;
      const winnerUsers = usersByEmail.get(winner.id) || [];
      const loserUsers = usersByEmail.get(loser.id) || [];
      if (winnerUsers.length === 0 || loserUsers.length === 0) {
        console.log('     skipped: one side has no users doc - merge it from إدارة الطلاب');
        continue;
      }
      await runMerge('linked', winnerUsers[0].uid, loserUsers[0].uid, winner.id, loser.id);
    }
    console.log(hits === 0 ? '  none\n' : `  ${hits} pair(s)\n`);
  }

  // -------------------------------------------------------------------------
  // PASS D - the same folded name twice in one stage
  //
  // REPORT ONLY, deliberately and at every flag. Two students in one cohort can
  // genuinely share a three-part name, and fusing them would destroy one
  // person's record to tidy another's. This is the shape the signup funnel
  // produced and it is exactly the shape that needs someone who knows the
  // cohort.
  // -------------------------------------------------------------------------
  if (runs('names')) {
    console.log('== D. same name, same stage - REVIEW BY HAND, never auto-merged ==');
    const byKey = new Map<string, Row[]>();
    for (const r of live) {
      const key = `${r.data.stageId || '-'}::${r.data.nameKey || nameKeyFor(r.data.name)}`;
      if (key.endsWith('::')) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(r);
    }

    let hits = 0;
    for (const [key, rows] of byKey) {
      if (rows.length < 2) continue;
      hits++; findings++;
      console.log(`  ${key}`);
      for (const r of rows) {
        const matched = usersByEmail.get(r.id) || [];
        console.log(`     ${describe(r)}`);
        for (const u of matched) {
          console.log(`        uid=${u.uid} streak=${u.data.streakCount || 0}`
            + ` last=${u.data.lastActiveDate || '-'} sub=${u.data.isSubscribed === true}`);
        }
      }
    }
    console.log(hits === 0 ? '  none\n' : `  ${hits} group(s) for review in إدارة الطلاب\n`);
  }

  console.log(findings === 0
    ? 'No duplicates found.'
    : `${findings} finding(s). ${commit ? 'Structural passes committed.' : 'Re-run with --commit to merge passes A and C.'}`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
