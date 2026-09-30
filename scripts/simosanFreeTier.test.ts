import assert from 'node:assert/strict';
import {
  baghdadWeekKey,
  msUntilBaghdadWeeklyReset,
  freeUsageDocId,
  reserveFreeQuestion,
  reconcileFreeQuestion,
  releaseFreeQuestion,
  type SimosanCtx,
} from '../shared/simosan.js';

async function runTests() {
  console.log('====================================================');
  console.log('  Simosan Free Weekly Tier & Calendar Test Suite    ');
  console.log('====================================================\n');

  // Test Set 1: Baghdad Academic Week Calendar Calculations
  console.log('[1/4] Testing Baghdad Academic Week Key (Saturday - Friday)...');

  // 2026-09-26 was a Saturday
  // 2026-09-26 09:00 Baghdad time (06:00 UTC) -> should be 2026-09-26
  assert.equal(
    baghdadWeekKey(new Date('2026-09-26T06:00:00Z')),
    '2026-09-26',
    'Saturday is the start of the week',
  );

  // Sunday 2026-09-27 -> same week (2026-09-26)
  assert.equal(
    baghdadWeekKey(new Date('2026-09-27T12:00:00Z')),
    '2026-09-26',
    'Sunday belongs to the Saturday-start week',
  );

  // Wednesday 2026-09-30 -> same week (2026-09-26)
  assert.equal(
    baghdadWeekKey(new Date('2026-09-30T15:00:00Z')),
    '2026-09-26',
    'Wednesday belongs to the Saturday-start week',
  );

  // Friday night 2026-10-02 23:59:00 Baghdad time (20:59:00 UTC) -> same week (2026-09-26)
  assert.equal(
    baghdadWeekKey(new Date('2026-10-02T20:59:00Z')),
    '2026-09-26',
    'Friday before midnight belongs to current week',
  );

  // Saturday midnight 2026-10-03 00:00:05 Baghdad time (2026-10-02 21:00:05 UTC) -> NEXT week (2026-10-03)
  assert.equal(
    baghdadWeekKey(new Date('2026-10-02T21:00:05Z')),
    '2026-10-03',
    'Saturday after Baghdad midnight rolls over to new week',
  );
  console.log('  PASS  All academic week boundaries verified accurately.');

  // Test Set 2: Countdown to Next Saturday Midnight
  console.log('\n[2/4] Testing msUntilBaghdadWeeklyReset Countdown...');
  // Friday 23:00 Baghdad time (20:00 UTC): exactly 1 hour until Saturday midnight
  const fridayNight = new Date('2026-10-02T20:00:00Z');
  const msRemaining = msUntilBaghdadWeeklyReset(fridayNight);
  assert.equal(msRemaining, 60 * 60 * 1000, 'Exactly 1 hour remaining before weekly reset on Friday night');

  // Saturday 00:00:00 Baghdad time (Friday 21:00 UTC): exactly 7 days until next reset
  const satMidnight = new Date('2026-10-02T21:00:00Z');
  const msSat = msUntilBaghdadWeeklyReset(satMidnight);
  assert.equal(msSat, 7 * 24 * 60 * 60 * 1000, 'Exactly 7 days remaining at the very start of Saturday');
  console.log('  PASS  msUntilBaghdadWeeklyReset calculates accurate millisecond intervals.');

  // Test Set 3: Free Usage Document ID
  console.log('\n[3/4] Testing freeUsageDocId Formatting...');
  assert.equal(
    freeUsageDocId('student_99', '2026-09-26'),
    'student_99_free_2026-09-26',
    'freeUsageDocId correctly combines uid and weekKey',
  );
  console.log('  PASS  Document ID adheres to firestore security rules.');

  // Test Set 4: In-Memory Mock Transactional Logic
  console.log('\n[4/4] Testing Atomic Reservation, Reconcile, and Release...');
  const fakeStore = new Map<string, any>();
  const mockCtx: SimosanCtx = {
    db: {
      collection: (colName: string) => ({
        doc: (docId: string) => {
          const path = `${colName}/${docId}`;
          return {
            get: async () => ({
              exists: fakeStore.has(path),
              data: () => fakeStore.get(path),
            }),
            set: async (val: any) => fakeStore.set(path, val),
          };
        },
      }),
      runTransaction: async (fn: any) => {
        const t = {
          get: async (ref: any) => ref.get(),
          set: (ref: any, data: any, opts: any) => {
            const current = fakeStore.get(ref.path || '') || {};
            const next = opts?.merge ? { ...current, ...data } : data;
            // Record target path
            fakeStore.set(ref.path || '', next);
          },
        };
        // Monkey-patch paths for testing
        return fn({
          get: async (ref: any) => {
            const p = ref._path || '';
            return {
              exists: fakeStore.has(p),
              data: () => fakeStore.get(p),
            };
          },
          set: (ref: any, data: any, opts: any) => {
            const p = ref._path || '';
            const current = fakeStore.get(p) || {};
            fakeStore.set(p, opts?.merge ? { ...current, ...data } : data);
          },
        });
      },
    } as any,
    FieldValue: {
      serverTimestamp: () => new Date(),
      increment: (n: number) => n,
    },
    Timestamp: { now: () => new Date(), fromDate: (d: Date) => d },
  };

  // Helper with attached _path
  function createCtxWithStore(): SimosanCtx {
    const store = new Map<string, any>();
    // Default enabled settings
    store.set('app_settings/simosan', {
      enabled: true,
      dailyUnitBudget: 1000,
      monthlyCeilingUsd: 100,
      monthUsd: 10,
    });

    const db: any = {
      collection: (col: string) => ({
        doc: (id: string) => ({
          _path: `${col}/${id}`,
          get: async () => ({
            exists: store.has(`${col}/${id}`),
            data: () => store.get(`${col}/${id}`),
          }),
        }),
      }),
      runTransaction: async (cb: any) => {
        const t = {
          get: async (ref: any) => {
            const path = ref._path;
            return {
              exists: store.has(path),
              data: () => store.get(path),
            };
          },
          set: (ref: any, data: any, opts: any) => {
            const path = ref._path;
            const prev = store.get(path) || {};
            store.set(path, opts?.merge ? { ...prev, ...data } : data);
          },
        };
        return cb(t);
      },
    };

    return {
      db,
      FieldValue: {
        serverTimestamp: () => 'SERVER_TIMESTAMP',
        increment: (n: number) => n,
      },
      Timestamp: { now: () => new Date(), fromDate: (d: Date) => d },
    };
  }

  const testCtx = createCtxWithStore();
  const testNow = new Date('2026-09-30T10:00:00Z');

  // 1. Initial reservation for non-subscribed user
  const res1 = await reserveFreeQuestion(testCtx, { uid: 'u_test', stageId: 'stage_4' }, testNow);
  assert.equal(res1.ok, true, 'First reservation succeeds');

  // 2. Second reservation in the same week should fail
  const res2 = await reserveFreeQuestion(testCtx, { uid: 'u_test', stageId: 'stage_4' }, testNow);
  assert.equal(res2.ok, false, 'Second reservation in the same week fails');
  assert.equal(res2.reason, 'free_weekly_limit_reached', 'Correct reason code returned');

  // 3. Release on aborted connection
  await releaseFreeQuestion(testCtx, { uid: 'u_test' }, testNow);

  // 4. Retry after release should succeed again
  const res3 = await reserveFreeQuestion(testCtx, { uid: 'u_test', stageId: 'stage_4' }, testNow);
  assert.equal(res3.ok, true, 'Reservation succeeds again after release');

  // 5. Reconcile on completed turn
  await reconcileFreeQuestion(testCtx, { uid: 'u_test', actualUnits: 50 }, testNow);

  // 6. Attempting another question after completed turn must be rejected
  const res4 = await reserveFreeQuestion(testCtx, { uid: 'u_test', stageId: 'stage_4' }, testNow);
  assert.equal(res4.ok, false, 'Cannot ask again after question is reconciled');
  assert.equal(res4.reason, 'free_weekly_limit_reached');

  console.log('  PASS  Atomic reserve, release, reconcile, and lock lifecycle verified.');

  console.log('\n====================================================');
  console.log('  ALL SIMOSAN FREE TIER TESTS PASSED (4/4)!         ');
  console.log('====================================================');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
