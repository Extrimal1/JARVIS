-- 0001_core.sql — Core application tables + RLS.
-- Run once in the Supabase SQL editor (or via `supabase db push`).
-- Every user-owned table: UUID PK, user_id FK to auth.users with
-- cascade delete, timestamps, and four owner-only RLS policies.

-- gen_random_uuid() is built into Postgres 13+ (no extension needed).

-- ---------------------------------------------------------------- profiles

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select to authenticated using (auth.uid() = id);
create policy "profiles_insert_own" on public.profiles
  for insert to authenticated with check (auth.uid() = id);
create policy "profiles_update_own" on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);
create policy "profiles_delete_own" on public.profiles
  for delete to authenticated using (auth.uid() = id);

-- ------------------------------------------------------------------- tasks

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  time text not null default 'Keine Frist',
  done boolean not null default false,
  priority text not null check (priority in ('Niedrig', 'Mittel', 'Hoch')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tasks_user_id_idx on public.tasks (user_id);

alter table public.tasks enable row level security;

create policy "tasks_select_own" on public.tasks
  for select to authenticated using (auth.uid() = user_id);
create policy "tasks_insert_own" on public.tasks
  for insert to authenticated with check (auth.uid() = user_id);
create policy "tasks_update_own" on public.tasks
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "tasks_delete_own" on public.tasks
  for delete to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------- calendar_events

create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  date date not null,
  start_time text not null,
  end_time text not null,
  type text not null check (type in ('lecture', 'exam', 'personal')),
  description text not null default '',
  location text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index calendar_events_user_date_idx on public.calendar_events (user_id, date);

alter table public.calendar_events enable row level security;

create policy "calendar_events_select_own" on public.calendar_events
  for select to authenticated using (auth.uid() = user_id);
create policy "calendar_events_insert_own" on public.calendar_events
  for insert to authenticated with check (auth.uid() = user_id);
create policy "calendar_events_update_own" on public.calendar_events
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "calendar_events_delete_own" on public.calendar_events
  for delete to authenticated using (auth.uid() = user_id);

-- ------------------------------------------------------------ study_entries

create table public.study_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  section text not null check (section in ('subjects', 'exams', 'topics', 'materials')),
  title text not null,
  detail text not null default '',
  date date null,
  subject text null,
  done boolean null,
  review_stage integer null,
  last_reviewed_at date null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index study_entries_user_section_idx on public.study_entries (user_id, section);

alter table public.study_entries enable row level security;

create policy "study_entries_select_own" on public.study_entries
  for select to authenticated using (auth.uid() = user_id);
create policy "study_entries_insert_own" on public.study_entries
  for insert to authenticated with check (auth.uid() = user_id);
create policy "study_entries_update_own" on public.study_entries
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "study_entries_delete_own" on public.study_entries
  for delete to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------- quiz_questions

create table public.quiz_questions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  subject text not null default '',
  exam_id uuid null references public.study_entries (id) on delete set null,
  topic_id uuid null references public.study_entries (id) on delete set null,
  question text not null,
  options jsonb not null,
  correct_index integer not null default 0,
  explanation text not null default '',
  kind text not null default 'single' check (kind in ('single', 'multiple', 'free')),
  correct_indices integer[] null,
  grading_criteria text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index quiz_questions_user_id_idx on public.quiz_questions (user_id);

alter table public.quiz_questions enable row level security;

create policy "quiz_questions_select_own" on public.quiz_questions
  for select to authenticated using (auth.uid() = user_id);
create policy "quiz_questions_insert_own" on public.quiz_questions
  for insert to authenticated with check (auth.uid() = user_id);
create policy "quiz_questions_update_own" on public.quiz_questions
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "quiz_questions_delete_own" on public.quiz_questions
  for delete to authenticated using (auth.uid() = user_id);

-- --------------------------------------------------- finance_import_batches

create table public.finance_import_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  file_name text not null,
  file_size bigint not null default 0,
  statement_month text not null default '',
  imported_at timestamptz not null default now(),
  count integer not null default 0,
  storage_path text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index finance_import_batches_user_id_idx on public.finance_import_batches (user_id);

alter table public.finance_import_batches enable row level security;

create policy "finance_import_batches_select_own" on public.finance_import_batches
  for select to authenticated using (auth.uid() = user_id);
create policy "finance_import_batches_insert_own" on public.finance_import_batches
  for insert to authenticated with check (auth.uid() = user_id);
create policy "finance_import_batches_update_own" on public.finance_import_batches
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "finance_import_batches_delete_own" on public.finance_import_batches
  for delete to authenticated using (auth.uid() = user_id);

-- ----------------------------------------------------- finance_transactions

create table public.finance_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  amount_cents bigint not null check (amount_cents >= 0),
  type text not null check (type in ('income', 'expense')),
  category text not null default 'Sonstiges',
  date date not null,
  note text not null default '',
  currency text not null default 'EUR',
  source_batch_id uuid null references public.finance_import_batches (id) on delete set null,
  import_status text not null default 'manual' check (import_status in ('manual', 'imported')),
  original_description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index finance_transactions_user_date_idx on public.finance_transactions (user_id, date);
create index finance_transactions_batch_idx on public.finance_transactions (source_batch_id);

alter table public.finance_transactions enable row level security;

create policy "finance_transactions_select_own" on public.finance_transactions
  for select to authenticated using (auth.uid() = user_id);
create policy "finance_transactions_insert_own" on public.finance_transactions
  for insert to authenticated with check (auth.uid() = user_id);
create policy "finance_transactions_update_own" on public.finance_transactions
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "finance_transactions_delete_own" on public.finance_transactions
  for delete to authenticated using (auth.uid() = user_id);

-- -------------------------------------------------------- finance_settings

create table public.finance_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  monthly_budget_cents bigint not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.finance_settings enable row level security;

create policy "finance_settings_select_own" on public.finance_settings
  for select to authenticated using (auth.uid() = user_id);
create policy "finance_settings_insert_own" on public.finance_settings
  for insert to authenticated with check (auth.uid() = user_id);
create policy "finance_settings_update_own" on public.finance_settings
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "finance_settings_delete_own" on public.finance_settings
  for delete to authenticated using (auth.uid() = user_id);

-- --------------------------------------------------------- category_budgets

create table public.category_budgets (
  user_id uuid not null references auth.users (id) on delete cascade,
  category text not null,
  cents bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, category)
);

