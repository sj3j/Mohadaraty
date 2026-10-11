import assert from 'node:assert/strict';
import {
  resolveAuthState,
  resolveUserDocument,
  resolveWhitelistVerification,
} from '../src/lib/sessionRestoration';

let passed = 0;

function test(name: string, run: () => void) {
  run();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('\n--- Android session restoration regression ---');

test('online cold restart restores the Firebase session', () => {
  const result = resolveAuthState({
    firebaseUserPresent: true,
    isOnline: true,
    wasSignedIn: true,
    cachedProfileAvailable: true,
  });
  assert.equal(result.status, 'authenticated');
  assert.equal(result.showLogin, false);
  assert.equal(result.shouldSignOut, false);
});

test('offline process restart uses the cached profile instead of login', () => {
  const result = resolveAuthState({
    firebaseUserPresent: false,
    isOnline: false,
    wasSignedIn: true,
    cachedProfileAvailable: true,
  });
  assert.equal(result.status, 'cached-offline');
  assert.equal(result.useCachedProfile, true);
  assert.equal(result.showLogin, false);
  assert.equal(result.shouldSignOut, false);
});

test('transient whitelist failure preserves the session', () => {
  const result = resolveWhitelistVerification({
    outcome: 'error',
    isOnline: true,
    isTransientError: true,
    confirmedByServer: false,
  });
  assert.equal(result.status, 'authenticated');
  assert.equal(result.shouldSignOut, false);
});

test('non-verdict whitelist error also preserves credentials', () => {
  const result = resolveWhitelistVerification({
    outcome: 'error',
    isOnline: true,
    isTransientError: false,
    confirmedByServer: false,
  });
  assert.equal(result.status, 'authenticated');
  assert.equal(result.shouldSignOut, false);
});

test('cache-only missing user document preserves the session', () => {
  const result = resolveUserDocument({
    exists: false,
    fromCache: true,
    isOnline: false,
    rosterUser: false,
    cachedProfileAvailable: true,
  });
  assert.equal(result.status, 'cached-offline');
  assert.equal(result.shouldSignOut, false);
  assert.equal(result.showLogin, false);
});

test('confirmed missing whitelist account is rejected', () => {
  const result = resolveWhitelistVerification({
    outcome: 'missing',
    isOnline: true,
    isTransientError: false,
    confirmedByServer: true,
  });
  assert.equal(result.status, 'rejected-account');
  assert.equal(result.reason, 'confirmed-missing-account');
  assert.equal(result.shouldSignOut, true);
});

test('confirmed disabled whitelist account is rejected', () => {
  const result = resolveWhitelistVerification({
    outcome: 'disabled',
    isOnline: true,
    isTransientError: false,
    confirmedByServer: true,
  });
  assert.equal(result.status, 'rejected-account');
  assert.equal(result.reason, 'disabled-account');
  assert.equal(result.shouldSignOut, true);
});

test('cache-only missing whitelist account is inconclusive', () => {
  const result = resolveWhitelistVerification({
    outcome: 'missing',
    isOnline: true,
    isTransientError: false,
    confirmedByServer: false,
  });
  assert.equal(result.status, 'authenticated');
  assert.equal(result.shouldSignOut, false);
});

test('cached disabled flag waits for a server verdict', () => {
  const result = resolveWhitelistVerification({
    outcome: 'disabled',
    isOnline: true,
    isTransientError: false,
    confirmedByServer: false,
  });
  assert.equal(result.status, 'authenticated');
  assert.equal(result.shouldSignOut, false);
});

test('explicit logout remains signed out after restart', () => {
  const result = resolveAuthState({
    firebaseUserPresent: false,
    isOnline: false,
    wasSignedIn: false,
    cachedProfileAvailable: false,
  });
  assert.equal(result.status, 'signed-out');
  assert.equal(result.showLogin, true);
  assert.equal(result.clearPersistence, true);
});

test('corrupt or absent cached profile cannot create a phantom session', () => {
  const result = resolveAuthState({
    firebaseUserPresent: false,
    isOnline: false,
    wasSignedIn: true,
    cachedProfileAvailable: false,
  });
  assert.equal(result.status, 'signed-out');
  assert.equal(result.showLogin, true);
});

console.log(`\nResults: ${passed} passed, 0 failed\n`);
