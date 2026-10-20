import assert from 'node:assert/strict';
import { test } from 'node:test';
import 'fake-indexeddb/auto';
import { canonicalAttendanceState, type LocalAttendanceReceipt } from '../shared/attendance';
import { summarizeAttendanceTelemetry } from '../shared/attendanceSecurity';
import { AL_SAFWA_CAMPUS, calculateCampusDistance } from '../shared/campusLocation';
import { commitAttendanceCapture, getAttendanceReceipt, openDb } from '../src/lib/localDb';

function receipt(ownerUid: string, sessionId: string): LocalAttendanceReceipt {
  return {
    requestId: crypto.randomUUID(), ownerUid, sessionId, occurrenceId: sessionId,
    stageId: 'stage_3', qrToken: crypto.randomUUID(), installationId: 'fixture-installation',
    occurrence: { id: sessionId, stageId: 'stage_3', lectureDate: '2026-10-15', title: 'Lecture', startTime: '09:00', endTime: '10:00' },
    savedAt: 1, updatedAt: 1, status: 'pending', attemptCount: 0,
  };
}

test('one installation may capture the same student in three lectures', async () => {
  for (const sessionId of ['lecture-a', 'lecture-b', 'lecture-c']) {
    const result = await commitAttendanceCapture(receipt('student-a', sessionId));
    assert.equal(result.receipt.localDeviceConflict, false);
    assert.ok(await getAttendanceReceipt(result.receipt.requestId));
  }
});

test('concurrent accounts cannot both acquire a lecture lock', async () => {
  const results = await Promise.all([
    commitAttendanceCapture(receipt('student-a', 'concurrent-session')),
    commitAttendanceCapture(receipt('student-b', 'concurrent-session')),
  ]);
  assert.equal(results.filter(result => !result.receipt.localDeviceConflict).length, 1);
  const conflict = results.find(result => result.receipt.localDeviceConflict)!;
  assert.equal(canonicalAttendanceState(undefined, conflict.receipt), 'manual_required');
  assert.ok(await getAttendanceReceipt(conflict.receipt.requestId));
});

test('same-account rescan is idempotent without locking the next lecture', async () => {
  const first = await commitAttendanceCapture(receipt('student-a', 'retry-session'));
  const retry = await commitAttendanceCapture(receipt('student-a', 'retry-session'));
  assert.equal(retry.alreadySaved, true);
  assert.equal(retry.receipt.requestId, first.receipt.requestId);
  const later = await commitAttendanceCapture(receipt('student-a', 'next-session'));
  assert.equal(later.receipt.localDeviceConflict, false);
});

test('confirmed acknowledgement survives missing schedule response', () => {
  const saved = { ...receipt('student-a', 'confirmed-session'), status: 'confirmed' as const, recordId: 'record-1', recordStatus: 'confirmed' as const, recordRevision: 2 };
  assert.equal(canonicalAttendanceState(undefined, saved), 'confirmed');
});

test('upload-time coordinates never become scan-location evidence', () => {
  const result = summarizeAttendanceTelemetry({ location: { state: 'available', phase: 'upload', latitude: 0, longitude: 0, accuracyMeters: 1 } });
  assert.equal(result.flags.includes('reported_off_campus'), false);
  assert.equal(result.reportedDistanceMeters, undefined);
});

test('GPS failure and rapid reconnect are advisory; no trusted scan time exists', () => {
  const result = summarizeAttendanceTelemetry({ capturedOffline: true, sameRuntimeElapsedSeconds: 45, location: { state: 'permission_unavailable', phase: 'scan' } });
  assert.ok(result.flags.includes('rapid_reconnect'));
  assert.ok(result.flags.includes('location_permission_unavailable'));
  assert.equal(result.timingConfidence, 'untrusted_same_runtime');
  assert.equal('trueScanTime' in result, false);
  assert.equal(summarizeAttendanceTelemetry({ capturedOffline: true }).timingConfidence, 'unknown');
});

test('off-campus flag respects accuracy and does not retain coordinates', () => {
  const outside = summarizeAttendanceTelemetry({ location: { state: 'available', phase: 'scan', latitude: 33.4, longitude: 44.3, accuracyMeters: 20 } });
  assert.ok(outside.flags.includes('reported_off_campus'));
  assert.equal('latitude' in outside, false);
  const uncertain = summarizeAttendanceTelemetry({ location: { state: 'available', phase: 'scan', latitude: 33.31, longitude: 44.3, accuracyMeters: 2000 } });
  assert.equal(uncertain.flags.includes('reported_off_campus'), true);
});

test('Al-Safwa campus distance uses the exact centre and capped indoor allowance', () => {
  assert.deepEqual(calculateCampusDistance(AL_SAFWA_CAMPUS.lat, AL_SAFWA_CAMPUS.lng), {
    distanceMeters: 0, accuracyMeters: 0, locationStatus: 'on_campus',
  });
  const latitudeAt500m = AL_SAFWA_CAMPUS.lat + 500 / 111195;
  assert.equal(calculateCampusDistance(latitudeAt500m, AL_SAFWA_CAMPUS.lng, 49).locationStatus, 'off_campus');
  assert.equal(calculateCampusDistance(latitudeAt500m, AL_SAFWA_CAMPUS.lng, 50).locationStatus, 'on_campus');
  const latitudeAt601m = AL_SAFWA_CAMPUS.lat + 601 / 111195;
  assert.equal(calculateCampusDistance(latitudeAt601m, AL_SAFWA_CAMPUS.lng, 5000).locationStatus, 'off_campus');
});

test('invalid campus coordinates are rejected', () => {
  for (const values of [[NaN, 44, 1], [91, 44, 1], [32, 181, 1], [32, 44, -1]] as const) {
    assert.throws(() => calculateCampusDistance(values[0], values[1], values[2]), /invalid_campus_coordinates/);
  }
});

test('server summary recomputes coordinates and accepts native indoor timeout without a distance', () => {
  const offCampus = summarizeAttendanceTelemetry({
    location: {
      state: 'available', phase: 'scan', latitude: 33, longitude: 44,
      accuracyMeters: 5, distanceMeters: 0, locationStatus: 'on_campus',
    },
  });
  assert.equal(offCampus.locationStatus, 'off_campus');
  assert.ok(offCampus.reportedDistanceMeters && offCampus.reportedDistanceMeters > 1000);
  const indoor = summarizeAttendanceTelemetry({ location: { state: 'gps_on_indoor_timeout', phase: 'scan', locationStatus: 'gps_on_indoor_timeout' } });
  assert.equal(indoor.locationStatus, 'gps_on_indoor_timeout');
  assert.equal(indoor.reportedDistanceMeters, undefined);
});

test('invalid timing telemetry stays unknown', () => {
  for (const duration of [-1, Infinity, '20', NaN]) {
    assert.equal(summarizeAttendanceTelemetry({ sameRuntimeElapsedSeconds: duration }).timingConfidence, 'unknown');
  }
});

test.after(async () => { (await openDb()).close(); });
