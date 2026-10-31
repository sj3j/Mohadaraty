/**
 * Mohadaraty E2E Test Suite - Type Definitions
 * Covers Tiers 1-4 for Requirements R1, R2, R3.
 */

export interface TestLecture {
  id: string;
  stageId: string;
  subjectId: string;
  type: 'theoretical' | 'practical';
  number: number;
  title: string;
  description?: string;
  pdfUrl?: string;
}

export interface TestRecordItem {
  id: string;
  title: string;
  category: string;
  type: 'theoretical' | 'practical';
  description?: string;
  audioUrl: string;
  duration?: number;
  size?: number;
  createdAt?: any;
  uploadedBy?: string;
  uploaderName?: string;
  number?: number | string;
  stageId?: string;
  subjectId?: string;
  subjectName?: string;
  subjectNameAr?: string;
  courseId?: string;
  lectureId?: string; // Optional direct link to parent lecture
}

export interface TestUserProfile {
  uid: string;
  role: 'student' | 'staff' | 'admin' | 'master_admin';
  stageId?: string;
  name?: string;
  email?: string;
  permissions?: Record<string, boolean>;
}

export type InnerTab = 'lectures' | 'weekly' | 'records' | 'leaderboard' | 'downloads';

export interface RouteResolution {
  currentTab: string;
  sanitizedPath: string;
  sanitizedSearch: string;
  openedLectureId?: string | null;
  highlightedRecordId?: string | null;
  redirected: boolean;
}

export interface AudioPlaybackState {
  currentTrack: { id: string; src: string; title: string } | null;
  isPlaying: boolean;
  progress: number;
  duration: number;
  currentTime: number;
  playbackRate: number;
  isMuted: boolean;
  isPlayerHidden: boolean;
}
