import { db } from './firebase';

const RECOVERY_STORAGE_KEY = 'firestore_recovery_attempted';
const COOLDOWN_MS = 60_000;

/**
 * Checks whether an error is a fatal Firestore internal assertion failure
 * or an IndexedDB transaction abort error (e.g. ID: b815).
 */
export function isFirestoreAssertionError(error: unknown): boolean {
  if (!error) return false;
  const msg = typeof error === 'string'
    ? error
    : (error as Error).message || String(error);

  return (
    msg.includes('b815') ||
    msg.includes('INTERNAL ASSERTION FAILED') ||
    msg.includes('The transaction was aborted') ||
    msg.includes('Unexpected state (ID:') ||
    msg.includes('IndexedDbTransactionError') ||
    (msg.includes('AbortError') && msg.toLowerCase().includes('transaction'))
  );
}

/**
 * Checks if recovery has already been attempted recently to prevent infinite reload loops.
 */
export function hasRecentlyAttemptedRecovery(): boolean {
  try {
    const raw = sessionStorage.getItem(RECOVERY_STORAGE_KEY);
    if (!raw) return false;
    const timestamp = parseInt(raw, 10);
    if (isNaN(timestamp)) return false;
    return Date.now() - timestamp < COOLDOWN_MS;
  } catch {
    return false;
  }
}

/**
 * Cleanly terminates Firestore, purges the local IndexedDB cache,
 * deletes any orphaned Firestore IndexedDB stores, and reloads the window.
 */
export async function recoverCorruptedFirestoreCache(force = false): Promise<boolean> {
  if (!force && hasRecentlyAttemptedRecovery()) {
    console.warn('[firestoreRecovery] Recovery already attempted within cooldown window. Skipping automatic reload.');
    return false;
  }

  try {
    sessionStorage.setItem(RECOVERY_STORAGE_KEY, Date.now().toString());
  } catch {
    // sessionStorage might fail in restrictive environments
  }

  console.warn('[firestoreRecovery] Detected fatal Firestore assertion. Terminating and purging corrupted IndexedDB cache...');

  try {
    const { terminate, clearIndexedDbPersistence } = await import('firebase/firestore');
    await terminate(db);
    await clearIndexedDbPersistence(db);
    console.log('[firestoreRecovery] Firestore terminated and persistence cleared successfully.');
  } catch (err) {
    console.warn('[firestoreRecovery] Direct Firestore clear failed, falling back to manual IndexedDB deletion:', err);
  }

  // Fallback: manually delete any IndexedDB databases matching firestore
  try {
    if (typeof window !== 'undefined' && window.indexedDB) {
      if (typeof window.indexedDB.databases === 'function') {
        const dbs = await window.indexedDB.databases();
        for (const info of dbs) {
          if (info.name && (info.name.includes('firestore') || info.name.includes('[DEFAULT]'))) {
            try {
              window.indexedDB.deleteDatabase(info.name);
              console.log(`[firestoreRecovery] Deleted IndexedDB: ${info.name}`);
            } catch (delErr) {
              console.warn(`[firestoreRecovery] Failed to delete ${info.name}:`, delErr);
            }
          }
        }
      } else {
        // Fallback for browsers without indexedDB.databases()
        const defaultName = 'firestore/[DEFAULT]/mohadaraty/main';
        try {
          window.indexedDB.deleteDatabase(defaultName);
        } catch {
          // ignore
        }
      }
    }
  } catch (idbErr) {
    console.warn('[firestoreRecovery] IndexedDB manual cleanup error:', idbErr);
  }

  // Soft delay before reload to let deletions commit
  await new Promise(resolve => setTimeout(resolve, 300));

  if (typeof window !== 'undefined') {
    window.location.reload();
  }
  return true;
}
