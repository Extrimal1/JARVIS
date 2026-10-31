-- 0013_study_review_events.sql — append-only answer history.
--
-- REVIEW ONLY: apply manually in Supabase after review. Nothing in the
-- app runs this file automatically.
--
-- Every rated answer appends one row: which question, which topic,
-- correct or not, and the self-reported difficulty. The mastery
-- engine reads this log (recency-weighted) plus the cumulative
-- per-question counters; rows are never updated or deleted by the
-- app, so learning history survives. Fully additive: new table
-- only, owner-scoped RLS like the other study tables.
--
-- Topic/exam links are stamped from the question row at insert
-- time (server-side), so clients cannot spoof foreign links and
-- later question moves keep history intact.

create table public.study_review_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  question_id uuid not null references public.quiz_questions (id) on delete cascade,
  topic_id uuid null references public.study_entries (id) on delete set null,
  exam_id uuid null references public.study_entries (id) on delete set null,
  kind text not null default 'single' check (kind in ('single', 'multiple', 'free')),
  correct boolean not null,
  rating text not null check (rating in ('again', 'hard', 'good', 'easy')),
  created_at timestamptz not null default now()
);

create index study_review_events_user_created_idx on public.study_review_events (user_id, created_at desc);
create index study_review_events_question_idx on public.study_review_events (question_id);

alter table public.study_review_events enable row level security;

create policy "study_review_events_select_own" on public.study_review_events
  for select to authenticated using (auth.uid() = user_id);
create policy "study_review_events_insert_own" on public.study_review_events
  for insert to authenticated with check (auth.uid() = user_id);
