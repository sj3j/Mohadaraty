/**
 * Recording a student's progression answer. Server-side only.
 *
 * This CANNOT be a client write, for two independent reasons:
 *
 * 1. syncUserStage (api/index.ts, mirrored in server.ts) copies
 *    `students/{email}.stageId` onto the user doc on EVERY login. Writing only
 *    `users` - which is what the old ProgressionModal did - is silently
 *    reverted the next time the student signs in.
 * 2. `students/{email}` is admin-write-only in firestore.rules, so the student
 *    cannot fix (1) themselves.
 *
 * The round is recomputed here rather than trusted from the request, so a
 * student cannot skip to the three-way question and promote themselves early.
 */
import { AcademicCalendar, baghdadToday, progressionGate } from './academicCalendar.js';
import {
  ProgressionRound, ProgressionAnswer, StageLike,
  nextProgressionStep, progressionOutcome, isAnswerValid, nextStageOf,
} from './progression.js';

export interface SubmitResult {
  promoted: boolean;
  graduated: boolean;
  stageId: string;
  stageNameAr: string | null;
  stageNameEn: string | null;
  tahmeelSubjects: string[];
  tahmeelStageId: string | null;
  purged?: boolean;
}

export interface ProgressionLifecycle {
  purgeGraduatedStudent?: (identity: { uid: string; studentId: string }) => Promise<unknown>;
}

export class ProgressionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'PROGRESSION_ERROR',
  ) {
    super(message);
  }
}

