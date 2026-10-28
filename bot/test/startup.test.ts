import {
  LeaseWaitAbortedError,
  leaseRetryDelayMs,
  waitForLease,
  type LeaseWaitEvent,
} from '../src/leaseStartup.ts';
import { leaseUnavailableReason, type LeaseAcquireResult } from '../src/state.ts';

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

function sequence(results: LeaseAcquireResult[]): () => Promise<LeaseAcquireResult> {
  let index = 0;
  return async () => results[Math.min(index++, results.length - 1)];
}

console.log('\nLease startup recovery');

const permissionWaits: LeaseWaitEvent[] = [];
const permissionSleeps: number[] = [];
const recoveredGeneration = await waitForLease({
  acquire: sequence([
    { status: 'LEASE_PERMISSION_DENIED', error: new Error('403') },
    { status: 'LEASE_ACQUIRED', generation: 8 },
  ]),
  shouldContinue: () => true,
  random: () => 0,
  sleep: async ms => { permissionSleeps.push(ms); },
  onWait: event => { permissionWaits.push(event); },
});
check('a Firestore 403 keeps startup alive until access recovers', recoveredGeneration === 8);
check('permission failures retry at a bounded one-minute interval',
  permissionSleeps[0] === 60_000 && permissionWaits[0]?.status === 'LEASE_PERMISSION_DENIED');
check('health names an IAM denial explicitly',
  leaseUnavailableReason('LEASE_PERMISSION_DENIED') === 'lease_permission_denied');

const transportSleeps: number[] = [];
await waitForLease({
  acquire: sequence([
    {
      status: 'LEASE_TRANSPORT_DENIED',
      error: new Error('7 PERMISSION_DENIED: Received HTTP status code 403'),
    },
    { status: 'LEASE_ACQUIRED', generation: 10 },
  ]),
  shouldContinue: () => true,
  random: () => 0,
  sleep: async ms => { transportSleeps.push(ms); },
});
check('a transport 403 retries with transient backoff', transportSleeps[0] === 2_000);
check('health names a transport denial separately',
  leaseUnavailableReason('LEASE_TRANSPORT_DENIED') === 'firestore_transport_denied');

const overlapSleeps: number[] = [];
await waitForLease({
  acquire: sequence([
    { status: 'LEASE_HELD_BY_OTHER', holder: 'old-instance', remainingMs: 4_500 },
    { status: 'LEASE_ACQUIRED', generation: 9 },
  ]),
  shouldContinue: () => true,
  random: () => 0,
  sleep: async ms => { overlapSleeps.push(ms); },
});
check('an active owner is treated as overlap rather than a permission failure', overlapSleeps[0] === 5_500);
check('health names overlap explicitly',
  leaseUnavailableReason('LEASE_HELD_BY_OTHER') === 'lease_held_by_other');
check('long overlap waits remain capped',
  leaseRetryDelayMs({ status: 'LEASE_HELD_BY_OTHER', holder: 'old', remainingMs: 300_000 }, 1) === 60_000);

let continuing = true;
let shutdownError: unknown;
let acquireCalls = 0;
try {
  await waitForLease({
    acquire: async () => {
      acquireCalls += 1;
      return { status: 'LEASE_PERMISSION_DENIED', error: new Error('403') };
    },
    shouldContinue: () => continuing,
    random: () => 0,
    sleep: async () => { continuing = false; },
  });
} catch (error) {
  shutdownError = error;
}
check('shutdown interrupts startup without another acquisition attempt',
  shutdownError instanceof LeaseWaitAbortedError && acquireCalls === 1);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
