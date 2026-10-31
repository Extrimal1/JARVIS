-- 0010_study_summary_splits.sql — truncation-recovery split depths.
--
-- REVIEW ONLY: apply manually in Supabase after review. Nothing in the
-- app runs this file automatically.
--
-- Adds draft_splits (base span key -> subdivision depth) to the
-- study_summaries drafts from 0009. When a batch truncation hits, the
-- service persists a deeper split for that base span and retries only
-- the smaller subspan; resume re-applies the same splits so the plan
-- is deterministic across retries, reloads, and both local/cloud
-- modes. Fully additive: one nullable-safe column with a '{}'
-- default, existing rows read as "no splits", RLS untouched.
--
-- How the schema supports draft/active versions: the active_* columns
-- keep serving the last promoted summary while the draft_* columns
-- (now including splits) version each new generation by
-- draft_generation_id; promotion flips active_* in one update and
-- clears the draft, so concurrent or stale batches can only ever
-- touch their own generation's draft.

alter table public.study_summaries
  add column if not exists draft_splits jsonb not null default '{}';
