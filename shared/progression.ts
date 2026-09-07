/**
 * End-of-year progression: what to ask a student, and what their answer means.
 *
 * Pure - no Firebase - so the client and the server compute the same answer from
 * the same inputs. The server recomputes `nextProgressionStep` before accepting
 * a submission, because the client is not trusted about which question it was
 * showing.
 *
 * The flow:
 *
 *   results published  ->  نجحت ? / دور ثاني ?
 *                            |          |
 *                       promoted    awaiting_resit, asked nothing more until
 *                                   the resit results date passes, then:
 *                                     نجحت / تحميل / رسبت
 *
 * Everything is keyed on the calendar's `yearLabel`, so next year's calendar
 * reopens the cycle for everyone without any migration.
 */
import { ProgressionGate } from './academicCalendar.js';

export type ProgressionRound = 'first' | 'resit';
export type ProgressionStep = 'none' | ProgressionRound;

/** Round one: نجحت / دور ثاني. */
export type FirstAnswer = 'passed' | 'resit';
/** Round two, after the resit results: نجحت / تحميل / رسبت. */
export type ResitAnswer = 'passed' | 'tahmeel' | 'failed';
export type ProgressionAnswer = FirstAnswer | ResitAnswer;

export type ProgressionState = 'awaiting_resit' | 'completed';

/** The subset of a user document this module cares about. */
export interface ProgressionUser {
  role?: string;
  stageId?: string;
  progressionYear?: string;
  progressionState?: ProgressionState;
  graduated?: boolean;
  /** True only for the master admin, who is staff rather than a student and so
   *  never sits exams. Representatives and moderators ARE students. */
  isMasterAdmin?: boolean;
}

export interface StageLike {
  id: string;
  order: number;
  nameAr?: string;
  nameEn?: string;
}

/**
 * Which question this student should be answering right now.
 *
 * `none` for anyone who is not a student, has graduated, is already done for
 * this year, or is waiting on resit results that have not been published.
 */
export function nextProgressionStep(opts: {
  gate: ProgressionGate;
  yearLabel: string;
  user: ProgressionUser;
  /** Stages to ask. Empty/absent asks everyone. */
  stages?: string[] | null;
}): ProgressionStep {
  const { gate, yearLabel, user, stages } = opts;

  if (gate === 'closed') return 'none';
  // A stage representative and the moderators they appoint are STUDENTS who hold
  // extra permissions - they sit the same exams and move up the same ladder. Only
  // the master admin is staff-not-student. This used to exclude every non-student
  // role, which quietly froze representatives in their stage for ever: they were
  // never asked whether they passed, so their stageId never advanced.
  if (user.isMasterAdmin || user.role === 'master_admin') return 'none';
  if (user.graduated) return 'none';
  // Without a stage there is no "next stage" to compute, and an unknown stage
  // looks identical to the top of the ladder - answering نجحت would silently
  // mark them graduated. Leave them alone until an admin assigns a stage.
  if (!user.stageId) return 'none';

  // Only the cohort that actually sat last year's exams. A stage whose roster
  // was just imported has no result to report, so asking would just wall them
  // out of the app.
  if (stages && stages.length > 0 && !stages.includes(user.stageId)) return 'none';

  const answeredThisYear = user.progressionYear === yearLabel;

  if (answeredThisYear) {
    if (user.progressionState === 'completed') return 'none';
    // Sat a resit. Nothing more is asked until those results are out.
    if (user.progressionState === 'awaiting_resit') {
      return gate === 'resit_round' ? 'resit' : 'none';
    }
  }

  // Never answered this year. Even once the resit round is open they start at
  // the first question - they may simply not have opened the app in months.
  return 'first';
}

export interface ProgressionOutcome {
  stageId: string;
  graduated: boolean;
  tahmeelSubjects: string[];
  progressionState: ProgressionState;
  /** True when the stage actually changed, so the UI can congratulate them. */
  promoted: boolean;
  nextStage: StageLike | null;
}

/** `order` as a number, or NaN for a stage whose order is missing or junk. */
export function stageOrder(stage: StageLike | undefined | null): number {
  const raw = Number(stage?.order);
  return Number.isFinite(raw) ? raw : NaN;
}

/**
 * The ladder in order, lowest first.
 *
 * Sorted here rather than by Firestore, because `orderBy('order')` silently
 * DROPS any document that lacks the field - and a dropped stage is invisible
 * to `nextStageOf`, which is how a student promoting into it got graduated
 * instead. Reading the collection unordered and sorting here keeps a
 * malformed stage in the list, where the rest of the code can see and report
 * it. Stages with no usable `order` sort last, in id order.
 */
