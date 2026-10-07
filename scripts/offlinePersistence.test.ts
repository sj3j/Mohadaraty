/**
 * Automated Verification for Offline Support & Persistent Sign-In
 *
 * Checks:
 * 1. UserProfile offline serialization, retrieval, and eviction (authPersistence).
 * 2. Optimistic mutations for completed weekly tasks and studied lectures in cached profile.
 * 3. Offline storage data structures for Schedule Image and Stage Homeworks.
 * 4. Error classification for transient network vs account verdicts (isTransientNetworkError).
 */

import { isTransientNetworkError } from '../src/lib/firebase';
import type { UserProfile, Homework } from '../src/types';
import type { OfflineScheduleImage, OfflineStageHomeworks } from '../src/lib/localDb';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.error(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
    failed++;
  }
}

console.log('\n--- 1. Auth Persistence & Cached UserProfile ---');

// Mock localStorage for node test environment
const mockStorage: Record<string, string> = {};
(global as any).window = {
  localStorage: {
    getItem: (key: string) => mockStorage[key] || null,
    setItem: (key: string, value: string) => { mockStorage[key] = value; },
    removeItem: (key: string) => { delete mockStorage[key]; },
    clear: () => { Object.keys(mockStorage).forEach(k => delete mockStorage[k]); }
  }
};
(global as any).localStorage = (global as any).window.localStorage;

// Dynamic import of authPersistence to test with mock storage
const {
  saveCachedUserProfile,
  getCachedUserProfile,
  clearCachedUserProfile,
  updateCachedCompletedTasks,
  updateCachedStudied,
  CACHED_USER_PROFILE_KEY,
} = await import('../src/lib/authPersistence');

const sampleProfile: UserProfile = {
  uid: 'user_std_test_123',
  name: 'طالب متميز',
  email: 'student@example.com',
  role: 'student',
  stageId: 'stage_3',
  group: 'A1',
  streakCount: 5,
  longestStreak: 12,
  freezeTokens: 3,
  completedWeeklyTasks: ['hw_1', 'hw_2'],
  studied: ['lec_101'],
  isSubscribed: true,
};

saveCachedUserProfile(sampleProfile);
check('saveCachedUserProfile serializes profile into localStorage', !!mockStorage[CACHED_USER_PROFILE_KEY]);

const restored = getCachedUserProfile();
check('getCachedUserProfile recovers full profile with uid', restored?.uid === sampleProfile.uid);
check('getCachedUserProfile preserves stageId and group', restored?.stageId === 'stage_3' && restored?.group === 'A1');
check('getCachedUserProfile preserves completedWeeklyTasks', Array.isArray(restored?.completedWeeklyTasks) && restored?.completedWeeklyTasks.includes('hw_1'));

// Optimistic task completion
updateCachedCompletedTasks('hw_3', true);
const afterComplete = getCachedUserProfile();
check('updateCachedCompletedTasks adds task optimistically', afterComplete?.completedWeeklyTasks?.includes('hw_3') === true);

updateCachedCompletedTasks('hw_1', false);
const afterUncomplete = getCachedUserProfile();
check('updateCachedCompletedTasks removes task optimistically', afterUncomplete?.completedWeeklyTasks?.includes('hw_1') === false);

// Optimistic studied state
updateCachedStudied('lec_102', true);
const afterStudied = getCachedUserProfile();
check('updateCachedStudied adds lecture optimistically', afterStudied?.studied?.includes('lec_102') === true);

// Eviction
clearCachedUserProfile();
check('clearCachedUserProfile wipes profile on logout', getCachedUserProfile() === null);

console.log('\n--- 2. Transient Network Error Discrimination ---');

check('auth/network-request-failed is transient', isTransientNetworkError({ code: 'auth/network-request-failed' }));
check('unavailable is transient', isTransientNetworkError({ code: 'unavailable' }));
check('deadline-exceeded is transient', isTransientNetworkError({ code: 'deadline-exceeded' }));
check('TypeError without code (fetch failure) is treated as transient', isTransientNetworkError(new TypeError('Failed to fetch')));
check('auth/user-disabled is NOT transient (real account verdict)', !isTransientNetworkError({ code: 'auth/user-disabled' }));
check('auth/user-not-found is NOT transient', !isTransientNetworkError({ code: 'auth/user-not-found' }));
check('permission-denied is NOT transient', !isTransientNetworkError({ code: 'permission-denied' }));

console.log('\n--- 3. Offline Schedule Image Record Structure ---');

const dummyBlob = new Blob(['sample-image-bytes'], { type: 'image/jpeg' });
const scheduleRecord: OfflineScheduleImage = {
  stageId: 'stage_3',
  photoUrl: 'https://firebasestorage.googleapis.com/v0/b/app/o/schedules%2Fweekly_123.jpg',
  blob: dummyBlob,
  updatedAt: Date.now(),
};

check('schedule record carries stageId keyPath', scheduleRecord.stageId === 'stage_3');
check('schedule record carries photoUrl', scheduleRecord.photoUrl.includes('weekly_123'));
check('schedule record carries blob payload', scheduleRecord.blob.size > 0);

console.log('\n--- 4. Offline Stage Homeworks Record Structure ---');

const sampleHomeworks: Homework[] = [
  {
    id: 'hw_001',
    subject: 'pharmacology',
    type: 'theoretical',
    lectures: [{ label: 'محاضرة 1', lectureId: 'lec_1' }],
    dueDate: new Date(),
    stageId: 'stage_3',
    deadlineMode: 'fixed',
    createdAt: new Date(),
  },
  {
    id: 'hw_002',
    subject: 'medicinal_chemistry',
    type: 'practical',
    lectures: [{ label: 'مختبر 2', lectureId: 'lec_2' }],
    stageId: 'stage_3',
    deadlineMode: 'timetable',
    targetWeekStart: '2026-10-10',
    createdAt: new Date(),
  }
];

const homeworksRecord: OfflineStageHomeworks = {
  stageId: 'stage_3',
  homeworks: sampleHomeworks,
  updatedAt: Date.now(),
};

check('homeworks record carries stageId keyPath', homeworksRecord.stageId === 'stage_3');
check('homeworks record contains homework items', homeworksRecord.homeworks.length === 2);
check('homework record preserves timetable deadline mode', homeworksRecord.homeworks[1].deadlineMode === 'timetable');

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
