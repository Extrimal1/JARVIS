-- 0004_study_intel.sql — Guides, flashcards, exams, tutor, retrieval.
-- Requires the pgvector extension for the embedding column (Supabase
-- ships pgvector; enable it once — this statement is idempotent).
-- Retrieval still works without embeddings (keyword fallback).

create extension if not exists vector;

-- -------------------------------------------------------- retrieval_chunks

create table public.retrieval_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  recording_id uuid null references public.lecture_recordings (id) on delete cascade,
  document_id uuid null references public.study_documents (id) on delete cascade,
  chunk_index integer not null default 0,
  content text not null,
  token_count integer not null default 0,
  embedding vector(768) null,
  created_at timestamptz not null default now()
);

create index retrieval_chunks_user_id_idx on public.retrieval_chunks (user_id);
create index retrieval_chunks_recording_idx on public.retrieval_chunks (recording_id);
-- NOTE: no vector index at personal scale; exact search is fast enough
-- for thousands of chunks. Add HNSW/IVFFlat only if this ever grows.

alter table public.retrieval_chunks enable row level security;

create policy "retrieval_chunks_select_own" on public.retrieval_chunks
  for select to authenticated using (auth.uid() = user_id);
create policy "retrieval_chunks_insert_own" on public.retrieval_chunks
  for insert to authenticated with check (auth.uid() = user_id);
create policy "retrieval_chunks_update_own" on public.retrieval_chunks
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "retrieval_chunks_delete_own" on public.retrieval_chunks
  for delete to authenticated using (auth.uid() = user_id);

-- ----------------------------------------------------- lecture_study_guides

create table public.lecture_study_guides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  recording_id uuid null references public.lecture_recordings (id) on delete cascade,
  course_id uuid null references public.study_entries (id) on delete set null,
  title text not null,
  summary_md text not null default '',
  sections jsonb not null default '[]',
  source_refs jsonb not null default '[]',
  version integer not null default 1,
  manually_edited boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index lecture_study_guides_user_id_idx on public.lecture_study_guides (user_id);
create index lecture_study_guides_recording_idx on public.lecture_study_guides (recording_id);

alter table public.lecture_study_guides enable row level security;

create policy "lecture_study_guides_select_own" on public.lecture_study_guides
  for select to authenticated using (auth.uid() = user_id);
create policy "lecture_study_guides_insert_own" on public.lecture_study_guides
  for insert to authenticated with check (auth.uid() = user_id);
create policy "lecture_study_guides_update_own" on public.lecture_study_guides
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "lecture_study_guides_delete_own" on public.lecture_study_guides
  for delete to authenticated using (auth.uid() = user_id);

-- ------------------------------------------------------- lecture_flashcards

create table public.lecture_flashcards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  recording_id uuid null references public.lecture_recordings (id) on delete cascade,
  course_id uuid null references public.study_entries (id) on delete set null,
  topic_ref text not null default '',
  prompt text not null,
  answer text not null,
  difficulty text not null default 'medium' check (difficulty in ('easy', 'medium', 'hard')),
  source_refs jsonb not null default '[]',
  ease double precision not null default 2.5,
  interval_days integer not null default 0,
  reps integer not null default 0,
  lapses integer not null default 0,
  next_review date null,
  last_reviewed date null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index lecture_flashcards_user_review_idx on public.lecture_flashcards (user_id, next_review);

alter table public.lecture_flashcards enable row level security;

create policy "lecture_flashcards_select_own" on public.lecture_flashcards
  for select to authenticated using (auth.uid() = user_id);
create policy "lecture_flashcards_insert_own" on public.lecture_flashcards
  for insert to authenticated with check (auth.uid() = user_id);
create policy "lecture_flashcards_update_own" on public.lecture_flashcards
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "lecture_flashcards_delete_own" on public.lecture_flashcards
  for delete to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------- lecture_card_reviews

create table public.lecture_card_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  card_id uuid not null references public.lecture_flashcards (id) on delete cascade,
  quality integer not null check (quality >= 0 and quality <= 5),
  reviewed_at timestamptz not null default now()
);

