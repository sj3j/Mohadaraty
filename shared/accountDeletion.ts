/**
 * Account deletion, requested by the student and approved by their stage
 * representative.
 *
 * Google Play requires an app with accounts to offer deletion both in-app and
 * from a public web page. A review queue satisfies that: the request is made
 * in the app, and nothing is destroyed until a human acts.
 *
 * WHAT SURVIVES, AND WHY
 *
 * The person is deleted; the enrolment is not. `students/{id}` is the
 * institution's roster record - the representative created it, grades in
 * `degrees/{studentId}` hang off it, and wiping it would erase a university
 * result record rather than a personal account. So it is left in place with
 * every credential stripped and isActive false, which makes it permanently
 * unusable for signing in while the academic history stays intact. The privacy
 * policy states exactly this; Play permits retention that is disclosed.
 *
 * Everything that is genuinely *theirs* goes: profile, sign-in identity, photo,
 * push token, quiz attempts, streak history. Chat messages are kept but
 * anonymised - other students replied to them, and deleting one side of a
 * conversation damages someone else's record of it.
 *
 * Firestore and Auth are typed structurally because server.ts and api/index.ts
 * each build their own admin instance; this module must not import
 * firebase-admin, the same rule shared/adminUsers.ts follows.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any;
type Auth = any;
type FieldValueLike = { serverTimestamp(): any; delete(): any };

export class DeletionError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string) {
    super(message);
  }
}

export type DeletionStatus = 'pending' | 'approved' | 'rejected';

export interface DeletionRequest {
  uid: string;
  studentId: string;
  name: string;
  stageId: string | null;
  reason: string;
  status: DeletionStatus;
  requestedAt: any;
}

/** The name a deleted student's old messages are attributed to. */
export const DELETED_AUTHOR_AR = 'طالب محذوف';

/**
 * Records a student's request to have their account deleted.
 *
 * Keyed by uid so asking twice updates one row rather than filling the queue,
 * and so the student can always see the state of their own request.
 */
export async function requestAccountDeletion(
  db: Db,
  FieldValue: FieldValueLike,
  input: { uid: string; studentId: string; name: string; stageId?: string | null; reason?: string },
): Promise<{ uid: string }> {
  const { uid, studentId } = input;
  if (!uid || !studentId) {
    throw new DeletionError('Missing account identity.', 400, 'MISSING_IDENTITY');
  }

  const ref = db.collection('deletion_requests').doc(uid);
  const existing = await ref.get();
  if (existing.exists && existing.data()?.status === 'pending') {
    throw new DeletionError('A deletion request is already pending.', 409, 'ALREADY_PENDING');
  }

  await ref.set({
    uid,
    studentId,
    name: input.name || '',
    stageId: input.stageId || null,
    reason: (input.reason || '').slice(0, 500),
    status: 'pending',
    requestedAt: FieldValue.serverTimestamp(),
  });

  return { uid };
}

/** Withdraws a pending request. Only the student's own, and only while pending. */
export async function cancelAccountDeletion(db: Db, uid: string): Promise<void> {
  const ref = db.collection('deletion_requests').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) throw new DeletionError('No request found.', 404, 'NOT_FOUND');
  if (snap.data()?.status !== 'pending') {
    throw new DeletionError('That request has already been reviewed.', 409, 'ALREADY_REVIEWED');
  }
  await ref.delete();
}

/** Deletes every document in a collection reference, in pages. */
async function purgeCollection(db: Db, ref: any): Promise<void> {
  while (true) {
    const snap = await ref.limit(300).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((d: any) => batch.delete(d.ref));
    await batch.commit();
    if (snap.size < 300) return;
  }
}

/**
 * Irreversibly removes the personal account behind `uid`.
 *
 * Ordered so the credentials die FIRST. If a later step fails, the account is
 * already unusable rather than half-deleted but still signable-in - the one
 * outcome that would be worse than not starting.
 *
 * Every step is best-effort past that point: a missing subcollection or an
 * already-deleted Auth user must not strand the request in the queue forever.
 */
