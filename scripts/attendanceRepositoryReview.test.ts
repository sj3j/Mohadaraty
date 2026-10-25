import assert from 'node:assert/strict';
import { test } from 'node:test';
import 'fake-indexeddb/auto';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { dbPut, STORE_META, STORE_ATTENDANCE_OUTBOX } from '../src/lib/localDb';
import { IndexedDbAttendanceRepository } from '../src/services/indexedDbAttendanceRepository';

test('UID-scoped metadata cannot fall back to another account', async () => {
  await dbPut(STORE_META, { key: 'review-private-profile', ownerUid: 'alice', data: { secret: 'alice' } });
  const repo = new IndexedDbAttendanceRepository();
  assert.equal(await repo.getMetadata('review-private-profile', 'bob'), null);
  assert.deepEqual(await repo.getMetadata('review-private-profile', 'alice'), { secret: 'alice' });
});

test('acknowledgements persist record identity and voided state', async () => {
  const repo = new IndexedDbAttendanceRepository();
  await dbPut(STORE_ATTENDANCE_OUTBOX, {
    requestId: 'review-ack', ownerUid: 'alice', sessionId: 'ack-session',
    status: 'pending', savedAt: 1, updatedAt: 1, attemptCount: 0,
  });
  const batch = await repo.acquireUploadLease('alice');
  await repo.acknowledgeBatch(batch.leaseId, [{
    requestId: 'review-ack', resolution: 'needs_review', reason: 'record_voided',
    recordId: 'record-1', recordRevision: 4, recordStatus: 'voided',
  } as any]);
  const receipt = await repo.getReceipt('review-ack');
  assert.equal(receipt?.recordId, 'record-1');
  assert.equal(receipt?.recordStatus, 'voided');
  assert.equal(receipt?.recordRevision, 4);
});

test('parallel uploaders cannot lease the same evidence', async () => {
  const repo = new IndexedDbAttendanceRepository();
  await dbPut(STORE_ATTENDANCE_OUTBOX, {
    requestId: 'review-lease', ownerUid: 'lease-owner', sessionId: 'lease-session',
    status: 'pending', savedAt: 1, updatedAt: 1, attemptCount: 0,
  });
  const batches = await Promise.all([repo.acquireUploadLease('lease-owner'), repo.acquireUploadLease('lease-owner')]);
  assert.equal(batches.flatMap(batch => batch.receipts).length, 1);
});

test('acknowledging a doctor command preserves its order', async () => {
  const repo = new IndexedDbAttendanceRepository();
  const command = { requestId: 'review-command', ownerUid: 'doctor', status: 'pending' };
  await repo.commitDoctorSession({ meta: { key: 'review-snapshot', data: {} }, command });
  const first = (await repo.listDoctorCommands('doctor'))[0];
  await repo.commitDoctorSession({ meta: { key: 'review-snapshot', data: {} }, command: { ...first, status: 'synced' } });
  const updated = (await repo.listDoctorCommands('doctor'))[0];
  assert.equal(updated.localOrder, first.localOrder);
});

test('two lecturer sessions retain separate QR imports, counts, and close commands after repository reopen', async () => {
  const ownerUid = 'doctor-two-sessions';
  const repo = new IndexedDbAttendanceRepository();
  for (const sessionId of ['lecture-a', 'lecture-b']) {
    await repo.commitDoctorSession({
      meta: { key: `attendance-doctor:${ownerUid}:${sessionId}`, data: { session: { id: sessionId, physicalHeadcount: null, status: 'active' } } },
      command: { kind: 'import', requestId: `import-${sessionId}`, ownerUid, sessionId, input: { qrToken: `static-qr-${sessionId}` }, status: 'pending' },
    });
    await repo.enqueueDoctorCommand({ kind: 'session_update', requestId: `count-${sessionId}`, ownerUid, sessionId,
      input: { physicalHeadcount: sessionId === 'lecture-a' ? 25 : 40 }, status: 'pending' });
    await repo.enqueueDoctorCommand({ kind: 'session_update', requestId: `close-${sessionId}`, ownerUid, sessionId,
      input: { status: 'ended' }, status: 'pending' });
  }
  const reopened = new IndexedDbAttendanceRepository();
  const commands = await reopened.listDoctorCommands(ownerUid);
  for (const sessionId of ['lecture-a', 'lecture-b']) {
    const own = commands.filter(command => command.sessionId === sessionId).sort((a, b) => (a.localOrder || 0) - (b.localOrder || 0));
    assert.deepEqual(own.map(command => command.kind), ['import', 'session_update', 'session_update']);
    assert.equal(own[0].input.qrToken, `static-qr-${sessionId}`);
    assert.equal(own[2].input.status, 'ended');
    assert.equal((await reopened.getMetadata<{ session: { id: string } }>(`attendance-doctor:${ownerUid}:${sessionId}`, ownerUid))?.session.id, sessionId);
  }
});

test('native initialization rejects unavailable storage and can retry', async () => {
  let healthy = false;
  registerPlugin('AttendanceStorage', {
    web: async () => ({
      initialize: async () => ({
        healthState: healthy ? 'ready' : 'unavailable',
        isDurable: healthy,
        legacyMigrationPending: false,
      }),
    }),
  });
  const original = Capacitor.isNativePlatform;
  Capacitor.isNativePlatform = () => true;
  try {
    const { ensureAttendanceInitialized } = await import('../src/services/attendanceMigration');
    await assert.rejects(ensureAttendanceInitialized(), /attendance_storage_unavailable/);
    healthy = true;
    await ensureAttendanceInitialized();
  } finally {
    Capacitor.isNativePlatform = original;
  }
});
