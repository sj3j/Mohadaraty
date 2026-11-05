import {
  bankLectureIdFor,
  canonicalBankLectureId,
  isLectureMatchingSubject,
  isQuestionMatchingLecture,
  isQuestionMatchingSubject,
  questionBankLectureOptions,
  type QuestionBankLecture,
} from '../src/lib/questionBankMatching';

let passed = 0;
let failed = 0;

const check = (name: string, ok: boolean) => {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}`);
    failed++;
  }
};

const original: QuestionBankLecture = {
  id: 'lec-pharma-original',
  subjectId: 'pharmacology_i',
  category: 'pharmacology',
};
const translation: QuestionBankLecture = {
  id: 'lec-pharma-ar',
  translationOf: original.id,
  subjectId: 'pharmacology_i',
};
const unrelated: QuestionBankLecture = {
  id: 'lec-biochem',
  subjectId: 'biochemistry_ii',
  category: 'biochemistry',
};
const orphanTranslation: QuestionBankLecture = {
  id: 'lec-orphan-ar',
  translationOf: 'deleted-original',
  subjectId: 'pharmacology_i',
};
const lectures = [original, translation, unrelated, orphanTranslation];

console.log('\nCanonical lecture ids:');
check('original keeps its id', bankLectureIdFor(original) === original.id);
check('translation resolves to the original id', bankLectureIdFor(translation) === original.id);
check('an unknown id is preserved for legacy questions', canonicalBankLectureId('legacy-id', lectures) === 'legacy-id');

console.log('\nLecture-pair question matching:');
check('question stored on the original matches the translation selection',
  isQuestionMatchingLecture({ lectureId: original.id }, translation.id, lectures));
check('question stored on the translation matches the original selection',
  isQuestionMatchingLecture({ lectureId: translation.id }, original.id, lectures));
check('unrelated lecture does not match',
  !isQuestionMatchingLecture({ lectureId: unrelated.id }, original.id, lectures));
check('subject-scoped question does not match a lecture selection',
  !isQuestionMatchingLecture({ lectureId: null }, original.id, lectures));
check('no selected lecture leaves the list unfiltered',
  isQuestionMatchingLecture({ lectureId: unrelated.id }, null, lectures));

console.log('\nLegacy subject matching:');
check('legacy lecture category matches its curriculum subject',
  isLectureMatchingSubject({ id: 'legacy-pharma', category: 'pharmacology' }, 'pharmacology_i'));
check('legacy question subject matches its curriculum subject',
  isQuestionMatchingSubject({ subjectId: 'pharmacology' }, 'pharmacology_i'));
check('different subjects do not match',
  !isQuestionMatchingSubject({ subjectId: 'biochemistry' }, 'pharmacology_i'));
check('no selected subject leaves the list unfiltered',
  isLectureMatchingSubject(unrelated, null));

console.log('\nQuestion-bank lecture options:');
const pharmacologyOptions = questionBankLectureOptions(lectures, 'pharmacology_i');
check('hides a translation when its original exists',
  pharmacologyOptions.length === 2 && pharmacologyOptions[0].id === original.id && pharmacologyOptions[1].id === orphanTranslation.id);
check('keeps an orphan translation reachable', pharmacologyOptions.some(lecture => lecture.id === orphanTranslation.id));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
