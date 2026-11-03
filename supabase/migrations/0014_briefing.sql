-- 0014_briefing.sql — Morning Briefing: schedule settings, Web Push
-- subscriptions, and dispatch log.
--
-- REVIEW ONLY: apply manually in Supabase after review. Nothing in the
-- app runs this file automatically.
--
-- Fully additive: three new tables, no changes to existing tables,
-- RLS owner-only (service-role dispatch bypasses RLS), nothing
-- rewritten or deleted. Until applied, briefing routes answer
-- 503 migration-pending (never fake data).

-- -------------------------------------------------------- briefing_settings

create table public.briefing_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  enabled boolean not null default true,
  -- Local delivery time as HH:MM (24h) in `timezone`.
  time text not null default '07:30',
  -- IANA timezone, e.g. 'Europe/Berlin'.
  timezone text not null default 'Europe/Berlin',
  -- Weather city { name, latitude, longitude, detail }; null = default city.
  city jsonb null,
  -- Comma-separated RSS interest keywords, "" = all.
  interests text not null default '',
  -- Local date (in `timezone`) the briefing was last sent, null = never.
  last_sent_date date null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.briefing_settings enable row level security;

create policy "briefing_settings_select_own" on public.briefing_settings
  for select to authenticated using (auth.uid() = user_id);
create policy "briefing_settings_insert_own" on public.briefing_settings
  for insert to authenticated with check (auth.uid() = user_id);
create policy "briefing_settings_update_own" on public.briefing_settings
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "briefing_settings_delete_own" on public.briefing_settings
  for delete to authenticated using (auth.uid() = user_id);

-- ------------------------------------------------------ push_subscriptions

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz null,
  constraint push_subscriptions_user_endpoint_unique unique (user_id, endpoint)
);

create index push_subscriptions_user_id_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

create policy "push_subscriptions_select_own" on public.push_subscriptions
  for select to authenticated using (auth.uid() = user_id);
create policy "push_subscriptions_insert_own" on public.push_subscriptions
  for insert to authenticated with check (auth.uid() = user_id);
create policy "push_subscriptions_update_own" on public.push_subscriptions
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "push_subscriptions_delete_own" on public.push_subscriptions
  for delete to authenticated using (auth.uid() = user_id);

-- ------------------------------------------------------------ briefing_log

-- Dispatch audit trail (written by the service-role dispatch route,
-- which bypasses RLS; users may read their own rows).
create table public.briefing_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  sent_date date not null,
  status text not null check (status in ('sent', 'partial', 'failed', 'skipped')),
  detail text not null default '',
  created_at timestamptz not null default now()
);

create index briefing_log_user_date_idx on public.briefing_log (user_id, sent_date);

alter table public.briefing_log enable row level security;

create policy "briefing_log_select_own" on public.briefing_log
  for select to authenticated using (auth.uid() = user_id);
