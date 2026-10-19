import test from 'node:test';
import assert from 'node:assert/strict';
import { secureRequestId } from '../src/lib/secureRandom';
import {
  attendanceRotationMessage,
  verifyAttendanceKeyRotation,
  deviceFingerprint,
} from '../shared/attendanceDevice';
import { resolveAuthState } from '../src/lib/sessionRestoration';
import { IndexedDbAttendanceRepository } from '../src/services/indexedDbAttendanceRepository';
import { runLosslessAttendanceMigration, MIGRATION_CHECKPOINT_KEY } from '../src/services/attendanceMigration';
import { attendanceFlagLabel } from '../shared/attendanceSecurity';

test('1. secureRequestId generates valid RFC4122 v4 UUID without crypto.randomUUID (iOS 15.0 - 15.3 fallback)', () => {
  // Test normal execution
  const id1 = secureRequestId();
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.match(id1, uuidRegex, 'Normal secureRequestId should be valid UUID v4');

  // Simulate older iOS 15.0-15.3 runtime where crypto.randomUUID is undefined
  const originalCrypto = globalThis.crypto;
  try {
    const fakeCrypto = {
      getRandomValues: (arr: Uint8Array) => originalCrypto.getRandomValues(arr),
      // randomUUID intentionally missing / undefined
    } as any;
    Object.defineProperty(globalThis, 'crypto', { value: fakeCrypto, configurable: true });

    const id2 = secureRequestId();
    assert.match(id2, uuidRegex, 'Fallback secureRequestId must generate valid RFC 4122 UUID v4');
    assert.equal(id2.charAt(14), '4', 'UUID version nibble must be 4');
    assert.ok(['8', '9', 'a', 'b'].includes(id2.charAt(19).toLowerCase()), 'UUID variant nibble must be RFC 4122');
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, configurable: true });
  }
});

test('2. Auth session restoration does not destroy offline entry point when navigator.onLine is true but uplink disconnected', () => {
  // Case: navigator.onLine === true (e.g. captive portal or disconnected uplink),
  // but Firebase auth has not loaded a user yet, and previous signed-in profile exists.
  const outcome = resolveAuthState({
    firebaseUserPresent: false,
    isOnline: true,
    wasSignedIn: true,
    cachedProfileAvailable: true,
  });

  // Must NOT wipe session / persistence
  assert.equal(outcome.status, 'cached-offline', 'Should fall back to cached-offline instead of signing out');
  assert.equal(outcome.clearPersistence, false, 'Must not clear persistence when offline cached profile is available');
  assert.equal(outcome.useCachedProfile, true, 'Must use cached profile');

  // Case: No cached profile available
  const loggedOutOutcome = resolveAuthState({
    firebaseUserPresent: false,
    isOnline: true,
    wasSignedIn: false,
    cachedProfileAvailable: false,
  });
  assert.equal(loggedOutOutcome.status, 'signed-out');
  assert.equal(loggedOutOutcome.clearPersistence, true, 'Absence of prior session clears persistence');
});

test('3. Key rotation challenge message verification & device alias continuity', async () => {
  process.env.ATTENDANCE_INSTALLATION_SECRET = 'test-secret-at-least-32-chars-long-for-hmac';

  // Generate old keypair (WebCrypto)
  const oldPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const oldPubJwk = await crypto.subtle.exportKey('jwk', oldPair.publicKey);

  // Generate new keypair (Native)
  const newPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const newPubJwk = await crypto.subtle.exportKey('jwk', newPair.publicKey);

  const challengeId = 'chal-12345';
  const nonce = 'nonce-abcdef';
  const uid = 'student-test-uid';

  const message = attendanceRotationMessage({
    actorUid: uid,
    challengeId,
    nonce,
    oldFingerprint: deviceFingerprint(oldPubJwk),
    newFingerprint: deviceFingerprint(newPubJwk),
  });

  const encoder = new TextEncoder();
  const oldRawSig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    oldPair.privateKey,
    encoder.encode(message)
  );
  const newRawSig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    newPair.privateKey,
    encoder.encode(message)
  );

  const toBase64Url = (buf: ArrayBuffer) =>
    Buffer.from(buf).toString('base64url');

  const oldSignature = toBase64Url(oldRawSig);
  const newSignature = toBase64Url(newRawSig);

  // Verify key rotation with correct signatures
  const result = verifyAttendanceKeyRotation({
    actorUid: uid,
    challengeId,
    nonce,
    oldKey: oldPubJwk,
    newKey: newPubJwk,
    oldSignature,
    newSignature,
  });
  assert.ok(result.oldDeviceDigest, 'Should return old device digest');
  assert.ok(result.newDeviceDigest, 'Should return new device digest');

  // Verify tampering with challengeId fails
  assert.throws(
    () =>
      verifyAttendanceKeyRotation({
        actorUid: uid,
        challengeId: 'chal-tampered',
        nonce,
        oldKey: oldPubJwk,
        newKey: newPubJwk,
        oldSignature,
        newSignature,
      }),
    /invalid_old_signature/
  );
});

test('4. attendanceFlagLabel formats late_arrival correctly in Arabic and English', () => {
  const arLabel = attendanceFlagLabel('late_arrival', true);
  const enLabel = attendanceFlagLabel('late_arrival', false);

  assert.ok(arLabel.includes('متأخر'), 'Arabic label should mention late arrival');
  assert.ok(enLabel.toLowerCase().includes('late'), 'English label should mention late arrival');
});

test('5. Android WebView version detection handles versions below and above minimum 108', () => {
  const getVersionFromUA = (ua: string): number | null => {
    const match = ua.match(/Chrome\/(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  };

  // Old WebView (Chrome 95 on Android 8)
  const oldUa = 'Mozilla/5.0 (Linux; U; Android 8.0.0; en-us; Build/OPR6.170623.013) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/95.0.4638.74 Mobile Safari/537.36';
  const oldVersion = getVersionFromUA(oldUa);
  assert.equal(oldVersion, 95);
  assert.ok(oldVersion < 108, 'Should detect version below 108');

  // Supported minimum (Chrome 108)
  const minUa = 'Mozilla/5.0 (Linux; Android 10; SM-A205U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.5359.128 Mobile Safari/537.36';
  const minVersion = getVersionFromUA(minUa);
  assert.equal(minVersion, 108);
  assert.ok(minVersion >= 108, 'Should accept version 108');

  // Modern WebView (Chrome 130+)
  const modernUa = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.135 Mobile Safari/537.36';
  const modernVersion = getVersionFromUA(modernUa);
  assert.equal(modernVersion, 131);
  assert.ok(modernVersion >= 108, 'Should accept modern version');
});

test('6. StorageHealth contract distinguishes native durable storage from web indexeddb', async () => {
  const indexedRepo = new IndexedDbAttendanceRepository();
  const health = await indexedRepo.getHealth('');
  assert.equal(health.storageType, 'indexeddb');
  assert.equal(health.isDurable, false, 'Web IndexedDB must report isDurable: false per specification');
});

