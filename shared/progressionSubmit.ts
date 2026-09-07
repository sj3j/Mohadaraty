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
  nextProgressionStep, progressionOutcome, isAnswerValid, sortStages, stageOrder,
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

  // Deliberately unordered: `orderBy('order')` drops a stage document that has
  // no `order` field, and a dropped stage is one the ladder cannot see. The id
  // comes from the document, not the `id` field inside it - a wrong inner id
  // breaks the match against user.stageId exactly like a missing one, and
  // stagePromotion and signupRequest already address stages by document id.
  const stagesSnap = await db.collection('stages').get();
  const stages: StageLike[] = sortStages(
    stagesSnap.docs.map(d => ({ ...(d.data() as StageLike), id: d.id })),
  );

  // "No successor" is how the top of the ladder is detected, and an unknown
  // stage looks exactly the same - so without this check a student on a stale
  // or mistyped stageId would be silently marked graduated.
  const currentStage = stages.find(st => st.id === user.stageId);
  if (!currentStage) {
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

  // Graduating is inferred from "there is no stage above this one", so a data
  // defect that hides the stage above - no `order` on it, a broken ladder -
  // reads as a degree. Refuse rather than write it: graduation is one-way,
  // nextProgressionStep never asks a graduate anything again, and the student
  // would be frozen a year below where they belong with no way to say so. A
  // 409 they can report is recoverable; a silent graduation is not.
  if (outcome.graduated) {
    const orders = stages.map(stageOrder);
    const order = stageOrder(currentStage);
    const top = Math.max(...orders.filter(o => !Number.isNaN(o)));
    // A stage with no usable `order` cannot be placed on the ladder, so there is
    // no way to tell whether it sits above this student. While one exists, "no
    // stage above me" is not a fact - it is a gap in the data - and graduating
    // on it would be a guess. Refusing costs a graduate a day; guessing wrong
    // costs a whole cohort their final year.
    if (Number.isNaN(order) || order < top || orders.some(o => Number.isNaN(o))) {
      throw new ProgressionError(
        'تعذّر تحديد مرحلتك التالية. راجع الإدارة قبل تسجيل نتيجتك.', 409);
    }
  }

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
  //
  // The exam number goes with it, for the same reason and by the same route:
  // it is issued per year, so the one on file belongs to the year they just
  // finished. Clearing is also what makes re-asking POSSIBLE - setOwnExamCode
  // refuses to overwrite a code that is already set, and shouldAskForExamCode
  // never fires while one is present. Empty string rather than a delete:
  // Student.examCode is a required string and firestore.rules asserts
  // `examCode is string` on the user document. The snooze goes too, or a
  // student who postponed last year's prompt would silently skip this year's.
  //
  // Graduates keep theirs: they are not promoted, and there is no next year.
  if (outcome.promoted) {
    userPatch.group = FieldValue.delete();
    userPatch.examCode = '';
    userPatch.examCodePromptSnoozedUntil = FieldValue.delete();
  }

  // Leaving the stage vacates the seat.
  //
  // A representative represents the stage they study in. Once they move up (or
  // graduate) they are an ordinary student again and the seat is left empty for
  // the master admin to fill - nobody keeps write access over a stage they have
  // left, and nobody silently acquires power over the stage they arrive in.
  //
  // Moderators are appointed by a representative for one stage, so they are
  // released on the same rule.
  const wasStaff = user.role === 'admin' || user.role === 'moderator';
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
      if (outcome.promoted) {
        studentPatch.subgroup = FieldValue.delete();
        // App.tsx reads examCode from students FIRST, so clearing only the user
        // document would leave last year's number on screen and the prompt shut.
        studentPatch.examCode = '';
      }
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
