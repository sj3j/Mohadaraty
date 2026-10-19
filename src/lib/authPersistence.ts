import type { UserProfile } from '../types';
import { safeGetStorageItem, safeSetStorageItem } from '../hooks/useAuthWatchdog';

export const CACHED_USER_PROFILE_KEY = 'cached_user_profile';
export const LAST_ACTIVE_UID_KEY = 'cached_user_profile_last_uid';
export const EXPLICIT_LOGOUT_MARKER_KEY = 'attendance_auth_explicit_logout';

export function setExplicitLogoutMarker(): void {
  try {
    safeSetStorageItem(EXPLICIT_LOGOUT_MARKER_KEY, String(Date.now()));
  } catch (err) {
    console.warn('[authPersistence] Failed to set logout marker:', err);
  }
}

export function clearExplicitLogoutMarker(): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.removeItem(EXPLICIT_LOGOUT_MARKER_KEY);
    }
  } catch (err) {
    console.warn('[authPersistence] Failed to clear logout marker:', err);
  }
}

export function hasExplicitLogoutMarker(): boolean {
  try {
    return !!safeGetStorageItem(EXPLICIT_LOGOUT_MARKER_KEY);
  } catch {
    return false;
  }
}

/**
 * Persists the user profile locally so cold launches (especially offline on iOS & Android)
 * can instantly hydrate the session and avoid getting trapped on the Login screen.
 */
export function saveCachedUserProfile(profile: UserProfile): void {
  try {
    if (!profile || !profile.uid) return;
    clearExplicitLogoutMarker();
    safeSetStorageItem(`cached_user_profile_${profile.uid}`, JSON.stringify(profile));
    safeSetStorageItem(LAST_ACTIVE_UID_KEY, profile.uid);
    safeSetStorageItem(CACHED_USER_PROFILE_KEY, JSON.stringify(profile));
  } catch (err) {
    console.warn('[authPersistence] Failed to save cached profile:', err);
  }
}

/**
 * Retrieves the cached user profile if one exists.
 */
export function getCachedUserProfile(expectedUid?: string): UserProfile | null {
  try {
    const targetUid = expectedUid || safeGetStorageItem(LAST_ACTIVE_UID_KEY);
    if (targetUid) {
      const rawUid = safeGetStorageItem(`cached_user_profile_${targetUid}`);
      if (rawUid) {
        const parsed = JSON.parse(rawUid) as UserProfile;
        if (parsed && typeof parsed === 'object' && parsed.uid === targetUid) {
          return parsed;
        }
      }
    }
    if (!expectedUid) {
      const raw = safeGetStorageItem(CACHED_USER_PROFILE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as UserProfile;
      if (parsed && typeof parsed === 'object' && parsed.uid) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn('[authPersistence] Failed to read cached profile:', err);
  }
  return null;
}

/**
 * Purges the cached user profile on explicit logout.
 */
export function clearCachedUserProfile(uid?: string): void {
  try {
    setExplicitLogoutMarker();
    if (typeof window !== 'undefined' && window.localStorage) {
      if (uid) {
        localStorage.removeItem(`cached_user_profile_${uid}`);
      }
      localStorage.removeItem(CACHED_USER_PROFILE_KEY);
      localStorage.removeItem(LAST_ACTIVE_UID_KEY);
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
