import {
  firestoreSettings,
  firestoreStreamsEnabled,
  parseFirestoreTransport,
} from '../src/firestoreTransport.ts';
import { statusWriteAllowed } from '../src/statusOwnership.ts';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed += 1;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
    failed += 1;
  }
}

console.log('\nFirestore transport and status ownership');

check('REST is the safe default', parseFirestoreTransport(undefined) === 'rest');
check('REST forces preferRest', firestoreSettings('rest').preferRest === true);
check('REST never attaches snapshot streams', !firestoreStreamsEnabled('rest'));
check('gRPC retains snapshot streams', firestoreStreamsEnabled('grpc'));

let invalidRejected = false;
try {
  parseFirestoreTransport('websocket');
} catch {
  invalidRejected = true;
}
check('an invalid transport fails at boot', invalidRejected);

check('a waiter cannot write status', !statusWriteAllowed(false, false, 0));
check('generation zero cannot write status', !statusWriteAllowed(true, true, 0));
check('a non-holder cannot write status', !statusWriteAllowed(true, false, 12));
check('the active fenced holder can write status', statusWriteAllowed(true, true, 12));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