alter table public.category_budgets enable row level security;

create policy "category_budgets_select_own" on public.category_budgets
  for select to authenticated using (auth.uid() = user_id);
create policy "category_budgets_insert_own" on public.category_budgets
  for insert to authenticated with check (auth.uid() = user_id);
create policy "category_budgets_update_own" on public.category_budgets
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "category_budgets_delete_own" on public.category_budgets
  for delete to authenticated using (auth.uid() = user_id);

-- ------------------------------------------------------------ savings_goals

create table public.savings_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  target_cents bigint not null default 0,
  saved_cents bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index savings_goals_user_id_idx on public.savings_goals (user_id);

alter table public.savings_goals enable row level security;

create policy "savings_goals_select_own" on public.savings_goals
  for select to authenticated using (auth.uid() = user_id);
create policy "savings_goals_insert_own" on public.savings_goals
  for insert to authenticated with check (auth.uid() = user_id);
create policy "savings_goals_update_own" on public.savings_goals
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "savings_goals_delete_own" on public.savings_goals
  for delete to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------- finance_category_corrections

create table public.finance_category_corrections (
  user_id uuid not null references auth.users (id) on delete cascade,
  pattern text not null,
  type text not null check (type in ('income', 'expense')),
  category text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, pattern, type)
);

alter table public.finance_category_corrections enable row level security;

create policy "finance_category_corrections_select_own" on public.finance_category_corrections
  for select to authenticated using (auth.uid() = user_id);
create policy "finance_category_corrections_insert_own" on public.finance_category_corrections
  for insert to authenticated with check (auth.uid() = user_id);
create policy "finance_category_corrections_update_own" on public.finance_category_corrections
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "finance_category_corrections_delete_own" on public.finance_category_corrections
  for delete to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------- lifestyle_places

