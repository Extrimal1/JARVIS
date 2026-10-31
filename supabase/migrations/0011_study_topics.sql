-- 0011_study_topics.sql — topic tree, sources, and mastery on entries.
--
-- REVIEW ONLY: apply manually in Supabase after review. Nothing in the
-- app runs this file automatically.
--
-- AI-extracted topics reuse the live study_entries rows (section =
-- 'topics') instead of a parallel table: parent_id nests subtopics,
-- source_refs keeps every grounded document location merged across
-- documents, and mastery + mastery_evidence store the evidence-based
-- level (quiz/review history only — reading never advances it).
-- Fully additive: new columns only, existing rows read as manual
-- topics without tree position, RLS untouched, nothing rewritten.
--
-- Removing a topic sets its children's parent_id null (they become
-- roots, never deleted); linked quiz questions keep their rows and
-- are reassigned by the application, never cascade-deleted.

alter table public.study_entries
  add column if not exists parent_id uuid null references public.study_entries (id) on delete set null,
  add column if not exists source_refs jsonb not null default '[]',
  add column if not exists mastery text not null default 'not-started' check (mastery in ('not-started', 'learning', 'needs-revision', 'understood', 'mastered')),
  add column if not exists mastery_evidence jsonb not null default '{}',
  add column if not exists topic_data jsonb not null default '{}';

create index if not exists study_entries_parent_idx on public.study_entries (parent_id);
