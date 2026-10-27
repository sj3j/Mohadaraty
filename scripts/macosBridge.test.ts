import assert from 'node:assert/strict';
import fs from 'node:fs';

const bridge = fs.readFileSync('src/macos/macBridge.ts', 'utf8');
const repository = fs.readFileSync('src/macos/macAttendanceRepository.ts', 'utf8');
const factory = fs.readFileSync('src/services/attendanceRepositoryFactory.ts', 'utf8');

assert.match(bridge, /MAC_BRIDGE_VERSION = 1/);
for (const service of ['environment', 'attendance', 'files', 'presentation']) {
  assert.ok(bridge.includes(`'${service}'`), `bridge service missing: ${service}`);
}
for (const method of [
  'initialize', 'capture', 'listReceipts', 'getReceipt', 'commitDoctorSession',
  'enqueueDoctorCommand', 'listDoctorCommands', 'updateDoctorCommand',
  'updateReceipt', 'transitionReceipt', 'acquireUploadLease', 'acknowledgeBatch',
  'releaseUploadLease', 'getMetadata', 'setMetadata', 'deleteMetadata',
  'recoverInterruptedWork', 'getHealth', 'getPublicIdentity', 'signReceipt',
  'signDoctorQr', 'signRotationMessage',
]) {
  assert.ok(repository.includes(`'${method}'`), `Mac repository method missing: ${method}`);
}
assert.match(factory, /if \(IS_MACOS_BUILD\)/);
assert.match(factory, /requireMacRuntime\(\)/);
console.log('macOS bridge contract audit passed.');

