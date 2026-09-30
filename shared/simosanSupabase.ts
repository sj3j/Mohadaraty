/**
 * Supabase PostgreSQL backend integration for Simosan AI Chat.
 *
 * Replaces Firestore document reads for:
 * - Active thread lookup (1 read -> 1 SQL index scan)
 * - Thread state check (1 read -> 0 extra reads, returned with thread)
 * - Message history (20 reads -> 1 SQL query with LIMIT 20)
 * - Message writing (batch write to Postgres)
 * - Client history retrieval
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { MAX_QUESTIONS_PER_CHAT } from './simosan.js';
import { ChatMessage } from './simosanChat.js';

export interface SupaThread {
  id: string;
  userId: string;
  lectureId: string;
  stageId: string;
  questionCount: number;
  isReadOnly: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SupaMessage {
  id: string;
  threadId: string;
  role: 'user' | 'model';
  text: string;
  selection?: string | null;
  citedPages?: number[];
  createdAt: string;
}

/**
 * Resolve or create active thread for user + lecture in Supabase.
 */
export async function resolveSupaThread(
  supabase: SupabaseClient,
  params: {
    userId: string;
    lectureId: string;
    stageId: string;
    isFreeTier: boolean;
    forceNew?: boolean;
  },
): Promise<{ threadId: string; questionCount: number; isReadOnly: boolean } | null> {
  const { userId, lectureId, stageId, isFreeTier, forceNew } = params;
  const maxAllowed = isFreeTier ? 1 : MAX_QUESTIONS_PER_CHAT;

  try {
    if (!forceNew) {
      // Find latest thread for this user and lecture
      const { data, error } = await supabase
        .from('ai_threads')
        .select('*')
        .eq('user_id', userId)
        .eq('lecture_id', lectureId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        console.warn('[simosanSupabase] resolveThread query error:', error.message);
        return null;
      }

      if (data && !data.is_read_only && (data.question_count || 0) < maxAllowed) {
        return {
          threadId: data.id,
          questionCount: data.question_count || 0,
          isReadOnly: false,
        };
      }
    }

    // Create fresh thread
    const { data: newThread, error: insertError } = await supabase
      .from('ai_threads')
      .insert({
        user_id: userId,
        lecture_id: lectureId,
        stage_id: stageId || '',
        question_count: 0,
        is_read_only: false,
      })
      .select('*')
      .single();

    if (insertError) {
      console.warn('[simosanSupabase] insertThread error:', insertError.message);
      return null;
    }

    return {
      threadId: newThread.id,
      questionCount: 0,
      isReadOnly: false,
    };
  } catch (err) {
    console.warn('[simosanSupabase] resolveSupaThread unexpected exception:', err);
    return null;
  }
}

/**
 * Fetch past N messages from Supabase for prompt context (descending order reversed).
 */
export async function loadSupaHistory(
  supabase: SupabaseClient,
  threadId: string,
  limit: number = 20,
): Promise<ChatMessage[] | null> {
  try {
    const { data, error } = await supabase
      .from('ai_messages')
      .select('role, text, created_at')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.warn('[simosanSupabase] loadSupaHistory error:', error.message);
      return null;
    }

    if (!data) return [];

    // Reverse to chronological order (oldest -> newest) for model prompt
    return data.reverse().map((m) => ({
      role: m.role as 'user' | 'model',
      text: m.text,
    }));
  } catch (err) {
    console.warn('[simosanSupabase] loadSupaHistory unexpected exception:', err);
    return null;
  }
}

/**
 * Persist user question and model answer to Supabase.
 */
export async function recordSupaTurn(
  supabase: SupabaseClient,
  params: {
    threadId: string;
    userId: string;
    lectureId: string;
    stageId: string;
    question: string;
    selection?: string | null;
    answer: string;
    citedPages?: number[];
    isFreeTier: boolean;
    currentQuestionCount: number;
  },
): Promise<boolean> {
  const {
    threadId,
    question,
    selection,
    answer,
    citedPages,
    isFreeTier,
    currentQuestionCount,
  } = params;

  try {
    const nextCount = currentQuestionCount + 1;
    const maxAllowed = isFreeTier ? 1 : MAX_QUESTIONS_PER_CHAT;
    const isReadOnly = nextCount >= maxAllowed;

    const now = Date.now();
    const userCreatedAt = new Date(now).toISOString();
    const modelCreatedAt = new Date(now + 50).toISOString();

    // 1. Insert user message and model message
    const { error: msgError } = await supabase.from('ai_messages').insert([
      {
        thread_id: threadId,
        role: 'user',
        text: question.trim(),
        selection: selection?.slice(0, 4000) || null,
        created_at: userCreatedAt,
      },
      {
        thread_id: threadId,
        role: 'model',
        text: answer,
        cited_pages: citedPages && citedPages.length > 0 ? citedPages : null,
        created_at: modelCreatedAt,
      },
    ]);

    if (msgError) {
      console.warn('[simosanSupabase] insert messages error:', msgError.message);
      return false;
    }

    // 2. Update thread question_count and is_read_only
    const { error: threadError } = await supabase
      .from('ai_threads')
      .update({
        question_count: nextCount,
        is_read_only: isReadOnly,
        updated_at: new Date().toISOString(),
      })
      .eq('id', threadId);

    if (threadError) {
      console.warn('[simosanSupabase] update thread error:', threadError.message);
    }

    return true;
  } catch (err) {
    console.warn('[simosanSupabase] recordSupaTurn unexpected exception:', err);
    return false;
  }
}

