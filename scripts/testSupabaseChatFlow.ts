import dotenv from 'dotenv';
dotenv.config();

import { getSupabaseAdmin } from '../shared/supabaseClient.js';
import {
  resolveSupaThread,
  loadSupaHistory,
  recordSupaTurn,
  getClientMessagesFromSupabase,
} from '../shared/simosanSupabase.js';

async function main() {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.error('Supabase client not configured.');
    process.exit(1);
  }

  console.log('--- Testing Full Supabase AI Chat Lifecycle ---');

  const testUid = 'test_student_user_123';
  const testLectureId = 'lec_test_pharmacology_1';
  const testStageId = 'stage_3';

  // 1. Resolve or create thread
  console.log('[1/4] Resolving thread...');
  const thread = await resolveSupaThread(supabase, {
    userId: testUid,
    lectureId: testLectureId,
    stageId: testStageId,
    isFreeTier: false,
    forceNew: true, // test fresh thread creation
  });

  if (!thread) {
    throw new Error('Failed to create/resolve thread in Supabase');
  }
  console.log('  PASS  Thread resolved:', thread.threadId);

  // 2. Record turn (User question + Model answer)
  console.log('[2/4] Recording chat turn in Supabase...');
  const recorded = await recordSupaTurn(supabase, {
    threadId: thread.threadId,
    userId: testUid,
    lectureId: testLectureId,
    stageId: testStageId,
    question: 'ما هي آلية عمل الدواء؟',
    selection: 'Paracetamol mechanism of action',
    answer: 'يعمل الباراسيتامول من خلال تثبيط تصنيع البروستاغلاندين في الجهاز العصبي المركزي.',
    citedPages: [2, 5],
    isFreeTier: false,
    currentQuestionCount: 0,
  });

  if (!recorded) {
    throw new Error('Failed to record chat turn in Supabase');
  }
  console.log('  PASS  Chat turn recorded successfully.');

  // 3. Load prompt context history
  console.log('[3/4] Loading model prompt history (last 20 messages)...');
  const history = await loadSupaHistory(supabase, thread.threadId, 20);
  if (!history || history.length !== 2) {
    throw new Error(`Expected 2 messages in prompt history, got ${history?.length}`);
  }
  console.log(`  PASS  History retrieved: ${history.length} messages (oldest to newest):`);
  console.log(`        1. [${history[0].role}] ${history[0].text}`);
  console.log(`        2. [${history[1].role}] ${history[1].text.slice(0, 50)}...`);

  // 4. Load client drawer history
  console.log('[4/4] Loading client drawer history...');
  const clientData = await getClientMessagesFromSupabase(supabase, {
    userId: testUid,
    lectureId: testLectureId,
  });

  if (!clientData || clientData.messages.length !== 2) {
    throw new Error(`Expected 2 messages for client, got ${clientData?.messages.length}`);
  }
  console.log(`  PASS  Client messages retrieved: ${clientData.messages.length} messages.`);
  console.log(`        First cited pages: [${clientData.messages[1].citedPages}]`);

  // Clean up test rows
  console.log('\nCleaning up test rows...');
  await supabase.from('ai_threads').delete().eq('id', thread.threadId);
  console.log('Cleaned up test thread.');

  console.log('\n=============================================');
  console.log('  ALL SUPABASE CHAT TESTS PASSED (4/4)!     ');
  console.log('=============================================');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
