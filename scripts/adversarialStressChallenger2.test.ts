import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Import production pure utilities
import { parseRecordsRoute, resolveRecordsRoute } from '../src/lib/recordsRouteResolution';
import { recordBelongsToLecture } from '../src/components/lecture/LectureRecordingsSection';
import { canManage } from '../src/lib/permissions';
import { r2KeyFromUrl, storagePathFromUrl } from '../shared/yearWipe';
import type { Lecture, RecordItem, UserProfile } from '../src/types';

// =========================================================================
// ADVERSARIAL TEST FIXTURES
// =========================================================================

const MOCK_LECTURES: Lecture[] = ([
  {
    id: 'lec_pharma_1',
    title: 'علم الأدوية - المحاضرة 1',
    stageId: 'stage_3',
    subjectId: 'pharma',
    category: 'pharmacology' as any,
    type: 'theoretical',
    number: 1,
    date: '2026-10-01',
    createdAt: null as any,
  },
  {
    id: 'lec_pharma_1_ar',
    title: 'علم الأدوية 1 - مترجم',
    stageId: 'stage_3',
    subjectId: 'pharma',
    category: 'pharmacology' as any,
    type: 'theoretical',
    number: 1,
    translationOf: 'lec_pharma_1',
    date: '2026-10-01',
    createdAt: null as any,
  },
  {
    id: 'lec_pharma_2',
    title: 'علم الأدوية - المحاضرة 2',
    stageId: 'stage_3',
    subjectId: 'pharma',
    category: 'pharmacology' as any,
    type: 'theoretical',
    number: 2,
    date: '2026-10-05',
    createdAt: null as any,
  },
  {
    id: 'lec_patho_1_practical',
    title: 'أمراض عملي 1',
    stageId: 'stage_3',
    subjectId: 'pathology',
    category: 'pathology' as any,
    type: 'practical',
    number: 1,
    date: '2026-10-02',
    createdAt: null as any,
  },
  {
    id: 'lec_stage4_pharma_1',
    title: 'فارما المرحلة الرابعة 1',
    stageId: 'stage_4',
    subjectId: 'pharma',
    category: 'pharmacology' as any,
    type: 'theoretical',
    number: 1,
    date: '2026-10-03',
    createdAt: null as any,
  },
] as unknown) as Lecture[];

const MOCK_RECORDS: RecordItem[] = [
  {
    id: 'rec_direct_fk',
    lectureId: 'lec_pharma_1',
    title: 'تسجيل نظري المحاضرة الأولى',
    audioUrl: 'https://pub-abc.r2.dev/records/pharma_1.mp3',
    stageId: 'stage_3',
    subjectId: 'pharma',
    category: 'pharmacology' as any,
    type: 'theoretical',
    number: 1,
    createdAt: null as any,
  },
  {
    id: 'rec_composite_match',
    title: 'تسجيل بدون معرف محاضرة مباشر',
    audioUrl: 'https://pub-abc.r2.dev/records/pharma_2.mp3',
    stageId: 'stage_3',
    subjectId: 'pharma',
    category: 'pharmacology' as any,
    type: 'theoretical',
    number: 2,
    createdAt: null as any,
  },
  {
    id: 'rec_practical',
    title: 'تسجيل عملي باثولوجي',
    audioUrl: 'https://pub-abc.r2.dev/records/patho_prac_1.m4a',
    stageId: 'stage_3',
    subjectId: 'pathology',
    category: 'pathology' as any,
    type: 'practical',
    number: 1,
    createdAt: null as any,
  },
];

const STUDENT_USER: UserProfile = {
  uid: 'student_123',
  role: 'student',
  stageId: 'stage_3',
  isRepresentative: false,
} as any;

const STUDENT_WITH_FAKE_PERMS: UserProfile = {
  uid: 'student_attacker',
  role: 'student',
  stageId: 'stage_3',
  isRepresentative: true,
  permissions: { manageRecords: true },
} as any;

const ADMIN_REP_DEFAULT: UserProfile = {
  uid: 'rep_default',
  role: 'admin',
  stageId: 'stage_3',
  managedStageId: 'stage_3',
  permissions: {},
} as any;

const ADMIN_REVOKED_RECORDS: UserProfile = {
  uid: 'rep_revoked',
  role: 'admin',
  stageId: 'stage_3',
  managedStageId: 'stage_3',
  permissions: { manageRecords: false },
} as any;

