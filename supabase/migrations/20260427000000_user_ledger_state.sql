-- Per-user ledgers + KG artifact metadata (replaces localStorage-only keys).
-- RLS: users can only read/write their own row.

create table if not exists public.user_ledger_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  turbopuffer_indexed_ids jsonb not null default '[]'::jsonb,
  kg_extracted_ids jsonb not null default '[]'::jsonb,
  kg_artifact_fingerprint text,
  kg_artifact_data jsonb,
  updated_at timestamptz not null default now()
);

comment on table public.user_ledger_state is 'Turbopuffer + KG extraction ledgers and optional KG graph artifact cache, keyed by user (not session).';

create index if not exists user_ledger_state_updated_at_idx
  on public.user_ledger_state (updated_at desc);

alter table public.user_ledger_state enable row level security;

create policy "user_ledger_state_select_own"
  on public.user_ledger_state for select
  using (auth.uid() = user_id);

create policy "user_ledger_state_insert_own"
  on public.user_ledger_state for insert
  with check (auth.uid() = user_id);

create policy "user_ledger_state_update_own"
  on public.user_ledger_state for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "user_ledger_state_delete_own"
  on public.user_ledger_state for delete
  using (auth.uid() = user_id);
