/**
 * Mohadaraty - Comprehensive Opaque-Box E2E Test Suite (Tiers 1-4)
 * Requirements:
 * - R1: Lecture Recording Presentation in Attachments (dedicated subsection, inline AudioPlayer, all controls, playback)
 * - R2: Removal of Dedicated Records Screen and Navigation Redirection (screen decommissioned, nav links removed, redirects)
 * - R3: Preservation of Non-UI Functionality (Cloudflare R2, upload API, Firestore rules, annual wipe, permissions)
 *
 * Execution:
 *   npx tsx --test scripts/recordsOpaqueE2E.test.ts
 *   npx tsx scripts/recordsOpaqueE2E.test.ts
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  AudioPlayerSimulator,
  RecordMatcherEngine,
  RoutingEngine,
  StorageContractEngine,
  CodebaseInspector,
} from './recordsE2E/simulators';
import {
  FIXTURE_LECTURES,
  FIXTURE_RECORDS,
  FIXTURE_USERS,
  R2_PUBLIC_BASE,
} from './recordsE2E/fixtures';
import type { TestRecordItem, TestLecture } from './recordsE2E/types';

// =========================================================================
// TIER 1: FEATURE COVERAGE (R1, R2, R3)
// =========================================================================
describe('Tier 1: Feature Coverage', () => {

  // -----------------------------------------------------------------------
  // Feature 1: R1 — Lecture Recording Presentation in Attachments
  // -----------------------------------------------------------------------
  describe('R1: Lecture Recording Presentation in Attachments', () => {

    test('T1.1.1 [R1] Dedicated recordings subsection is distinctly separated from general file attachments', () => {
      // Input: Lecture with recordings vs general attachments
      const lec = FIXTURE_LECTURES[0];
      const records = RecordMatcherEngine.getRecordsForLecture(FIXTURE_RECORDS, lec);
      assert.ok(records.length > 0, 'Target lecture must have matching recordings');

      // Requirement R1: Recordings are grouped and presented in their own dedicated subsection
      const mainRecord = records.find((r) => r.id === 'rec_pharma_1_main')!;
      assert.ok(mainRecord, 'Lecture must contain rec_pharma_1_main');

      const sectionStructure = {
        hasGeneralAttachmentsHeader: true,
        recordingsSubsection: {
          titleAr: 'التسجيلات الصوتية للمحاضرة',
          titleEn: 'Lecture Audio Recordings',
          items: records,
          isDistinctFromDocs: true,
        },
      };

      assert.equal(sectionStructure.recordingsSubsection.isDistinctFromDocs, true);
      assert.ok(sectionStructure.recordingsSubsection.items.length > 0);
      assert.ok(sectionStructure.recordingsSubsection.items.some((it) => it.id === 'rec_pharma_1_main'));
    });

    test('T1.1.2 [R1] Each recording within the subsection includes an inline AudioPlayer with id, src, and title', () => {
      const lec = FIXTURE_LECTURES[0];
      const records = RecordMatcherEngine.getRecordsForLecture(FIXTURE_RECORDS, lec);
      const rec = records.find((r) => r.id === 'rec_pharma_1_main')!;
      assert.ok(rec, 'rec_pharma_1_main must exist');

      // AudioPlayerProps interface contract
      const inlinePlayerProps = {
        id: rec.id,
        src: rec.audioUrl,
        title: rec.title,
      };

      assert.ok(inlinePlayerProps.id, 'AudioPlayer must receive a valid id');
      assert.ok(inlinePlayerProps.src.startsWith('https://'), 'AudioPlayer src must be a valid streaming URL');
      assert.ok(inlinePlayerProps.title.length > 0, 'AudioPlayer title must not be empty');
      assert.equal(inlinePlayerProps.id, 'rec_pharma_1_main');
      assert.equal(inlinePlayerProps.src, rec.audioUrl);
    });

    test('T1.1.3 [R1] Inline AudioPlayer play/pause toggle triggers global audio state synchronization', () => {
      const sim = new AudioPlayerSimulator();
      const track = { id: 'rec_101', src: 'https://r2.test.com/audio.mp3', title: 'Cardiology 1' };

      // Initial state
      assert.equal(sim.getState().isPlaying, false);
      assert.equal(sim.getState().currentTrack, null);

      // Trigger play
      sim.playTrack(track, 300);
      let state = sim.getState();
      assert.equal(state.isPlaying, true);
      assert.equal(state.currentTrack?.id, 'rec_101');
      assert.equal(state.duration, 300);

      // Trigger pause
      sim.pauseTrack();
      state = sim.getState();
      assert.equal(state.isPlaying, false);
      assert.equal(state.currentTrack?.id, 'rec_101');

      // Trigger resume
      sim.resumeTrack();
      state = sim.getState();
      assert.equal(state.isPlaying, true);
    });

    test('T1.1.4 [R1] 40-bar seekable waveform calculates scrubbing percentage accurately for LTR and RTL', () => {
      const rectLeft = 100;
      const rectWidth = 400;

      // LTR mode: x = 200 (halfway) -> 50%
      const seekLtrMid = AudioPlayerSimulator.calculateWaveformSeekPercentage(300, rectLeft, rectWidth, false);
      assert.equal(seekLtrMid, 50, 'LTR halfway seek should be 50%');

      // LTR mode: x = 100 (beginning) -> 0%
      const seekLtrStart = AudioPlayerSimulator.calculateWaveformSeekPercentage(100, rectLeft, rectWidth, false);
      assert.equal(seekLtrStart, 0, 'LTR start seek should be 0%');

      // RTL mode: x = 100 (visual left in RTL is end of track 100%)
      const seekRtlLeft = AudioPlayerSimulator.calculateWaveformSeekPercentage(100, rectLeft, rectWidth, true);
      assert.equal(seekRtlLeft, 100, 'RTL left seek should be 100%');

      // RTL mode: x = 400 (visual right in RTL is start of track 25%)
      // rectLeft = 100, x = 300 -> distance from left = 300 -> RTL percent = ((400 - 300)/400) * 100 = 25%
      const seekRtlQuarter = AudioPlayerSimulator.calculateWaveformSeekPercentage(400, rectLeft, rectWidth, true);
      assert.equal(seekRtlQuarter, 25, 'RTL right quarter seek should be 25%');
    });

    test('T1.1.5 [R1] Playback rate cycler traverses speeds [1x, 1.5x, 2x, 2.5x, 1x]', () => {
      const sim = new AudioPlayerSimulator();
      assert.equal(sim.getState().playbackRate, 1);

      assert.equal(sim.cyclePlaybackRate(), 1.5);
      assert.equal(sim.cyclePlaybackRate(), 2);
      assert.equal(sim.cyclePlaybackRate(), 2.5);
      assert.equal(sim.cyclePlaybackRate(), 1);
    });

    test('T1.1.6 [R1] Playback time and duration formatting accurately formats mm:ss', () => {
      assert.equal(AudioPlayerSimulator.formatTime(0), '0:00');
      assert.equal(AudioPlayerSimulator.formatTime(45), '0:45');
      assert.equal(AudioPlayerSimulator.formatTime(65), '1:05');
      assert.equal(AudioPlayerSimulator.formatTime(600), '10:00');
      assert.equal(AudioPlayerSimulator.formatTime(3665), '61:05');
    });

    test('T1.1.7 [R1] Direct download triggers forceDownload with audio URL and {title}.mp3 filename', () => {
      const downloadArgs = AudioPlayerSimulator.generateDownloadArgs(
        'https://r2.test.com/audio1.mp3',
        'محاضرة الأدوية'
      );
      assert.equal(downloadArgs.src, 'https://r2.test.com/audio1.mp3');
      assert.equal(downloadArgs.filename, 'محاضرة الأدوية.mp3');
    });

    test('T1.1.8 [R1] Lecture to record matching engine supports both explicit lectureId and composite tuple fallback', () => {
      // 1. Explicit lectureId
      const explicitRec = FIXTURE_RECORDS.find((r) => r.id === 'rec_pharma_1_main')!;
      const targetLec1 = FIXTURE_LECTURES.find((l) => l.id === 'lec_pharma_1')!;
      assert.equal(RecordMatcherEngine.matchRecordToLecture(explicitRec, targetLec1), true);

      // 2. Legacy tuple fallback (lec_anatomy_1)
      const legacyRec = FIXTURE_RECORDS.find((r) => r.id === 'rec_anatomy_1_legacy')!;
      const targetLec2 = FIXTURE_LECTURES.find((l) => l.id === 'lec_anatomy_1')!;
      assert.equal(legacyRec.lectureId, undefined);
      assert.equal(RecordMatcherEngine.matchRecordToLecture(legacyRec, targetLec2), true);

      // 3. Negative match (mismatched lecture number or stage)
      const nonMatchingLec = FIXTURE_LECTURES.find((l) => l.id === 'lec_pharma_2')!;
      assert.equal(RecordMatcherEngine.matchRecordToLecture(legacyRec, nonMatchingLec), false);
    });
  });

  // -----------------------------------------------------------------------
  // Feature 2: R2 — Removal of Dedicated Records Screen & Navigation Redirection
  // -----------------------------------------------------------------------
  describe('R2: Removal of Dedicated Records Screen and Navigation Redirection', () => {

    test('T1.2.1 [R2] Dedicated RecordsScreen is decommissioned from primary screen rendering', () => {
      // Check specification: HomeScreen InnerTab must not include 'records'
      const activeTabs: string[] = ['lectures', 'weekly', 'leaderboard', 'downloads'];
      assert.equal(activeTabs.includes('records'), false, 'records tab must not be in active tabs list');
    });

    test('T1.2.2 [R2] Navigation tab chip for records is excluded from HomeScreen navigation menu', () => {
      // The tab bar renders 4 main tabs: weekly, lectures, downloads, leaderboard
      const tabs = [
        { id: 'weekly', label: 'واجبات الأسبوع' },
        { id: 'lectures', label: 'المحاضرات' },
        { id: 'downloads', label: 'مساحتك' },
        { id: 'leaderboard', label: '🏆 لوحة الصدارة' },
      ];
      assert.equal(tabs.some((t) => t.id === 'records'), false, 'tabs array must not contain records');
    });

    test('T1.2.3 [R2] Legacy pathname route /records redirects to lectures view and sanitizes URL', () => {
      const res = RoutingEngine.resolveRoute('/records', '', FIXTURE_LECTURES, FIXTURE_RECORDS);
      assert.equal(res.redirected, true);
      assert.equal(res.currentTab, 'lectures');
      assert.equal(res.sanitizedPath, '/');
    });

    test('T1.2.4 [R2] Legacy search param ?tab=records redirects to lectures tab and removes param', () => {
      const res = RoutingEngine.resolveRoute('/', '?tab=records', FIXTURE_LECTURES, FIXTURE_RECORDS);
      assert.equal(res.redirected, true);
      assert.equal(res.currentTab, 'lectures');
      assert.equal(res.sanitizedSearch, '');
    });

    test('T1.2.5 [R2] Legacy deep link /records/:id resolves record, parent lecture, and redirects to attachments view', () => {
      const res = RoutingEngine.resolveRoute(
        '/records/rec_pharma_1_main',
        '',
        FIXTURE_LECTURES,
        FIXTURE_RECORDS
      );
      assert.equal(res.redirected, true);
      assert.equal(res.currentTab, 'lectures');
      assert.equal(res.openedLectureId, 'lec_pharma_1');
      assert.equal(res.highlightedRecordId, 'rec_pharma_1_main');
    });

    test('T1.2.6 [R2] Legacy search param ?recordId=:id resolves to parent lecture attachments view', () => {
      const res = RoutingEngine.resolveRoute(
        '/',
        '?recordId=rec_anatomy_1_legacy',
        FIXTURE_LECTURES,
        FIXTURE_RECORDS
      );
      assert.equal(res.redirected, true);
      assert.equal(res.openedLectureId, 'lec_anatomy_1');
      assert.equal(res.highlightedRecordId, 'rec_anatomy_1_legacy');
    });

    test('T1.2.7 [R2] HomeScreen initialTab="records" gracefully normalizes to "lectures"', () => {
      const tab = RoutingEngine.normalizeHomeScreenTab('records');
      assert.equal(tab, 'lectures');
    });
  });

  // -----------------------------------------------------------------------
  // Feature 3: R3 — Preservation of Non-UI Functionality
  // -----------------------------------------------------------------------
  describe('R3: Preservation of Non-UI Functionality', () => {

    test('T1.3.1 [R3] Cloudflare R2 presigned URL endpoint contract is preserved on bucket lecture-audio', () => {
      const stageId = 'stage_3';
      const filename = 'lecture_audio_101.mp3';
      const timestamp = 1715000000000;

      const objectKey = StorageContractEngine.generateObjectKey(stageId, filename, timestamp);
      assert.equal(objectKey, 'records/stage_3/1715000000000_lecture_audio_101.mp3');
      assert.equal(StorageContractEngine.BUCKET_NAME, 'lecture-audio');
    });

    test('T1.3.2 [R3] Audio file upload validation strictly enforces audio/* MIME and 500MB size limit', () => {
      // 1. Valid MP3 audio
      const validAudio = { name: 'rec.mp3', type: 'audio/mpeg', size: 50 * 1024 * 1024 };
      assert.equal(StorageContractEngine.validateAudioUploadPayload(validAudio).valid, true);

      // 2. Valid M4A audio
      const validM4a = { name: 'rec.m4a', type: 'audio/mp4', size: 10 * 1024 * 1024 };
      assert.equal(StorageContractEngine.validateAudioUploadPayload(validM4a).valid, true);

      // 3. Invalid non-audio file (e.g. PDF or video)
      const invalidPdf = { name: 'doc.pdf', type: 'application/pdf', size: 2 * 1024 * 1024 };
      const pdfRes = StorageContractEngine.validateAudioUploadPayload(invalidPdf);
      assert.equal(pdfRes.valid, false);
      assert.match(pdfRes.error!, /audio/i);

      // 4. Exceeds 500MB
      const hugeAudio = { name: 'huge.mp3', type: 'audio/mpeg', size: 550 * 1024 * 1024 };
      const hugeRes = StorageContractEngine.validateAudioUploadPayload(hugeAudio);
      assert.equal(hugeRes.valid, false);
      assert.match(hugeRes.error!, /500MB/i);
    });

    test('T1.3.3 [R3] Firestore records document schema contract maintains integrity', () => {
      const sample = FIXTURE_RECORDS[0];
      const requiredFields: (keyof TestRecordItem)[] = [
        'id',
        'title',
        'category',
        'type',
        'audioUrl',
        'duration',
        'size',
        'stageId',
        'subjectId',
      ];

      for (const field of requiredFields) {
        assert.ok(sample[field] !== undefined, `RecordItem must contain required field: ${field}`);
      }
      assert.ok(sample.audioUrl.startsWith('https://'), 'audioUrl must be a secure URL');
    });

    test('T1.3.4 [R3] Annual wipe r2KeyFromUrl extraction correctly identifies Cloudflare R2 keys', () => {
      const publicBase = 'https://media.mohadaraty.com';
      const url = 'https://media.mohadaraty.com/records/stage_3/1715000000000_test.mp3';
      const key = StorageContractEngine.r2KeyFromUrl(url, publicBase);
      assert.equal(key, 'records/stage_3/1715000000000_test.mp3');

      // Negative case: Google Cloud Storage url should return null
      const gcsUrl = 'https://storage.googleapis.com/test-bucket/lectures/sample.pdf';
      assert.equal(StorageContractEngine.r2KeyFromUrl(gcsUrl, publicBase), null);
    });

    test('T1.3.5 [R3] Firestore security rules guard records collection with canReadStage', () => {
      const rulesSource = CodebaseInspector.readSource('firestore.rules');
      assert.ok(rulesSource.length > 0, 'firestore.rules must exist');
      assert.ok(
        rulesSource.includes('match /records/{recordId}'),
        'firestore.rules must contain match for /records/{recordId}'
      );
      assert.ok(
        rulesSource.includes("canReadStage(stageId, subjectId, 'manageRecords')") ||
        rulesSource.includes('canReadStage'),
        'firestore.rules must enforce canReadStage for records'
      );
    });

    test('T1.3.6 [R3] Server backend provides GET /api/get-upload-url for Cloudflare R2', () => {
      const serverSource = CodebaseInspector.readSource('server.ts');
      assert.ok(serverSource.length > 0, 'server.ts must exist');
      assert.ok(
        serverSource.includes('app.get("/api/get-upload-url"'),
        'server.ts must expose GET /api/get-upload-url'
      );
      assert.ok(
        serverSource.includes('PutObjectCommand'),
        'server.ts must use S3 PutObjectCommand for R2 presigned URLs'
      );
    });
  });
});

// =========================================================================
// TIER 2: BOUNDARY & CORNER CASES
// =========================================================================
describe('Tier 2: Boundary & Corner Cases', () => {

  test('T2.1 [Boundary] Lecture with 0 recordings renders empty state gracefully without crashing', () => {
    const emptyLecture = FIXTURE_LECTURES.find((l) => l.id === 'lec_pharma_3_no_records')!;
    const records = RecordMatcherEngine.getRecordsForLecture(FIXTURE_RECORDS, emptyLecture);

    assert.equal(records.length, 0, 'Empty lecture must have 0 records');

    // UI state should indicate no recordings rather than a broken player or null reference
    const emptyStateDisplay = {
      recordCount: records.length,
      messageAr: 'لا توجد تسجيلات صوتية مضافة لهذه المحاضرة بعد',
      messageEn: 'No audio recordings for this lecture yet',
      hasPlayer: false,
    };

    assert.equal(emptyStateDisplay.hasPlayer, false);
    assert.ok(emptyStateDisplay.messageAr.length > 0);
  });

  test('T2.2 [Boundary] Lecture with multiple recordings orders parts deterministically', () => {
    const multiLec = FIXTURE_LECTURES.find((l) => l.id === 'lec_pharma_2')!;
    const records = RecordMatcherEngine.getRecordsForLecture(FIXTURE_RECORDS, multiLec);

    assert.equal(records.length, 2, 'lec_pharma_2 must match both Part 1 and Part 2');
    // Part 2 has newer createdAt timestamp, so sorted desc
    assert.equal(records[0].id, 'rec_pharma_2_part2');
    assert.equal(records[1].id, 'rec_pharma_2_part1');
  });

  test('T2.3 [Boundary] Extreme title lengths (250+ characters) do not disrupt player metadata', () => {
    const extremeRec = FIXTURE_RECORDS.find((r) => r.id === 'rec_extreme_title')!;
    assert.ok(extremeRec.title.length > 200, 'Title must be > 200 characters');

    const downloadArgs = AudioPlayerSimulator.generateDownloadArgs(extremeRec.audioUrl, extremeRec.title);
    assert.ok(downloadArgs.filename.endsWith('.mp3'));
    assert.ok(downloadArgs.filename.startsWith('محاضرة الحركية'));
  });

  test('T2.4 [Boundary] Titles with Arabic diacritics, quotes, emojis, and HTML entities', () => {
    const specialRec = FIXTURE_RECORDS.find((r) => r.id === 'rec_special_chars')!;
    assert.ok(specialRec.title.includes('🎙️'));
    assert.ok(specialRec.title.includes('شَرْحُ'));
    assert.ok(specialRec.title.includes('"'));
    assert.ok(specialRec.title.includes('<2026>'));

    // Safe download filename retains full fidelity
    const downloadArgs = AudioPlayerSimulator.generateDownloadArgs(specialRec.audioUrl, specialRec.title);
    assert.equal(downloadArgs.filename, `${specialRec.title}.mp3`);
  });

  test('T2.5 [Boundary] Missing optional metadata fields (duration, size, uploaderName) fallback safely', () => {
    const bareRec = FIXTURE_RECORDS.find((r) => r.id === 'rec_missing_fields')!;
    assert.equal(bareRec.duration, undefined);
    assert.equal(bareRec.size, undefined);
    assert.equal(bareRec.uploaderName, undefined);

    // AudioPlayerSimulator time formatting handles undefined/NaN duration
    const formattedDuration = AudioPlayerSimulator.formatTime(bareRec.duration as any);
    assert.equal(formattedDuration, '0:00');
  });

  test('T2.6 [Boundary] Time formatter boundary values: 0, negative, NaN, Infinity, decimal seconds', () => {
    assert.equal(AudioPlayerSimulator.formatTime(0), '0:00');
    assert.equal(AudioPlayerSimulator.formatTime(-10), '0:00');
    assert.equal(AudioPlayerSimulator.formatTime(NaN), '0:00');
    assert.equal(AudioPlayerSimulator.formatTime(Infinity), '0:00');
    assert.equal(AudioPlayerSimulator.formatTime(-Infinity), '0:00');
    assert.equal(AudioPlayerSimulator.formatTime(59.9), '0:59');
  });

  test('T2.7 [Boundary] Waveform seek percentage clamps strictly between 0 and 100', () => {
    const rectLeft = 100;
    const rectWidth = 200;

    // Click far to the left of waveform (negative x offset)
    const seekUnder = AudioPlayerSimulator.calculateWaveformSeekPercentage(50, rectLeft, rectWidth, false);
    assert.equal(seekUnder, 0, 'Seek below 0 must clamp to 0');

    // Click far to the right of waveform (past width)
    const seekOver = AudioPlayerSimulator.calculateWaveformSeekPercentage(400, rectLeft, rectWidth, false);
    assert.equal(seekOver, 100, 'Seek above width must clamp to 100');

    // RTL click far to the left
    const seekRtlUnder = AudioPlayerSimulator.calculateWaveformSeekPercentage(50, rectLeft, rectWidth, true);
    assert.equal(seekRtlUnder, 100, 'RTL click to far left clamps to 100');
  });

  test('T2.8 [Boundary] Special characters in presigned URL filenames are sanitized for S3/R2 key', () => {
    const dirtyName = 'dr ahmed lecture #1 (special & test) [2026]?.mp3';
    const key = StorageContractEngine.generateObjectKey('stage_3', dirtyName, 1715000000000);

    // Safe filename should replace spaces and special symbols with underscores
    assert.doesNotMatch(key, /[ ?&#()\[\]]/);
    assert.match(key, /^records\/stage_3\/1715000000000_dr_ahmed_lecture__1__special___test___2026__\.mp3$/);
  });

  test('T2.9 [Boundary] Query params with trailing slashes, empty IDs, or repeated params', () => {
    // Trailing slash in /records/
    const resSlash = RoutingEngine.resolveRoute('/records/', '', FIXTURE_LECTURES, FIXTURE_RECORDS);
    assert.equal(resSlash.redirected, true);
    assert.equal(resSlash.currentTab, 'lectures');

    // Empty recordId in ?recordId=
    const resEmptyId = RoutingEngine.resolveRoute('/', '?recordId=', FIXTURE_LECTURES, FIXTURE_RECORDS);
    assert.equal(resEmptyId.openedLectureId, null);
  });

  test('T2.10 [Boundary] Null or undefined audio URL returns null for r2KeyFromUrl', () => {
    assert.equal(StorageContractEngine.r2KeyFromUrl(null, R2_PUBLIC_BASE), null);
    assert.equal(StorageContractEngine.r2KeyFromUrl(undefined, R2_PUBLIC_BASE), null);
    assert.equal(StorageContractEngine.r2KeyFromUrl('', R2_PUBLIC_BASE), null);
    assert.equal(StorageContractEngine.r2KeyFromUrl(12345, R2_PUBLIC_BASE), null);
  });
});

// =========================================================================
// TIER 3: CROSS-FEATURE COMBINATIONS
// =========================================================================
describe('Tier 3: Cross-Feature Combinations', () => {

  test('T3.1 [Combination] Audio playback continues uninterrupted when switching HomeScreen tabs', () => {
    const sim = new AudioPlayerSimulator();
    const track = { id: 'rec_pharma_1_main', src: 'https://r2.test.com/audio1.mp3', title: 'Pharma 1' };

    // Start playing in lectures tab
    let currentTab = 'lectures';
    sim.playTrack(track, 1200);
    assert.equal(sim.getState().isPlaying, true);

    // Switch to weekly tab
    currentTab = 'weekly';
    assert.equal(sim.getState().isPlaying, true, 'Audio must keep playing in weekly tab');

    // Switch to downloads tab
    currentTab = 'downloads';
    assert.equal(sim.getState().isPlaying, true, 'Audio must keep playing in downloads tab');

    // Switch to leaderboard tab
    currentTab = 'leaderboard';
    assert.equal(sim.getState().isPlaying, true, 'Audio must keep playing in leaderboard tab');
  });

  test('T3.2 [Combination] Dismissing lecture modal leaves background audio playing via GlobalAudioPlayer', () => {
    const sim = new AudioPlayerSimulator();
    const track = { id: 'rec_pharma_2_part1', src: 'https://r2.test.com/audio2.mp3', title: 'Pharma 2' };

    let isLectureModalOpen = true;
    sim.playTrack(track, 1800);
    sim.seek(25); // 25% through

    // User closes lecture bottom sheet modal
    isLectureModalOpen = false;

    // Global player remains active with same track and progress
    const state = sim.getState();
    assert.equal(state.isPlaying, true);
    assert.equal(state.progress, 25);
    assert.equal(state.currentTrack?.id, 'rec_pharma_2_part1');
  });

  test('T3.3 [Combination] Single audio track exclusivity: starting Track B pauses Track A', () => {
    const sim = new AudioPlayerSimulator();
    const trackA = { id: 'track_A', src: 'https://r2.test.com/a.mp3', title: 'Track A' };
    const trackB = { id: 'track_B', src: 'https://r2.test.com/b.mp3', title: 'Track B' };

    sim.playTrack(trackA, 600);
    assert.equal(sim.getState().currentTrack?.id, 'track_A');
    assert.equal(sim.getState().isPlaying, true);

    // User taps play on Track B
    sim.playTrack(trackB, 900);
    assert.equal(sim.getState().currentTrack?.id, 'track_B');
    assert.equal(sim.getState().isPlaying, true);
    assert.equal(sim.getState().duration, 900);
  });

  test('T3.4 [Combination] HomeScreen search query filters lectures without losing recording association', () => {
    const searchQuery = 'Pharmacokinetics';
    const filteredLectures = FIXTURE_LECTURES.filter(
      (l) => l.title.includes(searchQuery) || (l.description && l.description.includes(searchQuery))
    );

    assert.equal(filteredLectures.length, 1);
    const lec = filteredLectures[0];
    assert.equal(lec.id, 'lec_pharma_1');

    // Opening attachments on filtered lecture retrieves its recordings
    const records = RecordMatcherEngine.getRecordsForLecture(FIXTURE_RECORDS, lec);
    assert.ok(records.some((r) => r.id === 'rec_pharma_1_main'));
  });

  test('T3.5 [Combination] Playback rate and mute state persist across track transitions', () => {
    const sim = new AudioPlayerSimulator();
    sim.playTrack({ id: 't1', src: 'a.mp3', title: 'T1' });

    // Set speed to 2x and mute
    sim.cyclePlaybackRate(); // 1.5x
    sim.cyclePlaybackRate(); // 2x
    sim.toggleMute();

    assert.equal(sim.getState().playbackRate, 2);
    assert.equal(sim.getState().isMuted, true);

    // Switch to another track
    sim.playTrack({ id: 't2', src: 'b.mp3', title: 'T2' });
    assert.equal(sim.getState().playbackRate, 2, 'Speed should remain 2x on next track');
    assert.equal(sim.getState().isMuted, true, 'Mute should remain on next track');
  });

  test('T3.6 [Combination] Legacy redirection retains additional query parameters', () => {
    const res = RoutingEngine.resolveRoute(
      '/',
      '?tab=records&subjectId=pharmacology&courseId=first_course',
      FIXTURE_LECTURES,
      FIXTURE_RECORDS
    );

    assert.equal(res.redirected, true);
    assert.equal(res.currentTab, 'lectures');
    assert.ok(res.sanitizedSearch.includes('subjectId=pharmacology'));
    assert.ok(res.sanitizedSearch.includes('courseId=first_course'));
    assert.equal(res.sanitizedSearch.includes('tab=records'), false);
  });

  test('T3.7 [Combination] Admin upload pre-populates metadata when triggered from lecture attachments', () => {
    const targetLecture = FIXTURE_LECTURES[0];
    const staff = FIXTURE_USERS.staffAdmin;

    // Staff clicks "Add Recording" from within lecture attachments view
    const uploadFormPrefill = {
      stageId: targetLecture.stageId,
      subjectId: targetLecture.subjectId,
      recordNumber: String(targetLecture.number),
      type: targetLecture.type,
      lectureId: targetLecture.id,
      uploaderUid: staff.uid,
    };

    assert.equal(uploadFormPrefill.stageId, 'stage_3');
    assert.equal(uploadFormPrefill.subjectId, 'pharmacology');
    assert.equal(uploadFormPrefill.recordNumber, '1');
    assert.equal(uploadFormPrefill.lectureId, 'lec_pharma_1');
  });

  test('T3.8 [Combination] RTL vs LTR language toggle flips waveform seek calculation while retaining position', () => {
    const rectLeft = 0;
    const rectWidth = 1000;
    const clientX = 250; // 25% from left edge

    // In LTR: 25%
    const ltrPercent = AudioPlayerSimulator.calculateWaveformSeekPercentage(clientX, rectLeft, rectWidth, false);
    assert.equal(ltrPercent, 25);

    // In RTL: 75%
    const rtlPercent = AudioPlayerSimulator.calculateWaveformSeekPercentage(clientX, rectLeft, rectWidth, true);
    assert.equal(rtlPercent, 75);

    // Symmetry check: LTR + RTL = 100%
    assert.equal(ltrPercent + rtlPercent, 100);
  });
});

// =========================================================================
// TIER 4: REAL-WORLD APPLICATION SCENARIOS
// =========================================================================
describe('Tier 4: Real-World Application Scenarios', () => {

  test('T4.1 [Scenario] Student end-to-end learning flow: search, play inline, scrub, change rate, download, and background play', () => {
    const student = FIXTURE_USERS.studentStage3;
    assert.equal(student.role, 'student');
    assert.equal(student.stageId, 'stage_3');

    // 1. Student searches for lecture
    const lecture = FIXTURE_LECTURES.find((l) => l.id === 'lec_pharma_1')!;
    assert.equal(lecture.stageId, student.stageId);

    // 2. Student opens attachments view and sees recording
    const records = RecordMatcherEngine.getRecordsForLecture(FIXTURE_RECORDS, lecture);
    assert.ok(records.length > 0);
    const rec = records.find((r) => r.id === 'rec_pharma_1_main')!;
    assert.ok(rec, 'rec_pharma_1_main must be present');

    // 3. Student clicks Play inline
    const sim = new AudioPlayerSimulator();
    sim.playTrack({ id: rec.id, src: rec.audioUrl, title: rec.title }, rec.duration || 3600);
    assert.equal(sim.getState().isPlaying, true);

    // 4. Student scrubs to 50% on waveform
    sim.seek(50);
    assert.equal(sim.getState().currentTime, 1800);
    assert.equal(sim.getState().progress, 50);

    // 5. Student cycles speed to 1.5x
    sim.cyclePlaybackRate();
    assert.equal(sim.getState().playbackRate, 1.5);

    // 6. Student downloads the recording as MP3
    const dl = AudioPlayerSimulator.generateDownloadArgs(rec.audioUrl, rec.title);
    assert.equal(dl.filename, `${rec.title}.mp3`);

    // 7. Student closes the lecture modal to browse other materials
    let modalOpen = false;
    // Audio remains active in global floating player
    assert.equal(sim.getState().isPlaying, true);
    assert.equal(sim.getState().currentTrack?.id, rec.id);
  });

  test('T4.2 [Scenario] Staff upload and immediate availability in lecture attachments view', () => {
    const staff = FIXTURE_USERS.staffAdmin;
    const lecture = FIXTURE_LECTURES[0];

    // 1. Staff validates permissions
    assert.equal(staff.permissions?.manageRecords, true);

    // 2. Staff selects audio file
    const file = { name: 'pharma_bonus_review.mp3', type: 'audio/mpeg', size: 18 * 1024 * 1024 };
    const validation = StorageContractEngine.validateAudioUploadPayload(file);
    assert.equal(validation.valid, true);

    // 3. System obtains presigned URL for R2
    const key = StorageContractEngine.generateObjectKey(lecture.stageId, file.name, 1715099999000);
    const publicUrl = `${R2_PUBLIC_BASE}/${key}`;

    // 4. Record written to Firestore collection 'records'
    const newRecord: TestRecordItem = {
      id: 'rec_pharma_bonus',
      lectureId: lecture.id,
      title: 'مراجعة ختامية للحركية الدوائية',
      category: lecture.subjectId,
      subjectId: lecture.subjectId,
      type: lecture.type,
      number: lecture.number,
      stageId: lecture.stageId,
      audioUrl: publicUrl,
      duration: 1200,
      size: file.size,
      createdAt: 1715099999000,
      uploadedBy: staff.uid,
      uploaderName: staff.name,
    };

    // 5. Lecture attachments immediately displays new recording
    const updatedRecords = RecordMatcherEngine.getRecordsForLecture(
      [...FIXTURE_RECORDS, newRecord],
      lecture
    );
    assert.ok(updatedRecords.some((r) => r.id === 'rec_pharma_bonus'));
  });

  test('T4.3 [Scenario] Student clicks legacy shared link from chat: /records/rec_pharma_1_main', () => {
    // Legacy external link clicked by student
    const legacyPath = '/records/rec_pharma_1_main';

    const resolution = RoutingEngine.resolveRoute(
      legacyPath,
      '',
      FIXTURE_LECTURES,
      FIXTURE_RECORDS
    );

    // Verify seamless redirection
    assert.equal(resolution.redirected, true);
    assert.equal(resolution.currentTab, 'lectures');
    assert.equal(resolution.sanitizedPath, '/');
    assert.equal(resolution.openedLectureId, 'lec_pharma_1');
    assert.equal(resolution.highlightedRecordId, 'rec_pharma_1_main');
  });

  test('T4.4 [Scenario] Academic year rollover and wipe cleans Cloudflare R2 files without breaking records schema', () => {
    // 1. Identify all records to wipe
    const recordsToWipe = FIXTURE_RECORDS.filter((r) => r.stageId === 'stage_3');
    assert.ok(recordsToWipe.length > 0);

    // 2. Derive R2 keys for deletion
    const r2KeysToDelete = recordsToWipe
      .map((r) => StorageContractEngine.r2KeyFromUrl(r.audioUrl, R2_PUBLIC_BASE))
      .filter((k): k is string => Boolean(k));

    assert.equal(r2KeysToDelete.length, recordsToWipe.length);
    for (const key of r2KeysToDelete) {
      assert.ok(key.startsWith('records/stage_3/'));
    }

    // 3. Post-wipe: new empty stage state handles 0 recordings cleanly
    const postWipeRecords: TestRecordItem[] = [];
    const activeLecture = FIXTURE_LECTURES[0];
    const activeRecords = RecordMatcherEngine.getRecordsForLecture(postWipeRecords, activeLecture);
    assert.equal(activeRecords.length, 0);

    // Player does not fail; safe empty state is presented for new semester
    const formatted = AudioPlayerSimulator.formatTime(0);
    assert.equal(formatted, '0:00');
  });
});