create table public.lifestyle_places (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  category text not null check (category in ('nature', 'food', 'culture', 'sport', 'cinema', 'date', 'free')),
  address text not null default '',
  latitude double precision null,
  longitude double precision null,
  cost_cents bigint null,
  duration_minutes integer null,
  setting text null check (setting in ('indoor', 'outdoor', 'both')),
  opening_hours text not null default '',
  notes text not null default '',
  source jsonb not null default '{"providerId":"manual","label":"Manuell","fetchedAt":null}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index lifestyle_places_user_id_idx on public.lifestyle_places (user_id);

alter table public.lifestyle_places enable row level security;

create policy "lifestyle_places_select_own" on public.lifestyle_places
  for select to authenticated using (auth.uid() = user_id);
create policy "lifestyle_places_insert_own" on public.lifestyle_places
  for insert to authenticated with check (auth.uid() = user_id);
create policy "lifestyle_places_update_own" on public.lifestyle_places
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "lifestyle_places_delete_own" on public.lifestyle_places
  for delete to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------- lifestyle_events

create table public.lifestyle_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  category text not null check (category in ('nature', 'food', 'culture', 'sport', 'cinema', 'date', 'free', 'events')),
  venue text not null default '',
  address text not null default '',
  date date not null,
  end_date date null,
  time text not null default '',
  price_cents bigint null,
  booking_url text not null default '',
  notes text not null default '',
  source jsonb not null default '{"providerId":"manual","label":"Manuell","fetchedAt":null}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index lifestyle_events_user_date_idx on public.lifestyle_events (user_id, date);

alter table public.lifestyle_events enable row level security;

create policy "lifestyle_events_select_own" on public.lifestyle_events
  for select to authenticated using (auth.uid() = user_id);
create policy "lifestyle_events_insert_own" on public.lifestyle_events
  for insert to authenticated with check (auth.uid() = user_id);
create policy "lifestyle_events_update_own" on public.lifestyle_events
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "lifestyle_events_delete_own" on public.lifestyle_events
  for delete to authenticated using (auth.uid() = user_id);

-- ----------------------------------------------------------- lifestyle_saved

create table public.lifestyle_saved (
  user_id uuid not null references auth.users (id) on delete cascade,
  place_id uuid not null references public.lifestyle_places (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, place_id)
);

alter table public.lifestyle_saved enable row level security;

create policy "lifestyle_saved_select_own" on public.lifestyle_saved
  for select to authenticated using (auth.uid() = user_id);
create policy "lifestyle_saved_insert_own" on public.lifestyle_saved
  for insert to authenticated with check (auth.uid() = user_id);
create policy "lifestyle_saved_update_own" on public.lifestyle_saved
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "lifestyle_saved_delete_own" on public.lifestyle_saved
  for delete to authenticated using (auth.uid() = user_id);

-- ----------------------------------------------------------- lifestyle_plans

create table public.lifestyle_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  date date not null,
  duration_minutes integer null,
  budget_cents bigint null,
  categories text[] not null default '{}',
  stops jsonb not null default '[]',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index lifestyle_plans_user_date_idx on public.lifestyle_plans (user_id, date);

alter table public.lifestyle_plans enable row level security;

create policy "lifestyle_plans_select_own" on public.lifestyle_plans
  for select to authenticated using (auth.uid() = user_id);
create policy "lifestyle_plans_insert_own" on public.lifestyle_plans
  for insert to authenticated with check (auth.uid() = user_id);
create policy "lifestyle_plans_update_own" on public.lifestyle_plans
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "lifestyle_plans_delete_own" on public.lifestyle_plans
  for delete to authenticated using (auth.uid() = user_id);

-- ----------------------------------------------------- lifestyle_preferences

create table public.lifestyle_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  city text not null default '',
  use_geolocation boolean not null default false,
  latitude double precision null,
  longitude double precision null,
  radius_km double precision not null default 10,
  max_budget_cents bigint null,
  categories text[] not null default '{}',
  setting text not null default 'any' check (setting in ('any', 'indoor', 'outdoor')),
  max_duration_minutes integer null,
  company text not null default 'any' check (company in ('any', 'solo', 'friends', 'date')),
  updated_at timestamptz not null default now()
);

alter table public.lifestyle_preferences enable row level security;

create policy "lifestyle_preferences_select_own" on public.lifestyle_preferences
  for select to authenticated using (auth.uid() = user_id);
create policy "lifestyle_preferences_insert_own" on public.lifestyle_preferences
  for insert to authenticated with check (auth.uid() = user_id);
create policy "lifestyle_preferences_update_own" on public.lifestyle_preferences
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "lifestyle_preferences_delete_own" on public.lifestyle_preferences
  for delete to authenticated using (auth.uid() = user_id);

-- ------------------------------------------------------------ memory_entries

create table public.memory_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  version integer not null default 1,
  category text not null check (category in ('preferences', 'goals', 'study', 'finance', 'lifestyle', 'assistant')),
  title text not null,
  content text not null default '',
  origin text not null check (origin in ('user', 'derived')),
  approved boolean not null default true,
  pinned boolean not null default false,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  review_at date null,
  expires_at date null,
  evidence text not null default ''
);

create index memory_entries_user_id_idx on public.memory_entries (user_id);

alter table public.memory_entries enable row level security;

create policy "memory_entries_select_own" on public.memory_entries
  for select to authenticated using (auth.uid() = user_id);
create policy "memory_entries_insert_own" on public.memory_entries
  for insert to authenticated with check (auth.uid() = user_id);
create policy "memory_entries_update_own" on public.memory_entries
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "memory_entries_delete_own" on public.memory_entries
  for delete to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------- study_documents

create table public.study_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  mime text not null default '',
  size bigint not null default 0,
  kind text not null check (kind in ('pdf', 'docx', 'txt', 'md', 'pptx')),
  subject text null,
  description text not null default '',
  uploaded_at timestamptz not null default now(),
  extraction_status text not null default 'not_processed',
  storage_path text not null default '',
  text_path text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index study_documents_user_id_idx on public.study_documents (user_id);

alter table public.study_documents enable row level security;

create policy "study_documents_select_own" on public.study_documents
  for select to authenticated using (auth.uid() = user_id);
create policy "study_documents_insert_own" on public.study_documents
  for insert to authenticated with check (auth.uid() = user_id);
create policy "study_documents_update_own" on public.study_documents
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "study_documents_delete_own" on public.study_documents
  for delete to authenticated using (auth.uid() = user_id);

-- ------------------------------------------------------------ user_settings

create table public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  lecture_auto_upload boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

create policy "user_settings_select_own" on public.user_settings
  for select to authenticated using (auth.uid() = user_id);
create policy "user_settings_insert_own" on public.user_settings
  for insert to authenticated with check (auth.uid() = user_id);
create policy "user_settings_update_own" on public.user_settings
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "user_settings_delete_own" on public.user_settings
  for delete to authenticated using (auth.uid() = user_id);
