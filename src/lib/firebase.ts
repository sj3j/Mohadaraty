import { initializeApp } from 'firebase/app';
import { 
  initializeAuth, 
  indexedDBLocalPersistence, 
  browserLocalPersistence, 
  browserSessionPersistence,
  inMemoryPersistence,
  browserPopupRedirectResolver 
} from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { getMessaging, isSupported } from 'firebase/messaging';
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions';
import firebaseConfig from '../../firebase-applet-config.json';

export const app = initializeApp(firebaseConfig);
export const functions = getFunctions(app, 'me-west1');

export const auth = initializeAuth(app, {
  persistence: [
    indexedDBLocalPersistence,
    browserLocalPersistence,
    browserSessionPersistence,
    inMemoryPersistence
  ],
  popupRedirectResolver: browserPopupRedirectResolver
});

/**
 * Firestore with an IndexedDB-backed cache.
 *
 * This ran on the SDK's default MEMORY cache for a long time, which is empty on
 * every cold start. Auth persistence (above) is durable, so an offline launch
 * restored a signed-in session and then entered a boot path whose Firestore
 * reads could not possibly succeed:
 *
 *   - a document getDoc REJECTS offline when it is not in cache, and App.tsx's
 *     catch responded by signing the user out;
 *   - an onSnapshot does NOT reject - it delivers fromCache with exists()===false,
 *     which App.tsx read as a deleted account and also signed the user out;
 *   - the lecture list listener never fired, so downloaded PDFs had no metadata
 *     to be reached through.
 *
 * `persistentMultipleTabManager` rather than the single-tab default: the web
 * build is a PWA that people open in more than one tab, and the single-tab
 * manager fails the second one with `failed-precondition`.
 *
 * WARNING: this also makes the offline MUTATION queue durable. A write issued
 * offline now survives the tab and flushes on reconnect, where before it died
 * with the page. StageContext's DEFAULT_STAGES seeding is guarded against
 * exactly that (it must never fire on a fromCache-empty snapshot) - check any
 * other unconditional write that keys off an "empty" read before adding one.
 */
export const db = initializeFirestore(
  app,
  { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) },
  firebaseConfig.firestoreDatabaseId,
);

// Initialize Storage using the exact bucket from config
export const storage = getStorage(app, firebaseConfig.storageBucket);
// Set a reasonable timeout (60 seconds) so it doesn't hang indefinitely
storage.maxUploadRetryTime = 60000;
storage.maxOperationRetryTime = 60000;

// Initialize Messaging conditionally (not supported in all browsers)
export const messaging = async () => {
  const supported = await isSupported();
  if (supported) {
    return getMessaging(app);
  }
  return null;
};

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

/**
 * True when a failure is the network, not a verdict about the account.
 *
 * The distinction matters because the auth bootstrap used to treat ANY throw as
 * proof the account was invalid and called signOut(), which wipes the refresh
 * token out of IndexedDB. Turning off WiFi therefore logged people out
 * permanently - reconnecting could not restore the session, and the login screen
 * refuses to submit while offline. Firebase itself never does this: the SDK
 * explicitly declines to clear a user on `auth/network-request-failed`.
 */
export function isTransientNetworkError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (typeof code !== 'string') {
    // A bare TypeError from a failed fetch has no code. Treat an unrecognised
    // failure as transient: keeping a session that should have ended is
    // recoverable on the next online launch, wrongly ending one is not.
    return true;
  }
  return (
    code === 'unavailable' ||
    code === 'deadline-exceeded' ||
    code === 'cancelled' ||
    code === 'resource-exhausted' ||
    code === 'internal' ||
    code === 'unknown' ||
    code === 'auth/network-request-failed' ||
    code === 'auth/timeout'
  );
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  // Do not throw the error to prevent the app from completely crashing on permission denied
}