create index lecture_card_reviews_card_idx on public.lecture_card_reviews (card_id);

alter table public.lecture_card_reviews enable row level security;

create policy "lecture_card_reviews_select_own" on public.lecture_card_reviews
  for select to authenticated using (auth.uid() = user_id);
create policy "lecture_card_reviews_insert_own" on public.lecture_card_reviews
  for insert to authenticated with check (auth.uid() = user_id);
create policy "lecture_card_reviews_update_own" on public.lecture_card_reviews
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "lecture_card_reviews_delete_own" on public.lecture_card_reviews
  for delete to authenticated using (auth.uid() = user_id);

-- --------------------------------------------------- lecture_practice_exams

create table public.lecture_practice_exams (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid null references public.study_entries (id) on delete set null,
  title text not null,
  question_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create index lecture_practice_exams_user_id_idx on public.lecture_practice_exams (user_id);

alter table public.lecture_practice_exams enable row level security;

create policy "lecture_practice_exams_select_own" on public.lecture_practice_exams
  for select to authenticated using (auth.uid() = user_id);
create policy "lecture_practice_exams_insert_own" on public.lecture_practice_exams
  for insert to authenticated with check (auth.uid() = user_id);
create policy "lecture_practice_exams_update_own" on public.lecture_practice_exams
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "lecture_practice_exams_delete_own" on public.lecture_practice_exams
  for delete to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------- lecture_exam_attempts

create table public.lecture_exam_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  exam_id uuid not null references public.lecture_practice_exams (id) on delete cascade,
  answers jsonb not null default '{}',
  score double precision null,
  created_at timestamptz not null default now()
);

create index lecture_exam_attempts_exam_idx on public.lecture_exam_attempts (exam_id);

alter table public.lecture_exam_attempts enable row level security;

create policy "lecture_exam_attempts_select_own" on public.lecture_exam_attempts
  for select to authenticated using (auth.uid() = user_id);
create policy "lecture_exam_attempts_insert_own" on public.lecture_exam_attempts
  for insert to authenticated with check (auth.uid() = user_id);
create policy "lecture_exam_attempts_update_own" on public.lecture_exam_attempts
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "lecture_exam_attempts_delete_own" on public.lecture_exam_attempts
  for delete to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------- lecture_tutor_threads

create table public.lecture_tutor_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid null references public.study_entries (id) on delete set null,
  recording_id uuid null references public.lecture_recordings (id) on delete cascade,
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index lecture_tutor_threads_user_id_idx on public.lecture_tutor_threads (user_id);

alter table public.lecture_tutor_threads enable row level security;

create policy "lecture_tutor_threads_select_own" on public.lecture_tutor_threads
  for select to authenticated using (auth.uid() = user_id);
create policy "lecture_tutor_threads_insert_own" on public.lecture_tutor_threads
  for insert to authenticated with check (auth.uid() = user_id);
create policy "lecture_tutor_threads_update_own" on public.lecture_tutor_threads
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "lecture_tutor_threads_delete_own" on public.lecture_tutor_threads
  for delete to authenticated using (auth.uid() = user_id);

-- --------------------------------------------------- lecture_tutor_messages

create table public.lecture_tutor_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  thread_id uuid not null references public.lecture_tutor_threads (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  citations jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create index lecture_tutor_messages_thread_idx on public.lecture_tutor_messages (thread_id, created_at);

alter table public.lecture_tutor_messages enable row level security;

create policy "lecture_tutor_messages_select_own" on public.lecture_tutor_messages
  for select to authenticated using (auth.uid() = user_id);
create policy "lecture_tutor_messages_insert_own" on public.lecture_tutor_messages
  for insert to authenticated with check (auth.uid() = user_id);
create policy "lecture_tutor_messages_update_own" on public.lecture_tutor_messages
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "lecture_tutor_messages_delete_own" on public.lecture_tutor_messages
  for delete to authenticated using (auth.uid() = user_id);
