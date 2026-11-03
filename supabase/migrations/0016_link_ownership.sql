-- 0016_link_ownership.sql — cross-user link hardening on direct writes.
--
-- REVIEW-ONLY: apply manually in the Supabase SQL editor (or via
-- `supabase db push`) after review. Nothing in the app runs this
-- file automatically.
--
-- Problem: every owner RLS policy checks `auth.uid() = user_id`, but
-- foreign-key columns (question/topic/exam/document/thread/...) are
-- not ownership-checked. The API routes validate ownership
-- server-side (quiz config, review stamping), yet a client holding
-- its own user JWT could still write rows that *reference* another
-- user's rows through direct PostgREST calls (no data leak back —
-- selects stay owner-only — but foreign links pollute joins, counts,
-- and mastery math).
--
-- Fix: extend the WITH CHECK clauses so referenced rows must exist
-- AND belong to the writer. Pure policy change: no tables, columns,
-- indexes, or data rows are touched; existing valid rows keep
-- working. SELECT/DELETE policies are unchanged (already owner-only).
--
-- Tables without outbound references keep their 0001-0015 policies
-- untouched. `lecture_practice_exams.question_ids` (uuid array) stays
-- application-validated: arrays cannot be ownership-checked in a
-- WITH CHECK without a helper function, and that table has no
-- writer route today (dead schema until the exam builder lands).

-- ------------------------------------------------------- helper convention
--
-- Each block below drops one policy only when it exists, then
-- recreates it under the SAME name with the added ownership
-- subqueries. Subqueries run under the caller's RLS, so
-- `user_id = auth.uid()` matches exactly the rows the caller owns.

-- ----------------------------------------------------- study_review_events
-- 0013: insert checked user_id only. A direct insert could log a
-- review against another user's question/topic/exam.

drop policy if exists "study_review_events_insert_own"
  on public.study_review_events;

create policy "study_review_events_insert_own" on public.study_review_events
  for insert to authenticated with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.quiz_questions q
      where q.id = question_id and q.user_id = auth.uid()
    )
    and (topic_id is null or exists (
      select 1 from public.study_entries t
      where t.id = topic_id and t.user_id = auth.uid()
    ))
    and (exam_id is null or exists (
      select 1 from public.study_entries e
      where e.id = exam_id and e.user_id = auth.uid()
    ))
  );

-- -------------------------------------------------------- quiz_questions
-- exam/topic/document links must resolve to owned rows.

drop policy if exists "quiz_questions_insert_own"
  on public.quiz_questions;
drop policy if exists "quiz_questions_update_own"
  on public.quiz_questions;

create policy "quiz_questions_insert_own" on public.quiz_questions
  for insert to authenticated with check (
    auth.uid() = user_id
    and (exam_id is null or exists (
      select 1 from public.study_entries e
      where e.id = exam_id and e.user_id = auth.uid()
    ))
    and (topic_id is null or exists (
      select 1 from public.study_entries t
      where t.id = topic_id and t.user_id = auth.uid()
    ))
    and (document_id is null or exists (
      select 1 from public.study_documents d
      where d.id = document_id and d.user_id = auth.uid()
    ))
  );

create policy "quiz_questions_update_own" on public.quiz_questions
  for update to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (exam_id is null or exists (
      select 1 from public.study_entries e
      where e.id = exam_id and e.user_id = auth.uid()
    ))
    and (topic_id is null or exists (
      select 1 from public.study_entries t
      where t.id = topic_id and t.user_id = auth.uid()
    ))
    and (document_id is null or exists (
      select 1 from public.study_documents d
      where d.id = document_id and d.user_id = auth.uid()
    ))
  );

-- ---------------------------------------------------------- study_entries
-- parent_id (0011 topic tree) must resolve to an owned row.

drop policy if exists "study_entries_insert_own"
  on public.study_entries;
drop policy if exists "study_entries_update_own"
  on public.study_entries;

create policy "study_entries_insert_own" on public.study_entries
  for insert to authenticated with check (
    auth.uid() = user_id
    and (parent_id is null or exists (
      select 1 from public.study_entries p
      where p.id = parent_id and p.user_id = auth.uid()
    ))
  );

create policy "study_entries_update_own" on public.study_entries
  for update to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (parent_id is null or exists (
      select 1 from public.study_entries p
      where p.id = parent_id and p.user_id = auth.uid()
    ))
  );

-- -------------------------------------------------------- study_summaries
-- 0009: document_id must resolve to an owned document (insert and
-- update; promotion updates never change document_id, so the update
-- check is a no-op for honest clients).

drop policy if exists "study_summaries_insert_own"
  on public.study_summaries;
drop policy if exists "study_summaries_update_own"
  on public.study_summaries;

create policy "study_summaries_insert_own" on public.study_summaries
  for insert to authenticated with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.study_documents d
      where d.id = document_id and d.user_id = auth.uid()
    )
  );

create policy "study_summaries_update_own" on public.study_summaries
  for update to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.study_documents d
      where d.id = document_id and d.user_id = auth.uid()
    )
  );

-- --------------------------------------------------- conversation_messages
-- thread_id must resolve to an owned thread.

