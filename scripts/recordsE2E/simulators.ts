/**
 * Mohadaraty E2E Test Suite - Core Simulation Engines & Logic Verifiers
 * Provides opaque-box behavioral simulation and contract verification.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  TestLecture,
  TestRecordItem,
  TestUserProfile,
  RouteResolution,
  AudioPlaybackState,
} from './types';

// ==========================================
// 1. Audio Player & AudioContext Simulator
// ==========================================
export class AudioPlayerSimulator {
  private state: AudioPlaybackState = {
    currentTrack: null,
    isPlaying: false,
    progress: 0,
    duration: 0,
    currentTime: 0,
    playbackRate: 1,
    isMuted: false,
    isPlayerHidden: false,
  };

  private static readonly RATES = [1, 1.5, 2, 2.5];

  getState(): Readonly<AudioPlaybackState> {
    return { ...this.state };
  }

  playTrack(track: { id: string; src: string; title: string }, durationSec: number = 180) {
    if (this.state.currentTrack?.id === track.id) {
      this.state.isPlaying = true;
      return;
    }
    this.state.currentTrack = track;
    this.state.isPlaying = true;
    this.state.duration = durationSec;
    this.state.currentTime = 0;
    this.state.progress = 0;
    this.state.isPlayerHidden = false;
  }

  pauseTrack() {
    this.state.isPlaying = false;
  }

  resumeTrack() {
    if (this.state.currentTrack) {
      this.state.isPlaying = true;
    }
  }

  seek(percentage: number) {
    const clamped = Math.max(0, Math.min(100, percentage));
    this.state.progress = clamped;
    this.state.currentTime = (clamped / 100) * (this.state.duration || 0);
  }

  /**
   * Waveform scrubbing percentage calculation.
   * Matches AudioPlayer.tsx lines 72-76:
   * isElementRtl ? ((rect.width - x) / rect.width) * 100 : (x / rect.width) * 100
   */
  static calculateWaveformSeekPercentage(
    clientX: number,
    rectLeft: number,
    rectWidth: number,
    isRtl: boolean
  ): number {
    if (rectWidth <= 0) return 0;
    const x = Math.max(0, Math.min(rectWidth, clientX - rectLeft));
    const percentage = isRtl
      ? ((rectWidth - x) / rectWidth) * 100
      : (x / rectWidth) * 100;
    return Math.max(0, Math.min(100, Math.round(percentage * 100) / 100));
  }

  cyclePlaybackRate(): number {
    const currentIndex = AudioPlayerSimulator.RATES.indexOf(this.state.playbackRate);
    const nextIndex = (currentIndex + 1) % AudioPlayerSimulator.RATES.length;
    this.state.playbackRate = AudioPlayerSimulator.RATES[nextIndex];
    return this.state.playbackRate;
  }

  toggleMute(): boolean {
    this.state.isMuted = !this.state.isMuted;
    return this.state.isMuted;
  }

  /**
   * Audio timestamp formatter.
   * Matches AudioPlayer.tsx formatTime:
   * if (isNaN(time) || time === 0) return "0:00";
   * minutes:seconds.padStart(2, '0')
   */
  static formatTime(time: number): string {
    if (isNaN(time) || time <= 0 || !isFinite(time)) return '0:00';
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  /**
   * Direct download filename generator.
   * Matches AudioPlayer.tsx line 128:
   * forceDownload(src, title + '.mp3')
   */
  static generateDownloadArgs(src: string, title: string) {
    return {
      src,
      filename: `${title}.mp3`,
    };
  }

  closePlayer() {
    this.state.currentTrack = null;
    this.state.isPlaying = false;
    this.state.progress = 0;
    this.state.currentTime = 0;
  }
}

// ==========================================
// 2. Lecture ↔ Record Matcher Engine
// ==========================================
export class RecordMatcherEngine {
  /**
   * Matches records to a lecture using the canonical contract:
   * 1. Explicit link: rec.lectureId === lecture.id
   * 2. Fallback tuple match: !rec.lectureId && same stageId && same subjectId (or category) && same type && same number
   */
  static matchRecordToLecture(record: TestRecordItem, lecture: TestLecture): boolean {
    if (record.lectureId && record.lectureId === lecture.id) {
      return true;
    }
    if (
      !record.lectureId &&
      record.stageId === lecture.stageId &&
      (record.subjectId === lecture.subjectId || record.category === lecture.subjectId) &&
      record.type === lecture.type &&
      Number(record.number) === Number(lecture.number)
    ) {
      return true;
    }
    return false;
  }

  static getRecordsForLecture(
    allRecords: TestRecordItem[],
    lecture: TestLecture
  ): TestRecordItem[] {
    return allRecords
      .filter((rec) => this.matchRecordToLecture(rec, lecture))
      .sort((a, b) => {
        // Sort by createdAt descending if available, else part/title
        const timeA = typeof a.createdAt?.toMillis === 'function' ? a.createdAt.toMillis() : (a.createdAt || 0);
        const timeB = typeof b.createdAt?.toMillis === 'function' ? b.createdAt.toMillis() : (b.createdAt || 0);
        if (timeA && timeB && timeA !== timeB) return timeB - timeA;
        return (a.title || '').localeCompare(b.title || '');
      });
  }
}

