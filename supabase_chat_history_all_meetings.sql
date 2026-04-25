-- =====================================================
-- CHAT HISTORY: Add RAG metadata columns + All Meetings support
-- Run this ONCE in your Supabase SQL Editor.
-- Safe to run multiple times (uses IF NOT EXISTS / idempotent ops).
-- =====================================================

-- 1. Add thread_id, citations, retrieval_meta columns (from RAG upgrade)
ALTER TABLE public.chat_history
  ADD COLUMN IF NOT EXISTS thread_id TEXT;

ALTER TABLE public.chat_history
  ADD COLUMN IF NOT EXISTS citations JSONB DEFAULT '[]'::jsonb;

ALTER TABLE public.chat_history
  ADD COLUMN IF NOT EXISTS retrieval_meta JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_chat_history_thread_id
  ON public.chat_history(thread_id);

CREATE INDEX IF NOT EXISTS idx_chat_history_citations_gin
  ON public.chat_history USING GIN (citations);

CREATE INDEX IF NOT EXISTS idx_chat_history_retrieval_meta_gin
  ON public.chat_history USING GIN (retrieval_meta);

-- 2. Make task_id nullable so "All Meetings" chats can be stored without a task FK
ALTER TABLE public.chat_history ALTER COLUMN task_id DROP NOT NULL;
