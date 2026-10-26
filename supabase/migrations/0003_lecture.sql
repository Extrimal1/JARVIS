-- 0003_lecture.sql — Lecture Intelligence core tables + RLS.
-- Courses reuse study subjects (study_entries with section='subjects');
-- nothing here duplicates course, topic, exam, or document records.

-- --------------------------------------------------------- lecture_sessions

create table public.lecture_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid null references public.study_entries (id) on delete set null,
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index lecture_sessions_user_id_idx on public.lecture_sessions (user_id);

alter table public.lecture_sessions enable row level security;

create policy "lecture_sessions_select_own" on public.lecture_sessions
  for select to authenticated using (auth.uid() = user_id);
create policy "lecture_sessions_insert_own" on public.lecture_sessions
  for insert to authenticated with check (auth.uid() = user_id);
create policy "lecture_sessions_update_own" on public.lecture_sessions
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "lecture_sessions_delete_own" on public.lecture_sessions
  for delete to authenticated using (auth.uid() = user_id);

-- -------------------------------------------------------- lecture_recordings

create table public.lecture_recordings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid null references public.study_entries (id) on delete set null,
  session_id uuid null references public.lecture_sessions (id) on delete set null,
  title text not null,
  language text not null default 'de',
  duration_seconds integer not null default 0,
  audio_storage_path text not null default '',
  audio_sha256 text not null default '',
  file_size_bytes bigint not null default 0,
  status text not null default 'recording' check (status in (
    'recording', 'saved_locally', 'queued', 'uploading', 'uploaded',
    'transcribing', 'analyzing', 'ready', 'failed'
  )),
  upload_state text not null default 'local' check (upload_state in (
    'local', 'queued', 'uploading', 'uploaded', 'failed'
  )),
  processing_state text not null default 'pending' check (processing_state in (
    'pending', 'transcribing', 'analyzing', 'ready', 'failed'
  )),
  error_code text not null default '',
  local_retained boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz null
);

create index lecture_recordings_user_id_idx on public.lecture_recordings (user_id);
create index lecture_recordings_session_idx on public.lecture_recordings (session_id);

alter table public.lecture_recordings enable row level security;

create policy "lecture_recordings_select_own" on public.lecture_recordings
  for select to authenticated using (auth.uid() = user_id);
create policy "lecture_recordings_insert_own" on public.lecture_recordings
  for insert to authenticated with check (auth.uid() = user_id);
create policy "lecture_recordings_update_own" on public.lecture_recordings
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "lecture_recordings_delete_own" on public.lecture_recordings
  for delete to authenticated using (auth.uid() = user_id);

-- ------------------------------------------------------ transcript_segments

create table public.transcript_segments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  recording_id uuid not null references public.lecture_recordings (id) on delete cascade,
  segment_index integer not null,
  start_seconds double precision not null,
  end_seconds double precision not null,
  original_text text not null,
  corrected_text text not null default '',
  confidence double precision null,
  speaker_label text not null default '',
  processing_version text not null default 'whisper-1',
  created_at timestamptz not null default now(),
  unique (recording_id, segment_index)
);

create index transcript_segments_recording_idx on public.transcript_segments (recording_id, segment_index);

alter table public.transcript_segments enable row level security;

create policy "transcript_segments_select_own" on public.transcript_segments
  for select to authenticated using (auth.uid() = user_id);
create policy "transcript_segments_insert_own" on public.transcript_segments
  for insert to authenticated with check (auth.uid() = user_id);
create policy "transcript_segments_update_own" on public.transcript_segments
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "transcript_segments_delete_own" on public.transcript_segments
  for delete to authenticated using (auth.uid() = user_id);

-- -------------------------------------------------------- lecture_insights

create table public.lecture_insights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  recording_id uuid not null references public.lecture_recordings (id) on delete cascade,
  insight_type text not null check (insight_type in (
    'topics', 'definitions', 'explanations', 'examples', 'formulas',
    'spoken_only', 'emphasized', 'exam_requirements', 'exam_inference',
    'open_questions'
  )),
  title text not null,
  content text not null default '',
  confidence double precision null,
  evidence_type text not null default 'evidence' check (evidence_type in ('evidence', 'inference')),
  source_segment_ids uuid[] not null default '{}',
  source_document_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create index lecture_insights_recording_idx on public.lecture_insights (recording_id);

alter table public.lecture_insights enable row level security;

create policy "lecture_insights_select_own" on public.lecture_insights
  for select to authenticated using (auth.uid() = user_id);
create policy "lecture_insights_insert_own" on public.lecture_insights
  for insert to authenticated with check (auth.uid() = user_id);
create policy "lecture_insights_update_own" on public.lecture_insights
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "lecture_insights_delete_own" on public.lecture_insights
  for delete to authenticated using (auth.uid() = user_id);

-- ----------------------------------------------------- lecture_source_links

create table public.lecture_source_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  recording_id uuid not null references public.lecture_recordings (id) on delete cascade,
  segment_id uuid null references public.transcript_segments (id) on delete cascade,
  document_id uuid null references public.study_documents (id) on delete cascade,
  page_number integer null,
  slide_number integer null,
  match_confidence double precision null,
  created_at timestamptz not null default now()
);

create index lecture_source_links_recording_idx on public.lecture_source_links (recording_id);

alter table public.lecture_source_links enable row level security;

create policy "lecture_source_links_select_own" on public.lecture_source_links
  for select to authenticated using (auth.uid() = user_id);
create policy "lecture_source_links_insert_own" on public.lecture_source_links
  for insert to authenticated with check (auth.uid() = user_id);
create policy "lecture_source_links_update_own" on public.lecture_source_links
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "lecture_source_links_delete_own" on public.lecture_source_links
  for delete to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------- processing_jobs

create table public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  recording_id uuid null references public.lecture_recordings (id) on delete cascade,
  job_type text not null check (job_type in ('transcribe', 'analyze', 'embed', 'guide', 'flashcards', 'quiz')),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  progress double precision not null default 0,
  attempts integer not null default 0,
  error_code text not null default '',
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create index processing_jobs_user_status_idx on public.processing_jobs (user_id, status);
create index processing_jobs_recording_idx on public.processing_jobs (recording_id);

alter table public.processing_jobs enable row level security;

create policy "processing_jobs_select_own" on public.processing_jobs
  for select to authenticated using (auth.uid() = user_id);
create policy "processing_jobs_insert_own" on public.processing_jobs
  for insert to authenticated with check (auth.uid() = user_id);
create policy "processing_jobs_update_own" on public.processing_jobs
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "processing_jobs_delete_own" on public.processing_jobs
  for delete to authenticated using (auth.uid() = user_id);

-- ------------------------------------------------------- lecture_deletions

-- Tombstones for delete propagation (retained after the recording row,
-- files, transcripts, and jobs are removed).

create table public.lecture_deletions (
  recording_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  deleted_at timestamptz not null default now()
);

alter table public.lecture_deletions enable row level security;

create policy "lecture_deletions_select_own" on public.lecture_deletions
  for select to authenticated using (auth.uid() = user_id);
create policy "lecture_deletions_insert_own" on public.lecture_deletions
  for insert to authenticated with check (auth.uid() = user_id);
create policy "lecture_deletions_update_own" on public.lecture_deletions
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "lecture_deletions_delete_own" on public.lecture_deletions
  for delete to authenticated using (auth.uid() = user_id);
