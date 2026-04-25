-- Extend chat_history with retrieval provenance metadata for grounded chat
-- Safe to run multiple times.

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

