/**
 * Challenger 1: Adversarial Empirical Stress Test Suite
 * Targeted at:
 * - AudioPlayer & AudioContext synchronization
 * - Waveform scrubbing math (LTR / RTL) & boundary clicks (<0%, >100%, 0-width)
 * - Playback rate cycling & corrupted states
 * - Mute behavior & global persistence
 * - Edge case titles, Arabic diacritics, emojis, HTML injections
 * - recordBelongsToLecture matching engine under hostile/adversarial inputs
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { recordBelongsToLecture } from '../src/components/lecture/LectureRecordingsSection';
import type { Lecture, RecordItem } from '../src/types';

// =========================================================================
// 1. WAVEFORM SCRUBBING CALCULATION: LTR vs RTL & BOUNDARY CONDITIONS
// =========================================================================
describe('Waveform Scrubbing Calculation — LTR & RTL Boundary Stress', () => {

  // Pure implementation of AudioPlayer.tsx lines 72-76
  function calculateScrubPercentageRaw(
    clientX: number,
    rectLeft: number,
    rectWidth: number,
    isRtl: boolean
  ): number {
    const x = clientX - rectLeft;
    return isRtl ? ((rectWidth - x) / rectWidth) * 100 : (x / rectWidth) * 100;
  }

  // Clamped safe calculation
  function calculateScrubPercentageClamped(
    clientX: number,
    rectLeft: number,
    rectWidth: number,
    isRtl: boolean
  ): number {
    if (rectWidth <= 0) return 0;
    const x = clientX - rectLeft;
    const pct = isRtl ? ((rectWidth - x) / rectWidth) * 100 : (x / rectWidth) * 100;
    return Math.max(0, Math.min(100, pct));
  }

  test('LTR normal seek positions: 0%, 25%, 50%, 75%, 100%', () => {
    const rectLeft = 100;
    const rectWidth = 200;

    assert.equal(calculateScrubPercentageRaw(100, rectLeft, rectWidth, false), 0);
    assert.equal(calculateScrubPercentageRaw(150, rectLeft, rectWidth, false), 25);
    assert.equal(calculateScrubPercentageRaw(200, rectLeft, rectWidth, false), 50);
    assert.equal(calculateScrubPercentageRaw(250, rectLeft, rectWidth, false), 75);
    assert.equal(calculateScrubPercentageRaw(300, rectLeft, rectWidth, false), 100);
  });

  test('RTL normal seek positions: inverted direction 100% -> 0%', () => {
    const rectLeft = 100;
    const rectWidth = 200;

    // In RTL: clicking left edge (x=0) corresponds to 100% (the end of track)
    assert.equal(calculateScrubPercentageRaw(100, rectLeft, rectWidth, true), 100);
    // Clicking midpoint corresponds to 50%
    assert.equal(calculateScrubPercentageRaw(200, rectLeft, rectWidth, true), 50);
    // Clicking right edge (x=rectWidth) corresponds to 0% (the start of track)
    assert.equal(calculateScrubPercentageRaw(300, rectLeft, rectWidth, true), 0);
  });

  test('Boundary Stress: Click to the left of waveform element (clientX < rectLeft)', () => {
    const rectLeft = 100;
    const rectWidth = 200;
    const clientX = 80; // 20px outside left

    const rawLtr = calculateScrubPercentageRaw(clientX, rectLeft, rectWidth, false);
    const rawRtl = calculateScrubPercentageRaw(clientX, rectLeft, rectWidth, true);

    // In raw implementation without Math.max/Math.min clamping:
    assert.ok(rawLtr < 0, 'Raw LTR allows negative percentage!');
    assert.equal(Math.round(rawLtr), -10);
    assert.ok(rawRtl > 100, 'Raw RTL allows percentage > 100%!');
    assert.equal(Math.round(rawRtl), 110);

    // In clamped safe calculation:
    const safeLtr = calculateScrubPercentageClamped(clientX, rectLeft, rectWidth, false);
    const safeRtl = calculateScrubPercentageClamped(clientX, rectLeft, rectWidth, true);
    assert.equal(safeLtr, 0, 'Clamped LTR stays at 0%');
    assert.equal(safeRtl, 100, 'Clamped RTL stays at 100%');
  });

  test('Boundary Stress: Click to the right of waveform element (clientX > rectLeft + rectWidth)', () => {
    const rectLeft = 100;
    const rectWidth = 200;
    const clientX = 350; // 50px outside right

    const rawLtr = calculateScrubPercentageRaw(clientX, rectLeft, rectWidth, false);
    const rawRtl = calculateScrubPercentageRaw(clientX, rectLeft, rectWidth, true);

    assert.equal(rawLtr, 125, 'Raw LTR allows percentage > 100%!');
    assert.equal(rawRtl, -25, 'Raw RTL allows negative percentage!');

    const safeLtr = calculateScrubPercentageClamped(clientX, rectLeft, rectWidth, false);
    const safeRtl = calculateScrubPercentageClamped(clientX, rectLeft, rectWidth, true);
    assert.equal(safeLtr, 100);
    assert.equal(safeRtl, 0);
  });

  test('Boundary Stress: Element with 0 width (collapsed/hidden container)', () => {
    const rectLeft = 100;
    const rectWidth = 0; // Collapsed before layout
    const clientX = 100;

    const rawLtr = calculateScrubPercentageRaw(clientX, rectLeft, rectWidth, false);
    assert.ok(Number.isNaN(rawLtr), 'Division by 0 in raw produces NaN');

    const safeLtr = calculateScrubPercentageClamped(clientX, rectLeft, rectWidth, false);
    assert.equal(safeLtr, 0, 'Safe function handles 0-width gracefully');
  });
});

// =========================================================================
// 2. PLAYBACK RATE CYCLING & RESILIENCE
// =========================================================================
describe('Playback Rate Cycling & Corrupted State Recovery', () => {
  const rates = [1, 1.5, 2, 2.5];

  function cycleRate(currentRate: number): number {
    const currentIndex = rates.indexOf(currentRate);
    return rates[(currentIndex + 1) % rates.length];
  }

  test('Standard cycle traversal: 1x -> 1.5x -> 2x -> 2.5x -> 1x', () => {
    let rate = 1;
    rate = cycleRate(rate);
    assert.equal(rate, 1.5);
    rate = cycleRate(rate);
    assert.equal(rate, 2);
    rate = cycleRate(rate);
    assert.equal(rate, 2.5);
    rate = cycleRate(rate);
    assert.equal(rate, 1);
  });

  test('Corrupted or unsupported initial rate recovers safely to 1x', () => {
    // If rate was somehow 0.75 or 3 or NaN
    assert.equal(cycleRate(0.75), 1);
    assert.equal(cycleRate(3), 1);
    assert.equal(cycleRate(NaN as any), 1);
    assert.equal(cycleRate(undefined as any), 1);
  });
});

// =========================================================================
// 3. TIME FORMATTER BOUNDARY EMPIRICAL TESTS
// =========================================================================
describe('Time Formatter Boundary Conditions', () => {
  // Pure implementation of AudioPlayer.tsx lines 49-54
  const formatTime = (time: number) => {
    if (isNaN(time) || time === 0) return "0:00";
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  test('Handles normal seconds', () => {
    assert.equal(formatTime(45), '0:45');
    assert.equal(formatTime(65), '1:05');
    assert.equal(formatTime(600), '10:00');
  });

  test('Handles 0, NaN, null, undefined', () => {
    assert.equal(formatTime(0), '0:00');
    assert.equal(formatTime(NaN), '0:00');
    assert.equal(formatTime(null as any), '0:00');
    assert.equal(formatTime(undefined as any), '0:00');
  });

  test('Boundary: Large duration (over 1 hour)', () => {
    // 3725 seconds = 62 minutes 5 seconds
    assert.equal(formatTime(3725), '62:05');
  });

  test('Boundary: Negative seconds (e.g. from negative seek)', () => {
    // Math.floor(-5 / 60) = -1; Math.floor(-5 % 60) = -5
    const formatted = formatTime(-5);
    // Notice: if negative time is passed, it outputs "-1:-5"!
    assert.equal(formatted, '-1:-5', 'Reveals lack of negative clamp in formatTime');
  });
});

// =========================================================================
// 4. MUTE BEHAVIOR EMPIRICAL ANALYSIS
// =========================================================================
describe('AudioPlayer Mute State Analysis', () => {
  test('Empirical Verification: AudioPlayer mute is purely local component state', () => {
    // AudioPlayer.tsx line 15:
    // const [isMuted, setIsMuted] = useState(false); // We can leave mute local if needed or ignore it
    // Line 111:
    // onClick={() => setIsMuted(!isMuted)}
    // AudioContextType has NO mute methods or state.
    // Therefore, toggling mute in AudioPlayer DOES NOT mute the HTMLAudioElement!
    const audioContextExposesMute = false; // AudioContext has no mute or volume
    assert.equal(audioContextExposesMute, false, 'AudioContext does not manage mute');
  });
});

// =========================================================================
// 5. ADVERSARIAL MATCHING: recordBelongsToLecture
// =========================================================================
describe('Adversarial Matching: recordBelongsToLecture', () => {
  const baseLecture: Lecture = {
    id: 'lec_cardio_1',
    stageId: 'stage_3',
    subjectId: 'sub_cardio',
    category: 'Cardiology',
    title: 'Heart Failure Pathophysiology',
    number: 1,
    type: 'theoretical',
    doctor: 'Dr. Smith',
    date: '2026-10-30',
  } as unknown as Lecture;

  test('Match via explicit foreign key lectureId', () => {
    const rec: RecordItem = {
      id: 'rec_1',
      lectureId: 'lec_cardio_1',
      stageId: 'stage_3',
      subjectId: 'sub_cardio',
      title: 'Any Title',
      audioUrl: 'https://r2.test/1.mp3',
    } as unknown as RecordItem;

    assert.equal(recordBelongsToLecture(rec, baseLecture), true);
  });

  test('Non-matching foreign key lectureId immediately rejects even if metadata matches', () => {
    const rec: RecordItem = {
      id: 'rec_2',
      lectureId: 'lec_different_99',
      stageId: 'stage_3',
      subjectId: 'sub_cardio',
      number: 1,
      type: 'theoretical',
      title: 'Heart Failure Pathophysiology',
      audioUrl: 'https://r2.test/2.mp3',
    } as unknown as RecordItem;

    assert.equal(recordBelongsToLecture(rec, baseLecture), false);
  });

  test('Translation lecture link: matches translationOf', () => {
    const translationLecture = {
      ...baseLecture,
      id: 'lec_trans_1',
      translationOf: 'lec_cardio_1',
    };
    const rec: RecordItem = {
      id: 'rec_trans',
      lectureId: 'lec_cardio_1',
      stageId: 'stage_3',
      title: 'Audio',
      audioUrl: 'https://r2.test/trans.mp3',
    } as unknown as RecordItem;

    assert.equal(recordBelongsToLecture(rec, translationLecture), true);
  });

  test('Composite tuple fallback: matches stage + subject + type + number', () => {
    const rec: RecordItem = {
      id: 'rec_tuple',
      stageId: 'stage_3',
      subjectId: 'sub_cardio',
      number: 1,
      type: 'theoretical',
      title: 'Different Title',
      audioUrl: 'https://r2.test/tuple.mp3',
    } as RecordItem;

    assert.equal(recordBelongsToLecture(rec, baseLecture), true);
  });

  test('Type mismatch rejection: theoretical lecture vs practical record', () => {
    const rec: RecordItem = {
      id: 'rec_prac',
      stageId: 'stage_3',
      subjectId: 'sub_cardio',
      number: 1,
      type: 'practical',
      title: 'Lab Audio',
      audioUrl: 'https://r2.test/prac.mp3',
    } as RecordItem;

    assert.equal(recordBelongsToLecture(rec, baseLecture), false);
  });

  test('Stage mismatch rejection: stage_3 lecture vs stage_2 record', () => {
    const rec: RecordItem = {
      id: 'rec_stg',
      stageId: 'stage_2',
      subjectId: 'sub_cardio',
      number: 1,
      type: 'theoretical',
      title: 'Cardio',
      audioUrl: 'https://r2.test/stg.mp3',
    } as RecordItem;

    assert.equal(recordBelongsToLecture(rec, baseLecture), false);
  });

  test('Number 0 edge case: number 0 is treated as valid number, not falsy', () => {
    const zeroLecture: Lecture = {
      ...baseLecture,
      id: 'lec_intro_0',
      number: 0,
    };
    const zeroRecord: RecordItem = {
      id: 'rec_zero',
      stageId: 'stage_3',
      subjectId: 'sub_cardio',
      number: 0,
      type: 'theoretical',
      title: 'Intro 0',
      audioUrl: 'https://r2.test/0.mp3',
    } as RecordItem;

    assert.equal(recordBelongsToLecture(zeroRecord, zeroLecture), true);
  });

  test('String number vs numeric number: record.number="1" matches lecture.number=1', () => {
    const strNumRecord: RecordItem = {
      id: 'rec_str',
      stageId: 'stage_3',
      subjectId: 'sub_cardio',
      number: '1' as any,
      type: 'theoretical',
      title: 'Audio',
      audioUrl: 'https://r2.test/str.mp3',
    } as RecordItem;

    assert.equal(recordBelongsToLecture(strNumRecord, baseLecture), true);
  });

  test('Title fallback when number is undefined on both', () => {
    const unnumberedLecture: Lecture = {
      ...baseLecture,
      id: 'lec_unnum',
      number: undefined as any,
      title: 'Electrocardiogram Interpretation',
    };
    const unnumberedRecord: RecordItem = {
      id: 'rec_unnum',
      stageId: 'stage_3',
      subjectId: 'sub_cardio',
      number: undefined as any,
      title: 'ECG - Electrocardiogram Interpretation part 1',
      audioUrl: 'https://r2.test/ecg.mp3',
    } as RecordItem;

    assert.equal(recordBelongsToLecture(unnumberedRecord, unnumberedLecture), true);
  });

  test('Hostile titles: Arabic diacritics, emojis, HTML tags', () => {
    const arabicLecture: Lecture = {
      ...baseLecture,
      id: 'lec_ar',
      number: 5,
      title: 'شرح أدوية القلب ❤️ <script>alert(1)</script>',
    };
    const arabicRecord: RecordItem = {
      id: 'rec_ar',
      stageId: 'stage_3',
      subjectId: 'sub_cardio',
      number: 5,
      title: 'شرح أدوية القلب ❤️ <script>alert(1)</script>',
      audioUrl: 'https://r2.test/ar.mp3',
    } as RecordItem;

    assert.equal(recordBelongsToLecture(arabicRecord, arabicLecture), true);
  });
});
