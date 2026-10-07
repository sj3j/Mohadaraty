import type { UserProfile } from '../types';
import { safeGetStorageItem, safeSetStorageItem } from '../hooks/useAuthWatchdog';

export const CACHED_USER_PROFILE_KEY = 'cached_user_profile';

/**
 * Persists the user profile locally so cold launches (especially offline on iOS & Android)
 * can instantly hydrate the session and avoid getting trapped on the Login screen.
 */
export function saveCachedUserProfile(profile: UserProfile): void {
  try {
    if (!profile || !profile.uid) return;
    safeSetStorageItem(CACHED_USER_PROFILE_KEY, JSON.stringify(profile));
  } catch (err) {
    console.warn('[authPersistence] Failed to save cached profile:', err);
  }
}

/**
 * Retrieves the cached user profile if one exists.
 */
export function getCachedUserProfile(): UserProfile | null {
  try {
    const raw = safeGetStorageItem(CACHED_USER_PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UserProfile;
    if (parsed && typeof parsed === 'object' && parsed.uid) {
      return parsed;
    }
  } catch (err) {
    console.warn('[authPersistence] Failed to read cached profile:', err);
  }
  return null;
}

/**
 * Purges the cached user profile on explicit logout.
 */
export function clearCachedUserProfile(): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.removeItem(CACHED_USER_PROFILE_KEY);
    }
  } catch (err) {
    console.warn('[authPersistence] Failed to clear cached profile:', err);
  }
}

/**
 * Optimistically updates the completion status of a weekly task in the cached profile.
 */
export function updateCachedCompletedTasks(homeworkId: string, isCompleted: boolean): void {
  try {
    const profile = getCachedUserProfile();
    if (!profile) return;
    const current = new Set(profile.completedWeeklyTasks || []);
    if (isCompleted) {
      current.add(homeworkId);
    } else {
      current.delete(homeworkId);
    }
    profile.completedWeeklyTasks = Array.from(current);
    saveCachedUserProfile(profile);
  } catch (err) {
    console.warn('[authPersistence] Failed to update cached completed tasks:', err);
  }
}

/**
 * Optimistically updates the studied status of a lecture in the cached profile.
 */
export function updateCachedStudied(lectureId: string, isStudied: boolean): void {
  try {
    const profile = getCachedUserProfile();
    if (!profile) return;
    const current = new Set(profile.studied || []);
    if (isStudied) {
      current.add(lectureId);
    } else {
      current.delete(lectureId);
    }
    profile.studied = Array.from(current);
    saveCachedUserProfile(profile);
  } catch (err) {
    console.warn('[authPersistence] Failed to update cached studied state:', err);
  }
}
