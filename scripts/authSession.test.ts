import assert from 'node:assert/strict';
import {
  resolveAuthState,
  resolveUserDocument,
  resolveWhitelistVerification,
} from '../src/lib/sessionRestoration';
import crypto from 'node:crypto';
import { canAttemptStreakActivity, createSingleFlight } from '../src/lib/streakActivity';
import {
  isAccountSessionAuthorized,
  normalizeSessionDevice,
  requestSessionLocation,
  sessionClaimsFromToken,
  resolveManagedAccountRole,
  createAccountSession,
  isPrivateIp,
  extractClientIp,
  resolveSessionLocation,
} from '../shared/accountSessions';

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


console.log('\n--- Account sessions, claims, nonce idempotency & role enforcement ---');

test('active session at the current generation is authorized', () => {
  assert.equal(isAccountSessionAuthorized(
    { uid: 'student-1', status: 'active', generation: 3 },
    { generation: 3, preservedSessionId: null }, 'student-1', 'session-1', 3,
  ), true);
});

test('terminated and cross-account sessions are rejected', () => {
  assert.equal(isAccountSessionAuthorized(
    { uid: 'account-1', status: 'revoked', generation: 3 },
    { generation: 3 }, 'account-1', 'session-1', 3,
  ), false);
  assert.equal(isAccountSessionAuthorized(
    { uid: 'account-2', status: 'active', generation: 3 },
    { generation: 3 }, 'account-1', 'session-1', 3,
  ), false);
});

test('bulk termination preserves only the current older-generation session', () => {
  const session = { uid: 'user-1', status: 'active', generation: 1 };
  assert.equal(isAccountSessionAuthorized(session, { generation: 2, preservedSessionId: 'current' }, 'user-1', 'current', 1), true);
  assert.equal(isAccountSessionAuthorized(session, { generation: 2, preservedSessionId: 'current' }, 'user-1', 'other', 1), false);
});

test('session claim and metadata parsing reject malformed claims and preserve honest unknowns', () => {
  assert.equal(sessionClaimsFromToken({ app_session: true, app_session_id: 's1', app_session_generation: 1 })?.app_session_id, 's1');
  assert.equal(sessionClaimsFromToken({ app_session: true, app_session_id: '', app_session_generation: 1 }), null);
  assert.equal(sessionClaimsFromToken({ app_session: false, app_session_id: 's1', app_session_generation: 1 }), null);
  assert.equal(sessionClaimsFromToken({ app_session: true, app_session_id: 's1', app_session_generation: 0 }), null);
  assert.equal(normalizeSessionDevice({}).name, 'Unknown device');
  assert.deepEqual(requestSessionLocation({ 'x-vercel-ip-city': 'Karbala%20City', 'x-vercel-ip-country': 'IQ' }), { city: 'Karbala City', country: 'IQ' });
  assert.deepEqual(requestSessionLocation({}), { city: 'Unknown', country: 'Unknown' });
});

test('requestSessionLocation supports Vercel, Cloudflare, and custom headers', () => {
  assert.deepEqual(requestSessionLocation({ 'cf-ipcity': 'Erbil', 'cf-ipcountry': 'IQ' }), { city: 'Erbil', country: 'IQ' });
  assert.deepEqual(requestSessionLocation({ 'x-city': 'Basra', 'x-country-code': 'IQ' }), { city: 'Basra', country: 'IQ' });
});

test('isPrivateIp detects loopback, local network, and ipv6 mapped addresses', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('192.168.1.50'), true);
  assert.equal(isPrivateIp('10.0.0.1'), true);
  assert.equal(isPrivateIp('172.20.0.1'), true);
  assert.equal(isPrivateIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateIp('169.224.90.5'), false);
  assert.equal(isPrivateIp('8.8.8.8'), false);
});

test('extractClientIp correctly parses x-forwarded-for, x-real-ip and fallbackIp', () => {
  assert.equal(extractClientIp({ 'x-forwarded-for': '127.0.0.1, 169.224.90.5' }), '169.224.90.5');
  assert.equal(extractClientIp({ 'x-real-ip': '8.8.8.8' }), '8.8.8.8');
  assert.equal(extractClientIp({}, '37.237.0.1'), '37.237.0.1');
});

await testAsync('resolveSessionLocation uses clientLocation if headers missing', async () => {
  const loc = await resolveSessionLocation({
    headers: {},
    clientLocation: { city: 'Najaf', country: 'IQ' },
    fallbackIp: '127.0.0.1',
  });
  assert.deepEqual(loc, { city: 'Najaf', country: 'IQ' });
});

await testAsync('resolveSessionLocation marks private localhost as Local Development', async () => {
  const loc = await resolveSessionLocation({
    headers: {},
    fallbackIp: '127.0.0.1',
  });
  assert.deepEqual(loc, { city: 'Local Development', country: 'Dev' });
});

function createMockDb() {
  const collections: Record<string, Map<string, any>> = {
    users: new Map(),
    allowed_admins: new Map(),
    students: new Map(),
    accountSessions: new Map(),
    accountSessionState: new Map(),
  };

  return {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => ({
          exists: collections[name]?.has(id) ?? false,
          data: () => collections[name]?.get(id),
          id,
        }),
        set: async (data: any, options?: any) => {
          if (!collections[name]) collections[name] = new Map();
          if (options?.merge && collections[name].has(id)) {
            collections[name].set(id, { ...collections[name].get(id), ...data });
          } else {
            collections[name].set(id, data);
          }
        },
      }),
    }),
    runTransaction: async (updateFunction: (tx: any) => Promise<any>) => {
      const tx = {
        get: async (ref: any) => ref.get(),
        set: async (ref: any, data: any, options?: any) => ref.set(data, options),
        update: async (ref: any, data: any) => ref.set(data, { merge: true }),
      };
      return await updateFunction(tx);
    },
    _collections: collections,
  };
}

