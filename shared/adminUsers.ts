/**
 * Master-admin account maintenance: deleting a user, and merging a duplicate
 * account into the one being kept.
 *
 * Lives in shared/ because these two routes existed only in server.ts. vercel.json
 * routes /api/* to api/index.ts, so in production they 404 - while
 * StudentManagement.tsx calls them. Duplicating ~150 lines into the second file
 * is how the two surfaces drifted in the first place, so the logic lives here once
 * and both files register a thin route over it.
 *
 * Firestore types are structural on purpose: server.ts and api/index.ts each build
 * their own admin instance, and this module must not import firebase-admin itself.
 */

import { ROSTER_EMAIL_DOMAIN } from './rosterIdentity.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any;
type Auth = any;

/** Deletes the Firestore user doc and the Auth account behind it. */
export async function deleteUserAccount(db: Db, auth: Auth, uid: string): Promise<void> {
  await db.collection('users').doc(uid).delete();
  await auth.deleteUser(uid);
}


export interface MergeOptions {
  /** The surviving `students` document id, if the pair has one. */
  keepStudentId?: string | null;
  /** The `students` document to retire. Deactivated and pointed at the keeper. */
  deleteStudentId?: string | null;
  /** Injected, so this module never imports firebase-admin. */
  FieldValue?: { serverTimestamp(): any };
  /** Free text recorded on the audit row: who or what asked for the merge. */
  reason?: string;
}

export interface MergeReport {
  keepUid: string;
  deleteUid: string;
  keepStudentId: string | null;
  deleteStudentId: string | null;
  /** False when there was nothing left to do - the merge already ran. */
  merged: boolean;
  moved: Record<string, number>;
  linkedGoogleEmail: string | null;
  auditId: string | null;
}

/** Moves every document of a subcollection across, then deletes the source. */
async function moveSubcollection(
  sourceParent: any,
  targetParent: any,
  name: string,
  patch?: (data: any) => any,
): Promise<number> {
  const snap = await sourceParent.collection(name).get();
  if (snap.empty) return 0;

  const writes: Promise<unknown>[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    writes.push(
      targetParent.collection(name).doc(doc.id).set(patch ? patch(data) : data, { merge: true }));
    writes.push(doc.ref.delete());
  }
  await Promise.all(writes);
  return snap.size;
}

/** Repoints every document whose `field` holds the dead uid at the live one. */
async function reassignByField(
  db: Db,
  collection: string,
  field: string,
  deleteUid: string,
  keepUid: string,
): Promise<number> {
  const snap = await db.collection(collection).where(field, '==', deleteUid).get();
  if (snap.empty) return 0;
  await Promise.all(
    snap.docs.map((d: any) => d.ref.set({ [field]: keepUid }, { merge: true })));
  return snap.size;
}

/** Drops documents that are cheaper to re-create than to reconcile. */
async function dropByField(
  db: Db, collection: string, field: string, uid: string,
): Promise<number> {
  const snap = await db.collection(collection).where(field, '==', uid).get();
  if (snap.empty) return 0;
  await Promise.all(snap.docs.map((d: any) => d.ref.delete()));
  return snap.size;
}

/**
 * Folds `deleteUid` into `keepUid`, then removes the duplicate.
 *
 * Merge policy: array fields union, numeric progress fields take the MAX of the
 * two, and subcollections move across. Taking the max rather than the sum is
 * deliberate - a duplicate account is the same human, so their streak did not
 * actually happen twice.
 *
 * THE `students` HALF IS WHAT MAKES IT STICK. This used to fold the `users` doc
 * and stop, leaving the losing roster row live - so the student signed in again
 * on the address it was keyed by and minted the duplicate straight back. The
 * loser is now retired in place (`isActive:false` + `mergedInto`) and its
 * address copied onto the survivor as `googleEmail`, which turns the duplicate
 * into the link. Retired rather than deleted, on the same reasoning as a subject
 * split: content the merge could not see would otherwise point at nothing, which
 * is invisible rather than merely misfiled. `followMerge` in
 * shared/studentLookup.ts is the other half - every lookup follows the pointer,
 * and resolveGoogleLogin follows it BEFORE reading `isActive`.
 *
 * Not transactional, and cannot be: it spans dozens of documents across a dozen
 * collections. An `accountMerges` row is written BEFORE any of it and closed
 * after, so a crash halfway leaves a reconstructible record rather than a silent
 * half-merge. Re-running is safe - a merge whose `users/{deleteUid}` is already
 * gone reports `merged:false` and touches nothing.
 */
