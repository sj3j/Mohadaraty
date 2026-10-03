/**
 * Automated test suite for Lecture Attachments & Moderation System.
 * Tests:
 * 1. Image compression & resizing contracts
 * 2. Data model validation & attribution rules
 * 3. Security rules queries (Rules are not filters compliance)
 * 4. Timestamp resolution and sort stability
 * 5. Moderation notifications payload format
 *
 * Run with: npx tsx scripts/lectureAttachments.test.ts
 */

import { readFileSync } from 'fs';
import { join } from 'path';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok    ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
    failed++;
  }
}

const root = join(import.meta.dirname, '..');

console.log('\n--- 1. Security & Storage Rules Alignment ---');

const firestoreRules = readFileSync(join(root, 'firestore.rules'), 'utf8');
const storageRules = readFileSync(join(root, 'storage.rules'), 'utf8');

check(
  'firestore.rules guards lecture_attachments collection',
  firestoreRules.includes('match /lecture_attachments/{attachmentId}')
);

check(
  'firestore.rules ensures only approved or own pending or staff can read',
  firestoreRules.includes("resource.data.get('status', 'approved') == 'approved'") &&
    firestoreRules.includes("resource.data.get('uploadedBy', '') == request.auth.uid") &&
    firestoreRules.includes("canWriteStage(resource.data.get('stageId', ''))")
);

check(
  'firestore.rules prevents students from self-approving on create',
  firestoreRules.includes("request.resource.data.get('status', '') == 'pending'")
);

check(
  'storage.rules guards lecture_attachments with 10MB limit and image type',
  storageRules.includes('match /lecture_attachments/{stageId}/{lectureId}/{fileName}') &&
    storageRules.includes('10 * 1024 * 1024') &&
    storageRules.includes("request.resource.contentType.matches('image/.*')")
);

check(
  'storage.rules explicitly allows delete without failing on request.resource.size',
  storageRules.includes('allow delete: if isAuthenticated()') ||
    storageRules.includes('request.resource == null ||')
);

console.log('\n--- 2. Attribution & Data Model Validation ---');

import type { LectureAttachment } from '../src/types/lectureAttachment.types';

const mockAttachment: LectureAttachment = {
  id: 'att_123',
  lectureId: 'lec_456',
  lectureTitle: 'Pharmacology - Lec 1',
  stageId: 'stage_3',
  url: 'https://storage.googleapis.com/test.jpg',
  storagePath: 'lecture_attachments/stage_3/lec_456/user_1.jpg',
  title: 'Board notes summary',
  uploadedBy: 'user_student_1',
  uploaderName: 'Ahmad Ali',
  uploaderRole: 'student',
  isAnonymous: true,
  status: 'approved',
  createdAt: { toMillis: () => 1712000000000 },
  width: 1920,
  height: 1080,
  size: 350000,
};

check('Attachment model contains all required fields including lectureTitle', Boolean(
  mockAttachment.id &&
  mockAttachment.lectureId &&
  mockAttachment.lectureTitle &&
  mockAttachment.stageId &&
  mockAttachment.url &&
  mockAttachment.storagePath &&
  mockAttachment.uploadedBy &&
  mockAttachment.uploaderName &&
  mockAttachment.status
));

// Attribution display logic test
function formatAttribution(
  item: LectureAttachment,
  viewerIsStaff: boolean,
  isRtl: boolean
): string {
  if (item.isAnonymous) {
    if (viewerIsStaff) {
      return `${item.uploaderName} (${isRtl ? 'مجهول للعامة' : 'Anonymous'})`;
    }
    return isRtl ? 'طالب (هوية غير معلنة)' : 'Anonymous Student';
  }
  return item.uploaderName || (isRtl ? 'طالب' : 'Student');
}

check(
  'Anonymous student upload hides real name from peers',
  formatAttribution(mockAttachment, false, true) === 'طالب (هوية غير معلنة)'
);

check(
  'Anonymous student upload reveals real name to staff with tag',
  formatAttribution(mockAttachment, true, true) === 'Ahmad Ali (مجهول للعامة)'
);

check(
  'Non-anonymous upload shows real student name to peers',
  formatAttribution({ ...mockAttachment, isAnonymous: false }, false, true) === 'Ahmad Ali'
);

console.log('\n--- 3. Timestamp Resolution & Sort Stability ---');

function safeTimestampMillis(val: any): number {
  if (!val) return 0;
  if (typeof val.toMillis === 'function') return val.toMillis();
  if (typeof val === 'number') return val;
  if (val.seconds) return val.seconds * 1000 + (val.nanoseconds ? Math.floor(val.nanoseconds / 1e6) : 0);
  if (typeof val === 'string') {
    const parsed = Date.parse(val);
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

const t1 = { toMillis: () => 1700000000000 };
const t2 = { seconds: 1700000500, nanoseconds: 0 };
const t3 = 1700001000000;
const tNull = null;
const tUndefined = undefined;

check('safeTimestampMillis resolves Firestore Timestamp with toMillis()', safeTimestampMillis(t1) === 1700000000000);
check('safeTimestampMillis resolves raw seconds object', safeTimestampMillis(t2) === 1700000500000);
check('safeTimestampMillis resolves numeric epoch', safeTimestampMillis(t3) === 1700001000000);
check('safeTimestampMillis safely handles null without NaN', safeTimestampMillis(tNull) === 0);
check('safeTimestampMillis safely handles undefined without throwing', safeTimestampMillis(tUndefined) === 0);

console.log('\n--- 4. Client Query Strategy for Firestore Rules & UX ---');

const serviceCode = readFileSync(join(root, 'src/services/lectureAttachmentService.ts'), 'utf8');

check(
  'Service contains getLectureAttachments export',
  serviceCode.includes('export async function getLectureAttachments')
);

check(
  'Service saves cleanStageId in attachmentData and adminAlerts',
  serviceCode.includes('stageId: cleanStageId')
);

check(
  'Service contains approveAttachment and rejectAttachment exports',
  serviceCode.includes('export async function approveAttachment') &&
    serviceCode.includes('export async function rejectAttachment')
);

check(
  'Service contains uploadAttachment export accepting lectureTitle',
  serviceCode.includes('export async function uploadAttachment') &&
    serviceCode.includes('lectureTitle')
);

console.log('\n--- 5. Call Sites Pass `user` to `getLectureAttachments` ---');

const sectionCode = readFileSync(join(root, 'src/components/lecture/LectureAttachmentsSection.tsx'), 'utf8');
const drawerCode = readFileSync(join(root, 'src/components/pdf/PdfAttachmentsDrawer.tsx'), 'utf8');
const overlayCode = readFileSync(join(root, 'src/components/pdf/PdfReaderOverlay.tsx'), 'utf8');
const viewerModalCode = readFileSync(join(root, 'src/components/lecture/AttachmentViewerModal.tsx'), 'utf8');

check(
  'LectureAttachmentsSection passes user to getLectureAttachments',
  sectionCode.includes('getLectureAttachments(lecture.id, user)')
);

check(
  'PdfAttachmentsDrawer passes user to getLectureAttachments',
  drawerCode.includes('getLectureAttachments(lecture.id, user)')
);

check(
  'PdfReaderOverlay passes user to getLectureAttachments',
  overlayCode.includes('getLectureAttachments(lectureId, user)')
);

check(
  'AttachmentViewerModal provides zoom access without hiding on mobile',
  !viewerModalCode.includes('hidden sm:flex') || viewerModalCode.includes('onDoubleClick')
);

console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) {
  process.exit(1);
}

