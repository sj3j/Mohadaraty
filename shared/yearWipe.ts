/**
 * The year-end wipe: emptying every stage's content so the next year starts clean.
 *
 * This is the most destructive operation in the app. It is split into a
 * read-only `planYearWipe`, an `exportYear` that snapshots what is about to go,
 * and `wipeYear` which does the deleting - the same plan/apply shape as
 * shared/stagePromotion.ts, so the whole thing can be dry-run and reviewed
 * before anything is committed.
 *
 * ORDER IS LOAD-BEARING. The caller must run, in this order:
 *   1. summariseYear()   - shared/yearSummary.ts, while the answer data still exists
 *   2. startNewSeason()  - shared/seasonReset.ts, archives term leaderboard cards
 *   3. exportYear()      - snapshot
 *   4. wipeYear()        - delete
 * Annual MCQ aggregates are archived and reset inside wipeYear(), after export.
 *
 * WHAT SURVIVES, and why each one matters:
 *   questionBank    - the whole point; ministry/past-year/professor questions, not regenerable
 *   students        - the login table; wiping it locks everyone out
 *   users           - accounts, roles, subscription state
 *   stages, subjects- signup and promotion both hard-fail without them
 *   exam grades     - the degrees subcollections; irreplaceable academic record
 *   adminLogs       - append-only audit by design
 *   semesterArchives, streakHistory, mcqHistory, yearHistory - the history we just wrote
 */

/** Collections emptied completely. */
const WIPE_COLLECTIONS = [
  'records',
  'announcements',
  'homeworks',
  'mcqs',
  'lecture_mcqs',      // dead duplicate of mcqs; no security rule, writes already fail
  'antiCheatLogs',
  'adminAlerts',
  'systemNotifications',
  'chat_messages',
  'chat_archive',
] as const;

/** Fields on `lectures` that a stub does not keep. */
const LECTURE_STUB_DROPS = ['pdfUrl', 'youtubeUrl', 'description'] as const;

/** Per-user arrays that would otherwise hold nothing but dead ids after the wipe. */
const DEAD_ID_ARRAYS = ['studied', 'completedWeeklyTasks', 'favorites'] as const;

export interface WipeFile {
  kind: 'r2' | 'storage';
  /** R2 object key, or Storage object path. */
  key: string;
  /** Which document referenced it, for the manifest. */
  source: string;
}

export interface WipePlan {
  yearLabel: string;
  /** Documents that would be deleted, by collection. */
  counts: Record<string, number>;
  /** Lectures that would be reduced to a stub rather than deleted. */
  lectureStubs: number;
  /** Every binary object referenced by the documents above. */
  files: WipeFile[];
  /** True when this year has already been wiped. */
  alreadyWiped: boolean;
}

export interface WipeResult {
  yearLabel: string;
  documentsDeleted: number;
  lectureStubs: number;
  usersCleaned: number;
  filesListed: number;
  mcqStatsReset: number;
}

/**
 * Archives and resets the active annual MCQ aggregates.
 *
 * Each row is handled transactionally with a deterministic history id. A
 * retry therefore cannot replace a real snapshot with the already-zeroed
 * aggregate, and cannot create duplicate history cards.
 */
