export type SessionBootstrapStatus =
  | 'authenticated'
  | 'cached-offline'
  | 'signed-out'
  | 'rejected-account';

export type SessionBootstrapReason =
  | 'firebase-user-restored'
  | 'cached-profile-restored'
  | 'no-persisted-session'
  | 'cached-profile-unavailable'
  | 'account-verified'
  | 'verification-unavailable'
  | 'cached-user-document-miss'
  | 'confirmed-missing-account'
  | 'disabled-account';

export interface SessionBootstrapResult {
  status: SessionBootstrapStatus;
  reason: SessionBootstrapReason;
  showLogin: boolean;
  shouldSignOut: boolean;
  clearPersistence: boolean;
  useCachedProfile: boolean;
}

const AUTHENTICATED: SessionBootstrapResult = {
  status: 'authenticated',
  reason: 'firebase-user-restored',
  showLogin: false,
  shouldSignOut: false,
  clearPersistence: false,
  useCachedProfile: false,
};

function preserve(reason: SessionBootstrapReason, useCachedProfile = false): SessionBootstrapResult {
  return {
    ...AUTHENTICATED,
    status: useCachedProfile ? 'cached-offline' : 'authenticated',
    reason,
    useCachedProfile,
  };
}

function reject(reason: 'confirmed-missing-account' | 'disabled-account'): SessionBootstrapResult {
  return {
    status: 'rejected-account',
    reason,
    showLogin: true,
    shouldSignOut: true,
    clearPersistence: true,
    useCachedProfile: false,
  };
}

export function resolveAuthState(input: {
  firebaseUserPresent: boolean;
  isOnline: boolean;
  wasSignedIn: boolean;
  cachedProfileAvailable: boolean;
}): SessionBootstrapResult {
  if (input.firebaseUserPresent) return AUTHENTICATED;

  if (input.wasSignedIn && input.cachedProfileAvailable) {
    return preserve('cached-profile-restored', true);
  }

  return {
    status: 'signed-out',
    reason: input.wasSignedIn ? 'cached-profile-unavailable' : 'no-persisted-session',
    showLogin: true,
    shouldSignOut: false,
    clearPersistence: true,
    useCachedProfile: false,
  };
}

export function resolveWhitelistVerification(input: {
  outcome: 'active' | 'missing' | 'disabled' | 'error';
  isOnline: boolean;
  isTransientError: boolean;
  confirmedByServer: boolean;
}): SessionBootstrapResult {
  if (input.outcome === 'active') return preserve('account-verified');
  if (input.outcome === 'disabled' && input.confirmedByServer) return reject('disabled-account');

  // Only a successful online lookup returning no account is a server verdict.
  if (input.outcome === 'missing' && input.isOnline && input.confirmedByServer) {
    return reject('confirmed-missing-account');
  }

  // An error is not proof that the account is invalid. Preserve the refresh
  // token and allow a later online launch to retry account verification.
  return preserve('verification-unavailable');
}

export function resolveUserDocument(input: {
  exists: boolean;
  fromCache: boolean;
  isOnline: boolean;
  rosterUser: boolean;
  cachedProfileAvailable: boolean;
}): SessionBootstrapResult {
  if (input.exists || input.rosterUser) return preserve('account-verified');

  if (input.fromCache || !input.isOnline || input.cachedProfileAvailable) {
    return preserve('cached-user-document-miss', input.cachedProfileAvailable);
  }

  return reject('confirmed-missing-account');
}

export function logSessionBootstrap(result: SessionBootstrapResult): void {
  const message = `[auth-session] ${result.status}: ${result.reason}`;
  if (result.status === 'rejected-account') console.warn(message);
  else console.info(message);
}
