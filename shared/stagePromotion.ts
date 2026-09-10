/**
 * Moving a cohort from one stage to the next.
 *
 * Split into a read-only `planPromotion` and a write-only `applyPromotion` so
 * the whole thing can be dry-run and reviewed before anything is committed.
 *
 * Three things here are load-bearing and easy to get wrong:
 *
 * 1. `students/{email}.stageId` must be written, not just `users/{uid}.stageId`.
 *    syncUserStage (api/index.ts, mirrored in server.ts) copies the students
 *    value onto the user doc on EVERY login, so updating only `users` is
 *    silently reverted the next time the student signs in.
 * 2. The group has to go to both `students.subgroup` and `users.group`. They
 *    hold the same "C2" value and nothing syncs them: the first drives the
 *    admin roster, the second gates the app (src/App.tsx forces the onboarding
 *    screen when it is missing).
 * 3. User docs are found by email QUERY, not by id. Password-login uids are the
 *    lowercased email but Google-login uids are not, and an email can have more
 *    than one user doc (hence the merge-duplicates tool in StudentManagement).
 */
import { GroupConfigLike, FALLBACK_GROUP_CONFIG, isValidSubgroup, normalizeSubgroup } from './groups.js';
import { completedProgressionFields } from './progression.js';

/** One row of the roster spreadsheet, already normalised. */
export interface PromotionRow {
  email: string;
  subgroup: string;
}

export interface PromotionMatch {
  email: string;
  name: string;
  subgroup: string;
  previousSubgroup: string | null;
  /** Every users doc carrying this email. Empty when they have never signed in. */
  userIds: string[];
  /** Subset of userIds that actually has a userMCQStats doc. */
  statsIds: string[];
  /**
   * Subset of userIds holding a stage-scoped staff role (representative or
   * moderator) that this move would strand. Their seat belongs to the stage
   * they are leaving, so it is vacated on promotion - see applyPromotion. The
   * master admin is never included.
   */
  vacatingStaffIds: string[];
  /** Already in the destination stage - a re-run, so this is a no-op. */
  alreadyPromoted: boolean;
  /** Had a non-empty tahmeelSubjects, which the promotion clears. */
  hadTahmeel: boolean;
}

export type ProblemKind =
  | 'unknown_email'
  | 'invalid_subgroup'
  | 'missing_subgroup'
  | 'duplicate_email_rows';

export interface PromotionProblem {
  kind: ProblemKind;
  email: string;
  detail: string;
}

export interface PromotionPlan {
  /** Undefined in roster mode: rows are matched against students anywhere. */
  from?: string;
  to: string;
  groupConfig: GroupConfigLike;
  matched: PromotionMatch[];
  /** Rows that cannot be applied. None of these are written. */
  problems: PromotionProblem[];
  /** In `from` but absent from the sheet - deliberately left where they are. */
  stayingBehind: { email: string; name: string }[];
  /** Matched but never signed in, so there is no users doc to patch yet. */
  neverSignedIn: string[];
  /** Emails resolving to more than one users doc; all of them get patched. */
  duplicateUsers: { email: string; userIds: string[] }[];
}

/**
 * Works out exactly what would change. Performs reads only.
 */
export async function planPromotion(
  db: FirebaseFirestore.Firestore,
  opts: { from?: string; to: string; rows: PromotionRow[] },
): Promise<PromotionPlan> {
  const { from, to, rows } = opts;

  // Roster mode (no `from`): the sheet defines who belongs to this stage, so
  // rows are matched against every student regardless of where they sit today.
  // Promotion mode: only students currently in `from` are eligible.
  const [stageSnap, fromSnap, toSnap, usersSnap, statsSnap] = await Promise.all([
    db.collection('stages').doc(to).get(),
    from
      ? db.collection('students').where('stageId', '==', from).get()
      : db.collection('students').get(),
    db.collection('students').where('stageId', '==', to).get(),
    db.collection('users').get(),
    // Ids only - so we re-file stats docs that exist rather than creating empty
    // ones for students who never answered an MCQ.
    db.collection('userMCQStats').select().get(),
  ]);

  const statsIds = new Set(statsSnap.docs.map(d => d.id));

  const groupConfig: GroupConfigLike =
    (stageSnap.exists && (stageSnap.data() as any)?.groupConfig) || FALLBACK_GROUP_CONFIG;

  const keyOf = (doc: FirebaseFirestore.QueryDocumentSnapshot) =>
    String((doc.data() as any).email || doc.id).toLowerCase().trim();

  const fromStudents = new Map(fromSnap.docs.map(d => [keyOf(d), d]));
  const toStudents = new Map(toSnap.docs.map(d => [keyOf(d), d]));

  const usersByEmail = new Map<string, FirebaseFirestore.QueryDocumentSnapshot[]>();
  for (const doc of usersSnap.docs) {
    const email = String((doc.data() as any).email || '').toLowerCase().trim();
    if (!email) continue;
    if (!usersByEmail.has(email)) usersByEmail.set(email, []);
    usersByEmail.get(email)!.push(doc);
  }

  const matched: PromotionMatch[] = [];
  const problems: PromotionProblem[] = [];
  const neverSignedIn: string[] = [];
  const duplicateUsers: { email: string; userIds: string[] }[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const email = row.email.toLowerCase().trim();
    if (!email) continue;

    if (seen.has(email)) {
      problems.push({ kind: 'duplicate_email_rows', email, detail: 'listed more than once in the sheet' });
      continue;
    }
    seen.add(email);

    if (!row.subgroup || !row.subgroup.trim()) {
      problems.push({ kind: 'missing_subgroup', email, detail: 'no group in the sheet' });
      continue;
    }

    const subgroup = normalizeSubgroup(row.subgroup);
    if (!subgroup || !isValidSubgroup(groupConfig, subgroup)) {
      problems.push({
        kind: 'invalid_subgroup',
        email,
        detail: `"${row.subgroup}" is not a subgroup ${to} allows`,
      });
      continue;
    }

    const alreadyPromoted = !fromStudents.has(email) && toStudents.has(email);
    const doc = fromStudents.get(email) || toStudents.get(email);
    if (!doc) {
      problems.push({
        kind: 'unknown_email',
        email,
        detail: from ? `no student in ${from} or ${to}` : 'no student record with that email',
      });
      continue;
    }

    const data = doc.data() as any;
    const userDocs = usersByEmail.get(email) || [];
    if (userDocs.length === 0) neverSignedIn.push(email);
    if (userDocs.length > 1) duplicateUsers.push({ email, userIds: userDocs.map(d => d.id) });

    matched.push({
      email,
      name: data.name || email,
      subgroup,
      previousSubgroup: data.subgroup || null,
      userIds: userDocs.map(d => d.id),
      statsIds: userDocs.map(d => d.id).filter(uid => statsIds.has(uid)),
      vacatingStaffIds: userDocs
        .filter(d => {
          const u = d.data() as any;
          // Mirrors submitProgression's wasStaff. 'support' is included for the
          // same reason: the seat is vacated on leaving the stage, and a role
          // this filter does not name is a role nothing ever releases.
          return !u.isMasterAdmin
            && (u.role === 'admin' || u.role === 'moderator' || u.role === 'support');
        })
        .map(d => d.id),
      alreadyPromoted,
      hadTahmeel: userDocs.some(d => ((d.data() as any).tahmeelSubjects || []).length > 0),
    });
  }

  const inSheet = new Set(matched.map(m => m.email));
  // In roster mode the interesting omission is someone already in the target
  // stage who is missing from the sheet - listing every student in the database
  // would be noise.
  const candidates = from ? fromSnap.docs : toSnap.docs;
  const stayingBehind = candidates
    .filter(d => !inSheet.has(keyOf(d)))
    .map(d => ({ email: keyOf(d), name: (d.data() as any).name || keyOf(d) }));

  return { from, to, groupConfig, matched, problems, stayingBehind, neverSignedIn, duplicateUsers };
}

