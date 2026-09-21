const { setGlobalOptions } = require('firebase-functions/v2');
const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

setGlobalOptions({ region: 'me-west1' });

admin.initializeApp();

const db = admin.firestore();
db.settings({ databaseId: '(default)' });

// A COPY of shared/masterAdmins.ts. functions/ deploys as its own package and
// cannot reach the repo's TypeScript, so the list is repeated here and pinned
// by `npm run test:masters`, which fails if the two disagree.
//
// syncRole below is the reason this matters more than it looks: it rewrites the
// custom claim on EVERY users/{uid} write, and App.tsx stores role 'admin' for a
// master admin. An address missing from this list therefore has its
// master_admin claim stripped again by the next profile write.
const MASTER_ADMIN_EMAILS = [
  'almdrydyl335@gmail.com',
  'dra016go@gmail.com',
  'jempe.kn@gmail.com',
];

const isMasterAdminEmail = (email) =>
  !!email && MASTER_ADMIN_EMAILS.includes(String(email).toLowerCase());

/**
 * Device tokens for everyone who wants `preferenceKey` notifications.
 *
 * `stageId` restricts the fan-out to that stage. Every content type is
 * stage-owned, so without it a stage-1 homework woke up all five stages'
 * phones for something those students cannot even open. Pass null only for a
 * genuinely university-wide notification.
 */
async function getTokensWithPreferences(preferenceKey, stageId = null) {
  const tokensSnapshot = await db.collection('fcm_tokens').get();
  
  if (tokensSnapshot.empty) {
    return { tokens: [], tokenDocs: [] };
  }

  const userIds = [];
  const tokenMap = new Map();

  tokensSnapshot.forEach((doc) => {
    const data = doc.data();
    if (data.token) {
      userIds.push(doc.id);
      tokenMap.set(doc.id, data.token);
    }
  });

  if (userIds.length === 0) {
    return { tokens: [], tokenDocs: [] };
  }

  // Fetch user preferences in chunks of 30
  const tokens = [];
  const tokenDocs = [];
  const fetchedUserIds = new Set();

  for (let i = 0; i < userIds.length; i += 30) {
    const chunk = userIds.slice(i, i + 30);
    const usersSnapshot = await db.collection('users').where(admin.firestore.FieldPath.documentId(), 'in', chunk).get();
    
    usersSnapshot.forEach((doc) => {
      fetchedUserIds.add(doc.id);
      const userData = doc.data();
      const prefs = userData.notificationPreferences || {};
      // Wrong stage: this notification is not theirs to see.
      if (stageId && userData.stageId && userData.stageId !== stageId) {
        return;
      }
      // If preference is not explicitly false, it's true by default
      if (prefs[preferenceKey] !== false) {
        const token = tokenMap.get(doc.id);
        if (token) {
          tokens.push(token);
          tokenDocs.push(doc.id);
        }
      }
    });
  }

  // Also include tokens for users who might not have a user document yet (default to true)
  userIds.forEach(uid => {
    if (!fetchedUserIds.has(uid)) {
      tokens.push(tokenMap.get(uid));
      tokenDocs.push(uid);
    }
  });

  return { tokens, tokenDocs };
}

async function cleanupTokens(response, tokenDocs) {
  if (response.failureCount > 0) {
    const failedTokens = [];
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        const error = resp.error;
        if (
          error.code === 'messaging/invalid-registration-token' ||
          error.code === 'messaging/registration-token-not-registered'
        ) {
          failedTokens.push(tokenDocs[idx]);
        }
      }
    });

    if (failedTokens.length > 0) {
      console.log(`Cleaning up ${failedTokens.length} invalid tokens.`);
      const batch = db.batch();
      failedTokens.forEach((userId) => {
        const ref = db.collection('fcm_tokens').doc(userId);
        batch.delete(ref);
      });
      await batch.commit();
      console.log('Cleanup complete.');
    }
  }
}

