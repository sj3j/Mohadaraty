import assert from 'node:assert/strict';
import {
  resolveAuthState,
  resolveUserDocument,
  resolveWhitelistVerification,
} from '../src/lib/sessionRestoration';
import { canAttemptStreakActivity, createSingleFlight } from '../src/lib/streakActivity';

let passed = 0;

function test(name: string, run: () => void) {
  run();
  passed++;
  console.log(`  PASS  ${name}`);
}

async function testAsync(name: string, run: () => Promise<void>) {
  await run();
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

test('cached profile waits for the matching Firebase user before recording activity', () => {
  const startup = {
    profileUid: 'student-1',
    isAuthReady: true,
    isOnline: true,
    isVisible: true,
  };

  assert.equal(canAttemptStreakActivity({ ...startup, authenticatedUid: null }), false);
  assert.equal(canAttemptStreakActivity({ ...startup, authenticatedUid: 'student-1' }), true);
});

test('activity becomes eligible after an offline session reconnects', () => {
  const session = {
    profileUid: 'student-1',
    authenticatedUid: 'student-1',
    isAuthReady: true,
    isVisible: true,
  };

  assert.equal(canAttemptStreakActivity({ ...session, isOnline: false }), false);
  assert.equal(canAttemptStreakActivity({ ...session, isOnline: true }), true);
});

test('activity rejects a cached profile belonging to another Firebase user', () => {
  assert.equal(canAttemptStreakActivity({
    profileUid: 'cached-user',
    authenticatedUid: 'signed-in-user',
    isAuthReady: true,
    isOnline: true,
    isVisible: true,
  }), false);
});

await testAsync('simultaneous activity triggers share one in-flight request', async () => {
  const singleFlight = createSingleFlight();
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });

  const first = singleFlight.run(async () => {
    calls++;
    await blocked;
    return 'recorded';
  });
  const second = singleFlight.run(async () => {
    calls++;
    return 'duplicate';
  });

  assert.equal(first, second);
  assert.equal(calls, 1);
  assert.equal(singleFlight.isRunning(), true);

  release();
  assert.equal(await second, 'recorded');
  assert.equal(singleFlight.isRunning(), false);

  await singleFlight.run(async () => {
    calls++;
    return 'retry';
  });
  assert.equal(calls, 2);
});

test('activity becomes eligible when watchdog safeIsAuthReady is true even if isAuthReady is false', () => {
  const watchdogRescuedSession = {
    profileUid: 'student-1',
    authenticatedUid: 'student-1',
    isAuthReady: false,
    safeIsAuthReady: true,
    isOnline: true,
    isVisible: true,
  };

  assert.equal(canAttemptStreakActivity(watchdogRescuedSession), true);
  assert.equal(canAttemptStreakActivity({ ...watchdogRescuedSession, safeIsAuthReady: false }), false);
});

await testAsync('singleFlight unblocks and resets on timeout if task stalls', async () => {
  const singleFlight = createSingleFlight();
  let calls = 0;

  // Run a task with a very short timeout (50ms) that never settles on its own
  const stalled = singleFlight.run(async (signal) => {
    calls++;
    return new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }, 50);

  assert.equal(singleFlight.isRunning(), true);

  try {
    await stalled;
  } catch {
    // Expected abort error
  }

  // Ensure isRunning() cleared and next call succeeds
  assert.equal(singleFlight.isRunning(), false);

  const next = await singleFlight.run(async () => {
    calls++;
    return 'recovered';
  }, 50);

  assert.equal(next, 'recovered');
  assert.equal(calls, 2);
});

console.log(`\nResults: ${passed} passed, 0 failed\n`);