export async function submitProgression(
  db: FirebaseFirestore.Firestore,
  FieldValue: { serverTimestamp(): any; delete(): any },
  calendar: AcademicCalendar,
  opts: {
    uid: string;
    round: ProgressionRound;
    answer: ProgressionAnswer;
    tahmeelSubjects?: string[];
    replacementRepresentativeEmail?: string;
  },
  lifecycle: ProgressionLifecycle = {},
): Promise<SubmitResult> {
  const { uid, round, answer } = opts;

  if (round !== 'first' && round !== 'resit') throw new ProgressionError('Unknown round');
  if (!isAnswerValid(round, answer)) throw new ProgressionError('Answer does not belong to that round');

  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new ProgressionError('User not found', 404);
  const user = userSnap.data() as any;

  const gate = progressionGate(calendar, baghdadToday(calendar.timezone));
  const due = nextProgressionStep({
    gate, yearLabel: calendar.yearLabel, user, stages: calendar.progressionStages,
  });

  if (due === 'none') {
    throw new ProgressionError(
      'No progression question is open for you', 409, 'NO_OPEN_PROGRESSION');
  }
  if (due !== round) {
    throw new ProgressionError(
      `Expected the "${due}" question, not "${round}"`, 409, 'WRONG_PROGRESSION_ROUND');
  }

  const stagesSnap = await db.collection('stages').orderBy('order', 'asc').get();
  const stages: StageLike[] = stagesSnap.docs.map(d => d.data() as StageLike);

  // "No successor" is how the top of the ladder is detected, and an unknown
  // stage looks exactly the same - so without this check a student on a stale
  // or mistyped stageId would be silently marked graduated.
  if (!stages.some(st => st.id === user.stageId)) {
    throw new ProgressionError('Your stage is not recognised. Contact an admin.', 409);
  }

  // Carried subjects must be real subjects of the stage being left, by slug.
  let tahmeel: string[] = [];
  if (round === 'resit' && answer === 'tahmeel') {
    if (!nextStageOf(stages, user.stageId)) {
      throw new ProgressionError('لا يمكن التحميل في المرحلة المنتهية. اختر "مكمل" أو "رسبت".', 400);
    }
    const requested = Array.from(new Set(opts.tahmeelSubjects || []));
    if (requested.length === 0) throw new ProgressionError('Choose at least one carried subject');
    if (requested.length > 20) throw new ProgressionError('Choose no more than 20 carried subjects');

    const subjectsSnap = await db.collection('subjects')
      .where('stageId', '==', user.stageId || '')
      .get();
    const valid = new Set(
      subjectsSnap.docs
        .map(d => d.data() as any)
        .filter(s => s.isActive !== false)
        .map(s => s.id),
    );

    const unknown = requested.filter(id => !valid.has(id));
    if (unknown.length) throw new ProgressionError(`Not subjects of your stage: ${unknown.join(', ')}`);
    tahmeel = requested;
  }

  const outcome = progressionOutcome({ round, answer, user, stages, tahmeelSubjects: tahmeel });

  const wasRepresentative = user.role === 'admin' && !user.isMasterAdmin;
  const leavingStage = outcome.promoted || outcome.graduated;
  const replacementEmail = String(opts.replacementRepresentativeEmail || '').toLowerCase().trim();
  let replacementUserRef: FirebaseFirestore.DocumentReference | null = null;
  let replacementAllowedRef: FirebaseFirestore.DocumentReference | null = null;

  if (replacementEmail) {
    if (!wasRepresentative || !leavingStage) {
      throw new ProgressionError('Only an outgoing stage representative may transfer the seat.', 403);
    }
    if (replacementEmail === String(user.email || '').toLowerCase().trim()) {
      throw new ProgressionError('Choose another student as the representative.');
    }
    const replacementRoster = await db.collection('students').doc(replacementEmail).get();
    if (!replacementRoster.exists || replacementRoster.data()?.isActive === false
        || replacementRoster.data()?.stageId !== user.stageId) {
      throw new ProgressionError('The replacement must be an active student in your current stage.', 409);
    }
    const replacementUsers = await db.collection('users').where('email', '==', replacementEmail).limit(1).get();
    if (replacementUsers.empty || replacementUsers.docs[0].data()?.stageId !== user.stageId) {
      throw new ProgressionError('The replacement must sign in once before the role can be transferred.', 409);
    }
    replacementUserRef = replacementUsers.docs[0].ref;
    replacementAllowedRef = db.collection('allowed_admins').doc(replacementEmail);
  }

  const batch = db.batch();

  const nextStage = nextStageOf(stages, user.stageId);
  const userPatch: Record<string, any> = {
    stageId: outcome.stageId,
    pendingStageId: outcome.progressionState === 'awaiting_resit'
      ? (nextStage?.id || FieldValue.delete())
      : FieldValue.delete(),
    pendingProgressionYear: outcome.progressionState === 'awaiting_resit'
      ? calendar.yearLabel
      : FieldValue.delete(),
    pendingProgressionSetAt: outcome.progressionState === 'awaiting_resit'
      ? FieldValue.serverTimestamp()
      : FieldValue.delete(),
    tahmeelSubjects: outcome.tahmeelSubjects,
    tahmeelStageId: outcome.tahmeelSubjects.length > 0 ? user.stageId : FieldValue.delete(),
    progressionYear: calendar.yearLabel,
    progressionState: outcome.progressionState,
    graduated: outcome.graduated,
    hasCompletedProgression: outcome.progressionState === 'completed',
    lastProgressionYear: calendar.yearLabel,
    progressionAnsweredAt: FieldValue.serverTimestamp(),
  };

  // A group from the stage they are leaving may not even exist in the new one.
  // Clearing it drops them onto the existing onboarding screen to pick again.
  if (outcome.promoted) userPatch.group = FieldValue.delete();

  // Leaving the stage vacates the seat.
  //
  // A representative represents the stage they study in. Once they move up (or
  // graduate) they are an ordinary student again and the seat is left empty for
  // the master admin to fill - nobody keeps write access over a stage they have
  // left, and nobody silently acquires power over the stage they arrive in.
  //
  // Moderators are appointed by a representative for one stage, so they are
  // released on the same rule.
  // 'support' belongs here even though the role is cross-stage: the seat is
  // still tied to a cohort, and a support account left holding the role after
  // it has left the stage keeps a role this demotion path would no longer
  // recognise on any later pass.
  const wasStaff = user.role === 'admin' || user.role === 'moderator' || user.role === 'support';
  if (wasStaff && leavingStage && !user.isMasterAdmin) {
    userPatch.role = 'student';
    userPatch.managedStageId = FieldValue.delete();
    userPatch.permissions = FieldValue.delete();
  }

  // Guard the eligibility snapshot. Without this precondition two near-simultaneous
  // submissions can both pass nextProgressionStep() and commit contradictory
  // outcomes. The loser becomes a harmless 409 that the client can refresh.
  batch.update(userRef, userPatch, { lastUpdateTime: userSnap.updateTime! });

  // The whitelist copy. Without this syncUserStage undoes the promotion at the
  // student's next login - which is why the old client-only flow never worked.
  const email = String(user.email || '').toLowerCase().trim();
  if (email) {
    const studentRef = db.collection('students').doc(email);
    if ((await studentRef.get()).exists) {
      const studentPatch: Record<string, any> = {
        stageId: outcome.stageId,
        tahmeelSubjects: outcome.tahmeelSubjects,
        tahmeelStageId: outcome.tahmeelSubjects.length > 0 ? user.stageId : FieldValue.delete(),
      };
      if (outcome.promoted) studentPatch.subgroup = FieldValue.delete();
      batch.set(studentRef, studentPatch, { merge: true });
    }

    // The other half of vacating the seat. allowed_admins is the second source
    // syncUserStage and firestore.rules read a role from, so demoting only the
    // users doc would be undone at the next login - they would silently get the
    // role back on a stage they no longer study in.
    if (wasStaff && leavingStage && !user.isMasterAdmin) {
      const allowedRef = db.collection('allowed_admins').doc(email);
      if ((await allowedRef.get()).exists) batch.delete(allowedRef);
    }
  }

  if (replacementUserRef && replacementAllowedRef) {
    const representative = {
      role: 'admin',
      managedStageId: user.stageId,
      permissions: {},
    };
    batch.set(replacementUserRef, representative, { merge: true });
    batch.set(replacementAllowedRef, {
      email: replacementEmail,
      ...representative,
      appointedBy: uid,
      appointedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  // Stage-isolated MCQ stats:
  // When promoted or graduated, mark their previous stage stats as isActiveInStage: false.
  // Their score earned in the previous stage remains permanently preserved in userStageMCQStats,
  // but they leave the active race so new incoming cohorts start on a fair, clean slate.
  if (user.stageId && (outcome.promoted || outcome.graduated)) {
    const prevStageStatRef = db.collection('userStageMCQStats').doc(`${uid}_${user.stageId}`);
    const prevStageStat = await prevStageStatRef.get();
    if (prevStageStat.exists) {
      const stats = prevStageStat.data() || {};
      batch.set(userRef.collection('stageHistory').doc(`${calendar.yearLabel}_${user.stageId}`), {
        yearLabel: calendar.yearLabel,
        stageId: user.stageId,
        totalFirstAttemptCorrect: stats.totalFirstAttemptCorrect || 0,
        totalFirstAttemptAnswered: stats.totalFirstAttemptAnswered || 0,
        lecturesAttempted: stats.lecturesAttempted || 0,
        mcqLeaderboardScore: stats.mcqLeaderboardScore || 0,
        scoreModel: 'correct_x10_v1',
        mcqRankScore: stats.mcqRankScore ?? null,
        accuracy: stats.accuracy || 0,
        subjectStats: stats.subjectStats || {},
        reason: outcome.graduated ? 'graduated' : 'promoted',
        archivedAt: FieldValue.serverTimestamp(),
      });
      batch.set(prevStageStatRef, {
        isActiveInStage: false,
        lastUpdated: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  }

  // If a stat doc already exists for their new destination stage, activate it
  if (outcome.stageId && outcome.promoted && !outcome.graduated) {
    const newStageStatRef = db.collection('userStageMCQStats').doc(`${uid}_${outcome.stageId}`);
    if ((await newStageStatRef.get()).exists) {
      batch.set(newStageStatRef, {
        isActiveInStage: true,
        lastUpdated: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  }

  // The legacy MCQ leaderboard copy on userMCQStats (kept for backward compatibility).
  const statsRef = db.collection('userMCQStats').doc(uid);
  if ((await statsRef.get()).exists) {
    batch.set(statsRef, {
      stageId: outcome.stageId,
      lastUpdated: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  try {
    await batch.commit();
  } catch (error: any) {
    const code = String(error?.code ?? '').toLowerCase();
    if (code === '9' || code === '10' || code === 'failed-precondition' || code === 'aborted') {
      throw new ProgressionError(
        'Your progression state changed. Refresh and try again.',
        409,
        'PROGRESSION_STATE_CHANGED',
      );
    }
    throw error;
  }

  let purged = false;
  if (outcome.graduated && lifecycle.purgeGraduatedStudent) {
    await lifecycle.purgeGraduatedStudent({ uid, studentId: email });
    purged = true;
  }

  const landed = stages.find(s => s.id === outcome.stageId) || null;
  return {
    promoted: outcome.promoted,
    graduated: outcome.graduated,
    stageId: outcome.stageId,
    stageNameAr: landed?.nameAr ?? null,
    stageNameEn: landed?.nameEn ?? null,
    tahmeelSubjects: outcome.tahmeelSubjects,
    tahmeelStageId: outcome.tahmeelSubjects.length > 0 ? user.stageId : null,
    purged,
  };
}

export interface ResetProgressionOptions {
  uid?: string;
  email?: string;
  stageId?: string;
  resetGroup?: boolean;
}

export interface ResetProgressionResult {
  success: boolean;
  uid: string;
  email: string;
  stageId?: string;
}

/**
 * Resets a student's progression state so they can answer again, or corrects their
 * stage assignment after an accidental answer.
 */
export async function resetProgression(
  db: FirebaseFirestore.Firestore,
  FieldValue: { serverTimestamp(): any; delete(): any },
  opts: ResetProgressionOptions,
): Promise<ResetProgressionResult> {
  let uid = opts.uid;
  let email = opts.email ? opts.email.toLowerCase().trim() : '';

  let userSnap: FirebaseFirestore.DocumentSnapshot | null = null;
  if (uid) {
    userSnap = await db.collection('users').doc(uid).get();
  } else if (email) {
    const q = await db.collection('users').where('email', '==', email).limit(1).get();
    if (!q.empty) {
      userSnap = q.docs[0];
      uid = userSnap.id;
    }
  }

  if (!userSnap || !userSnap.exists) {
    if (!email && uid && uid.includes('@')) email = uid.toLowerCase().trim();
    if (!email) throw new ProgressionError('User not found', 404);
  } else {
    const userData = userSnap.data() as any;
    if (!email && userData?.email) email = userData.email.toLowerCase().trim();
  }

  const batch = db.batch();

  if (uid && userSnap && userSnap.exists) {
    const userRef = db.collection('users').doc(uid);
    const userPatch: Record<string, any> = {
      pendingStageId: FieldValue.delete(),
      pendingProgressionYear: FieldValue.delete(),
      pendingProgressionSetAt: FieldValue.delete(),
      progressionYear: FieldValue.delete(),
      progressionState: FieldValue.delete(),
      hasCompletedProgression: FieldValue.delete(),
      lastProgressionYear: FieldValue.delete(),
      progressionAnsweredAt: FieldValue.delete(),
      graduated: false,
      tahmeelSubjects: [],
      tahmeelStageId: FieldValue.delete(),
    };
    if (opts.stageId) {
      userPatch.stageId = opts.stageId;
    }
    if (opts.resetGroup) {
      userPatch.group = FieldValue.delete();
    }
    batch.set(userRef, userPatch, { merge: true });

    if (opts.stageId) {
      const stageStatRef = db.collection('userStageMCQStats').doc(`${uid}_${opts.stageId}`);
      if ((await stageStatRef.get()).exists) {
        batch.set(stageStatRef, {
          isActiveInStage: true,
          lastUpdated: FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      const statsRef = db.collection('userMCQStats').doc(uid);
      if ((await statsRef.get()).exists) {
        batch.set(statsRef, {
          stageId: opts.stageId,
          lastUpdated: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }
  }

  if (email) {
    const studentRef = db.collection('students').doc(email);
    const studentSnap = await studentRef.get();
    if (studentSnap.exists) {
      const studentPatch: Record<string, any> = {
        pendingStageId: FieldValue.delete(),
        pendingProgressionYear: FieldValue.delete(),
        pendingProgressionSetAt: FieldValue.delete(),
        progressionYear: FieldValue.delete(),
        progressionState: FieldValue.delete(),
        hasCompletedProgression: FieldValue.delete(),
        lastProgressionYear: FieldValue.delete(),
        tahmeelSubjects: [],
        tahmeelStageId: FieldValue.delete(),
      };
      if (opts.stageId) {
        studentPatch.stageId = opts.stageId;
      }
      if (opts.resetGroup) {
        studentPatch.subgroup = FieldValue.delete();
      }
      batch.set(studentRef, studentPatch, { merge: true });
    }
  }

  await batch.commit();

  return {
    success: true,
    uid: uid || '',
    email,
    stageId: opts.stageId,
  };
}

export async function setPendingProgression(
  db: FirebaseFirestore.Firestore,
  FieldValue: { serverTimestamp(): any; delete(): any },
  calendar: AcademicCalendar,
  opts: { uid: string },
): Promise<{ success: boolean; pendingStageId: string }> {
  const { uid } = opts;
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new ProgressionError('User not found', 404);
  const user = userSnap.data() as any;

  const gate = progressionGate(calendar, baghdadToday(calendar.timezone));
  const due = nextProgressionStep({
    gate,
    yearLabel: calendar.yearLabel,
    user,
    stages: calendar.progressionStages,
  });
  if (due === 'none') {
    throw new ProgressionError(
      'No progression question is open for you', 409, 'NO_OPEN_PROGRESSION');
  }

  const stagesSnap = await db.collection('stages').orderBy('order', 'asc').get();
  const stages: StageLike[] = stagesSnap.docs.map(d => d.data() as StageLike);

  const nextStage = nextStageOf(stages, user.stageId);
  if (!nextStage) {
    throw new ProgressionError('المرحلة الحالية هي المرحلة المنتهية، لا توجد مرحلة تالية.', 400);
  }

  const batch = db.batch();
  batch.update(userRef, {
    pendingStageId: nextStage.id,
    pendingProgressionYear: calendar.yearLabel,
    pendingProgressionSetAt: FieldValue.serverTimestamp(),
  }, { lastUpdateTime: userSnap.updateTime! });
  try {
    await batch.commit();
  } catch (error: any) {
    const code = String(error?.code ?? '').toLowerCase();
    if (code === '9' || code === '10' || code === 'failed-precondition' || code === 'aborted') {
      throw new ProgressionError(
        'Your progression state changed. Refresh and try again.',
        409,
        'PROGRESSION_STATE_CHANGED',
      );
    }
    throw error;
  }

  return { success: true, pendingStageId: nextStage.id };
}


