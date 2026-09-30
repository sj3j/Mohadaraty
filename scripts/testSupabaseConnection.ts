import dotenv from 'dotenv';
dotenv.config();

import { getSupabaseAdmin } from '../shared/supabaseClient.js';

async function main() {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.error('Supabase client not configured.');
    process.exit(1);
  }

  console.log('Testing Supabase connection...');
  for (const table of ['ai_threads', 'ai_messages', 'ai_usage']) {
    const { data, error } = await supabase.from(table).select('*').limit(1);
    if (error) {
      console.log(`❌ Table '${table}':`, error.message);
    } else {
      console.log(`✅ Table '${table}' exists and is accessible. (rows: ${data?.length})`);
    }
  }
}

main().catch(console.error);
