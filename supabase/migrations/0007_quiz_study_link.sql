-- 0007_quiz_study_link.sql — AI linkage + spaced repetition on quiz_questions.
-- Links generated questions to their source document and stores the
-- per-question SM-2-inspired review state (last/next review, review
-- counts, streak, difficulty, status). Fully additive: existing rows
-- keep working with the "manual / new" defaults, RLS policies are
-- untouched, and nothing is rewritten or deleted.

alter table public.quiz_questions
  add column if not exists document_id uuid null references public.study_documents (id) on delete set null,
  add column if not exists source text not null default 'manual' check (source in ('manual', 'ai')),
  add column if not exists source_refs jsonb not null default '[]',
  add column if not exists last_reviewed_at date null,
  add column if not exists next_review_at date null,
  add column if not exists review_count integer not null default 0,
  add column if not exists success_count integer not null default 0,
  add column if not exists streak integer not null default 0,
  add column if not exists difficulty integer not null default 3 check (difficulty >= 1 and difficulty <= 5),
  add column if not exists review_status text not null default 'new' check (review_status in ('new', 'learning', 'review', 'mastered'));

create index if not exists quiz_questions_document_idx on public.quiz_questions (document_id);
create index if not exists quiz_questions_next_review_idx on public.quiz_questions (user_id, next_review_at);
