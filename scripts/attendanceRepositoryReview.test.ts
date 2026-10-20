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
