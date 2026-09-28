import { useState, useEffect } from 'react';
import { logPerfMark } from '../lib/perf';

/**
 * Safe local storage read that never throws on iOS WebKit / private browsing / quota errors.
 */
export function safeGetStorageItem(key: string): string | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return localStorage.getItem(key);
    }
  } catch (err) {
    console.warn(`[safeStorage] Failed to read ${key}:`, err);
  }
  return null;
}

/**
 * Safe local storage write that never throws on iOS WebKit / private browsing / quota errors.
 */
export function safeSetStorageItem(key: string, value: string): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.setItem(key, value);
    }
  } catch (err) {
    console.warn(`[safeStorage] Failed to write ${key}:`, err);
  }
}

const FIRST_INSTALL_TIMEOUT_MS = 5000;
const RETURNING_USER_HARD_CEILING_MS = 8000;

/**
 * Auth startup watchdog to ensure the application never hangs indefinitely on the boot loader.
 *
 * Behavior:
 * - Fresh install / first-time user (wasSignedIn !== 'true'):
 *   Unblocks after 5s so the user can immediately access the LoginScreen or offline view.
 * - Returning user (wasSignedIn === 'true'):
 *   Allows an initial 5s grace period for Firebase to hydrate the cached token from IndexedDB.
 *   If still unresolved, an 8s hard ceiling guarantees `setForceReady(true)` is called,
 *   preventing permanent spin in captive portals, dead networks, or stalled token refreshes.
 */
export function useAuthWatchdog(isAuthReady: boolean) {
  const [forceReady, setForceReady] = useState(false);

  useEffect(() => {
    if (isAuthReady) return;

    let ceilingTimer: ReturnType<typeof setTimeout> | null = null;

    const graceTimer = setTimeout(() => {
      const wasSignedIn = safeGetStorageItem('wasSignedIn') === 'true';

      if (!wasSignedIn) {
        logPerfMark('auth-watchdog-unblock-first-install');
        console.warn(`[useAuthWatchdog] Auth state did not resolve within ${FIRST_INSTALL_TIMEOUT_MS}ms for first-time user. Forcing UI ready.`);
        setForceReady(true);
      } else {
        logPerfMark('auth-watchdog-grace-extended');
        console.warn(
          `[useAuthWatchdog] User was previously signed in. Extending grace period to ${RETURNING_USER_HARD_CEILING_MS}ms before hard unblock.`
        );
      }
    }, FIRST_INSTALL_TIMEOUT_MS);

    // Hard ceiling: guarantees the app never hangs indefinitely under any circumstances
    ceilingTimer = setTimeout(() => {
      logPerfMark('auth-watchdog-hard-ceiling-hit');
      console.warn(`[useAuthWatchdog] Hard ceiling reached (${RETURNING_USER_HARD_CEILING_MS}ms). Forcing UI ready.`);
      setForceReady(true);
    }, RETURNING_USER_HARD_CEILING_MS);

    return () => {
      clearTimeout(graceTimer);
      if (ceilingTimer) clearTimeout(ceilingTimer);
    };
  }, [isAuthReady]);

  return isAuthReady || forceReady;
}
