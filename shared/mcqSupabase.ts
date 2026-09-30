import { SupabaseClient } from '@supabase/supabase-js';

export interface SupaMCQRow {
  lecture_id: string;
  subject_id: string;
  stage_id: string;
  status: 'generating' | 'ready' | 'failed';
  questions: any[];
  total_questions: number;
  generated_by?: string;
  started_at?: string | null;
  generated_at?: string | null;
  failure_reason?: string | null;
  failure_count?: number;
  created_at?: string;
  updated_at?: string;
}

export interface SupaUserMCQAnswerRow {
  id: string; // "{userId}_{lectureId}"
  user_id: string;
  lecture_id: string;
  has_completed_first_attempt: boolean;
  first_attempt_score: number;
  first_attempt_correct: number;
  first_attempt_total: number;
  locked_answers: Record<string, any>;
  updated_at?: string;
}

/**
 * Fetch full MCQ record from Supabase for taking or reviewing a quiz.
 */
export async function getSupaMCQ(
  supabase: SupabaseClient,
  lectureId: string,
): Promise<SupaMCQRow | null> {
  try {
    const { data, error } = await supabase
      .from('mcqs')
      .select('*')
      .eq('lecture_id', lectureId)
      .maybeSingle();

    if (error) {
      console.warn('[mcqSupabase] getSupaMCQ error:', error.message);
      return null;
    }
    return data as SupaMCQRow | null;
  } catch (err) {
    console.warn('[mcqSupabase] getSupaMCQ exception:', err);
    return null;
  }
}

/**
 * Fetch lightweight status (NO question payloads) to render badge state fast.
 */
export async function getSupaMCQStatus(
  supabase: SupabaseClient,
  lectureId: string,
): Promise<{ status: string; totalQuestions: number } | null> {
  try {
    const { data, error } = await supabase
      .from('mcqs')
      .select('status, total_questions')
      .eq('lecture_id', lectureId)
      .maybeSingle();

    if (error || !data) return null;
    return {
      status: data.status,
      totalQuestions: data.total_questions || 0,
    };
  } catch (err) {
    console.warn('[mcqSupabase] getSupaMCQStatus exception:', err);
    return null;
  }
}

/**
 * Fetch statuses for multiple lectures in a single indexed query.
 */
export async function getSupaMCQStatusBatch(
  supabase: SupabaseClient,
  lectureIds: string[],
): Promise<Record<string, { status: string; totalQuestions: number }>> {
  if (!lectureIds.length) return {};
  try {
    const { data, error } = await supabase
      .from('mcqs')
      .select('lecture_id, status, total_questions')
      .in('lecture_id', lectureIds);

    if (error || !data) return {};
    const result: Record<string, { status: string; totalQuestions: number }> = {};
    for (const row of data) {
      result[row.lecture_id] = {
        status: row.status,
        totalQuestions: row.total_questions || 0,
      };
    }
    return result;
  } catch (err) {
    console.warn('[mcqSupabase] getSupaMCQStatusBatch exception:', err);
    return {};
  }
}

/**
 * Persist or update generated MCQs in Supabase.
 */
export async function saveSupaMCQ(
  supabase: SupabaseClient,
  record: Partial<SupaMCQRow> & { lecture_id: string },
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('mcqs')
      .upsert(
        {
          ...record,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'lecture_id' },
      );

    if (error) {
      console.warn('[mcqSupabase] saveSupaMCQ error:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[mcqSupabase] saveSupaMCQ exception:', err);
    return false;
  }
}

/**
 * Fetch a student's answer record for a lecture.
 */
export async function getSupaUserMCQAnswers(
  supabase: SupabaseClient,
  userId: string,
  lectureId: string,
): Promise<SupaUserMCQAnswerRow | null> {
  const id = `${userId}_${lectureId}`;
  try {
    const { data, error } = await supabase
      .from('user_mcq_answers')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error || !data) return null;
    return data as SupaUserMCQAnswerRow;
  } catch (err) {
    console.warn('[mcqSupabase] getSupaUserMCQAnswers exception:', err);
    return null;
  }
}

/**
 * Save locked answers or first attempt completion to Supabase.
 */
export async function saveSupaUserMCQAnswers(
  supabase: SupabaseClient,
  record: Partial<SupaUserMCQAnswerRow> & { user_id: string; lecture_id: string },
): Promise<boolean> {
  const id = `${record.user_id}_${record.lecture_id}`;
  try {
    const { error } = await supabase
      .from('user_mcq_answers')
      .upsert(
        {
          id,
          ...record,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' },
      );

    if (error) {
      console.warn('[mcqSupabase] saveSupaUserMCQAnswers error:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[mcqSupabase] saveSupaUserMCQAnswers exception:', err);
    return false;
  }
}
