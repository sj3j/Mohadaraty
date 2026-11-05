import type { Lecture } from '../types';
import type { BankQuestion } from '../types/questionBank.types';
import { canonicalSubjectSlug, subjectSlugOf } from './subjectDisplay';

/** The lecture fields needed to identify a shared question-bank entry. */
export type QuestionBankLecture = Pick<Lecture, 'id' | 'translationOf' | 'subjectId' | 'category'>;

/**
 * The stable question-bank id for a lecture pair.
 *
 * A translated lecture points to its original via `translationOf`; both views
 * must therefore read and write lecture-scoped questions under the original id.
 */
export function bankLectureIdFor(lecture: Pick<Lecture, 'id' | 'translationOf'> | null | undefined): string {
  if (!lecture) return '';
  return lecture.translationOf || lecture.id;
}

function canonicalSubjectId(subject: { subjectId?: string | null; category?: string | null } | null | undefined): string {
  return canonicalSubjectSlug(subjectSlugOf(subject));
}

/** Whether a lecture belongs to the selected current or legacy subject. */
export function isLectureMatchingSubject(
  lecture: QuestionBankLecture | null | undefined,
  subjectId: string | null | undefined,
): boolean {
  if (!subjectId) return true;
  return canonicalSubjectId(lecture) === canonicalSubjectSlug(subjectId);
}

/** Resolve any lecture document id to the canonical id used by the question bank. */
export function canonicalBankLectureId(
  lectureId: string | null | undefined,
  lectures: readonly QuestionBankLecture[],
): string {
  if (!lectureId) return '';
  const lecture = lectures.find(item => item.id === lectureId);
  return lecture ? bankLectureIdFor(lecture) : lectureId;
}

/** Whether a bank question belongs to the selected original/translated lecture pair. */
export function isQuestionMatchingLecture(
  question: Pick<BankQuestion, 'lectureId'> | null | undefined,
  selectedLectureId: string | null | undefined,
  lectures: readonly QuestionBankLecture[],
): boolean {
  if (!selectedLectureId) return true;
  if (!question?.lectureId) return false;
  return canonicalBankLectureId(question.lectureId, lectures) === canonicalBankLectureId(selectedLectureId, lectures);
}

/** Whether a bank question belongs to the selected current or legacy subject. */
export function isQuestionMatchingSubject(
  question: Pick<BankQuestion, 'subjectId'> | null | undefined,
  subjectId: string | null | undefined,
): boolean {
  if (!subjectId) return true;
  return canonicalSubjectId(question) === canonicalSubjectSlug(subjectId);
}

/**
 * Lectures shown in a question-bank picker for a subject.
 *
 * Hide a translation only when its original is present. A translation whose
 * original was deleted remains selectable so historical content is reachable.
 */
export function questionBankLectureOptions<T extends QuestionBankLecture>(
  lectures: readonly T[],
  subjectId: string | null | undefined,
): T[] {
  return lectures
    .filter(lecture => isLectureMatchingSubject(lecture, subjectId))
    .filter(lecture => !lecture.translationOf || !lectures.some(original => original.id === lecture.translationOf));
}