export function sortStages<T extends StageLike>(stages: T[]): T[] {
  return stages.slice().sort((a, b) => {
    const oa = stageOrder(a);
    const ob = stageOrder(b);
    if (Number.isNaN(oa) && Number.isNaN(ob)) return a.id.localeCompare(b.id);
    if (Number.isNaN(oa)) return 1;
    if (Number.isNaN(ob)) return -1;
    return oa - ob || a.id.localeCompare(b.id);
  });
}

/**
 * The stage after this one, or null at the top of the ladder.
 *
 * The successor is the LOWEST order strictly above this one, not `order + 1`.
 * An exact match made every gap in the ladder - orders 1,2,3,5, or a stage
 * document the query dropped - look identical to the top of it, and the top of
 * the ladder is what graduates a student: a third-year would have been marked
 * graduated because stage 4 was one step further away than the arithmetic
 * assumed. A stage with no usable `order` is not a candidate; it cannot be
 * placed on the ladder at all.
 */
export function nextStageOf(stages: StageLike[], stageId?: string): StageLike | null {
  const current = stages.find(s => s.id === stageId);
  const currentOrder = stageOrder(current);
  if (!current || Number.isNaN(currentOrder)) return null;

  let best: StageLike | null = null;
  for (const stage of stages) {
    const order = stageOrder(stage);
    if (Number.isNaN(order) || order <= currentOrder) continue;
    if (!best || order < stageOrder(best)) best = stage;
  }
  return best;
}

/**
 * Turns an answer into the fields to write.
 *
 * `tahmeelSubjects` are subject SLUGS ('biochemistry_ii'), not document ids
 * ('stage_3__biochemistry_ii'): that is what lectures.subjectId and the
 * hasStageAccess rule compare against, so an id here would grant nothing.
 * Callers must validate the slugs against the current stage before saving.
 */
export function progressionOutcome(opts: {
  round: ProgressionRound;
  answer: ProgressionAnswer;
  user: ProgressionUser;
  stages: StageLike[];
  tahmeelSubjects?: string[];
}): ProgressionOutcome {
  const { round, answer, user, stages } = opts;
  const currentStageId = user.stageId || '';
  const next = nextStageOf(stages, currentStageId);

  const stay = (state: ProgressionState, tahmeel: string[] = []): ProgressionOutcome => ({
    stageId: currentStageId,
    graduated: false,
    tahmeelSubjects: tahmeel,
    progressionState: state,
    promoted: false,
    nextStage: next,
  });

  // Passing out of the final stage graduates them: there is no next stage, so
  // they keep read-only access where they are and are never asked again.
  const moveUp = (tahmeel: string[] = []): ProgressionOutcome => {
    if (!next) {
      return {
        stageId: currentStageId,
        graduated: true,
        tahmeelSubjects: [],
        progressionState: 'completed',
        promoted: false,
        nextStage: null,
      };
    }
    return {
      stageId: next.id,
      graduated: false,
      tahmeelSubjects: tahmeel,
      progressionState: 'completed',
      promoted: true,
      nextStage: next,
    };
  };

  if (round === 'first') {
    if (answer === 'passed') return moveUp();
    // دور ثاني - nothing changes yet, they are parked until those results land.
    return stay('awaiting_resit');
  }

  if (answer === 'passed') return moveUp();
  if (answer === 'tahmeel') return moveUp(opts.tahmeelSubjects || []);
  return stay('completed'); // رسبت - repeats the year
}

/** Is this answer valid for this round? Guards the endpoint against junk input. */
export function isAnswerValid(round: ProgressionRound, answer: string): boolean {
  return round === 'first'
    ? answer === 'passed' || answer === 'resit'
    : answer === 'passed' || answer === 'tahmeel' || answer === 'failed';
}

/**
 * Stamps a student as already handled for this year's progression cycle.
 *
 * Used both for CLI promotion (stagePromotion.ts) and for importing a
 * brand-new roster with no prior year's result to report (RosterImport.tsx):
 * both place a student in a stage without them having answered a progression
 * question, and nextProgressionStep cannot tell "never answered because they
 * are new" from "never answered because they haven't gotten to it yet" - so
 * without this stamp they would be asked a question that has nothing to ask
 * them about.
 */
export function completedProgressionFields(yearLabel: string) {
  return {
    hasCompletedProgression: true,
    lastProgressionYear: yearLabel,
    progressionYear: yearLabel,
    progressionState: 'completed' as ProgressionState,
  };
}

/**
 * Copies a fresh-intake stamp off a students/{email} doc onto the users/{uid}
 * doc created at first login. Mirrors how stageId/subgroup are carried over
 * there: the importer cannot write to a uid that does not exist yet.
 */
export function carriedProgressionFields(studentData: any): Partial<ReturnType<typeof completedProgressionFields>> {
  if (!studentData?.progressionYear) return {};
  return {
    progressionYear: studentData.progressionYear,
    progressionState: studentData.progressionState,
    hasCompletedProgression: studentData.hasCompletedProgression,
    lastProgressionYear: studentData.lastProgressionYear,
  };
}
