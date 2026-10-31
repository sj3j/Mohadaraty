import { recordBelongsToLecture } from '../src/components/lecture/LectureRecordingsSection';
import { Lecture, RecordItem } from '../src/types';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ PASSED: ${message}`);
  }
}

console.log('--- Running Lecture Record Tag Tests ---');

// Test 1: Direct lectureId link
const lecture1: Lecture = {
  id: 'lec_101',
  title: 'Anatomy Lecture 1',
  type: 'theoretical',
  pdfUrl: 'https://example.com/1.pdf',
  createdAt: null,
  uploadedBy: 'admin',
  stageId: 'stage_1',
  subjectId: 'subj_anatomy',
  number: 1,
};

const recordDirect: RecordItem = {
  id: 'rec_1',
  title: 'Anatomy 1 Audio',
  type: 'theoretical',
  audioUrl: 'https://example.com/1.mp3',
  lectureId: 'lec_101',
  createdAt: null,
  uploadedBy: 'admin',
};

assert(
  recordBelongsToLecture(recordDirect, lecture1, 'stage_1') === true,
  'Direct foreign key (record.lectureId === lecture.id) matches lecture'
);

// Test 2: Foreign key points to a different lecture
const recordDifferentId: RecordItem = {
  id: 'rec_2',
  title: 'Physiology Audio',
  type: 'theoretical',
  audioUrl: 'https://example.com/2.mp3',
  lectureId: 'lec_999',
  createdAt: null,
  uploadedBy: 'admin',
};

assert(
  recordBelongsToLecture(recordDifferentId, lecture1, 'stage_1') === false,
  'Different foreign key does not match'
);

// Test 3: Metadata matching (stage, subject, type, number)
const recordMetadataMatch: RecordItem = {
  id: 'rec_3',
  title: 'Anatomy Audio Part 1',
  type: 'theoretical',
  audioUrl: 'https://example.com/3.mp3',
  stageId: 'stage_1',
  subjectId: 'subj_anatomy',
  number: 1,
  createdAt: null,
  uploadedBy: 'admin',
};

assert(
  recordBelongsToLecture(recordMetadataMatch, lecture1, 'stage_1') === true,
  'Metadata matching (stageId, subjectId, type, number) matches lecture'
);

// Test 4: Different lecture number
const recordWrongNumber: RecordItem = {
  id: 'rec_4',
  title: 'Anatomy Audio Part 2',
  type: 'theoretical',
  audioUrl: 'https://example.com/4.mp3',
  stageId: 'stage_1',
  subjectId: 'subj_anatomy',
  number: 2,
  createdAt: null,
  uploadedBy: 'admin',
};

assert(
  recordBelongsToLecture(recordWrongNumber, lecture1, 'stage_1') === false,
  'Different lecture number does not match'
);

// Test 5: Different stage
const recordWrongStage: RecordItem = {
  id: 'rec_5',
  title: 'Anatomy Audio Stage 2',
  type: 'theoretical',
  audioUrl: 'https://example.com/5.mp3',
  stageId: 'stage_2',
  subjectId: 'subj_anatomy',
  number: 1,
  createdAt: null,
  uploadedBy: 'admin',
};

assert(
  recordBelongsToLecture(recordWrongStage, lecture1, 'stage_1') === false,
  'Different stage does not match'
);

// Test 6: Different type (practical vs theoretical)
const recordWrongType: RecordItem = {
  id: 'rec_6',
  title: 'Anatomy Practical Audio',
  type: 'practical',
  audioUrl: 'https://example.com/6.mp3',
  stageId: 'stage_1',
  subjectId: 'subj_anatomy',
  number: 1,
  createdAt: null,
  uploadedBy: 'admin',
};

assert(
  recordBelongsToLecture(recordWrongType, lecture1, 'stage_1') === false,
  'Different type (practical vs theoretical) does not match'
);

console.log('--- All 6 Lecture Record Matching Tests Passed! ---');