const mockFieldValue = {
  serverTimestamp: () => 'SERVER_TIMESTAMP',
};

await testAsync('resolveManagedAccountRole identifies all roles correctly', async () => {
  const db = createMockDb();
  // master_admin
  const masterRole = await resolveManagedAccountRole(db, { uid: 'master-1', email: 'almdrydyl335@gmail.com' });
  assert.equal(masterRole, 'master_admin');

  // observer
  const observerRole = await resolveManagedAccountRole(db, { uid: 'obs-1', email: 'info@alsafwa.edu.iq' });
  assert.equal(observerRole, 'observer');

  // doctor in users
  db._collections.users.set('doc-1', { role: 'doctor' });
  const doctorRole = await resolveManagedAccountRole(db, { uid: 'doc-1', email: 'doctor@univ.edu' });
  assert.equal(doctorRole, 'doctor');

  // admin / moderator / support in users
  db._collections.users.set('admin-1', { role: 'admin' });
  assert.equal(await resolveManagedAccountRole(db, { uid: 'admin-1', email: 'admin@x.com' }), 'admin');

  db._collections.users.set('mod-1', { role: 'moderator' });
  assert.equal(await resolveManagedAccountRole(db, { uid: 'mod-1', email: 'mod@x.com' }), 'moderator');

  db._collections.users.set('sup-1', { role: 'support' });
  assert.equal(await resolveManagedAccountRole(db, { uid: 'sup-1', email: 'sup@x.com' }), 'support');

  // student in students
  db._collections.students.set('stu@x.com', { isActive: true, role: 'student' });
  assert.equal(await resolveManagedAccountRole(db, { uid: 'stu-1', email: 'stu@x.com' }), 'student');

  // allowed_admins fallback
  db._collections.allowed_admins.set('rep@x.com', { role: 'admin' });
  assert.equal(await resolveManagedAccountRole(db, { uid: 'rep-uid', email: 'rep@x.com' }), 'admin');
});

await testAsync('resolveManagedAccountRole rejects disabled and unregistered accounts', async () => {
  const db = createMockDb();

  // Disabled in users
  db._collections.users.set('disabled-1', { role: 'admin', disabled: true });
  await assert.rejects(
    resolveManagedAccountRole(db, { uid: 'disabled-1', email: 'dis@x.com' }),
    (err: any) => err.message === 'account_disabled' && err.status === 403
  );

  // StaffDisabled in users
  db._collections.users.set('staff-disabled-1', { role: 'support', staffDisabled: true });
  await assert.rejects(
    resolveManagedAccountRole(db, { uid: 'staff-disabled-1', email: 'sd@x.com' }),
    (err: any) => err.message === 'account_disabled' && err.status === 403
  );

  // Inactive in students
  db._collections.students.set('inactive@x.com', { isActive: false });
  await assert.rejects(
    resolveManagedAccountRole(db, { uid: 'inactive-uid', email: 'inactive@x.com' }),
    (err: any) => err.message === 'account_disabled' && err.status === 403
  );

  // Unregistered
  await assert.rejects(
    resolveManagedAccountRole(db, { uid: 'stranger-uid', email: 'stranger@x.com' }),
    (err: any) => err.message === 'account_not_registered' && err.status === 403
  );
});

await testAsync('createAccountSession is idempotent when retried with same sessionNonce', async () => {
  const db = createMockDb();
  const sessionNonce = crypto.randomUUID();

  // First registration attempt
  const first = await createAccountSession({
    db,
    FieldValue: mockFieldValue,
    uid: 'user-retry-1',
    role: 'student',
    sessionId: sessionNonce,
    device: { name: 'Device A' },
  });

  assert.equal(first.sessionId, sessionNonce);
  assert.equal(first.claims.app_session_id, sessionNonce);
  assert.equal(first.claims.app_session, true);

  // Second registration attempt (simulating client retry after network blip)
  const second = await createAccountSession({
    db,
    FieldValue: mockFieldValue,
    uid: 'user-retry-1',
    role: 'student',
    sessionId: sessionNonce,
    device: { name: 'Device A' },
  });

  assert.equal(second.sessionId, sessionNonce);
  assert.equal(second.generation, first.generation);
  assert.deepEqual(second.claims, first.claims);
});

await testAsync('createAccountSession rejects sessionNonce conflict with different user', async () => {
  const db = createMockDb();
  const sessionNonce = crypto.randomUUID();

  await createAccountSession({
    db,
    FieldValue: mockFieldValue,
    uid: 'user-owner',
    role: 'admin',
    sessionId: sessionNonce,
    device: { name: 'Device A' },
  });

  // Malicious or accidental reuse by a different user
  await assert.rejects(
    createAccountSession({
      db,
      FieldValue: mockFieldValue,
      uid: 'user-imposter',
      role: 'student',
      sessionId: sessionNonce,
      device: { name: 'Device B' },
    }),
    (err: any) => err.message === 'session_nonce_conflict' && err.status === 409
  );
});

console.log(`\nResults: ${passed} passed, 0 failed\n`);