// ==========================================
// 3. Routing & Redirection Engine (R2)
// ==========================================
export class RoutingEngine {
  /**
   * Resolves incoming URL/route transitions according to Requirement R2:
   * - /records -> redirect to 'lectures'
   * - ?tab=records -> redirect to 'lectures'
   * - /records/:id or ?recordId=:id -> redirect to matching lecture attachments view
   */
  static resolveRoute(
    pathname: string,
    search: string,
    allLectures: TestLecture[],
    allRecords: TestRecordItem[]
  ): RouteResolution {
    const searchParams = new URLSearchParams(search);
    let currentTab = 'lectures';
    let redirected = false;
    let openedLectureId: string | null = null;
    let highlightedRecordId: string | null = null;

    // Check query param ?tab=records
    if (searchParams.get('tab') === 'records') {
      redirected = true;
      searchParams.delete('tab');
      currentTab = 'lectures';
    }

    // Check query param ?recordId=:id or ?record=:id
    const queryRecordId = searchParams.get('recordId') || searchParams.get('record');
    if (queryRecordId) {
      highlightedRecordId = queryRecordId;
      redirected = true;
      searchParams.delete('recordId');
      searchParams.delete('record');
      const matchedRecord = allRecords.find((r) => r.id === queryRecordId);
      if (matchedRecord) {
        const parentLec = allLectures.find((lec) =>
          RecordMatcherEngine.matchRecordToLecture(matchedRecord, lec)
        );
        if (parentLec) {
          openedLectureId = parentLec.id;
        }
      }
    }

    // Check pathname: /records or /records/:id
    let cleanPath = pathname;
    if (pathname === '/records' || pathname === '/records/') {
      redirected = true;
      cleanPath = '/';
      currentTab = 'lectures';
    } else if (pathname.startsWith('/records/')) {
      const pathRecordId = pathname.slice('/records/'.length).replace(/\/$/, '');
      if (pathRecordId) {
        highlightedRecordId = pathRecordId;
        redirected = true;
        cleanPath = '/';
        currentTab = 'lectures';
        const matchedRecord = allRecords.find((r) => r.id === pathRecordId);
        if (matchedRecord) {
          const parentLec = allLectures.find((lec) =>
            RecordMatcherEngine.matchRecordToLecture(matchedRecord, lec)
          );
          if (parentLec) {
            openedLectureId = parentLec.id;
          }
        }
      }
    }

    return {
      currentTab,
      sanitizedPath: cleanPath,
      sanitizedSearch: searchParams.toString() ? `?${searchParams.toString()}` : '',
      openedLectureId,
      highlightedRecordId,
      redirected,
    };
  }

  /**
   * Normalizes HomeScreen initial tab.
   * If 'records' is passed, it must normalize to 'lectures'.
   */
  static normalizeHomeScreenTab(tab: string): string {
    if (tab === 'records') return 'lectures';
    return tab;
  }
}

// ==========================================
// 4. Cloudflare R2 & Storage Contract Engine (R3)
// ==========================================
export class StorageContractEngine {
  static readonly BUCKET_NAME = 'lecture-audio';
  static readonly MAX_AUDIO_SIZE_BYTES = 500 * 1024 * 1024; // 500MB

  static validateAudioUploadPayload(file: { name: string; type: string; size: number }) {
    if (!file.type.startsWith('audio/')) {
      return { valid: false, error: 'Please select audio files only' };
    }
    if (file.size > this.MAX_AUDIO_SIZE_BYTES) {
      return { valid: false, error: 'Max 500MB' };
    }
    return { valid: true, error: null };
  }

  static generateObjectKey(stageId: string, filename: string, timestamp: number = Date.now()): string {
    const safeFileName = filename.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    return stageId
      ? `records/${stageId}/${timestamp}_${safeFileName}`
      : `records/${timestamp}_${safeFileName}`;
  }

  /**
   * Derives Cloudflare R2 key from stored URL.
   * Matches shared/yearWipe.ts lines 188-196:
   * export function r2KeyFromUrl(url: unknown, publicBase: string): string | null
   */
  static r2KeyFromUrl(url: unknown, publicBase: string): string | null {
    if (typeof url !== 'string' || !url.trim()) return null;
    const base = publicBase.replace(/\/+$/, '');
    if (!base) return null;
    if (url.startsWith(base + '/')) {
      return url.slice(base.length + 1).split('?')[0];
    }
    return null;
  }
}

// ==========================================
// 5. Codebase Inspector
// ==========================================
export class CodebaseInspector {
  private static root = join(import.meta.dirname, '..', '..');

  static readSource(relativePath: string): string {
    const absPath = join(this.root, relativePath);
    if (!existsSync(absPath)) {
      return '';
    }
    return readFileSync(absPath, 'utf8');
  }

  static fileExists(relativePath: string): boolean {
    return existsSync(join(this.root, relativePath));
  }
}
