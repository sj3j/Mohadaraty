/**
 * Verification test suite for Simosan Subscriber Access & Supabase Offloading.
 * Run with: npx tsx scripts/simosanSupabaseOptimization.test.ts
 */
import assert from 'node:assert/strict';
import 'dotenv/config';
import {
  hasLiveSubscription,
  hasSubscriptionAccess,
  parseSubscriptionEndDate,
} from '../shared/subscriptionAccess.js';
import { getSupabaseAdmin } from '../shared/supabaseClient.js';
import { getClientMessagesFromSupabase } from '../shared/simosanSupabase.js';
import { createSimosanHandlers } from '../shared/simosanApi.js';

async function main() {
  console.log('===============================================================');
  console.log('  Simosan Subscriber Access & Supabase Optimization Test Suite ');
  console.log('===============================================================\n');

  // Test 1: Robust Date Parsing for Subscribers
  console.log('[1/4] Testing parseSubscriptionEndDate across formats...');
  const now = new Date('2026-11-02T12:00:00Z');
  const futureSec = Math.floor(now.getTime() / 1000) + 30 * 86400; // 30 days ahead

  // 1.1 Native Date
  const nativeDate = new Date(futureSec * 1000);
  assert.equal(
    parseSubscriptionEndDate(nativeDate)?.getTime(),
    nativeDate.getTime(),
    'Native Date parses directly',
  );

  // 1.2 Firestore Timestamp-like instance (.toDate())
  const stampObj = { toDate: () => nativeDate };
  assert.equal(
    parseSubscriptionEndDate(stampObj)?.getTime(),
    nativeDate.getTime(),
    'Firestore Timestamp toDate() parses',
  );

  // 1.3 Serialized {_seconds, _nanoseconds}
  const serializedA = { _seconds: futureSec, _nanoseconds: 0 };
  assert.equal(
    parseSubscriptionEndDate(serializedA)?.getTime(),
    futureSec * 1000,
    'Serialized {_seconds, _nanoseconds} parses accurately',
  );

  // 1.4 Serialized {seconds}
  const serializedB = { seconds: futureSec };
  assert.equal(
    parseSubscriptionEndDate(serializedB)?.getTime(),
    futureSec * 1000,
    'Serialized {seconds} parses accurately',
  );

  // 1.5 ISO String
  assert.equal(
    parseSubscriptionEndDate(nativeDate.toISOString())?.getTime(),
    nativeDate.getTime(),
    'ISO string parses accurately',
  );

  console.log('  PASS  All subscription timestamp formats parsed accurately.');

  // Test 2: hasLiveSubscription and hasSubscriptionAccess with Serialized Timestamps
  console.log('\n[2/4] Testing Subscriber Access Gates...');
  const activeSubscriber = {
    isSubscribed: true,
    subscriptionEnd: { _seconds: futureSec, _nanoseconds: 0 },
    subscriptionPlan: 'yearly',
  };
  assert.equal(
    hasLiveSubscription(activeSubscriber, now),
    true,
    'hasLiveSubscription returns true for serialized timestamp subscriber',
  );
  assert.equal(
    hasSubscriptionAccess(activeSubscriber, now),
    true,
    'hasSubscriptionAccess returns true for serialized timestamp subscriber',
  );

  const expiredSubscriber = {
    isSubscribed: true,
    subscriptionEnd: { _seconds: futureSec - 60 * 86400, _nanoseconds: 0 },
  };
  assert.equal(
    hasLiveSubscription(expiredSubscriber, now),
    false,
    'hasLiveSubscription returns false for past serialized timestamp subscriber',
  );
  console.log('  PASS  Subscriber access gates correctly validate live & expired accounts.');

  // Test 3: Supabase Client & getClientMessagesFromSupabase
  console.log('\n[3/4] Testing Supabase Client History Query (No Firestore fallback on empty)...');
  const supabase = getSupabaseAdmin();
  assert.ok(supabase, 'Supabase client must be configured');

  const emptyLectureId = 'lec_definitely_nonexistent_test_' + Date.now();
  const result = await getClientMessagesFromSupabase(supabase, {
    userId: 'test_user_empty_check',
    lectureId: emptyLectureId,
  });

  assert.ok(result !== null, 'Supabase returns a clean result object, not null');
  assert.equal(result.threadId, '', 'Empty thread ID returned for unvisited lecture');
  assert.deepEqual(result.messages, [], 'Empty messages array returned for unvisited lecture');
  console.log('  PASS  Supabase accurately handles unvisited lectures without errors.');

  // Test 4: Simosan Handler Exports & Endpoint Coverage
  console.log('\n[4/4] Testing Simosan Handlers Export Interface...');
  const mockAdmin = {
    firestore: () => ({
      collection: () => ({
        doc: () => ({
          get: async () => ({ exists: false }),
        }),
      }),
    }),
  };
  const handlers = createSimosanHandlers({ admin: mockAdmin as any });
  assert.equal(typeof handlers.ask, 'function', 'handlers.ask exists');
  assert.equal(typeof handlers.state, 'function', 'handlers.state exists');
  assert.equal(typeof handlers.history, 'function', 'handlers.history exists');
  assert.equal(typeof handlers.adminStats, 'function', 'handlers.adminStats exists');
  assert.equal(typeof handlers.adminSettings, 'function', 'handlers.adminSettings exists');
  assert.equal(typeof handlers.report, 'function', 'handlers.report exists');
  console.log('  PASS  Simosan handlers export ask, state, history, adminStats, adminSettings, and report.');

  console.log('\n===============================================================');
  console.log('  ALL SIMOSAN SUBSCRIBER & SUPABASE TESTS PASSED (4/4)!         ');
  console.log('===============================================================');
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});