drop policy if exists "conversation_messages_insert_own"
  on public.conversation_messages;

create policy "conversation_messages_insert_own" on public.conversation_messages
  for insert to authenticated with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.conversation_threads t
      where t.id = thread_id and t.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------- finance_transactions
-- source_batch_id must resolve to an owned import batch.

drop policy if exists "finance_transactions_insert_own"
  on public.finance_transactions;
drop policy if exists "finance_transactions_update_own"
  on public.finance_transactions;

create policy "finance_transactions_insert_own" on public.finance_transactions
  for insert to authenticated with check (
    auth.uid() = user_id
    and (source_batch_id is null or exists (
      select 1 from public.finance_import_batches b
      where b.id = source_batch_id and b.user_id = auth.uid()
    ))
  );

create policy "finance_transactions_update_own" on public.finance_transactions
  for update to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (source_batch_id is null or exists (
      select 1 from public.finance_import_batches b
      where b.id = source_batch_id and b.user_id = auth.uid()
    ))
  );

-- -------------------------------------------------------- lifestyle_saved
-- place_id must resolve to an owned place.

drop policy if exists "lifestyle_saved_insert_own"
  on public.lifestyle_saved;

create policy "lifestyle_saved_insert_own" on public.lifestyle_saved
  for insert to authenticated with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.lifestyle_places p
      where p.id = place_id and p.user_id = auth.uid()
    )
  );

-- ------------------------------------------------------- lecture_sessions
-- course_id must resolve to an owned study entry.

drop policy if exists "lecture_sessions_insert_own"
  on public.lecture_sessions;
drop policy if exists "lecture_sessions_update_own"
  on public.lecture_sessions;

create policy "lecture_sessions_insert_own" on public.lecture_sessions
  for insert to authenticated with check (
    auth.uid() = user_id
    and (course_id is null or exists (
      select 1 from public.study_entries s
      where s.id = course_id and s.user_id = auth.uid()
    ))
  );

create policy "lecture_sessions_update_own" on public.lecture_sessions
  for update to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (course_id is null or exists (
      select 1 from public.study_entries s
      where s.id = course_id and s.user_id = auth.uid()
    ))
  );

-- ------------------------------------------------------ lecture_recordings
-- course_id/session_id must resolve to owned rows.

drop policy if exists "lecture_recordings_insert_own"
  on public.lecture_recordings;
drop policy if exists "lecture_recordings_update_own"
  on public.lecture_recordings;

create policy "lecture_recordings_insert_own" on public.lecture_recordings
  for insert to authenticated with check (
    auth.uid() = user_id
    and (course_id is null or exists (
      select 1 from public.study_entries s
      where s.id = course_id and s.user_id = auth.uid()
    ))
    and (session_id is null or exists (
      select 1 from public.lecture_sessions s
      where s.id = session_id and s.user_id = auth.uid()
    ))
  );

create policy "lecture_recordings_update_own" on public.lecture_recordings
  for update to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (course_id is null or exists (
      select 1 from public.study_entries s
      where s.id = course_id and s.user_id = auth.uid()
    ))
    and (session_id is null or exists (
      select 1 from public.lecture_sessions s
      where s.id = session_id and s.user_id = auth.uid()
    ))
  );

-- ----------------------------------------------------- transcript_segments
-- recording_id must resolve to an owned recording.

drop policy if exists "transcript_segments_insert_own"
  on public.transcript_segments;

create policy "transcript_segments_insert_own" on public.transcript_segments
  for insert to authenticated with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.lecture_recordings r
      where r.id = recording_id and r.user_id = auth.uid()
    )
  );

-- ------------------------------------------------------- lecture_insights
-- recording_id must resolve to an owned recording.

drop policy if exists "lecture_insights_insert_own"
  on public.lecture_insights;

create policy "lecture_insights_insert_own" on public.lecture_insights
  for insert to authenticated with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.lecture_recordings r
      where r.id = recording_id and r.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------- lecture_source_links
-- recording/segment/document must resolve to owned rows.

drop policy if exists "lecture_source_links_insert_own"
  on public.lecture_source_links;

create policy "lecture_source_links_insert_own" on public.lecture_source_links
  for insert to authenticated with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.lecture_recordings r
      where r.id = recording_id and r.user_id = auth.uid()
    )
    and (segment_id is null or exists (
      select 1 from public.transcript_segments s
      where s.id = segment_id and s.user_id = auth.uid()
    ))
    and (document_id is null or exists (
      select 1 from public.study_documents d
      where d.id = document_id and d.user_id = auth.uid()
    ))
  );

-- -------------------------------------------------------- processing_jobs
-- recording_id must resolve to an owned recording.

drop policy if exists "processing_jobs_insert_own"
  on public.processing_jobs;

create policy "processing_jobs_insert_own" on public.processing_jobs
  for insert to authenticated with check (
    auth.uid() = user_id
    and (recording_id is null or exists (
      select 1 from public.lecture_recordings r
      where r.id = recording_id and r.user_id = auth.uid()
    ))
  );

-- ------------------------------------------------------- retrieval_chunks
-- recording/document must resolve to owned rows.

