-- 0006_study_refs.sql — Citation refs on retrieval chunks (additive).
-- Phase 4A stores one ref object per chunk source location
-- ({kind:"page",page:N} | {kind:"slide",slide:N} |
-- {kind:"paragraph",paragraph:N} | {kind:"lines",start:N,end:N})
-- so grounded answers can only cite locations that were extracted.
-- Existing rows keep the empty default; nothing is rewritten.

alter table public.retrieval_chunks
  add column if not exists source_refs jsonb not null default '[]';
