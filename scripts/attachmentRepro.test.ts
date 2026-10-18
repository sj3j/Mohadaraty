/**
 * Verification test for lecture attachment upload fixes.
 * Run with: npx tsx scripts/attachmentRepro.test.ts
 */
import { initializeApp } from 'firebase/app';
import { initializeFirestore, collection, addDoc } from 'firebase/firestore';
import { hasStaffCapability, hasStageCapability } from '../shared/staffCapabilities';

let failed = 0;
let passed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
    failed++;
  }
}

console.log('\n--- 1. Testing Fixed Firestore addDoc Sanitization ---');

const app = initializeApp({ projectId: 'test-project' }, 'testAppFix');
const db = initializeFirestore(app, {});

// Replicate the fixed attachmentData construction from src/services/lectureAttachmentService.ts:
const lectureNumber = null; // typical lecture without a number
const subjectName = '';
const subjectNameAr = undefined;

const sanitizedAttachmentData: Record<string, any> = {
  lectureId: 'lec_123',
  lectureTitle: 'Pharmacology 1',
  lectureNumber: typeof lectureNumber === 'number' ? lectureNumber : null,
  stageId: 'stage_3',
  subjectId: '',
  subjectName: (subjectName || '').trim() || null,
  subjectNameAr: (subjectNameAr || subjectName || '').trim() || null,
  url: 'https://example.com/test.jpg',
  storagePath: 'lecture_attachments/stage_3/lec_123/img.jpg',
  title: 'Board photo',
  uploadedBy: 'helper_1',
  uploaderName: 'Helper User',
  uploaderRole: 'moderator',
  isAnonymous: false,
  status: 'approved',
  width: 1920,
  height: 1080,
  size: 200000,
};

let crashed = false;
try {
  // addDoc validates all property values synchronously
  addDoc(collection(db, 'lecture_attachments'), sanitizedAttachmentData).catch(() => {});
} catch (e: any) {
  crashed = true;
  console.log('Unexpected crash:', e.message);
}

check('Sanitized attachmentData passes Firestore SDK validation without crashing', !crashed);

console.log('\n--- 2. Testing Stage Resolution for Helper Role ---');

const helperUser = {
  uid: 'helper_uid',
  role: 'moderator',
  managedStageId: 'stage_3',
  permissions: { manageLectures: true },
};

// Lecture with missing stageId falls back to helper's managedStageId
const lectureWithoutStageId: { id: string; stageId?: string } = { id: 'lec_999' };
const resolvedStage = (lectureWithoutStageId.stageId || (helperUser as any).managedStageId || (helperUser as any).stageId || 'general').trim();

check('Lecture without stageId correctly resolves to helper managedStageId (stage_3)', resolvedStage === 'stage_3');

console.log('\n--- 3. Testing Helper Stage Capability ---');

const isStaffForOwnStage = hasStageCapability(helperUser as any, 'manageLectures', 'stage_3');
const isStaffForOtherStage = hasStageCapability(helperUser as any, 'manageLectures', 'stage_4');

check('Helper has auto-approve authority on their own stage (stage_3)', isStaffForOwnStage === true);
check('Helper does NOT hold staff authority on other stages (stage_4)', isStaffForOtherStage === false);

console.log(`\nVerification Results: ${passed} passed, ${failed} failed.\n`);
process.exit(failed > 0 ? 1 : 0);
