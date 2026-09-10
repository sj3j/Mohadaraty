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
  nextProgressionStep, progressionOutcome, isAnswerValid,
} from './progression.js';

export interface SubmitResult {
  promoted: boolean;
  graduated: boolean;
  stageId: string;
  stageNameAr: string | null;
  stageNameEn: string | null;
  tahmeelSubjects: string[];
}

export class ProgressionError extends Error {
  constructor(message: string, readonly status = 400) {
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
  },
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

  if (due === 'none') throw new ProgressionError('No progression question is open for you', 409);
  if (due !== round) throw new ProgressionError(`Expected the "${due}" question, not "${round}"`, 409);

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
    const requested = Array.from(new Set(opts.tahmeelSubjects || []));
    if (requested.length === 0) throw new ProgressionError('Choose at least one carried subject');

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

  const batch = db.batch();

  const userPatch: Record<string, any> = {
    stageId: outcome.stageId,
    tahmeelSubjects: outcome.tahmeelSubjects,
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
  const leavingStage = outcome.promoted || outcome.graduated;
  if (wasStaff && leavingStage && !user.isMasterAdmin) {
    userPatch.role = 'student';
    userPatch.managedStageId = FieldValue.delete();
    userPatch.permissions = FieldValue.delete();
  }

  batch.set(userRef, userPatch, { merge: true });

  // The whitelist copy. Without this syncUserStage undoes the promotion at the
  // student's next login - which is why the old client-only flow never worked.
  const email = String(user.email || '').toLowerCase().trim();
  if (email) {
    const studentRef = db.collection('students').doc(email);
    if ((await studentRef.get()).exists) {
      const studentPatch: Record<string, any> = { stageId: outcome.stageId };
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

  await batch.commit();

  const landed = stages.find(s => s.id === outcome.stageId) || null;
  return {
    promoted: outcome.promoted,
    graduated: outcome.graduated,
    stageId: outcome.stageId,
    stageNameAr: landed?.nameAr ?? null,
    stageNameEn: landed?.nameEn ?? null,
    tahmeelSubjects: outcome.tahmeelSubjects,
  };
}
