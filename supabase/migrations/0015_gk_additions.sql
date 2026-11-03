-- 0015_gk_additions.sql — Tasks due dates, import content hashes, cloud memory kill-switch.
--
-- REVIEW-ONLY: apply manually in the Supabase SQL editor (or via
-- `supabase db push`). All three changes are purely additive:
-- - tasks.due_date: nullable; code omits the column until set, so
--   pre-migration databases keep working for dateless tasks.
-- - finance_import_batches.sha256: nullable; the statement-upload
--   route retries without it when the column is missing.
-- - user_settings.memory_enabled: NOT NULL DEFAULT true; the settings
--   route treats a missing column as enabled, and only sends the
--   column when the client sets it.
--
-- Until applied, due dates and import hashes work locally but are not
-- persisted in the cloud, and the memory kill-switch stays device-local.

alter table public.tasks
  add column if not exists due_date date null;

alter table public.finance_import_batches
  add column if not exists sha256 text null;

alter table public.user_settings
  add column if not exists memory_enabled boolean not null default true;

create index if not exists tasks_user_due_date_idx
  on public.tasks (user_id, due_date);
