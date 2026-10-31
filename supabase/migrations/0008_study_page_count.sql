-- 0008_study_page_count.sql — total PDF pages / PPTX slides per document.
-- Feeds the coverage UI (total vs. text-bearing vs. covered pages).
-- Fully additive: nullable, no backfill (older rows stay null = unknown
-- until reprocessed), RLS policies untouched, nothing rewritten or deleted.

alter table public.study_documents
  add column if not exists page_count integer null;
