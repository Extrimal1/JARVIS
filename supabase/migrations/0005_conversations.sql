-- Phase 2: general conversation engine (threads + messages).
--
-- Mirrors the lecture-tutor precedent (0004), but module-agnostic:
-- Dashboard, Assistant, Study, Lecture, Finance, Lifestyle, Memory,
-- and Daily Briefing will share these tables. The tutor tables stay
-- untouched. No existing table is modified; no user data moves.

-- ------------------------------------------------------- conversation_threads

create table public.conversation_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  version integer not null default 1,
  title text not null,
  locale text not null default 'de',
  module text not null default 'assistant',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conversation_threads_user_id_idx on public.conversation_threads (user_id);

alter table public.conversation_threads enable row level security;

create policy "conversation_threads_select_own" on public.conversation_threads
  for select to authenticated using (auth.uid() = user_id);
create policy "conversation_threads_insert_own" on public.conversation_threads
  for insert to authenticated with check (auth.uid() = user_id);
create policy "conversation_threads_update_own" on public.conversation_threads
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "conversation_threads_delete_own" on public.conversation_threads
  for delete to authenticated using (auth.uid() = user_id);

-- ------------------------------------------------------ conversation_messages

create table public.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  thread_id uuid not null references public.conversation_threads (id) on delete cascade,
  version integer not null default 1,
  seq integer not null,
  role text not null check (role in ('user', 'assistant', 'tool', 'system')),
  content text not null,
  tool_name text null,
  created_at timestamptz not null default now()
);

create index conversation_messages_thread_idx on public.conversation_messages (thread_id, seq);

alter table public.conversation_messages enable row level security;

create policy "conversation_messages_select_own" on public.conversation_messages
  for select to authenticated using (auth.uid() = user_id);
create policy "conversation_messages_insert_own" on public.conversation_messages
  for insert to authenticated with check (auth.uid() = user_id);
create policy "conversation_messages_update_own" on public.conversation_messages
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "conversation_messages_delete_own" on public.conversation_messages
  for delete to authenticated using (auth.uid() = user_id);