export interface PromotionResult {
  studentsUpdated: number;
  usersUpdated: number;
  statsUpdated: number;
  /** Representative/moderator seats released because their holder moved stage. */
  staffVacated: number;
}

/**
 * Commits a plan. Idempotent: re-running writes the same values.
 *
 * Imported students are stamped as already answered for this year. They were
 * placed in a stage by the roster, not by a result they reported, so the
 * end-of-year question would have nothing to ask them and would only wall them
 * out of the app until they guessed at it.
 *
 * Both `progressionYear`/`progressionState` (what nextProgressionStep reads)
 * and the legacy `hasCompletedProgression`/`lastProgressionYear` are written -
 * stamping only the legacy pair would leave them being asked anyway.
 */
export async function applyPromotion(
  db: FirebaseFirestore.Firestore,
  FieldValue: { serverTimestamp(): any; delete(): any },
  plan: PromotionPlan,
  opts: { progressionYear: string },
): Promise<PromotionResult> {
  let batch = db.batch();
  let ops = 0;
  const flush = async (force = false) => {
    if (ops >= 400 || (force && ops > 0)) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  };

  const result: PromotionResult = { studentsUpdated: 0, usersUpdated: 0, statsUpdated: 0, staffVacated: 0 };

  for (const m of plan.matched) {
    // The whitelist copy. Without this, syncUserStage undoes everything below
    // on the student's next login.
    batch.set(db.collection('students').doc(m.email), {
      stageId: plan.to,
      subgroup: m.subgroup,
    }, { merge: true });
    ops++;
    result.studentsUpdated++;
    await flush();

    for (const uid of m.userIds) {
      const patch: Record<string, any> = {
        stageId: plan.to,
        group: m.subgroup,          // what App.tsx actually gates on
        tahmeelSubjects: [],        // ids from the old stage; stale after a move
        ...completedProgressionFields(opts.progressionYear),
      };
      // Same rule as submitProgression: a representative or moderator represents
      // the stage they study in, so moving them up vacates the seat rather than
      // carrying authority over a stage they have left.
      if (m.vacatingStaffIds.includes(uid)) {
        patch.role = 'student';
        patch.managedStageId = FieldValue.delete();
        patch.permissions = FieldValue.delete();
      }
      batch.set(db.collection('users').doc(uid), patch, { merge: true });
      ops++;
      result.usersUpdated++;
      await flush();
    }

    // allowed_admins is the second place a role is read from (syncUserStage and
    // firestore.rules), so it has to go too or the next login restores it.
    if (m.vacatingStaffIds.length > 0) {
      batch.delete(db.collection('allowed_admins').doc(m.email));
      ops++;
      result.staffVacated++;
      await flush();
    }

    // Only docs that already exist. Zeroed by the season archive, so this just
    // re-files them under the new stage; they would self-heal on the next
    // answer anyway, but leaving them stale hides the student from both boards.
    for (const uid of m.statsIds) {
      batch.update(db.collection('userMCQStats').doc(uid), {
        stageId: plan.to,
        lastUpdated: FieldValue.serverTimestamp(),
      });
      ops++;
      result.statsUpdated++;
      await flush();
    }
  }

  await flush(true);
  return result;
}