export async function mergeUserAccounts(
  db: Db,
  auth: Auth,
  keepUid: string,
  deleteUid: string,
  options: MergeOptions = {},
): Promise<MergeReport> {
  const keepStudentId = (options.keepStudentId || '').trim().toLowerCase() || null;
  const deleteStudentId = (options.deleteStudentId || '').trim().toLowerCase() || null;
  const stamp = () => (options.FieldValue ? options.FieldValue.serverTimestamp() : new Date());

  const moved: Record<string, number> = {};
  const report: MergeReport = {
    keepUid, deleteUid, keepStudentId, deleteStudentId,
    merged: false, moved, linkedGoogleEmail: null, auditId: null,
  };

  const keepUserRef = db.collection('users').doc(keepUid);
  const deleteUserRef = db.collection('users').doc(deleteUid);

  const [keepUserSnap, deleteUserSnap] = await Promise.all([
    keepUserRef.get(),
    deleteUserRef.get(),
  ]);

  // Idempotency. The bulk script and the admin UI can both reach the same pair,
  // and a retry after a partial failure must not re-run the students half with a
  // keeper that has already absorbed the loser.
  if (!deleteUserSnap.exists && !deleteStudentId) return report;

  const deleteUserData = deleteUserSnap.exists ? deleteUserSnap.data() || {} : {};
  const keepUserData = keepUserSnap.exists ? keepUserSnap.data() || {} : {};

  const auditRef = db.collection('accountMerges').doc();
  report.auditId = auditRef.id;
  await auditRef.set({
    keepUid, deleteUid, keepStudentId, deleteStudentId,
    reason: options.reason || '',
    status: 'started',
    startedAt: stamp(),
  });

  const updateData: Record<string, unknown> = {};

  const mergeArrays = (field: string) => {
    const keepArr = Array.isArray(keepUserData[field]) ? keepUserData[field] : [];
    const deleteArr = Array.isArray(deleteUserData[field]) ? deleteUserData[field] : [];
    if (deleteArr.length > 0) {
      updateData[field] = Array.from(new Set([...keepArr, ...deleteArr]));
    }
  };

  mergeArrays('studied');
  mergeArrays('favorites');
  mergeArrays('completedWeeklyTasks');

  const takeMax = (field: string) => {
    if ((deleteUserData[field] || 0) > (keepUserData[field] || 0)) {
      updateData[field] = deleteUserData[field];
    }
  };

  takeMax('streakCount');
  takeMax('longestStreak');
  // Merging is exactly the case this field exists for: the same human holding two
  // accounts (a Google uid and a roster email-as-uid) must not lose the record
  // earned on whichever one is being discarded.
  takeMax('bestStreakAllTime');
  takeMax('freezeTokens');

  // The chain has to stay consistent with the counter. streakCount was taking the
  // max while lastActiveDate was left alone, so a survivor could end up claiming a
  // streak its own last-active day could not support. ISO dates sort as strings.
  if ((deleteUserData.lastActiveDate || '') > (keepUserData.lastActiveDate || '')) {
    updateData.lastActiveDate = deleteUserData.lastActiveDate;
  }

  // The surviving account keeps its own stage unless it never had one. A merge
  // must not silently move someone between stages.
  if (!keepUserData.stageId && deleteUserData.stageId) {
    updateData.stageId = deleteUserData.stageId;
  }

  // Fill-only: never overwrite something the survivor already says about itself.
  for (const field of ['examCode', 'photoUrl', 'group', 'subgroup', 'originalName']) {
    if (!keepUserData[field] && deleteUserData[field]) {
      updateData[field] = deleteUserData[field];
    }
  }

  // Paid access follows the human, not the row they happened to buy it on. This
  // was dropped entirely before, so merging could silently revoke a live
  // subscription. The later expiry wins, and the cached trio moves together:
  // App.tsx gates access on isSubscribed and renders the other two.
  const asMillis = (v: any): number => {
    if (!v) return 0;
    if (typeof v.toMillis === 'function') return v.toMillis();
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  if (asMillis(deleteUserData.subscriptionEnd) > asMillis(keepUserData.subscriptionEnd)) {
    updateData.subscriptionEnd = deleteUserData.subscriptionEnd || null;
    updateData.isSubscribed = deleteUserData.isSubscribed === true;
    if (deleteUserData.subscriptionPlan) {
      updateData.subscriptionPlan = deleteUserData.subscriptionPlan;
    }
  }
  if (!keepUserData.pendingZainCashRef && deleteUserData.pendingZainCashRef) {
    updateData.pendingZainCashRef = deleteUserData.pendingZainCashRef;
  }
  // The doc moves below; the flag that renders it lives here and used to be left
  // behind, so the survivor inherited a queued reset it never showed.
  if (deleteUserData.hasPendingStreakReset === true) {
    updateData.hasPendingStreakReset = true;
  }

  if (Object.keys(updateData).length > 0) {
    await keepUserRef.set(updateData, { merge: true });
  }

  // --- subcollections of users/{uid} ----------------------------------------
  // All three are season/year archives written by the Admin SDK. Only
  // streakHistory moved before; deleting users/{deleteUid} leaves subcollections
  // fully intact, so the other two were orphaned rather than merged.
  moved.streakHistory = await moveSubcollection(deleteUserRef, keepUserRef, 'streakHistory');
  moved.mcqHistory = await moveSubcollection(deleteUserRef, keepUserRef, 'mcqHistory');
  moved.yearHistory = await moveSubcollection(deleteUserRef, keepUserRef, 'yearHistory');

  // --- MCQ stats -------------------------------------------------------------
  const deleteMcqStatsRef = db.collection('userMCQStats').doc(deleteUid);
  const keepMcqStatsRef = db.collection('userMCQStats').doc(keepUid);
  const delMcqStatsSnap = await deleteMcqStatsRef.get();
  if (delMcqStatsSnap.exists) {
    const keepMcqStatsSnap = await keepMcqStatsRef.get();
    const delMcqData = delMcqStatsSnap.data() || {};
    const mergedMcqData: Record<string, any> = keepMcqStatsSnap.exists
      ? keepMcqStatsSnap.data() || {}
      : { userId: keepUid };

    mergedMcqData.userId = keepUid;
    mergedMcqData.mcqLeaderboardScore = Math.max(mergedMcqData.mcqLeaderboardScore || 0, delMcqData.mcqLeaderboardScore || 0);
    mergedMcqData.totalFirstAttemptCorrect = Math.max(mergedMcqData.totalFirstAttemptCorrect || 0, delMcqData.totalFirstAttemptCorrect || 0);
    mergedMcqData.accuracy = Math.max(mergedMcqData.accuracy || 0, delMcqData.accuracy || 0);
    mergedMcqData.lecturesAttempted = Math.max(mergedMcqData.lecturesAttempted || 0, delMcqData.lecturesAttempted || 0);

    if (delMcqData.subjectStats) {
      mergedMcqData.subjectStats = mergedMcqData.subjectStats || {};
      for (const key of Object.keys(delMcqData.subjectStats)) {
        if (!mergedMcqData.subjectStats[key]) {
          mergedMcqData.subjectStats[key] = delMcqData.subjectStats[key];
        } else {
          mergedMcqData.subjectStats[key].correct = Math.max(mergedMcqData.subjectStats[key].correct || 0, delMcqData.subjectStats[key].correct || 0);
          mergedMcqData.subjectStats[key].total = Math.max(mergedMcqData.subjectStats[key].total || 0, delMcqData.subjectStats[key].total || 0);
          mergedMcqData.subjectStats[key].lecturesAttempted = Math.max(mergedMcqData.subjectStats[key].lecturesAttempted || 0, delMcqData.subjectStats[key].lecturesAttempted || 0);
        }
      }
    }
    await keepMcqStatsRef.set(mergedMcqData, { merge: true });
    await deleteMcqStatsRef.delete();
    moved.userMCQStats = 1;
  }

  // --- answer sets ------------------------------------------------------------
  moved.userMCQAnswers = await moveSubcollection(
    db.collection('userMCQAnswers').doc(deleteUid),
    db.collection('userMCQAnswers').doc(keepUid),
    'lectures',
    (data) => ({ ...data, userId: keepUid }),
  );
  if (moved.userMCQAnswers > 0) {
    await db.collection('userMCQAnswers').doc(deleteUid).delete();
  }

  moved.userBankAnswers = await moveSubcollection(
    db.collection('userBankAnswers').doc(deleteUid),
    db.collection('userBankAnswers').doc(keepUid),
    'questions',
  );
  if (moved.userBankAnswers > 0) {
    await db.collection('userBankAnswers').doc(deleteUid).delete();
  }

  // The academic record. Unreachable after the merge if left behind, because
  // StudentGradesScreen reads degrees/{user.uid}/exams and that uid is gone.
  moved.degrees = await moveSubcollection(
    db.collection('degrees').doc(deleteUid),
    db.collection('degrees').doc(keepUid),
    'exams',
  );
  if (moved.degrees > 0) {
    await db.collection('degrees').doc(deleteUid).delete();
  }

  // --- global streak calendar --------------------------------------------------
  // Doc ids are {uid}_{date}, and a roster uid IS an email address which may
  // itself contain an underscore - so split('_')[1] returned a fragment of the
  // uid rather than the date. The stored `date` field is authoritative; the id is
  // only a fallback, and a row that yields neither is LEFT ALONE rather than
  // deleted. The delete used to sit outside that guard, so an id that failed to
  // split was destroyed without ever being copied.
  const streakHistoryDocsSnap = await db.collection('streak_history')
    .where('userId', '==', deleteUid).get();
  if (!streakHistoryDocsSnap.empty) {
    const writes: Promise<unknown>[] = [];
    const prefix = deleteUid + '_';
    let stranded = 0;
    for (const doc of streakHistoryDocsSnap.docs) {
      const data = doc.data() || {};
      const targetDateStr = data.date
        || (doc.id.startsWith(prefix) ? doc.id.slice(prefix.length) : '');
      if (!targetDateStr) { stranded++; continue; }
      writes.push(db.collection('streak_history').doc(keepUid + '_' + targetDateStr)
        .set({ ...data, userId: keepUid, date: targetDateStr }, { merge: true }));
      writes.push(doc.ref.delete());
    }
    await Promise.all(writes);
    moved.streak_history = streakHistoryDocsSnap.size - stranded;
    if (stranded > 0) moved.streak_history_stranded = stranded;
  }

  // Evidence and ledgers keyed by a uid FIELD. Repointed rather than moved - the
  // document ids are opaque and nothing reads them.
  moved.streak_recoveries = await reassignByField(
    db, 'streak_recoveries', 'userId', deleteUid, keepUid);
  moved.subscriptions = await reassignByField(
    db, 'subscriptions', 'userId', deleteUid, keepUid);

  const pendingDeleteSnap = await db.collection('pending_streak_resets').doc(deleteUid).get();
  if (pendingDeleteSnap.exists) {
    await db.collection('pending_streak_resets').doc(keepUid)
      .set(pendingDeleteSnap.data() || {}, { merge: true });
    await pendingDeleteSnap.ref.delete();
    moved.pending_streak_resets = 1;
  }

  // Cheaper to re-create than to reconcile: a device re-registers its push token
  // on next launch, the AI ledger resets at Baghdad midnight anyway, and a
  // generation request or a delivered notification addressed to a dead uid is
  // noise. Listed explicitly so the omission reads as a decision, not an
  // oversight.
  await db.collection('fcm_tokens').doc(deleteUid).delete().catch(() => {});
  moved.dropped_aiUsage = await dropByField(db, 'aiUsage', 'uid', deleteUid);
  moved.dropped_mcqRequests = await dropByField(db, 'mcqRequests', 'userId', deleteUid);
  moved.dropped_systemNotifications = await dropByField(
    db, 'systemNotifications', 'userId', deleteUid);

  // --- the students half --------------------------------------------------------
  if (deleteStudentId && keepStudentId && deleteStudentId !== keepStudentId) {
    const [loserSnap, keeperSnap] = await Promise.all([
      db.collection('students').doc(deleteStudentId).get(),
      db.collection('students').doc(keepStudentId).get(),
    ]);

    if (loserSnap.exists && keeperSnap.exists) {
      const keeperData = keeperSnap.data() || {};
      const loserData = loserSnap.data() || {};
      const keeperUpdates: any = {};

      // Only a real address is worth carrying over, and only onto a survivor that
      // has not already linked one - overwriting an existing googleEmail would
      // silently retarget a link the student made themselves. A synthetic roster
      // id is not a mailbox and nobody can sign in with it.
      const isSynthetic = deleteStudentId.endsWith('@' + ROSTER_EMAIL_DOMAIN);
      if (!isSynthetic && !(keeperData.googleEmail || '').trim()) {
        keeperUpdates.googleEmail = deleteStudentId;
        keeperUpdates.googleLinkedAt = stamp();
        report.linkedGoogleEmail = deleteStudentId;
      }

      // UX Guard: Carry over the password ONLY if the survivor completely lacks one.
      // Never overwrite a survivor's working password.
      if (!keeperData.password && loserData.password) {
        keeperUpdates.password = loserData.password;
      }

      if (Object.keys(keeperUpdates).length > 0) {
        await db.collection('students').doc(keepStudentId).set(keeperUpdates, { merge: true });
      }

      await db.collection('students').doc(deleteStudentId).set({
        isActive: false,
        mergedInto: keepStudentId,
        mergedAt: stamp(),
      }, { merge: true });
      moved.students_retired = 1;
    }
  }

  await deleteUserRef.delete();
  try {
    await auth.deleteUser(deleteUid);
  } catch (authError) {
    // The Auth account may already be gone; the Firestore side is what matters.
    console.error('Auth user delete error (may not exist):', authError);
  }

  report.merged = true;
  await auditRef.set({
    status: 'completed',
    completedAt: stamp(),
    moved,
    linkedGoogleEmail: report.linkedGoogleEmail,
  }, { merge: true });

  return report;
}