drop policy if exists "retrieval_chunks_insert_own"
  on public.retrieval_chunks;

create policy "retrieval_chunks_insert_own" on public.retrieval_chunks
  for insert to authenticated with check (
    auth.uid() = user_id
    and (recording_id is null or exists (
      select 1 from public.lecture_recordings r
      where r.id = recording_id and r.user_id = auth.uid()
    ))
    and (document_id is null or exists (
      select 1 from public.study_documents d
      where d.id = document_id and d.user_id = auth.uid()
    ))
  );

-- ---------------------------------------------------- lecture_study_guides
-- recording/course must resolve to owned rows.

drop policy if exists "lecture_study_guides_insert_own"
  on public.lecture_study_guides;
drop policy if exists "lecture_study_guides_update_own"
  on public.lecture_study_guides;

create policy "lecture_study_guides_insert_own" on public.lecture_study_guides
  for insert to authenticated with check (
    auth.uid() = user_id
    and (recording_id is null or exists (
      select 1 from public.lecture_recordings r
      where r.id = recording_id and r.user_id = auth.uid()
    ))
    and (course_id is null or exists (
      select 1 from public.study_entries s
      where s.id = course_id and s.user_id = auth.uid()
    ))
  );

create policy "lecture_study_guides_update_own" on public.lecture_study_guides
  for update to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (recording_id is null or exists (
      select 1 from public.lecture_recordings r
      where r.id = recording_id and r.user_id = auth.uid()
    ))
    and (course_id is null or exists (
      select 1 from public.study_entries s
      where s.id = course_id and s.user_id = auth.uid()
    ))
  );

-- ------------------------------------------------------ lecture_flashcards
-- recording/course must resolve to owned rows.

drop policy if exists "lecture_flashcards_insert_own"
  on public.lecture_flashcards;
drop policy if exists "lecture_flashcards_update_own"
  on public.lecture_flashcards;

create policy "lecture_flashcards_insert_own" on public.lecture_flashcards
  for insert to authenticated with check (
    auth.uid() = user_id
    and (recording_id is null or exists (
      select 1 from public.lecture_recordings r
      where r.id = recording_id and r.user_id = auth.uid()
    ))
    and (course_id is null or exists (
      select 1 from public.study_entries s
      where s.id = course_id and s.user_id = auth.uid()
    ))
  );

create policy "lecture_flashcards_update_own" on public.lecture_flashcards
  for update to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (recording_id is null or exists (
      select 1 from public.lecture_recordings r
      where r.id = recording_id and r.user_id = auth.uid()
    ))
    and (course_id is null or exists (
      select 1 from public.study_entries s
      where s.id = course_id and s.user_id = auth.uid()
    ))
  );

-- --------------------------------------------------- lecture_card_reviews
-- card_id must resolve to an owned card.

drop policy if exists "lecture_card_reviews_insert_own"
  on public.lecture_card_reviews;

create policy "lecture_card_reviews_insert_own" on public.lecture_card_reviews
  for insert to authenticated with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.lecture_flashcards c
      where c.id = card_id and c.user_id = auth.uid()
    )
  );

-- --------------------------------------------------- lecture_exam_attempts
-- exam_id must resolve to an owned practice exam.

drop policy if exists "lecture_exam_attempts_insert_own"
  on public.lecture_exam_attempts;

create policy "lecture_exam_attempts_insert_own" on public.lecture_exam_attempts
  for insert to authenticated with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.lecture_practice_exams e
      where e.id = exam_id and e.user_id = auth.uid()
    )
  );

-- --------------------------------------------------- lecture_tutor_threads
-- course/recording must resolve to owned rows.

drop policy if exists "lecture_tutor_threads_insert_own"
  on public.lecture_tutor_threads;
drop policy if exists "lecture_tutor_threads_update_own"
  on public.lecture_tutor_threads;

create policy "lecture_tutor_threads_insert_own" on public.lecture_tutor_threads
  for insert to authenticated with check (
    auth.uid() = user_id
    and (course_id is null or exists (
      select 1 from public.study_entries s
      where s.id = course_id and s.user_id = auth.uid()
    ))
    and (recording_id is null or exists (
      select 1 from public.lecture_recordings r
      where r.id = recording_id and r.user_id = auth.uid()
    ))
  );

create policy "lecture_tutor_threads_update_own" on public.lecture_tutor_threads
  for update to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (course_id is null or exists (
      select 1 from public.study_entries s
      where s.id = course_id and s.user_id = auth.uid()
    ))
    and (recording_id is null or exists (
      select 1 from public.lecture_recordings r
      where r.id = recording_id and r.user_id = auth.uid()
    ))
  );

-- -------------------------------------------------- lecture_tutor_messages
-- thread_id must resolve to an owned thread.

drop policy if exists "lecture_tutor_messages_insert_own"
  on public.lecture_tutor_messages;

create policy "lecture_tutor_messages_insert_own" on public.lecture_tutor_messages
  for insert to authenticated with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.lecture_tutor_threads t
      where t.id = thread_id and t.user_id = auth.uid()
    )
  );