export async function purgeAccount(
  db: Db,
  auth: Auth,
  FieldValue: FieldValueLike,
  input: { uid: string; studentId: string },
): Promise<{ steps: string[] }> {
  const { uid, studentId } = input;
  const steps: string[] = [];
  const attempt = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      steps.push(label);
    } catch (err) {
      console.error(`purgeAccount: ${label} failed for ${uid}:`, err);
      steps.push(`${label}:failed`);
    }
  };

  // 1. Kill the credentials before anything else.
  if (studentId) {
    await attempt('students:disabled', () => db.collection('students').doc(studentId).update({
      isActive: false,
      password: FieldValue.delete(),
      loginCode: FieldValue.delete(),
      loginCodeKey: FieldValue.delete(),
      nameKey: FieldValue.delete(),
      googleEmail: FieldValue.delete(),
      googleLinkedAt: FieldValue.delete(),
      deletedAt: FieldValue.serverTimestamp(),
      deletedByRequest: true,
    }));
  }

  // 2. The sign-in identity itself.
  await attempt('auth:deleted', () => auth.deleteUser(uid));

  // 3. The profile and everything keyed by uid.
  await attempt('users:deleted', () => db.collection('users').doc(uid).delete());
  await attempt('fcmToken:deleted', () => db.collection('fcm_tokens').doc(uid).delete());
  await attempt('mcqStats:deleted', () => db.collection('userMCQStats').doc(uid).delete());
  await attempt('pendingStreakReset:deleted',
    () => db.collection('pending_streak_resets').doc(uid).delete());

  await attempt('mcqAnswers:purged',
    () => purgeCollection(db, db.collection('userMCQAnswers').doc(uid).collection('lectures')));
  await attempt('bankAnswers:purged',
    () => purgeCollection(db, db.collection('userBankAnswers').doc(uid).collection('questions')));

  await attempt('streakHistory:purged', async () => {
    const snap = await db.collection('streak_history').where('userId', '==', uid).limit(300).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((d: any) => batch.delete(d.ref));
    await batch.commit();
  });

  // Per-day streak audit. A subcollection, so deleting the users/ doc above
  // leaves it orphaned and fully intact - the same trap purgeChat.ts documents.
  // It records when the account was active every single day, which is exactly
  // the kind of thing a deletion request is asking to be rid of.
  await attempt('streakLog:purged',
    () => purgeCollection(db, db.collection('streakLog').doc(uid).collection('days')));

  // 4. Chat is anonymised, not deleted - see the module comment.
  await attempt('chat:anonymised', async () => {
    const snap = await db.collection('chat_messages').where('senderId', '==', uid).get();
    if (snap.empty) return;
    for (let i = 0; i < snap.docs.length; i += 300) {
      const batch = db.batch();
      for (const d of snap.docs.slice(i, i + 300)) {
        batch.update(d.ref, {
          senderName: DELETED_AUTHOR_AR,
          senderId: FieldValue.delete(),
          senderEmail: FieldValue.delete(),
          senderPhotoUrl: FieldValue.delete(),
          originalSenderName: FieldValue.delete(),
          originalSenderExamCode: FieldValue.delete(),
        });
      }
      await batch.commit();
    }
  });

  return { steps };
}

/**
 * Approves or rejects a queued request.
 *
 * The stage check is re-done here rather than trusted from the caller: this
 * runs with the Admin SDK, which bypasses firestore.rules entirely, so the
 * boundary the rules enforce has to be re-enforced by hand.
 */
export async function reviewDeletionRequest(
  db: Db,
  auth: Auth,
  FieldValue: FieldValueLike,
  opts: {
    uid: string;
    approve: boolean;
    reviewerUid: string;
    staff: { isMasterAdmin: boolean; managedStageId?: string | null };
    reason?: string;
  },
): Promise<{ status: DeletionStatus; steps: string[] }> {
  const ref = db.collection('deletion_requests').doc(opts.uid);
  const snap = await ref.get();
  if (!snap.exists) throw new DeletionError('No request found.', 404, 'NOT_FOUND');

  const data = snap.data() || {};
  if (data.status !== 'pending') {
    throw new DeletionError('That request has already been reviewed.', 409, 'ALREADY_REVIEWED');
  }

  if (!opts.staff.isMasterAdmin) {
    if (!opts.staff.managedStageId) {
      throw new DeletionError('You are not assigned to a stage.', 403, 'NO_STAGE');
    }
    if (data.stageId !== opts.staff.managedStageId) {
      throw new DeletionError(
        'You may only review students in your own stage.', 403, 'WRONG_STAGE');
    }
  }

  let steps: string[] = [];
  if (opts.approve) {
    const result = await purgeAccount(db, auth, FieldValue, {
      uid: data.uid, studentId: data.studentId,
    });
    steps = result.steps;
  }

  await ref.set({
    status: opts.approve ? 'approved' : 'rejected',
    reviewedAt: FieldValue.serverTimestamp(),
    reviewedBy: opts.reviewerUid,
    ...(opts.approve ? { steps } : { rejectionReason: (opts.reason || '').slice(0, 500) }),
  }, { merge: true });

  return { status: opts.approve ? 'approved' : 'rejected', steps };
}