const MODERATOR_WITH_RECORDS: UserProfile = {
  uid: 'mod_records',
  role: 'moderator',
  stageId: 'stage_3',
  managedStageId: 'stage_3',
  permissions: { manageRecords: true },
} as any;

const MODERATOR_WITHOUT_RECORDS: UserProfile = {
  uid: 'mod_no_records',
  role: 'moderator',
  stageId: 'stage_3',
  managedStageId: 'stage_3',
  permissions: { manageLectures: true },
} as any;

const MASTER_ADMIN_USER: UserProfile = {
  uid: 'admin_master',
  role: 'admin',
  isMasterAdmin: true,
} as any;

// =========================================================================
// TEST SUITE: ADVERSARIAL STRESS CHALLENGER 2
// =========================================================================

describe('CHALLENGER 2: Adversarial Stress Testing', () => {

  // -----------------------------------------------------------------------
  // VECTOR 1: Routing, Deep Link Interception & Sanitization Stress Matrix
  // -----------------------------------------------------------------------
  describe('Vector 1: Routing, Deep Links & URL Sanitization', () => {

    test('1.1 Standard and trailing-slash paths (/records, /records/) sanitize to /', () => {
      const p1 = parseRecordsRoute('/records', '');
      assert.equal(p1.isLegacyRecordRoute, true);
      assert.equal(p1.cleanPath, '/');
      assert.equal(p1.recordId, null);

      const p2 = parseRecordsRoute('/records/', '');
      assert.equal(p2.isLegacyRecordRoute, true);
      assert.equal(p2.cleanPath, '/');
      assert.equal(p2.recordId, null);
    });

    test('1.2 Subpath deep links (/records/:id, /record/:id) extract ID and sanitize path to /', () => {
      const p1 = parseRecordsRoute('/records/rec_12345', '');
      assert.equal(p1.isLegacyRecordRoute, true);
      assert.equal(p1.recordId, 'rec_12345');
      assert.equal(p1.cleanPath, '/');

      const p2 = parseRecordsRoute('/record/rec_67890', '');
      assert.equal(p2.isLegacyRecordRoute, true);
      assert.equal(p2.recordId, 'rec_67890');
      assert.equal(p2.cleanPath, '/');
    });

    test('1.3 URL-encoded characters and spaces in subpath deep links', () => {
      const p = parseRecordsRoute('/records/rec%20audio%20%231%20%26%20part2', '');
      assert.equal(p.isLegacyRecordRoute, true);
      assert.equal(p.recordId, 'rec audio #1 & part2');
      assert.equal(p.cleanPath, '/');
    });

    test('1.4 Query parameter variations (?tab=records, ?tab=recordings, ?recordId=..., ?record=...)', () => {
      const p1 = parseRecordsRoute('/', '?tab=records');
      assert.equal(p1.isLegacyRecordRoute, true);
      assert.equal(p1.cleanSearch, '');

      const p2 = parseRecordsRoute('/', '?tab=recordings');
      assert.equal(p2.isLegacyRecordRoute, true);
      assert.equal(p2.cleanSearch, '');

      const p3 = parseRecordsRoute('/', '?recordId=rec_query_1');
      assert.equal(p3.isLegacyRecordRoute, true);
      assert.equal(p3.recordId, 'rec_query_1');
      assert.equal(p3.cleanSearch, '');

      const p4 = parseRecordsRoute('/', '?record=rec_query_2');
      assert.equal(p4.isLegacyRecordRoute, true);
      assert.equal(p4.recordId, 'rec_query_2');
      assert.equal(p4.cleanSearch, '');
    });

    test('1.5 Multi-parameter preservation: non-records params are strictly preserved', () => {
      const p = parseRecordsRoute(
        '/records/rec_123',
        '?tab=records&recordId=rec_123&utm_source=chat&theme=dark&page=2'
      );
      assert.equal(p.isLegacyRecordRoute, true);
      assert.equal(p.recordId, 'rec_123');
      assert.equal(p.cleanPath, '/');
      assert.ok(p.cleanSearch.includes('utm_source=chat'));
      assert.ok(p.cleanSearch.includes('theme=dark'));
      assert.ok(p.cleanSearch.includes('page=2'));
      assert.ok(!p.cleanSearch.includes('tab=records'));
      assert.ok(!p.cleanSearch.includes('recordId=rec_123'));
    });

    test('1.6 Malformed query strings, duplicate params, and edge characters', () => {
      // Repeated params: tab=records & tab=lectures
      const p1 = parseRecordsRoute('/', '?tab=records&tab=lectures');
      assert.equal(p1.isLegacyRecordRoute, true);

      // Empty recordId
      const p2 = parseRecordsRoute('/', '?recordId=&tab=records');
      assert.equal(p2.isLegacyRecordRoute, true);
      assert.equal(p2.cleanSearch, '');

      // Trailing & leading ampersands
      const p3 = parseRecordsRoute('/', '&&tab=records&&utm_campaign=winter&&');
      assert.equal(p3.isLegacyRecordRoute, true);
      assert.ok(p3.cleanSearch.includes('utm_campaign=winter'));
    });

    test('1.7 Malicious / adversarial strings (XSS, path traversal)', () => {
      // URL encoded XSS payload
      const xssEncoded = '/records/%3Cscript%3Ealert(%22xss%22)%3C%2Fscript%3E';
      const pXssEnc = parseRecordsRoute(xssEncoded, '');
      assert.equal(pXssEnc.isLegacyRecordRoute, true);
      assert.equal(pXssEnc.cleanPath, '/');
      assert.equal(pXssEnc.recordId, '<script>alert("xss")</script>');

      // Query param XSS payload
      const pXssParam = parseRecordsRoute('/', '?recordId=<script>alert("xss")</script>');
      assert.equal(pXssParam.isLegacyRecordRoute, true);
      assert.equal(pXssParam.recordId, '<script>alert("xss")</script>');

      // Path traversal attempt: /records/../../etc/passwd sanitizes path to /
      const traversalPath = '/records/../../etc/passwd';
      const pTrav = parseRecordsRoute(traversalPath, '');
      assert.equal(pTrav.isLegacyRecordRoute, true);
      assert.equal(pTrav.cleanPath, '/');
    });

    test('1.8 Non-records routes are never falsely flagged', () => {
      const routes = [
        ['/lectures', ''],
        ['/lectures/lec_1', ''],
        ['/announcements', '?tab=announcements'],
        ['/profile', ''],
        ['/weekly', '?week=2'],
        ['/records-management', ''],
        ['/my-recordings-doc', ''],
      ];

      for (const [pathname, search] of routes) {
        const p = parseRecordsRoute(pathname, search);
        assert.equal(p.isLegacyRecordRoute, false, `Route ${pathname}${search} should not be flagged`);
        assert.equal(p.cleanPath, pathname);
      }
    });

    test('1.9 Route Resolution: Resolves target lecture via direct lectureId FK', () => {
      const res = resolveRecordsRoute(
        '/records/rec_direct_fk',
        '',
        MOCK_LECTURES,
        MOCK_RECORDS
      );
      assert.equal(res.redirected, true);
      assert.equal(res.currentTab, 'lectures');
      assert.equal(res.openedLectureId, 'lec_pharma_1');
      assert.equal(res.highlightedRecordId, 'rec_direct_fk');
    });

    test('1.10 Route Resolution: Resolves target lecture via taxonomy fallback', () => {
      const res = resolveRecordsRoute(
        '/',
        '?recordId=rec_composite_match',
        MOCK_LECTURES,
        MOCK_RECORDS
      );
      assert.equal(res.redirected, true);
      assert.equal(res.openedLectureId, 'lec_pharma_2');
      assert.equal(res.highlightedRecordId, 'rec_composite_match');
    });

    test('1.11 Route Resolution: Direct lectureId fallback when ID passed matches lecture directly', () => {
      const res = resolveRecordsRoute(
        '/records/lec_patho_1_practical',
        '',
        MOCK_LECTURES,
        MOCK_RECORDS
      );
      assert.equal(res.redirected, true);
      assert.equal(res.openedLectureId, 'lec_patho_1_practical');
    });

    test('1.12 Route Resolution: Gracefully handles non-existent record ID without crashing', () => {
      const res = resolveRecordsRoute(
        '/records/non_existent_rec_99999',
        '',
        MOCK_LECTURES,
        MOCK_RECORDS
      );
      assert.equal(res.redirected, true);
      assert.equal(res.openedLectureId, null);
      assert.equal(res.highlightedRecordId, 'non_existent_rec_99999');
    });

    test('1.13 Route Resolution: Empty collections or undefined records arrays do not throw', () => {
      assert.doesNotThrow(() => {
        const res = resolveRecordsRoute('/records/rec_1', '', [], []);
        assert.equal(res.openedLectureId, null);
      });
      assert.doesNotThrow(() => {
        const res = resolveRecordsRoute('/records', '', undefined as any, undefined as any);
        assert.equal(res.openedLectureId, null);
      });
    });

    test('1.14 Lecture to Record matching engine: Cross-stage isolation is strictly enforced', () => {
      // Record for stage_4 must NOT match stage_3 lecture even if subject & number match
      const stage4Record: RecordItem = {
        id: 'rec_s4',
        title: 'فارما 4',
        stageId: 'stage_4',
        subjectId: 'pharma',
        type: 'theoretical',
        number: 1,
        audioUrl: 'https://pub-abc.r2.dev/records/s4.mp3',
        createdAt: null as any,
      };

      const matchStage3 = recordBelongsToLecture(stage4Record, MOCK_LECTURES[0]); // stage_3
      assert.equal(matchStage3, false, 'Record of stage_4 must not match lecture of stage_3');

      const matchStage4 = recordBelongsToLecture(stage4Record, MOCK_LECTURES[4]); // stage_4
      assert.equal(matchStage4, true, 'Record of stage_4 must match lecture of stage_4');
    });

    test('1.15 Lecture to Record matching engine: Type mismatch (theoretical vs practical) is strictly isolated', () => {
      const theoreticalRec: RecordItem = {
        id: 'rec_theo',
        title: 'باثولوجي نظري',
        stageId: 'stage_3',
        subjectId: 'pathology',
        type: 'theoretical',
        number: 1,
        audioUrl: 'https://pub-abc.r2.dev/records/theo.mp3',
        createdAt: null as any,
      };

      // Target lecture is practical
      const match = recordBelongsToLecture(theoreticalRec, MOCK_LECTURES[3]);
      assert.equal(match, false, 'Theoretical record must not match practical lecture');
    });
  });

  // -----------------------------------------------------------------------
  // VECTOR 2: Student Permissions & Staff-Only Guarding
  // -----------------------------------------------------------------------
  describe('Vector 2: Student Permissions & Staff Gating', () => {

    test('2.1 canManage("manageRecords") evaluates correctly across all user roles', () => {
      // Student: forbidden
      assert.equal(canManage(STUDENT_USER, 'manageRecords'), false);
      // Student attempting privilege escalation with forged permissions: strictly forbidden!
      assert.equal(canManage(STUDENT_WITH_FAKE_PERMS, 'manageRecords'), false);
      // Guest / null: forbidden
      assert.equal(canManage(null, 'manageRecords'), false);
      // Stage rep (role: admin): granted by default
      assert.equal(canManage(ADMIN_REP_DEFAULT, 'manageRecords'), true);
      // Stage rep with manageRecords explicitly revoked: forbidden
      assert.equal(canManage(ADMIN_REVOKED_RECORDS, 'manageRecords'), false);
      // Moderator with manageRecords granted: granted
      assert.equal(canManage(MODERATOR_WITH_RECORDS, 'manageRecords'), true);
      // Moderator without manageRecords: forbidden
      assert.equal(canManage(MODERATOR_WITHOUT_RECORDS, 'manageRecords'), false);
      // Master admin: granted
      assert.equal(canManage(MASTER_ADMIN_USER, 'manageRecords'), true);
    });

    test('2.2 LectureRecordingsSection UI code guards all staff actions with canManage', () => {
      const sectionSrc = fs.readFileSync(
        path.resolve('src/components/lecture/LectureRecordingsSection.tsx'),
        'utf-8'
      );

      // Verify isStaff declaration
      assert.ok(
        sectionSrc.includes("const isStaff = canManage(user, 'manageRecords')"),
        'LectureRecordingsSection must evaluate isStaff via canManage(user, "manageRecords")'
      );

      // Upload button must be conditioned on isStaff
      assert.ok(
        sectionSrc.includes('{isStaff && (') || sectionSrc.includes('isStaff && ('),
        'Upload action must be conditioned on isStaff'
      );

      // Admin actions (edit/delete) must be conditioned on isStaff
      assert.ok(
        sectionSrc.includes('{/* Admin Actions */}\n                    {isStaff && ('),
        'Admin edit/delete actions must be strictly wrapped in isStaff condition'
      );
    });

    test('2.3 server.ts GET /api/get-upload-url enforces verifyAuth, verifyAdmin, and staffCan', () => {
      const serverSrc = fs.readFileSync(path.resolve('server.ts'), 'utf-8');

      // Check route definition
      assert.ok(
        serverSrc.includes('app.get("/api/get-upload-url", verifyAuth, verifyAdmin'),
        'GET /api/get-upload-url must require verifyAuth and verifyAdmin'
      );

      // Check staff permission guard
      assert.ok(
        serverSrc.includes("if (!staffCan(staff, 'manageRecords'))"),
        'server.ts must verify staffCan(staff, "manageRecords")'
      );

      // Check stage gating
      assert.ok(
        serverSrc.includes('if (!staff.isMasterAdmin && !staff.isSupport) {') &&
        serverSrc.includes('if (!staff.managedStageId || requestedStage !== staff.managedStageId) {'),
        'server.ts must prevent staff from uploading to stages they do not manage'
      );
    });

    test('2.4 firestore.rules restricts records collection mutations to canWriteStage(..., "manageRecords")', () => {
      const rulesSrc = fs.readFileSync(path.resolve('firestore.rules'), 'utf-8');

      // Verify records rule block exists
      assert.ok(rulesSrc.includes('match /records/{recordId}'), 'firestore.rules must secure records collection');

      // Verify write rules
      assert.ok(
        rulesSrc.includes("allow create: if canWriteStage(request.resource.data.get('stageId', ''), 'manageRecords');"),
        'firestore.rules must restrict create to canWriteStage manageRecords'
      );
      assert.ok(
        rulesSrc.includes("allow update, delete: if canWriteStage(resource.data.get('stageId', ''), 'manageRecords')"),
        'firestore.rules must restrict update/delete to canWriteStage manageRecords'
      );
      assert.ok(
        rulesSrc.includes("allow read: if canReadStage(resource.data.get('stageId', null)"),
        'firestore.rules must restrict read to canReadStage'
      );
    });
  });

  // -----------------------------------------------------------------------
  // VECTOR 3: Backend Preservation, Cloudflare R2 Contracts & Annual Wipe
  // -----------------------------------------------------------------------
  describe('Vector 3: Backend Storage Preservation & Cloudflare R2 Contracts', () => {

    test('3.1 r2KeyFromUrl extracts object keys across various URL configurations', () => {
      const base = 'https://pub-abc123xyz.r2.dev';

      // Standard R2 URL
      assert.equal(
        r2KeyFromUrl(`${base}/records/1779_pharma_intro.mp3`, base),
        'records/1779_pharma_intro.mp3'
      );

      // Base with trailing slash
      assert.equal(
        r2KeyFromUrl(`${base}/records/audio_file_2.m4a`, `${base}/`),
        'records/audio_file_2.m4a'
      );

      // R2 URL with query string
      assert.equal(
        r2KeyFromUrl(`${base}/records/track.mp3?download=1&auth=xyz`, base),
        'records/track.mp3'
      );

      // Deep subpath in bucket
      assert.equal(
        r2KeyFromUrl(`${base}/stage_3/records/2026/lec_1.aac`, base),
        'stage_3/records/2026/lec_1.aac'
      );
    });

    test('3.2 r2KeyFromUrl returns null for non-R2 URLs and falsy inputs', () => {
      const base = 'https://pub-abc123xyz.r2.dev';

      // Firebase Storage URL
      assert.equal(
        r2KeyFromUrl('https://firebasestorage.googleapis.com/v0/b/app.appspot.com/o/rec.mp3?alt=media', base),
        null
      );

      // External YouTube link
      assert.equal(r2KeyFromUrl('https://youtube.com/watch?v=123', base), null);

      // Other domain
      assert.equal(r2KeyFromUrl('https://cdn.example.com/records/123.mp3', base), null);

      // Null, undefined, empty string
      assert.equal(r2KeyFromUrl('', base), null);
      assert.equal(r2KeyFromUrl(null as any, base), null);
      assert.equal(r2KeyFromUrl(undefined as any, base), null);
      assert.equal(r2KeyFromUrl('   ', base), null);
    });

    test('3.3 storagePathFromUrl strictly rejects R2 audio URLs to prevent cross-bucket confusion', () => {
      const base = 'https://pub-abc123xyz.r2.dev';
      const r2Url = `${base}/records/123.mp3`;

      // An R2 URL must never be parsed as a Firebase Storage path
      assert.equal(storagePathFromUrl(r2Url), null);
    });

    test('3.4 Annual Wipe: WIPE_COLLECTIONS includes "records" and planYearWipe targets R2 keys', () => {
      const yearWipeSrc = fs.readFileSync(path.resolve('shared/yearWipe.ts'), 'utf-8');
      assert.ok(
        yearWipeSrc.includes("const WIPE_COLLECTIONS = [") && yearWipeSrc.includes("'records'"),
        'WIPE_COLLECTIONS in shared/yearWipe.ts must include "records"'
      );

      // Verify that records collection is specifically parsed for R2 keys
      assert.ok(
        yearWipeSrc.includes("if (name === 'records') {") &&
        yearWipeSrc.includes("const key = r2KeyFromUrl(d.audioUrl, r2PublicUrl);") &&
        yearWipeSrc.includes("files.push({ kind: 'r2', key, source: `records/${doc.id}` });"),
        'planYearWipe must extract R2 keys from records.audioUrl'
      );
    });

    test('3.5 Cloudflare R2 presigned URL bucket contract in server.ts and api/index.ts', () => {
      const serverSrc = fs.readFileSync(path.resolve('server.ts'), 'utf-8');
      const apiSrc = fs.readFileSync(path.resolve('api/index.ts'), 'utf-8');

      // Check bucket name fallback 'lecture-audio'
      assert.ok(
        serverSrc.includes('process.env.R2_BUCKET_NAME || "lecture-audio"'),
        'server.ts must preserve bucket name default "lecture-audio"'
      );
      assert.ok(
        apiSrc.includes('process.env.R2_BUCKET_NAME || "lecture-audio"'),
        'api/index.ts must preserve bucket name default "lecture-audio"'
      );

      // Check PutObjectCommand import and invocation
      assert.ok(serverSrc.includes('PutObjectCommand'), 'server.ts must use PutObjectCommand');
      assert.ok(apiSrc.includes('PutObjectCommand'), 'api/index.ts must use PutObjectCommand');
    });
  });

  // -----------------------------------------------------------------------
  // VECTOR 4: UI Screen Removal & App Router Cleanliness
  // -----------------------------------------------------------------------
  describe('Vector 4: UI Screen Removal & Navigation Whitelist', () => {

    test('4.1 RecordsScreen.tsx is decommissioned and renders null stub', () => {
      const recordsScreenSrc = fs.readFileSync(path.resolve('src/components/RecordsScreen.tsx'), 'utf-8');

      // Must be a deprecated stub
      assert.ok(
        recordsScreenSrc.includes('export default function RecordsScreen(): null {') ||
        recordsScreenSrc.includes('return null;'),
        'RecordsScreen.tsx must return null and be decommissioned'
      );
    });

    test('4.2 HomeScreen tabs array strictly excludes records tab', () => {
      const homeScreenSrc = fs.readFileSync(path.resolve('src/components/HomeScreen.tsx'), 'utf-8');

      // InnerTab type must not include 'records'
      assert.ok(
        !homeScreenSrc.includes("type InnerTab = 'lectures' | 'weekly' | 'records'"),
        "HomeScreen InnerTab must not include 'records'"
      );

      // Tab chips must not contain id: 'records'
      assert.ok(
        !homeScreenSrc.includes("id: 'records'"),
        "HomeScreen tabs list must not contain id: 'records'"
      );

      // JSX must not mount <RecordsScreen
      assert.ok(
        !homeScreenSrc.includes('<RecordsScreen'),
        'HomeScreen JSX must not mount <RecordsScreen'
      );
    });

    test('4.3 App.tsx tabs whitelist strictly excludes records', () => {
      const appSrc = fs.readFileSync(path.resolve('src/App.tsx'), 'utf-8');

      // Tab whitelist should be ['home', 'lectures', 'weekly', 'leaderboard', 'downloads']
      assert.ok(
        appSrc.includes("['home', 'lectures', 'weekly', 'leaderboard', 'downloads'].includes(currentTab)"),
        "App.tsx tab whitelist must exclude 'records'"
      );

      // InitialTab normalization for legacy state
      assert.ok(
        appSrc.includes("(currentTab as any) === 'records' ? 'lectures' : currentTab"),
        'App.tsx must normalize legacy records tab state to lectures'
      );
    });
  });
});
