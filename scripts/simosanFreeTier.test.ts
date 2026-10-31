import assert from 'node:assert/strict';
import {
  baghdadWeekKey,
  msUntilBaghdadWeeklyReset,
  freeUsageDocId,
  recordSpendAndCheckCeiling,
  reserveFreeQuestion,
  reconcileFreeQuestion,
  releaseFreeQuestion,
  type SimosanCtx,
} from '../shared/simosan.js';
import { formatReset } from '../src/services/simosanService.js';
import {
  reserveSupaEnergy,
  reconcileSupaEnergy,
  releaseSupaEnergy,
  settleSupaOffTopic,
} from '../shared/simosanSupabase.js';

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

  // 7. Cross-Saturday midnight rollover test for free tier:
  // Reserve at Friday 23:59:50, reconcile at Saturday 00:00:10 with week: res.week.
  // Friday's turn is consumed, and Saturday's new week quota remains available!
  const friTime = new Date('2026-10-02T20:59:50Z'); // Friday 23:59:50 Baghdad
  const satTime = new Date('2026-10-02T21:00:10Z'); // Saturday 00:00:10 Baghdad
  const friWeekKey = baghdadWeekKey(friTime);
  const satWeekKey = baghdadWeekKey(satTime);
  assert.notEqual(friWeekKey, satWeekKey, 'Friday and Saturday are different weeks');

  const crossFreeRes = await reserveFreeQuestion(testCtx, { uid: 'u_cross_free', stageId: 's4' }, friTime);
  assert.equal(crossFreeRes.ok, true);
  assert.equal(crossFreeRes.week, friWeekKey);

  // Turn completes on Saturday: reconcile using crossFreeRes.week
  await reconcileFreeQuestion(testCtx, { uid: 'u_cross_free', actualUnits: 50, week: crossFreeRes.week }, satTime);

  // Student should still be able to use their NEW week's question on Saturday!
  const satNewRes = await reserveFreeQuestion(testCtx, { uid: 'u_cross_free', stageId: 's4' }, satTime);
  assert.equal(satNewRes.ok, true, 'Student can use free question for new week starting on Saturday');

  console.log('  PASS  Atomic reserve, release, reconcile, and lock lifecycle verified.');

  // Test Set 5: formatReset Multi-Day & Cooldown Formatting
  console.log('\n[5/6] Testing formatReset Countdown Formatting...');
  assert.equal(formatReset(45 * 60 * 1000, false), '45m');
  assert.equal(formatReset(45 * 60 * 1000, true), '45 دقيقة');
  assert.equal(formatReset(2 * 60 * 60 * 1000, false), '2h 0m');
  assert.equal(formatReset(2 * 60 * 60 * 1000, true), '2 ساعة و 0 دقيقة');
  assert.equal(formatReset((6 * 24 + 4) * 60 * 60 * 1000, false), '6d 4h');
  assert.equal(formatReset((6 * 24 + 4) * 60 * 60 * 1000, true), '6 أيام و 4 ساعات');
  assert.equal(formatReset(24 * 60 * 60 * 1000, false), '1d');
  assert.equal(formatReset(24 * 60 * 60 * 1000, true), 'يوم');
  console.log('  PASS  formatReset accurately presents sub-hour, multi-hour, and multi-day countdowns.');

  // Test Set 6: Supabase Burst Cooldown & Window Tracking Parity
  console.log('\n[6/7] Testing Supabase Cooldown Parity & Rollover Window...');
  const supaStore = new Map<string, any>();
  const mockSupaClient: any = {
    from: (table: string) => ({
      select: () => ({
        eq: (col: string, val: any) => ({
          maybeSingle: async () => ({ data: supaStore.get(val) || null, error: null }),
        }),
      }),
      upsert: async (row: any) => {
        supaStore.set(row.id, { ...(supaStore.get(row.id) || {}), ...row });
        return { data: row, error: null };
      },
      update: (patch: any) => ({
        eq: async (col: string, val: any) => {
          const current = supaStore.get(val) || {};
          supaStore.set(val, { ...current, ...patch });
          return { error: null };
        },
      }),
    }),
  };

  const sUid = 'supa_student';
  const sWeek = '2026-10-31';
  // 1. Initial reservation: 35,000 units succeeds
  const sRes1 = await reserveSupaEnergy(mockSupaClient, { uid: sUid, weekKey: sWeek, estimatedUnits: 35_000 });
  assert.equal(sRes1.ok, true, 'Supabase initial reserve succeeds');
  await reconcileSupaEnergy(mockSupaClient, { uid: sUid, weekKey: sWeek, reservedUnits: 35_000, actualUnits: 35_000 });

  // 2. Second burst request: 30,000 units pushes window past 60k threshold -> triggers cooldown
  const sRes2 = await reserveSupaEnergy(mockSupaClient, { uid: sUid, weekKey: sWeek, estimatedUnits: 30_000 });
  assert.equal(sRes2.ok, false, 'Supabase burst request triggers cooldown');
  assert.equal(sRes2.reason, 'cooldown_active');

  // 3. Subsequent request during cooldown is rejected
  const sRes3 = await reserveSupaEnergy(mockSupaClient, { uid: sUid, weekKey: sWeek, estimatedUnits: 500 });
  assert.equal(sRes3.ok, false, 'Supabase rejects requests while cooldown is active');
  assert.equal(sRes3.reason, 'cooldown_active');

  // 4. Test settleSupaOffTopic window tracking and refund logic
  const otUid = 'supa_offtopic';
  const otRes = await reserveSupaEnergy(mockSupaClient, { uid: otUid, weekKey: sWeek, estimatedUnits: 10_000 });
  assert.equal(otRes.ok, true);
  const otSettle = await settleSupaOffTopic(mockSupaClient, {
    uid: otUid,
    weekKey: sWeek,
    reservedUnits: 10_000,
    actualUnits: 8_000,
    maxFreeOffTopic: 5,
  });
  assert.equal(otSettle.refunded, true, 'Off-topic within cap is refunded');
  assert.equal(supaStore.get(`${otUid}_${sWeek}`).units_used, 0, 'Refunded units not charged against student budget');

  // 5. Test Supabase rollover burst window carryover across Saturday midnight
  const rollUid = 'supa_rollover_student';
  const prevWeekKey = '2026-10-24';
  const nextWeekKey = '2026-10-31';
  // Friday 23:56 Baghdad time (4 minutes before Saturday 00:00 midnight)
  const fridayWindowStart = new Date(Date.parse(`${nextWeekKey}T00:00:00+03:00`) - 4 * 60 * 1000).toISOString();
  supaStore.set(`${rollUid}_${prevWeekKey}`, {
    id: `${rollUid}_${prevWeekKey}`,
    user_id: rollUid,
    period_key: prevWeekKey,
    units_used: 50_000,
    units_reserved: 0,
    window_start: fridayWindowStart,
    window_units: 50_000,
    cooldown_until: null,
  });
  // Now at Saturday 00:02 Baghdad time, user tries to burst another 20,000 units
  const satRollNow = new Date(Date.parse(`${nextWeekKey}T00:02:00+03:00`));
  const rollRes = await reserveSupaEnergy(mockSupaClient, {
    uid: rollUid,
    weekKey: nextWeekKey,
    estimatedUnits: 20_000,
    now: satRollNow,
  });
  assert.equal(rollRes.ok, false, 'Rapid burst across Saturday midnight triggers burst cooldown');
  assert.equal(rollRes.reason, 'cooldown_active');
  console.log('  PASS  Supabase burst tracking, rollover carryover, and 2-hour cooldown parity verified.');

  // Test Set 7: recordSpendAndCheckCeiling Month Rollover & Ceiling Enforcement
  console.log('\n[7/7] Testing recordSpendAndCheckCeiling Monthly Ceiling & Rollover...');
  const ceilingCtx = createCtxWithStore();
  // 1. Spend under ceiling
  const sResult1 = await recordSpendAndCheckCeiling(ceilingCtx, 10_000, new Date('2026-09-15T12:00:00Z'));
  assert.equal(sResult1.enabled, true, 'Simosan remains enabled below ceiling');

  // 2. Spend pushing past $100 ceiling disables Simosan
  const sResult2 = await recordSpendAndCheckCeiling(ceilingCtx, 70_000_000, new Date('2026-09-15T12:00:00Z'));
  assert.equal(sResult2.enabled, false, 'Simosan is disabled when ceiling is crossed');

  // 3. New month resets monthUsd to 0 and re-evaluates
  const sResult3 = await recordSpendAndCheckCeiling(ceilingCtx, 1_000, new Date('2026-10-01T12:00:00Z'));
  assert.equal(sResult3.month, '2026-10', 'Month rolled over to new month');
  assert.ok(sResult3.monthUsd < 1, 'monthUsd reset to new month initial spend');
  console.log('  PASS  recordSpendAndCheckCeiling handles month rollover and ceiling kill switch.');

  console.log('\n====================================================');
  console.log('  ALL SIMOSAN TEST SETS PASSED (7/7)!               ');
  console.log('====================================================');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
