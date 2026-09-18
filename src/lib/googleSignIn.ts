import { signInWithPopup, GoogleAuthProvider, getAuth, signOut } from 'firebase/auth';
import { initializeApp, deleteApp } from 'firebase/app';
import { apiUrl } from './apiBase';
import firebaseConfig from '../../firebase-applet-config.json';

/**
 * Google sign-in for both web and the installed app.
 *
 * `signInWithPopup` never opens inside a WebView - the button simply does
 * nothing - so the native build goes through the OS account picker instead.
 *
 * The two paths hand the server DIFFERENT tokens, deliberately:
 *
 *   web     a FIREBASE id token, because the popup has already signed in
 *   native  a raw GOOGLE id token, verified server-side with google-auth-library
 *
 * The native path never creates a client-side Firebase identity. The web popup
 * mints a Firebase account under the Google uid, which the code then signs out
 * of and replaces with a custom-token session under a different uid - orphaning
 * the first account. Sending the Google token straight to the server means the
 * custom-token session is the only identity that ever exists.
 */

export class NoAccountError extends Error {
  constructor(readonly email: string, readonly name: string | null) {
    super('NO_ACCOUNT');
  }
}

async function isNative(): Promise<boolean> {
  try {
    const { Capacitor } = await import('@capacitor/core');
    return Capacitor?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

export interface GoogleProfile {
  name: string | null;
  email: string | null;
  photoUrl: string | null;
}

export interface GoogleSignInResult {
  token: string;
  /** The students/ document id the server resolved to. */
  studentId: string;
  /** From the Google account, for seeding a brand-new users document. */
  profile: GoogleProfile;
}

export interface GoogleTokenResult {
  /** Exactly one key, and which one it is decides how the server verifies it. */
  body: { idToken: string } | { googleIdToken: string };
  profile: GoogleProfile;
}

/**
 * The Android account picker, with the Credential Manager failure taken as read.
 *
 * `signInWithGoogle()` defaults to `useCredentialManager: true`, which routes
 * through androidx.credentials. That API fails CLOSED on a large slice of real
 * phones - it raises NoCredentialException ("No credentials available") rather
 * than showing a picker - and it does so with the project configured correctly:
 *
 *   - Play services throttles the sheet for 24h after the student dismisses it
 *     a few times, and every attempt afterwards is a no-credential error;
 *   - a device with no Google account added, or with the Google credential
 *     provider disabled, has nothing to offer;
 *   - Huawei and other non-GMS handsets have no provider at all.
 *
 * Passing `useCredentialManager: false` drops to the legacy GoogleSignIn intent,
 * which launches a full-screen account picker and can add an account on the
 * spot. It requests the id token from the SAME `default_web_client_id`, so the
 * token's `aud` is unchanged and /api/google-login verifies it identically -
 * this is a different UI on the way to the same credential, not a second
 * identity path.
 *
 * Credential Manager is still tried first, because where it works it is one tap
 * and does not leave the app. A cancellation is NOT retried: the student closed
 * the sheet on purpose and re-opening a second picker reads as the app fighting
 * them.
 */
async function signInWithGoogleNative(): Promise<any> {
  const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
  try {
    return await FirebaseAuthentication.signInWithGoogle();
  } catch (error: any) {
    const message = String(error?.message ?? error ?? '');
    if (/cancel/i.test(message)) throw error;
    console.warn('Credential Manager sign-in failed, falling back to the legacy picker:', message);
    return await FirebaseAuthentication.signInWithGoogle({ useCredentialManager: false });
  }
}


/** Exchanges a token for our custom token. Throws NoAccountError for signup. */
async function exchange(body: Record<string, string>): Promise<{ token: string; studentId: string }> {
  const res = await fetch(apiUrl('/api/google-login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (data?.code === 'NO_ACCOUNT') {
      throw new NoAccountError(data.email || '', data.name || null);
    }
    throw new Error(data?.error || 'Authentication failed');
  }
  return { token: data.token, studentId: (data.studentId || '').toLowerCase() };
}

/**
 * Obtains a Google-issued token WITHOUT touching the current session.
 *
 * Signing in is not the only reason to prove you own a mailbox - linking one
 * from settings needs the same proof while the student stays signed in. The
 * login path cannot be reused as-is, because on web it runs signInWithPopup
 * against the app's own auth instance and then signs out of it, which would
 * log the student out mid-link.
 *
 * So the popup runs on a SECOND, throwaway Firebase app. Its token is valid
 * for the same project (same aud), so admin.auth().verifyIdToken accepts it,
 * and the primary session is never written to at all.
 */
export async function getGoogleToken(): Promise<GoogleTokenResult> {
  if (await isNative()) {
    const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
    const result = await signInWithGoogleNative();
    const googleIdToken = result.credential?.idToken;
    if (!googleIdToken) throw new Error('Google sign-in returned no token');

    const profile: GoogleProfile = {
      name: result.user?.displayName ?? null,
      email: result.user?.email ?? null,
      photoUrl: result.user?.photoUrl ?? null,
    };

    // The plugin creates a native Firebase session as a side effect; drop it so
    // nothing but our own custom-token session is ever in play.
    await FirebaseAuthentication.signOut().catch(() => {});
    return { body: { googleIdToken }, profile };
  }

  const scratchApp = initializeApp(firebaseConfig, `google-link-${Date.now()}`);
  try {
    const scratchAuth = getAuth(scratchApp);
    const popupResult = await signInWithPopup(scratchAuth, new GoogleAuthProvider());
    const idToken = await popupResult.user.getIdToken();
    const profile: GoogleProfile = {
      name: popupResult.user.displayName,
      email: popupResult.user.email,
      photoUrl: popupResult.user.photoURL,
    };
    await signOut(scratchAuth).catch(() => {});
    return { body: { idToken }, profile };
  } finally {
    await deleteApp(scratchApp).catch(() => {});
  }
}

/**
 * Returns a custom token to sign in with, or throws.
 *
 * NoAccountError means the Google identity is valid but there is no student
 * record - the caller should route to signup rather than show a credential
 * error, since the person has just proved they own that mailbox.
 */
export async function getGoogleCustomToken(): Promise<GoogleSignInResult> {
  const { body, profile } = await getGoogleToken();
  const { token, studentId } = await exchange(body as Record<string, string>);
  return { token, studentId, profile };
}
