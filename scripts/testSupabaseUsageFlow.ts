import dotenv from 'dotenv';
dotenv.config();

import { getSupabaseAdmin } from '../shared/supabaseClient.js';
import {
  getSupaUsage,
  reserveSupaEnergy,
  reconcileSupaEnergy,
  releaseSupaEnergy,
  reserveSupaFreeQuestion,
  reconcileSupaFreeQuestion,
} from '../shared/simosanSupabase.js';

async function main() {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.error('Supabase not configured');
    process.exit(1);
  }

  console.log('--- Testing Supabase AI Usage Ledger ---');
  const testUid = 'test_student_usage_999';
  const dayKey = '2026-10-01';
  const weekKey = '2026-W40';

  // 1. Reserve energy
  console.log('[1/4] Reserving energy...');
  const res = await reserveSupaEnergy(supabase, {
    uid: testUid,
    dayKey,
    estimatedUnits: 1500,
    dailyBudget: 140000,
  });
  if (!res.ok) throw new Error('Reserve failed: ' + res.reason);
  console.log('  PASS  Reserve succeeded, remaining:', res.remaining);

  // 2. Reconcile energy
  console.log('[2/4] Reconciling energy...');
  const rec = await reconcileSupaEnergy(supabase, {
    uid: testUid,
    dayKey,
    reservedUnits: 1500,
    actualUnits: 1200,
    dailyBudget: 140000,
  });
  console.log('  PASS  Reconcile succeeded, remaining:', rec.remaining);

  const row = await getSupaUsage(supabase, `${testUid}_${dayKey}`);
  console.log('  PASS  Usage row verified:', {
    units_used: row?.units_used,
    units_reserved: row?.units_reserved,
    used_count: row?.used_count,
  });

  // 3. Free question reserve & reconcile
  console.log('[3/4] Testing free tier question...');
  const freeRes = await reserveSupaFreeQuestion(supabase, { uid: testUid, weekKey });
  if (!freeRes.ok) throw new Error('Free reserve failed');
  console.log('  PASS  Free question reserved.');

  await reconcileSupaFreeQuestion(supabase, { uid: testUid, weekKey, actualUnits: 800 });
  const freeRow = await getSupaUsage(supabase, `${testUid}_free_${weekKey}`);
  console.log('  PASS  Free usage row verified:', {
    used_count: freeRow?.used_count,
    reserved_count: freeRow?.reserved_count,
  });

  // 4. Cleanup
  console.log('[4/4] Cleaning up test rows...');
  await supabase.from('ai_usage').delete().eq('user_id', testUid);
  console.log('  PASS  Test rows deleted.');

  console.log('\n=============================================');
  console.log('  ALL SUPABASE USAGE TESTS PASSED!          ');
  console.log('=============================================');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