/**
 * Fetch thread messages formatted for student client (drawer view).
 */
export async function getClientMessagesFromSupabase(
  supabase: SupabaseClient,
  params: { userId: string; lectureId: string },
): Promise<{ threadId: string; messages: any[] } | null> {
  const { userId, lectureId } = params;

  try {
    // 1. Get latest thread
    const { data: thread, error: threadErr } = await supabase
      .from('ai_threads')
      .select('id')
      .eq('user_id', userId)
      .eq('lecture_id', lectureId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (threadErr || !thread) {
      return { threadId: '', messages: [] };
    }

    // 2. Get messages
    const { data: messages, error: msgErr } = await supabase
      .from('ai_messages')
      .select('id, role, text, cited_pages, selection, created_at')
      .eq('thread_id', thread.id)
      .order('created_at', { ascending: true })
      .limit(60);

    if (msgErr || !messages) {
      return { threadId: thread.id, messages: [] };
    }

    return {
      threadId: thread.id,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text || '',
        citedPages: m.cited_pages || [],
        selection: m.selection ?? null,
      })),
    };
  } catch (err) {
    console.warn('[simosanSupabase] getClientMessagesFromSupabase error:', err);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Supabase AI Usage Ledger (Offloads aiUsage reads & writes from Firestore)
 * ------------------------------------------------------------------ */

export interface SupaUsageRow {
  id: string;
  user_id: string;
  period_key: string;
  units_used: number;
  units_reserved: number;
  used_count: number;
  reserved_count: number;
  off_topic_count?: number;
  updated_at: string;
}

export async function getSupaUsage(
  supabase: SupabaseClient,
  id: string,
): Promise<SupaUsageRow | null> {
  try {
    const { data, error } = await supabase
      .from('ai_usage')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.warn('[simosanSupabase] getSupaUsage error:', error.message);
      return null;
    }
    return data as SupaUsageRow | null;
  } catch (err) {
    console.warn('[simosanSupabase] getSupaUsage exception:', err);
    return null;
  }
}