exports.sendLectureNotificationV3 = onDocumentCreated({
  document: 'lectures/{lectureId}',
  database: '(default)'
}, async (event) => {
    const snap = event.data;
    if (!snap) return;
    const lectureId = event.params.lectureId;

    const notifLockRef = db.doc(`sentNotifications/${lectureId}_sendLectureNotificationV3`);
    const lockSnap = await notifLockRef.get();
    if (lockSnap.exists) {
      console.log('Already sent, skipping');
      return null;
    }
    await notifLockRef.set({ sentAt: admin.firestore.FieldValue.serverTimestamp() });

    const lectureData = snap.data();
    const lectureTitle = lectureData.title || 'New Lecture';

    console.log('New lecture created:', lectureTitle);

    const { tokens, tokenDocs } = await getTokensWithPreferences('lectures', lectureData.stageId || null);

    if (tokens.length === 0) {
      console.log('No valid tokens found for lecture notifications.');
      return null;
    }

    const payload = {
      notification: {
        title: 'New Lecture Uploaded!',
        body: lectureTitle,
      },
      data: {
        url: `/?lecture=${lectureId}`,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
    };

    console.log(`Sending lecture notifications to ${tokens.length} devices.`);

    const response = await admin.messaging().sendEachForMulticast({
      tokens: tokens,
      notification: payload.notification,
      data: payload.data,
      webpush: {
        fcmOptions: {
          link: `/?lecture=${lectureId}`
        }
      }
    });

    console.log('Successfully sent messages:', response.successCount);
    console.log('Failed messages:', response.failureCount);

    await cleanupTokens(response, tokenDocs);

    return null;
  });

exports.sendAnnouncementNotificationV3 = onDocumentCreated({
  document: 'announcements/{announcementId}',
  database: '(default)'
}, async (event) => {
    const snap = event.data;
    if (!snap) return;
    
    const announcementId = event.params.announcementId;
    const notifLockRef = db.doc(`sentNotifications/${announcementId}_sendAnnouncementNotificationV3`);
    const lockSnap = await notifLockRef.get();
    if (lockSnap.exists) {
      console.log('Already sent, skipping');
      return null;
    }
    await notifLockRef.set({ sentAt: admin.firestore.FieldValue.serverTimestamp() });

    const announcementData = snap.data();
    // `text` is the plain-text mirror of richBlocks, written by the composer on
    // every save precisely so this line never has to understand formatting - a
    // bold word must not reach a notification tray as literal markup.
    let content = announcementData.text || announcementData.content || '';
    // A poll-only post has no body. Falling through to the generic 'إعلان جديد'
    // would tell a student nothing; the question is the announcement.
    if (!content && announcementData.poll && announcementData.poll.question) {
      content = `📊 ${announcementData.poll.question}`;
    }
    if (!content && Array.isArray(announcementData.attachments) && announcementData.attachments.length) {
      content = `📎 ${announcementData.attachments.length} مرفق`;
    }
    if (!content) content = 'إعلان جديد';
    // Truncate content for notification body
    if (content.length > 100) {
      content = content.substring(0, 97) + '...';
    }

    console.log('New announcement created:', content);

    const { tokens, tokenDocs } = await getTokensWithPreferences('announcements', announcementData.stageId || null);

    if (tokens.length === 0) {
      console.log('No valid tokens found for announcement notifications.');
      return null;
    }

    const payload = {
      notification: {
        title: 'إعلان جديد 📢',
        body: content,
      },
      data: {
        url: `/?tab=announcements`,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
    };

    console.log(`Sending announcement notifications to ${tokens.length} devices.`);

    const response = await admin.messaging().sendEachForMulticast({
      tokens: tokens,
      notification: payload.notification,
      data: payload.data,
      webpush: {
        fcmOptions: {
          link: `/?tab=announcements`
        }
      }
    });

    console.log('Successfully sent messages:', response.successCount);
    console.log('Failed messages:', response.failureCount);

    await cleanupTokens(response, tokenDocs);

    return null;
  });

/**
 * Keeps `poll.counts` and `poll.totalVoters` on an announcement in step with the
 * ballots under `announcements/{id}/votes/{uid}`.
 *
 * This function exists so that the tally is not client-written. The students
 * collection has a precedent for accepting forgeable client-written aggregates
 * (see the comment above userMCQStats in firestore.rules), and that trade is
 * defensible for a personal score. It is not defensible for a poll: the whole
 * point of asking the class is that the answer reflects the class, and a single
 * student able to add fifty votes to their preferred option makes the result
 * worse than not asking. So firestore.rules grants students no write access to
 * the announcement document at all, and the count arrives here instead.
 *
 * Recounted from the subcollection rather than incremented from the delta. An
 * increment would drift permanently on any retry or out-of-order delivery, and
 * a class poll is a few dozen documents - cheap enough to just count.
 */
exports.tallyPollVotes = onDocumentWritten({
  document: 'announcements/{announcementId}/votes/{voterId}',
  database: '(default)'
}, async (event) => {
  const { announcementId } = event.params;
  const announcementRef = db.doc(`announcements/${announcementId}`);

  try {
    const announcementSnap = await announcementRef.get();
    if (!announcementSnap.exists) return null;

    const poll = announcementSnap.data().poll;
    if (!poll || !Array.isArray(poll.options)) return null;

    const votesSnap = await db.collection(`announcements/${announcementId}/votes`).get();

    // Seeded from the poll's own options so an option nobody picked reports 0
    // rather than disappearing from the map - the bar has to render at 0%.
    const counts = {};
    for (const option of poll.options) counts[option.id] = 0;

    let totalVoters = 0;
    const valid = new Set(poll.options.map(o => o.id));

    votesSnap.forEach(doc => {
      const optionIds = doc.data().optionIds;
      if (!Array.isArray(optionIds) || optionIds.length === 0) return;

      // Ignore ids that are not options of this poll. A ballot can outlive an
      // edit that removed the option it named, and it must not create a phantom
      // key in the tally when it does.
      const picked = optionIds.filter(id => valid.has(id));
      if (picked.length === 0) return;

      totalVoters++;
      // De-duplicated: a malformed ballot listing the same option twice counts
      // once, so a student cannot double-weight themselves.
      for (const id of new Set(picked)) counts[id] += 1;
    });

    await announcementRef.update({
      'poll.counts': counts,
      'poll.totalVoters': totalVoters,
    });
    return null;
  } catch (error) {
    console.error('Error tallying poll votes for', announcementId, error);
    return null;
  }
});

// REMOVED: telegramWebhookV3.
//
// Telegram posts are now mirrored by the standalone bot in bot/, which
// long-polls getUpdates instead of receiving a webhook. Three things made the
// webhook untenable rather than merely redundant:
//
//   1. It took a SINGLE TELEGRAM_CHANNEL_ID. The mirror maps five channels to
//      five stages, which that shape cannot express.
//   2. It never set `stageId`, so every announcement it wrote was invisible to
//      the stage-filtered feed - while still waking all five stages' phones,
//      because getTokensWithPreferences fans out to everyone when stageId is
//      null. A push for a post nobody could open.
//   3. It wrote the pre-redesign attachment shape (type/imageUrl/videoUrl) and
//      built Storage URLs with no download token, so its images 403'd for the
//      unauthenticated <img> in AttachmentGrid.
//
// A webhook and getUpdates are mutually exclusive on one bot token, so this
// had to go for the bot to receive anything at all. The bot clears any
// registered webhook at boot.
//
// IMPORTANT: this function was deployed in TWO regions - me-west1 and an
// orphaned us-central1 from before setGlobalOptions pinned the region.
// Deleting it here removes neither. Run BOTH:
//   firebase functions:delete telegramWebhookV3 --region me-west1
//   firebase functions:delete telegramWebhookV3 --region us-central1

exports.sendHomeworkNotificationV3 = onDocumentCreated({
  document: 'homeworks/{homeworkId}',
  database: '(default)'
}, async (event) => {
    const snap = event.data;
    if (!snap) return;

    const homeworkId = event.params.homeworkId;
    const notifLockRef = db.doc(`sentNotifications/${homeworkId}_sendHomeworkNotificationV3`);
    const lockSnap = await notifLockRef.get();
    if (lockSnap.exists) {
      console.log('Already sent, skipping');
      return null;
    }
    await notifLockRef.set({ sentAt: admin.firestore.FieldValue.serverTimestamp() });

    const homeworkData = snap.data();
    
    // The subject NAME is denormalized onto the homework at save time, so the
    // primary path needs no subject list here at all. That matters: this file
    // deploys as its own package and cannot import shared/subjectSlug.ts, so a
    // list here is a SECOND copy that silently goes stale - and it did. Every
    // subject outside the five below pushed a notification naming a raw slug.
    //
    // The map is kept only as a fallback for homework written before the
    // curriculum move, which carries a legacy category and no name.
    const LEGACY_SUBJECT_NAMES = {
      'pharmacology': 'فارما',
      'pharmacognosy': 'عقاقير',
      'organic_chemistry': 'عضوية',
      'biochemistry': 'بايو',
      'cosmetics': 'تكنو'
    };
    const subject =
      (homeworkData.subjectNameAr || '').trim() ||
      (homeworkData.subjectName || '').trim() ||
      LEGACY_SUBJECT_NAMES[homeworkData.subject] ||
      homeworkData.subject ||
      'مادة غير معروفة';
    const type = homeworkData.type === 'theoretical' ? 'نظري' : 'عملي';
    
    // Extract lecture numbers
    const lectureNumbers = homeworkData.lectures
      .map(l => l.label)
      .join(', ');

    const title = '📚 واجب جديد!';
    const body = `${subject} - ${type} | ${lectureNumbers}`;

    console.log('New homework created:', body);

    // Assuming we want to send to everyone who wants announcements for now
    // Or we could add a specific 'homework' preference later
    const { tokens, tokenDocs } = await getTokensWithPreferences('announcements', homeworkData.stageId || null);

    if (tokens.length === 0) {
      console.log('No valid tokens found for homework notifications.');
      return null;
    }

    const payload = {
      notification: {
        title: title,
        body: body,
      },
      data: {
        url: `/?tab=weekly`,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
    };

    console.log(`Sending homework notifications to ${tokens.length} devices.`);

    const response = await admin.messaging().sendEachForMulticast({
      tokens: tokens,
      notification: payload.notification,
      data: payload.data,
      webpush: {
        fcmOptions: {
          link: `/?tab=weekly`
        }
      }
    });

    console.log('Successfully sent messages:', response.successCount);
    console.log('Failed messages:', response.failureCount);

    await cleanupTokens(response, tokenDocs);

    return null;
  });

exports.sendSystemNotificationV3 = onDocumentCreated({
  document: 'systemNotifications/{notificationId}',
  database: '(default)'
}, async (event) => {
    const snap = event.data;
    if (!snap) return;

    const notificationId = event.params.notificationId;
    const notifLockRef = db.doc(`sentNotifications/${notificationId}_sendSystemNotificationV3`);
    const lockSnap = await notifLockRef.get();
    if (lockSnap.exists) {
      console.log('Already sent, skipping');
      return null;
    }
    await notifLockRef.set({ sentAt: admin.firestore.FieldValue.serverTimestamp() });

    const data = snap.data();
    const userId = data.userId;
    if (!userId) return null;

    console.log(`New system notification for user: ${userId}`);

    // Fetch token for this specific user
    const tokenDoc = await db.collection('fcm_tokens').doc(userId).get();
    if (!tokenDoc.exists || !tokenDoc.data().token) {
      console.log('No valid token found for user.');
      return null;
    }

    const payload = {
      notification: {
        title: data.title || 'إشعار إداري',
        body: data.body || '',
      },
      data: {
        url: `/?tab=profile`,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
    };

    try {
      const response = await admin.messaging().send({
        token: tokenDoc.data().token,
        notification: payload.notification,
        data: payload.data,
        webpush: {
          fcmOptions: {
            link: `/?tab=profile`
          }
        }
      });
      console.log('Successfully sent message:', response);
    } catch (error) {
      console.error('Error sending message:', error);
      if (
        error.code === 'messaging/invalid-registration-token' ||
        error.code === 'messaging/registration-token-not-registered'
      ) {
         await db.collection('fcm_tokens').doc(userId).delete();
         console.log('Cleaned up invalid token for user', userId);
      }
    }

    return null;
  });

exports.onFirstAttemptComplete = onDocumentCreated(
  {
    document: 'userMCQAnswers/{userId}/lectures/{lectureId}',
    region: 'me-west1'
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;

    const data = snapshot.data();
    if (!data.hasCompletedFirstAttempt) {
      return;
    }

    const { userId, lectureId } = event.params;
    const { firstAttemptCorrect, firstAttemptTotal } = data;

    const subjectId = data.subjectId || 'unknown_subject';

    const userStatsRef = db.collection('userMCQStats').doc(userId);

    try {
      await db.runTransaction(async (transaction) => {
        const statsDoc = await transaction.get(userStatsRef);

        let stats = statsDoc.exists ? statsDoc.data() : {
          userId,
          totalFirstAttemptCorrect: 0,
          totalFirstAttemptAnswered: 0,
          lecturesAttempted: 0,
          mcqLeaderboardScore: 0,
          accuracy: 0,
          subjectStats: {}
        };

        stats.totalFirstAttemptCorrect += firstAttemptCorrect;
        stats.totalFirstAttemptAnswered += firstAttemptTotal;
        stats.lecturesAttempted += 1;

        if (!stats.subjectStats) stats.subjectStats = {};
        if (!stats.subjectStats[subjectId]) {
          stats.subjectStats[subjectId] = { correct: 0, total: 0, lecturesAttempted: 0 };
        }
        stats.subjectStats[subjectId].correct += firstAttemptCorrect;
        stats.subjectStats[subjectId].total += firstAttemptTotal;
        stats.subjectStats[subjectId].lecturesAttempted += 1;

        if (stats.totalFirstAttemptAnswered > 0) {
          stats.mcqLeaderboardScore = (stats.totalFirstAttemptCorrect / stats.totalFirstAttemptAnswered) * Math.sqrt(stats.totalFirstAttemptAnswered) * 100;
          stats.accuracy = (stats.totalFirstAttemptCorrect / stats.totalFirstAttemptAnswered) * 100;
        }

        stats.lastUpdated = admin.firestore.FieldValue.serverTimestamp();

        transaction.set(userStatsRef, stats, { merge: true });
      });
      console.log(`Successfully updated MCQ stats for user: ${userId}`);
    } catch (error) {
      console.error(`Error updating MCQ stats for user ${userId}:`, error);
    }
    
    return null;
  }
);

const { onCall, HttpsError } = require('firebase-functions/v2/https');

// confirmDegreeBatch (onCall) was removed here.
//
// It was dead: the app confirms batches through confirmDegreeBatchClient in
// src/services/adminGradeService.ts, and nothing has called this in-app. But
// it was still DEPLOYED and callable by any signed-in staff account, and it
// was wrong in three ways that the client path is not:
//
//   - it admitted role === 'moderator', while manageGrades sits in
//     ADMIN_ONLY_CAPABILITIES (src/lib/permissions.ts) because grades reach
//     the students whitelist;
//   - it had no stage check of any kind, so it bypassed the scoping that
//     firestore.rules now enforces on degrees and degreeBatches - an onCall
//     runs on the Admin SDK and is not subject to those rules at all;
//   - it wrote degree documents with no stageId, material, maxDegree or
//     yearLabel, which land in StudentGradesScreen's legacy bucket and
//     surface under whichever stage tab happens to be earliest.
//
// Deleting it rather than fixing it: a second write path for grades is the
// thing worth removing, not a second copy of the same guards.
// onDocumentWritten is imported at the top of the file alongside
// onDocumentCreated. It used to be re-required here, which stopped working the
// moment a second trigger needed it: tallyPollVotes registers at module load,
// well before this line runs, and `const` is not hoisted.
exports.syncRole = onDocumentWritten({
  document: 'users/{uid}',
  database: '(default)'
}, async (event) => {
  if (!event.data.after.exists) return; // Ignore deletes
  
  const uid = event.params.uid;
  const newData = event.data.after.data();

  const email = newData.email || "";
  let role = newData.role ?? 'student';

  if (isMasterAdminEmail(email)) {
    role = 'master_admin';
  }

  await admin.auth().setCustomUserClaims(uid, {
    role: role,
  });
});

const { onSchedule } = require("firebase-functions/v2/scheduler");

// ============================================================================
// Subscription Cron Jobs
// ============================================================================

/**
 * Recompute users/{uid}'s access cache from the subscription rows that still
 * exist, instead of blanket-clearing it.
 *
 * A checked copy of recomputeUserAccess() in shared/iap.ts - functions/ deploys
 * as its own package, so ../shared is not on disk here, the same constraint
 * that forces the master-admin list to be duplicated in this file.
 *
 * It exists because an account can now hold TWO live subscriptions from
 * different rails: a web ZainCash one and an Apple IAP one. Expiring either and
 * clearing isSubscribed unconditionally would revoke access the other has
 * genuinely paid for. Taking max(endDate) over what is still active can only
 * raise access, never lower it below what someone bought.
 */
async function recomputeUserAccessAfterExpiry(userId) {
  const live = await db.collection('subscriptions')
    .where('userId', '==', userId)
    .where('status', '==', 'active')
    .get();

  let bestEnd = null;
  let bestPlan = null;
  const nowMs = Date.now();

  for (const doc of live.docs) {
    const data = doc.data();
    const end = data.endDate && data.endDate.toDate ? data.endDate.toDate() : null;
    // No endDate means open-ended, which outranks any date.
    if (!end) return { isSubscribed: true, subscriptionEnd: null, subscriptionPlan: data.plan || null };
    if (end.getTime() <= nowMs) continue;
    if (!bestEnd || end > bestEnd) { bestEnd = end; bestPlan = data.plan || null; }
  }

  return bestEnd
    ? {
        isSubscribed: true,
        subscriptionEnd: admin.firestore.Timestamp.fromDate(bestEnd),
        subscriptionPlan: bestPlan,
      }
    : { isSubscribed: false, subscriptionEnd: null, subscriptionPlan: null };
}

/**
 * Runs daily to expire subscriptions that have passed their end date.
 * Updates the subscription status to 'inactive' and recomputes the user's
 * access cache from whatever is left.
 */
exports.expireSubscriptions = onSchedule('every 24 hours', async (event) => {
  const now = admin.firestore.Timestamp.now();

  const expiredSubs = await db.collection('subscriptions')
    .where('status', '==', 'active')
    .where('endDate', '<=', now)
    .get();

  if (expiredSubs.empty) {
    console.log('No expired subscriptions found.');
    return;
  }

  console.log(`Expiring ${expiredSubs.size} subscriptions...`);
  
  // Firestore batch limit is 500
  const batches = [];
  let currentBatch = db.batch();
  let count = 0;

  for (const doc of expiredSubs.docs) {
    const data = doc.data();
    
    // Update subscription document
    currentBatch.update(doc.ref, {
      status: 'inactive',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Recompute rather than clear: this student may hold a second, still-live
    // subscription on the other rail, and taking access away from someone who
    // paid for it is the expensive direction to get wrong.
    //
    // The row being expired here is still status 'active' - the batch has not
    // committed - so the query below sees it. It is excluded by DATE instead:
    // its endDate is what put it in this loop, so the "end <= now" skip drops
    // it. Any other row of this user's that is still in the future survives.
    const remaining = await recomputeUserAccessAfterExpiry(data.userId);
    const stillLive = remaining.isSubscribed;
    const userRef = db.collection('users').doc(data.userId);
    currentBatch.update(userRef, stillLive ? remaining : {
      isSubscribed: false,
      subscriptionEnd: null,
      subscriptionPlan: null
    });

    // Only tell them it ended if it actually ended for them.
    const fcmDoc = stillLive
      ? { exists: false }
      : await db.collection('fcm_tokens').doc(data.userId).get();
    if (fcmDoc.exists && fcmDoc.data().token) {
       admin.messaging().send({
          token: fcmDoc.data().token,
          notification: {
            title: 'انتهى اشتراكك ⏰',
            body: 'انتهت صلاحية اشتراكك. جدّد الآن للاستمرار في استخدام ميزات الأسئلة.',
          },
          data: { type: 'subscription', event: 'expired' },
       }).catch(err => console.error('FCM error on expiry:', err));
    }

    count++;
    if (count === 400) {
      batches.push(currentBatch);
      currentBatch = db.batch();
      count = 0;
    }
  }

  if (count > 0) {
    batches.push(currentBatch);
  }

  await Promise.all(batches.map(batch => batch.commit()));
  console.log(`Successfully expired ${expiredSubs.size} subscriptions.`);
});

/**
 * Runs daily to send reminders to users whose subscriptions will expire in 3 days.
 */
exports.sendExpiryReminders = onSchedule('every 24 hours', async (event) => {
  const now = new Date();
  const threeDaysFromNowStart = new Date(now.getTime() + (3 * 24 * 60 * 60 * 1000));
  threeDaysFromNowStart.setHours(0, 0, 0, 0);
  
  const threeDaysFromNowEnd = new Date(threeDaysFromNowStart);
  threeDaysFromNowEnd.setHours(23, 59, 59, 999);

  const startTimestamp = admin.firestore.Timestamp.fromDate(threeDaysFromNowStart);
  const endTimestamp = admin.firestore.Timestamp.fromDate(threeDaysFromNowEnd);

  const expiringSubs = await db.collection('subscriptions')
    .where('status', '==', 'active')
    .where('endDate', '>=', startTimestamp)
    .where('endDate', '<=', endTimestamp)
    .get();

  if (expiringSubs.empty) {
    console.log('No subscriptions expiring in 3 days.');
    return;
  }

  console.log(`Sending expiry reminders for ${expiringSubs.size} subscriptions...`);

  let successCount = 0;
  for (const doc of expiringSubs.docs) {
    const data = doc.data();
    try {
      const fcmDoc = await db.collection('fcm_tokens').doc(data.userId).get();
      if (fcmDoc.exists && fcmDoc.data().token) {
        await admin.messaging().send({
          token: fcmDoc.data().token,
          notification: {
            title: 'تذكير: اقترب موعد انتهاء الاشتراك ⚠️',
            body: 'اشتراكك سينتهي خلال 3 أيام. بادر بالتجديد لضمان عدم انقطاع الخدمة.',
          },
          data: { type: 'subscription', event: 'reminder' },
        });
        successCount++;
      }
    } catch (err) {
      console.error(`Failed to send reminder to ${data.userId}:`, err);
    }
  }

  console.log(`Successfully sent ${successCount} expiry reminders.`);
});
