-- 0009_study_summaries.sql — per-document summary drafts + active text.
--
-- REVIEW ONLY: apply manually in Supabase after review. Nothing in the
-- app runs this file automatically.
--
-- One row per (user, document): active_* columns hold the promoted
-- summary, draft_* columns hold the running generation versioned by
-- draft_generation_id. Promotion is a single-row update, so the
-- active summary stays readable and unchanged until its replacement
-- completes; cancel/failure only ever touch the draft columns.
-- Sequential generations each get a fresh draft_generation_id, and
-- the batch/synthesize services reject stale ids, so old client
-- state can never skip content or resurrect a superseded draft.
-- Fully additive: new table only, owner-scoped RLS like the other
-- study tables, nothing rewritten or deleted.

create table public.study_summaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  document_id uuid not null references public.study_documents (id) on delete cascade,
  status text not null default 'partial' check (status in ('partial', 'complete')),
  active_final_md text not null default '',
  active_final_refs jsonb not null default '[]',
  active_completed_at timestamptz null,
  draft_generation_id uuid null,
  draft_planned jsonb not null default '[]',
  draft_spans jsonb not null default '[]',
  draft_preview_md text not null default '',
  draft_preview_refs jsonb not null default '[]',
  draft_started_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, document_id)
);

create index study_summaries_document_idx on public.study_summaries (document_id);

alter table public.study_summaries enable row level security;

create policy "study_summaries_select_own" on public.study_summaries
  for select to authenticated using (auth.uid() = user_id);
create policy "study_summaries_insert_own" on public.study_summaries
  for insert to authenticated with check (auth.uid() = user_id);
create policy "study_summaries_update_own" on public.study_summaries
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "study_summaries_delete_own" on public.study_summaries
  for delete to authenticated using (auth.uid() = user_id);