export async function resetAnnualMcqStats(
  db: FirebaseFirestore.Firestore,
  FieldValue: { serverTimestamp(): any; delete(): any },
  yearLabel: string,
): Promise<number> {
  const allStageStats = await db.collection('userStageMCQStats').get();
  // Rows created before isActiveInStage was introduced are active by default;
  // progression explicitly stamps archived rows false.
  const active = allStageStats.docs.filter(row => row.data()?.isActiveInStage !== false);
  let reset = 0;

  for (const row of active) {
    await db.runTransaction(async tx => {
      const live = await tx.get(row.ref);
      if (!live.exists) return;
      const data = live.data() || {};
      const uid = String(data.userId || '');
      const stageId = String(data.stageId || 'unassigned');
      if (!uid) return;

      const historyRef = db.collection('users').doc(uid)
        .collection('stageHistory').doc(`${yearLabel}_${stageId}`);
      const history = await tx.get(historyRef);

      if (!history.exists) {
        tx.set(historyRef, {
          yearLabel,
          stageId,
          totalFirstAttemptCorrect: data.totalFirstAttemptCorrect || 0,
          totalFirstAttemptAnswered: data.totalFirstAttemptAnswered || 0,
          lecturesAttempted: data.lecturesAttempted || 0,
          mcqLeaderboardScore: data.mcqLeaderboardScore || 0,
          scoreModel: 'correct_x10_v1',
          mcqRankScore: data.mcqRankScore ?? null,
          accuracy: data.accuracy || 0,
          subjectStats: data.subjectStats || {},
          reason: 'academic_year_closed',
          archivedAt: FieldValue.serverTimestamp(),
        });
      }

      tx.set(row.ref, {
        totalFirstAttemptCorrect: 0,
        totalFirstAttemptAnswered: 0,
        lecturesAttempted: 0,
        mcqLeaderboardScore: 0,
        accuracy: 0,
        mcqRankScore: FieldValue.delete(),
        subjectStats: {},
        academicYear: FieldValue.delete(),
        lastUpdated: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    reset++;
  }

  const legacy = await db.collection('userMCQStats').get();
  let batch = db.batch();
  let ops = 0;
  for (const row of legacy.docs) {
    batch.set(row.ref, {
      totalFirstAttemptCorrect: 0,
      totalFirstAttemptAnswered: 0,
      lecturesAttempted: 0,
      mcqLeaderboardScore: 0,
      accuracy: 0,
      mcqRankScore: FieldValue.delete(),
      subjectStats: {},
      lastUpdated: FieldValue.serverTimestamp(),
    }, { merge: true });
    ops++;
    if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
  }
  if (ops) await batch.commit();
  return reset;
}

/**
 * Storage download URL -> object path.
 *
 * Firebase URLs look like
 *   https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{urlencoded path}?alt=media&token=...
 * so the path is the single segment after `/o/`, url-decoded. Returns null for
 * anything that is not a Firebase Storage URL - a YouTube link, an empty string,
 * or a raw R2 url must never be mistaken for one.
 */
export function storagePathFromUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  if (!url.includes('firebasestorage.googleapis.com') && !url.includes('/o/')) return null;
  const m = /\/o\/([^?]+)/.exec(url);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/**
 * R2 public URL -> object key.
 *
 * `publicBase` is R2_PUBLIC_URL. The key is whatever follows it, which for
 * recordings is `records/{timestamp}_{filename}`. Guarded on the base so a
 * Firebase URL can never be handed to the R2 client.
 */
export function r2KeyFromUrl(url: unknown, publicBase: string): string | null {
  if (typeof url !== 'string' || !url || !publicBase) return null;
  const base = publicBase.replace(/\/+$/, '');
  if (!url.startsWith(base)) return null;
  const key = url.slice(base.length).replace(/^\/+/, '').split('?')[0];
  return key ? decodeURIComponent(key) : null;
}

export class YearWipeError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/**
 * The whole sequence, in the only order that works.
 *
 * Guards first, because every one of them protects against a wipe that would
 * destroy something unrecoverable:
 *   - the year label must match the live calendar, so a stale browser tab cannot
 *     wipe the wrong year
 *   - the final term's season must already be archived, or its leaderboard
 *     snapshot would be missing from the historical record
 *   - the latch makes a second click a no-op
 *
 * Returns the plan so the caller can hand the file manifest to deleteWipedFiles.
 * File deletion is deliberately NOT done here - it needs the R2 and Storage
 * clients, which only the API surfaces build.
 */
export async function runYearWipe(
  db: FirebaseFirestore.Firestore,
  FieldValue: { serverTimestamp(): any; delete(): any },
  opts: {
    yearLabel: string;
    performedBy: string;
    r2PublicUrl?: string;
    /** Set by the caller from the live calendar. */
    calendarYearLabel: string;
    /** Id of the last term of the year, from the live calendar. */
    finalTermId: string | null;
    summarise: (yearLabel: string) => Promise<{ summarised: number; skipped: number }>;
  },
): Promise<{ plan: WipePlan; wipe: WipeResult; summarised: number; documentsExported: number }> {
  const { yearLabel, performedBy, r2PublicUrl = '', calendarYearLabel, finalTermId, summarise } = opts;

  if (!yearLabel) throw new YearWipeError('yearLabel is required');
  if (yearLabel !== calendarYearLabel) {
    throw new YearWipeError(
      `That is not the current academic year. The calendar says "${calendarYearLabel}".`, 409);
  }

  const settingsSnap = await db.collection('app_settings').doc('streak').get();
  const settings = settingsSnap.data() || {};

  if (settings.yearClosedFor === yearLabel) {
    throw new YearWipeError(`${yearLabel} has already been wiped.`, 409);
  }

  // The term archive is a required historical checkpoint before annual reset.
  if (finalTermId && settings.seasonClosedFor !== finalTermId) {
    throw new YearWipeError(
      'Archive the final season first - run the season rollover, then wipe.', 409);
  }

  const { summarised } = await summarise(yearLabel);

  const plan = await planYearWipe(db, { yearLabel, r2PublicUrl });
  const { documentsExported } = await exportYear(db, FieldValue, { yearLabel, performedBy, plan });
  const wipe = await wipeYear(db, FieldValue, { yearLabel, performedBy });

  return { plan, wipe, summarised, documentsExported };
}

/** Reads only. Works out exactly what a wipe would touch. */
export async function planYearWipe(
  db: FirebaseFirestore.Firestore,
  opts: { yearLabel: string; r2PublicUrl?: string },
): Promise<WipePlan> {
  const { yearLabel, r2PublicUrl = '' } = opts;
  if (!yearLabel) throw new Error('planYearWipe needs a yearLabel');

  const settings = await db.collection('app_settings').doc('streak').get();
  const alreadyWiped = (settings.data() || {}).yearClosedFor === yearLabel;

  const counts: Record<string, number> = {};
  const files: WipeFile[] = [];

  for (const name of WIPE_COLLECTIONS) {
    const snap = await db.collection(name).get();
    counts[name] = snap.size;

    for (const doc of snap.docs) {
      const d = doc.data() || {};
      if (name === 'records') {
        const key = r2KeyFromUrl(d.audioUrl, r2PublicUrl);
        if (key) files.push({ kind: 'r2', key, source: `records/${doc.id}` });
      }
      for (const field of ['imageUrl', 'videoUrl', 'fileUrl']) {
        const path = storagePathFromUrl(d[field]);
        if (path) files.push({ kind: 'storage', key: path, source: `${name}/${doc.id}` });
      }
    }
  }

  // Lectures are reduced, not removed - the stub is what keeps bank questions
  // scoped to a lecture reachable. Their PDFs still go.
  const lectureSnap = await db.collection('lectures').get();
  for (const doc of lectureSnap.docs) {
    const path = storagePathFromUrl((doc.data() || {}).pdfUrl);
    if (path) files.push({ kind: 'storage', key: path, source: `lectures/${doc.id}` });
  }

  // Per-stage weekly timetable photos.
  const settingsSnap = await db.collection('settings').get();
  for (const doc of settingsSnap.docs) {
    if (!doc.id.startsWith('weekly_schedule')) continue;
    const path = storagePathFromUrl((doc.data() || {}).photoUrl);
    if (path) files.push({ kind: 'storage', key: path, source: `settings/${doc.id}` });
  }

  counts['userMCQAnswers'] = (await answerDocs(db, 'lectures', 'userMCQAnswers')).length;
  counts['userBankAnswers'] = (await answerDocs(db, 'questions', 'userBankAnswers')).length;

  return { yearLabel, counts, lectureStubs: lectureSnap.size, files, alreadyWiped };
}

/**
 * Per-user answer documents, via a collection group.
 *
 * The path guard is essential, not defensive: `collectionGroup('lectures')` also
 * matches the TOP-LEVEL `lectures` collection, so without it a wipe of MCQ
 * answers would delete every lecture in the app.
 */
async function answerDocs(
  db: FirebaseFirestore.Firestore,
  groupName: string,
  expectedRoot: string,
): Promise<FirebaseFirestore.DocumentReference[]> {
  const snap = await db.collectionGroup(groupName).select().get();
  const out: FirebaseFirestore.DocumentReference[] = [];
  for (const doc of snap.docs) {
    const userDoc = doc.ref.parent.parent;      // .../{root}/{uid}
    if (!userDoc) continue;                     // a top-level collection of the same name
    if (userDoc.parent.id !== expectedRoot) continue;
    out.push(doc.ref);
  }
  return out;
}

/**
 * Snapshots everything the wipe will delete into `contentArchives/{yearLabel}`.
 *
 * Documents only. The manifest records every R2 key and Storage path, but NOT
 * the bytes - a year of recordings is hundreds of megabytes and cannot live in
 * Firestore. Once the objects are deleted they are gone; the manifest exists so
 * you can fetch them first if you want them.
 */
export async function exportYear(
  db: FirebaseFirestore.Firestore,
  FieldValue: { serverTimestamp(): any },
  opts: { yearLabel: string; performedBy: string; plan: WipePlan },
): Promise<{ documentsExported: number }> {
  const { yearLabel, performedBy, plan } = opts;
  const root = db.collection('contentArchives').doc(yearLabel);

  let batch = db.batch();
  let ops = 0;
  const flush = async (force = false) => {
    if (ops >= 400 || (force && ops > 0)) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  };

  let documentsExported = 0;

  for (const name of [...WIPE_COLLECTIONS, 'lectures']) {
    const snap = await db.collection(name).get();
    for (const doc of snap.docs) {
      batch.set(root.collection(name).doc(doc.id), doc.data());
      ops++;
      documentsExported++;
      await flush();
    }
  }
  await flush(true);

  await root.set({
    yearLabel,
    performedBy,
    counts: plan.counts,
    lectureStubs: plan.lectureStubs,
    files: plan.files,
    documentsExported,
    exportedAt: FieldValue.serverTimestamp(),
  });

  return { documentsExported };
}

/**
 * Commits the wipe. Idempotent via `app_settings/streak.yearClosedFor`, which
 * mirrors how `seasonClosedFor` guards the season rollover.
 */
export async function wipeYear(
  db: FirebaseFirestore.Firestore,
  FieldValue: { serverTimestamp(): any; delete(): any },
  opts: { yearLabel: string; performedBy: string },
): Promise<WipeResult> {
  const { yearLabel, performedBy } = opts;
  if (!yearLabel) throw new Error('wipeYear needs a yearLabel');

  const mcqStatsReset = await resetAnnualMcqStats(db, FieldValue, yearLabel);

  let batch = db.batch();
  let ops = 0;
  const flush = async (force = false) => {
    if (ops >= 400 || (force && ops > 0)) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  };

  let documentsDeleted = 0;

  for (const name of WIPE_COLLECTIONS) {
    const snap = await db.collection(name).get();
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
      ops++;
      documentsDeleted++;
      await flush();
    }
  }
  await flush(true);

  for (const groupName of [['lectures', 'userMCQAnswers'], ['questions', 'userBankAnswers']] as const) {
    for (const ref of await answerDocs(db, groupName[0], groupName[1])) {
      batch.delete(ref);
      ops++;
      documentsDeleted++;
      await flush();
    }
  }
  await flush(true);

  // Lectures become stubs: enough for a bank question scoped to a lecture to
  // still resolve, with nothing left to read. `archived` is what keeps them out
  // of the student-facing lists.
  const lectureSnap = await db.collection('lectures').get();
  for (const doc of lectureSnap.docs) {
    const patch: Record<string, any> = { archived: true, archivedYear: yearLabel };
    for (const field of LECTURE_STUB_DROPS) patch[field] = FieldValue.delete();
    batch.set(doc.ref, patch, { merge: true });
    ops++;
    await flush();
  }
  await flush(true);

  // Nothing prunes these arrays, so after the wipe they would hold nothing but
  // ids of deleted documents - and StudentManagement would keep counting them.
  const usersSnap = await db.collection('users').get();
  let usersCleaned = 0;
  for (const doc of usersSnap.docs) {
    const d = doc.data() || {};
    const patch: Record<string, any> = {};
    // Completion belongs to the year being closed. Clearing the legacy flag
    // prevents it from suppressing next year's self-service question. Only add
    // existing fields so an idempotent retry does not rewrite every user.
    for (const field of [
      'hasCompletedProgression', 'lastProgressionYear', 'progressionYear',
      'progressionState', 'progressionAnsweredAt', 'pendingStageId',
      'pendingProgressionYear', 'pendingProgressionSetAt',
    ]) {
      if (field in d) patch[field] = FieldValue.delete();
    }
    for (const field of DEAD_ID_ARRAYS) {
      if (Array.isArray(d[field]) && d[field].length > 0) patch[field] = [];
    }
    if (Object.keys(patch).length === 0) continue;
    batch.set(doc.ref, patch, { merge: true });
    ops++;
    usersCleaned++;
    await flush();
  }
  await flush(true);

  // Administrative transfers also stamp progression on the roster so a
  // never-signed-in student's first login inherits the completed state. Clear
  // the roster copy too, otherwise the next login can resurrect the year that
  // was just closed. The roster itself and all identity fields remain intact.
  const studentsSnap = await db.collection('students').get();
  for (const doc of studentsSnap.docs) {
    const d = doc.data() || {};
    const patch: Record<string, any> = {};
    for (const field of [
      'hasCompletedProgression', 'lastProgressionYear', 'progressionYear',
      'progressionState', 'progressionAnsweredAt', 'pendingStageId',
      'pendingProgressionYear', 'pendingProgressionSetAt',
    ]) {
      if (field in d) patch[field] = FieldValue.delete();
    }
    if (Object.keys(patch).length === 0) continue;
    batch.set(doc.ref, patch, { merge: true });
    ops++;
    await flush();
  }
  await flush(true);

  await db.collection('app_settings').doc('streak').set({
    yearClosedFor: yearLabel,
    yearWipedAt: FieldValue.serverTimestamp(),
    yearWipedBy: performedBy,
  }, { merge: true });

  return {
    yearLabel,
    documentsDeleted,
    lectureStubs: lectureSnap.size,
    usersCleaned,
    filesListed: 0,
    mcqStatsReset,
  };
}
