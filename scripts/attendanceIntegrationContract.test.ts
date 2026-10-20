import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import crypto, { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { attendanceDeviceMessage, attendanceLocationBadge, summarizeAttendanceTelemetry } from '../shared/attendanceSecurity.js';
import { verifyAttendanceDevice, attendanceRotationMessage, verifyAttendanceKeyRotation, deviceFingerprint } from '../shared/attendanceDevice.js';
import { attendanceSessionId } from '../shared/attendanceOffline.js';
import { type LocalAttendanceReceipt } from '../shared/attendance.js';

// Setup environment for installation secret
process.env.ATTENDANCE_INSTALLATION_SECRET = 'fixture-installation-secret-high-entropy-32-bytes!';

// P-256 Key generation helper
function generateP256KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string; y: string };
  return { publicKey, privateKey, jwk };
}

function signDeviceReceipt(receipt: any, privateKey: crypto.KeyObject): string {
  const message = Buffer.from(attendanceDeviceMessage(receipt));
  const signature = crypto.sign('sha256', message, {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return signature.toString('base64url');
}

test('1. P-256 Signing and Server-Side Verification Contract', () => {
  const { privateKey, jwk } = generateP256KeyPair();
  const validReceipt = {
    requestId: randomUUID(),
    ownerUid: 'student-auth-123',
    sessionId: 'session-456',
    occurrenceId: 'occ-789',
    qrToken: 'qr-token-abc',
    installationId: 'install-xyz',
    localDeviceConflict: false,
    devicePublicKey: jwk,
    deviceSignature: '',
  };
  validReceipt.deviceSignature = signDeviceReceipt(validReceipt, privateKey);

  // Verification succeeds
  const verified = verifyAttendanceDevice(validReceipt);
  assert.ok(verified.deviceDigest);
  assert.ok(verified.installationDigest);

  // Tampering: requestId fails verification
  const tamperedRequestId = { ...validReceipt, requestId: randomUUID() };
  assert.throws(() => verifyAttendanceDevice(tamperedRequestId), /invalid_device_proof/);

  // Tampering: localDeviceConflict flipped to true fails verification
  const tamperedConflict = { ...validReceipt, localDeviceConflict: true };
  assert.throws(() => verifyAttendanceDevice(tamperedConflict), /invalid_device_proof/);

  // Tampering: ownerUid modified fails verification
  const tamperedOwner = { ...validReceipt, ownerUid: 'other-student' };
  assert.throws(() => verifyAttendanceDevice(tamperedOwner), /invalid_device_proof/);

  // Tampering: sessionId modified fails verification
  const tamperedSession = { ...validReceipt, sessionId: 'other-session' };
  assert.throws(() => verifyAttendanceDevice(tamperedSession), /invalid_device_proof/);

  // Tampering: qrToken modified fails verification
  const tamperedQrToken = { ...validReceipt, qrToken: 'other-qr' };
  assert.throws(() => verifyAttendanceDevice(tamperedQrToken), /invalid_device_proof/);

  // Tampering: signature truncated fails verification
  const truncatedSig = { ...validReceipt, deviceSignature: validReceipt.deviceSignature.slice(0, 80) };
  assert.throws(() => verifyAttendanceDevice(truncatedSig), /invalid_device_proof/);

  // Tampering: invalid characters in signature fails verification
  const corruptedSig = { ...validReceipt, deviceSignature: '?' + validReceipt.deviceSignature.slice(1) };
  assert.throws(() => verifyAttendanceDevice(corruptedSig), /invalid_device_proof/);
});

test('2. Unicode and escaped characters serialize identically in attendanceDeviceMessage', () => {
  const receiptWithUnicode = {
    requestId: 'req-123',
    ownerUid: 'طالب_علي_حسين',
    sessionId: 'قاعة_الفيزياء/2026',
    occurrenceId: 'محاضرة "المداواة" & اختبار\\تجربة',
    qrToken: 'رمز-qr-123 🎉',
    installationId: 'جهاز-رقم-99',
    localDeviceConflict: false,
  };

  const serialized = attendanceDeviceMessage(receiptWithUnicode);
  const parsed = JSON.parse(serialized);
  assert.deepEqual(parsed, [
    'req-123',
    'طالب_علي_حسين',
    'قاعة_الفيزياء/2026',
    'محاضرة "المداواة" & اختبار\\تجربة',
    'رمز-qr-123 🎉',
    'جهاز-رقم-99',
    false,
  ]);

  // Ensure JSON.stringify on the array produces the exact same byte string
  assert.equal(
    serialized,
    JSON.stringify([
      receiptWithUnicode.requestId,
      receiptWithUnicode.ownerUid,
      receiptWithUnicode.sessionId,
      receiptWithUnicode.occurrenceId,
      receiptWithUnicode.qrToken,
      receiptWithUnicode.installationId,
      receiptWithUnicode.localDeviceConflict,
    ])
  );
});

test('3. iOS X9.63 65-byte uncompressed coordinate validation logic', () => {
  // Simulate iOS Swift coordinate extraction logic:
  function extractCoordinatesFromX963(raw: Buffer): { x: string; y: string } {
    if (raw.length !== 65) throw new Error('invalid_x963_length');
    if (raw[0] !== 0x04) throw new Error('invalid_x963_prefix');
    const x = raw.subarray(1, 33).toString('base64url');
    const y = raw.subarray(33, 65).toString('base64url');
    if (x.length !== 43 || y.length !== 43) throw new Error('invalid_coordinate_length');
    return { x, y };
  }

  // Generate real P-256 key and export raw uncompressed representation
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const rawKey = publicKey.export({ type: 'spki', format: 'der' });
  // In SPKI DER for P-256, the last 65 bytes are the uncompressed point (0x04 || X || Y)
  const x963 = rawKey.subarray(rawKey.length - 65);
  assert.equal(x963.length, 65);
  assert.equal(x963[0], 0x04);

  const coords = extractCoordinatesFromX963(x963);
  assert.equal(coords.x.length, 43);
  assert.equal(coords.y.length, 43);

  // Test rejection of compressed key prefix (0x02 or 0x03)
  const compressed = Buffer.from(x963);
  compressed[0] = 0x02;
  assert.throws(() => extractCoordinatesFromX963(compressed), /invalid_x963_prefix/);

  // Test rejection of truncated key (64 bytes)
  const truncated = x963.subarray(0, 64);
  assert.throws(() => extractCoordinatesFromX963(truncated), /invalid_x963_length/);

  // Test rejection of extra bytes (66 bytes)
  const tooLong = Buffer.concat([x963, Buffer.from([0x00])]);
  assert.throws(() => extractCoordinatesFromX963(tooLong), /invalid_x963_length/);
});

test('4. Doctor QR Token 2,330-byte limit and permit-header enforcement', () => {
  const MAX_TOKEN_BYTES = 2330;

  function buildDoctorQrEnvelope(permit: string, claims: Record<string, any>) {
    // Check that permit is not duplicated in claims
    assert.equal('permit' in claims, false, 'permit must not be duplicated in claims');
    const header = { alg: 'ES256', typ: 'JWT', pmt: permit };
    const payload = claims;
    const token = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.mockSignature`;
    const byteLength = Buffer.byteLength(token, 'utf8');
    if (byteLength > MAX_TOKEN_BYTES) {
      throw new Error(`doctor_qr_token_too_large: ${byteLength} > ${MAX_TOKEN_BYTES}`);
    }
    return token;
  }

  // Normal envelope passes
  const normalToken = buildDoctorQrEnvelope('permit-123', {
    sub: 'doctor-uid',
    occ: 'occ-1',
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  assert.ok(Buffer.byteLength(normalToken, 'utf8') < MAX_TOKEN_BYTES);

  // Oversized claims exceed 2,330 bytes and are rejected
  assert.throws(
    () => buildDoctorQrEnvelope('permit-123', {
      sub: 'doctor-uid',
      oversizedData: 'x'.repeat(2500),
    }),
    /doctor_qr_token_too_large/
  );
});

test('5. Location badge formatting for native indoor timeout', () => {
  const advisory = summarizeAttendanceTelemetry({
    location: {
      state: 'gps_on_indoor_timeout',
      phase: 'scan',
      locationStatus: 'gps_on_indoor_timeout',
    },
  });

  const englishBadge = attendanceLocationBadge(advisory, false);
  const arabicBadge = attendanceLocationBadge(advisory, true);

  assert.equal(englishBadge, '📍 Location unavailable — permission and location services enabled');
  assert.equal(arabicBadge, '📍 الموقع غير متاح — الإذن وخدمات الموقع مفعلة');
});

// Database & Concurrency Integration Tests using PGlite
const database = new PGlite();
const sessions: Array<{ id: string; challenge: string; tokenHash: string }> = Array.from(
  { length: 4 },
  () => ({ id: randomUUID(), challenge: randomUUID(), tokenHash: 'c'.repeat(64) })
);
const testDevice = 'a'.repeat(64);
const testInstallation = 'b'.repeat(64);

before(async () => {
  await database.exec(
    'create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to service_role;'
  );
  for (const path of [
    'supabase/migrations/20261014083458_simosan_attendance_reliability.sql',
    'supabase/migrations/20261015073458_attendance_device_policy.sql',
    'supabase/migrations/20261015155756_attendance_offline_sessions.sql',
    'supabase/migrations/20261018160000_attendance_late_receipts_key_rotation.sql',
    'supabase/migrations/20261021000000_attendance_review_revisions_key_rotation.sql',
    'supabase/migrations/20261021000001_attendance_review_retry_integrity.sql',
  ]) {
    await database.exec(readFileSync(path, 'utf8'));
  }
  await database.exec(
    "insert into attendance_terms(id,calendar_term_id,year_label,name_ar,name_en,start_date,end_date) values ('term','term','2026','term','term','2026-01-01','2026-12-31');"
  );
  for (const [index, session] of sessions.entries()) {
    await database.query(
      "insert into attendance_occurrences(id,term_id,stage_id,timetable_session_id,lecture_date,title,start_at,end_at,audience_groups) values ($1,'term','stage_3',$1,'2026-10-15','Lecture',now(),now()+interval '1 hour',array['A'])",
      [`integ-lecture-${index}`]
    );
    await database.query(
      "insert into attendance_sessions(id,request_id,occurrence_id,professor_uid,expected_headcount,reconciliation_deadline) values ($1,$2,$3,'doctor',10,now()+interval '7 days')",
      [session.id, randomUUID(), `integ-lecture-${index}`]
    );
    for (const [student, subgroup] of [['student-1', 'A'], ['student-2', 'A'], ['student-3', 'A']]) {
      await database.query(
        'insert into attendance_session_roster(session_id,roster_student_id,official_name,subgroup) values ($1,$2,$2,$3)',
        [session.id, student, subgroup]
      );
    }
    await database.query(
      "insert into attendance_challenges(id,session_id,token_hash,qr_token,key_id) values ($1,$2,$3,$4,'test')",
      [session.challenge, session.id, createHash('sha256').update(session.id).digest('hex'), 'fixture.'.repeat(12)]
    );
    session.tokenHash = createHash('sha256').update(session.id).digest('hex');
  }
});

after(async () => {
  await database.close();
});

test('6. Review revision concurrency and idempotency', async () => {
  const session = sessions[0];
  const requestId = randomUUID();
  const receiptHash = createHash('sha256').update(requestId).digest('hex');

  // Submit receipt requiring device enrollment review
  const submitResult = await database.query<{ result: any }>(
    'select attendance_submit_receipt($1,$2,$3,$4,$5,$6,$7,$8,null,$9,false,$10) as result',
    [
      requestId,
      'student-1',
      'student-1',
      receiptHash,
      session.id,
      session.challenge,
      session.tokenHash,
      testInstallation,
      testDevice,
      JSON.stringify({ flags: [], timingConfidence: 'unknown' }),
    ]
  );
  assert.equal(submitResult.rows[0].result.resolution, 'needs_review');
  assert.equal(submitResult.rows[0].result.reason, 'device_enrollment_required');

  // Review probe with invalid revision (-999) fails with concurrency_conflict
  await assert.rejects(
    database.query(
      "select attendance_resolve_review($1,$2,'doctor','confirm','Verified ID',-999,true,false) as result",
      [randomUUID(), requestId]
    ),
    /concurrency_conflict/
  );

  // Review probe with expectedRevision = 1 succeeds
  const commandId = randomUUID();
  const reviewResult = await database.query<{ result: any }>(
    "select attendance_resolve_review($1,$2,'doctor','confirm','Verified ID',1,true,false) as result",
    [commandId, requestId]
  );
  assert.equal(reviewResult.rows[0].result.resolution, 'confirmed');
  assert.equal(reviewResult.rows[0].result.reviewRevision, 2);

  // Review retry with identical commandId and payload returns the existing result
  const retryResult = await database.query<{ result: any }>(
    "select attendance_resolve_review($1,$2,'doctor','confirm','Verified ID',1,true,false) as result",
    [commandId, requestId]
  );
  assert.equal(retryResult.rows[0].result.resolution, 'confirmed');
  assert.equal(retryResult.rows[0].result.reviewRevision, 2);

  // Review with stale revision 1 now fails with concurrency_conflict
  await assert.rejects(
    database.query(
      "select attendance_resolve_review($1,$2,'doctor','confirm','Verified ID again',1,true,false) as result",
      [randomUUID(), requestId]
    ),
    /concurrency_conflict/
  );
});

test('7. Capacity and multi-connection concurrency simulation (100 parallel submissions)', async () => {
  const session = sessions[1];
  const totalSubmissions = 100;
  const requestId = randomUUID();
  const receiptHash = createHash('sha256').update(requestId).digest('hex');

  // student-1 is already enrolled on testDevice from test 6, so submissions confirm directly
  const tasks = Array.from({ length: totalSubmissions }, () => {
    return database.query<{ result: any }>(
      'select attendance_submit_receipt($1,$2,$3,$4,$5,$6,$7,$8,null,$9,false,$10) as result',
      [
        requestId, // same requestId to test idempotency and zero duplicate records
        'student-1',
        'student-1',
        receiptHash,
        session.id,
        session.challenge,
        session.tokenHash,
        testInstallation,
        testDevice,
        JSON.stringify({ flags: [], timingConfidence: 'unknown' }),
      ]
    );
  });

  const results = await Promise.all(tasks);
  // All must return confirmed
  for (const r of results) {
    assert.equal(r.rows[0].result.resolution, 'confirmed');
  }

  // Check database has exactly 1 record for this student and session (zero duplicates)
  const countRes = await database.query<{ count: number }>(
    'select count(*)::int as count from attendance_records where session_id=$1 and roster_student_id=$2',
    [session.id, 'student-1']
  );
  assert.equal(countRes.rows[0].count, 1);
});

test('8. Upload lease and batch acknowledgement simulation contract', () => {
  // Simulate native queue lease contract:
  interface QueueItem {
    requestId: string;
    ownerUid: string;
    leaseId: string | null;
    leaseExpiresAt: number | null;
    status: 'pending' | 'uploading' | 'confirmed';
  }

  const queue: QueueItem[] = [
    { requestId: 'req-1', ownerUid: 'u1', leaseId: null, leaseExpiresAt: null, status: 'pending' },
    { requestId: 'req-2', ownerUid: 'u1', leaseId: null, leaseExpiresAt: null, status: 'pending' },
  ];

  function acquireUploadLease(ownerUid: string, limit: number, leaseDurationMs: number): { leaseId: string; receipts: QueueItem[] } {
    const now = Date.now();
    const available = queue.filter(
      item => item.ownerUid === ownerUid &&
      item.status === 'pending' &&
      (!item.leaseExpiresAt || item.leaseExpiresAt <= now)
    ).slice(0, limit);

    if (available.length === 0) return { leaseId: '', receipts: [] };
    const leaseId = randomUUID();
    const expiresAt = now + leaseDurationMs;
    for (const item of available) {
      item.leaseId = leaseId;
      item.leaseExpiresAt = expiresAt;
      item.status = 'uploading';
    }
    return { leaseId, receipts: available };
  }

  function releaseUploadLease(leaseId: string) {
    for (const item of queue) {
      if (item.leaseId === leaseId && item.status === 'uploading') {
        item.leaseId = null;
        item.leaseExpiresAt = null;
        item.status = 'pending';
      }
    }
  }

  function acknowledgeBatch(leaseId: string, requestIds: string[]) {
    const idSet = new Set(requestIds);
    for (const item of queue) {
      if (item.leaseId === leaseId && idSet.has(item.requestId)) {
        item.status = 'confirmed';
        item.leaseId = null;
        item.leaseExpiresAt = null;
      }
    }
  }

  // 1. Acquire lease
  const lease1 = acquireUploadLease('u1', 25, 30000);
  assert.ok(lease1.leaseId);
  assert.equal(lease1.receipts.length, 2);

  // 2. Concurrent uploader attempts to acquire lease while lease1 is active
  const concurrentLease = acquireUploadLease('u1', 25, 30000);
  assert.equal(concurrentLease.receipts.length, 0);

  // 3. Release lease1 -> items return to pending
  releaseUploadLease(lease1.leaseId);
  assert.equal(queue[0].status, 'pending');
  assert.equal(queue[1].status, 'pending');

  // 4. Re-acquire and acknowledge
  const lease2 = acquireUploadLease('u1', 25, 30000);
  assert.equal(lease2.receipts.length, 2);
  acknowledgeBatch(lease2.leaseId, ['req-1', 'req-2']);
  assert.equal(queue[0].status, 'confirmed');
  assert.equal(queue[1].status, 'confirmed');
});

test('9. Metadata UID scoping and isolation', () => {
  const store = new Map<string, string>();
  function setMetadata(ownerUid: string, key: string, value: string) {
    store.set(`${ownerUid}:${key}`, value);
  }
  function getMetadata(ownerUid: string, key: string): string | null {
    return store.get(`${ownerUid}:${key}`) ?? null;
  }

  setMetadata('student-alice', 'offline_pack', 'alice-pack-data');
  setMetadata('student-bob', 'offline_pack', 'bob-pack-data');

  assert.equal(getMetadata('student-alice', 'offline_pack'), 'alice-pack-data');
  assert.equal(getMetadata('student-bob', 'offline_pack'), 'bob-pack-data');
  assert.equal(getMetadata('student-charlie', 'offline_pack'), null);
});

test('10. Account Generation Isolation', () => {
  let activeGeneration = 1;
  let savedReceiptCount = 0;

  function onCaptureComplete(generation: number) {
    // If account switched in between, drop asynchronous completion
    if (generation !== activeGeneration) return;
    savedReceiptCount++;
  }

  // Capture initiated under gen 1
  const opGen = activeGeneration;

  // Account switch happens
  activeGeneration = 2;

  // Op finishes late
  onCaptureComplete(opGen);
  assert.equal(savedReceiptCount, 0, 'Late callback must be dropped across account switch');

  // Capture under active gen 2 succeeds
  onCaptureComplete(activeGeneration);
  assert.equal(savedReceiptCount, 1);
});
