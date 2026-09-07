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

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any;
type Auth = any;

/** Deletes the Firestore user doc and the Auth account behind it. */
export async function deleteUserAccount(db: Db, auth: Auth, uid: string): Promise<void> {
  await db.collection('users').doc(uid).delete();
  await auth.deleteUser(uid);
}

/**
 * Folds `deleteUid` into `keepUid`, then removes the duplicate.
 *
 * Merge policy: array fields union, numeric progress fields take the MAX of the
 * two, and subcollections move across. Taking the max rather than the sum is
 * deliberate - a duplicate account is the same human, so their streak did not
 * actually happen twice.
 */
export async function mergeUserAccounts(
  db: Db,
  auth: Auth,
  keepUid: string,
  deleteUid: string,
): Promise<void> {
  const keepUserRef = db.collection('users').doc(keepUid);
  const deleteUserRef = db.collection('users').doc(deleteUid);

  const [keepUserSnap, deleteUserSnap] = await Promise.all([
    keepUserRef.get(),
    deleteUserRef.get(),
  ]);

  const deleteUserData = deleteUserSnap.exists ? deleteUserSnap.data() || {} : {};
  const keepUserData = keepUserSnap.exists ? keepUserSnap.data() || {} : {};

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
  mergeArrays('favoriteLectures');

  if ((deleteUserData.streakCount || 0) > (keepUserData.streakCount || 0)) {
    updateData.streakCount = deleteUserData.streakCount;
  }
  if ((deleteUserData.longestStreak || 0) > (keepUserData.longestStreak || 0)) {
    updateData.longestStreak = deleteUserData.longestStreak;
  }
  // Merging is exactly the case this field exists for: the same human holding two
  // accounts (a Google uid and a roster email-as-uid) must not lose the record
  // earned on whichever one is being discarded.
  if ((deleteUserData.bestStreakAllTime || 0) > (keepUserData.bestStreakAllTime || 0)) {
    updateData.bestStreakAllTime = deleteUserData.bestStreakAllTime;
  }
  if ((deleteUserData.freezeTokens || 0) > (keepUserData.freezeTokens || 0)) {
    updateData.freezeTokens = deleteUserData.freezeTokens;
  }

  // The surviving account keeps its own stage unless it never had one. A merge
  // must not silently move someone between stages.
  if (!keepUserData.stageId && deleteUserData.stageId) {
    updateData.stageId = deleteUserData.stageId;
  }

  if (Object.keys(updateData).length > 0) {
    await keepUserRef.set(updateData, { merge: true });
  }

  // Subcollection: streakHistory
  const streakDocs = await deleteUserRef.collection('streakHistory').get();
  if (!streakDocs.empty) {
    const promises: Promise<unknown>[] = [];
    for (const doc of streakDocs.docs) {
      promises.push(keepUserRef.collection('streakHistory').doc(doc.id).set(doc.data(), { merge: true }));
      promises.push(doc.ref.delete());
    }
    await Promise.all(promises);
  }

  // MCQ stats
  const deleteMcqStatsRef = db.collection('userMCQStats').doc(deleteUid);
  const keepMcqStatsRef = db.collection('userMCQStats').doc(keepUid);
  const delMcqStatsSnap = await deleteMcqStatsRef.get();
  if (delMcqStatsSnap.exists) {
    const keepMcqStatsSnap = await keepMcqStatsRef.get();
    const delMcqData = delMcqStatsSnap.data() || {};
    const mergedMcqData: Record<string, any> = keepMcqStatsSnap.exists
      ? keepMcqStatsSnap.data() || {}
      : { userId: keepUid };

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
  }

  // MCQ answers
  const delAnswersLecturesDocs = await db.collection('userMCQAnswers').doc(deleteUid).collection('lectures').get();
  if (!delAnswersLecturesDocs.empty) {
    const keepAnswersRef = db.collection('userMCQAnswers').doc(keepUid).collection('lectures');
    const promises: Promise<unknown>[] = [];
    for (const doc of delAnswersLecturesDocs.docs) {
      promises.push(keepAnswersRef.doc(doc.id).set({ ...doc.data(), userId: keepUid }, { merge: true }));
      promises.push(doc.ref.delete());
    }
    await Promise.all(promises);
    await db.collection('userMCQAnswers').doc(deleteUid).delete();
  }

  // Global streak_history. Doc ids are {uid}_{date}.
  const streakHistoryDocsSnap = await db.collection('streak_history').where('userId', '==', deleteUid).get();
  if (!streakHistoryDocsSnap.empty) {
    const promises: Promise<unknown>[] = [];
    for (const doc of streakHistoryDocsSnap.docs) {
      const data = doc.data();
      const targetDateStr = doc.id.split('_')[1];
      if (targetDateStr) {
        promises.push(db.collection('streak_history').doc(`${keepUid}_${targetDateStr}`).set({ ...data, userId: keepUid }, { merge: true }));
      }
      promises.push(doc.ref.delete());
    }
    await Promise.all(promises);
  }

  // pending_streak_resets
  const pendingDeleteSnap = await db.collection('pending_streak_resets').doc(deleteUid).get();
  if (pendingDeleteSnap.exists) {
    await db.collection('pending_streak_resets').doc(keepUid).set(pendingDeleteSnap.data() || {}, { merge: true });
    await pendingDeleteSnap.ref.delete();
  }

  await deleteUserRef.delete();
  try {
    await auth.deleteUser(deleteUid);
  } catch (authError) {
    // The Auth account may already be gone; the Firestore side is what matters.
    console.error('Auth user delete error (may not exist):', authError);
  }
}
