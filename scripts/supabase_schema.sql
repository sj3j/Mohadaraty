-- =========================================================================
-- MyLecture: Simosan AI Chat & Usage Ledger Schema
-- Target: Supabase PostgreSQL (Project: xrdzftuitdmlvymtlzlf)
-- Purpose: Offload AI chat threads, message histories, and rate-limit tracking
--          from Firestore to Postgres, eliminating the 27-read/turn quota burn.
-- =========================================================================

-- 1. AI Threads Table
CREATE TABLE IF NOT EXISTS public.ai_threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    lecture_id TEXT NOT NULL,
    stage_id TEXT DEFAULT '',
    question_count INTEGER DEFAULT 0,
    is_read_only BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Fast lookup of student's active thread for a given lecture
CREATE INDEX IF NOT EXISTS idx_ai_threads_user_lecture ON public.ai_threads (user_id, lecture_id);

-- 2. AI Messages Table
CREATE TABLE IF NOT EXISTS public.ai_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES public.ai_threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'model')),
    text TEXT NOT NULL,
    selection TEXT,
    cited_pages INTEGER[],
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Fast retrieval of latest 20 messages in conversation order
CREATE INDEX IF NOT EXISTS idx_ai_messages_thread_created ON public.ai_messages (thread_id, created_at DESC);

-- 3. AI Usage Ledger Table (Daily Energy & Free-Tier Allowances)
CREATE TABLE IF NOT EXISTS public.ai_usage (
    id TEXT PRIMARY KEY, -- e.g. "{userId}_{dayKey}" or "{userId}_{weekKey}"
    user_id TEXT NOT NULL,
    period_key TEXT NOT NULL,
    units_used NUMERIC DEFAULT 0,
    units_reserved NUMERIC DEFAULT 0,
    used_count INTEGER DEFAULT 0,
    reserved_count INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON public.ai_usage (user_id);

-- 4. Enable Row Level Security (RLS) on all exposed tables (Supabase Best Practice)
ALTER TABLE public.ai_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS by default. Since all backend queries go through
-- the server using the service_role key, server operations are fully authorized.
