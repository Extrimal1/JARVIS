-- 0002_storage.sql — Private buckets + owner-scoped Storage policies.
-- All buckets are private. Objects live under `{user_id}/...`; RLS on
-- storage.objects enforces the same boundary the API routes enforce.

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('study-documents', 'study-documents', false, 10485760),
  ('finance-statements', 'finance-statements', false, 15728640),
  ('lecture-audio', 'lecture-audio', false, 536870912)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit;

-- Helper: first path folder must equal the caller's user id.
-- (string_to_array is core Postgres — no extension needed.)

-- study-documents ----------------------------------------------------------

create policy "study-documents_insert_own" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'study-documents'
    and (string_to_array(name, '/'))[1] = auth.uid()::text
  );
create policy "study-documents_select_own" on storage.objects
  for select to authenticated using (
    bucket_id = 'study-documents'
    and (string_to_array(name, '/'))[1] = auth.uid()::text
  );
create policy "study-documents_update_own" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'study-documents'
    and (string_to_array(name, '/'))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'study-documents'
    and (string_to_array(name, '/'))[1] = auth.uid()::text
  );
create policy "study-documents_delete_own" on storage.objects
  for delete to authenticated using (
    bucket_id = 'study-documents'
    and (string_to_array(name, '/'))[1] = auth.uid()::text
  );

-- finance-statements --------------------------------------------------------

create policy "finance-statements_insert_own" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'finance-statements'
    and (string_to_array(name, '/'))[1] = auth.uid()::text
  );
create policy "finance-statements_select_own" on storage.objects
  for select to authenticated using (
    bucket_id = 'finance-statements'
    and (string_to_array(name, '/'))[1] = auth.uid()::text
  );
create policy "finance-statements_update_own" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'finance-statements'
    and (string_to_array(name, '/'))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'finance-statements'
    and (string_to_array(name, '/'))[1] = auth.uid()::text
  );
create policy "finance-statements_delete_own" on storage.objects
  for delete to authenticated using (
    bucket_id = 'finance-statements'
    and (string_to_array(name, '/'))[1] = auth.uid()::text
  );

-- lecture-audio -------------------------------------------------------------

create policy "lecture-audio_insert_own" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'lecture-audio'
    and (string_to_array(name, '/'))[1] = auth.uid()::text
  );
create policy "lecture-audio_select_own" on storage.objects
  for select to authenticated using (
    bucket_id = 'lecture-audio'
    and (string_to_array(name, '/'))[1] = auth.uid()::text
  );
create policy "lecture-audio_update_own" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'lecture-audio'
    and (string_to_array(name, '/'))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'lecture-audio'
    and (string_to_array(name, '/'))[1] = auth.uid()::text
  );
create policy "lecture-audio_delete_own" on storage.objects
  for delete to authenticated using (
    bucket_id = 'lecture-audio'
    and (string_to_array(name, '/'))[1] = auth.uid()::text
  );
