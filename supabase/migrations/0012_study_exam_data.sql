-- 0012_study_exam_data.sql — per-exam links + availability on entries.
--
-- REVIEW ONLY: apply manually in Supabase after review. Nothing in the
-- app runs this file automatically.
--
-- Exams reuse the live study_entries rows (section = 'exams'): the
-- exam_data object stores linked document/topic ids plus the flexible
-- weekly availability with per-date exceptions. Each exam row owns
-- its state, so preparing for one exam can never overwrite another.
-- Fully additive: one jsonb column, existing rows read as unlinked
-- exams with default availability, RLS untouched, nothing rewritten.
--
-- Link ownership is enforced by the application (ids must resolve to
-- rows the caller owns); deleting an exam never deletes linked
-- documents, topics, or questions — only the exam row goes away.

alter table public.study_entries
  add column if not exists exam_data jsonb not null default '{}';