export async function reserveSupaEnergy(
  supabase: SupabaseClient,
  params: {
    uid: string;
    dayKey: string;
    estimatedUnits: number;
    dailyBudget: number;
  },
): Promise<{ ok: boolean; reserved: number; remaining: number; reason?: string }> {
  const { uid, dayKey, estimatedUnits, dailyBudget } = params;
  const id = `${uid}_${dayKey}`;

  try {
    const current = await getSupaUsage(supabase, id);
    const used = Number(current?.units_used) || 0;
    const held = Number(current?.units_reserved) || 0;
    const spent = used + held;

    if (spent + estimatedUnits > dailyBudget) {
      return {
        ok: false,
        reserved: 0,
        remaining: Math.max(0, dailyBudget - spent),
        reason: 'insufficient_energy',
      };
    }

    const nextHeld = held + estimatedUnits;
    const { error: upsertErr } = await supabase.from('ai_usage').upsert(
      {
        id,
        user_id: uid,
        period_key: dayKey,
        units_used: used,
        units_reserved: nextHeld,
        used_count: Number(current?.used_count) || 0,
        reserved_count: Number(current?.reserved_count) || 0,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    );

    if (upsertErr) {
      console.warn('[simosanSupabase] reserveSupaEnergy upsert error:', upsertErr.message);
      return { ok: false, reserved: 0, remaining: Math.max(0, dailyBudget - spent), reason: 'db_error' };
    }

    return {
      ok: true,
      reserved: estimatedUnits,
      remaining: Math.max(0, dailyBudget - spent - estimatedUnits),
    };
  } catch (err) {
    console.warn('[simosanSupabase] reserveSupaEnergy exception:', err);
    return { ok: false, reserved: 0, remaining: 0, reason: 'exception' };
  }
}

export async function reconcileSupaEnergy(
  supabase: SupabaseClient,
  params: {
    uid: string;
    dayKey: string;
    reservedUnits: number;
    actualUnits: number;
    dailyBudget: number;
  },
): Promise<{ remaining: number }> {
  const { uid, dayKey, reservedUnits, actualUnits, dailyBudget } = params;
  const id = `${uid}_${dayKey}`;

  try {
    const current = await getSupaUsage(supabase, id);
    const used = Number(current?.units_used) || 0;
    const held = Number(current?.units_reserved) || 0;
    const nextUsed = used + actualUnits;
    const nextHeld = Math.max(0, held - reservedUnits);
    const nextCount = (Number(current?.used_count) || 0) + 1;

    await supabase.from('ai_usage').upsert(
      {
        id,
        user_id: uid,
        period_key: dayKey,
        units_used: nextUsed,
        units_reserved: nextHeld,
        used_count: nextCount,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    );

    return { remaining: Math.max(0, dailyBudget - nextUsed - nextHeld) };
  } catch (err) {
    console.warn('[simosanSupabase] reconcileSupaEnergy exception:', err);
    return { remaining: 0 };
  }
}

export async function releaseSupaEnergy(
  supabase: SupabaseClient,
  params: { uid: string; dayKey: string; reservedUnits: number },
): Promise<void> {
  const { uid, dayKey, reservedUnits } = params;
  const id = `${uid}_${dayKey}`;

  try {
    const current = await getSupaUsage(supabase, id);
    if (!current) return;
    const held = Number(current.units_reserved) || 0;
    const nextHeld = Math.max(0, held - reservedUnits);

    await supabase.from('ai_usage').update({
      units_reserved: nextHeld,
      updated_at: new Date().toISOString(),
    }).eq('id', id);
  } catch (err) {
    console.warn('[simosanSupabase] releaseSupaEnergy exception:', err);
  }
}

export async function reserveSupaFreeQuestion(
  supabase: SupabaseClient,
  params: { uid: string; weekKey: string },
): Promise<{ ok: boolean; reason?: string }> {
  const { uid, weekKey } = params;
  const id = `${uid}_free_${weekKey}`;

  try {
    const current = await getSupaUsage(supabase, id);
    const used = Number(current?.used_count) || 0;
    const held = Number(current?.reserved_count) || 0;

    if (used + held >= 1) {
      return { ok: false, reason: 'free_weekly_limit_reached' };
    }

    const { error } = await supabase.from('ai_usage').upsert(
      {
        id,
        user_id: uid,
        period_key: weekKey,
        used_count: used,
        reserved_count: held + 1,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    );

    if (error) {
      console.warn('[simosanSupabase] reserveSupaFreeQuestion error:', error.message);
      return { ok: false, reason: 'db_error' };
    }

    return { ok: true };
  } catch (err) {
    console.warn('[simosanSupabase] reserveSupaFreeQuestion exception:', err);
    return { ok: false, reason: 'exception' };
  }
}

export async function reconcileSupaFreeQuestion(
  supabase: SupabaseClient,
  params: { uid: string; weekKey: string; actualUnits: number },
): Promise<void> {
  const { uid, weekKey, actualUnits } = params;
  const id = `${uid}_free_${weekKey}`;

  try {
    const current = await getSupaUsage(supabase, id);
    const used = Number(current?.used_count) || 0;
    const held = Number(current?.reserved_count) || 0;
    const units = Number(current?.units_used) || 0;

    await supabase.from('ai_usage').upsert(
      {
        id,
        user_id: uid,
        period_key: weekKey,
        used_count: used + 1,
        reserved_count: Math.max(0, held - 1),
        units_used: units + actualUnits,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    );
  } catch (err) {
    console.warn('[simosanSupabase] reconcileSupaFreeQuestion exception:', err);
  }
}

export async function releaseSupaFreeQuestion(
  supabase: SupabaseClient,
  params: { uid: string; weekKey: string },
): Promise<void> {
  const { uid, weekKey } = params;
  const id = `${uid}_free_${weekKey}`;

  try {
    const current = await getSupaUsage(supabase, id);
    if (!current) return;
    const held = Number(current.reserved_count) || 0;

    await supabase.from('ai_usage').update({
      reserved_count: Math.max(0, held - 1),
      updated_at: new Date().toISOString(),
    }).eq('id', id);
  } catch (err) {
    console.warn('[simosanSupabase] releaseSupaFreeQuestion exception:', err);
  }
}

export async function settleSupaOffTopic(
  supabase: SupabaseClient,
  params: {
    uid: string;
    dayKey: string;
    reservedUnits: number;
    actualUnits: number;
    maxFreeOffTopic: number;
    dailyBudget: number;
  },
): Promise<{ refunded: boolean; remaining: number }> {
  const { uid, dayKey, reservedUnits, actualUnits, maxFreeOffTopic, dailyBudget } = params;
  const id = `${uid}_${dayKey}`;

  try {
    const current = await getSupaUsage(supabase, id);
    const used = Number(current?.units_used) || 0;
    const held = Number(current?.units_reserved) || 0;
    const offTopic = Number(current?.off_topic_count) || 0;
    const refunded = offTopic < maxFreeOffTopic;

    const nextUsed = refunded ? used : used + actualUnits;
    const nextHeld = Math.max(0, held - reservedUnits);

    await supabase.from('ai_usage').upsert(
      {
        id,
        user_id: uid,
        period_key: dayKey,
        units_used: nextUsed,
        units_reserved: nextHeld,
        off_topic_count: offTopic + 1,
        used_count: (Number(current?.used_count) || 0) + 1,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    );

    return {
      refunded,
      remaining: Math.max(0, dailyBudget - nextUsed - nextHeld),
    };
  } catch (err) {
    console.warn('[simosanSupabase] settleSupaOffTopic exception:', err);
    return { refunded: true, remaining: dailyBudget };
  }
}

